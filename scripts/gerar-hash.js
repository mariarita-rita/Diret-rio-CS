#!/usr/bin/env node
/*
 * Gera o hash scrypt de uma senha para colar nas variáveis de ambiente da Vercel.
 *
 *   node scripts/gerar-hash.js "minha senha"
 *
 * Formato de saída (mantenha em sincronia com api/_lib/auth.js):
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * O valor impresso é o que vai em AUTH_CONSULTA, AUTH_GESTAO, AUTH_CSM_*.
 * A senha em texto puro nunca entra em nenhum arquivo do repositório.
 *
 * CommonJS de propósito: roda com `node` puro, sem package.json.
 */

const crypto = require('node:crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

function uso(msg) {
  if (msg) console.error(`\nErro: ${msg}`);
  console.error(`
Uso:
  node scripts/gerar-hash.js "a senha aqui"

Dicas:
  - Use aspas para senhas com espaços ou caracteres especiais.
  - No PowerShell prefira aspas simples se a senha tiver $ ou \`.
  - Para gerar o SESSION_SECRET:
      node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
`);
  process.exit(1);
}

const senha = process.argv[2];
if (senha === undefined) uso('informe a senha como argumento.');
if (senha.length === 0) uso('a senha não pode ser vazia.');
if (process.argv.length > 3) uso('mais de um argumento recebido — coloque a senha entre aspas.');

const salt = crypto.randomBytes(SALT_BYTES);
const maxmem = 256 * N * R + 1024 * 1024;

crypto.scrypt(senha, salt, KEYLEN, { N, r: R, p: P, maxmem }, (err, dk) => {
  if (err) {
    console.error('Falha ao gerar o hash:', err.message);
    process.exit(1);
  }
  const valor = `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`;
  console.log('');
  console.log('Cole este valor na variável de ambiente da Vercel:');
  console.log('');
  console.log(valor);
  console.log('');
});
