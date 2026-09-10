// Integração com a Umbler Talk (Utalk) API — cria o contato e abre a
// conversa no canal configurado, pro ISM continuar manualmente por lá.
//
// NÃO manda mensagem nenhuma automaticamente: a conta ainda não tem nenhum
// template aprovado pela Meta, e o WhatsApp só permite texto livre pra quem
// já mandou mensagem antes (janela de sessão de 24h) — tentar mandar teria
// grande chance de ser rejeitado pra clientes que nunca falaram com esse
// número. O Utalk já sinaliza isso pro ISM quando ele for escrever por lá,
// do mesmo jeito que já acontece hoje ao iniciar uma conversa manualmente.

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

/** Cria a conversa desse contato no canal configurado (ou devolve a já aberta, se houver). */
export async function garantirConversa(contactId) {
  const { organizationId, channelId } = credenciais();
  const chat = await request('/v1/chats/', {
    method: 'POST',
    body: JSON.stringify({ organizationId, channelId, contactId }),
  });
  return chat?.id || null;
}
