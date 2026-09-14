// GET  /api/trilhas-cliente                    -> trilhas dos produtos ativados, com progresso
// GET  /api/trilhas-cliente?recurso=pontos      -> total de pontos, detalhamento e prêmios elegíveis
// POST /api/trilhas-cliente { acao, ... }       -> marcar_assistido (padrão, compatível com chamadas
//                                                   antigas sem `acao`) | concluir_atividade |
//                                                   declarar_evento | resgatar_premio
//
// Os quatro viviam/vivem juntos aqui porque cada arquivo em /api vira uma
// Serverless Function, e o plano Hobby da Vercel limita a 12 por deploy (ver
// commit e51b14e).
//
// Nunca confia em id vindo do cliente sem checar posse (vídeo precisa
// pertencer a uma trilha liberada pra sessão) nem em pontuação calculada no
// navegador — resgate sempre recalcula tudo aqui, do zero, antes de aceitar.

import { aplicarCors, erro, lerCorpo, ErroCorpo, uuidValido, texto } from './_lib/http.js';
import { ErroConfig } from './_lib/auth.js';
import { exigirSessaoCliente } from './_lib/sessao-cliente.js';
import {
  listarTrilhasAtivas,
  listarVisualizacoesPorEmail,
  buscarVideoComProduto,
  upsertVisualizacao,
  listarAtividadesPorEmail,
  marcarAtividadeConcluida,
  listarRegras,
  buscarEvento,
  declararEvento,
  calcularPontosCliente,
  listarPremiosParaCliente,
  contarResgatesAtivos,
  listarResgatesPorEmail,
  criarResgate,
  ErroConfigSupabase,
  ErroSupabase,
} from './_lib/supabase.js';

