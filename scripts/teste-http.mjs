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
  export const EQUIPE_OPCAO = 'a9832e95-4c6b-4b53-834f-cebb5000a188';
  export const STATUS_MES_ATUAL = 'mês atual';
  export class ErroConfigClickUp extends Error {}
  export class ErroUpstream extends Error { constructor(s){ super('up'); this.status = s; } }
  export async function getCarteira() { return { linhas: [] }; }
  export async function getMetas() { return { linhas: [] }; }
  export async function gravarCampo() {}
  export async function limparCampo() {}
  export function invalidarCarteira() {}
  export function refletirEscrita() {}
  export async function localizarTask() { return null; }
  export async function localizarCliente() { return null; }
  export async function lerClienteFresco() { return null; }
  export async function criarTaskPropostaWaipe() { return {}; }
  export const LISTA_IMPLANTACOES_WAIPE = '901328976497';
  export async function criarTaskImplantacao() { return { id: 'stub-projeto' }; }
  export async function criarSubtaskAgente() { return { id: 'stub-agente' }; }
  export async function atualizarTask() { return {}; }
  export async function obterTask() { return null; }
  export async function listarImplantacoes() { return []; }
  export async function obterTaskComSubtasks() { return { pai: null, subtasks: [] }; }
  export async function criarComentario() { return {}; }
  export async function listarComentarios() { return []; }
  export const ISM_OPCOES = [{ id: 118125102, nome: 'Bruno Vaz' }, { id: 48933858, nome: 'Erica Fernanda' }];
  export function parseWaipeState() { return {}; }
  export function stringifyWaipeState(description) { return description || ''; }
  export function contextoSemEstado(description) { return description || ''; }
  export function csmDaDescricaoImplantacao() { return ''; }
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

console.log('\n[23] escrita reflete no cache em vez de derruba-lo (S3)');
{
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  const ALERTA_A = 'ddaddf7d-9ffa-49de-9b53-6e63acbbceb3';
  const ALERTA_B = '06759f74-83bb-427a-8ddd-77aa2f9f94c5';

  const ok = (corpo) => ({
    ok: true, status: 200,
    headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '90'], ['x-ratelimit-reset', '0']]),
    json: async () => corpo, text: async () => '',
  });

  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    if (/\/field\//.test(String(url))) return ok({});
    // Uma pagina com uma task, com type_config de labels para os rotulos serem aprendidos
    return ok({
      last_page: true,
      tasks: [{
        id: 'tX', name: 'Cliente Y', list: { id: '901327787926' }, status: { status: 'ativo' },
        custom_fields: [
          { id: '94b85690-3d47-4edf-9209-0a671cfb570b', type: 'checkbox', value: false },
          { id: '6ce5db54-1a1d-4dfa-944d-4b01b8832549', type: 'labels', value: [],
            type_config: { options: [
              { id: ALERTA_A, label: 'Risco de Churn' },
              { id: ALERTA_B, label: 'Cliente Insatisfeito' },
            ] } },
        ],
      }],
    });
  };

  const lib = await import(libClickupUnica('reflete'));
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const c1 = await lib.getCarteira();
  checar('leitura inicial: acomp false', c1.linhas[0].acomp, false);
  checar('leitura inicial: alertas vazio', c1.linhas[0].alertas, []);

  // Escrita do checkbox, refletida
  await lib.gravarCampo('tX', '94b85690-3d47-4edf-9209-0a671cfb570b', true);
  lib.refletirEscrita('tX', '94b85690-3d47-4edf-9209-0a671cfb570b', true);
  chamadas.length = 0;
  const c2 = await lib.getCarteira();
  checar('depois da escrita: acomp true', c2.linhas[0].acomp, true);
  checar('  e a releitura custou 0 chamadas', chamadas.length, 0);

  // Escrita de labels, traduzida pelos rotulos aprendidos do ClickUp
  lib.refletirEscrita('tX', '6ce5db54-1a1d-4dfa-944d-4b01b8832549', [ALERTA_A, ALERTA_B]);
  chamadas.length = 0;
  const c3 = await lib.getCarteira();
  checar('alertas refletidos com rotulo correto', c3.linhas[0].alertas, ['Risco de Churn', 'Cliente Insatisfeito']);
  checar('  sem chamada extra', chamadas.length, 0);

  // Rotulo desconhecido: prefere custo a divergencia
  lib.refletirEscrita('tX', '6ce5db54-1a1d-4dfa-944d-4b01b8832549', ['00000000-0000-0000-0000-000000000000']);
  chamadas.length = 0;
  await lib.getCarteira();
  checar('rotulo desconhecido invalida (relê do ClickUp)', chamadas.length > 0, true);

  // Campo que nao aparece na linha: nao invalida
  const c4 = await lib.getCarteira();
  chamadas.length = 0;
  lib.refletirEscrita('tX', 'd15028f2-40c6-44da-a5dc-3d608eef6f48', '94eb0e3e-de65-432d-b74d-a342689d5d85');
  await lib.getCarteira();
  checar('Etapa nao invalida o cache', chamadas.length, 0);
  checar('  e a linha segue intacta', c4.linhas[0].id, 'tX');

  globalThis.fetch = fetchOriginal;
}

