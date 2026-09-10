// Integração com a Google Calendar API — OAuth por ISM (conexão individual,
// não delegação por dominio): cada ISM autoriza a propria conta uma vez, o
// backend guarda so o refresh token (ver LISTA_GOOGLE_TOKENS em clickup.js) e
// usa isso pra checar disponibilidade real e criar reuniao com Meet
// automatico ao registrar uma reserva.
//
// Escopos minimos: calendar.events (criar evento) + calendar.freebusy (checar
// disponibilidade) — nao precisa do escopo `calendar` inteiro.

import crypto from 'node:crypto';

const ESCOPOS = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
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

export function assinarEstadoGoogle(ismId) {
  const corpo = b64(JSON.stringify({ ismId: Number(ismId), iat: Date.now() }));
  return `${corpo}.${b64(hmac(corpo))}`;
}

/** Valida assinatura e validade do state. Retorna { ismId } ou null. */
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
  if (!p || typeof p.ismId !== 'number' || typeof p.iat !== 'number') return null;
  if (Date.now() - p.iat > ESTADO_TTL_MS) return null;
  return { ismId: p.ismId };
}

/** URL de consentimento do Google pra um ISM especifico (state carrega o id). */
export function urlAutorizacaoGoogle(ismId) {
  const { clientId, redirectUri } = credenciais();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ESCOPOS,
    access_type: 'offline',
    prompt: 'consent',
    state: assinarEstadoGoogle(ismId),
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

async function calendarRequest(path, accessToken, init = {}) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const corpo = await r.json().catch(() => null);
  if (!r.ok) throw new ErroGoogle(r.status, corpo);
  return corpo;
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

/** Cria o evento na agenda primária do ISM com Meet automático. Devolve o hangoutLink (ou null). */
export async function criarEventoComMeet(accessToken, { titulo, inicio, fim }) {
  const r = await calendarRequest('/calendars/primary/events?conferenceDataVersion=1', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      summary: titulo,
      start: { dateTime: new Date(inicio).toISOString() },
      end: { dateTime: new Date(fim).toISOString() },
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    }),
  });
  return r?.hangoutLink || null;
}
