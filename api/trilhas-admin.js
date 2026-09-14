// GET  /api/trilhas-admin                              -> lista todas as trilhas + vídeos (inclui arquivadas)
// GET  /api/trilhas-admin?recurso=clientes             -> lista clientes (Supabase) + e-mails cadastrados
// GET  /api/trilhas-admin?recurso=indicadores          -> engajamento de treinamento por cliente
// GET  /api/trilhas-admin?recurso=pontos-regras        -> catálogo de regras de pontos
// GET  /api/trilhas-admin?recurso=pontos-eventos[&status=pendente|aprovado|rejeitado] -> eventos declarados
// GET  /api/trilhas-admin?recurso=premios              -> prêmios + faixas (admin, inclui inativos)
// GET  /api/trilhas-admin?recurso=premio-elegiveis&premioId=... -> lista de elegíveis de um prêmio restrito
// GET  /api/trilhas-admin?recurso=resgates[&status=...] -> fila de resgates
// POST /api/trilhas-admin  { acao, ... }   -> criar_trilha | editar_trilha | arquivar_trilha
//                                             criar_video | editar_video | arquivar_video | excluir_video
//                                             reordenar_videos
//                                             sincronizar | adicionar_email | remover_email
//                                             criar_regra | editar_regra
//                                             aprovar_evento | rejeitar_evento
//                                             criar_premio | editar_premio
//                                             criar_faixa | editar_faixa | excluir_faixa
//                                             definir_elegiveis
//                                             atualizar_resgate
//
// Uso interno (sessão cs_sessao, mesma da Carteira/Implantação). Leitura para
// qualquer nível autenticado; escrita exige podeEscrever (gestão/csm/ism —
// consulta é só-leitura em todo o resto do app, e aqui não é diferente).
//
// Tudo isso vive num arquivo só porque cada arquivo em /api vira uma
// Serverless Function, e o plano Hobby da Vercel limita a 12 por deploy (ver
// commit e51b14e). Mesmo padrão de "ação num corpo só" que api/clickup.js já
// usa pra tudo que é dado de carteira/implantação.

import { aplicarCors, erro, lerCorpo, ErroCorpo, texto, uuidValido } from './_lib/http.js';
import { ErroConfig, exigirSessao, podeEscrever } from './_lib/auth.js';
import { getCarteira, ErroUpstream } from './_lib/clickup.js';
import {
  listarTrilhasAdmin,
  criarTrilha,
  editarTrilha,
  criarVideo,
  editarVideo,
  excluirVideo,
  reordenarVideos,
  upsertClientes,
  desativarClientesForaDe,
  listarClientes,
  listarTodosEmails,
  adicionarEmailCliente,
  removerEmailCliente,
  indicadoresPorCliente,
  listarRegras,
  criarRegra,
  editarRegra,
  listarEventos,
  revisarEvento,
  listarPremiosAdmin,
  criarPremio,
  editarPremio,
  criarFaixa,
  editarFaixa,
  excluirFaixa,
  listarElegiveis,
  definirElegiveis,
  listarResgates,
  atualizarResgate,
  ErroConfigSupabase,
  ErroSupabase,
} from './_lib/supabase.js';

