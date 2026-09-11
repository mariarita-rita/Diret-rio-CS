// GET /api/google-oauth-callback?code=...&state=...
//
// Destino do redirect que o Google manda de volta depois do consentimento
// OAuth (agenda OU e-mail — duas finalidades independentes, ver
// _lib/google.js). Fica FORA do dispatcher de api/clickup.js de proposito:
// la, toda acao passa por exigirSessao incondicionalmente (cookie de
// sessao), mas o cookie deste app e SameSite=Strict — nunca chega aqui,
// porque a navegacao vem de accounts.google.com (outro site), mesmo sendo
// um redirect de topo. A identidade de quem esta conectando (e PRA QUE)
// vem inteira do `state` assinado (ver assinarEstadoGoogle/
// verificarEstadoGoogle em _lib/google.js), gerado por
// conectar-agenda-google/conectar-email-google (esses sim, dentro do
// dispatcher normal, com sessao exigida).
//
// Nunca cacheavel, e nunca devolve JSON de erro pro usuario final — sempre
// redireciona de volta pro painel, com sucesso ou erro, pra nao deixar a
// pessoa "presa" numa tela de callback.

import { aplicarCors, erro } from './_lib/http.js';
import { verificarEstadoGoogle, trocarCodigoPorToken, obterEmailConectado, ErroGoogle, ErroConfigGoogle } from './_lib/google.js';
import { salvarTokenGoogle, salvarTokenEmail } from './_lib/clickup.js';

const DESTINOS_OK = { calendar: '/implantacao-waipe.html?googleConectado=1', email: '/implantacao-waipe.html?emailConectado=1' };
const DESTINOS_ERRO = { calendar: '/implantacao-waipe.html?googleErro=1', email: '/implantacao-waipe.html?emailErro=1' };
const DESTINO_ERRO = '/implantacao-waipe.html?googleErro=1'; // fallback quando nem o `state` deu pra validar (nao sabemos a finalidade)

function redirecionar(res, destino) {
  res.setHeader('Location', destino);
  return res.status(302).end();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // So sabemos se era pra agenda ou e-mail depois de validar o `state` — ate
  // la, cai no generico (raro: state ausente/adulterado/expirado).
  let destinoErro = DESTINO_ERRO;

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
    if (!code || !state) return redirecionar(res, destinoErro);

    const estado = verificarEstadoGoogle(state);
    if (!estado) return redirecionar(res, destinoErro);
    destinoErro = DESTINOS_ERRO[estado.finalidade] || DESTINO_ERRO;

    let tokens;
    try {
      tokens = await trocarCodigoPorToken(code);
    } catch (e) {
      if (e instanceof ErroGoogle) return redirecionar(res, destinoErro);
      throw e;
    }
    if (!tokens?.refresh_token) return redirecionar(res, destinoErro);

    if (estado.finalidade === 'email') {
      const emailConectado = await obterEmailConectado(tokens.access_token);
      if (!emailConectado) return redirecionar(res, destinoErro);
      await salvarTokenEmail(estado.alvo, tokens.refresh_token, emailConectado);
    } else {
      await salvarTokenGoogle(estado.alvo, tokens.refresh_token);
    }
    return redirecionar(res, DESTINOS_OK[estado.finalidade] || DESTINOS_OK.calendar);
  } catch (e) {
    if (e instanceof ErroConfigGoogle) {
      console.error('[google-oauth-callback] config ausente:', e.message);
    } else {
      console.error('[google-oauth-callback] falha inesperada:', e);
    }
    return redirecionar(res, destinoErro);
  }
}
