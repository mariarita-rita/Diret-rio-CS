// GET /api/google-oauth-callback?code=...&state=...
//
// Destino do redirect que o Google manda de volta depois do consentimento
// OAuth de um ISM. Fica FORA do dispatcher de api/clickup.js de proposito:
// la, toda acao passa por exigirSessao incondicionalmente (cookie de
// sessao), mas o cookie deste app e SameSite=Strict — nunca chega aqui,
// porque a navegacao vem de accounts.google.com (outro site), mesmo sendo
// um redirect de topo. A identidade de qual ISM esta conectando vem inteira
// do `state` assinado (ver assinarEstadoGoogle/verificarEstadoGoogle em
// _lib/google.js), gerado por conectar-agenda-google (esse sim, dentro do
// dispatcher normal, com sessao exigida).
//
// Nunca cacheavel, e nunca devolve JSON de erro pro usuario final — sempre
// redireciona de volta pro painel, com sucesso ou erro, pra nao deixar a
// pessoa "presa" numa tela de callback.

import { aplicarCors, erro } from './_lib/http.js';
import { verificarEstadoGoogle, trocarCodigoPorToken, ErroGoogle, ErroConfigGoogle } from './_lib/google.js';
import { salvarTokenGoogle } from './_lib/clickup.js';

const DESTINO_OK = '/implantacao-waipe.html?googleConectado=1';
const DESTINO_ERRO = '/implantacao-waipe.html?googleErro=1';

function redirecionar(res, destino) {
  res.setHeader('Location', destino);
  return res.status(302).end();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }

    const code = String(req.query?.code || '');
    const state = String(req.query?.state || '');
    if (!code || !state) return redirecionar(res, DESTINO_ERRO);

    const estado = verificarEstadoGoogle(state);
    if (!estado) return redirecionar(res, DESTINO_ERRO);

    let tokens;
    try {
      tokens = await trocarCodigoPorToken(code);
    } catch (e) {
      if (e instanceof ErroGoogle) return redirecionar(res, DESTINO_ERRO);
      throw e;
    }
    if (!tokens?.refresh_token) return redirecionar(res, DESTINO_ERRO);

    await salvarTokenGoogle(estado.ismId, tokens.refresh_token);
    return redirecionar(res, DESTINO_OK);
  } catch (e) {
    if (e instanceof ErroConfigGoogle) {
      console.error('[google-oauth-callback] config ausente:', e.message);
    } else {
      console.error('[google-oauth-callback] falha inesperada:', e);
    }
    return redirecionar(res, DESTINO_ERRO);
  }
}
