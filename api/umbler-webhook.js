// POST /api/umbler-webhook?token=...
//
// Recebe eventos do Umbler Talk (mensagem nova, em qualquer canal e direção).
// Configurado MANUALMENTE no painel do Umbler Talk (Configurações →
// Webhooks) — a API deles só permite LISTAR/APAGAR webhooks, não CRIAR um
// novo (ver nota em api/_lib/umbler.js), então não dá pra automatizar esse
// cadastro daqui.
//
// Protegido por um token compartilhado na própria URL (UMBLER_WEBHOOK_TOKEN)
// — o Umbler não assina o payload, então essa é a defesa contra chamada
// forjada. Sem sessão de usuário nenhuma: quem chama é o Umbler, não uma
// pessoa logada — a autoridade pra escrever no ClickUp aqui vem do token, não
// de podeEscrever/nivel.
//
// Formato real do evento (confirmado inspecionando o payload ao vivo, não só
// pela doc): { Type:"Message", Payload:{ Content: <BasicChatModel PascalCase,
// vem em Pascal aqui — diferente do camelCase que a API REST devolve> } }.
// Cada mensagem (nossa ou do cliente) dispara um evento — por isso filtra
// ANTES de tocar no ClickUp: só processa quando `LastMessage.Source ===
// "Contact"` (mensagem do cliente, não da equipe), o canal bate com
// UMBLER_CHANNEL_ID, e não é um grupo. A maioria dos eventos recebidos
// (mensagens nossas, outros canais, grupos) para bem antes de custar uma
// chamada ao ClickUp.
//
// Sempre responde 200 (exceto token inválido/ausente): o Umbler PAUSA um
// webhook sozinho depois de falhas repetidas (campo `pausedDueToFailures` na
// API deles) — um erro nosso não pode arriscar derrubar o recebimento.

import { aplicarCors, erro, lerCorpo, ErroCorpo } from './_lib/http.js';
import {
  atualizarTask,
  listarImplantacoes,
  parseWaipeState,
  soDigitos,
  stringifyWaipeState,
} from './_lib/clickup.js';
import { telefoneParaE164 } from './_lib/umbler.js';

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

    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (e) {
      if (e instanceof ErroCorpo) return res.status(200).json({ ok: true, ignorado: 'corpo_invalido' });
      throw e;
    }

    await processarEvento(corpo);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[umbler-webhook] falha inesperada:', e?.name, e?.message);
    // 200 mesmo em falha nossa — ver nota no topo sobre o Umbler pausar o webhook.
    return res.status(200).json({ ok: true });
  }
}

async function processarEvento(corpo) {
  const chat = corpo?.Payload?.Content;
  const ultimaMensagem = chat?.LastMessage;
  if (corpo?.Type !== 'Message' || !chat || !ultimaMensagem) return;

  // Filtros baratos (sem chamar o ClickUp) — a maioria dos eventos recebidos
  // para aqui: mensagem nossa (Source !== "Contact"), canal diferente do
  // configurado, ou grupo (nao e conversa 1:1 com um cliente).
  if (ultimaMensagem.Source !== 'Contact') return;
  if (chat.Contact?.ContactType === 'Group') return;
  const canalId = chat.Channel?.Id;
  if (!canalId || canalId !== process.env.UMBLER_CHANNEL_ID) return;

  const telefoneDigitos = soDigitos(chat.Contact?.PhoneNumber);
  if (!telefoneDigitos) return;

  const dataMensagemMs = Date.parse(ultimaMensagem.EventAtUTC || '');
  if (!Number.isFinite(dataMensagemMs)) return;

  // Normaliza o telefone GRAVADO pro mesmo formato (E.164, com DDI) do que
  // vem do Umbler — sem isso, "(43) 98492-7116" (sem DDI, como é digitado no
  // formulário) nunca bate com "+5543984927116" (que sempre vem com DDI).
  const projetos = await listarImplantacoes();
  const projeto = projetos.find((t) => {
    const estado = parseWaipeState(t.description);
    const telefoneProjetoE164 = telefoneParaE164(estado.telefone);
    return telefoneProjetoE164 && soDigitos(telefoneProjetoE164) === telefoneDigitos;
  });
  if (!projeto) return; // telefone nao bate com nenhum projeto — nada a marcar

  const estadoAtual = parseWaipeState(projeto.description);
  if (Number(estadoAtual.ultimaMensagemClienteEm) >= dataMensagemMs) return; // ja registrado, evento fora de ordem

  const novoEstado = { ...estadoAtual, ultimaMensagemClienteEm: dataMensagemMs };
  await atualizarTask(projeto.id, {
    markdown_description: stringifyWaipeState(projeto.description, novoEstado),
  });
}
