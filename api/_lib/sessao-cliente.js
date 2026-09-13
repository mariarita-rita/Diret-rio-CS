// Sessão do cliente (Central de Treinamento) — HMAC-SHA256, mesma ideia de
// api/_lib/auth.js, mas deliberadamente um módulo separado: a sessão interna
// (cs_sessao) usa um conjunto estático de perfis (PERFIS/NIVEIS, um por
// variável de ambiente); aqui o "perfil" é dinâmico (um cliente cadastrado no
// Supabase), o que não se encaixa naquele modelo. Cookie próprio
// (cs_sessao_cliente) para conviver no mesmo navegador com uma sessão interna
// sem colisão — útil, por exemplo, quando alguém do time testa a visão do
// cliente numa aba ao lado do próprio painel interno.
//
// Reaproveita SESSION_SECRET (em vez de exigir uma variável nova) com um
// prefixo de domínio fixo na string assinada, para que um token de cliente
// jamais valide como token interno nem vice-versa mesmo com o mesmo segredo.

import crypto from 'node:crypto';
import { ErroConfig } from './auth.js';

export const COOKIE_NOME = 'cs_sessao_cliente';
export const SESSAO_TTL_MS = 12 * 60 * 60 * 1000; // 12h — mesmo TTL da sessão interna
const TOLERANCIA_FUTURO_MS = 60 * 1000;
const DOMINIO = 'cliente'; // separa a assinatura da sessão interna, mesmo reaproveitando o segredo

function segredo() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new ErroConfig('SESSION_SECRET ausente ou com menos de 32 caracteres.');
  }
  return s;
}

function hmac(dados) {
  return crypto.createHmac('sha256', segredo()).update(`${DOMINIO}:${dados}`).digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Gera o token de sessão do cliente: base64url(payload).base64url(hmac). */
export function assinarSessaoCliente({ clienteId, email, nome, produtos }) {
  const corpo = b64(JSON.stringify({
    clienteId,
    email: String(email || '').toLowerCase(),
    nome: String(nome || ''),
    produtos: Array.isArray(produtos) ? produtos : [],
    iat: Date.now(),
  }));
  return `${corpo}.${b64(hmac(corpo))}`;
}

/** Valida assinatura, validade e forma do payload. Retorna a sessão ou null. */
export function verificarSessaoCliente(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
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
  if (!p || typeof p !== 'object') return null;
  if (typeof p.iat !== 'number' || !Number.isFinite(p.iat)) return null;
  if (typeof p.clienteId !== 'string' || !p.clienteId) return null;
  if (typeof p.email !== 'string' || !p.email) return null;

  const idade = Date.now() - p.iat;
  if (idade > SESSAO_TTL_MS || idade < -TOLERANCIA_FUTURO_MS) return null;

  return {
    clienteId: p.clienteId,
    email: p.email,
    nome: String(p.nome || ''),
    produtos: Array.isArray(p.produtos) ? p.produtos : [],
    iat: p.iat,
  };
}

// ── Cookie ────────────────────────────────────────────────────────────────
// lerCookies é idêntico ao de auth.js — não reimportamos daquele módulo para
// manter este arquivo sem nenhuma dependência do modelo de sessão interna
// além do segredo e do ErroConfig.

export function lerCookies(req) {
  const cru = req.headers.cookie;
  const out = {};
  if (!cru) return out;
  for (const parte of cru.split(';')) {
    const i = parte.indexOf('=');
    if (i < 1) continue;
    out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

export function cookieSessaoCliente(token) {
  const maxAge = Math.floor(SESSAO_TTL_MS / 1000);
  return `${COOKIE_NOME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function cookieClienteLimpo() {
  return `${COOKIE_NOME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ── Guarda usada pelos endpoints do cliente ────────────────────────────────

const MSG_SESSAO = 'Sessão ausente ou expirada. Faça login novamente.';

export function exigirSessaoCliente(req, res, { detalharExpiracao = false } = {}) {
  let sessao = null;
  let tinhaToken = false;
  try {
    const token = lerCookies(req)[COOKIE_NOME];
    tinhaToken = Boolean(token);
    sessao = token ? verificarSessaoCliente(token) : null;
  } catch (e) {
    if (e instanceof ErroConfig) {
      console.error('[sessao-cliente] configuracao:', e.message);
      res.setHeader('Cache-Control', 'no-store');
      res.status(500).json({ error: 'Sessão não configurada no servidor.', code: 'nao_configurado' });
      return null;
    }
    throw e;
  }
  if (!sessao) {
    res.setHeader('Set-Cookie', cookieClienteLimpo());
    res.setHeader('Cache-Control', 'no-store');
    if (detalharExpiracao && tinhaToken) {
      res.status(401).json({ error: MSG_SESSAO, code: 'sessao_invalida', expirada: true });
      return null;
    }
    res.status(401).json({ error: MSG_SESSAO, code: 'sessao_invalida' });
    return null;
  }
  return sessao;
}
