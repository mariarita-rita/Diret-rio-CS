#!/usr/bin/env node
/*
 * Testes dos caminhos de falha dos três endpoints.
 *
 *   node scripts/teste-http.mjs
 *
 * Regra que estes testes existem para garantir: NADA derruba a função. Corpo
 * malformado, Content-Type errado, corpo vazio, corpo grande e configuração
 * ausente têm que virar resposta HTTP tratada.
 *
 * O ponto crítico do harness: no runtime da Vercel `req.body` é um GETTER que faz
 * o parse no acesso e LANÇA quando o corpo não é JSON. Um teste que entrega
 * `body` já pronto como propriedade comum NÃO exercita essa camada — foi
 * exatamente o ponto cego que deixou passar o bug de `ApiError: Invalid JSON`
 * derrubando o processo. `reqBodyQueLanca()` reproduz o getter.
 *
 * Sem dependências: só Node. Os módulos de api/ são ESM em .js e o projeto não
 * tem package.json, então são carregados via data: URL com os imports reescritos.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => readFileSync(join(RAIZ, p), 'utf8');
const dataUrl = (code) =>
  'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');

// ── Ambiente de teste ─────────────────────────────────────────────────────
// Segredos fabricados aqui. Nenhum valor de .env.local é lido.
const SENHA_GESTAO = 'senha-de-teste-gestao';
const SENHA_CONSULTA = 'senha-de-teste-consulta';

function hashScrypt(senha) {
  const N = 16384, r = 8, p = 1, KEYLEN = 64;
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(senha, salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

process.env.SESSION_SECRET = 'T'.repeat(48);
process.env.AUTH_GESTAO = hashScrypt(SENHA_GESTAO);
process.env.AUTH_CONSULTA = hashScrypt(SENHA_CONSULTA);
delete process.env.ALLOWED_ORIGINS;
delete process.env.VERCEL_ENV;

const httpUrl = dataUrl(ler('api/_lib/http.js'));
const authUrl = dataUrl(ler('api/_lib/auth.js').replace("'./http.js'", `'${httpUrl}'`));
const auth = await import(authUrl);

const stubClickup = `
  export const CAMPOS_ESCRITA = {};
  export class ErroConfigClickUp extends Error {}
  export class ErroUpstream extends Error { constructor(s){ super('up'); this.status = s; } }
  export async function getCarteira() { return { linhas: [] }; }
  export async function getMetas() { return { linhas: [] }; }
  export async function gravarCampo() {}
  export function invalidarCarteira() {}
  export async function localizarTask() { return null; }
  export async function localizarCliente() { return null; }
`;
const clickupLibUrl = dataUrl(stubClickup);

const carregar = (arquivo) =>
  import(
    dataUrl(
      ler(arquivo)
        .replace("'./_lib/http.js'", `'${httpUrl}'`)
        .replace("'./_lib/auth.js'", `'${authUrl}'`)
        .replace("'./_lib/clickup.js'", `'${clickupLibUrl}'`)
    )
  ).then((m) => m.default);

const login = await carregar('api/login.js');
const clickup = await carregar('api/clickup.js');
const moskit = await carregar('api/moskit.js');

/**
 * data: URL do _lib/clickup.js real, ÚNICA por variante.
 * import() cacheia por URL: sem o sufixo, dois testes compartilhariam a mesma
 * instância — e o cache de carteira de um contaminaria o outro.
 */
const libClickupUnica = (tag) => dataUrl(ler('api/_lib/clickup.js') + `\n// variante:${tag}\n`);

/** Como carregar(), mas com o _lib/clickup.js REAL em vez do stub. */
const carregarCom = (arquivo, libClickupUrl) =>
  import(
    dataUrl(
      ler(arquivo)
        .replace("'./_lib/http.js'", `'${httpUrl}'`)
        .replace("'./_lib/auth.js'", `'${authUrl}'`)
        .replace("'./_lib/clickup.js'", `'${libClickupUrl}'`)
    )
  ).then((m) => m.default);

// ── Harness ───────────────────────────────────────────────────────────────

/** Reproduz o getter do runtime da Vercel: acessar .body LANÇA. */
function reqBodyQueLanca(base) {
  const req = { ...base };
  Object.defineProperty(req, 'body', {
    get() {
      const e = new Error('Invalid JSON');
      e.name = 'ApiError';
      throw e;
    },
    enumerable: true,
    configurable: true,
  });
  return req;
}

