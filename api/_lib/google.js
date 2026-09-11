// Integração com contas Google — OAuth por PESSOA (conexão individual, não
// delegação por dominio): cada um autoriza a propria conta uma vez, o
// backend guarda so o refresh token (ver LISTA_GOOGLE_TOKENS em clickup.js).
// Duas finalidades independentes, com escopos e autorizacoes separadas —
// conectar a agenda NAO da permissao de mandar e-mail, e vice-versa, entao
// quem ja tinha conectado a agenda antes do envio de e-mail existir continua
// sem gmail.send ate conectar o e-mail tambem (sem reconsentimento forçado):
//   - calendar: checar disponibilidade real + criar reuniao com Meet
//     automatico ao registrar uma reserva.
//   - email: mandar e-mail pro cliente direto do painel (por pessoa, ou por
//     uma conta compartilhada — ver CONTA_EMAIL_COMPARTILHADA em clickup.js).
//
// Escopos minimos: calendar.events (criar evento) + calendar.freebusy (checar
// disponibilidade) pra agenda; gmail.send (mandar e-mail) + userinfo.email
// (descobrir qual endereco foi autorizado, so pra mostrar na tela) pro e-mail.

import crypto from 'node:crypto';

const ESCOPOS_CALENDAR = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
].join(' ');

const ESCOPOS_EMAIL = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const ESTADO_TTL_MS = 10 * 60 * 1000; // 10min — so precisa durar o consentimento no Google

export class ErroConfigGoogle extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroConfigGoogle';
  }
}

export class ErroGoogle extends Error {
  constructor(status, corpo) {
    super(`Google respondeu ${status}`);
    this.name = 'ErroGoogle';
    this.status = status;
    this.corpo = corpo;
  }
}

function credenciais() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new ErroConfigGoogle('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI ausentes.');
  }
  return { clientId, clientSecret, redirectUri };
}

// ── state assinado (mesmo esquema HMAC de assinarSessao/verificarSessao em
// auth.js, payload proprio — nao reutiliza aquelas funcoes diretamente
// porque o formato do payload e outro). Usa o mesmo SESSION_SECRET: mesmo
// limite de confianca, sem precisar de segredo novo so pra isso. ──────────

function segredo() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new ErroConfigGoogle('SESSION_SECRET ausente ou com menos de 32 caracteres.');
  return s;
}

function hmac(dados) {
  return crypto.createHmac('sha256', segredo()).update(dados).digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/**
 * `alvo` e o `ismId` numerico (finalidade "calendar") ou uma chave string
 * (finalidade "email" — nome de login ou CONTA_EMAIL_COMPARTILHADA). O tipo
 * de `alvo` fica por conta de quem assina; aqui so carrega o que foi dado.
 */
export function assinarEstadoGoogle(finalidade, alvo) {
  const corpo = b64(JSON.stringify({ finalidade, alvo, iat: Date.now() }));
  return `${corpo}.${b64(hmac(corpo))}`;
}

/** Valida assinatura, validade e forma do state. Retorna { finalidade, alvo } ou null. */
export function verificarEstadoGoogle(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const ponto = token.indexOf('.');
  if (ponto < 1 || ponto === token.length - 1) return null;

  const corpo = token.slice(0, ponto);
  const assinatura = Buffer.from(token.slice(ponto + 1));
  const esperada = Buffer.from(b64(hmac(corpo)));
  if (assinatura.length !== esperada.length) return null;
  if (!crypto.timingSafeEqual(assinatura, esperada)) return null;

  let p;
  try {
    p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!p || (p.finalidade !== 'calendar' && p.finalidade !== 'email')) return null;
  if (p.alvo === undefined || p.alvo === null || typeof p.iat !== 'number') return null;
  if (Date.now() - p.iat > ESTADO_TTL_MS) return null;
  return { finalidade: p.finalidade, alvo: p.alvo };
}

/** URL de consentimento do Google pra uma finalidade+alvo especificos (state carrega os dois). */
export function urlAutorizacaoGoogle(finalidade, alvo) {
  const { clientId, redirectUri } = credenciais();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: finalidade === 'email' ? ESCOPOS_EMAIL : ESCOPOS_CALENDAR,
    access_type: 'offline',
    prompt: 'consent',
    state: assinarEstadoGoogle(finalidade, alvo),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenRequest(body) {
  const { clientId, clientSecret, redirectUri } = credenciais();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, ...body }),
  });
  const corpo = await r.json().catch(() => null);
  if (!r.ok) throw new ErroGoogle(r.status, corpo);
  return corpo;
}

