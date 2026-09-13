// GET  /api/trilhas-sync-clientes                      -> lista clientes (Supabase) + e-mails cadastrados
// POST /api/trilhas-sync-clientes { acao: 'sincronizar' }               -> puxa a Carteira do ClickUp e faz upsert
// POST /api/trilhas-sync-clientes { acao: 'adicionar_email', clienteId, email }
// POST /api/trilhas-sync-clientes { acao: 'remover_email', emailId }
//
// O ClickUp não tem e-mail de cliente em nenhum campo estruturado da
// Carteira, e não há como filtrar por CNPJ/e-mail — só varredura completa
// (~28 chamadas paginadas). Por isso o roster de e-mail é gerido só aqui,
// manualmente, e a sincronia de produtos ativados/CNPJ/nome é um botão, não
// uma chamada em todo login de cliente (ver plano/README).

import { aplicarCors, erro, lerCorpo, ErroCorpo, texto } from './_lib/http.js';
import { ErroConfig, exigirSessao, podeEscrever } from './_lib/auth.js';
import { getCarteira, ErroUpstream } from './_lib/clickup.js';
import {
  upsertClientes,
  desativarClientesForaDe,
  listarClientes,
  listarTodosEmails,
  adicionarEmailCliente,
  removerEmailCliente,
  ErroConfigSupabase,
  ErroSupabase,
} from './_lib/supabase.js';

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();

    const sessao = exigirSessao(req, res);
    if (!sessao) return undefined;

    if (req.method === 'GET') {
      const [clientes, emails] = await Promise.all([listarClientes(), listarTodosEmails()]);
      return res.status(200).json({ clientes, emails });
    }
    if (req.method !== 'POST') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }
    if (!podeEscrever(sessao)) {
      return erro(res, 403, 'sem_permissao', 'Este nível de acesso não pode gerenciar clientes.');
    }

    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (e) {
      if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
      throw e;
    }

    const acao = String(corpo.acao || '');
    if (acao === 'sincronizar') return await sincronizar(res);
    if (acao === 'adicionar_email') return await adicionarEmail(corpo, sessao, res);
    if (acao === 'remover_email') return await removerEmail(corpo, res);
    return erro(res, 400, 'acao_desconhecida', `Ação desconhecida: ${acao}`);
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigSupabase) {
      console.error('[trilhas-sync-clientes] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Serviço não configurado no servidor.');
    }
    if (e instanceof ErroSupabase) {
      console.error('[trilhas-sync-clientes] supabase:', e.status);
      return erro(res, 502, 'erro_upstream', 'Falha ao acessar o banco de clientes.');
    }
    console.error(`[trilhas-sync-clientes] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}

async function sincronizar(res) {
  let carteira;
  try {
    carteira = await getCarteira();
  } catch (e) {
    if (e instanceof ErroUpstream && e.status === 429) {
      res.setHeader('Cache-Control', 'no-store');
      if (e.esperaSegundos) res.setHeader('Retry-After', String(e.esperaSegundos));
      return res.status(429).json({
        error: 'Limite de requisições do ClickUp atingido. Tente novamente em instantes.',
        code: 'limite_clickup',
        esperaSegundos: e.esperaSegundos || 60,
      });
    }
    throw e;
  }

  const linhasComIdNucleo = carteira.linhas.filter((l) => l.idNucleo);
  const paraUpsert = linhasComIdNucleo.map((l) => {
    // Produtos = os add-ons de OUTROS_SRV (Simplaz, Waipe, etc.) + o(s) plano(s)
    // base (Gestor/Unique), quando preenchidos — trilha tagueada "Gestor" (por
    // exemplo) precisa achar esse valor aqui para liberar para quem só tem o
    // plano base, sem nenhum add-on.
    const produtos = new Set(Array.isArray(l.outrosSrv) ? l.outrosSrv : []);
    if (l.planoGestor) produtos.add(l.planoGestor);
    if (l.planoUnique) produtos.add(l.planoUnique);
    return {
      id_nucleo: l.idNucleo,
      cnpj: l.cnpj || null,
      nome: l.nome || l.idNucleo,
      produtos_ativos: [...produtos],
      clickup_task_id: l.id,
      ativo: true,
      sincronizado_em: new Date().toISOString(),
    };
  });

  const salvos = await upsertClientes(paraUpsert);
  const idsPresentes = linhasComIdNucleo.map((l) => l.idNucleo);
  const desativados = await desativarClientesForaDe(idsPresentes);

  return res.status(200).json({
    ok: true,
    processados: paraUpsert.length,
    salvos: salvos?.length ?? null,
    desativados: desativados?.length ?? 0,
    ignoradosSemIdNucleo: carteira.linhas.length - linhasComIdNucleo.length,
  });
}

async function adicionarEmail(corpo, sessao, res) {
  const clienteId = texto(corpo.clienteId, 64);
  const email = texto(corpo.email, 200).toLowerCase();
  if (!clienteId || !email || !RE_EMAIL.test(email)) {
    return erro(res, 400, 'campos_invalidos', 'clienteId e um e-mail válido são obrigatórios.');
  }
  try {
    const linhas = await adicionarEmailCliente(clienteId, email, sessao.nome || null);
    return res.status(200).json({ email: linhas?.[0] || null });
  } catch (e) {
    // Violação de unicidade do Postgres: e-mail já cadastrado (para este ou outro cliente).
    if (e instanceof ErroSupabase && e.status === 409) {
      return erro(res, 409, 'email_ja_cadastrado', 'Este e-mail já está cadastrado.');
    }
    throw e;
  }
}

async function removerEmail(corpo, res) {
  const emailId = texto(corpo.emailId, 64);
  if (!emailId) return erro(res, 400, 'campos_invalidos', 'emailId é obrigatório.');
  await removerEmailCliente(emailId);
  return res.status(200).json({ ok: true });
}
