// Sessão assinada (HMAC-SHA256) + verificação de senha (scrypt).
// Somente módulos nativos do Node.

import crypto from 'node:crypto';
import { erro } from './http.js';

export const COOKIE_NOME = 'cs_sessao';
export const SESSAO_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const TOLERANCIA_FUTURO_MS = 60 * 1000;

export const NIVEIS = ['consulta', 'gestao', 'csm'];

/**
 * Perfis de acesso. A senha de cada perfil vive apenas na variável de ambiente
 * correspondente, sempre como hash scrypt (ver scripts/gerar-hash.js).
 */
export const PERFIS = [
  { env: 'AUTH_CONSULTA', nivel: 'consulta', csm: null, nome: 'Consulta Geral' },
  { env: 'AUTH_GESTAO', nivel: 'gestao', csm: null, nome: 'Gestão' },
  { env: 'AUTH_CSM_GIAN', nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' },
  { env: 'AUTH_CSM_LUCINEIA', nivel: 'csm', csm: 'Lucineia Felix', nome: 'Lucineia Felix' },
  { env: 'AUTH_CSM_GUILHERME', nivel: 'csm', csm: 'Guilherme Camargo', nome: 'Guilherme Camargo' },
  { env: 'AUTH_CSM_PATRICIA', nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' },
];

export class ErroConfig extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroConfig';
  }
}

// ── Assinatura da sessão ──────────────────────────────────────────────────

function segredo() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new ErroConfig('SESSION_SECRET ausente ou com menos de 32 caracteres.');
  }
  return s;
}

function hmac(dados) {
  return crypto.createHmac('sha256', segredo()).update(dados).digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Gera o token de sessão: base64url(payload).base64url(hmac). */
export function assinarSessao({ nivel, csm, nome }) {
  const corpo = b64(JSON.stringify({ nivel, csm: csm || null, nome, iat: Date.now() }));
  return `${corpo}.${b64(hmac(corpo))}`;
}

/** Valida assinatura, validade e forma do payload. Retorna a sessão ou null. */
export function verificarSessao(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
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

  const idade = Date.now() - p.iat;
  if (idade > SESSAO_TTL_MS || idade < -TOLERANCIA_FUTURO_MS) return null;
  if (!NIVEIS.includes(p.nivel)) return null;
  if (p.nivel === 'csm' && !PERFIS.some((x) => x.nivel === 'csm' && x.csm === p.csm)) return null;
  if (p.nivel !== 'csm' && p.csm) return null;

  return { nivel: p.nivel, csm: p.csm || null, nome: String(p.nome || ''), iat: p.iat };
}

// ── Cookie ────────────────────────────────────────────────────────────────

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

export function cookieSessao(token) {
  const maxAge = Math.floor(SESSAO_TTL_MS / 1000);
  return `${COOKIE_NOME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function cookieLimpo() {
  return `${COOKIE_NOME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ── Guarda usada pelos endpoints ──────────────────────────────────────────

const MSG_SESSAO = 'Sessão ausente ou expirada. Faça login novamente.';

/**
 * Exige cookie de sessão válido. Em caso de falha já responde 401 e devolve null.
 * O código "sessao_invalida" é o sinal que o front usa para reabrir o login —
 * nenhum outro 401 desta API carrega esse código.
 *
 * `detalharExpiracao` acrescenta `expirada: true` ao corpo quando havia cookie e
 * ele não validou — para o front distinguir "sua sessão caiu" de "você nunca
 * entrou", que hoje são o mesmo 401 e por isso o reload não mostra mensagem.
 *
 * SÓ o `GET /api/login` pede isso. Nos proxies o 401 permanece genérico, byte a
 * byte: diferenciar lá criaria oráculo de "existe sessão aqui". No /api/login não
 * vaza nada — quem mandou cookie inválido já sabe que tinha um.
 */
export function exigirSessao(req, res, { detalharExpiracao = false } = {}) {
  let sessao = null;
  let tinhaToken = false;
  try {
    const token = lerCookies(req)[COOKIE_NOME];
    tinhaToken = Boolean(token);
    sessao = token ? verificarSessao(token) : null;
  } catch (e) {
    // SESSION_SECRET ausente ou curto faz verificarSessao lançar ErroConfig.
    // Antes isso subia sem tratamento pelos três endpoints — exigirSessao é
    // chamada fora do try em clickup.js e moskit.js, e no ramo GET de login.js —
    // e derrubava a função. Falha de configuração é 500 tratado, não queda.
    if (e instanceof ErroConfig) {
      console.error('[auth] configuracao:', e.message);
      erro(res, 500, 'nao_configurado', 'Sessão não configurada no servidor.');
      return null;
    }
    throw e;
  }
  if (!sessao) {
    res.setHeader('Set-Cookie', cookieLimpo());
    if (detalharExpiracao && tinhaToken) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: MSG_SESSAO, code: 'sessao_invalida', expirada: true });
      return null;
    }
    erro(res, 401, 'sessao_invalida', MSG_SESSAO);
    return null;
  }
  return sessao;
}

/** consulta é somente leitura: nada de escrita no ClickUp nem no Moskit. */
export function podeEscrever(sessao) {
  return sessao.nivel === 'gestao' || sessao.nivel === 'csm';
}

/**
 * Normaliza nome para comparação: sem acentos, sem espaço repetido, minúsculas.
 * "  Gián  Lúca " e "gian luca" viram a mesma coisa.
 */