/** Troca o `code` do redirect do Google por { access_token, refresh_token, ... }. */
export async function trocarCodigoPorToken(code) {
  return tokenRequest({ code, grant_type: 'authorization_code' });
}

/** Renova o access_token a partir do refresh_token salvo. Chamado a cada operação (sem cache — baixo volume). */
export async function renovarAccessToken(refreshToken) {
  const r = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  return r.access_token;
}

/** Fetch autenticado (Bearer) generico contra qualquer API do Google — usado
 * pelos wrappers de path fixo abaixo (calendarRequest) e diretamente por
 * quem chama uma API de base diferente (userinfo, Gmail). */
async function googleApiRequest(url, accessToken, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const corpo = await r.json().catch(() => null);
  if (!r.ok) throw new ErroGoogle(r.status, corpo);
  return corpo;
}

async function calendarRequest(path, accessToken, init = {}) {
  return googleApiRequest(`https://www.googleapis.com/calendar/v3${path}`, accessToken, init);
}

/** Endereco de e-mail da conta que acabou de autorizar (usado logo apos trocar
 * o code por token, pra saber QUAL Gmail foi conectado e mostrar na tela). */
export async function obterEmailConectado(accessToken) {
  const r = await googleApiRequest('https://www.googleapis.com/oauth2/v2/userinfo', accessToken);
  return r?.email || null;
}

/**
 * Monta a mensagem RFC 2822 e manda via Gmail API (`users.messages.send`).
 * Assunto e corpo em portugues tem acento — Subject vai como "encoded-word"
 * (RFC 2047, base64) e o corpo como base64 com charset UTF-8 explicito,
 * senao acento chega quebrado do outro lado.
 */
export async function enviarEmailGmail(accessToken, { de, para, assunto, corpoTexto }) {
  const assuntoCodificado = `=?UTF-8?B?${Buffer.from(String(assunto || ''), 'utf8').toString('base64')}?=`;
  const corpoBase64 = Buffer.from(String(corpoTexto || ''), 'utf8').toString('base64');
  const mensagem = [
    `From: ${de}`,
    `To: ${para.join(', ')}`,
    `Subject: ${assuntoCodificado}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    corpoBase64,
  ].join('\r\n');
  const raw = Buffer.from(mensagem, 'utf8').toString('base64url');
  return googleApiRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', accessToken, {
    method: 'POST',
    body: JSON.stringify({ raw }),
  });
}

/** Consulta se a agenda primária do ISM tem algo marcado entre inicio/fim (epoch ms). */
export async function consultarFreeBusy(accessToken, inicio, fim) {
  const r = await calendarRequest('/freeBusy', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      timeMin: new Date(inicio).toISOString(),
      timeMax: new Date(fim).toISOString(),
      items: [{ id: 'primary' }],
    }),
  });
  const ocupado = r?.calendars?.primary?.busy || [];
  return ocupado.length ? ocupado[0] : null;
}

/**
 * Lista os eventos da agenda primária do ISM entre inicio/fim (epoch ms) —
 * usado pra achar reservas feitas pelo próprio cliente numa página de
 * agendamento do Google (fora do nosso fluxo de criar-reserva).
 */
export async function listarEventos(accessToken, inicio, fim) {
  const params = new URLSearchParams({
    timeMin: new Date(inicio).toISOString(),
    timeMax: new Date(fim).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const r = await calendarRequest(`/calendars/primary/events?${params.toString()}`, accessToken);
  return r?.items || [];
}

/**
 * Cria o evento na agenda primária do ISM com Meet automático. Devolve o
 * hangoutLink (ou null). `attendees`, quando presente, e-mail o cliente/
 * outros participantes como convidados do evento — `sendUpdates=all` faz o
 * Google mandar o convite por e-mail pra eles (sem convidados, mantém o
 * comportamento de sempre: nenhuma notificação).
 */
export async function criarEventoComMeet(accessToken, { titulo, inicio, fim, attendees }) {
  const corpo = {
    summary: titulo,
    start: { dateTime: new Date(inicio).toISOString() },
    end: { dateTime: new Date(fim).toISOString() },
    conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  };
  const temConvidados = Array.isArray(attendees) && attendees.length > 0;
  if (temConvidados) {
    corpo.attendees = attendees.map((email) => ({ email }));
  }
  const r = await calendarRequest(
    `/calendars/primary/events?conferenceDataVersion=1&sendUpdates=${temConvidados ? 'all' : 'none'}`,
    accessToken,
    { method: 'POST', body: JSON.stringify(corpo) },
  );
  return r?.hangoutLink || null;
}
