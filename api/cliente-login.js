// POST /api/cliente-login   { email, senha } -> emite cookie de sessão do cliente
// GET  /api/cliente-login             -> devolve a sessão atual (para não perder login no F5)
// POST /api/cliente-login?action=logout -> derruba o cookie
//
// Senha única e global para todos os clientes (variável AUTH_CLIENTE_TRILHAS,
// mesmo formato scrypt das AUTH_* internas — ver api/_lib/auth.js e
// scripts/gerar-hash.js). É o e-mail, cadastrado manualmente em
// clientes_emails, que identifica QUAL cliente está entrando e quais
// produtos (trilhas) ele enxerga — não a senha, que é a mesma para todos.
//
// Nunca cacheável: Cache-Control no-store em todas as respostas.

import { aplicarCors, erro, ipCliente, lerCorpo, ErroCorpo } from './_lib/http.js';
import { ErroConfig, conferirSenha } from './_lib/auth.js';
import {
  assinarSessaoCliente,
  cookieClienteLimpo,
  cookieSessaoCliente,
  exigirSessaoCliente,
} from './_lib/sessao-cliente.js';
import { buscarClientePorEmail, ErroConfigSupabase, ErroSupabase } from './_lib/supabase.js';

// Rate limiting por IP, em memória — instância própria, separada da de
// api/login.js: força bruta contra o login do cliente não deve conseguir
// travar (nem ser travada por) o login interno.
const JANELA_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 5;
const MAX_ENTRADAS = 5000;
const tentativas = new Map();

function limparExpirados(agora) {
  for (const [ip, reg] of tentativas) {
    if (agora - reg.inicio > JANELA_MS) tentativas.delete(ip);
  }
  if (tentativas.size > MAX_ENTRADAS) tentativas.clear();
}

function bloqueado(ip, agora) {
  const reg = tentativas.get(ip);
  if (!reg) return 0;
  if (agora - reg.inicio > JANELA_MS) {
    tentativas.delete(ip);
    return 0;
  }
  if (reg.total < MAX_TENTATIVAS) return 0;
  return Math.ceil((JANELA_MS - (agora - reg.inicio)) / 1000);
}

function registrarFalha(ip, agora) {
  const reg = tentativas.get(ip);
  if (!reg || agora - reg.inicio > JANELA_MS) {
    tentativas.set(ip, { total: 1, inicio: agora });
    return;
  }
  reg.total += 1;
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();

    const acao = String(req.query?.action || '');

    if (req.method === 'GET') return sessaoAtual(req, res);
    if (req.method !== 'POST') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }
    if (acao === 'logout') {
      res.setHeader('Set-Cookie', cookieClienteLimpo());
      return res.status(200).json({ ok: true });
    }

    return await autenticar(req, res);
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigSupabase) {
      console.error('[cliente-login] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Login não configurado no servidor.');
    }
    if (e instanceof ErroSupabase) {
      console.error('[cliente-login] supabase:', e.status);
      return erro(res, 502, 'erro_upstream', 'Falha ao consultar dados do cliente.');
    }
    console.error(`[cliente-login] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno na autenticação.');
  }
}

function sessaoAtual(req, res) {
  const sessao = exigirSessaoCliente(req, res, { detalharExpiracao: true });
  if (!sessao) return undefined;
  return res.status(200).json({ autenticado: true, email: sessao.email, nome: sessao.nome, produtos: sessao.produtos });
}

async function autenticar(req, res) {
  const agora = Date.now();
  const ip = ipCliente(req);
  limparExpirados(agora);

  const espera = bloqueado(ip, agora);
  if (espera > 0) {
    res.setHeader('Retry-After', String(espera));
    return erro(
      res,
      429,
      'muitas_tentativas',
      `Muitas tentativas. Tente novamente em ${Math.ceil(espera / 60)} min.`
    );
  }

  let corpo;
  try {
    corpo = await lerCorpo(req);
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }

  const email = typeof corpo.email === 'string' ? corpo.email.trim().toLowerCase() : '';
  const senha = typeof corpo.senha === 'string' ? corpo.senha : '';

  // Mesma mensagem genérica para e-mail desconhecido e senha errada — não dá
  // pra descobrir por tentativa e erro se um e-mail está cadastrado.
  const MSG_INVALIDO = 'E-mail ou senha incorretos.';

  if (!email || !RE_EMAIL.test(email) || !senha || senha.length > 200) {
    registrarFalha(ip, agora);
    return erro(res, 401, 'credenciais_invalidas', MSG_INVALIDO);
  }

  const hash = process.env.AUTH_CLIENTE_TRILHAS;
  if (!hash) {
    console.error('[cliente-login] AUTH_CLIENTE_TRILHAS não configurada.');
    return erro(res, 500, 'nao_configurado', 'Login não configurado no servidor.');
  }

  let confere;
  try {
    confere = await conferirSenha(senha, hash);
  } catch (e) {
    console.error('[cliente-login] falha ao conferir senha:', e.name);
    return erro(res, 500, 'erro_interno', 'Erro interno na autenticação.');
  }
  if (confere.motivo && confere.motivo !== 'senha_errada') {
    console.error(`[cliente-login] AUTH_CLIENTE_TRILHAS: valor invalido — ${confere.motivo}`);
  }
  if (!confere.ok) {
    registrarFalha(ip, agora);
    return erro(res, 401, 'credenciais_invalidas', MSG_INVALIDO);
  }

  const cliente = await buscarClientePorEmail(email);
  if (!cliente) {
    registrarFalha(ip, agora);
    return erro(res, 401, 'credenciais_invalidas', MSG_INVALIDO);
  }

  let token;
  try {
    token = assinarSessaoCliente({
      clienteId: cliente.id,
      email,
      nome: cliente.nome,
      produtos: cliente.produtos_ativos || [],
    });
  } catch (e) {
    if (e instanceof ErroConfig) {
      console.error('[cliente-login]', e.message);
      return erro(res, 500, 'nao_configurado', 'Sessão não configurada no servidor.');
    }
    throw e;
  }

  tentativas.delete(ip);
  res.setHeader('Set-Cookie', cookieSessaoCliente(token));
  return res.status(200).json({ autenticado: true, email, nome: cliente.nome, produtos: cliente.produtos_ativos || [] });
}
