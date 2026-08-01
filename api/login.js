// POST /api/login   { senha } -> emite cookie de sessão assinado
// GET  /api/login             -> devolve a sessão atual (para não perder login no F5)
// POST /api/login?action=logout -> derruba o cookie
//
// Nunca cacheável: Cache-Control no-store em todas as respostas.

import {
  aplicarCors,
  erro,
  ipCliente,
  lerCorpo,
  ErroCorpo,
} from './_lib/http.js';
import {
  PERFIS,
  ErroConfig,
  assinarSessao,
  conferirSenha,
  cookieLimpo,
  cookieSessao,
  exigirSessao,
} from './_lib/auth.js';

// ── Rate limiting por IP ──────────────────────────────────────────────────
// Em memória, por instância serverless. Não é um limite global forte (cada
// instância tem seu próprio contador), mas corta força bruta de origem única.
// Ver nota no README.
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

// ── Handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // O try cobre o handler INTEIRO. O ramo GET nao tinha protecao nenhuma: com
  // SESSION_SECRET ausente, exigirSessao lancava e derrubava a funcao.
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
      res.setHeader('Set-Cookie', cookieLimpo());
      return res.status(200).json({ ok: true });
    }

    return await autenticar(req, res);
  } catch (e) {
    if (e instanceof ErroConfig) {
      console.error('[login] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Autenticação não configurada no servidor.');
    }
    console.error(`[login] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno na autenticação.');
  }
}

function sessaoAtual(req, res) {
  const sessao = exigirSessao(req, res);
  if (!sessao) return undefined;
  return res.status(200).json({
    autenticado: true,
    nivel: sessao.nivel,
    csm: sessao.csm,
    nome: sessao.nome,
  });
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

  const senha = typeof corpo.senha === 'string' ? corpo.senha : '';
  if (!senha || senha.length > 200) {
    registrarFalha(ip, agora);
    return erro(res, 401, 'senha_incorreta', 'Senha incorreta.');
  }

  // Não há usuário: a própria senha identifica o perfil, então testamos todos
  // os hashes configurados.
  let perfil = null;
  let algumConfigurado = false;
  try {
    for (const p of PERFIS) {
      const hash = process.env[p.env];
      if (!hash) continue;
      algumConfigurado = true;
      if (await conferirSenha(senha, hash)) {
        perfil = p;
        break;
      }
    }
  } catch (e) {
    console.error('[login] falha ao conferir senha:', e.name);
    return erro(res, 500, 'erro_interno', 'Erro interno na autenticação.');
  }

  if (!algumConfigurado) {
    console.error('[login] nenhuma variável AUTH_* configurada no ambiente.');
    return erro(res, 500, 'nao_configurado', 'Autenticação não configurada no servidor.');
  }

  if (!perfil) {
    registrarFalha(ip, agora);
    return erro(res, 401, 'senha_incorreta', 'Senha incorreta.');
  }

  let token;
  try {
    token = assinarSessao(perfil);
  } catch (e) {
    if (e instanceof ErroConfig) {
      console.error('[login]', e.message);
      return erro(res, 500, 'nao_configurado', 'Sessão não configurada no servidor.');
    }
    throw e;
  }

  tentativas.delete(ip);
  res.setHeader('Set-Cookie', cookieSessao(token));
  return res.status(200).json({
    autenticado: true,
    nivel: perfil.nivel,
    csm: perfil.csm,
    nome: perfil.nome,
  });
}
