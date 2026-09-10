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
const SENHA_ISM_BRUNO = 'senha-de-teste-ism-bruno';

function hashScrypt(senha) {
  const N = 16384, r = 8, p = 1, KEYLEN = 64;
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(senha, salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

process.env.SESSION_SECRET = 'T'.repeat(48);
process.env.AUTH_GESTAO = hashScrypt(SENHA_GESTAO);
process.env.AUTH_CONSULTA = hashScrypt(SENHA_CONSULTA);
process.env.AUTH_ISM_BRUNO = hashScrypt(SENHA_ISM_BRUNO);
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
  export const LISTA_RESERVAS_AGENDA = '901329017742';
  export async function criarReserva() { return { id: 'stub-reserva' }; }
  export async function listarReservas() { return []; }
  export async function excluirTask() { return {}; }
  export function projetoDaDescricaoReserva() { return ''; }
  export function linkDaDescricaoReserva() { return ''; }
  export function googleEventIdDaDescricaoReserva() { return ''; }
  export function soDigitos(v) { return String(v || '').replace(/\\D/g, ''); }
  export function cnpjDoAgendamentoGoogle() { return null; }
  export async function obterTokenGoogle() { return null; }
  export async function listarTokensGoogle() { return []; }
`;
const clickupLibUrl = dataUrl(stubClickup);

// Stub padrao do modulo Google: nenhuma acao chega a bater na rede real. Como
// obterTokenGoogle acima sempre devolve null, o ramo de integracao do Google em
// criarReservaAcao nunca chama nada disto — existe so pra satisfazer o import.
const stubGoogle = `
  export class ErroGoogle extends Error { constructor(s){ super('g'); this.status = s; } }
  export class ErroConfigGoogle extends Error {}
  export function urlAutorizacaoGoogle() { return 'https://accounts.google.com/o/oauth2/v2/auth?stub=1'; }
  export async function trocarCodigoPorToken() { return { access_token: 'stub', refresh_token: 'stub' }; }
  export async function renovarAccessToken() { return 'stub-access-token'; }
  export async function consultarFreeBusy() { return null; }
  export async function criarEventoComMeet() { return null; }
  export async function listarEventos() { return []; }
`;
const googleLibUrl = dataUrl(stubGoogle);

// Stub padrao do modulo Umbler: nenhuma acao existente chama isto (so
// iniciar-conversa-umbler usa) — existe so pra satisfazer o import.
const stubUmbler = `
  export class ErroUmbler extends Error { constructor(s){ super('u'); this.status = s; } }
  export class ErroConfigUmbler extends Error {}
  export function telefoneParaE164() { return null; }
  export async function garantirContato() { return 'stub-contato'; }
  export async function garantirConversa() { return { id: 'stub-chat', criadaAgora: true, setor: null }; }
  export async function enviarMensagem() { return 'stub-mensagem'; }
`;
const umblerLibUrl = dataUrl(stubUmbler);

const carregar = (arquivo) =>
  import(
    dataUrl(
      ler(arquivo)
        .replace("'./_lib/http.js'", `'${httpUrl}'`)
        .replace("'./_lib/auth.js'", `'${authUrl}'`)
        .replace("'./_lib/clickup.js'", `'${clickupLibUrl}'`)
        .replace("'./_lib/google.js'", `'${googleLibUrl}'`)
        .replace("'./_lib/umbler.js'", `'${umblerLibUrl}'`)
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

/** Como carregar(), mas com o _lib/clickup.js REAL em vez do stub. `libGoogleUrl`
 * opcional troca tambem o _lib/google.js (default: mesmo stub de carregar()). */
const carregarCom = (arquivo, libClickupUrl, libGoogleUrl = googleLibUrl, libUmblerUrl = umblerLibUrl) =>
  import(
    dataUrl(
      ler(arquivo)
        .replace("'./_lib/http.js'", `'${httpUrl}'`)
        .replace("'./_lib/auth.js'", `'${authUrl}'`)
        .replace("'./_lib/clickup.js'", `'${libClickupUrl}'`)
        .replace("'./_lib/google.js'", `'${libGoogleUrl}'`)
        .replace("'./_lib/umbler.js'", `'${libUmblerUrl}'`)
    )
  ).then((m) => m.default);

/** data: URL do _lib/google.js real, UNICA por variante (mesmo motivo de libClickupUnica). */
const libGoogleUnica = (tag) => dataUrl(ler('api/_lib/google.js') + `\n// variante:${tag}\n`);
/** data: URL do _lib/umbler.js real, UNICA por variante (mesmo motivo de libClickupUnica). */
const libUmblerUnica = (tag) => dataUrl(ler('api/_lib/umbler.js') + `\n// variante:${tag}\n`);

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
  // 5 + os 3 campos numericos da campanha (vendidos/cortesia/valor vendido) + os 2
  // do historico Camp 2025 (status/observacao).
  checar('total de campos na allowlist continua enumeravel', Object.keys(lib.CAMPOS_ESCRITA).length, 10);

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

  let statusProjetoAtual = 'pendente';
  const taskProjeto = () => ({
    id: 'tProjeto', name: 'Cliente X — Implantação Waipe', list: { id: LISTA },
    status: { status: statusProjetoAtual }, parent: null, subtasks: [{ id: 'tAgente1' }],
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
  const DADOS_CLIENTE_TESTE = { idNucleo: '123', cnpj: '00.000.000/0001-00', email: 'contato@cliente.com.br', telefone: '(43) 90000-0000' };
  const criarSemAgente = await chamarAcao(GESTAO, 'POST', 'criar-implantacao', { body: { cliente: 'X', agentes: [], ...DADOS_CLIENTE_TESTE } });
  checar('criar-implantacao: sem agentes -> 400', [criarSemAgente.code, criarSemAgente.corpo.code], [400, 'agentes_invalidos']);
  const criarSemDadosCliente = await chamarAcao(GESTAO, 'POST', 'criar-implantacao', { body: { cliente: 'X', agentes: [{ nome: 'A' }] } });
  checar('criar-implantacao: sem ID Nucleo/CNPJ/e-mail/telefone -> 400', [criarSemDadosCliente.code, criarSemDadosCliente.corpo.code], [400, 'dados_cliente_incompletos']);
  escritas.length = 0;
  const criarOk = await chamarAcao(GESTAO, 'POST', 'criar-implantacao', {
    body: { cliente: 'Cliente Novo', contexto: 'Escopo fechado', agentes: [{ nome: 'Agente 1', frente: 'Cobranca' }], ...DADOS_CLIENTE_TESTE },
  });
  checar('criar-implantacao: 200', [criarOk.code, criarOk.corpo.ok], [200, true]);
  checar('  cria 1 projeto + 1 subtask', escritas.filter((e) => e.alvo === 'criar').length, 2);
  const criarBody = escritas.find((e) => e.alvo === 'criar')?.body;
  checar('  grava idNucleo/cnpj/email/telefone no bloco de estado', criarBody.markdown_description.includes('"idNucleo":"123"') && criarBody.markdown_description.includes('"cnpj":"00.000.000/0001-00"'), true);

  // atualizar-implantacao: dono grava o estado, etapa invalida 400, outro csm 403
  escritas.length = 0;
  const atualizarOk = await chamarAcao(GIAN, 'POST', 'atualizar-implantacao', {
    body: { id: 'tProjeto', etapaAtual: 'construcao', prioridade: ['tAgente1'], agenteAtualId: 'tAgente1', concluidos: [] },
  });
  checar('atualizar-implantacao: 200', [atualizarOk.code, atualizarOk.corpo.ok], [200, true]);
  const escritaProjeto = escritas.find((e) => e.alvo === 'projeto');
  checar('  grava etapaAtual no bloco de estado', escritaProjeto.body.markdown_description.includes('"etapaAtual":"construcao"'), true);
  checar('  projeto "pendente" sobe pra "in progress" sozinho (1a interacao)', escritaProjeto.body.status, 'in progress');
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
  checar('  grava status (da subtask, explicito no corpo)', escritaAgente.body.status, 'in progress');
  const escritaProjetoViaAgente = escritas.find((e) => e.alvo === 'projeto');
  checar('  mexer no agente TAMBEM sobe o PROJETO pai pra "in progress"', escritaProjetoViaAgente?.body.status, 'in progress');
  const atualizarAgenteOutroCsm = await chamarAcao(PATRICIA, 'POST', 'atualizar-agente', { body: { taskId: 'tAgente1', buildChecks: {} } });
  checar('atualizar-agente: posse pelo pai, csm errado -> 403', [atualizarAgenteOutroCsm.code, atualizarAgenteOutroCsm.corpo.code], [403, 'fora_da_carteira']);

  // projeto ja fora de "pendente" (ex: concluído manualmente, ou ja tinha
  // subido antes): mexer em mais um agente NAO reabre/sobrescreve o status.
  statusProjetoAtual = 'concluído';
  escritas.length = 0;
  const atualizarAgenteProjetoConcluido = await chamarAcao(GIAN, 'POST', 'atualizar-agente', { body: { taskId: 'tAgente1', buildChecks: { passo2: true } } });
  checar('atualizar-agente com projeto concluído: 200', [atualizarAgenteProjetoConcluido.code, atualizarAgenteProjetoConcluido.corpo.ok], [200, true]);
  checar('  NAO reabre o projeto pra "in progress"', escritas.some((e) => e.alvo === 'projeto'), false);
  statusProjetoAtual = 'pendente';

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
      ...DADOS_CLIENTE_TESTE,
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

console.log('\n[35] api/ia.js — analisar-transcricao: sessao, saneamento e configuracao ausente');
{
  const ia = await carregar('api/ia.js');
  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'Gestao' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'Consulta' };

  const chamarIa = async (perfil, body) => {
    const r = res();
    await ia({
      method: 'POST',
      headers: cabecalhos(perfil ? { cookie: cookieDe(perfil) } : {}),
      query: { action: 'analisar-transcricao' },
      body,
    }, r);
    return r;
  };

  // Sem ANTHROPIC_API_KEY: 500 nao_configurado, nao derruba.
  delete process.env.ANTHROPIC_API_KEY;
  const semChave = await chamarIa(GESTAO, { transcricao: 'x'.repeat(50) });
  checar('sem ANTHROPIC_API_KEY: nao derruba', semChave.corpo != null, true);
  checar('sem ANTHROPIC_API_KEY: 500 nao_configurado', [semChave.code, semChave.corpo.code], [500, 'nao_configurado']);

  // Gates de sessao/perfil, antes de qualquer chamada externa.
  const semSessao = await chamarIa(null, { transcricao: 'x'.repeat(50) });
  checar('sem cookie: 401', semSessao.code, 401);
  const comoConsulta = await chamarIa(CONSULTA, { transcricao: 'x'.repeat(50) });
  checar('consulta: 403 somente_leitura', [comoConsulta.code, comoConsulta.corpo.code], [403, 'somente_leitura']);

  // Corpo invalido e transcricao curta demais — com a chave presente, pra passar do gate de config.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-teste';
  const corpoVazio = await chamarIa(GESTAO, '');
  checar('corpo vazio: 400 corpo_invalido', [corpoVazio.code, corpoVazio.corpo.code], [400, 'corpo_invalido']);
  const transcricaoCurta = await chamarIa(GESTAO, { transcricao: 'oi' });
  checar('transcricao curta: 400 transcricao_invalida', [transcricaoCurta.code, transcricaoCurta.corpo.code], [400, 'transcricao_invalida']);

  // Chamada real (mockada) — saneamento: produto fora da allowlist descartado, campos truncados.
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url) => {
    checar('  chama a Claude API', String(url), 'https://api.anthropic.com/v1/messages');
    return {
      ok: true, status: 200,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          cliente: 'Cliente Teste',
          segmento: 'Varejo',
          dores: 'Inadimplência alta.',
          recomendacoes: [
            { produto: 'Gestor', planoSugerido: 'Avançado', motivo: 'Precisa de multi-filial.', atencao: 'Verificar disponibilidade do Módulo Indústria.' },
            { produto: 'Produto Inventado', planoSugerido: 'X', motivo: 'Nao deveria sobreviver.' },
            { produto: 'BIME APP', planoSugerido: '', motivo: 'Vendedor externo lançando pedido.', quantidadeSugerida: 4 },
            { produto: 'BIME APP', planoSugerido: '', motivo: 'Quantidade fora de faixa.', quantidadeSugerida: 9999 },
          ],
        }) }],
      }),
    };
  };
  const ok = await chamarIa(GESTAO, { transcricao: 'x'.repeat(50) });
  checar('chamada ok: 200', ok.code, 200);
  checar('  cliente/segmento/dores repassados', [ok.corpo.cliente, ok.corpo.segmento, ok.corpo.dores], ['Cliente Teste', 'Varejo', 'Inadimplência alta.']);
  checar('  3 recomendacoes sobrevivem (produto invalido descartado)', ok.corpo.recomendacoes.length, 3);
  checar('  Gestor mantem o campo atencao', ok.corpo.recomendacoes[0].atencao, 'Verificar disponibilidade do Módulo Indústria.');
  checar('  BIME APP sem atencao (campo omitido)', Object.hasOwn(ok.corpo.recomendacoes[1], 'atencao'), false);
  checar('  quantidadeSugerida valida sobrevive', ok.corpo.recomendacoes[1].quantidadeSugerida, 4);
  checar('  quantidadeSugerida fora de faixa (1-500) e omitida', Object.hasOwn(ok.corpo.recomendacoes[2], 'quantidadeSugerida'), false);
  checar('  Gestor sem quantidadeSugerida (campo omitido)', Object.hasOwn(ok.corpo.recomendacoes[0], 'quantidadeSugerida'), false);
  globalThis.fetch = fetchOriginal;

  // waipeDiagnostico: campos validos passam, campos invalidos/fora de faixa caem no padrao seguro.
  const fetchOriginal2 = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        cliente: 'X', segmento: 'Y', dores: 'Z',
        waipeDiagnostico: { usuarios: 7, empresas: 9999, governanca: 'sim', auditoria: 'talvez', automacao: 'personalizada', enterprisePorVolume: 'sim' },
        recomendacoes: [],
      }) }],
    }),
  });
  const comWd = await chamarIa(GESTAO, { transcricao: 'x'.repeat(50) });
  checar('waipeDiagnostico: usuarios valido preservado', comWd.corpo.waipeDiagnostico.usuarios, 7);
  checar('waipeDiagnostico: empresas fora da faixa (1-500) cai no padrao', comWd.corpo.waipeDiagnostico.empresas, 1);
  checar('waipeDiagnostico: governanca valida preservada', comWd.corpo.waipeDiagnostico.governanca, 'sim');
  checar('waipeDiagnostico: auditoria invalida cai no padrao "nao"', comWd.corpo.waipeDiagnostico.auditoria, 'nao');
  checar('waipeDiagnostico: automacao valida preservada', comWd.corpo.waipeDiagnostico.automacao, 'personalizada');
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ cliente: 'X', recomendacoes: [] }) }] }),
  });
  const semWd = await chamarIa(GESTAO, { transcricao: 'x'.repeat(50) });
  checar('waipeDiagnostico ausente: usa o padrao seguro inteiro', semWd.corpo.waipeDiagnostico, { usuarios: 1, empresas: 1, governanca: 'nao', auditoria: 'nao', automacao: 'pronta', enterprisePorVolume: 'nao' });
  globalThis.fetch = fetchOriginal2;

  delete process.env.ANTHROPIC_API_KEY;
}