function res() {
  const r = { headers: {}, code: null, corpo: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.corpo = o; return r; };
  r.end = () => r;
  return r;
}

function cabecalhos(extra = {}) {
  return { host: 'localhost:3000', 'content-type': 'application/json', ...extra };
}

async function sessaoGestao() {
  const r = res();
  await login({ method: 'POST', headers: cabecalhos(), query: {}, body: { senha: SENHA_GESTAO } }, r);
  if (r.code !== 200) throw new Error(`login de teste falhou: ${r.code} ${JSON.stringify(r.corpo)}`);
  return String(r.headers['Set-Cookie']).split(';')[0];
}

let falhas = 0;
let total = 0;
function checar(nome, real, esperado) {
  total++;
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} ${nome}` + (ok ? '' : `\n        recebido ${JSON.stringify(real)} / esperado ${JSON.stringify(esperado)}`));
}

const cookie = await sessaoGestao();

/** Chama um handler e devolve { code, codeCorpo }, ou marca crash. */
async function chamar(handler, req) {
  const r = res();
  try {
    await handler(req, r);
    return { code: r.code, cod: r.corpo?.code ?? null, crash: false };
  } catch (e) {
    return { code: null, cod: null, crash: true, erro: `${e?.name}: ${e?.message}` };
  }
}

// ── Casos de corpo inválido, nos endpoints que leem corpo ─────────────────

const ALVOS = [
  { nome: 'login',   handler: login,   query: {},                  cookie: false },
  { nome: 'clickup', handler: clickup, query: { action: 'set-field' }, cookie: true },
  { nome: 'moskit',  handler: moskit,  query: { action: 'deal' },      cookie: true },
];

console.log('\n[1] req.body lança (ApiError: Invalid JSON) — era o crash');
for (const a of ALVOS) {
  const base = { method: 'POST', headers: cabecalhos(a.cookie ? { cookie } : {}), query: a.query };
  const r = await chamar(a.handler, reqBodyQueLanca(base));
  checar(`${a.nome}: nao derruba`, r.crash, false);
  checar(`${a.nome}: 400 corpo_invalido`, [r.code, r.cod], [400, 'corpo_invalido']);
}

console.log('\n[2] Content-Type ausente');
for (const a of ALVOS) {
  const h = cabecalhos(a.cookie ? { cookie } : {});
  delete h['content-type'];
  const r = await chamar(a.handler, { method: 'POST', headers: h, query: a.query, body: '{"x":1}' });
  checar(`${a.nome}: 400 corpo_invalido`, [r.code, r.cod], [400, 'corpo_invalido']);
}

console.log('\n[3] Content-Type diferente de application/json');
for (const a of ALVOS) {
  const h = cabecalhos({ ...(a.cookie ? { cookie } : {}), 'content-type': 'text/plain' });
  const r = await chamar(a.handler, { method: 'POST', headers: h, query: a.query, body: '{"x":1}' });
  checar(`${a.nome}: 400 corpo_invalido`, [r.code, r.cod], [400, 'corpo_invalido']);
}

console.log('\n[4] corpo vazio');
for (const a of ALVOS) {
  for (const vazio of ['', Buffer.alloc(0)]) {
    const h = cabecalhos(a.cookie ? { cookie } : {});
    const r = await chamar(a.handler, { method: 'POST', headers: h, query: a.query, body: vazio });
    checar(`${a.nome}: ${typeof vazio === 'string' ? 'string' : 'buffer'} vazio -> 400`, [r.code, r.cod], [400, 'corpo_invalido']);
  }
}

console.log('\n[5] corpo acima do limite (content-length declarado)');
for (const a of ALVOS) {
  const h = cabecalhos({ ...(a.cookie ? { cookie } : {}), 'content-length': String(200 * 1024) });
  const r = await chamar(a.handler, { method: 'POST', headers: h, query: a.query, body: '{"x":1}' });
  checar(`${a.nome}: 400 corpo_invalido`, [r.code, r.cod], [400, 'corpo_invalido']);
}

console.log('\n[6] corpo acima do limite (string grande, sem content-length)');
for (const a of ALVOS) {
  const h = cabecalhos(a.cookie ? { cookie } : {});
  const r = await chamar(a.handler, { method: 'POST', headers: h, query: a.query, body: 'x'.repeat(200 * 1024) });
  checar(`${a.nome}: 400 corpo_invalido`, [r.code, r.cod], [400, 'corpo_invalido']);
}

console.log('\n[7] JSON valido mas nao-objeto');
for (const corpo of ['null', '3', '"texto"', '[]']) {
  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: corpo });
  checar(`login: ${corpo} -> 400`, [r.code, r.cod], [400, 'corpo_invalido']);
}
{
  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: [] });
  checar('login: array ja parseado -> 400', [r.code, r.cod], [400, 'corpo_invalido']);
}

console.log('\n[8] corpo VALIDO continua funcionando (nao viramos tudo 400)');
{
  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: { senha: 'errada' } });
  checar('login: senha errada -> 401 senha_incorreta', [r.code, r.cod], [401, 'senha_incorreta']);
}
{
  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: '{"senha":"errada"}' });
  checar('login: corpo string valida -> 401', [r.code, r.cod], [401, 'senha_incorreta']);
}
{
  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: Buffer.from('{"senha":"errada"}') });
  checar('login: corpo buffer valido -> 401', [r.code, r.cod], [401, 'senha_incorreta']);
}
{
  const r = await chamar(clickup, {
    method: 'POST', headers: cabecalhos({ cookie }), query: { action: 'set-field' },
    body: { taskId: 'abc123', fieldId: '11111111-2222-3333-4444-555555555555', value: true },
  });
  checar('clickup: fieldId fora da allowlist -> 403', [r.code, r.cod], [403, 'campo_nao_permitido']);
}

console.log('\n[9] SESSION_SECRET ausente -> 500 tratado, nos tres endpoints');
{
  const guardado = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;

  const r1 = await chamar(login, { method: 'GET', headers: cabecalhos({ cookie }), query: {} });
  checar('login GET: nao derruba', r1.crash, false);
  checar('login GET: 500 nao_configurado', [r1.code, r1.cod], [500, 'nao_configurado']);

  const r2 = await chamar(clickup, { method: 'GET', headers: cabecalhos({ cookie }), query: { action: 'carteira' } });
  checar('clickup: nao derruba', r2.crash, false);
  checar('clickup: 500 nao_configurado', [r2.code, r2.cod], [500, 'nao_configurado']);

  const r3 = await chamar(moskit, { method: 'POST', headers: cabecalhos({ cookie }), query: { action: 'deal' }, body: { taskId: 'abc123' } });
  checar('moskit: nao derruba', r3.crash, false);
  checar('moskit: 500 nao_configurado', [r3.code, r3.cod], [500, 'nao_configurado']);

  const r4 = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: { senha: SENHA_GESTAO } });
  checar('login POST com segredo ausente: nao derruba', r4.crash, false);
  checar('login POST: 500 nao_configurado', [r4.code, r4.cod], [500, 'nao_configurado']);

  process.env.SESSION_SECRET = guardado;
}

console.log('\n[10] SESSION_SECRET curto (<32) -> 500 tratado');
{
  const guardado = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'curto';
  const r = await chamar(clickup, { method: 'GET', headers: cabecalhos({ cookie }), query: { action: 'carteira' } });
  checar('clickup: nao derruba', r.crash, false);
  checar('clickup: 500 nao_configurado', [r.code, r.cod], [500, 'nao_configurado']);
  process.env.SESSION_SECRET = guardado;
}

console.log('\n[11] rajada de 60 corpos malformados alternados');
{
  let crashes = 0;
  const codigos = new Set();
  for (let i = 0; i < 60; i++) {
    const alvo = ALVOS[i % 3];
    const base = { method: 'POST', headers: cabecalhos(alvo.cookie ? { cookie } : {}), query: alvo.query };
    const req = i % 2 === 0 ? reqBodyQueLanca(base) : { ...base, body: '{ isso nao e json' };
    const r = await chamar(alvo.handler, req);
    if (r.crash) crashes++;
    codigos.add(`${r.code}/${r.cod}`);
  }
  checar('60 requisicoes, zero crash', crashes, 0);
  checar('todas responderam 400 corpo_invalido', [...codigos], ['400/corpo_invalido']);
}

console.log('\n[12] sessao segue valida depois da rajada');
{
  const r = await chamar(clickup, { method: 'GET', headers: cabecalhos({ cookie }), query: { action: 'metas' } });
  checar('clickup metas -> 200', r.code, 200);
}

console.log('\n[13] conferirSenha distingue senha errada de configuracao invalida');
{
  const bom = hashScrypt('abc');
  const p = bom.split('$');

  const casos = [
    ['senha correta', await auth.conferirSenha('abc', bom), { ok: true }],
    ['senha errada', (await auth.conferirSenha('xyz', bom)).motivo, 'senha_errada'],
    ['nao e texto', (await auth.conferirSenha('abc', 12345)).motivo, 'nao_e_texto'],
    ['prefixo errado', (await auth.conferirSenha('abc', `bcrypt$${p.slice(1).join('$')}`)).motivo, 'prefixo_nao_scrypt'],
  ];
  for (const [nome, real, esperado] of casos) checar(nome, real, esperado);

  // campos: 3 e 7 em vez de 6
  checar('poucos campos', (await auth.conferirSenha('abc', 'scrypt$16384$8')).motivo, 'formato (3 campos, esperado 6)');
  checar('campos demais', (await auth.conferirSenha('abc', `${bom}$extra`)).motivo, 'formato (7 campos, esperado 6)');

  // o valor de 64 chars base64url que causou o incidente real
  checar('valor sem $ (o incidente)', (await auth.conferirSenha('abc', 'A'.repeat(64))).motivo, 'formato (1 campos, esperado 6)');

  // salt e hash truncados: estrutura intacta, 6 campos, prefixo ok
  const saltCortado = `scrypt$16384$8$1$${p[4].slice(0, 8)}$${p[5]}`;
  checar('salt truncado', (await auth.conferirSenha('abc', saltCortado)).motivo.startsWith('salt_invalido'), true);
  const hashCortado = `scrypt$16384$8$1$${p[4]}$${p[5].slice(0, 40)}`;
  checar('hash truncado', (await auth.conferirSenha('abc', hashCortado)).motivo.startsWith('hash_invalido'), true);
  const saltVazio = `scrypt$16384$8$1$$${p[5]}`;
  checar('salt apagado (expansao de $)', (await auth.conferirSenha('abc', saltVazio)).motivo.startsWith('salt_invalido'), true);

  // round-trip: base64 nao canonico decodifica "com sucesso" mas nao volta igual
  checar('base64 nao canonico no salt',
    (await auth.conferirSenha('abc', `scrypt$16384$8$1$${p[4].replace(/=+$/, '')}$${p[5]}`)).motivo.startsWith('salt_invalido'), true);
}

console.log('\n[14] faixa de N/r estreitada ao que gerar-hash.js produz');
{
  const p = hashScrypt('abc').split('$');
  const com = (N, r, pp) => `scrypt$${N}$${r}$${pp}$${p[4]}$${p[5]}`;
  for (const [N, r, pp] of [[1024, 8, 1], [1048576, 32, 1], [32768, 8, 1], [16384, 16, 1], [16384, 8, 2]]) {
    const m = (await auth.conferirSenha('abc', com(N, r, pp))).motivo;
    checar(`N=${N} r=${r} p=${pp} recusado`, m.startsWith('parametros_nao_aceitos'), true);
  }
  checar('16384/8/1 aceito', (await auth.conferirSenha('abc', com(16384, 8, 1))).ok, true);
}

console.log('\n[15] hashes identicos entre perfis -> 500, com log nomeando as variaveis');
{
  const guardado = process.env.AUTH_CONSULTA;
  process.env.AUTH_CONSULTA = process.env.AUTH_GESTAO; // mesmo valor nas duas
  const capturados = [];
  const original = console.error;
  console.error = (...a) => capturados.push(a.join(' '));

  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: { senha: SENHA_GESTAO } });

  console.error = original;
  checar('500 nao_configurado', [r.code, r.cod], [500, 'nao_configurado']);
  checar('logou o par de variaveis', capturados.some((l) => l.includes('AUTH_CONSULTA') && l.includes('AUTH_GESTAO')), true);
  checar('nao vaza hash no log', capturados.some((l) => l.includes(process.env.AUTH_GESTAO)), false);
  process.env.AUTH_CONSULTA = guardado;
}

console.log('\n[16] configuracao invalida gera log nomeando a variavel');
{
  const guardado = process.env.AUTH_CONSULTA;
  process.env.AUTH_CONSULTA = 'A'.repeat(64); // formato do incidente real
  const capturados = [];
  const original = console.error;
  console.error = (...a) => capturados.push(a.join(' '));

  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: { senha: 'qualquer-coisa-errada' } });

  console.error = original;
  checar('resposta ao cliente segue 401 genérico', [r.code, r.cod], [401, 'senha_incorreta']);
  checar('log nomeia AUTH_CONSULTA', capturados.some((l) => l.includes('AUTH_CONSULTA') && l.includes('valor invalido')), true);
  checar('log nao contem a senha', capturados.some((l) => l.includes('qualquer-coisa-errada')), false);
  process.env.AUTH_CONSULTA = guardado;
}

console.log('\n[17] senha errada com tudo bem configurado NAO gera log');
{
  const capturados = [];
  const original = console.error;
  console.error = (...a) => capturados.push(a.join(' '));
  const r = await chamar(login, { method: 'POST', headers: cabecalhos(), query: {}, body: { senha: 'errada' } });
  console.error = original;
  checar('401 senha_incorreta', [r.code, r.cod], [401, 'senha_incorreta']);
  checar('zero logs', capturados.length, 0);
}

console.log('\n[18] expirada: true apenas no GET /api/login, e apenas com cookie presente');
{
  const invalido = `${auth.COOKIE_NOME}=lixo.assinaturaerrada`;

  const r1 = res();
  await login({ method: 'GET', headers: cabecalhos({ cookie: invalido }), query: {} }, r1);
  checar('GET /api/login com cookie invalido: 401', r1.code, 401);
  checar('  code inalterado', r1.corpo.code, 'sessao_invalida');
  checar('  expirada: true', r1.corpo.expirada, true);

  const r2 = res();
  await login({ method: 'GET', headers: cabecalhos(), query: {} }, r2);
  checar('GET /api/login SEM cookie: 401', r2.code, 401);
  checar('  sem campo expirada', r2.corpo.expirada, undefined);

  // Proxies nao diferenciam: nenhum oraculo de "existe sessao aqui"
  const r3 = res();
  await clickup({ method: 'GET', headers: cabecalhos({ cookie: invalido }), query: { action: 'carteira' } }, r3);
  checar('clickup com cookie invalido: 401 sem expirada', [r3.code, r3.corpo.expirada], [401, undefined]);

  const r4 = res();
  await clickup({ method: 'GET', headers: cabecalhos(), query: { action: 'carteira' } }, r4);
  checar('clickup sem cookie: corpo IDENTICO ao anterior', JSON.stringify(r4.corpo), JSON.stringify(r3.corpo));

  const r5 = res();
  await moskit({ method: 'POST', headers: cabecalhos({ cookie: invalido }), query: { action: 'deal' }, body: { taskId: 'abc123' } }, r5);
  checar('moskit com cookie invalido: 401 sem expirada', [r5.code, r5.corpo.expirada], [401, undefined]);
}

console.log('\n[19] TTL de 12h e rotacao de segredo (sem esperar 12h)');
{
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const tokenCom = (iat, segredo = process.env.SESSION_SECRET) => {
    const corpo = b64u(JSON.stringify({ nivel: 'gestao', csm: null, nome: 'G', iat }));
    return `${corpo}.${b64u(crypto.createHmac('sha256', segredo).update(corpo).digest())}`;
  };
  const H = 3600000;
  const agora = Date.now();
  checar('recem emitido: valido', auth.verificarSessao(tokenCom(agora))?.nivel, 'gestao');
  checar('11h59: valido', auth.verificarSessao(tokenCom(agora - 11.98 * H))?.nivel, 'gestao');
  checar('12h01: expirado', auth.verificarSessao(tokenCom(agora - 12.02 * H)), null);
  checar('iat +5min: recusado', auth.verificarSessao(tokenCom(agora + 5 * 60 * 1000)), null);
  checar('outro segredo (rotacao): recusado', auth.verificarSessao(tokenCom(agora, 'Z'.repeat(48))), null);
  checar('adulterado: recusado', auth.verificarSessao(tokenCom(agora).slice(0, -3) + 'aaa'), null);
}

console.log('\n[20] custo em chamadas ao ClickUp por operacao (T2)');
{
  // Carrega o _lib/clickup.js REAL com o fetch interceptado, para CONTAR chamadas.
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    const u = String(url);
    // Uma task avulsa
    if (/\/task\/[^/?]+\?/.test(u)) {
      return respostaOk({
        id: 'tsk1', name: 'Cliente X', list: { id: '901327787926' }, status: { status: 'ativo' },
        custom_fields: [{ id: '3898a8f4-bb21-46d7-88ee-79d164033fdf', type: 'drop_down', value: 0,
                          type_config: { options: [{ orderindex: 0, name: 'Gian Luca' }] } }],
      });
    }
    // Paginacao de lista: 3 paginas cheias e o resto vazio
    const m = u.match(/[?&]page=(\d+)/);
    const page = m ? Number(m[1]) : 0;
    const tasks = page < 3 ? Array.from({ length: 100 }, (_, i) => ({
      id: `t${page}_${i}`, name: 'x', list: { id: '901327787926' }, status: { status: 'ativo' }, custom_fields: [],
    })) : [];
    return respostaOk({ tasks, last_page: page >= 3 });
  };
  function respostaOk(corpo) {
    return {
      ok: true, status: 200,
      headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '99'], ['x-ratelimit-reset', '0']]),
      json: async () => corpo,
      text: async () => JSON.stringify(corpo),
    };
  }
  // As respostas usam Map; o codigo chama headers.get(), que Map tem.

  const lib = await import(libClickupUnica('custo'));
  process.env.CLICKUP_API_KEY = 'pk_teste';

  chamadas.length = 0;
  await lib.localizarTask('tsk1');
  const custoEscritaFria = chamadas.length;
  checar('localizarTask com cache frio: 1 chamada (era 29)', custoEscritaFria, 1);

  chamadas.length = 0;
  await lib.localizarTask('tsk1');
  checar('  segunda vez, do indice: 0 chamadas', chamadas.length, 0);

  chamadas.length = 0;
  await lib.localizarCliente('tsk1');
  checar('localizarCliente com cache frio: 1 chamada (era 28 a 56)', chamadas.length, 1);

  chamadas.length = 0;
  const c = await lib.getCarteira();
  checar('getCarteira pagina de fato', c.linhas.length, 300);
  checar('  e custa 1 lote de 4 por rodada', chamadas.length > 1, true);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[21] 429 vira mensagem acionavel com segundos (T3)');
{
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: new Map([['retry-after', '37'], ['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '0']]),
    json: async () => ({}),
    text: async () => '',
  });
  const cu = await carregarCom('api/clickup.js', libClickupUnica('429-com-retry-after'));
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const r = res();
  await cu({ method: 'GET', headers: cabecalhos({ cookie }), query: { action: 'carteira' } }, r);
  checar('status 429 preservado', r.code, 429);
  checar('code proprio', r.corpo.code, 'limite_clickup');
  checar('esperaSegundos do Retry-After', r.corpo.esperaSegundos, 37);
  checar('header Retry-After', r.headers['Retry-After'], '37');
  checar('mensagem acionavel', /Limite de requisições do ClickUp atingido\. Aguarde 37 segundos/.test(r.corpo.error), true);
  checar('nao diz "erro ao carregar"', /erro ao carregar/i.test(r.corpo.error), false);
  checar('nao vaza detalhe do upstream', /clickup\.com|token|Authorization/i.test(r.corpo.error), false);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[22] 429 sem Retry-After cai para a janela padrao');
{
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '0']]),
    json: async () => ({}), text: async () => '',
  });
  const cu = await carregarCom('api/clickup.js', libClickupUnica('429-sem-retry-after'));
  const r = res();
  await cu({ method: 'GET', headers: cabecalhos({ cookie }), query: { action: 'carteira' } }, r);
  checar('esperaSegundos padrao', r.corpo.esperaSegundos, 60);
  checar('mensagem com 60s', /Aguarde 60 segundos/.test(r.corpo.error), true);
  globalThis.fetch = fetchOriginal;
}

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) {
  console.error(`${falhas} FALHA(S)`);
  process.exit(1);
}
console.log('TUDO PASSOU — nenhum caminho de falha derruba a funcao');