/** Trilha "geral" (produtos vazio) vale pra todo mundo; senão precisa dar overlap. */
function trilhaLiberadaPara(produtosTrilha, produtosCliente) {
  if (!produtosTrilha || !produtosTrilha.length) return true;
  return produtosTrilha.some((p) => produtosCliente.includes(p));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();

    const sessao = exigirSessaoCliente(req, res);
    if (!sessao) return undefined;

    if (req.method === 'GET') {
      const recurso = String(req.query?.recurso || 'trilhas');
      if (recurso === 'trilhas') return await listarTrilhas(sessao, res);
      if (recurso === 'pontos') return await obterPontos(sessao, res);
      return erro(res, 400, 'recurso_desconhecido', `Recurso desconhecido: ${recurso}`);
    }
    if (req.method === 'POST') {
      let corpo;
      try {
        corpo = await lerCorpo(req);
      } catch (e) {
        if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
        throw e;
      }
      // Sem `acao` = chamada antiga de marcar-assistido (compatibilidade).
      const acao = String(corpo.acao || 'marcar_assistido');
      if (acao === 'marcar_assistido') return await marcarAssistido(corpo, sessao, res);
      if (acao === 'concluir_atividade') return await concluirAtividade(corpo, sessao, res);
      if (acao === 'declarar_evento') return await declararEventoAcao(corpo, sessao, res);
      if (acao === 'resgatar_premio') return await resgatarPremio(corpo, sessao, res);
      return erro(res, 400, 'acao_desconhecida', `Ação desconhecida: ${acao}`);
    }
    return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigSupabase) {
      console.error('[trilhas-cliente] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Serviço não configurado no servidor.');
    }
    if (e instanceof ErroSupabase) {
      console.error('[trilhas-cliente] supabase:', e.status);
      return erro(res, 502, 'erro_upstream', 'Falha ao acessar as trilhas.');
    }
    console.error(`[trilhas-cliente] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}

async function listarTrilhas(sessao, res) {
  const [todasTrilhas, visualizacoes, atividadesFeitas] = await Promise.all([
    listarTrilhasAtivas(),
    listarVisualizacoesPorEmail(sessao.email),
    listarAtividadesPorEmail(sessao.email),
  ]);

  const progressoPorVideo = new Map(visualizacoes.map((v) => [v.trilha_video_id, v]));
  const atividadeFeitaSet = new Set(atividadesFeitas.map((a) => a.trilha_video_id));

  const resultado = todasTrilhas
    .filter((t) => trilhaLiberadaPara(t.produtos, sessao.produtos))
    .map((t) => {
      const videos = (t.trilha_videos || [])
        .slice()
        .sort((a, b) => a.ordem - b.ordem)
        .map((v) => {
          const p = progressoPorVideo.get(v.id);
          return {
            id: v.id,
            titulo: v.titulo,
            youtubeId: v.youtube_id,
            duracaoSegundos: v.duracao_segundos,
            nota: v.nota || null,
            concluido: Boolean(p?.concluido),
            percentual: p?.percentual_maximo || 0,
            atividadeTitulo: v.atividade_titulo || null,
            atividadePontos: v.atividade_pontos || null,
            atividadeFeita: atividadeFeitaSet.has(v.id),
          };
        });
      return {
        id: t.id,
        titulo: t.titulo,
        descricao: t.descricao,
        produtos: t.produtos,
        videos,
        totalVideos: videos.length,
        videosAssistidos: videos.filter((v) => v.concluido).length,
      };
    })
    .sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));

  return res.status(200).json({ trilhas: resultado });
}

async function marcarAssistido(corpo, sessao, res) {
  const trilhaVideoId = String(corpo.trilhaVideoId || '');
  if (!uuidValido(trilhaVideoId)) {
    return erro(res, 400, 'campos_invalidos', 'trilhaVideoId inválido.');
  }
  const percentual = Number(corpo.percentual);
  if (!Number.isFinite(percentual) || percentual < 0 || percentual > 100) {
    return erro(res, 400, 'campos_invalidos', 'percentual deve estar entre 0 e 100.');
  }
  const progressoSegundos = Number(corpo.progressoSegundos);

  const video = await buscarVideoComProduto(trilhaVideoId);
  if (!video || video.ativo === false || !video.trilhas || video.trilhas.ativa === false) {
    return erro(res, 404, 'video_nao_encontrado', 'Vídeo não encontrado.');
  }
  if (!trilhaLiberadaPara(video.trilhas.produtos, sessao.produtos)) {
    // Cliente não tem mais (ou nunca teve) nenhum dos produtos dessa trilha —
    // nada vaza, só um 403 genérico, sem detalhar qual produto seria necessário.
    return erro(res, 403, 'sem_acesso', 'Você não tem acesso a este vídeo.');
  }

  const registro = await upsertVisualizacao({
    clienteId: sessao.clienteId,
    email: sessao.email,
    trilhaVideoId,
    percentual,
    progressoSegundos,
  });

  return res.status(200).json({
    concluido: Boolean(registro?.concluido),
    percentual: registro?.percentual_maximo || 0,
  });
}

// ── Gamificação ──────────────────────────────────────────────────────────

async function obterPontos(sessao, res) {
  const [{ total, detalhamento }, premiosElegiveis, resgatesDoEmail] = await Promise.all([
    calcularPontosCliente({ email: sessao.email, produtosAtivos: sessao.produtos }),
    listarPremiosParaCliente(sessao.clienteId),
    listarResgatesPorEmail(sessao.email),
  ]);

  const resgatePorPremio = new Map();
  for (const r of resgatesDoEmail) {
    if (!resgatePorPremio.has(r.premio_id)) resgatePorPremio.set(r.premio_id, r);
  }

  const premios = await Promise.all(premiosElegiveis.map(async (p) => {
    const faixas = (p.premio_faixas || []).slice().sort((a, b) => b.pontos_minimos - a.pontos_minimos);
    const faixaAtingida = faixas.find((f) => total >= f.pontos_minimos) || null;
    let estoqueRestante = null;
    if (p.estoque_total != null) {
      const usados = await contarResgatesAtivos(p.id);
      estoqueRestante = Math.max(0, p.estoque_total - usados);
    }
    const resgate = resgatePorPremio.get(p.id);
    return {
      id: p.id,
      titulo: p.titulo,
      descricao: p.descricao,
      prazoFinal: p.prazo_final,
      faixas: faixas.map((f) => ({ id: f.id, pontosMinimos: f.pontos_minimos, descricao: f.descricao })),
      faixaAtingida: faixaAtingida
        ? { id: faixaAtingida.id, pontosMinimos: faixaAtingida.pontos_minimos, descricao: faixaAtingida.descricao }
        : null,
      estoqueRestante,
      resgateStatus: resgate ? resgate.status : null,
    };
  }));

  return res.status(200).json({ total, detalhamento, premios });
}

async function concluirAtividade(corpo, sessao, res) {
  const trilhaVideoId = String(corpo.trilhaVideoId || '');
  if (!uuidValido(trilhaVideoId)) return erro(res, 400, 'campos_invalidos', 'trilhaVideoId inválido.');

  const video = await buscarVideoComProduto(trilhaVideoId);
  if (!video || video.ativo === false || !video.trilhas || video.trilhas.ativa === false) {
    return erro(res, 404, 'video_nao_encontrado', 'Vídeo não encontrado.');
  }
  if (!trilhaLiberadaPara(video.trilhas.produtos, sessao.produtos)) {
    return erro(res, 403, 'sem_acesso', 'Você não tem acesso a este vídeo.');
  }

  await marcarAtividadeConcluida(sessao.clienteId, sessao.email, trilhaVideoId);
  return res.status(200).json({ ok: true });
}

async function declararEventoAcao(corpo, sessao, res) {
  const regraId = String(corpo.regraId || '');
  if (!uuidValido(regraId)) return erro(res, 400, 'campos_invalidos', 'regraId inválido.');

  const regras = await listarRegras();
  const regra = regras.find((r) => r.id === regraId && r.ativa);
  if (!regra || regra.tipo === 'automatica') {
    return erro(res, 404, 'regra_nao_encontrada', 'Regra não encontrada.');
  }
  const identificacao = texto(corpo.identificacao, 200) || null;
  if (regra.pede_identificacao && !identificacao) {
    return erro(res, 400, 'campos_invalidos', 'Informe o e-mail ou CPF/CNPJ usado na inscrição.');
  }

  // Nunca deixa uma redeclaração derrubar um evento já aprovado de volta pra pendente.
  const existente = await buscarEvento(sessao.email, regraId);
  if (existente?.status === 'aprovado') {
    return res.status(200).json({ evento: existente });
  }

  const status = regra.tipo === 'autodeclarada' ? 'aprovado' : 'pendente';
  const evento = await declararEvento({
    clienteId: sessao.clienteId,
    email: sessao.email,
    regraId,
    status,
    identificacao,
    observacao: texto(corpo.observacao, 2000) || null,
  });
  return res.status(200).json({ evento });
}

async function resgatarPremio(corpo, sessao, res) {
  const premioId = String(corpo.premioId || '');
  const faixaId = corpo.faixaId ? String(corpo.faixaId) : null;
  const whatsapp = texto(corpo.whatsapp, 30);
  if (!uuidValido(premioId) || !whatsapp) {
    return erro(res, 400, 'campos_invalidos', 'premioId e whatsapp são obrigatórios.');
  }
  if (faixaId && !uuidValido(faixaId)) return erro(res, 400, 'campos_invalidos', 'faixaId inválido.');

  // Revalida tudo no servidor — nunca confia em pontuação/elegibilidade que o navegador calculou.
  const premiosElegiveis = await listarPremiosParaCliente(sessao.clienteId);
  const premio = premiosElegiveis.find((p) => p.id === premioId);
  if (!premio) return erro(res, 404, 'premio_nao_encontrado', 'Prêmio não encontrado ou não disponível.');

  const { total } = await calcularPontosCliente({ email: sessao.email, produtosAtivos: sessao.produtos });
  const faixas = (premio.premio_faixas || []).slice().sort((a, b) => b.pontos_minimos - a.pontos_minimos);
  const faixaEscolhida = faixaId ? faixas.find((f) => f.id === faixaId) : faixas[0];
  if (!faixaEscolhida || total < faixaEscolhida.pontos_minimos) {
    return erro(res, 403, 'pontos_insuficientes', 'Pontuação insuficiente para este prêmio.');
  }

  if (premio.estoque_total != null) {
    const usados = await contarResgatesAtivos(premio.id);
    if (usados >= premio.estoque_total) return erro(res, 409, 'sem_estoque', 'Prêmio sem estoque no momento.');
  }

  const existentes = await listarResgatesPorEmail(sessao.email);
  if (existentes.some((r) => r.premio_id === premioId && r.status !== 'cancelado')) {
    return erro(res, 409, 'ja_resgatado', 'Você já solicitou este prêmio.');
  }

  const resgate = await criarResgate({
    premioId, faixaId: faixaEscolhida.id, clienteId: sessao.clienteId, email: sessao.email, whatsapp,
  });
  return res.status(200).json({ resgate });
}
