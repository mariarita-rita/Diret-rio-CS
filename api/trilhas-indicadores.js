// GET /api/trilhas-indicadores -> engajamento de treinamento por cliente
// (vídeos disponíveis vs. assistidos, última atividade). Alimenta a aba
// Indicadores de implantacao-waipe.html.
//
// Uso interno (sessão cs_sessao) — mesma leitura para qualquer nível, sem
// filtro por CSM/ISM aqui: é um indicador de engajamento, não dado
// financeiro, e a aba Indicadores já é vista por todo o time de implantação.

import { aplicarCors, erro } from './_lib/http.js';
import { ErroConfig, exigirSessao } from './_lib/auth.js';
import { indicadoresPorCliente, ErroConfigSupabase, ErroSupabase } from './_lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');

    const sessao = exigirSessao(req, res);
    if (!sessao) return undefined;

    const indicadores = await indicadoresPorCliente();
    return res.status(200).json({ indicadores });
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigSupabase) {
      console.error('[trilhas-indicadores] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Serviço não configurado no servidor.');
    }
    if (e instanceof ErroSupabase) {
      console.error('[trilhas-indicadores] supabase:', e.status);
      return erro(res, 502, 'erro_upstream', 'Falha ao calcular indicadores.');
    }
    console.error(`[trilhas-indicadores] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}
