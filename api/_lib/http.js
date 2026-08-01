// Helpers HTTP compartilhados pelas funções serverless.
// Somente módulos nativos do Node — nenhuma dependência externa.
//
// Arquivos dentro de /api com prefixo "_" não viram endpoints na Vercel.

/** Loopback: a única situação em que uma origem `http://` é legítima. */
const RE_LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function hostLoopback(host) {
  return RE_LOOPBACK.test(String(host || ''));
}

/**
 * O esquema `http` é aceitável nesta requisição?
 *
 * Critério é o HOST, não variável de ambiente. `vercel dev` não define
 * VERCEL_ENV nem NODE_ENV no runtime das funções — medido: ambos ausentes — e
 * qualquer regra baseada neles trata dev como produção e derruba o CORS local.
 * Host sempre existe, em qualquer runtime.
 *
 * A decisão exige que `host` E `x-forwarded-host` (quando presente) sejam
 * loopback. XFH é, em princípio, cabeçalho escrito pelo cliente; na Vercel a
 * plataforma o sobrescreve, mas privilégio não se concede com base em garantia
 * de configuração. Em deploy publicado nenhum dos dois é loopback.
 */
function aceitaHttp(req) {
  const direto = req.headers.host;
  const encaminhado = req.headers['x-forwarded-host'];
  if (!hostLoopback(direto)) return false;
  if (encaminhado && !hostLoopback(encaminhado)) return false;
  // Segunda tranca, redundante de propósito: deploy publicado nunca libera http.
  const publicado = process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';
  return !publicado;
}

/**
 * Filtra entradas de ALLOWED_ORIGINS.
 * `https://` passa. `http://` só em loopback — assim, cadastrar
 * `ALLOWED_ORIGINS=http://algum-dominio` no ambiente de produção da Vercel não
 * afrouxa nada: a entrada é descartada e o descarte vai para o log.
 * Qualquer outro esquema (ou lixo não parseável) é recusado.
 */
function origemExtraValida(origem) {
  let u;
  try {
    u = new URL(origem);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return hostLoopback(u.host);
  return false;
}

/** Origens aceitas: a própria origem do deploy + extras opcionais em ALLOWED_ORIGINS. */
export function origensPermitidas(req) {
  const set = new Set();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    // Casar Origin com o host da própria requisição é a definição de mesma origem.
    set.add(`https://${host}`);
    if (aceitaHttp(req)) set.add(`http://${host}`);
  }
  for (const extra of String(process.env.ALLOWED_ORIGINS || '').split(',')) {
    const o = extra.trim();
    if (!o) continue;
    if (!origemExtraValida(o)) {
      console.error(
        `[cors] entrada de ALLOWED_ORIGINS descartada: ${JSON.stringify(o)} — ` +
          'apenas https://, ou http:// em loopback'
      );
      continue;
    }
    set.add(o);
  }
  return set;
}

/**
 * CORS restrito — jamais "*".
 * Só devolve Access-Control-Allow-Origin para a própria origem.
 * Requisições sem header Origin (fetch same-origin, curl) passam por aqui,
 * mas continuam obrigadas a apresentar o cookie de sessão.
 *
 * @returns {boolean} false quando a origem é estranha e a requisição deve morrer.
 */
export function aplicarCors(req, res) {
  res.setHeader('Vary', 'Origin, Cookie');
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!origensPermitidas(req).has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

/** Resposta de erro padronizada. Nunca inclui corpo cru de upstream nem credenciais. */
export function erro(res, status, code, mensagem) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error: mensagem, code });
}

/** IP do cliente atrás do proxy da Vercel. */
export function ipCliente(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconhecido';
}

export class ErroCorpo extends Error {
  constructor(mensagem = 'Corpo da requisição inválido — esperado JSON.') {
    super(mensagem);
    this.name = 'ErroCorpo';
  }
}

const LIMITE_CORPO = 100 * 1024;

/**
 * Lê o corpo JSON da requisição.
 * A Vercel normalmente já entrega req.body parseado; os outros ramos existem
 * para `vercel dev` e para runtimes que não fazem o parse.
 */
export async function lerCorpo(req) {
  if (Buffer.isBuffer(req.body)) {
    if (!req.body.length) return {};
    try { return JSON.parse(req.body.toString('utf8')); } catch { throw new ErroCorpo(); }
  }
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (!req.body) return {};
    try { return JSON.parse(req.body); } catch { throw new ErroCorpo(); }
  }

  const pedacos = [];
  let total = 0;
  for await (const pedaco of req) {
    total += pedaco.length;
    if (total > LIMITE_CORPO) throw new ErroCorpo('Corpo da requisição muito grande.');
    pedacos.push(pedaco);
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(pedacos).toString('utf8')); } catch { throw new ErroCorpo(); }
}

// ── Validadores de entrada ────────────────────────────────────────────────
// Tudo que entra em path de URL passa por aqui antes de ser concatenado.

const RE_TASK_ID = /^[A-Za-z0-9]{1,32}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskIdValido(v) {
  return typeof v === 'string' && RE_TASK_ID.test(v);
}

export function uuidValido(v) {
  return typeof v === 'string' && RE_UUID.test(v);
}

/** Remove caracteres de controle, preservando quebra de linha e tabulação. */
function semControle(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 127) continue;
    if (c < 32 && ch !== '\n' && ch !== '\t') continue;
    out += ch;
  }
  return out;
}

/** Texto saneado: string sem caracteres de controle, com tamanho máximo. */
export function texto(v, max) {
  if (typeof v !== 'string') return '';
  return semControle(v).trim().slice(0, max);
}

/** Inteiro presente em um conjunto permitido, ou null. */
export function opcaoPermitida(v, permitidas) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || !permitidas.has(n)) return null;
  return n;
}
