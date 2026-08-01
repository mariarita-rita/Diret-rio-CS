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
const RE_JSON = /^application\/json\b/i;

/**
 * Lê `req.body` UMA vez, protegido.
 *
 * No runtime da Vercel `req.body` é um *getter*: faz o parse no momento do acesso
 * e LANÇA (`ApiError: Invalid JSON`) quando o corpo não é JSON válido. Acessar
 * isso fora de try derrubava a função inteira — qualquer POST com corpo
 * malformado, sem sessão e sem conhecimento nenhum do sistema, tirava o endpoint
 * do ar. A mensagem do runtime morre aqui e nunca chega à resposta.
 *
 * Ler uma única vez também evita repetir o parse — e o throw — a cada acesso.
 */
function lerBodyProtegido(req) {
  try {
    return { ok: true, valor: req.body };
  } catch {
    return { ok: false, valor: undefined };
  }
}

/** Faz o parse e exige um objeto JSON. Qualquer falha vira ErroCorpo. */
function comoObjetoJson(texto) {
  let v;
  try {
    v = JSON.parse(texto);
  } catch {
    throw new ErroCorpo();
  }
  // JSON válido mas inutilizável como corpo: "null", "3", "\"x\"", "[]".
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new ErroCorpo('Corpo da requisição deve ser um objeto JSON.');
  }
  return v;
}

/**
 * Lê o corpo JSON da requisição.
 *
 * Contrato: **nada aqui derruba a função**. Todo caminho de falha — parse
 * inválido, Content-Type ausente ou errado, corpo vazio, corpo acima do limite,
 * erro de leitura do stream — sai como ErroCorpo, que os endpoints traduzem em
 * 400 `corpo_invalido`.
 */
export async function lerCorpo(req) {
  const declarado = Number(req.headers['content-length']);
  if (Number.isFinite(declarado) && declarado > LIMITE_CORPO) {
    throw new ErroCorpo('Corpo da requisição muito grande.');
  }
  if (!RE_JSON.test(req.headers['content-type'] || '')) {
    throw new ErroCorpo('Corpo da requisição deve ser application/json.');
  }

  const lido = lerBodyProtegido(req);
  if (!lido.ok) throw new ErroCorpo();
  const body = lido.valor;

  // Buffer antes de objeto: Buffer também é objeto.
  if (Buffer.isBuffer(body)) {
    if (!body.length) throw new ErroCorpo('Corpo da requisição vazio.');
    if (body.length > LIMITE_CORPO) throw new ErroCorpo('Corpo da requisição muito grande.');
    return comoObjetoJson(body.toString('utf8'));
  }
  if (typeof body === 'string') {
    if (!body.trim()) throw new ErroCorpo('Corpo da requisição vazio.');
    if (body.length > LIMITE_CORPO) throw new ErroCorpo('Corpo da requisição muito grande.');
    return comoObjetoJson(body);
  }
  if (body && typeof body === 'object') {
    if (Array.isArray(body)) throw new ErroCorpo('Corpo da requisição deve ser um objeto JSON.');
    return body;
  }

  // Runtime que não faz o parse: lê o stream com teto de tamanho.
  const pedacos = [];
  let total = 0;
  try {
    for await (const pedaco of req) {
      total += pedaco.length;
      if (total > LIMITE_CORPO) throw new ErroCorpo('Corpo da requisição muito grande.');
      pedacos.push(pedaco);
    }
  } catch (e) {
    if (e instanceof ErroCorpo) throw e;
    throw new ErroCorpo(); // falha de leitura do stream também não derruba
  }
  if (!total) throw new ErroCorpo('Corpo da requisição vazio.');
  return comoObjetoJson(Buffer.concat(pedacos).toString('utf8'));
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
