// Integração com a Umbler Talk (Utalk) API — cria o contato, abre a conversa
// no canal configurado e (opcionalmente) manda a mensagem de abertura.
//
// Os canais desta organização são do tipo "Broker" (não a Cloud API oficial
// da Meta) — por isso a própria usuária confirmou que dá pra mandar texto
// livre sem precisar de template pré-aprovado, diferente do que a regra geral
// do WhatsApp Business exigiria num canal oficial.

export class ErroConfigUmbler extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroConfigUmbler';
  }
}

export class ErroUmbler extends Error {
  constructor(status, corpo) {
    super(`Umbler Talk respondeu ${status}`);
    this.name = 'ErroUmbler';
    this.status = status;
    this.corpo = corpo;
  }
}

function credenciais() {
  const token = process.env.UMBLER_API_TOKEN;
  const organizationId = process.env.UMBLER_ORGANIZATION_ID;
  const channelId = process.env.UMBLER_CHANNEL_ID;
  if (!token || !organizationId || !channelId) {
    throw new ErroConfigUmbler('UMBLER_API_TOKEN/UMBLER_ORGANIZATION_ID/UMBLER_CHANNEL_ID ausentes.');
  }
  return { token, organizationId, channelId };
}

async function request(path, init = {}) {
  const { token } = credenciais();
  const r = await fetch(`https://app-utalk.umbler.com/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const corpo = await r.json().catch(() => null);
  if (!r.ok) throw new ErroUmbler(r.status, corpo);
  return corpo;
}

/** Converte um telefone BR em qualquer formato de digitação pro E.164 exigido pela API (+55DDD9NNNNNNNN). */
export function telefoneParaE164(telefone) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (!digitos) return null;
  const comDdi = digitos.startsWith('55') ? digitos : `55${digitos}`;
  // 55 + DDD (2) + numero (8 ou 9 digitos) = 12 ou 13 digitos no total.
  if (comDdi.length < 12 || comDdi.length > 13) return null;
  return `+${comDdi}`;
}

/** Acha o contato pelo telefone; cria um novo se ainda não existir. Devolve o contactId. */
export async function garantirContato(telefoneE164, nome) {
  const { organizationId } = credenciais();
  const params = new URLSearchParams({ organizationId, phoneNumber: telefoneE164 });
  try {
    const existente = await request(`/v1/contacts/phone/?${params.toString()}`);
    if (existente?.id) return existente.id;
  } catch (e) {
    if (!(e instanceof ErroUmbler) || e.status !== 404) throw e;
  }
  const criado = await request('/v1/contacts/', {
    method: 'POST',
    body: JSON.stringify({ organizationId, phoneNumber: telefoneE164, name: nome || undefined }),
  });
  return criado?.contact?.id || null;
}

/**
 * Cria a conversa desse contato no canal configurado (ou devolve a já aberta,
 * se houver — a API não avisa qual dos dois casos foi, então quem chama usa
 * `criadaAgora` pra diferenciar: `eventAtUTC` de uma conversa recém-criada é o
 * próprio instante da criação, então bem recente = nova; mais antigo = já existia).
 */
export async function garantirConversa(contactId) {
  const { organizationId, channelId } = credenciais();
  const chat = await request('/v1/chats/', {
    method: 'POST',
    body: JSON.stringify({ organizationId, channelId, contactId }),
  });
  if (!chat?.id) return null;
  const eventoMs = Date.parse(chat.eventAtUTC || '');
  return {
    id: chat.id,
    criadaAgora: Number.isFinite(eventoMs) && Date.now() - eventoMs < 15000,
    setor: chat.sector?.name || null,
  };
}

/** Manda uma mensagem de texto livre na conversa. Devolve o id da mensagem enviada. */
export async function enviarMensagem(chatId, mensagem) {
  const { organizationId } = credenciais();
  const enviada = await request('/v1/messages/', {
    method: 'POST',
    body: JSON.stringify({ organizationId, chatId, message: mensagem }),
  });
  return enviada?.id || null;
}

/**
 * Busca o histórico recente de conversa desse telefone no canal configurado —
 * SEM criar nada (diferente de garantirContato/garantirConversa). Devolve
 * `null` quando não existe conversa nenhuma ainda.
 */
export async function buscarHistoricoConversa(telefoneE164) {
  const { organizationId, channelId } = credenciais();

  let contato;
  try {
    contato = await request(`/v1/contacts/phone/?${new URLSearchParams({ organizationId, phoneNumber: telefoneE164 })}`);
  } catch (e) {
    if (e instanceof ErroUmbler && e.status === 404) return null;
    throw e;
  }
  if (!contato?.id) return null;

  const paramsChats = new URLSearchParams({
    organizationId, PhoneNumbers: telefoneE164, ChatState: 'All',
    ChatOrderBy: 'LastMessage', Order: 'Desc', Take: '5',
  });
  paramsChats.append('Channels.Values', channelId);
  const listaChats = await request(`/v1/chats/?${paramsChats.toString()}`);
  const chatResumo = (listaChats?.items || [])[0];
  if (!chatResumo?.id) return null;

  const detalhe = await request(`/v1/chats/${chatResumo.id}/?${new URLSearchParams({ organizationId, includeMessages: '10' })}`);

  const mensagens = (detalhe?.latestMessages || [])
    .filter((m) => m._t === 'MessageModel' || m._t === 'SentMessageModel')
    .map((m) => ({
      texto: m.content || '',
      // `sentByOrganizationMember` vem preenchido quando quem mandou foi a
      // equipe, e null quando foi o contato — é esse campo que a API
      // documenta sem ambiguidade ("null if sent by the contact"). O campo
      // `fromContact` parecia o certo pelo nome, mas o texto da própria
      // documentação da Umbler é sobre outra coisa — testado ao vivo e
      // confirmado que só `sentByOrganizationMember` distingue certo.
      deCliente: !m.sentByOrganizationMember,
      dataMs: Date.parse(m.eventAtUTC || '') || null,
    }))
    .filter((m) => m.texto);

  return {
    aberta: !!detalhe?.open,
    setor: detalhe?.sector?.name || null,
    ultimaMensagemEm: Date.parse(detalhe?.eventAtUTC || '') || null,
    mensagens,
  };
}
