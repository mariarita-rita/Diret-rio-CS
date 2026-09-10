// POST /api/umbler-webhook?token=...
//
// Recebe eventos do Umbler Talk (mensagem nova do cliente, etc). Configurado
// MANUALMENTE no painel do Umbler Talk (Configurações → Webhooks) — a API
// deles só permite LISTAR/APAGAR webhooks, não CRIAR um novo (ver nota em
// api/_lib/umbler.js), então não dá pra automatizar esse cadastro daqui.
//
// Protegido por um token compartilhado na própria URL (UMBLER_WEBHOOK_TOKEN)
// — o Umbler não assina o payload, então essa é a defesa contra chamada forjada.
//
// AINDA EM INSPEÇÃO: só loga o payload recebido por enquanto (`vercel logs` /
// aba de logs do projeto), pra confirmar o formato real de um evento antes de
// processar de verdade (casar telefone → projeto, marcar "mensagem nova" pro
// indicador na tela). Ver README para o passo a passo de configuração.
//
// Sempre responde 200 (exceto token inválido/ausente): o Umbler PAUSA um
// webhook sozinho depois de falhas repetidas (campo `pausedDueToFailures` na
// API deles) — um erro nosso não pode arriscar derrubar o recebimento.

import { aplicarCors, erro } from './_lib/http.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }

    const tokenEsperado = process.env.UMBLER_WEBHOOK_TOKEN;
    if (!tokenEsperado) {
      console.error('[umbler-webhook] UMBLER_WEBHOOK_TOKEN ausente na configuração.');
      return res.status(500).json({ error: 'nao_configurado' });
    }
    if (String(req.query?.token || '') !== tokenEsperado) {
      return erro(res, 403, 'token_invalido', 'Token inválido.');
    }

    console.log('[umbler-webhook] evento recebido:', JSON.stringify(req.body)?.slice(0, 4000));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[umbler-webhook] falha inesperada:', e?.name, e?.message);
    // 200 mesmo em falha nossa — ver nota acima sobre o Umbler pausar o webhook.
    return res.status(200).json({ ok: true });
  }
}