const TIPOS_REGRA = new Set(['automatica', 'autodeclarada', 'pendente_aprovacao']);
const STATUS_EVENTO = new Set(['pendente', 'aprovado', 'rejeitado']);
const STATUS_RESGATE = new Set(['solicitado', 'contatado', 'entregue', 'cancelado']);

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
      if (recurso === 'pontos-regras') {
        const regras = await listarRegras();
        return res.status(200).json({ regras });
      }
      if (recurso === 'pontos-eventos') {
        const status = String(req.query?.status || '');
        const eventos = await listarEventos(STATUS_EVENTO.has(status) ? status : undefined);
        return res.status(200).json({ eventos });
      }
      if (recurso === 'premios') {
        const premios = await listarPremiosAdmin();
        return res.status(200).json({ premios });
      }
      if (recurso === 'premio-elegiveis') {
        const premioId = String(req.query?.premioId || '');
        if (!uuidValido(premioId)) return erro(res, 400, 'campos_invalidos', 'premioId inválido.');
        const elegiveis = await listarElegiveis(premioId);
        return res.status(200).json({ elegiveis });
      }
      if (recurso === 'resgates') {
        const status = String(req.query?.status || '');
        const resgates = await listarResgates(STATUS_RESGATE.has(status) ? status : undefined);
        return res.status(200).json({ resgates });
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
      pontosConclusao: Number.isInteger(corpo.pontosConclusao) && corpo.pontosConclusao > 0 ? corpo.pontosConclusao : null,
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
    if (corpo.pontosConclusao !== undefined) {
      campos.pontos_conclusao = Number.isInteger(corpo.pontosConclusao) && corpo.pontosConclusao > 0 ? corpo.pontosConclusao : null;
    }
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
    const atividadeTitulo = texto(corpo.atividadeTitulo, 300) || null;
    const video = await criarVideo({
      trilhaId,
      titulo,
      youtubeId,
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0,
      duracaoSegundos: Number.isInteger(corpo.duracaoSegundos) ? corpo.duracaoSegundos : null,
      nota: texto(corpo.nota, 2000) || null,
      atividadeTitulo,
      atividadePontos: Number.isInteger(corpo.atividadePontos) && corpo.atividadePontos > 0 ? corpo.atividadePontos : null,
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
    if (corpo.nota !== undefined) campos.nota = texto(corpo.nota, 2000) || null;
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    if (corpo.atividadeTitulo !== undefined) {
      const atividadeTitulo = texto(corpo.atividadeTitulo, 300) || null;
      campos.atividade_titulo = atividadeTitulo;
      // Sem título de atividade não faz sentido guardar pontos órfãos.
      campos.atividade_pontos = atividadeTitulo && Number.isInteger(corpo.atividadePontos) && corpo.atividadePontos > 0
        ? corpo.atividadePontos
        : null;
    }
    const video = await editarVideo(id, campos);
    return res.status(200).json({ video });
  }

  if (acao === 'arquivar_video') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const video = await editarVideo(id, { ativo: Boolean(corpo.ativo) });
    return res.status(200).json({ video });
  }

  if (acao === 'excluir_video') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    await excluirVideo(id);
    return res.status(200).json({ ok: true });
  }

  if (acao === 'reordenar_videos') {
    const ids = Array.isArray(corpo.ids) ? corpo.ids.map((v) => texto(v, 64)).filter(Boolean) : null;
    if (!ids || !ids.length) return erro(res, 400, 'campos_invalidos', 'ids deve ser uma lista não vazia.');
    await reordenarVideos(ids);
    return res.status(200).json({ ok: true });
  }

  // ── Clientes e e-mails ────────────────────────────────────────────────
  if (acao === 'sincronizar') return await sincronizar(res);
  if (acao === 'adicionar_email') return await adicionarEmail(corpo, sessao, res);
  if (acao === 'remover_email') return await removerEmail(corpo, res);

  // ── Gamificação: regras de pontos ───────────────────────────────────────
  if (acao === 'criar_regra') {
    const titulo = texto(corpo.titulo, 200);
    const pontos = Number.isInteger(corpo.pontos) ? corpo.pontos : null;
    const tipo = String(corpo.tipo || '');
    if (!titulo || !pontos || pontos <= 0 || !TIPOS_REGRA.has(tipo)) {
      return erro(res, 400, 'campos_invalidos', 'Título, pontos (>0) e tipo válido são obrigatórios.');
    }
    const criterioProdutos = tipo === 'automatica' ? (sanearProdutos(corpo.criterioProdutos) ?? []) : [];
    if (tipo === 'automatica' && !criterioProdutos.length) {
      return erro(res, 400, 'campos_invalidos', 'Regra automática precisa de ao menos um produto-critério.');
    }
    const regra = await criarRegra({
      titulo, pontos, tipo, criterioProdutos,
      pedeIdentificacao: Boolean(corpo.pedeIdentificacao),
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0,
    });
    return res.status(200).json({ regra });
  }

  if (acao === 'editar_regra') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const campos = {};
    if (corpo.titulo !== undefined) campos.titulo = texto(corpo.titulo, 200);
    if (corpo.pontos !== undefined) {
      if (!Number.isInteger(corpo.pontos) || corpo.pontos <= 0) return erro(res, 400, 'campos_invalidos', 'pontos deve ser um inteiro positivo.');
      campos.pontos = corpo.pontos;
    }
    if (corpo.criterioProdutos !== undefined) {
      const criterioProdutos = sanearProdutos(corpo.criterioProdutos);
      if (criterioProdutos === null) return erro(res, 400, 'campos_invalidos', 'criterioProdutos deve ser uma lista.');
      campos.criterio_produtos = criterioProdutos;
    }
    if (corpo.pedeIdentificacao !== undefined) campos.pede_identificacao = Boolean(corpo.pedeIdentificacao);
    if (corpo.ativa !== undefined) campos.ativa = Boolean(corpo.ativa);
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    const regra = await editarRegra(id, campos);
    return res.status(200).json({ regra });
  }

  // ── Gamificação: aprovação de eventos ───────────────────────────────────
  if (acao === 'aprovar_evento' || acao === 'rejeitar_evento') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const evento = await revisarEvento(id, acao === 'aprovar_evento' ? 'aprovado' : 'rejeitado', sessao.nome || null);
    return res.status(200).json({ evento });
  }

  // ── Gamificação: prêmios ─────────────────────────────────────────────────
  if (acao === 'criar_premio') {
    const titulo = texto(corpo.titulo, 200);
    if (!titulo) return erro(res, 400, 'campos_invalidos', 'Título é obrigatório.');
    const premio = await criarPremio({
      titulo,
      descricao: texto(corpo.descricao, 2000) || null,
      prazoFinal: texto(corpo.prazoFinal, 10) || null,
      estoqueTotal: Number.isInteger(corpo.estoqueTotal) && corpo.estoqueTotal >= 0 ? corpo.estoqueTotal : null,
      restrito: Boolean(corpo.restrito),
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0,
    });
    return res.status(200).json({ premio });
  }

  if (acao === 'editar_premio') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const campos = {};
    if (corpo.titulo !== undefined) campos.titulo = texto(corpo.titulo, 200);
    if (corpo.descricao !== undefined) campos.descricao = texto(corpo.descricao, 2000) || null;
    if (corpo.prazoFinal !== undefined) campos.prazo_final = texto(corpo.prazoFinal, 10) || null;
    if (corpo.estoqueTotal !== undefined) {
      campos.estoque_total = Number.isInteger(corpo.estoqueTotal) && corpo.estoqueTotal >= 0 ? corpo.estoqueTotal : null;
    }
    if (corpo.restrito !== undefined) campos.restrito = Boolean(corpo.restrito);
    if (corpo.ativo !== undefined) campos.ativo = Boolean(corpo.ativo);
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    const premio = await editarPremio(id, campos);
    return res.status(200).json({ premio });
  }

  if (acao === 'criar_faixa') {
    const premioId = texto(corpo.premioId, 64);
    const descricao = texto(corpo.descricao, 200);
    const pontosMinimos = Number.isInteger(corpo.pontosMinimos) ? corpo.pontosMinimos : null;
    if (!premioId || !descricao || pontosMinimos === null || pontosMinimos < 0) {
      return erro(res, 400, 'campos_invalidos', 'premioId, descrição e pontosMinimos (>=0) são obrigatórios.');
    }
    const faixa = await criarFaixa({ premioId, pontosMinimos, descricao, ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0 });
    return res.status(200).json({ faixa });
  }

  if (acao === 'editar_faixa') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const campos = {};
    if (corpo.descricao !== undefined) campos.descricao = texto(corpo.descricao, 200);
    if (corpo.pontosMinimos !== undefined) {
      if (!Number.isInteger(corpo.pontosMinimos) || corpo.pontosMinimos < 0) return erro(res, 400, 'campos_invalidos', 'pontosMinimos inválido.');
      campos.pontos_minimos = corpo.pontosMinimos;
    }
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    const faixa = await editarFaixa(id, campos);
    return res.status(200).json({ faixa });
  }

  if (acao === 'excluir_faixa') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    await excluirFaixa(id);
    return res.status(200).json({ ok: true });
  }

  if (acao === 'definir_elegiveis') {
    const premioId = texto(corpo.premioId, 64);
    const clienteIds = Array.isArray(corpo.clienteIds) ? corpo.clienteIds.filter((v) => uuidValido(v)) : null;
    if (!premioId || !clienteIds) return erro(res, 400, 'campos_invalidos', 'premioId e clienteIds (lista) são obrigatórios.');
    await definirElegiveis(premioId, clienteIds);
    return res.status(200).json({ ok: true, total: clienteIds.length });
  }

  // ── Gamificação: resgates ────────────────────────────────────────────────
  if (acao === 'atualizar_resgate') {
    const id = texto(corpo.id, 64);
    const status = String(corpo.status || '');
    if (!id || !STATUS_RESGATE.has(status)) return erro(res, 400, 'campos_invalidos', 'id e status válido são obrigatórios.');
    const resgate = await atualizarResgate(id, status);
    return res.status(200).json({ resgate });
  }

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

  // Um timestamp só pra este sync inteiro — é o que permite desativar "quem
  // não apareceu desta vez" comparando sincronizado_em, sem montar uma lista
  // gigante de ids (ver desativarClientesForaDe).
  const momentoDoSync = new Date().toISOString();

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
      sincronizado_em: momentoDoSync,
    };
  });

  const salvos = await upsertClientes(paraUpsert);
  const desativados = await desativarClientesForaDe(momentoDoSync);

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
