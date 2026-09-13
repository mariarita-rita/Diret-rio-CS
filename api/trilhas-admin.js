// GET  /api/trilhas-admin                              -> lista todas as trilhas + vídeos (inclui arquivadas)
// GET  /api/trilhas-admin?recurso=clientes             -> lista clientes (Supabase) + e-mails cadastrados
// GET  /api/trilhas-admin?recurso=indicadores          -> engajamento de treinamento por cliente
// POST /api/trilhas-admin  { acao, ... }   -> criar_trilha | editar_trilha | arquivar_trilha
//                                             criar_video | editar_video | arquivar_video
//                                             sincronizar | adicionar_email | remover_email
//
// Uso interno (sessão cs_sessao, mesma da Carteira/Implantação). Leitura para
// qualquer nível autenticado; escrita exige podeEscrever (gestão/csm/ism —
// consulta é só-leitura em todo o resto do app, e aqui não é diferente).
//
// Os três recursos (trilhas, clientes/e-mails, indicadores) viviam em três
// arquivos separados — juntados aqui num só porque cada arquivo em /api vira
// uma Serverless Function, e o plano Hobby da Vercel limita a 12 por deploy.
// Mesmo padrão de "ação num corpo só" que api/clickup.js já usa pra tudo que
// é dado de carteira/implantação.

import { aplicarCors, erro, lerCorpo, ErroCorpo, texto } from './_lib/http.js';
import { ErroConfig, exigirSessao, podeEscrever } from './_lib/auth.js';
import { getCarteira, ErroUpstream } from './_lib/clickup.js';
import {
  listarTrilhasAdmin,
  criarTrilha,
  editarTrilha,
  criarVideo,
  editarVideo,
  upsertClientes,
  desativarClientesForaDe,
  listarClientes,
  listarTodosEmails,
  adicionarEmailCliente,
  removerEmailCliente,
  indicadoresPorCliente,
  ErroConfigSupabase,
  ErroSupabase,
} from './_lib/supabase.js';

const RE_YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Aceita um id puro ou uma URL do YouTube e devolve só o id de 11 caracteres, ou null. */
function extrairYoutubeId(v) {
  const s = String(v || '').trim();
  if (RE_YOUTUBE_ID.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1);
      return RE_YOUTUBE_ID.test(id) ? id : null;
    }
    if (u.hostname.endsWith('youtube.com')) {
      const v2 = u.searchParams.get('v');
      if (v2 && RE_YOUTUBE_ID.test(v2)) return v2;
      const m = u.pathname.match(/\/(embed|shorts)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    // não era URL — já tentamos como id puro acima
  }
  return null;
}

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
      const recurso = String(req.query?.recurso || 'trilhas');
      if (recurso === 'trilhas') {
        const trilhas = await listarTrilhasAdmin();
        return res.status(200).json({ trilhas });
      }
      if (recurso === 'clientes') {
        const [clientes, emails] = await Promise.all([listarClientes(), listarTodosEmails()]);
        return res.status(200).json({ clientes, emails });
      }
      if (recurso === 'indicadores') {
        const indicadores = await indicadoresPorCliente();
        return res.status(200).json({ indicadores });
      }
      return erro(res, 400, 'recurso_desconhecido', `Recurso desconhecido: ${recurso}`);
    }
    if (req.method !== 'POST') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }
    if (!podeEscrever(sessao)) {
      return erro(res, 403, 'sem_permissao', 'Este nível de acesso não pode editar trilhas nem clientes.');
    }

    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (e) {
      if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
      throw e;
    }

    return await executarAcao(String(corpo.acao || ''), corpo, sessao, res);
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigSupabase) {
      console.error('[trilhas-admin] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Serviço não configurado no servidor.');
    }
    if (e instanceof ErroSupabase) {
      console.error('[trilhas-admin] supabase:', e.status);
      return erro(res, 502, 'erro_upstream', 'Falha ao acessar o banco de trilhas.');
    }
    console.error(`[trilhas-admin] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}

/**
 * Aceita qualquer array e devolve uma lista de strings não-vazias, sem
 * duplicatas, ou null se `v` nem é array. Array vazio é válido — significa
 * trilha "geral" (aparece pra todo cliente, sem filtro de produto).
 */
function sanearProdutos(v) {
  if (!Array.isArray(v)) return null;
  const vistos = new Set();
  for (const item of v) {
    const s = texto(item, 100);
    if (s) vistos.add(s);
  }
  return [...vistos];
}

async function executarAcao(acao, corpo, sessao, res) {
  // ── Trilhas e vídeos ──────────────────────────────────────────────────
  if (acao === 'criar_trilha') {
    const titulo = texto(corpo.titulo, 200);
    const produtos = sanearProdutos(corpo.produtos) ?? [];
    if (!titulo) return erro(res, 400, 'campos_invalidos', 'Título é obrigatório.');
    const trilha = await criarTrilha({
      titulo,
      descricao: texto(corpo.descricao, 2000) || null,
      produtos,
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0,
    });
    return res.status(200).json({ trilha });
  }

  if (acao === 'editar_trilha') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const campos = {};
    if (corpo.titulo !== undefined) campos.titulo = texto(corpo.titulo, 200);
    if (corpo.descricao !== undefined) campos.descricao = texto(corpo.descricao, 2000) || null;
    if (corpo.produtos !== undefined) {
      const produtos = sanearProdutos(corpo.produtos);
      if (produtos === null) return erro(res, 400, 'campos_invalidos', 'produtos deve ser uma lista.');
      campos.produtos = produtos;
    }
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    const trilha = await editarTrilha(id, campos);
    return res.status(200).json({ trilha });
  }

  if (acao === 'arquivar_trilha') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const trilha = await editarTrilha(id, { ativa: Boolean(corpo.ativa) });
    return res.status(200).json({ trilha });
  }

  if (acao === 'criar_video') {
    const trilhaId = texto(corpo.trilhaId, 64);
    const titulo = texto(corpo.titulo, 200);
    const youtubeId = extrairYoutubeId(corpo.youtube);
    if (!trilhaId || !titulo || !youtubeId) {
      return erro(res, 400, 'campos_invalidos', 'trilhaId, título e um vídeo do YouTube válido são obrigatórios.');
    }
    const video = await criarVideo({
      trilhaId,
      titulo,
      youtubeId,
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0,
      duracaoSegundos: Number.isInteger(corpo.duracaoSegundos) ? corpo.duracaoSegundos : null,
    });
    return res.status(200).json({ video });
  }

  if (acao === 'editar_video') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const campos = {};
    if (corpo.titulo !== undefined) campos.titulo = texto(corpo.titulo, 200);
    if (corpo.youtube !== undefined) {
      const youtubeId = extrairYoutubeId(corpo.youtube);
      if (!youtubeId) return erro(res, 400, 'campos_invalidos', 'Vídeo do YouTube inválido.');
      campos.youtube_id = youtubeId;
    }
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    const video = await editarVideo(id, campos);
    return res.status(200).json({ video });
  }

  if (acao === 'arquivar_video') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const video = await editarVideo(id, { ativo: Boolean(corpo.ativo) });
    return res.status(200).json({ video });
  }

  // ── Clientes e e-mails ────────────────────────────────────────────────
  if (acao === 'sincronizar') return await sincronizar(res);
  if (acao === 'adicionar_email') return await adicionarEmail(corpo, sessao, res);
  if (acao === 'remover_email') return await removerEmail(corpo, res);

  return erro(res, 400, 'acao_desconhecida', `Ação desconhecida: ${acao}`);
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