function normalizarNome(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // marcas combinantes separadas pelo NFD
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Escopo de leitura/escrita por CSM: nome COMPLETO normalizado, igualdade exata.
 *
 * O critério antigo — o campo "Gerente" do ClickUp *contém* o primeiro nome do
 * CSM — casava parcialmente. Bastaria entrar um segundo CSM cujo primeiro nome
 * estivesse contido no de outro (ou um "Gerente" com nome composto) para a
 * carteira de um vazar para o outro. Igualdade exata não tem essa falha.
 *
 * Em troca, exige que o valor do campo "Gerente" no ClickUp seja idêntico ao
 * nome em PERFIS. Divergência não vaza dado: devolve carteira vazia.
 */
export function pertenceAoCsm(gerente, csm) {
  if (!csm) return true;
  const alvo = normalizarNome(csm);
  if (!alvo) return false;
  return normalizarNome(gerente) === alvo;
}

// ── Senhas ────────────────────────────────────────────────────────────────
// Formato armazenado (uma linha por variável de ambiente):
//   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
// Mantenha em sincronia com scripts/gerar-hash.js.

const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Parâmetros ACEITOS, não uma faixa do algoritmo.
 *
 * A versão anterior aceitava N até 1048576 e r até 32, e calculava
 * `maxmem = 256*N*r`. No extremo permitido isso pedia 8,2 GB ao crypto.scrypt —
 * e falha de alocação em código nativo aborta o processo, que `try/catch` não
 * captura. Ou seja: uma variável de ambiente com parâmetros altos derrubava a
 * função em vez de virar 401.
 *
 * A lista abaixo tem exatamente o que scripts/gerar-hash.js emite.
 * AO AUMENTAR O CUSTO: adicione a tupla nova aqui e MANTENHA a antiga até que
 * todos os hashes tenham sido regerados — remover antes tranca todo mundo fora.
 */
const PARAMS_ACEITOS = [{ N: 16384, r: 8, p: 1 }];
const MAXMEM_TETO = 64 * 1024 * 1024;

function paramsAceitos(N, r, p) {
  return PARAMS_ACEITOS.some((x) => x.N === N && x.r === r && x.p === p);
}

function scryptAsync(senha, salt, N, r, p) {
  return new Promise((resolve, reject) => {
    // maxmem acompanha N*r*128 com folga, e nunca passa do teto: todas as
    // tuplas de PARAMS_ACEITOS ficam muito abaixo dele.
    const maxmem = Math.min(256 * N * r + 1024 * 1024, MAXMEM_TETO);
    crypto.scrypt(senha, salt, KEYLEN, { N, r, p, maxmem }, (err, dk) =>
      err ? reject(err) : resolve(dk)
    );
  });
}

/**
 * Decodifica base64 exigindo tamanho exato e ida-e-volta idêntica.
 *
 * O round-trip é o que pega truncamento: `Buffer.from` descarta lixo no fim sem
 * reclamar, então um campo cortado decodifica "com sucesso" para menos bytes.
 * Era assim que um hash corrompido virava "senha incorreta" silencioso.
 */
function base64Exato(texto, bytes) {
  const buf = Buffer.from(texto, 'base64');
  if (buf.length !== bytes) return null;
  if (buf.toString('base64') !== texto) return null;
  return buf;
}

/**
 * Confere a senha contra um hash `scrypt$N$r$p$salt$hash`.
 *
 * Nunca lança. Distingue os dois desfechos que antes eram o mesmo `false`:
 *   { ok: true }                        senha correta
 *   { ok: false, motivo: 'senha_errada' }   senha errada — rotina, sem log
 *   { ok: false, motivo: <outro> }          CONFIGURAÇÃO inválida — quem chama loga
 *
 * A distinção existe porque hash malformado produzia exatamente a mesma resposta
 * de senha errada, sem nenhum registro. Seis variáveis com valor errado geraram
 * "senha incorreta" para todas as senhas e nada no log.
 */
export async function conferirSenha(senha, armazenado) {
  if (typeof armazenado !== 'string') return { ok: false, motivo: 'nao_e_texto' };

  const partes = armazenado.trim().split('$');
  if (partes.length !== 6) {
    return { ok: false, motivo: `formato (${partes.length} campos, esperado 6)` };
  }
  if (partes[0] !== 'scrypt') return { ok: false, motivo: 'prefixo_nao_scrypt' };

  const N = Number(partes[1]);
  const r = Number(partes[2]);
  const p = Number(partes[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return { ok: false, motivo: 'parametros_nao_inteiros' };
  }
  if (!paramsAceitos(N, r, p)) {
    return { ok: false, motivo: `parametros_nao_aceitos (N=${N} r=${r} p=${p})` };
  }

  const salt = base64Exato(partes[4], SALT_BYTES);
  if (!salt) return { ok: false, motivo: `salt_invalido (esperado ${SALT_BYTES}B em base64)` };

  const esperado = base64Exato(partes[5], KEYLEN);
  if (!esperado) return { ok: false, motivo: `hash_invalido (esperado ${KEYLEN}B em base64)` };

  let calculado;
  try {
    calculado = await scryptAsync(senha, salt, N, r, p);
  } catch (e) {
    return { ok: false, motivo: `falha_no_scrypt (${e?.code || e?.name})` };
  }
  if (crypto.timingSafeEqual(calculado, esperado)) return { ok: true };
  return { ok: false, motivo: 'senha_errada' };
}
