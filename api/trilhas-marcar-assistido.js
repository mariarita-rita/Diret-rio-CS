// POST /api/trilhas-marcar-assistido { trilhaVideoId, percentual, progressoSegundos }
//
// Registra o progresso de reprodução de um vídeo para o cliente logado.
// Nunca confia no trilhaVideoId sem checar posse: o vídeo precisa pertencer a
// uma trilha cujo produto está entre os produtos ativados da sessão — mesmo
// princípio já usado para taskId do ClickUp em api/clickup.js (nunca aceitar
// um id vindo do cliente sem validar que ele tem acesso àquele recurso).

import { aplicarCors, erro, lerCorpo, ErroCorpo, uuidValido } from './_lib/http.js';
import { ErroConfig } from './_lib/auth.js';
import { exigirSessaoCliente } from './_lib/sessao-cliente.js';
import { buscarVideoComProduto, upsertVisualizacao, ErroConfigSupabase, ErroSupabase } from './_lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');

    const sessao = exigirSessaoCliente(req, res);
    if (!sessao) return undefined;

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
    if (!sessao.produtos.includes(video.trilhas.produto)) {
      // Cliente não tem mais (ou nunca teve) o produto dessa trilha — nada vaza,
      // só um 403 genérico, sem detalhar qual produto seria necessário.
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
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigSupabase) {
      console.error('[trilhas-marcar-assistido] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Serviço não configurado no servidor.');
    }
    if (e instanceof ErroSupabase) {
      console.error('[trilhas-marcar-assistido] supabase:', e.status);
      return erro(res, 502, 'erro_upstream', 'Falha ao gravar progresso.');
    }
    console.error(`[trilhas-marcar-assistido] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}
