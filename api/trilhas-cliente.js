// GET /api/trilhas-cliente -> trilhas dos produtos ativados do cliente logado,
// com vídeos e o progresso (concluído/percentual) de cada um.

import { aplicarCors, erro } from './_lib/http.js';
import { ErroConfig } from './_lib/auth.js';
import { exigirSessaoCliente } from './_lib/sessao-cliente.js';
import { listarTrilhasPorProdutos, listarVisualizacoesPorEmail, ErroConfigSupabase, ErroSupabase } from './_lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');

    const sessao = exigirSessaoCliente(req, res);
    if (!sessao) return undefined;

    const [trilhas, visualizacoes] = await Promise.all([
      listarTrilhasPorProdutos(sessao.produtos),
      listarVisualizacoesPorEmail(sessao.email),
    ]);

    const progressoPorVideo = new Map(visualizacoes.map((v) => [v.trilha_video_id, v]));

    const resultado = trilhas
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
          produto: t.produto,
          videos,
          totalVideos: videos.length,
          videosAssistidos: videos.filter((v) => v.concluido).length,
        };
      })
      .sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));

    return res.status(200).json({ trilhas: resultado });
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
