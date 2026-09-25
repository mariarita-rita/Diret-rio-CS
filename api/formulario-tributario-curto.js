// GET /formulario-tributario/:codigo (reescrito pelo vercel.json pra
// /api/formulario-tributario-curto?codigo=:codigo)
//
// Link CURTO pro formulário tributário público — existe só pra caber
// melhor numa mensagem de WhatsApp (ver assinarLinkCurto em
// _lib/clickup.js). Confere a assinatura curta, re-assina com o token
// COMPLETO de sempre (assinarTokenProjeto) e redireciona pra
// formulario-tributario.html, que faz a verificação de sempre
// (verificarTokenProjeto) — nenhuma segurança nova nem diferente, só um
// passo a mais de indireção pra encurtar o link visível.
//
// Fica FORA do dispatcher de api/clickup.js de propósito, mesmo motivo de
// google-oauth-callback.js: é um link público, clicado por gente sem
// sessão nenhuma neste painel — nunca exige cookie.

import { aplicarCors, erro } from './_lib/http.js';
import { verificarLinkCurto, assinarTokenProjeto } from './_lib/clickup.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!aplicarCors(req, res)) {
    return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
  }

  const codigo = String(req.query?.codigo || '');
  const taskId = verificarLinkCurto(codigo);
  if (!taskId) {
    return erro(res, 404, 'link_invalido', 'Link inválido ou expirado.');
  }

  const token = assinarTokenProjeto(taskId);
  res.setHeader('Location', `/formulario-tributario.html?id=${encodeURIComponent(taskId)}&token=${encodeURIComponent(token)}`);
  return res.status(302).end();
}
