// GET  /api/trilhas-cliente -> trilhas dos produtos ativados do cliente logado,
//                               com vídeos e o progresso (concluído/percentual) de cada um.
// POST /api/trilhas-cliente { trilhaVideoId, percentual, progressoSegundos }
//                            -> registra o progresso de reprodução de um vídeo.
//
// Os dois viviam em arquivos separados — juntados aqui porque cada arquivo em
// /api vira uma Serverless Function, e o plano Hobby da Vercel limita a 12
// por deploy.
//
// No POST, nunca confia no trilhaVideoId sem checar posse: o vídeo precisa
// pertencer a uma trilha cujo produto está entre os produtos ativados da
// sessão — mesmo princípio já usado para taskId do ClickUp em api/clickup.js
// (nunca aceitar um id vindo do cliente sem validar que ele tem acesso àquele
// recurso).

import { aplicarCors, erro, lerCorpo, ErroCorpo, uuidValido } from './_lib/http.js';
import { ErroConfig } from './_lib/auth.js';
import { exigirSessaoCliente } from './_lib/sessao-cliente.js';
import {
  listarTrilhasAtivas,
  listarVisualizacoesPorEmail,
  buscarVideoComProduto,
  upsertVisualizacao,
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

    if (req.method === 'GET') return await listarTrilhas(sessao, res);
    if (req.method === 'POST') return await marcarAssistido(req, sessao, res);
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
  const [todasTrilhas, visualizacoes] = await Promise.all([
    listarTrilhasAtivas(),
    listarVisualizacoesPorEmail(sessao.email),
  ]);

  const progressoPorVideo = new Map(visualizacoes.map((v) => [v.trilha_video_id, v]));

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
            concluido: Boolean(p?.concluido),
            percentual: p?.percentual_maximo || 0,
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

async function marcarAssistido(req, sessao, res) {
  let corpo;
  try {
    corpo = await lerCorpo(req);
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }

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