console.log('\n[24] action=cliente: allowlist, portao de sessao, escopo e frescor');
{
  const ALERTA_A = 'ddaddf7d-9ffa-49de-9b53-6e63acbbceb3';
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  const ok = (corpo) => ({
    ok: true, status: 200,
    headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
    json: async () => corpo, text: async () => '',
  });
  const taskDe = (gerente) => ({
    id: 'tC', name: 'Cliente Z', list: { id: '901327787926' }, status: { status: 'ativo' },
    custom_fields: [
      { id: '59888807-a3f3-42f0-aebd-f63032011ed1', type: 'number', value: 4321 },
      { id: '3898a8f4-bb21-46d7-88ee-79d164033fdf', type: 'drop_down', value: 0,
        type_config: { options: [{ orderindex: 0, name: gerente }] } },
      { id: '6ce5db54-1a1d-4dfa-944d-4b01b8832549', type: 'labels', value: [ALERTA_A],
        type_config: { options: [{ id: ALERTA_A, label: 'Risco de Churn' }] } },
    ],
  });

  let gerenteAtual = 'Gian Luca';
  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    if (/\/task\//.test(String(url))) return ok(taskDe(gerenteAtual));
    return ok({ tasks: [taskDe(gerenteAtual)], last_page: true });
  };

  const cu = await carregarCom('api/clickup.js', libClickupUnica('cliente'));
  process.env.CLICKUP_API_KEY = 'pk_teste';

  // Sessoes de teste
  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const ckGestao = cookieDe({ nivel: 'gestao', csm: null, nome: 'G' });
  const ckGian = cookieDe({ nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' });
  const ckPatricia = cookieDe({ nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' });
  const ckConsulta = cookieDe({ nivel: 'consulta', csm: null, nome: 'C' });

  const pedir = async (ck, taskId = 'tC') => {
    const r = res();
    const headers = cabecalhos(ck ? { cookie: ck } : {});
    await cu({ method: 'GET', headers, query: { action: 'cliente', taskId } }, r);
    return r;
  };

  const semSessao = await pedir(null);
  checar('sem cookie: 401 sessao_invalida', [semSessao.code, semSessao.corpo.code], [401, 'sessao_invalida']);

  const gestao = await pedir(ckGestao);
  checar('gestao: 200', gestao.code, 200);
  checar('  devolve alertasIds', gestao.corpo.task.alertasIds, [ALERTA_A]);
  checar('  e o rotulo tambem', gestao.corpo.task.alertas, ['Risco de Churn']);
  checar('  no-store (o motivo de existir e frescor)', gestao.headers['Cache-Control'], 'no-store');

  const gian = await pedir(ckGian);
  checar('csm dono: 200', gian.code, 200);
  checar('  mrr visivel', gian.corpo.task.mrr, 4321);

  const patricia = await pedir(ckPatricia);
  checar('csm de outra carteira: 403 fora_da_carteira', [patricia.code, patricia.corpo.code], [403, 'fora_da_carteira']);

  const consulta = await pedir(ckConsulta);
  checar('consulta: 200 com mrr zerado', [consulta.code, consulta.corpo.task.mrr], [200, 0]);

  const invalido = await pedir(ckGestao, 'id com espaco!');
  checar('taskId invalido: 400', [invalido.code, invalido.corpo.code], [400, 'task_invalida']);

  // Custo e frescor: nao passa pelo cache mesmo com carteira quente
  const rq = res();
  await cu({ method: 'GET', headers: cabecalhos({ cookie: ckGestao }), query: { action: 'carteira' } }, rq);
  chamadas.length = 0;
  await pedir(ckGestao);
  checar('com carteira quente, ainda le do ClickUp: 1 chamada', chamadas.length, 1);

  // Metodo errado e acao desconhecida
  const post = res();
  await cu({ method: 'POST', headers: cabecalhos({ cookie: ckGestao, 'content-type': 'application/json' }),
             query: { action: 'cliente' }, body: {} }, post);
  checar('POST em action=cliente: 405', post.code, 405);
  const nada = res();
  await cu({ method: 'GET', headers: cabecalhos({ cookie: ckGestao }), query: { action: 'clientes' } }, nada);
  checar('acao inexistente segue 400', [nada.code, nada.corpo.code], [400, 'acao_invalida']);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[25] refletirEscrita mantem alertas e alertasIds coerentes');
{
  const ALERTA_A = 'ddaddf7d-9ffa-49de-9b53-6e63acbbceb3';
  const ALERTA_B = '06759f74-83bb-427a-8ddd-77aa2f9f94c5';
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
    json: async () => ({
      last_page: true,
      tasks: [{
        id: 'tD', name: 'C', list: { id: '901327787926' }, status: { status: 'ativo' },
        custom_fields: [{ id: '6ce5db54-1a1d-4dfa-944d-4b01b8832549', type: 'labels', value: [ALERTA_A],
          type_config: { options: [{ id: ALERTA_A, label: 'Risco de Churn' }, { id: ALERTA_B, label: 'Cliente Insatisfeito' }] } }],
      }],
    }),
    text: async () => '',
  });
  const lib = await import(libClickupUnica('ids-coerentes'));
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const c1 = await lib.getCarteira();
  checar('leitura traz ids e rotulos', [c1.linhas[0].alertasIds, c1.linhas[0].alertas], [[ALERTA_A], ['Risco de Churn']]);

  lib.refletirEscrita('tD', '6ce5db54-1a1d-4dfa-944d-4b01b8832549', [ALERTA_A, ALERTA_B]);
  const c2 = await lib.getCarteira();
  checar('reflete rotulos', c2.linhas[0].alertas, ['Risco de Churn', 'Cliente Insatisfeito']);
  checar('reflete ids junto', c2.linhas[0].alertasIds, [ALERTA_A, ALERTA_B]);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[26] motivoPerdaId: id da opcao, nao rotulo');
{
  const MOTIVO_CAMPO = '57b588ce-81f5-4728-94e5-b22d1966862a';
  const MIGRACAO = '00c64f34-41e0-4fb2-8f70-17a55b803507';
  const OUTRO = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
  const OPCOES = [
    { id: MIGRACAO, name: 'Contratou em outro CNPJ', orderindex: 0 },
    { id: OUTRO, name: 'Preco', orderindex: 1 },
  ];
  const fetchOriginal = globalThis.fetch;
  // Duas linhas: uma com value = orderindex (numero), outra com value = id
  // (string). A API do ClickUp alterna entre os dois, e a regra tem de dar o mesmo
  // id nos dois casos — foi por isso que cfOpcaoId nao pode devolver f.value cru.
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
    json: async () => ({
      last_page: true,
      tasks: [
        { id: 'mA', name: 'Por orderindex', list: { id: '901327787926' }, status: { status: 'cancelado' },
          custom_fields: [{ id: MOTIVO_CAMPO, type: 'drop_down', value: 0, type_config: { options: OPCOES } }] },
        { id: 'mB', name: 'Por id', list: { id: '901327787926' }, status: { status: 'cancelado' },
          custom_fields: [{ id: MOTIVO_CAMPO, type: 'drop_down', value: OUTRO, type_config: { options: OPCOES } }] },
        { id: 'mC', name: 'Sem motivo', list: { id: '901327787926' }, status: { status: 'cancelado' },
          custom_fields: [{ id: MOTIVO_CAMPO, type: 'drop_down', value: null, type_config: { options: OPCOES } }] },
      ],
    }),
    text: async () => '',
  });
  const lib = await import(libClickupUnica('motivo-perda'));
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const { linhas } = await lib.getCarteira();
  const [a, b, c] = linhas;
  checar('value = orderindex resolve para o id', a.motivoPerdaId, MIGRACAO);
  checar('  e o rotulo continua vindo junto', a.motivoPerda, 'Contratou em outro CNPJ');
  checar('value = id da opcao devolve o mesmo id', b.motivoPerdaId, OUTRO);
  checar('campo vazio devolve null', c.motivoPerdaId, null);
  checar('  e nao inventa rotulo', c.motivoPerda, null);

  // A regra do card vive no front; o id tem de ser o MESMO nos dois lados, senao a
  // exclusao para de valer sem ninguem perceber.
  checar('constante exportada bate com o id da opcao', lib.MOTIVO_MIGRACAO_CNPJ, MIGRACAO);
  const front = ler('dashboard_carteiras.html');
  const noFront = front.match(/const MOTIVO_MIGRACAO_CNPJ\s*=\s*'([0-9a-f-]+)'/);
  checar('front declara a constante', Boolean(noFront), true);
  checar('front e servidor usam o mesmo id', noFront?.[1], lib.MOTIVO_MIGRACAO_CNPJ);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[27] filtro de cidade: agrupa variacoes de texto livre');
{
  /**
   * O dashboard e HTML estatico, sem bundler nem export — para testar a regra de
   * agrupamento sem duplicar o codigo aqui, as declaracoes sao extraidas do arquivo
   * e carregadas como modulo. Se alguem renomear as funcoes, o teste falha em vez
   * de silenciosamente testar outra coisa.
   */
  const front = ler('dashboard_carteiras.html');
  const extrair = (nome) => {
    const inicio = front.indexOf(`function ${nome}(`);
    if (inicio < 0) return null;
    let i = front.indexOf('{', inicio);
    let profundidade = 0;
    for (; i < front.length; i++) {
      if (front[i] === '{') profundidade++;
      else if (front[i] === '}' && --profundidade === 0) return front.slice(inicio, i + 1);
    }
    return null;
  };

  const normTxtSrc = extrair('normTxt');
  const opcoesSrc = extrair('opcoesCidade');
  const sentinela = front.match(/const CIDADE_VAZIA\s*=\s*'([^']+)'/);
  checar('normTxt existe no front', Boolean(normTxtSrc), true);
  checar('opcoesCidade existe no front', Boolean(opcoesSrc), true);
  checar('CIDADE_VAZIA declarada', Boolean(sentinela), true);

  const mod = await import(dataUrl(
    `let allData = [];\nexport const setDados = (d) => { allData = d; };\n` +
    `${normTxtSrc}\n${opcoesSrc}\nexport { normTxt, opcoesCidade };\n`
  ));

  // O normalizador tem de casar com normalizarNome() do auth.js.
  checar('normTxt colapsa acento, caixa e espaco', mod.normTxt('  Lôndrína  Sul '), 'londrina sul');
  checar('normTxt de vazio e string vazia', [mod.normTxt(null), mod.normTxt('   ')], ['', '']);

  mod.setDados([
    // Empate 1x1x1: quem decide e a capitalizacao de nome proprio.
    { cidade: 'Londrina' }, { cidade: 'londrina ' }, { cidade: 'LONDRINA' },
    // Empate 1x1, com acento em uma das grafias.
    { cidade: 'Cambé' }, { cidade: 'cambe' },
    // Maioria FEIA: 3 minusculas contra 1 bem escrita. Frequencia tem de vencer a
    // capitalizacao, senao a regra deixou de ser "a grafia mais frequente".
    { cidade: 'sao paulo' }, { cidade: 'sao  paulo' }, { cidade: 'sao paulo ' }, { cidade: 'São Paulo' },
    { cidade: 'Apucarana' },
    { cidade: '' }, { cidade: null }, { cidade: '   ' }, {},
  ]);
  const { opts, semCidade } = mod.opcoesCidade();
  const grupo = (c) => opts.find((o) => o.chave === c);

  checar('quatro grupos distintos', opts.length, 4);
  checar('ordem alfabetica pelo rotulo', opts.map(o => o.rotulo),
         ['Apucarana', 'Cambé', 'Londrina', 'sao paulo']);
  checar('Londrina agrupou as 3 variacoes', grupo('londrina').total, 3);
  checar('  empate elege a capitalizacao de nome proprio', grupo('londrina').rotulo, 'Londrina');
  checar('acento nao separa grupo', grupo('cambe').total, 2);
  checar('  e a grafia acentuada ganha o empate', grupo('cambe').rotulo, 'Cambé');
  checar('espaco duplo cai no mesmo grupo', grupo('sao paulo').total, 4);
  checar('  frequencia vence capitalizacao', grupo('sao paulo').rotulo, 'sao paulo');
  checar('vazio, nulo, espacos e ausente viram Sem cidade', semCidade, 4);

  // A sentinela nao pode ser produzida por nenhuma cidade real.
  checar('nenhuma chave colide com a sentinela', opts.some(o => o.chave === sentinela[1]), false);

  globalThis.fetch = globalThis.fetch;
}

console.log('\n[28] meta de equipe: declarada, nao somada');
{
  const EQUIPE = 'a9832e95-4c6b-4b53-834f-cebb5000a188';
  const CAMPO_GERENTE = '3898a8f4-bb21-46d7-88ee-79d164033fdf';
  const F = {
    mrrAt: '3f9f68a3-58f8-4a3c-9e40-131e6e7b940e', down: '099e8c77-5ea3-4ab2-81e4-0f12e18ea9f9',
    meta: '66a8ff49-2a0e-4e6a-98db-7854e674a5cf', sup: '575f8269-a094-4ad5-8eaa-9806e128368a',
    ultra: '659aaee9-d3e9-4f89-aa65-b10e40178ab1', esp: '28627910-6605-4389-bcca-5efccb2cc264',
  };
  // Os nomes e valores reais da lista, para o teste provar o caso de producao.
  const OPCOES = [
    { id: '7fe6407b-3c75-48b1-bfb5-d429be6d68d8', name: 'Gian Luca', orderindex: 0 },
    { id: 'cbcf04f4-da02-4ff7-8515-c2e3ab53961e', name: 'Lucineia Felix', orderindex: 1 },
    { id: 'e9e55de1-cf37-48c9-9760-c6d50c474dde', name: 'Guilherme Camargo', orderindex: 2 },
    { id: 'c6e1ad22-ed55-42ea-9ea7-88ff3df65a18', name: 'Patricia Carvalho', orderindex: 3 },
    { id: EQUIPE, name: '⭐ Equipe', orderindex: 4 },
  ];
  const ANO = '5c06c44f-135e-4139-ae0b-3d21cb9d6040';
  const MES = '6f335424-3dcc-4cf0-9df3-2cdb367efde3';
  const MES_OPC = [
    { id: '68ab70d4-0288-49b4-8c82-45769ed6ee59', name: 'Junho', orderindex: 5 },
    { id: '80ae72d6-3320-4066-bdb8-46a4ffdff41f', name: 'Julho', orderindex: 6 },
    { id: '4d3e89aa-f3ab-4b99-b33c-07d1ea4b16d4', name: 'Agosto', orderindex: 7 },
  ];
  const MES_ID = { 6: MES_OPC[0].id, 7: MES_OPC[1].id, 8: MES_OPC[2].id };
  const ATUAL = 'mês atual';
  const FECHADO = 'meses fechados';

  /** Linha de meta com periodo e status. `mes` numerico, `ano` string como no ClickUp. */
  const linhaMeta = (id, gerenteIdx, mrrAt, down, opc = {}) => {
    const { mes = 7, ano = '2026', status = ATUAL, ...extras } = opc;
    return {
      id, name: `Meta ${id}`, list: { id: '901327940637' }, status: { status },
      custom_fields: [
        { id: CAMPO_GERENTE, type: 'drop_down', value: gerenteIdx, type_config: { options: OPCOES } },
        { id: F.mrrAt, type: 'currency', value: String(mrrAt) },
        { id: F.down, type: 'currency', value: String(down) },
        ...(mes === null ? [] : [{ id: MES, type: 'drop_down', value: MES_ID[mes], type_config: { options: MES_OPC } }]),
        ...(ano === null ? [] : [{ id: ANO, type: 'short_text', value: ano }]),
        ...Object.entries(extras).map(([k, v]) => ({ id: F[k], type: 'currency', value: String(v) })),
      ],
    };
  };

  const quatro = (opc) => [
    linhaMeta('g' + (opc?.mes ?? 7), 0, 2945.87, 0, opc), linhaMeta('l' + (opc?.mes ?? 7), 1, 2671.54, 0, opc),
    linhaMeta('u' + (opc?.mes ?? 7), 2, 3550.45, 0, opc), linhaMeta('p' + (opc?.mes ?? 7), 3, 2091.30, 191.40, opc),
  ];
  const SOMA = 11067.76;          // 2945.87 + 2671.54 + 3550.45 + (2091.30 - 191.40)
  const DECLARADO = 11028.76;     // 11259.16 - 230.40, da linha real
  const eqDe = (id, opc) => linhaMeta(id, 4, 11259.16, 230.40,
    { meta: 6918.07, sup: 10377.11, ultra: 17295.18, esp: 20000, ...opc });

  const JUL = quatro({ mes: 7 });
  const LINHA_EQ = eqDe('eq', { mes: 7 });

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const arred = (n) => Math.round(n * 100) / 100;

  /** Monta um /api/clickup com a lista de metas indicada. Conta as chamadas. */
  const comMetas = async (tag, tasks) => {
    const chamadas = [];
    globalThis.fetch = async (url) => {
      chamadas.push(String(url));
      // Pagina de verdade: pagina 0 devolve tudo e marca last_page.
      const pag = Number((String(url).match(/[?&]page=(\d+)/) || [])[1] ?? 0);
      return {
        ok: true, status: 200,
        headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
        json: async () => (pag === 0 ? { tasks, last_page: true } : { tasks: [], last_page: true }),
        text: async () => '',
      };
    };
    const cu = await carregarCom('api/clickup.js', libClickupUnica(tag));
    process.env.CLICKUP_API_KEY = 'pk_teste';
    const pedir = async (perfil) => {
      const r = res();
      await cu({ method: 'GET', headers: cabecalhos({ cookie: cookieDe(perfil) }), query: { action: 'metas' } }, r);
      return r;
    };
    pedir.chamadas = chamadas;
    return pedir;
  };

  const fetchOriginal = globalThis.fetch;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'G' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'C' };
  const per = (corpo, chave) => corpo.periodos.find((p) => p.chave === chave);

  // --- Caso de producao: 4 individuais + 1 equipe, tudo em Jul/2026 ---
  {
    const pedir = await comMetas('eq-declarada', [...JUL, LINHA_EQ]);
    const g = await pedir(GESTAO);
    checar('gestao: 200', g.code, 200);
    checar('E.6 custo: 1 chamada para a lista Metas', pedir.chamadas.length, 1);

    checar('um periodo so', g.corpo.periodos.map((p) => p.chave), ['2026-07']);
    checar('periodo corrente vem do status MES ATUAL', g.corpo.periodoAtual, '2026-07');
    checar('rotulo montado de Ano Base + Mes Referencia', per(g.corpo, '2026-07').rotulo, 'Julho/2026');
    checar('sem avisos gerais', g.corpo.avisosGerais, []);
    checar('sem avisos no periodo', per(g.corpo, '2026-07').avisos, []);

    const eq = per(g.corpo, '2026-07').equipe;
    checar('equipe do periodo e o DECLARADO, nao a soma', arred(eq.mrr), DECLARADO);
    checar('  e nao a soma das 5 linhas (era o bug)', arred(eq.mrr) === arred(SOMA + DECLARADO), false);
    checar('marcado como declarado', eq.declarado, true);
    checar('limiares vem da linha de equipe',
           [eq.meta, eq.superMeta, eq.ultraMeta, eq.metaEsp], [6918.07, 10377.11, 17295.18, 20000]);
    checar('a soma das individuais vem junto, para reconciliar', arred(eq.soma), SOMA);
    checar('  e a diferenca e os R$ 39,00 do downsell', arred(eq.diferenca), -39);

    // A linha de equipe NAO pode virar um quinto gerente.
    checar('tasks traz so as 4 individuais', g.corpo.tasks.length, 4);
    checar('  nenhuma delas e a de equipe', g.corpo.tasks.some((t) => t.gerenteId === EQUIPE), false);
    checar('  gerenteId resolvido de orderindex', g.corpo.tasks[0].gerenteId, OPCOES[0].id);
    checar('  cada linha carrega a chave do periodo', g.corpo.tasks[0].periodo, '2026-07');

    // CSM: recebe a propria linha e os limiares, mas nao a reconciliacao.
    const c = await pedir(GIAN);
    checar('csm ve so a propria meta', c.corpo.tasks.map((t) => t.gerente), ['Gian Luca']);
    checar('  "⭐ Equipe" nao casa com nenhum CSM', c.corpo.tasks.some((t) => t.gerenteId === EQUIPE), false);
    checar('  recebe o total declarado da equipe', arred(per(c.corpo, '2026-07').equipe.mrr), DECLARADO);
    checar('  recebe os limiares', per(c.corpo, '2026-07').equipe.ultraMeta, 17295.18);
    checar('  NAO recebe a reconciliacao',
           [per(c.corpo, '2026-07').equipe.soma, per(c.corpo, '2026-07').equipe.diferenca], [undefined, undefined]);

    // consulta: zero valor financeiro, inclusive aqui.
    const q = await pedir(CONSULTA);
    checar('consulta: tasks vazio', q.corpo.tasks, []);
    checar('  periodos vazio (carregam limiares)', q.corpo.periodos, []);
    checar('  periodoAtual nulo', q.corpo.periodoAtual, null);
  }

  // --- Dois meses na lista: o corrente e o do status, nao o mais recente ---
  {
    // Agosto existe mas esta em "meses fechados"; julho e o MES ATUAL. Prova que o
    // periodo vem do STATUS e nao do calendario nem da ordem.
    const pedir = await comMetas('dois-meses', [
      ...JUL, LINHA_EQ,
      ...quatro({ mes: 8, status: FECHADO }), eqDe('eq8', { mes: 8, status: FECHADO }),
    ]);
    const g = await pedir(GESTAO);
    checar('dois periodos, mais recente primeiro', g.corpo.periodos.map((p) => p.chave), ['2026-08', '2026-07']);
    checar('corrente e o do status MES ATUAL, nao o mais recente', g.corpo.periodoAtual, '2026-07');
    checar('  so um marcado como atual', g.corpo.periodos.filter((p) => p.atual).map((p) => p.chave), ['2026-07']);
    checar('cada periodo tem a sua equipe', arred(per(g.corpo, '2026-08').equipe.mrr), DECLARADO);
    checar('tasks traz as 8 individuais, com periodo em cada', g.corpo.tasks.length, 8);
    checar('  4 sao de julho', g.corpo.tasks.filter((t) => t.periodo === '2026-07').length, 4);
    checar('  4 sao de agosto', g.corpo.tasks.filter((t) => t.periodo === '2026-08').length, 4);
    checar('sem aviso: dois meses e o estado normal', g.corpo.avisosGerais, []);
  }

  // --- E.3 caso 1: nenhuma linha MES ATUAL ---
  {
    const pedir = await comMetas('sem-atual', [...quatro({ mes: 7, status: FECHADO }), eqDe('eq', { mes: 7, status: FECHADO })]);
    const g = await pedir(GESTAO);
    checar('E.3.1 sem MES ATUAL: periodoAtual nulo', g.corpo.periodoAtual, null);
    checar('  avisa na tela', g.corpo.avisosGerais.length, 1);
    checar('  e diz o que fazer', /marque as linhas do mês em andamento/i.test(g.corpo.avisosGerais[0]), true);
    checar('  o periodo continua na lista, para poder ser escolhido', g.corpo.periodos.map((p) => p.chave), ['2026-07']);
  }

  // --- E.3 caso 2: dois periodos distintos marcados MES ATUAL ---
  {
    const pedir = await comMetas('atual-ambiguo', [
      ...JUL, LINHA_EQ, ...quatro({ mes: 8 }), eqDe('eq8', { mes: 8 }),
    ]);
    const g = await pedir(GESTAO);
    checar('E.3.2 dois MES ATUAL: nao escolhe nenhum', g.corpo.periodoAtual, null);
    checar('  avisa na tela', g.corpo.avisosGerais.length, 1);
    checar('  nomeia os dois periodos', /Julho\/2026|Agosto\/2026/.test(g.corpo.avisosGerais[0]), true);
    checar('  nenhum periodo se declara atual', g.corpo.periodos.some((p) => p.atual), false);
  }

  // --- E.3 caso 3: dois registros do mesmo CSM no periodo ---
  {
    const pedir = await comMetas('csm-duplicado', [...JUL, linhaMeta('g2', 0, 999, 0, { mes: 7 }), LINHA_EQ]);
    const g = await pedir(GESTAO);
    const p = per(g.corpo, '2026-07');
    checar('E.3.3 CSM duplicado: aponta quem', p.gerentesAmbiguos, ['Gian Luca']);
    checar('  avisa na tela', p.avisos.length, 1);
    checar('  e diz que o numero nao sera exibido', /não pode ser exibida/i.test(p.avisos[0]), true);
    checar('  as duas linhas continuam em tasks, o front e que esconde', g.corpo.tasks.filter((t) => t.gerente === 'Gian Luca').length, 2);
  }

  // --- E.3 caso 4: duas linhas de equipe no periodo ---
  {
    const pedir = await comMetas('eq-duplicada', [...JUL, LINHA_EQ, linhaMeta('eq2', 4, 99999, 0, { mes: 7, ultra: 1 })]);
    const g = await pedir(GESTAO);
    const p = per(g.corpo, '2026-07');
    checar('E.3.4 duas linhas de equipe: cai na soma, nao escolhe uma', arred(p.equipe.mrr), SOMA);
    checar('  marcado como NAO declarado', p.equipe.declarado, false);
    checar('  limiares nulos, front usa a reserva', p.equipe.ultraMeta, null);
    checar('  avisa na tela', p.avisos.length, 1);
    checar('  nem uma nem outra vaza para tasks', g.corpo.tasks.length, 4);
  }

  // --- Fallback: linha de equipe ausente no periodo corrente ---
  {
    const pedir = await comMetas('eq-ausente', JUL);
    const g = await pedir(GESTAO);
    const p = per(g.corpo, '2026-07');
    checar('sem linha de equipe: cai na soma', arred(p.equipe.mrr), SOMA);
    checar('  marcado como NAO declarado', p.equipe.declarado, false);
    checar('  sem aviso na tela: o bloco ja se rotula "somado dos gerentes"', p.avisos, []);
    checar('  as 4 individuais seguem intactas', g.corpo.tasks.length, 4);
  }

  // --- Linha sem periodo: nao pode entrar em conta de mes nenhum ---
  {
    const pedir = await comMetas('sem-periodo', [...JUL, LINHA_EQ, linhaMeta('orfa', 1, 5000, 0, { mes: null, ano: null })]);
    const g = await pedir(GESTAO);
    checar('linha sem Ano/Mes fica fora dos periodos', g.corpo.periodos.map((p) => p.chave), ['2026-07']);
    checar('  avisa e nomeia a linha', /Meta orfa/.test(g.corpo.avisosGerais.join(' ')), true);
    checar('  nao contamina a soma de julho', arred(per(g.corpo, '2026-07').equipe.soma), SOMA);
    checar('  e vem com periodo null em tasks', g.corpo.tasks.find((t) => t.id === 'orfa').periodo, null);
  }

  globalThis.fetch = fetchOriginal;
}

console.log('\n[28b] getMetas pagina, e o custo continua 1 chamada abaixo de 100 linhas');
{
  const fetchOriginal = globalThis.fetch;
  const linha = (i) => ({
    id: `m${i}`, name: `Meta ${i}`, list: { id: '901327940637' }, status: { status: 'mês atual' },
    custom_fields: [],
  });

  // 250 linhas em 3 paginas: prova que nada desaparece acima de 100.
  {
    const chamadas = [];
    globalThis.fetch = async (url) => {
      chamadas.push(String(url));
      const pag = Number((String(url).match(/[?&]page=(\d+)/) || [])[1] ?? 0);
      const inicio = pag * 100;
      const tasks = inicio >= 250 ? [] : Array.from({ length: Math.min(100, 250 - inicio) }, (_, k) => linha(inicio + k));
      return {
        ok: true, status: 200,
        headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
        json: async () => ({ tasks, last_page: tasks.length < 100 }), text: async () => '',
      };
    };
    const lib = await import(libClickupUnica('metas-pagina'));
    process.env.CLICKUP_API_KEY = 'pk_teste';
    const { linhas } = await lib.getMetas();
    checar('250 linhas chegam inteiras (antes parava em 100)', linhas.length, 250);
    checar('  em 3 chamadas sequenciais', chamadas.length, 3);
    checar('  todas na lista Metas', chamadas.every((u) => u.includes('/list/901327940637/task')), true);
    checar('  com include_closed=false', chamadas.every((u) => u.includes('include_closed=false')), true);
  }

  // 5 linhas: 1 chamada, nao 4. Lote 1 existe para isso.
  {
    const chamadas = [];
    globalThis.fetch = async (url) => {
      chamadas.push(String(url));
      const pag = Number((String(url).match(/[?&]page=(\d+)/) || [])[1] ?? 0);
      const tasks = pag === 0 ? Array.from({ length: 5 }, (_, k) => linha(k)) : [];
      return {
        ok: true, status: 200,
        headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
        json: async () => ({ tasks, last_page: true }), text: async () => '',
      };
    };
    const lib = await import(libClickupUnica('metas-1-chamada'));
    process.env.CLICKUP_API_KEY = 'pk_teste';
    const { linhas } = await lib.getMetas();
    checar('5 linhas em 1 chamada (lote 4 custaria 4)', [linhas.length, chamadas.length], [5, 1]);
  }

  // A carteira continua em lote 4: o ganho de tempo la depende disso.
  {
    const chamadas = [];
    globalThis.fetch = async (url) => {
      chamadas.push(String(url));
      const pag = Number((String(url).match(/[?&]page=(\d+)/) || [])[1] ?? 0);
      const tasks = pag === 0 ? [{ id: 'c1', name: 'C', list: { id: '901327787926' }, status: { status: 'ativo' }, custom_fields: [] }] : [];
      return {
        ok: true, status: 200,
        headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
        json: async () => ({ tasks, last_page: pag === 0 }), text: async () => '',
      };
    };
    const lib = await import(libClickupUnica('carteira-lote'));
    process.env.CLICKUP_API_KEY = 'pk_teste';
    await lib.getCarteira();
    checar('carteira mantem o lote de 4 paginas concorrentes', chamadas.length, 4);
  }

  globalThis.fetch = fetchOriginal;
}

console.log('\n[29] bloco de equipe no front: regua compartilhada e limiares de reserva');
{
  const front = ler('dashboard_carteiras.html');
  const extrair = (nome) => {
    const inicio = front.indexOf(`function ${nome}(`);
    if (inicio < 0) return null;
    let i = front.indexOf('{', inicio);
    let profundidade = 0;
    for (; i < front.length; i++) {
      if (front[i] === '{') profundidade++;
      else if (front[i] === '}' && --profundidade === 0) return front.slice(inicio, i + 1);
    }
    return null;
  };

  // A regua tem de ser UMA funcao usada nos dois lugares, nao duas copias.
  checar('reguaHTML existe', Boolean(extrair('reguaHTML')), true);
  const usos = (front.match(/reguaHTML\(/g) || []).length;
  checar('reguaHTML: 1 declaracao + 2 usos', usos, 3);
  checar('nenhum mkr solto sobrou fora dela',
         (front.match(/const mkr\s*=/g) || []).length, 1);

  // renderEquipe roda para gestao e csm, nunca para consulta.
  const renderAll = extrair('renderAll');
  checar('renderEquipe chamado sob showMRR', /if\(showMRR\)\{\s*renderEquipe\(\);/.test(renderAll), true);
  checar('  e nao dentro do bloco de gestao', /gestao'&&currentTab==='geral'\)\{renderEquipe/.test(renderAll), false);

  // Limiares e recorte por periodo. Os limiares saem do periodo ATIVO, entao o teste
  // carrega periodoAtivo/metasDoPeriodo junto — e o que prova que nenhum consumidor
  // le metasData direto.
  checar('periodoAtivo existe', Boolean(extrair('periodoAtivo')), true);
  checar('metasDoPeriodo existe', Boolean(extrair('metasDoPeriodo')), true);
  checar('metaDoCsm existe', Boolean(extrair('metaDoCsm')), true);

  const mod = await import(dataUrl(
    `let periodos = [], periodoSel = null, metasData = [];\n` +
    `export const setEstado = (p, sel, m) => { periodos = p; periodoSel = sel; metasData = m || []; };\n` +
    `const META_EQ = {meta:6918.07,super:10377.11,ultra:17295.18,especial:20000};\n` +
    `${extrair('periodoAtivo')}\n${extrair('metasDoPeriodo')}\n${extrair('metaDoCsm')}\n` +
    `${extrair('mrrEquipeSel')}\n${extrair('limiaresEquipe')}\n` +
    `export { periodoAtivo, metasDoPeriodo, metaDoCsm, mrrEquipeSel, limiaresEquipe };\n`
  ));

  const pJul = {
    chave: '2026-07', rotulo: 'Julho/2026', atual: true, gerentesAmbiguos: [],
    equipe: { mrr: 11028.76, declarado: true, meta: 100, superMeta: 200, ultraMeta: 300, metaEsp: 400 },
  };
  const pAgo = {
    chave: '2026-08', rotulo: 'Agosto/2026', atual: false, gerentesAmbiguos: ['Gian Luca'],
    equipe: { mrr: 5000, declarado: false, meta: null, superMeta: null, ultraMeta: null, metaEsp: null },
  };
  const METAS = [
    { gerente: 'Gian Luca', periodo: '2026-07', mrrAt: 1 },
    { gerente: 'Lucineia Felix', periodo: '2026-07', mrrAt: 2 },
    { gerente: 'Gian Luca', periodo: '2026-08', mrrAt: 3 },
    { gerente: 'Gian Luca', periodo: '2026-08', mrrAt: 4 },
  ];

  mod.setEstado([pAgo, pJul], '2026-07', METAS);
  const dec = mod.limiaresEquipe();
  checar('declarado vence a reserva', [dec.meta, dec.super, dec.ultra, dec.especial], [100, 200, 300, 400]);
  checar('  e marca a origem com o rotulo do periodo', [dec.declarado, dec.mesRef], [true, 'Julho/2026']);
  checar('mrrEquipeSel sai do periodo ativo', mod.mrrEquipeSel(), 11028.76);
  checar('metasDoPeriodo filtra pelo periodo', mod.metasDoPeriodo().map((m) => m.mrrAt), [1, 2]);
  checar('metaDoCsm acha a do periodo', mod.metaDoCsm('Gian Luca').mrrAt, 1);

  // Trocar de periodo troca TUDO junto: limiares, total e linhas.
  mod.setEstado([pAgo, pJul], '2026-08', METAS);
  const fb = mod.limiaresEquipe();
  checar('trocar de periodo troca os limiares', [fb.meta, fb.ultra], [6918.07, 17295.18]);
  checar('  e o total da equipe', mod.mrrEquipeSel(), 5000);
  checar('  e as linhas', mod.metasDoPeriodo().map((m) => m.mrrAt), [3, 4]);
  checar('  limiares nulos caem na reserva', [fb.super, fb.especial], [10377.11, 20000]);
  checar('  e nao se declara declarado', fb.declarado, false);
  // E.3.3 no front: CSM com duas linhas no periodo devolve null, nao a primeira.
  checar('CSM ambiguo no periodo devolve null, nao escolhe', mod.metaDoCsm('Gian Luca'), null);
  checar('  outro CSM sem duplicata segue normal', mod.metaDoCsm('Lucineia Felix'), null);

  // Sem periodo selecionado: nada de numero inventado.
  mod.setEstado([], null, METAS);
  const vazio = mod.limiaresEquipe();
  checar('sem periodo: total zero e reserva nos limiares', [mod.mrrEquipeSel(), vazio.ultra], [0, 17295.18]);
  checar('  periodoAtivo nulo', mod.periodoAtivo(), null);
  checar('  e nenhuma linha selecionada', mod.metasDoPeriodo(), []);

  // Limiar declarado como 0 nao pode virar "meta zero atingida".
  mod.setEstado([{ ...pJul, equipe: { ...pJul.equipe, meta: 0, ultraMeta: 0 } }], '2026-07', METAS);
  const zero = mod.limiaresEquipe();
  checar('limiar 0 tambem cai na reserva', [zero.meta, zero.ultra], [6918.07, 17295.18]);
}

console.log('\n[30] Evento: Camp 2026 — allowlist explicita, escopo e reflexo');
{
  const CAMPO = '54ee7ad4-4689-4d79-bec7-5ac1373d96e9';
  const CONVIDADO = '52fbe800-c9cf-4aca-b75e-fdbbb4ea7e07';
  const PARTICIPOU = '8ceeca28-bc44-4f86-b3ff-f6205c316dda';
  const OPCOES = [
    { id: CONVIDADO, name: 'Convidado 💠', orderindex: 0 },
    { id: '69d511be-83fd-48e0-96ce-c4567a9c1e3f', name: 'Inscrito ✅', orderindex: 1 },
    { id: '0a08b436-5e35-458b-a05d-93f816e81488', name: 'Não Vai 🚫', orderindex: 2 },
    { id: PARTICIPOU, name: 'Participou ✨', orderindex: 3 },
  ];
  const GERENTE = '3898a8f4-bb21-46d7-88ee-79d164033fdf';
  const fetchOriginal = globalThis.fetch;
  const escritas = [];

  const task = () => ({
    id: 'tCamp', name: 'Cliente Camp', list: { id: '901327787926' }, status: { status: 'ativo' },
    custom_fields: [
      { id: GERENTE, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Gian Luca' }] } },
      { id: CAMPO, type: 'drop_down', value: CONVIDADO, type_config: { options: OPCOES } },
    ],
  });

  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') escritas.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true, status: 200,
      headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
      json: async () => (/\/list\//.test(String(url)) ? { tasks: [task()], last_page: true } : task()),
      text: async () => '',
    };
  };

  const libUrl = libClickupUnica('evento-camp');
  const lib = await import(libUrl);
  const cu = await carregarCom('api/clickup.js', libUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';

  // A allowlist e explicita: o campo entrou com os 4 ids, e nada mais.
  checar('campo esta em CAMPOS_ESCRITA', Object.hasOwn(lib.CAMPOS_ESCRITA, CAMPO), true);
  checar('  como tipo opcao', lib.CAMPOS_ESCRITA[CAMPO].tipo, 'opcao');
  checar('  com exatamente 4 opcoes', lib.CAMPOS_ESCRITA[CAMPO].opcoes.size, 4);
  checar('  e os ids sao os da lista exportada',
         lib.EVENTO_CAMP_OPCOES.map((o) => o.id).every((id) => lib.CAMPOS_ESCRITA[CAMPO].opcoes.has(id)), true);
  // Nenhuma regra generica de "qualquer drop_down": a allowlist segue fechada.
  // 5 + os 3 campos numericos da campanha (vendidos/cortesia/valor vendido).
  checar('total de campos na allowlist continua enumeravel', Object.keys(lib.CAMPOS_ESCRITA).length, 8);

  // Front e servidor tem de usar os MESMOS ids.
  const front = ler('dashboard_carteiras.html');
  const campoFront = front.match(/const CAMPO_EVENTO_CAMP\s*=\s*'([0-9a-f-]+)'/);
  checar('front declara o fieldId', campoFront?.[1], CAMPO);
  for (const o of lib.EVENTO_CAMP_OPCOES) {
    checar(`front tem a opcao ${o.rotulo}`, front.includes(o.id), true);
  }

  // Leitura: rotulo e id na linha.
  const { linhas } = await lib.getCarteira();
  checar('mapTask expoe o rotulo', linhas[0].eventoCamp, 'Convidado 💠');
  checar('  e o id da opcao', linhas[0].eventoCampId, CONVIDADO);

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const gravar = async (perfil, value) => {
    const r = res();
    await cu({
      method: 'POST',
      headers: cabecalhos({ cookie: cookieDe(perfil), 'content-type': 'application/json' }),
      query: { action: 'set-field' },
      body: { taskId: 'tCamp', fieldId: CAMPO, value },
    }, r);
    return r;
  };
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'G' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const PATRICIA = { nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'C' };

  escritas.length = 0;
  const ok = await gravar(GESTAO, PARTICIPOU);
  checar('gestao grava: 200', [ok.code, ok.corpo.ok], [200, true]);
  checar('  nome do campo na resposta', ok.corpo.campo, 'Evento: Camp 2026');
  checar('  manda o ID da opcao, nao o rotulo', escritas.at(-1).body.value, PARTICIPOU);
  checar('  no endpoint do campo certo', escritas.at(-1).url.includes(`/field/${CAMPO}`), true);
  checar('  E.6 custo: 1 POST por gravacao', escritas.filter((e) => e.url.includes('/field/')).length, 1);

  // refletirEscrita atualiza a linha em cache, sem reler a carteira.
  const depois = await lib.getCarteira();
  checar('refletirEscrita atualiza o id', depois.linhas[0].eventoCampId, PARTICIPOU);
  checar('  e o rotulo aprendido do ClickUp', depois.linhas[0].eventoCamp, 'Participou ✨');

  // Validacao nao afrouxou.
  const csmDono = await gravar(GIAN, CONVIDADO);
  checar('csm dono grava: 200', csmDono.code, 200);
  const csmOutro = await gravar(PATRICIA, CONVIDADO);
  checar('csm de outra carteira: 403 fora_da_carteira', [csmOutro.code, csmOutro.corpo.code], [403, 'fora_da_carteira']);
  const soLeitura = await gravar(CONSULTA, CONVIDADO);
  checar('consulta: 403 somente_leitura', [soLeitura.code, soLeitura.corpo.code], [403, 'somente_leitura']);
  const idFalso = await gravar(GESTAO, '11111111-2222-3333-4444-555555555555');
  checar('opcao fora da allowlist: 403', [idFalso.code, idFalso.corpo.code], [403, 'valor_nao_permitido']);
  const arr = await gravar(GESTAO, [CONVIDADO]);
  checar('array num campo de opcao: 403', [arr.code, arr.corpo.code], [403, 'valor_nao_permitido']);
  const rotulo = await gravar(GESTAO, 'Convidado 💠');
  checar('rotulo em vez de id: 403', [rotulo.code, rotulo.corpo.code], [403, 'valor_nao_permitido']);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[31] limpar campo: DELETE, so no Camp 2026, mesmo portao de escrita');
{
  const CAMP = '54ee7ad4-4689-4d79-bec7-5ac1373d96e9';
  const CONVIDADO = '52fbe800-c9cf-4aca-b75e-fdbbb4ea7e07';
  const ETAPA = 'd15028f2-40c6-44da-a5dc-3d608eef6f48';
  const TIPO = 'a4acad54-a6da-477f-b1fc-b3cbf56bbd08';
  const ALERTAS = '6ce5db54-1a1d-4dfa-944d-4b01b8832549';
  const ACOMP = '94b85690-3d47-4edf-9209-0a671cfb570b';
  const GERENTE = '3898a8f4-bb21-46d7-88ee-79d164033fdf';
  const OPCOES = [{ id: CONVIDADO, name: 'Convidado 💠', orderindex: 0 }];

  const fetchOriginal = globalThis.fetch;
  const chamadas = [];
  const task = () => ({
    id: 'tLimpa', name: 'Cliente Limpa', list: { id: '901327787926' }, status: { status: 'ativo' },
    custom_fields: [
      { id: GERENTE, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Gian Luca' }] } },
      { id: CAMP, type: 'drop_down', value: CONVIDADO, type_config: { options: OPCOES } },
    ],
  });

  globalThis.fetch = async (url, init) => {
    const metodo = init?.method || 'GET';
    chamadas.push({ url: String(url), metodo });
    const cabecalhos = new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]);
    // O DELETE de campo personalizado responde 200 com CORPO VAZIO. `json()` que
    // lanca reproduz isso: sem o tratamento em cu(), a escrita seria aplicada e a
    // funcao devolveria 500 — o pior dos mundos, porque o front reverteria a tela.
    if (metodo === 'DELETE') {
      return {
        ok: true, status: 200, headers: cabecalhos,
        json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
        text: async () => '',
      };
    }
    return {
      ok: true, status: 200, headers: cabecalhos,
      json: async () => (/\/list\//.test(String(url)) ? { tasks: [task()], last_page: true } : task()),
      text: async () => '',
    };
  };

  const libUrl = libClickupUnica('limpar-campo');
  const lib = await import(libUrl);
  const cu = await carregarCom('api/clickup.js', libUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';

  // A permissao e marcada campo a campo, e SO o Camp a tem.
  checar('Camp 2026 e limpavel', lib.CAMPOS_ESCRITA[CAMP].limpavel, true);
  const naoLimpaveis = [['Etapa', ETAPA], ['Tipo de solicitacao', TIPO], ['Alertas', ALERTAS], ['Em acompanhamento', ACOMP]];
  for (const [nome, id] of naoLimpaveis) {
    checar(`${nome} NAO e limpavel`, Boolean(lib.CAMPOS_ESCRITA[id].limpavel), false);
  }
  checar('so 1 campo limpavel na allowlist inteira',
         Object.values(lib.CAMPOS_ESCRITA).filter((c) => c.limpavel).length, 1);

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const enviar = async (perfil, fieldId, value) => {
    const r = res();
    await cu({
      method: 'POST',
      headers: cabecalhos({ cookie: cookieDe(perfil), 'content-type': 'application/json' }),
      query: { action: 'set-field' },
      body: { taskId: 'tLimpa', fieldId, value },
    }, r);
    return r;
  };
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'G' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const PATRICIA = { nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'C' };

  // Aquece o cache da carteira para poder conferir o reflexo.
  await lib.getCarteira();

  chamadas.length = 0;
  const limpou = await enviar(GESTAO, CAMP, null);
  checar('limpar Camp: 200', [limpou.code, limpou.corpo.ok], [200, true]);
  checar('  resposta marca que foi limpeza', limpou.corpo.limpo, true);
  const escrita = chamadas.find((c) => c.url.includes(`/field/${CAMP}`));
  checar('  usou DELETE, nao POST', escrita?.metodo, 'DELETE');
  checar('  no endpoint do campo', escrita?.url.includes('/task/tLimpa/field/'), true);
  checar('  corpo vazio nao derrubou (era o risco do DELETE)', limpou.code, 200);

  // O reflexo no cache tem de APAGAR os dois, nao so um.
  const depois = await lib.getCarteira();
  checar('refletirEscrita zera o id', depois.linhas[0].eventoCampId, null);
  checar('  e o rotulo', depois.linhas[0].eventoCamp, null);

  // Gravar normal continua POST.
  chamadas.length = 0;
  await enviar(GESTAO, CAMP, CONVIDADO);
  checar('gravar opcao continua POST', chamadas.find((c) => c.url.includes(`/field/${CAMP}`))?.metodo, 'POST');

  // Os outros campos NAO podem ser limpos — e a recusa e nossa, sem tocar o ClickUp.
  for (const [nome, id] of naoLimpaveis) {
    chamadas.length = 0;
    const r = await enviar(GESTAO, id, null);
    checar(`limpar ${nome}: 403 valor_nao_permitido`, [r.code, r.corpo.code], [403, 'valor_nao_permitido']);
    checar(`  e nenhum DELETE saiu para o ClickUp`, chamadas.some((c) => c.metodo === 'DELETE'), false);
  }

  // O portao de escrita vale para o DELETE tambem.
  const csmDono = await enviar(GIAN, CAMP, null);
  checar('csm dono limpa: 200', csmDono.code, 200);
  const csmOutro = await enviar(PATRICIA, CAMP, null);
  checar('csm de outra carteira: 403 fora_da_carteira no DELETE', [csmOutro.code, csmOutro.corpo.code], [403, 'fora_da_carteira']);
  const consulta = await enviar(CONSULTA, CAMP, null);
  checar('consulta: 403 somente_leitura no DELETE', [consulta.code, consulta.corpo.code], [403, 'somente_leitura']);

  // Campo fora da allowlist nao ganha limpeza por tabela.
  const forinha = await enviar(GESTAO, '99999999-8888-7777-6666-555555555555', null);
  checar('campo fora da allowlist: 403 campo_nao_permitido', [forinha.code, forinha.corpo.code], [403, 'campo_nao_permitido']);

  // `value` AUSENTE nao pode virar limpeza: corpo incompleto nao apaga dado.
  {
    const r = res();
    await cu({
      method: 'POST',
      headers: cabecalhos({ cookie: cookieDe(GESTAO), 'content-type': 'application/json' }),
      query: { action: 'set-field' },
      body: { taskId: 'tLimpa', fieldId: CAMP },
    }, r);
    checar('value ausente NAO limpa: 403', [r.code, r.corpo.code], [403, 'valor_nao_permitido']);
  }

  // O front tem de mandar null, nao string vazia.
  const front = ler('dashboard_carteiras.html');
  checar('front manda null ao limpar', /value:\s*limpando\s*\?\s*null\s*:/.test(front), true);
  checar('  e o seletor tem a opcao de limpar', front.includes('— sem marcação —'), true);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[32] action=busca: diretorio sem valor financeiro, sem filtro de CSM');
{
  const CF = {
    mrr: '59888807-a3f3-42f0-aebd-f63032011ed1',
    gerente: '3898a8f4-bb21-46d7-88ee-79d164033fdf',
    idNucleo: '6126a50b-7afb-40fd-8654-26a687f34258',
    cnpj: '1e819aec-0121-44c2-8a92-302c2f0e4450',
    cidade: 'beaef1da-fffa-419f-9827-093b5452f8fc',
    finStatus: 'c290f699-8d56-437c-9319-1cf282430d12',
    alertas: '6ce5db54-1a1d-4dfa-944d-4b01b8832549',
    nps: '49b335f4-98b9-40b6-acf6-f06ca3061621',
    obs: '114a9169-2a63-42b6-b9d3-8596232d0401',
    planoGestor: '806ccb6e-5368-43de-8fca-bcb7ba25d918',
    evento: '54ee7ad4-4689-4d79-bec7-5ac1373d96e9',
  };
  const ALERTA = 'ddaddf7d-9ffa-49de-9b53-6e63acbbceb3';
  const fetchOriginal = globalThis.fetch;
  const chamadas = [];

  // Cliente de OUTRA carteira, com todo campo sensivel preenchido: e o caso que
  // prova a projecao.
  const cliente = (id, gerente, extras = {}) => ({
    id, name: extras.nome || `Cliente ${id}`, list: { id: '901327787926' },
    status: { status: extras.status || 'ativo' },
    description: 'descricao interna',
    custom_fields: [
      { id: CF.gerente, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: gerente }] } },
      { id: CF.mrr, type: 'number', value: 4321 },
      { id: CF.idNucleo, type: 'short_text', value: '10748' },
      { id: CF.cnpj, type: 'short_text', value: '44.586.393/0001-10' },
      // `in` e nao `??`: o caso do c3 e cidade EXPLICITAMENTE nula.
      { id: CF.cidade, type: 'short_text', value: 'cidade' in extras ? extras.cidade : 'Londrina' },
      { id: CF.finStatus, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Pendente' }] } },
      { id: CF.alertas, type: 'labels', value: [ALERTA], type_config: { options: [{ id: ALERTA, label: 'Risco de Churn' }] } },
      { id: CF.nps, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Detrator' }] } },
      { id: CF.obs, type: 'short_text', value: 'observacao interna sigilosa' },
      { id: CF.planoGestor, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Gestor Ouro' }] } },
      { id: CF.evento, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Convidado 💠' }] } },
    ],
  });

  const TASKS = [
    cliente('c1', 'Gian Luca', { nome: 'Alfa Comercio' }),
    cliente('c2', 'Patricia Carvalho', { nome: 'Beta Servicos', status: 'cancelado' }),
    cliente('c3', 'Guilherme Camargo', { nome: 'Gama Ltda', cidade: null }),
  ];

  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    return {
      ok: true, status: 200,
      headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
      json: async () => {
        const pag = Number((String(url).match(/[?&]page=(\d+)/) || [])[1] ?? 0);
        return pag === 0 ? { tasks: TASKS, last_page: true } : { tasks: [], last_page: true };
      },
      text: async () => '',
    };
  };

  const libUrl = libClickupUnica('busca');
  const cu = await carregarCom('api/clickup.js', libUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const pedir = async (perfil, acao = 'busca') => {
    const r = res();
    await cu({ method: 'GET', headers: cabecalhos({ cookie: cookieDe(perfil) }), query: { action: acao } }, r);
    return r;
  };
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'G' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'C' };

  const semSessao = res();
  await cu({ method: 'GET', headers: cabecalhos(), query: { action: 'busca' } }, semSessao);
  checar('sem cookie: 401 sessao_invalida', [semSessao.code, semSessao.corpo.code], [401, 'sessao_invalida']);

  // A projecao e uma lista FECHADA. Este e o teste que importa.
  const PERMITIDOS = ['id', 'idNucleo', 'cnpj', 'nome', 'cidade', 'gerente', 'status'];
  const PROIBIDOS = ['mrr', 'finStatus', 'alertas', 'alertasIds', 'nps', 'csat', 'obs',
                     'descricao', 'planoGestor', 'planoUnique', 'baseRenov', 'criterio',
                     'motivoPerda', 'motivoPerdaId', 'eventoCamp', 'eventoCampId',
                     'outrosSrv', 'acomp', 'dataCancel'];

  for (const perfil of [GESTAO, GIAN, CONSULTA]) {
    const r = await pedir(perfil);
    const rotulo = perfil.nivel;
    checar(`${rotulo}: 200`, r.code, 200);
    checar(`${rotulo}: ve os 3 clientes, sem filtro de CSM`, r.corpo.tasks.length, 3);
    const chaves = Object.keys(r.corpo.tasks[0]).sort();
    checar(`${rotulo}: exatamente os campos permitidos`, chaves, [...PERMITIDOS].sort());
    const vazou = PROIBIDOS.filter((k) => r.corpo.tasks.some((t) => k in t));
    checar(`${rotulo}: nenhum campo sensivel vazou`, vazou, []);
  }

  // O CSM ve o cliente de OUTRA carteira — e o objetivo da acao.
  const gian = await pedir(GIAN);
  checar('csm ve cliente de outra carteira', gian.corpo.tasks.map((t) => t.gerente).sort(),
         ['Gian Luca', 'Guilherme Camargo', 'Patricia Carvalho']);
  checar('  com o nome e o gerente, que e a resposta que ele queria',
         [gian.corpo.tasks[1].nome, gian.corpo.tasks[1].gerente], ['Beta Servicos', 'Patricia Carvalho']);
  checar('  status vem junto', gian.corpo.tasks[1].status, 'cancelado');
  checar('  cidade ausente vira null, nao undefined', gian.corpo.tasks[2].cidade, null);
  checar('  e o campos declarado na resposta bate', gian.corpo.campos, PERMITIDOS);

  // action=carteira NAO foi afrouxada: o CSM continua vendo so a propria.
  const carteiraGian = await pedir(GIAN, 'carteira');
  checar('action=carteira segue filtrada por CSM', carteiraGian.corpo.tasks.map((t) => t.gerente), ['Gian Luca']);
  checar('  e continua trazendo o mrr para o dono', carteiraGian.corpo.tasks[0].mrr, 4321);
  const carteiraConsulta = await pedir(CONSULTA, 'carteira');
  checar('action=carteira segue zerando mrr para consulta',
         carteiraConsulta.corpo.tasks.every((t) => t.mrr === 0), true);

  // Custo: a busca reusa o cache da carteira, sem leitura nova.
  chamadas.length = 0;
  await pedir(GESTAO);
  checar('E.6 custo: cache quente, 0 chamadas ao ClickUp', chamadas.length, 0);

  // Metodo errado e acao desconhecida.
  const post = res();
  await cu({ method: 'POST', headers: cabecalhos({ cookie: cookieDe(GESTAO), 'content-type': 'application/json' }),
             query: { action: 'busca' }, body: {} }, post);
  checar('POST em action=busca: 405', post.code, 405);

  // O front precisa ter a aba e nao pode carregar carteira no perfil consulta.
  const front = ler('dashboard_carteiras.html');
  checar('front tem a aba de busca', /id:'busca'/.test(front), true);
  checar('front chama action=busca', front.includes("action=busca"), true);
  checar('consulta nao carrega a carteira no front', /nivel==='consulta'\)\{[\s\S]{0,400}?return;/.test(front), true);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[33] Campanha Camp 2026 — 3 campos numericos, allowlist e escopo');
{
  const VENDIDOS = '4a4400e7-6bfd-423e-9467-9c6f11c458c9';
  const CORTESIA = '62514802-d199-462a-9a44-9e8389c74951';
  const VALOR = '748dbd02-1c2f-4f31-a5f7-5cc82bcd3cb0';
  const GERENTE = '3898a8f4-bb21-46d7-88ee-79d164033fdf';
  const fetchOriginal = globalThis.fetch;
  const escritas = [];

  const task = () => ({
    id: 'tCampanha', name: 'Cliente Campanha', list: { id: '901327787926' }, status: { status: 'ativo' },
    custom_fields: [
      { id: GERENTE, type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Gian Luca' }] } },
      { id: VENDIDOS, type: 'number', value: 10 },
      { id: CORTESIA, type: 'number', value: 2 },
      { id: VALOR, type: 'currency', value: 1234.5 },
    ],
  });

  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') escritas.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true, status: 200,
      headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '95'], ['x-ratelimit-reset', '0']]),
      json: async () => (/\/list\//.test(String(url)) ? { tasks: [task()], last_page: true } : task()),
      text: async () => '',
    };
  };

  const libUrl = libClickupUnica('campanha-camp');
  const lib = await import(libUrl);
  const cu = await carregarCom('api/clickup.js', libUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';

  // Allowlist: os 3 campos entraram como tipo numero, com teto contra digitacao errada.
  for (const [nome, id, max] of [['vendidos', VENDIDOS, 999], ['cortesia', CORTESIA, 999], ['valor', VALOR, 999999]]) {
    checar(`${nome} esta em CAMPOS_ESCRITA`, Object.hasOwn(lib.CAMPOS_ESCRITA, id), true);
    checar(`  ${nome} como tipo numero`, lib.CAMPOS_ESCRITA[id].tipo, 'numero');
    checar(`  ${nome} com o teto certo`, lib.CAMPOS_ESCRITA[id].max, max);
    checar(`  ${nome} nao e limpavel`, Boolean(lib.CAMPOS_ESCRITA[id].limpavel), false);
  }

  // Front e servidor tem de usar os MESMOS ids.
  const front = ler('dashboard_carteiras.html');
  checar('front declara CAMPO_CAMP_VENDIDOS', front.includes(`CAMPO_CAMP_VENDIDOS='${VENDIDOS}'`), true);
  checar('front declara CAMPO_CAMP_CORTESIA', front.includes(`CAMPO_CAMP_CORTESIA='${CORTESIA}'`), true);
  checar('front declara CAMPO_CAMP_VALOR', front.includes(`CAMPO_CAMP_VALOR='${VALOR}'`), true);

  // Leitura: mapTask expoe os 3 valores.
  const { linhas } = await lib.getCarteira();
  checar('mapTask expoe vendidos', linhas[0].campVendidos, 10);
  checar('  cortesia', linhas[0].campCortesia, 2);
  checar('  valor vendido', linhas[0].campValor, 1234.5);

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const gravar = async (perfil, fieldId, value) => {
    const r = res();
    await cu({
      method: 'POST',
      headers: cabecalhos({ cookie: cookieDe(perfil), 'content-type': 'application/json' }),
      query: { action: 'set-field' },
      body: { taskId: 'tCampanha', fieldId, value },
    }, r);
    return r;
  };
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'G' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const PATRICIA = { nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'C' };

  escritas.length = 0;
  const ok = await gravar(GESTAO, VENDIDOS, 15);
  checar('gestao grava numero valido: 200', [ok.code, ok.corpo.ok], [200, true]);
  checar('  manda o numero, nao string', escritas.at(-1).body.value, 15);

  const depois = await lib.getCarteira();
  checar('refletirEscrita atualiza sem reler', depois.linhas[0].campVendidos, 15);

  // Validacao do tipo numero.
  const negativo = await gravar(GESTAO, VENDIDOS, -1);
  checar('numero negativo: 403', [negativo.code, negativo.corpo.code], [403, 'valor_nao_permitido']);
  const acimaDoTeto = await gravar(GESTAO, VENDIDOS, 1000);
  checar('acima do teto (999): 403', [acimaDoTeto.code, acimaDoTeto.corpo.code], [403, 'valor_nao_permitido']);
  const string = await gravar(GESTAO, VENDIDOS, '10');
  checar('string em vez de numero: 403', [string.code, string.corpo.code], [403, 'valor_nao_permitido']);
  const nan = await gravar(GESTAO, VENDIDOS, NaN);
  checar('NaN: 403', [nan.code, nan.corpo.code], [403, 'valor_nao_permitido']);
  const nulo = await gravar(GESTAO, VENDIDOS, null);
  checar('null: 403 (campo nao e limpavel)', [nulo.code, nulo.corpo.code], [403, 'valor_nao_permitido']);
  const valorAltoOk = await gravar(GESTAO, VALOR, 999999);
  checar('valor no teto exato (999999): 200', valorAltoOk.code, 200);

  // Escopo: mesmo portao de sempre.
  const csmDono = await gravar(GIAN, CORTESIA, 3);
  checar('csm dono grava: 200', csmDono.code, 200);
  const csmOutro = await gravar(PATRICIA, CORTESIA, 3);
  checar('csm de outra carteira: 403 fora_da_carteira', [csmOutro.code, csmOutro.corpo.code], [403, 'fora_da_carteira']);
  const soLeitura = await gravar(CONSULTA, CORTESIA, 3);
  checar('consulta: 403 somente_leitura', [soLeitura.code, soLeitura.corpo.code], [403, 'somente_leitura']);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[34] Projetos em Andamento — posse por CSM, etapas e estado embutido na descricao');
{
  const fetchOriginal = globalThis.fetch;
  const escritas = [];
  const LISTA = '901328976497';

  // Sem negrito/fence de proposito: uma task real devolve markdown_description
  // como texto simples (ClickUp descarta a sintaxe no round-trip — confirmado
  // com uma task real), entao o formato do fixture espelha o que volta de la.
  const descProjeto = (estado) =>
    `CSM: Gian Luca\n\nContexto de teste.\n\n${JSON.stringify(estado)}`;
  const descAgente = (estado) =>
    `Frente: Cobranca\n\n${JSON.stringify(estado)}`;

  const estadoProjeto = { etapaAtual: 'alinhamento', prioridade: ['tAgente1'], agenteAtualId: 'tAgente1', concluidos: [], agentesTotal: 1 };
  const estadoAgente = { estrutura: { nome: 'Guardião X', frente: 'Cobranca' }, buildChecks: {}, testChecks: {}, entregaChecks: {} };

  const taskProjeto = () => ({
    id: 'tProjeto', name: 'Cliente X — Implantação Waipe', list: { id: LISTA },
    status: { status: 'pendente' }, parent: null, subtasks: [{ id: 'tAgente1' }],
    description: descProjeto(estadoProjeto),
  });
  const taskAgente = () => ({
    id: 'tAgente1', name: 'Guardião X', list: { id: LISTA }, parent: 'tProjeto',
    status: { status: 'pendente' }, due_date: null,
    description: descAgente(estadoAgente),
  });

  function ok(corpo) {
    return {
      ok: true, status: 200,
      headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '90'], ['x-ratelimit-reset', '0']]),
      json: async () => corpo, text: async () => '',
    };
  }

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const metodo = init?.method || 'GET';
    if (metodo === 'PUT' && u.endsWith('/task/tProjeto')) {
      escritas.push({ alvo: 'projeto', body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'PUT' && u.endsWith('/task/tAgente1')) {
      escritas.push({ alvo: 'agente', body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'POST' && u.endsWith('/comment')) {
      escritas.push({ alvo: 'comentario', body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'GET' && u.endsWith('/comment')) {
      return ok({ comments: [{ id: 'c1', comment_text: 'Nota antiga', user: { username: 'Gian Luca' }, date: '1700000000000' }] });
    }
    if (metodo === 'POST' && u.endsWith(`/list/${LISTA}/task`)) {
      escritas.push({ alvo: 'criar', body: JSON.parse(init.body) });
      return ok({ id: 'tNovoProjeto' });
    }
    if (u.includes(`/list/${LISTA}/task?`)) return ok({ tasks: [taskProjeto()], last_page: true });
    if (u.includes('/task/tProjeto')) return ok(taskProjeto());
    if (u.includes('/task/tAgente1')) return ok(taskAgente());
    return ok({});
  };

  const libUrl = libClickupUnica('implantacoes');
  const cu = await carregarCom('api/clickup.js', libUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'Gestao' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const PATRICIA = { nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'Consulta' };

  const chamarAcao = async (perfil, method, action, extra = {}) => {
    const r = res();
    await cu({
      method,
      headers: cabecalhos({ cookie: cookieDe(perfil) }),
      query: { action, ...(extra.query || {}) },
      body: extra.body,
    }, r);
    return r;
  };

  // listar-implantacoes: escopo por CSM
  const listaGian = await chamarAcao(GIAN, 'GET', 'listar-implantacoes');
  checar('listar-implantacoes: csm dono ve o projeto', listaGian.corpo.tasks.map((t) => t.id), ['tProjeto']);
  const listaPatricia = await chamarAcao(PATRICIA, 'GET', 'listar-implantacoes');
  checar('listar-implantacoes: csm de outra carteira nao ve', listaPatricia.corpo.tasks, []);
  const listaGestao = await chamarAcao(GESTAO, 'GET', 'listar-implantacoes');
  checar('listar-implantacoes: gestao ve tudo', listaGestao.corpo.total, 1);

  // obter-implantacao: dono ve com agentes e estado embutido, outro csm 403, id invalido 400
  const obterGian = await chamarAcao(GIAN, 'GET', 'obter-implantacao', { query: { id: 'tProjeto' } });
  checar('obter-implantacao: 200 com 1 agente', [obterGian.code, obterGian.corpo.agentes.length], [200, 1]);
  checar('  etapaAtual do estado embutido', obterGian.corpo.projeto.etapaAtual, 'alinhamento');
  checar('  estrutura do agente veio do estado embutido', obterGian.corpo.agentes[0].estrutura.frente, 'Cobranca');
  checar('  contexto sem o bloco de estado', obterGian.corpo.projeto.contexto.includes('waipe-state'), false);
  const obterPatricia = await chamarAcao(PATRICIA, 'GET', 'obter-implantacao', { query: { id: 'tProjeto' } });
  checar('obter-implantacao: csm de outra carteira -> 403', [obterPatricia.code, obterPatricia.corpo.code], [403, 'fora_da_carteira']);
  const obterInvalido = await chamarAcao(GESTAO, 'GET', 'obter-implantacao', { query: { id: 'zzz!!' } });
  checar('obter-implantacao: id invalido -> 400', [obterInvalido.code, obterInvalido.corpo.code], [400, 'task_invalida']);

  // criar-implantacao: consulta nao pode, sem agente 400, gestao cria pai + subtask
  const criarConsulta = await chamarAcao(CONSULTA, 'POST', 'criar-implantacao', { body: { cliente: 'X', agentes: [{ nome: 'A' }] } });
  checar('criar-implantacao: consulta -> 403', [criarConsulta.code, criarConsulta.corpo.code], [403, 'somente_leitura']);
  const criarSemAgente = await chamarAcao(GESTAO, 'POST', 'criar-implantacao', { body: { cliente: 'X', agentes: [] } });
  checar('criar-implantacao: sem agentes -> 400', [criarSemAgente.code, criarSemAgente.corpo.code], [400, 'agentes_invalidos']);
  escritas.length = 0;
  const criarOk = await chamarAcao(GESTAO, 'POST', 'criar-implantacao', {
    body: { cliente: 'Cliente Novo', contexto: 'Escopo fechado', agentes: [{ nome: 'Agente 1', frente: 'Cobranca' }] },
  });
  checar('criar-implantacao: 200', [criarOk.code, criarOk.corpo.ok], [200, true]);
  checar('  cria 1 projeto + 1 subtask', escritas.filter((e) => e.alvo === 'criar').length, 2);

  // atualizar-implantacao: dono grava o estado, etapa invalida 400, outro csm 403
  escritas.length = 0;
  const atualizarOk = await chamarAcao(GIAN, 'POST', 'atualizar-implantacao', {
    body: { id: 'tProjeto', etapaAtual: 'construcao', prioridade: ['tAgente1'], agenteAtualId: 'tAgente1', concluidos: [] },
  });
  checar('atualizar-implantacao: 200', [atualizarOk.code, atualizarOk.corpo.ok], [200, true]);
  const escritaProjeto = escritas.find((e) => e.alvo === 'projeto');
  checar('  grava etapaAtual no bloco de estado', escritaProjeto.body.markdown_description.includes('"etapaAtual":"construcao"'), true);
  const atualizarEtapaInvalida = await chamarAcao(GIAN, 'POST', 'atualizar-implantacao', { body: { id: 'tProjeto', etapaAtual: 'xyz' } });
  checar('atualizar-implantacao: etapa invalida -> 400', [atualizarEtapaInvalida.code, atualizarEtapaInvalida.corpo.code], [400, 'etapa_invalida']);
  const atualizarOutroCsm = await chamarAcao(PATRICIA, 'POST', 'atualizar-implantacao', {
    body: { id: 'tProjeto', etapaAtual: 'testes', prioridade: [], concluidos: [] },
  });
  checar('atualizar-implantacao: csm de outra carteira -> 403', [atualizarOutroCsm.code, atualizarOutroCsm.corpo.code], [403, 'fora_da_carteira']);

  // atualizar-agente: posse resolvida pelo PROJETO PAI, preserva a estrutura ja salva
  escritas.length = 0;
  const atualizarAgenteOk = await chamarAcao(GIAN, 'POST', 'atualizar-agente', {
    body: { taskId: 'tAgente1', buildChecks: { passo1: true }, status: 'in progress' },
  });
  checar('atualizar-agente: 200', [atualizarAgenteOk.code, atualizarAgenteOk.corpo.ok], [200, true]);
  const escritaAgente = escritas.find((e) => e.alvo === 'agente');
  checar('  grava buildChecks', escritaAgente.body.markdown_description.includes('"passo1":true'), true);
  checar('  preserva a estrutura ja salva', escritaAgente.body.markdown_description.includes('"frente":"Cobranca"'), true);
  checar('  grava status', escritaAgente.body.status, 'in progress');
  const atualizarAgenteOutroCsm = await chamarAcao(PATRICIA, 'POST', 'atualizar-agente', { body: { taskId: 'tAgente1', buildChecks: {} } });
  checar('atualizar-agente: posse pelo pai, csm errado -> 403', [atualizarAgenteOutroCsm.code, atualizarAgenteOutroCsm.corpo.code], [403, 'fora_da_carteira']);

  // comentar-implantacao: consulta nao pode, texto vazio 400, dono posta
  const comentarConsulta = await chamarAcao(CONSULTA, 'POST', 'comentar-implantacao', { body: { taskId: 'tAgente1', texto: 'oi' } });
  checar('comentar-implantacao: consulta -> 403', [comentarConsulta.code, comentarConsulta.corpo.code], [403, 'somente_leitura']);
  const comentarVazio = await chamarAcao(GIAN, 'POST', 'comentar-implantacao', { body: { taskId: 'tAgente1', texto: '   ' } });
  checar('comentar-implantacao: texto vazio -> 400', [comentarVazio.code, comentarVazio.corpo.code], [400, 'texto_invalido']);
  escritas.length = 0;
  const comentarOk = await chamarAcao(GIAN, 'POST', 'comentar-implantacao', { body: { taskId: 'tAgente1', texto: 'Alinhamento feito.' } });
  checar('comentar-implantacao: 200', [comentarOk.code, comentarOk.corpo.ok], [200, true]);
  checar('  posta no ClickUp', escritas.some((e) => e.alvo === 'comentario'), true);

  // criar-implantacao: ISM (projeto e agente) saneado contra a allowlist ISM_OPCOES
  escritas.length = 0;
  const criarComIsm = await chamarAcao(GESTAO, 'POST', 'criar-implantacao', {
    body: {
      cliente: 'Cliente ISM', contexto: '',
      ismProjeto: [48933858, 999999],
      agentes: [{ nome: 'Agente ISM', ism: [118125102, 'invalido'] }],
    },
  });
  checar('criar-implantacao com ISM: 200', [criarComIsm.code, criarComIsm.corpo.ok], [200, true]);
  const criarBodies = escritas.filter((e) => e.alvo === 'criar').map((e) => e.body);
  checar('  ISM do projeto saneado (id invalido descartado)', criarBodies[0].assignees, [48933858]);
  checar('  ISM do agente saneado (id invalido descartado)', criarBodies[1].assignees, [118125102]);

  // atualizar-agente: validacao/diagnostico/prereqChecks/estrutura/ism, tudo mesclado no mesmo bloco
  escritas.length = 0;
  const atualizarCompleto = await chamarAcao(GIAN, 'POST', 'atualizar-agente', {
    body: {
      taskId: 'tAgente1',
      estrutura: { nome: 'Guardião X Editado', frente: 'Comercial', canal: 'WhatsApp' },
      diagnostico: { whatsapp_api: { resposta: 'sim', nota: 'confirmado' }, vazia: { resposta: '', nota: '' } },
      prereqChecks: { '0': true },
      validacao: { status: 'validado', motivo: '' },
      ism: [48933858, 'xyz'],
    },
  });
  checar('atualizar-agente completo: 200', [atualizarCompleto.code, atualizarCompleto.corpo.ok], [200, true]);
  const escritaCompleta = escritas.find((e) => e.alvo === 'agente');
  checar('  estrutura editada persistida', escritaCompleta.body.markdown_description.includes('"nome":"Guardião X Editado"'), true);
  checar('  diagnostico persistido (so a pergunta com resposta/nota)', escritaCompleta.body.markdown_description.includes('"whatsapp_api":{"resposta":"sim","nota":"confirmado"}'), true);
  checar('  diagnostico descarta pergunta vazia', escritaCompleta.body.markdown_description.includes('"vazia"'), false);
  checar('  prereqChecks persistido', escritaCompleta.body.markdown_description.includes('"prereqChecks":{"0":true}'), true);
  checar('  validacao persistida', escritaCompleta.body.markdown_description.includes('"validacao":{"status":"validado","motivo":""}'), true);
  checar('  ISM saneado na atualizacao do agente', escritaCompleta.body.assignees, [48933858]);

  // listar-comentarios: dono le, outro csm 403, taskId invalido 400
  const comentariosGian = await chamarAcao(GIAN, 'GET', 'listar-comentarios', { query: { taskId: 'tAgente1' } });
  checar('listar-comentarios: 200 com o comentario mockado', [comentariosGian.code, comentariosGian.corpo.comentarios.length], [200, 1]);
  checar('  autor traduzido', comentariosGian.corpo.comentarios[0].autor, 'Gian Luca');
  const comentariosPatricia = await chamarAcao(PATRICIA, 'GET', 'listar-comentarios', { query: { taskId: 'tAgente1' } });
  checar('listar-comentarios: csm de outra carteira -> 403', [comentariosPatricia.code, comentariosPatricia.corpo.code], [403, 'fora_da_carteira']);
  const comentariosInvalido = await chamarAcao(GESTAO, 'GET', 'listar-comentarios', { query: { taskId: 'zzz!!' } });
  checar('listar-comentarios: taskId invalido -> 400', [comentariosInvalido.code, comentariosInvalido.corpo.code], [400, 'task_invalida']);

  const invalida = await chamarAcao(GESTAO, 'GET', 'nao-existe');
  checar('acao invalida -> 400', [invalida.code, invalida.corpo.code], [400, 'acao_invalida']);

  globalThis.fetch = fetchOriginal;
}

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) {
  console.error(`${falhas} FALHA(S)`);
  process.exit(1);
}
console.log('TUDO PASSOU — nenhum caminho de falha derruba a funcao');