console.log('\n[36] Ponte proposta -> fechamento: salvar-proposta-implantacao e confirmar-fechamento-implantacao');
{
  const fetchOriginal = globalThis.fetch;
  const escritas = [];
  const LISTA = '901328976497';

  const estadoProposta = {
    etapaAtual: 'proposta',
    faseProjetoManual: 'aguardando_cliente',
    agentesPropostos: [{ nome: 'Agente Novo', frente: 'Comercial', entrega: ['Resumo diário'] }],
    outrasSolucoesPropostas: [
      { produto: 'Gestor', planoSugerido: 'Avançado', variante: 'Nuvem', motivo: 'Multi-filial.', observacoes: 'Cliente pediu para zerar a base antes de migrar.', ambienteMuda: false, quantidade: 1, valorTabela: 719, valorManual: 0, pol: 'padrao', descontoPercent: 0, incluir: true },
      { produto: 'BIME APP', planoSugerido: '', variante: null, motivo: 'Recusado pelo cliente.', quantidade: 4, valorTabela: 69.9, valorManual: 0, pol: 'sem', descontoPercent: 0, incluir: false },
      { produto: 'Unique', planoSugerido: 'Plus', variante: null, motivo: 'Troca de plano com migração de ambiente.', ambienteMuda: true, quantidade: 1, valorTabela: 447, valorManual: 0, pol: 'padrao', descontoPercent: 0, incluir: true },
      { produto: 'Treinamento', planoSugerido: '', variante: null, motivo: 'Nunca usou o módulo financeiro.', quantidade: 1, valorTabela: null, valorManual: 0, pol: null, descontoPercent: 0, incluir: true },
    ],
    diagnosticoWaipe: { usuarios: 3, empresas: 1, governanca: 'nao', auditoria: 'nao', automacao: 'pronta', enterprisePorVolume: 'nao', plano: 'Time', valorMensal: 249 },
    idNucleo: '123', cnpj: '00.000.000/0001-00', email: 'contato@cliente.com.br', telefone: '(43) 90000-0000',
  };
  const descProposta = (estado) => `CSM: Gian Luca\n\nContexto de teste.\n\n${JSON.stringify(estado)}`;

  const taskPropostaProjeto = () => ({
    id: 'tProposta', name: 'Cliente Y — Proposta — 01/01/2026', list: { id: LISTA },
    status: { status: 'pendente' }, parent: null, subtasks: [],
    description: descProposta(estadoProposta),
  });
  const taskJaPromovida = () => ({
    id: 'tPromovida', name: 'Cliente Z — Implantação Waipe', list: { id: LISTA },
    status: { status: 'pendente' }, parent: null,
    subtasks: [{ id: 'tSolucao1' }, { id: 'tSolucaoAntiga' }],
    description: descProposta({ etapaAtual: 'escopo', prioridade: [], agenteAtualId: null, concluidos: [], agentesTotal: 1 }),
  });
  const taskSolucaoExistente = () => ({
    id: 'tSolucao1', name: 'Gestor — Avançado', list: { id: LISTA }, parent: 'tPromovida',
    status: { status: 'pendente' },
    description: descProposta({
      tipo: 'solucao', produto: 'Gestor', planoSugerido: 'Avançado', variante: 'Nuvem',
      motivo: 'Multi-filial.', observacoes: 'Zerar a base antes.', quantidade: 1,
      valorTabela: 719, valorManual: 0, descontoPercent: 0,
      checklist: ['Alterar o plano no Núcleo'], checklistChecks: {},
    }),
  });
  // Fechada ANTES da jornada por produto existir (ou com o template ainda
  // nao definido na epoca): checklist ficou gravado como null. Depois que a
  // jornada do BIME APP foi documentada, obter-implantacao precisa recalcular
  // em vez de repetir pra sempre o aviso de "a detalhar".
  const taskSolucaoAntigaSemChecklist = () => ({
    id: 'tSolucaoAntiga', name: 'BIME APP', list: { id: LISTA }, parent: 'tPromovida',
    status: { status: 'pendente' },
    description: descProposta({
      tipo: 'solucao', produto: 'BIME APP', planoSugerido: '', variante: null,
      motivo: '', observacoes: '', quantidade: 1,
      valorTabela: 69.9, valorManual: 0, descontoPercent: 0,
      checklist: null, checklistChecks: {},
    }),
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
    if (metodo === 'PUT' && u.endsWith('/task/tProposta')) {
      escritas.push({ alvo: 'proposta', body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'PUT' && u.endsWith('/task/tSolucao1')) {
      escritas.push({ alvo: 'solucao1', body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'POST' && u.endsWith(`/list/${LISTA}/task`)) {
      escritas.push({ alvo: 'criar', body: JSON.parse(init.body) });
      return ok({ id: 'tSubtaskNova' });
    }
    if (u.includes('/task/tProposta')) return ok(taskPropostaProjeto());
    if (u.includes('/task/tSolucao1')) return ok(taskSolucaoExistente());
    if (u.includes('/task/tSolucaoAntiga')) return ok(taskSolucaoAntigaSemChecklist());
    if (u.includes('/task/tPromovida')) return ok(taskJaPromovida());
    return ok({});
  };

  const libUrl = libClickupUnica('proposta-implantacao');
  const cu = await carregarCom('api/clickup.js', libUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'Gestao' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const PATRICIA = { nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'Consulta' };

  const chamarAcao = async (perfil, action, body) => {
    const r = res();
    await cu({ method: 'POST', headers: cabecalhos({ cookie: cookieDe(perfil) }), query: { action }, body }, r);
    return r;
  };

  // salvar-proposta-implantacao: consulta nao pode, cliente ausente 400, gestao cria
  const salvarConsulta = await chamarAcao(CONSULTA, 'salvar-proposta-implantacao', { cliente: 'X' });
  checar('salvar-proposta: consulta -> 403', [salvarConsulta.code, salvarConsulta.corpo.code], [403, 'somente_leitura']);
  const salvarSemCliente = await chamarAcao(GESTAO, 'salvar-proposta-implantacao', { cliente: '' });
  checar('salvar-proposta: sem cliente -> 400', [salvarSemCliente.code, salvarSemCliente.corpo.code], [400, 'cliente_invalido']);

  escritas.length = 0;
  const salvarNovo = await chamarAcao(GESTAO, 'salvar-proposta-implantacao', {
    cliente: 'Cliente Y', contexto: 'Consultoria de ontem', csm: 'Ana Paula Souza',
    agentesPropostos: [{ nome: 'Agente Novo', frente: 'Comercial', entrega: ['Resumo diário'] }],
    outrasSolucoesPropostas: estadoProposta.outrasSolucoesPropostas,
    diagnosticoWaipe: estadoProposta.diagnosticoWaipe,
  });
  checar('salvar-proposta: 200 cria task nova', [salvarNovo.code, salvarNovo.corpo.ok], [200, true]);
  const criarBody = escritas.find((e) => e.alvo === 'criar')?.body;
  checar('  etapaAtual "proposta" no estado embutido', criarBody.markdown_description.includes('"etapaAtual":"proposta"'), true);
  checar('  agentesPropostos gravado', criarBody.markdown_description.includes('"nome":"Agente Novo"'), true);
  checar('  outrasSolucoesPropostas gravado (produto invalido seria descartado, aqui os 2 sao validos)', criarBody.markdown_description.includes('"produto":"BIME APP"'), true);
  checar('  CSM do formulario prevalece sobre quem esta logado', criarBody.markdown_description.includes('**CSM:** Ana Paula Souza'), true);

  // salvar-proposta-implantacao: taskIdExistente ATUALIZA a mesma task (nao cria outra)
  escritas.length = 0;
  const salvarExistente = await chamarAcao(GIAN, 'salvar-proposta-implantacao', {
    cliente: 'Cliente Y', contexto: 'Consultoria de ontem, ajustada',
    taskIdExistente: 'tProposta',
    outrasSolucoesPropostas: [{ ...estadoProposta.outrasSolucoesPropostas[0], incluir: false }],
  });
  checar('salvar-proposta: 200 atualiza task existente', [salvarExistente.code, salvarExistente.corpo.ok, salvarExistente.corpo.id], [200, true, 'tProposta']);
  checar('  nao cria task nova', escritas.filter((e) => e.alvo === 'criar').length, 0);
  checar('  atualiza a task existente', escritas.some((e) => e.alvo === 'proposta'), true);
  const salvarOutroCsm = await chamarAcao(PATRICIA, 'salvar-proposta-implantacao', { cliente: 'Cliente Y', taskIdExistente: 'tProposta' });
  checar('salvar-proposta: csm de outra carteira -> 403', [salvarOutroCsm.code, salvarOutroCsm.corpo.code], [403, 'fora_da_carteira']);
  const salvarJaPromovida = await chamarAcao(GIAN, 'salvar-proposta-implantacao', { cliente: 'Cliente Z', taskIdExistente: 'tPromovida' });
  checar('salvar-proposta: ja promovida -> 409', [salvarJaPromovida.code, salvarJaPromovida.corpo.code], [409, 'ja_promovida']);

  // confirmar-fechamento-implantacao: ID Nucleo/CNPJ/e-mail/telefone viram
  // obrigatorios so aqui (na proposta em si, salvar-proposta-implantacao ja
  // testado acima aceita sem eles).
  const cnpjOriginal = estadoProposta.cnpj;
  delete estadoProposta.cnpj;
  const confirmarSemDadosCliente = await chamarAcao(GIAN, 'confirmar-fechamento-implantacao', { id: 'tProposta' });
  checar('confirmar-fechamento: sem CNPJ -> 400', [confirmarSemDadosCliente.code, confirmarSemDadosCliente.corpo.code], [400, 'dados_cliente_incompletos']);
  estadoProposta.cnpj = cnpjOriginal;

  // confirmar-fechamento-implantacao: promove so os itens incluidos, avanca etapa,
  // resolve a jornada (checklist) por produto — null so quando Gestor/Unique envolve troca de ambiente.
  escritas.length = 0;
  const confirmarOk = await chamarAcao(GIAN, 'confirmar-fechamento-implantacao', { id: 'tProposta' });
  checar('confirmar-fechamento: 200', [confirmarOk.code, confirmarOk.corpo.ok], [200, true]);
  checar('  cria 1 agente + 3 solucoes incluidas (BIME APP recusado fica de fora)', confirmarOk.corpo.criados, 4);
  const criadas = escritas.filter((e) => e.alvo === 'criar').map((e) => e.body);
  checar('  subtask do agente', criadas.some((c) => c.name === 'Agente Novo'), true);
  checar('  solucao recusada NAO virou subtask', criadas.some((c) => c.name.includes('BIME APP')), false);
  const gestorBody = criadas.find((c) => c.name === 'Gestor — Avançado');
  checar('  Gestor sem troca de ambiente: checklist de 1 passo', gestorBody.markdown_description.includes('"checklist":["Alterar o plano no Núcleo"]'), true);
  checar('  Gestor: observacoes gravada', gestorBody.markdown_description.includes('Cliente pediu para zerar a base'), true);
  const uniqueBody = criadas.find((c) => c.name === 'Unique — Plus');
  checar('  Unique COM troca de ambiente: checklist null (a detalhar)', uniqueBody.markdown_description.includes('"checklist":null'), true);
  const treinoBody = criadas.find((c) => c.name === 'Treinamento');
  checar('  Treinamento: jornada própria', treinoBody.markdown_description.includes('"checklist":["Agendar o treinamento","Confirmar participantes","Realizar o treinamento na data agendada"]'), true);
  const escritaProjeto = escritas.find((e) => e.alvo === 'proposta');
  checar('  projeto avanca pra etapa escopo', escritaProjeto.body.markdown_description.includes('"etapaAtual":"escopo"'), true);
  checar('  idNucleo/cnpj/email/telefone carregados pro projeto promovido', escritaProjeto.body.markdown_description.includes('"idNucleo":"123"') && escritaProjeto.body.markdown_description.includes('"telefone":"(43) 90000-0000"'), true);

  const confirmarOutroCsm = await chamarAcao(PATRICIA, 'confirmar-fechamento-implantacao', { id: 'tProposta' });
  checar('confirmar-fechamento: csm de outra carteira -> 403', [confirmarOutroCsm.code, confirmarOutroCsm.corpo.code], [403, 'fora_da_carteira']);
  const confirmarJaPromovida = await chamarAcao(GIAN, 'confirmar-fechamento-implantacao', { id: 'tPromovida' });
  checar('confirmar-fechamento: ja promovida -> 409', [confirmarJaPromovida.code, confirmarJaPromovida.corpo.code], [409, 'ja_promovida']);
  const confirmarInvalida = await chamarAcao(GESTAO, 'confirmar-fechamento-implantacao', { id: 'zzz!!' });
  checar('confirmar-fechamento: id invalido -> 400', [confirmarInvalida.code, confirmarInvalida.corpo.code], [400, 'task_invalida']);

  // atualizar-agente numa subtask tipo "solucao": so o checklistChecks e editavel,
  // o resto do estado (produto/plano/valor/checklist/observacoes) e preservado.
  escritas.length = 0;
  const marcarChecklist = await chamarAcao(GIAN, 'atualizar-agente', { taskId: 'tSolucao1', checklistChecks: { 0: true } });
  checar('atualizar-agente (solucao): 200', [marcarChecklist.code, marcarChecklist.corpo.ok], [200, true]);
  const escritaSolucao = escritas.find((e) => e.alvo === 'solucao1');
  checar('  checklistChecks gravado', escritaSolucao.body.markdown_description.includes('"checklistChecks":{"0":true}'), true);
  checar('  checklist (jornada) preservado', escritaSolucao.body.markdown_description.includes('"checklist":["Alterar o plano no Núcleo"]'), true);
  checar('  observacoes preservada', escritaSolucao.body.markdown_description.includes('Zerar a base antes.'), true);
  checar('  produto preservado', escritaSolucao.body.markdown_description.includes('"produto":"Gestor"'), true);

  // atualizar-agente (solucao): fase tambem e editavel, com o mesmo padrao de preservar o resto
  escritas.length = 0;
  const marcarFase = await chamarAcao(GIAN, 'atualizar-agente', { taskId: 'tSolucao1', fase: 'entregue' });
  checar('atualizar-agente (solucao): fase gravada', [marcarFase.code, escritas.find((e) => e.alvo === 'solucao1')?.body.markdown_description.includes('"fase":"entregue"')], [200, true]);

  // atualizar-implantacao: camada1Checks (ativacao Waipe) e gravado e preserva o historico da proposta
  escritas.length = 0;
  const salvarCamada1 = await chamarAcao(GIAN, 'atualizar-implantacao', {
    id: 'tProposta', etapaAtual: 'escopo', prioridade: [], concluidos: [], camada1Checks: { 0: true, 1: false },
  });
  checar('atualizar-implantacao: camada1Checks 200', [salvarCamada1.code, salvarCamada1.corpo.ok], [200, true]);
  const escritaCamada1 = escritas.find((e) => e.alvo === 'proposta');
  checar('  camada1Checks gravado', escritaCamada1.body.markdown_description.includes('"camada1Checks":{"0":true,"1":false}'), true);
  checar('  historico da proposta preservado (nao apaga agentesPropostos/outrasSolucoesPropostas)', escritaCamada1.body.markdown_description.includes('"nome":"Agente Novo"'), true);
  checar('  faseProjetoManual preservado quando o campo nao vem no corpo', escritaCamada1.body.markdown_description.includes('"faseProjetoManual":"aguardando_cliente"'), true);

  // atualizar-implantacao: faseProjetoManual e gravavel, e null explicito volta pro automatico
  escritas.length = 0;
  const setarFaseManual = await chamarAcao(GIAN, 'atualizar-implantacao', {
    id: 'tProposta', etapaAtual: 'escopo', prioridade: [], concluidos: [], faseProjetoManual: 'entregue',
  });
  checar('atualizar-implantacao: faseProjetoManual definido', [setarFaseManual.code, escritas.find((e) => e.alvo === 'proposta')?.body.markdown_description.includes('"faseProjetoManual":"entregue"')], [200, true]);

  escritas.length = 0;
  const limparFaseManual = await chamarAcao(GIAN, 'atualizar-implantacao', {
    id: 'tProposta', etapaAtual: 'escopo', prioridade: [], concluidos: [], faseProjetoManual: null,
  });
  checar('atualizar-implantacao: faseProjetoManual null volta pro automatico', [limparFaseManual.code, escritas.find((e) => e.alvo === 'proposta')?.body.markdown_description.includes('"faseProjetoManual":null')], [200, true]);

  // obter-implantacao: solucao fechada ANTES da jornada por produto existir
  // ficou com checklist:null gravado — precisa recalcular pelo template
  // atual (BIME APP ja tem jornada definida), nao repetir o aviso "a detalhar".
  const obterPromovida = await (async () => {
    const r = res();
    await cu({ method: 'GET', headers: cabecalhos({ cookie: cookieDe(GIAN) }), query: { action: 'obter-implantacao', id: 'tPromovida' } }, r);
    return r;
  })();
  const itemAntigo = obterPromovida.corpo.agentes.find((a) => a.id === 'tSolucaoAntiga');
  checar('obter-implantacao: 200 com as 2 solucoes', [obterPromovida.code, obterPromovida.corpo.agentes.length], [200, 2]);
  checar('  BIME APP sem checklist gravado recalcula pelo template atual', itemAntigo?.checklist, ['Ativar usuários no workspace do cliente', 'Enviar e-mail com instruções de uso', 'Finalizar']);
  checar('  item sem fase gravada default pra "nao_iniciado"', itemAntigo?.fase, 'nao_iniciado');
  checar('  projeto sem faseProjetoManual e sem itens entregues deriva "nao_iniciado"', [obterPromovida.corpo.projeto.faseProjetoManual, obterPromovida.corpo.projeto.faseProjetoDerivada], [null, 'nao_iniciado']);
  checar('  sem agentes Waipe reais, faseWaipe e null (nao entra na derivacao)', obterPromovida.corpo.projeto.faseWaipe, null);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[37] Reservas de agenda — conflito de horario, ownership e link do Meet colado depois');
{
  const fetchOriginal = globalThis.fetch;
  const escritas = [];
  const LISTA_RESERVAS = '901329017742';
  const BRUNO = 118125102;
  const ERICA = 48933858;
  const INICIO = Date.UTC(2026, 8, 15, 13, 0); // 15/09/2026 13:00 UTC
  const UMA_HORA = 60 * 60 * 1000;

  const reservaBruno = () => ({
    id: 'tReservaBruno', name: 'Camada 1 — Cliente X', list: { id: LISTA_RESERVAS },
    assignees: [{ id: BRUNO }], start_date: String(INICIO), due_date: String(INICIO + UMA_HORA),
    description: '**Projeto:** tProjetoX',
  });
  const reservaForaDaLista = () => ({
    id: 'tOutraLista', name: 'Task de outra lista', list: { id: '999' }, assignees: [],
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
    if (metodo === 'POST' && u.endsWith(`/list/${LISTA_RESERVAS}/task`)) {
      escritas.push({ alvo: 'criar', body: JSON.parse(init.body) });
      return ok({ id: 'tNovaReserva' });
    }
    if (u.includes(`/list/${LISTA_RESERVAS}/task?`)) return ok({ tasks: [reservaBruno()], last_page: true });
    if (metodo === 'PUT' && u.endsWith('/task/tReservaBruno')) {
      escritas.push({ alvo: 'atualizar', body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'DELETE' && u.endsWith('/task/tReservaBruno')) {
      escritas.push({ alvo: 'cancelar' });
      return ok({});
    }
    if (u.includes('/task/tReservaBruno')) return ok(reservaBruno());
    if (u.includes('/task/tOutraLista')) return ok(reservaForaDaLista());
    return ok({});
  };

  const libUrl = libClickupUnica('reservas');
  const cu = await carregarCom('api/clickup.js', libUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'Gestao' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'Consulta' };

  const chamarAcao = async (perfil, method, action, body) => {
    const r = res();
    const headers = cabecalhos({ cookie: cookieDe(perfil) });
    await cu({ method, headers, query: { action }, body: body ? JSON.stringify(body) : undefined }, r);
    return r;
  };

  const criarConsulta = await chamarAcao(CONSULTA, 'POST', 'criar-reserva', { titulo: 'X', ismId: BRUNO, inicio: INICIO, fim: INICIO + UMA_HORA });
  checar('criar-reserva: consulta -> 403', [criarConsulta.code, criarConsulta.corpo.code], [403, 'somente_leitura']);

  const semTitulo = await chamarAcao(GESTAO, 'POST', 'criar-reserva', { ismId: BRUNO, inicio: INICIO, fim: INICIO + UMA_HORA });
  checar('criar-reserva: sem titulo -> 400', [semTitulo.code, semTitulo.corpo.code], [400, 'titulo_invalido']);

  const ismInvalido = await chamarAcao(GESTAO, 'POST', 'criar-reserva', { titulo: 'X', ismId: 999, inicio: INICIO, fim: INICIO + UMA_HORA });
  checar('criar-reserva: ism invalido -> 400', [ismInvalido.code, ismInvalido.corpo.code], [400, 'ism_invalido']);

  const fimAntesDoInicio = await chamarAcao(GESTAO, 'POST', 'criar-reserva', { titulo: 'X', ismId: ERICA, inicio: INICIO, fim: INICIO - 1000 });
  checar('criar-reserva: fim antes do inicio -> 400', [fimAntesDoInicio.code, fimAntesDoInicio.corpo.code], [400, 'horario_invalido']);

  const duracaoDemais = await chamarAcao(GESTAO, 'POST', 'criar-reserva', { titulo: 'X', ismId: ERICA, inicio: INICIO, fim: INICIO + 25 * UMA_HORA });
  checar('criar-reserva: duracao > 24h -> 400', [duracaoDemais.code, duracaoDemais.corpo.code], [400, 'horario_invalido']);

  // Conflito: mesmo ISM (Bruno), horario se sobrepondo ao que ja existe (13h-14h)
  const conflito = await chamarAcao(GESTAO, 'POST', 'criar-reserva', { titulo: 'Treinamento', ismId: BRUNO, inicio: INICIO + 30 * 60 * 1000, fim: INICIO + 90 * 60 * 1000 });
  checar('criar-reserva: conflito de horario -> 409', [conflito.code, conflito.corpo.code], [409, 'conflito_horario']);
  checar('  devolve a reserva conflitante', conflito.corpo.conflito?.id, 'tReservaBruno');

  // Sem conflito: outro ISM (Erica) no mesmo horario que o Bruno ja tem
  escritas.length = 0;
  const semConflito = await chamarAcao(GESTAO, 'POST', 'criar-reserva', {
    titulo: 'Treinamento Financeiro', ismId: ERICA, inicio: INICIO, fim: INICIO + UMA_HORA, projetoId: 'tProjetoY',
  });
  checar('criar-reserva: 200 sem conflito (outro ISM)', [semConflito.code, semConflito.corpo.ok], [200, true]);
  const criada = escritas.find((e) => e.alvo === 'criar')?.body;
  checar('  start_date_time/due_date_time marcados (sincroniza com hora, nao dia inteiro)', [criada.start_date_time, criada.due_date_time], [true, true]);
  checar('  projeto gravado na descricao', criada.markdown_description.includes('**Projeto:** tProjetoY'), true);

  // listar-reservas: mapeia ismNome/projetoId/linkReuniao a partir da task crua
  const listar = await chamarAcao(GESTAO, 'GET', 'listar-reservas');
  const linha = listar.corpo.reservas?.[0];
  checar('listar-reservas: 200 com ismNome resolvido', [listar.code, linha?.ismNome, linha?.projetoId], [200, 'Bruno Vaz', 'tProjetoX']);

  // atualizar-reserva: cola o link do Meet, preserva o projeto ja gravado
  escritas.length = 0;
  const colarLink = await chamarAcao(GESTAO, 'POST', 'atualizar-reserva', { id: 'tReservaBruno', linkReuniao: 'https://meet.google.com/abc-defg-hij' });
  checar('atualizar-reserva: 200', [colarLink.code, colarLink.corpo.ok], [200, true]);
  const atualizada = escritas.find((e) => e.alvo === 'atualizar')?.body;
  checar('  projeto preservado + link gravado', [atualizada.markdown_description.includes('**Projeto:** tProjetoX'), atualizada.markdown_description.includes('**Link:** https://meet.google.com/abc-defg-hij')], [true, true]);

  const atualizarForaDaLista = await chamarAcao(GESTAO, 'POST', 'atualizar-reserva', { id: 'tOutraLista', linkReuniao: 'x' });
  checar('atualizar-reserva: task de outra lista -> 404', [atualizarForaDaLista.code, atualizarForaDaLista.corpo.code], [404, 'nao_encontrado']);

  // cancelar-reserva: DELETE de verdade (libera o horario), com o mesmo portao de ownership
  escritas.length = 0;
  const cancelar = await chamarAcao(GESTAO, 'POST', 'cancelar-reserva', { id: 'tReservaBruno' });
  checar('cancelar-reserva: 200 e chama DELETE', [cancelar.code, escritas.some((e) => e.alvo === 'cancelar')], [200, true]);

  const cancelarForaDaLista = await chamarAcao(GESTAO, 'POST', 'cancelar-reserva', { id: 'tOutraLista' });
  checar('cancelar-reserva: task de outra lista -> 404', [cancelarForaDaLista.code, cancelarForaDaLista.corpo.code], [404, 'nao_encontrado']);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[38] Google Calendar: state assinado do OAuth (mesmo esquema HMAC da sessao)');
{
  const google = await import(libGoogleUnica('state'));
  process.env.SESSION_SECRET = 'T'.repeat(48);
  process.env.GOOGLE_CLIENT_ID = 'id-teste';
  process.env.GOOGLE_CLIENT_SECRET = 'segredo-teste';
  process.env.GOOGLE_REDIRECT_URI = 'https://exemplo.test/api/google-oauth-callback';

  const estado = google.assinarEstadoGoogle(118125102);
  checar('assina e verifica: ismId volta certo', google.verificarEstadoGoogle(estado)?.ismId, 118125102);
  checar('adulterado: recusado', google.verificarEstadoGoogle(estado.slice(0, -3) + 'aaa'), null);
  checar('lixo: recusado', google.verificarEstadoGoogle('nao-e-um-state'), null);

  // TTL de 10min, mesmo truque de HMAC(iat) manual do teste [19] (sem esperar de verdade)
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const stateComIat = (iat) => {
    const corpo = b64u(JSON.stringify({ ismId: 118125102, iat }));
    return `${corpo}.${b64u(crypto.createHmac('sha256', process.env.SESSION_SECRET).update(corpo).digest())}`;
  };
  const agora = Date.now();
  checar('9min59: valido', google.verificarEstadoGoogle(stateComIat(agora - 9.98 * 60000))?.ismId, 118125102);
  checar('10min01: expirado', google.verificarEstadoGoogle(stateComIat(agora - 10.02 * 60000)), null);

  const url = google.urlAutorizacaoGoogle(118125102);
  checar('urlAutorizacaoGoogle: aponta pro Google, com os 2 escopos e state', [
    url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'),
    url.includes('calendar.events'), url.includes('calendar.freebusy'),
    url.includes('access_type=offline'), url.includes('prompt=consent'),
  ], [true, true, true, true, true]);
}

console.log('\n[39] criar-reserva com ISM conectado ao Google: freebusy real + Meet automatico');
{
  const fetchOriginal = globalThis.fetch;
  const LISTA_RESERVAS = '901329017742';
  const LISTA_TOKENS_GOOGLE = '901329032234';
  const BRUNO = 118125102;
  const ERICA = 48933858;
  const INICIO = Date.UTC(2026, 8, 20, 13, 0);
  const UMA_HORA = 60 * 60 * 1000;

  function ok(corpo) {
    return {
      ok: true, status: 200,
      headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '90'], ['x-ratelimit-reset', '0']]),
      json: async () => corpo, text: async () => '',
    };
  }

  const escritas = [];
  let freeBusyOcupado = false; // alternado entre os dois cenarios abaixo

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const metodo = init?.method || 'GET';
    // ClickUp: lista de reservas — sempre vazia aqui (o foco deste teste e o Google, nao o conflito interno)
    if (u.includes(`/list/${LISTA_RESERVAS}/task?`)) return ok({ tasks: [], last_page: true });
    if (metodo === 'POST' && u.endsWith(`/list/${LISTA_RESERVAS}/task`)) {
      escritas.push({ alvo: 'criar-reserva', body: JSON.parse(init.body) });
      return ok({ id: 'tNovaReservaGoogle' });
    }
    // ClickUp: lista de tokens do Google — so o Bruno tem token salvo
    if (u.includes(`/list/${LISTA_TOKENS_GOOGLE}/task?`)) {
      return ok({
        tasks: [{
          id: 'tTokenBruno', assignees: [],
          description: JSON.stringify({ ismId: BRUNO, refreshToken: 'rt-bruno', conectadoEm: Date.now() }),
        }],
        last_page: true,
      });
    }
    // Google: renovar access_token
    if (u === 'https://oauth2.googleapis.com/token') {
      return ok({ access_token: 'at-bruno', expires_in: 3600 });
    }
    // Google: freebusy — controlado por freeBusyOcupado
    if (u.endsWith('/calendar/v3/freeBusy')) {
      return ok({ calendars: { primary: { busy: freeBusyOcupado ? [{ start: 'x', end: 'y' }] : [] } } });
    }
    // Google: criar evento com Meet
    if (u.includes('/calendar/v3/calendars/primary/events')) {
      return ok({ hangoutLink: 'https://meet.google.com/bruno-teste' });
    }
    return ok({});
  };

  const clickupLibUrl = libClickupUnica('google-reserva');
  const googleLibUrl = libGoogleUnica('google-reserva');
  const cu = await carregarCom('api/clickup.js', clickupLibUrl, googleLibUrl);
  process.env.CLICKUP_API_KEY = 'pk_teste';
  process.env.GOOGLE_CLIENT_ID = 'id-teste';
  process.env.GOOGLE_CLIENT_SECRET = 'segredo-teste';
  process.env.GOOGLE_REDIRECT_URI = 'https://exemplo.test/api/google-oauth-callback';

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'Gestao' };
  const chamarAcao = async (action, body) => {
    const r = res();
    await cu({ method: 'POST', headers: cabecalhos({ cookie: cookieDe(GESTAO) }), query: { action }, body: JSON.stringify(body) }, r);
    return r;
  };

  // Bruno tem Google conectado e a agenda real dele esta OCUPADA nesse horario
  freeBusyOcupado = true;
  const comConflitoGoogle = await chamarAcao('criar-reserva', { titulo: 'Camada 1', ismId: BRUNO, inicio: INICIO, fim: INICIO + UMA_HORA });
  checar('ISM conectado + agenda real ocupada: 409 conflito_horario_google', [comConflitoGoogle.code, comConflitoGoogle.corpo.code], [409, 'conflito_horario_google']);

  // Agora livre: cria o evento de verdade, com Meet automatico
  freeBusyOcupado = false;
  escritas.length = 0;
  const semConflitoGoogle = await chamarAcao('criar-reserva', { titulo: 'Camada 1', ismId: BRUNO, inicio: INICIO, fim: INICIO + UMA_HORA });
  checar('ISM conectado + agenda real livre: 200 com linkReuniao', [semConflitoGoogle.code, semConflitoGoogle.corpo.linkReuniao], [200, 'https://meet.google.com/bruno-teste']);
  const criada = escritas.find((e) => e.alvo === 'criar-reserva')?.body;
  checar('  link do Meet ja vai gravado na descricao (sem passo manual)', criada.markdown_description.includes('**Link:** https://meet.google.com/bruno-teste'), true);

  // Erica NAO tem Google conectado: comportamento identico ao de sempre (sem Meet, sem checar freebusy)
  const semGoogle = await chamarAcao('criar-reserva', { titulo: 'Treinamento', ismId: ERICA, inicio: INICIO, fim: INICIO + UMA_HORA });
  checar('ISM sem Google conectado: 200 sem linkReuniao (fallback identico ao de hoje)', [semGoogle.code, semGoogle.corpo.linkReuniao], [200, null]);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[40] iniciar-conversa-umbler: cria contato + abre conversa no Umbler Talk (sem mandar mensagem)');
{
  const fetchOriginal = globalThis.fetch;
  process.env.CLICKUP_API_KEY = 'pk_teste';
  process.env.UMBLER_API_TOKEN = 'token-teste';
  process.env.UMBLER_ORGANIZATION_ID = 'org-teste';
  process.env.UMBLER_CHANNEL_ID = 'canal-teste';

  const estadoBase = {
    etapaAtual: 'escopo', prioridade: [], concluidos: [], agentesTotal: 0, camada1Checks: {},
    telefone: '(43) 90000-0000',
  };
  let estadoAtual = estadoBase;
  let contatoExistente = null; // null = busca por telefone devolve 404
  let statusCriarContato = 200;
  let statusCriarChat = 200;
  let statusEnviarMensagem = 200;
  let chamadasUmbler = [];
  let chatEventAtUTC = new Date().toISOString(); // recente = chat recem-criado
  let chatSetor = null;

  function respostaJson(status, corpo) {
    return { ok: status >= 200 && status < 300, status, headers: new Map(), json: async () => corpo, text: async () => '' };
  }

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const metodo = init?.method || 'GET';
    if (u.startsWith('https://api.clickup.com/api/v2/task/tProjetoUmbler')) {
      return respostaJson(200, {
        id: 'tProjetoUmbler', name: 'Cliente Umbler', list: { id: '901328976497' }, parent: null,
        description: 'CSM: Gian Luca\n\n' + JSON.stringify(estadoAtual),
      });
    }
    if (u.startsWith('https://app-utalk.umbler.com/api/v1/contacts/phone/')) {
      chamadasUmbler.push({ tipo: 'busca-telefone' });
      if (contatoExistente) return respostaJson(200, contatoExistente);
      return respostaJson(404, { error: 'not found' });
    }
    if (metodo === 'POST' && u === 'https://app-utalk.umbler.com/api/v1/contacts/') {
      chamadasUmbler.push({ tipo: 'criar-contato', body: JSON.parse(init.body) });
      if (statusCriarContato !== 200) return respostaJson(statusCriarContato, { error: 'falhou' });
      return respostaJson(200, { contact: { id: 'contato-novo' }, alreadyExisted: false });
    }
    if (metodo === 'POST' && u === 'https://app-utalk.umbler.com/api/v1/chats/') {
      chamadasUmbler.push({ tipo: 'criar-chat', body: JSON.parse(init.body) });
      if (statusCriarChat !== 200) return respostaJson(statusCriarChat, { error: 'falhou' });
      return respostaJson(200, { id: 'chat-novo', eventAtUTC: chatEventAtUTC, sector: chatSetor ? { name: chatSetor } : null });
    }
    if (metodo === 'POST' && u === 'https://app-utalk.umbler.com/api/v1/messages/') {
      chamadasUmbler.push({ tipo: 'enviar-mensagem', body: JSON.parse(init.body) });
      if (statusEnviarMensagem !== 200) return respostaJson(statusEnviarMensagem, { error: 'falhou' });
      return respostaJson(200, { id: 'mensagem-nova' });
    }
    return respostaJson(200, {});
  };

  const clickupLibUrl = libClickupUnica('umbler');
  const umblerLibUrlReal = libUmblerUnica('umbler');
  const cu = await carregarCom('api/clickup.js', clickupLibUrl, googleLibUrl, umblerLibUrlReal);

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'Gestao' };
  const GIAN = { nivel: 'csm', csm: 'Gian Luca', nome: 'Gian Luca' };
  const PATRICIA = { nivel: 'csm', csm: 'Patricia Carvalho', nome: 'Patricia Carvalho' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'Consulta' };
  const chamarAcao = async (perfil, body) => {
    const r = res();
    await cu({ method: 'POST', headers: cabecalhos({ cookie: cookieDe(perfil) }), query: { action: 'iniciar-conversa-umbler' }, body }, r);
    return r;
  };

  const semPermissao = await chamarAcao(CONSULTA, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: consulta -> 403', [semPermissao.code, semPermissao.corpo.code], [403, 'somente_leitura']);

  const outraCarteira = await chamarAcao(PATRICIA, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: csm de outra carteira -> 403', [outraCarteira.code, outraCarteira.corpo.code], [403, 'fora_da_carteira']);

  const idInvalido = await chamarAcao(GESTAO, { id: 'zzz!!' });
  checar('iniciar-conversa-umbler: id invalido -> 400', [idInvalido.code, idInvalido.corpo.code], [400, 'task_invalida']);

  estadoAtual = { ...estadoBase, telefone: '' };
  const semTelefone = await chamarAcao(GIAN, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: sem telefone cadastrado -> 400', [semTelefone.code, semTelefone.corpo.code], [400, 'telefone_invalido']);

  estadoAtual = estadoBase;
  chamadasUmbler = [];
  contatoExistente = null;
  chatEventAtUTC = new Date().toISOString();
  chatSetor = 'Sucesso do Cliente';
  const criaContatoNovo = await chamarAcao(GIAN, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: 200 cria contato novo + abre conversa', [
    criaContatoNovo.code, criaContatoNovo.corpo.ok, criaContatoNovo.corpo.contactId, criaContatoNovo.corpo.chatId,
  ], [200, true, 'contato-novo', 'chat-novo']);
  checar('  telefone normalizado pro E.164', criaContatoNovo.corpo.telefone, '+5543900000000');
  checar('  chamou criar-contato (nao existia ainda)', chamadasUmbler.some((c) => c.tipo === 'criar-contato'), true);
  checar('  chatNovo: true (eventAtUTC recem-criado)', criaContatoNovo.corpo.chatNovo, true);
  checar('  setor devolvido', criaContatoNovo.corpo.setor, 'Sucesso do Cliente');

  chamadasUmbler = [];
  contatoExistente = { id: 'contato-existente' };
  const reaproveitaContato = await chamarAcao(GIAN, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: 200 reaproveita contato ja existente', [reaproveitaContato.code, reaproveitaContato.corpo.contactId], [200, 'contato-existente']);
  checar('  NAO chama criar-contato de novo', chamadasUmbler.some((c) => c.tipo === 'criar-contato'), false);

  // Conversa ja existia de antes (eventAtUTC antigo) — nao manda mensagem
  // nenhuma, so avisa onde procurar, sem fingir que criou uma nova.
  chamadasUmbler = [];
  chatEventAtUTC = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const conversaJaExistia = await chamarAcao(GIAN, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: chatNovo=false quando a conversa ja existia', conversaJaExistia.corpo.chatNovo, false);
  checar('  setor da conversa ja existente tambem volta', conversaJaExistia.corpo.setor, 'Sucesso do Cliente');
  chatEventAtUTC = new Date().toISOString();
  chatSetor = null;

  // Mensagem de abertura opcional: manda quando vier preenchida, nao manda
  // quando o campo veio vazio (sem tentar nada no Umbler).
  chamadasUmbler = [];
  contatoExistente = null;
  const comMensagem = await chamarAcao(GIAN, { id: 'tProjetoUmbler', mensagem: 'Olá tudo bem?' });
  checar('iniciar-conversa-umbler: 200 manda a mensagem quando preenchida', [comMensagem.code, comMensagem.corpo.mensagemEnviada], [200, true]);
  const corpoMensagem = chamadasUmbler.find((c) => c.tipo === 'enviar-mensagem')?.body;
  checar('  manda o texto certo pro chat certo', [corpoMensagem.chatId, corpoMensagem.message], ['chat-novo', 'Olá tudo bem?']);

  chamadasUmbler = [];
  contatoExistente = null;
  const semMensagem = await chamarAcao(GIAN, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: sem mensagem no corpo -> nao chama enviar-mensagem', [semMensagem.corpo.mensagemEnviada, chamadasUmbler.some((c) => c.tipo === 'enviar-mensagem')], [false, false]);

  // Erro do Umbler ao ENVIAR a mensagem nao derruba a resposta — contato e
  // conversa ja foram criados de verdade, entao ok:true com o aviso certo.
  chamadasUmbler = [];
  contatoExistente = null;
  statusEnviarMensagem = 500;
  const falhaMensagem = await chamarAcao(GIAN, { id: 'tProjetoUmbler', mensagem: 'Olá tudo bem?' });
  checar('iniciar-conversa-umbler: falha ao enviar mensagem -> 200 mesmo assim, so avisa', [falhaMensagem.code, falhaMensagem.corpo.ok, falhaMensagem.corpo.mensagemEnviada], [200, true, false]);
  checar('  mensagemErro preenchido', typeof falhaMensagem.corpo.mensagemErro === 'string' && falhaMensagem.corpo.mensagemErro.length > 0, true);
  statusEnviarMensagem = 200;

  chamadasUmbler = [];
  contatoExistente = null;
  statusCriarContato = 500;
  const erroUmblerContato = await chamarAcao(GIAN, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: erro do Umbler ao criar contato -> 502', [erroUmblerContato.code, erroUmblerContato.corpo.code], [502, 'erro_umbler']);
  statusCriarContato = 200;

  delete process.env.UMBLER_API_TOKEN;
  const semConfig = await chamarAcao(GIAN, { id: 'tProjetoUmbler' });
  checar('iniciar-conversa-umbler: configuracao ausente -> 500', [semConfig.code, semConfig.corpo.code], [500, 'umbler_nao_configurado']);
  process.env.UMBLER_API_TOKEN = 'token-teste';

  globalThis.fetch = fetchOriginal;
}

console.log('\n[41] sincronizar-agendamentos-google + vincular-agendamento-google: casamento por CNPJ');
{
  const fetchOriginal = globalThis.fetch;
  process.env.CLICKUP_API_KEY = 'pk_teste';
  process.env.GOOGLE_CLIENT_ID = 'id-teste';
  process.env.GOOGLE_CLIENT_SECRET = 'segredo-teste';
  process.env.GOOGLE_REDIRECT_URI = 'https://exemplo.test/api/google-oauth-callback';

  const LISTA_TOKENS_GOOGLE = '901329032234';
  const LISTA_IMPLANTACOES = '901328976497';
  const LISTA_RESERVAS = '901329017742';
  const BRUNO = 118125102;

  const descEvento = (cnpj) =>
    'Reservado por\nCliente Teste\ncliente@exemplo.test\n\nCNPJ (sem pontuação)\n' + cnpj + '\n\nAssunto da Reunião\nImplantação do Waipe';

  const eventos = [
    {
      id: 'evt-vinculado', summary: 'Implantação do Waipe', hangoutLink: 'https://meet.google.com/vinculado',
      start: { dateTime: '2026-09-21T14:00:00-03:00' }, end: { dateTime: '2026-09-21T15:00:00-03:00' },
      description: descEvento('11222333000181'), // bate com o CNPJ do Projeto A
    },
    {
      id: 'evt-sem-projeto', summary: 'Reunião sem projeto', hangoutLink: null,
      start: { dateTime: '2026-09-22T10:00:00-03:00' }, end: { dateTime: '2026-09-22T11:00:00-03:00' },
      description: descEvento('99988877000166'), // nenhum projeto tem esse CNPJ
    },
    {
      id: 'evt-sem-cnpj', summary: 'Reunião interna qualquer', hangoutLink: null,
      start: { dateTime: '2026-09-23T09:00:00-03:00' }, end: { dateTime: '2026-09-23T10:00:00-03:00' },
      description: 'Sem nenhuma pergunta personalizada aqui.',
    },
    {
      id: 'evt-ja-importado', summary: 'Ja processado antes', hangoutLink: null,
      start: { dateTime: '2026-09-24T09:00:00-03:00' }, end: { dateTime: '2026-09-24T10:00:00-03:00' },
      description: descEvento('11222333000181'),
    },
  ];

  const escritas = [];
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
    if (u.includes(`/list/${LISTA_TOKENS_GOOGLE}/task?`)) {
      return ok({
        tasks: [{ id: 'tTokenBruno', assignees: [], description: JSON.stringify({ ismId: BRUNO, refreshToken: 'rt-bruno', conectadoEm: Date.now() }) }],
        last_page: true,
      });
    }
    if (u.includes(`/list/${LISTA_IMPLANTACOES}/task?`)) {
      return ok({
        tasks: [{ id: 'tProjA', name: 'Cliente A', description: JSON.stringify({ etapaAtual: 'construcao', cnpj: '11222333000181' }) }],
        last_page: true,
      });
    }
    if (u.includes(`/list/${LISTA_RESERVAS}/task?`)) {
      return ok({
        tasks: [{ id: 'tReservaAntiga', assignees: [{ id: BRUNO }], description: '**Projeto:** tProjA\n\n**GoogleEventId:** evt-ja-importado' }],
        last_page: true,
      });
    }
    if (metodo === 'POST' && u.endsWith(`/list/${LISTA_RESERVAS}/task`)) {
      escritas.push({ alvo: 'criar-reserva', body: JSON.parse(init.body) });
      return ok({ id: 'tNovaReservaGoogle' });
    }
    if (u === 'https://oauth2.googleapis.com/token') {
      return ok({ access_token: 'at-bruno', expires_in: 3600 });
    }
    if (u.includes('/calendar/v3/calendars/primary/events')) {
      return ok({ items: eventos });
    }
    return ok({});
  };

  const clickupLibUrl = libClickupUnica('sync-google');
  const googleLibUrlReal = libGoogleUnica('sync-google');
  const cu = await carregarCom('api/clickup.js', clickupLibUrl, googleLibUrlReal);

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const GESTAO = { nivel: 'gestao', csm: null, nome: 'Gestao' };
  const CONSULTA = { nivel: 'consulta', csm: null, nome: 'Consulta' };
  const chamarAcao = async (perfil, action, body) => {
    const r = res();
    await cu({ method: 'POST', headers: cabecalhos({ cookie: cookieDe(perfil) }), query: { action }, body }, r);
    return r;
  };

  const semPermissao = await chamarAcao(CONSULTA, 'sincronizar-agendamentos-google', {});
  checar('sincronizar-agendamentos-google: consulta -> 403', [semPermissao.code, semPermissao.corpo.code], [403, 'somente_leitura']);

  escritas.length = 0;
  const sync = await chamarAcao(GESTAO, 'sincronizar-agendamentos-google', {});
  checar('sincronizar-agendamentos-google: 200', [sync.code, sync.corpo.ok], [200, true]);
  checar('  evento com CNPJ batendo -> vinculado automatico', sync.corpo.vinculados.map((v) => v.projetoId), ['tProjA']);
  checar('  cria a reserva de verdade, com GoogleEventId gravado', escritas[0]?.body.markdown_description.includes('**GoogleEventId:** evt-vinculado'), true);
  checar('  evento com CNPJ sem projeto -> naoVinculados', sync.corpo.naoVinculados.map((n) => n.googleEventId), ['evt-sem-projeto']);
  checar('  evento sem pergunta de CNPJ -> ignorado (nao aparece em nenhuma lista)', escritas.length, 1);
  checar('  evento ja importado (GoogleEventId ja existe numa reserva) -> nao duplica', escritas.some((e) => e.body.markdown_description.includes('evt-ja-importado')), false);

  // vincular-agendamento-google: valida os campos e cria a reserva manualmente
  const semPermissaoVincular = await chamarAcao(CONSULTA, 'vincular-agendamento-google', { projetoId: 'tProjA', ismId: BRUNO, googleEventId: 'x', inicio: 1, fim: 2 });
  checar('vincular-agendamento-google: consulta -> 403', [semPermissaoVincular.code, semPermissaoVincular.corpo.code], [403, 'somente_leitura']);

  const projetoInvalido = await chamarAcao(GESTAO, 'vincular-agendamento-google', { projetoId: 'zzz!!', ismId: BRUNO, googleEventId: 'x', inicio: 1, fim: 2 });
  checar('vincular-agendamento-google: projetoId invalido -> 400', [projetoInvalido.code, projetoInvalido.corpo.code], [400, 'task_invalida']);

  const ismInvalido = await chamarAcao(GESTAO, 'vincular-agendamento-google', { projetoId: 'tProjA', ismId: 999999, googleEventId: 'x', inicio: 1, fim: 2 });
  checar('vincular-agendamento-google: ismId invalido -> 400', [ismInvalido.code, ismInvalido.corpo.code], [400, 'ism_invalido']);

  const semEvento = await chamarAcao(GESTAO, 'vincular-agendamento-google', { projetoId: 'tProjA', ismId: BRUNO, inicio: 1, fim: 2 });
  checar('vincular-agendamento-google: sem googleEventId -> 400', [semEvento.code, semEvento.corpo.code], [400, 'evento_invalido']);

  const horarioInvalido = await chamarAcao(GESTAO, 'vincular-agendamento-google', { projetoId: 'tProjA', ismId: BRUNO, googleEventId: 'evt-x', inicio: 2, fim: 1 });
  checar('vincular-agendamento-google: fim antes do inicio -> 400', [horarioInvalido.code, horarioInvalido.corpo.code], [400, 'horario_invalido']);

  escritas.length = 0;
  const vincularOk = await chamarAcao(GESTAO, 'vincular-agendamento-google', {
    projetoId: 'tProjB', ismId: BRUNO, googleEventId: 'evt-sem-projeto', titulo: 'Reunião sem projeto',
    inicio: Date.parse('2026-09-22T10:00:00-03:00'), fim: Date.parse('2026-09-22T11:00:00-03:00'), linkReuniao: null,
  });
  checar('vincular-agendamento-google: 200', [vincularOk.code, vincularOk.corpo.ok], [200, true]);
  const reservaManual = escritas.find((e) => e.alvo === 'criar-reserva')?.body;
  checar('  grava Projeto + GoogleEventId certos', [
    reservaManual.markdown_description.includes('**Projeto:** tProjB'),
    reservaManual.markdown_description.includes('**GoogleEventId:** evt-sem-projeto'),
  ], [true, true]);

  globalThis.fetch = fetchOriginal;
}

console.log('\n[42] Nível "ism": login, sem dados financeiros, só os próprios projetos/agenda');
{
  // Login de verdade com a senha configurada em AUTH_ISM_BRUNO. IP proprio (nao
  // compartilhado com os outros testes de login) pra nao esbarrar no limitador
  // de tentativas — e' por IP, em memoria, e o modulo `login` e carregado uma
  // unica vez pro arquivo inteiro.
  const loginOk = await (async () => {
    const r = res();
    await login({ method: 'POST', headers: cabecalhos({ 'x-forwarded-for': '203.0.113.42' }), query: {}, body: { senha: SENHA_ISM_BRUNO } }, r);
    return r;
  })();
  checar('login: senha do Bruno -> nivel ism com ismId certo', [
    loginOk.code, loginOk.corpo.nivel, loginOk.corpo.ismId, loginOk.corpo.nome,
  ], [200, 'ism', 118125102, 'Bruno Vaz']);

  const fetchOriginal = globalThis.fetch;
  process.env.CLICKUP_API_KEY = 'pk_teste';
  process.env.GOOGLE_CLIENT_ID = 'id-teste';
  process.env.GOOGLE_CLIENT_SECRET = 'segredo-teste';
  process.env.GOOGLE_REDIRECT_URI = 'https://exemplo.test/api/google-oauth-callback';

  const LISTA = '901328976497';
  const LISTA_RESERVAS = '901329017742';
  const BRUNO = 118125102;
  const ERICA = 48933858;

  const tarefas = {
    tProjBruno: { id: 'tProjBruno', name: 'Cliente Bruno', list: { id: LISTA }, parent: null, assignees: [{ id: BRUNO }], subtasks: [{ id: 'tAgenteBruno' }], description: JSON.stringify({ etapaAtual: 'construcao' }) },
    tAgenteBruno: { id: 'tAgenteBruno', name: 'Agente Bruno', list: { id: LISTA }, parent: 'tProjBruno', assignees: [{ id: BRUNO }], description: JSON.stringify({ tipo: 'agente' }) },
    tProjErica: { id: 'tProjErica', name: 'Cliente Erica', list: { id: LISTA }, parent: null, assignees: [{ id: ERICA }], subtasks: [{ id: 'tAgenteErica' }], description: JSON.stringify({ etapaAtual: 'construcao' }) },
    tAgenteErica: { id: 'tAgenteErica', name: 'Agente Erica', list: { id: LISTA }, parent: 'tProjErica', assignees: [{ id: ERICA }], description: JSON.stringify({ tipo: 'agente' }) },
  };
  const reservas = {
    tReservaBruno: { id: 'tReservaBruno', list: { id: LISTA_RESERVAS }, assignees: [{ id: BRUNO }], description: '' },
    tReservaErica: { id: 'tReservaErica', list: { id: LISTA_RESERVAS }, assignees: [{ id: ERICA }], description: '' },
  };

  const escritas = [];
  function ok(corpo) {
    return { ok: true, status: 200, headers: new Map([['x-ratelimit-limit', '100'], ['x-ratelimit-remaining', '90'], ['x-ratelimit-reset', '0']]), json: async () => corpo, text: async () => '' };
  }

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const metodo = init?.method || 'GET';
    const idNaUrl = (prefixo) => {
      const m = u.match(new RegExp(`/task/([^/?]+)${prefixo}`));
      return m ? m[1] : null;
    };
    if (u.includes(`/list/${LISTA}/task?`)) return ok({ tasks: Object.values(tarefas).filter((t) => !t.parent), last_page: true });
    if (u.includes(`/list/${LISTA_RESERVAS}/task?`)) return ok({ tasks: Object.values(reservas), last_page: true });
    if (metodo === 'POST' && u.endsWith(`/list/${LISTA_RESERVAS}/task`)) {
      escritas.push({ alvo: 'criar-reserva', body: JSON.parse(init.body) });
      return ok({ id: 'tNovaReserva' });
    }
    const idSub = idNaUrl('\\?include_subtasks=true');
    if (idSub) return ok(tarefas[idSub] || null);
    if (metodo === 'PUT') {
      const id = idNaUrl('$');
      escritas.push({ alvo: id, body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'DELETE') {
      const id = idNaUrl('$');
      escritas.push({ alvo: 'excluir-' + id });
      return ok({});
    }
    if (metodo === 'POST' && u.includes('/comment')) {
      const id = idNaUrl('/comment');
      escritas.push({ alvo: 'comentario-' + id, body: JSON.parse(init.body) });
      return ok({});
    }
    if (metodo === 'GET' && u.includes('/comment')) return ok({ comments: [] });
    const id = idNaUrl('$');
    if (id && tarefas[id]) return ok(tarefas[id]);
    if (id && reservas[id]) return ok(reservas[id]);
    return ok({});
  };

  const clickupLibUrl = libClickupUnica('ism');
  const googleLibUrlReal = libGoogleUnica('ism');
  const cu = await carregarCom('api/clickup.js', clickupLibUrl, googleLibUrlReal);

  const cookieDe = (perfil) => `${auth.COOKIE_NOME}=${auth.assinarSessao(perfil)}`;
  const ISM_BRUNO = { nivel: 'ism', csm: null, ismId: BRUNO, nome: 'Bruno Vaz' };
  const chamarGet = async (action, query = {}) => {
    const r = res();
    await cu({ method: 'GET', headers: cabecalhos({ cookie: cookieDe(ISM_BRUNO) }), query: { action, ...query } }, r);
    return r;
  };
  const chamarPost = async (action, body) => {
    const r = res();
    await cu({ method: 'POST', headers: cabecalhos({ cookie: cookieDe(ISM_BRUNO) }), query: { action }, body }, r);
    return r;
  };

  // Sem nada de financeiro/carteira nem pipeline de proposta — bloqueado ANTES da funcao rodar.
  for (const acaoProibida of ['carteira', 'metas', 'cliente']) {
    const r = await chamarGet(acaoProibida, acaoProibida === 'cliente' ? { taskId: 'tProjBruno' } : {});
    checar(`ism: GET ${acaoProibida} -> 403 nivel_nao_permitido`, [r.code, r.corpo.code], [403, 'nivel_nao_permitido']);
  }
  for (const acaoProibida of ['set-field', 'log-proposta', 'criar-implantacao', 'salvar-proposta-implantacao', 'confirmar-fechamento-implantacao']) {
    const r = await chamarPost(acaoProibida, {});
    checar(`ism: POST ${acaoProibida} -> 403 nivel_nao_permitido`, [r.code, r.corpo.code], [403, 'nivel_nao_permitido']);
  }

  // listar-implantacoes: so o projeto do Bruno
  const lista = await chamarGet('listar-implantacoes');
  checar('ism: listar-implantacoes so mostra o proprio projeto', lista.corpo.tasks.map((t) => t.id), ['tProjBruno']);

  // obter-implantacao: proprio projeto ok, projeto de outro ISM -> 403
  const obterProprio = await chamarGet('obter-implantacao', { id: 'tProjBruno' });
  checar('ism: obter-implantacao do proprio projeto -> 200', obterProprio.code, 200);
  const obterAlheio = await chamarGet('obter-implantacao', { id: 'tProjErica' });
  checar('ism: obter-implantacao de projeto de outro ISM -> 403', [obterAlheio.code, obterAlheio.corpo.code], [403, 'fora_da_carteira']);

  // atualizar-implantacao: proprio ok, alheio 403
  const atualizarProprio = await chamarPost('atualizar-implantacao', { id: 'tProjBruno', etapaAtual: 'testes', prioridade: [], concluidos: [] });
  checar('ism: atualizar-implantacao do proprio projeto -> 200', atualizarProprio.code, 200);
  const atualizarAlheio = await chamarPost('atualizar-implantacao', { id: 'tProjErica', etapaAtual: 'testes', prioridade: [], concluidos: [] });
  checar('ism: atualizar-implantacao de projeto de outro ISM -> 403', [atualizarAlheio.code, atualizarAlheio.corpo.code], [403, 'fora_da_carteira']);

  // atualizar-agente: idem, posse resolvida pelo projeto pai
  const agenteProprio = await chamarPost('atualizar-agente', { taskId: 'tAgenteBruno', buildChecks: {} });
  checar('ism: atualizar-agente do proprio projeto -> 200', agenteProprio.code, 200);
  const agenteAlheio = await chamarPost('atualizar-agente', { taskId: 'tAgenteErica', buildChecks: {} });
  checar('ism: atualizar-agente de projeto de outro ISM -> 403', [agenteAlheio.code, agenteAlheio.corpo.code], [403, 'fora_da_carteira']);

  // comentar-implantacao / listar-comentarios: idem
  const comentarProprio = await chamarPost('comentar-implantacao', { taskId: 'tAgenteBruno', texto: 'oi' });
  checar('ism: comentar no proprio projeto -> 200', comentarProprio.code, 200);
  const comentarAlheio = await chamarPost('comentar-implantacao', { taskId: 'tAgenteErica', texto: 'oi' });
  checar('ism: comentar em projeto de outro ISM -> 403', [comentarAlheio.code, comentarAlheio.corpo.code], [403, 'fora_da_carteira']);
  const listarComentariosAlheio = await chamarGet('listar-comentarios', { taskId: 'tAgenteErica' });
  checar('ism: listar-comentarios de projeto de outro ISM -> 403', [listarComentariosAlheio.code, listarComentariosAlheio.corpo.code], [403, 'fora_da_carteira']);

  // conectar-agenda-google: so a propria
  const conectarProprio = await chamarGet('conectar-agenda-google', { ismId: BRUNO });
  checar('ism: conectar-agenda-google da propria -> 302', conectarProprio.code, 302);
  const conectarAlheio = await chamarGet('conectar-agenda-google', { ismId: ERICA });
  checar('ism: conectar-agenda-google de outro ISM -> 403', [conectarAlheio.code, conectarAlheio.corpo.code], [403, 'fora_do_escopo']);

  // criar-reserva: so a propria
  const inicioReserva = Date.UTC(2026, 9, 1, 13, 0);
  const criarReservaAlheia = await chamarPost('criar-reserva', { titulo: 'Reuniao', ismId: ERICA, inicio: inicioReserva, fim: inicioReserva + 3600000 });
  checar('ism: criar-reserva pra outro ISM -> 403', [criarReservaAlheia.code, criarReservaAlheia.corpo.code], [403, 'fora_do_escopo']);
  const criarReservaPropria = await chamarPost('criar-reserva', { titulo: 'Reuniao', ismId: BRUNO, inicio: inicioReserva, fim: inicioReserva + 3600000 });
  checar('ism: criar-reserva pra si mesmo -> 200', criarReservaPropria.code, 200);

  // atualizar-reserva/cancelar-reserva: so a reserva da propria agenda
  const atualizarReservaAlheia = await chamarPost('atualizar-reserva', { id: 'tReservaErica', linkReuniao: 'x' });
  checar('ism: atualizar-reserva de outro ISM -> 403', [atualizarReservaAlheia.code, atualizarReservaAlheia.corpo.code], [403, 'fora_do_escopo']);
  const atualizarReservaPropria = await chamarPost('atualizar-reserva', { id: 'tReservaBruno', linkReuniao: 'x' });
  checar('ism: atualizar-reserva da propria -> 200', atualizarReservaPropria.code, 200);
  const cancelarReservaAlheia = await chamarPost('cancelar-reserva', { id: 'tReservaErica' });
  checar('ism: cancelar-reserva de outro ISM -> 403', [cancelarReservaAlheia.code, cancelarReservaAlheia.corpo.code], [403, 'fora_do_escopo']);

  // vincular-agendamento-google: so pra propria agenda
  const vincularAlheio = await chamarPost('vincular-agendamento-google', { projetoId: 'tProjBruno', ismId: ERICA, googleEventId: 'evt-x', inicio: 1, fim: 2 });
  checar('ism: vincular-agendamento-google pra outro ISM -> 403', [vincularAlheio.code, vincularAlheio.corpo.code], [403, 'fora_do_escopo']);

  // "ism" auxiliar (Daiane/Aline): ismId null -> sem projeto/calendario proprio,
  // entao SEM restricao nenhuma (ve tudo, mexe na agenda de qualquer ISM) —
  // mas continua fora de carteira/metas/cliente/proposta, igual Bruno/Erica.
  const ISM_AUXILIAR = { nivel: 'ism', csm: null, ismId: null, nome: 'Daiane' };
  const chamarGetAuxiliar = async (action, query = {}) => {
    const r = res();
    await cu({ method: 'GET', headers: cabecalhos({ cookie: cookieDe(ISM_AUXILIAR) }), query: { action, ...query } }, r);
    return r;
  };
  const chamarPostAuxiliar = async (action, body) => {
    const r = res();
    await cu({ method: 'POST', headers: cabecalhos({ cookie: cookieDe(ISM_AUXILIAR) }), query: { action }, body }, r);
    return r;
  };

  const listaAuxiliar = await chamarGetAuxiliar('listar-implantacoes');
  checar('ism auxiliar (ismId null): ve TODOS os projetos, nao so um ISM', listaAuxiliar.corpo.tasks.map((t) => t.id).sort(), ['tProjBruno', 'tProjErica']);

  const obterAlheioAuxiliar = await chamarGetAuxiliar('obter-implantacao', { id: 'tProjErica' });
  checar('ism auxiliar: obter-implantacao de qualquer projeto -> 200', obterAlheioAuxiliar.code, 200);

  const conectarAlheioAuxiliar = await chamarGetAuxiliar('conectar-agenda-google', { ismId: ERICA });
  checar('ism auxiliar: conectar-agenda-google de qualquer ISM -> 302 (nao bloqueia)', conectarAlheioAuxiliar.code, 302);

  const criarReservaAuxiliar = await chamarPostAuxiliar('criar-reserva', { titulo: 'Reagendamento', ismId: ERICA, inicio: inicioReserva + 10 * 3600000, fim: inicioReserva + 11 * 3600000 });
  checar('ism auxiliar: criar-reserva pra outro ISM -> 200 (nao bloqueia)', criarReservaAuxiliar.code, 200);

  const atualizarReservaAuxiliar = await chamarPostAuxiliar('atualizar-reserva', { id: 'tReservaErica', linkReuniao: 'y' });
  checar('ism auxiliar: atualizar-reserva de qualquer ISM -> 200 (nao bloqueia)', atualizarReservaAuxiliar.code, 200);

  const carteiraAuxiliar = await chamarGetAuxiliar('carteira');
  checar('ism auxiliar: continua sem acesso a carteira -> 403', [carteiraAuxiliar.code, carteiraAuxiliar.corpo.code], [403, 'nivel_nao_permitido']);

  globalThis.fetch = fetchOriginal;
}

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) {
  console.error(`${falhas} FALHA(S)`);
  process.exit(1);
}
console.log('TUDO PASSOU — nenhum caminho de falha derruba a funcao');
