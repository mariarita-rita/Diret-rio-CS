# Diretório CS — Londrisoft

Site estático em HTML puro, publicado na Vercel. As páginas ficam na raiz do
repositório e não existe build step.

O `dashboard_carteiras.html` fala com o ClickUp e com o Moskit CRM através de
três funções serverless em `/api`. **Nenhuma credencial vive no navegador.**

---

## Variáveis de ambiente

Configure todas em **Vercel → Project → Settings → Environment Variables**, nos
ambientes *Production*, *Preview* e *Development*.

Nunca escreva nenhum destes valores em arquivo do repositório.

### Integrações

| Variável           | Para que serve                                        | Placeholder |
| ------------------ | ----------------------------------------------------- | ----------- |
| `CLICKUP_API_KEY`  | Token pessoal do ClickUp usado por `/api/clickup`     | `pk_XXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| `MOSKIT_API_KEY`   | Chave da API do Moskit usada por `/api/moskit`        | `00000000-0000-0000-0000-000000000000` |

### Sessão

| Variável         | Para que serve                                              | Placeholder |
| ---------------- | ----------------------------------------------------------- | ----------- |
| `SESSION_SECRET` | Segredo do HMAC que assina o cookie de sessão. Mínimo de 32 caracteres. | `<48 bytes aleatórios em base64url>` |

Para gerar:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Trocar o `SESSION_SECRET` invalida na hora todas as sessões abertas — é o jeito de
derrubar todo mundo se uma senha vazar.

### Senhas de acesso (hash, nunca texto puro)

Uma variável por perfil. O valor é sempre o **hash**, no formato
`scrypt$N$r$p$salt$hash`.

| Variável              | Perfil     | Nível      | Carteira            |
| --------------------- | ---------- | ---------- | ------------------- |
| `AUTH_CONSULTA`       | Consulta Geral    | `consulta` | —            |
| `AUTH_GESTAO`         | Gestão            | `gestao`   | todas        |
| `AUTH_CSM_GIAN`       | Gian Luca         | `csm`      | Gian Luca         |
| `AUTH_CSM_LUCINEIA`   | Lucineia Felix    | `csm`      | Lucineia Felix    |
| `AUTH_CSM_GUILHERME`  | Guilherme Camargo | `csm`      | Guilherme Camargo |
| `AUTH_CSM_PATRICIA`   | Patricia Carvalho | `csm`      | Patricia Carvalho |

Placeholder do valor:

```
scrypt$16384$8$1$YWJjZGVmZ2hpamtsbW5vcA==$<hash de 64 bytes em base64>
```

Um perfil sem variável configurada simplesmente não consegue entrar. Se **nenhuma**
`AUTH_*` estiver configurada, `/api/login` responde 500 em vez de deixar tudo
aberto.

#### Gerando o hash de uma senha

```bash
node scripts/gerar-hash.js "a senha aqui"
```

O script imprime a linha `scrypt$...` para colar na variável de ambiente. Use
aspas na senha; no PowerShell prefira aspas simples se ela tiver `$` ou backtick.

Para trocar a senha de alguém: rode o script com a senha nova e substitua o valor
da variável na Vercel. Não precisa mexer em código.

### Opcional

| Variável           | Para que serve |
| ------------------ | -------------- |
| `ALLOWED_ORIGINS`  | Origens extras aceitas pelo CORS, separadas por vírgula. Por padrão só a própria origem do deploy é aceita. Use apenas se o dashboard passar a ser servido de outro domínio. |

---

## Níveis de acesso

As regras são aplicadas **no servidor**, em toda requisição. Mexer no objeto
`session` pelo console do navegador muda no máximo o que a tela desenha; não
aumenta nem um pouco o acesso aos dados.

| Nível      | Carteira                     | `set-field` no ClickUp | Moskit | MRR |
| ---------- | ---------------------------- | ---------------------- | ------ | --- |
| `consulta` | sem valores financeiros      | 403                    | 403    | não |
| `csm`      | somente a própria            | somente a própria      | somente a própria | sim |
| `gestao`   | completa                     | liberado               | liberado | sim |

Para `consulta`, "não" em MRR vale para **todo** número financeiro: o `mrr` de cada
linha sai zerado e o agregado `mrrEquipe` sai `0`.

O filtro por CSM acontece antes da resposta sair do servidor: a carteira dos
outros CSMs nunca chega ao navegador.

O critério do filtro é **igualdade de nome completo**, normalizado (sem acentos,
sem espaço repetido, sem diferença de caixa), entre o campo *Gerente* da task e o
nome do perfil em `PERFIS` (`api/_lib/auth.js`). Não há casamento parcial: um
*Gerente* preenchido como `Gian` ou `Gian Luca Silva` **não** casa com o perfil
`Gian Luca`. Se um CSM entrar e a carteira aparecer vazia, o primeiro lugar para
olhar é a grafia do campo *Gerente* no ClickUp.

O perfil `csm` não tem mais a aba **Visão Geral**. Como o backend passou a
devolver somente a carteira dele, a aba seria uma cópia idêntica da aba própria.

---

## Endpoints

Todos exigem cookie de sessão válido e aceitam apenas a própria origem
(`Access-Control-Allow-Origin` nunca é `*`).

### `/api/login`

| Método | Query | O que faz |
| ------ | ----- | --------- |
| `POST` | —     | `{ senha }` → cookie de sessão + `{ nivel, csm, nome }` |
| `POST` | `?action=logout` | limpa o cookie |
| `GET`  | —     | devolve a sessão atual, ou 401 |

Cookie: `httpOnly`, `Secure`, `SameSite=Strict`, validade de 12h, assinado com
HMAC-SHA256. O payload carrega apenas `{ nivel, csm, nome, iat }`.

Rate limiting: 5 tentativas por IP em 15 minutos. **É um contador em memória, por
instância serverless** — corta força bruta de origem única, mas não é um limite
global forte. Se algum dia precisar de garantia real, isso exige um armazenamento
compartilhado (Vercel KV ou Upstash), o que traria dependência nova.

Sempre responde `Cache-Control: no-store`.

### `/api/clickup`

| Método | `action`    | O que faz |
| ------ | ----------- | --------- |
| `GET`  | `carteira`  | lista `901327787926`, paginada inteira no servidor, `include_closed=true`, `include_custom_fields=true` |
| `GET`  | `metas`     | lista `901327940637`, `include_closed=false`, mais o campo agregado `mrrEquipe` (`0` para `consulta`) |
| `POST` | `set-field` | `{ taskId, fieldId, value }` |

Não existe path livre. Os dois IDs de lista são constantes no servidor.

`set-field` só aceita estes quatro campos, e só estes valores:

| Campo | ID | Valores aceitos |
| ----- | -- | --------------- |
| Em acompanhamento | `94b85690-…` | `true` / `false` |
| Etapa             | `d15028f2-…` | 1 ID de opção |
| Tipo de solicitação | `a4acad54-…` | 4 IDs de opção |
| Alertas           | `6ce5db54-…` | até 10 dos 5 IDs de label |

Qualquer outro `fieldId` → 403. Qualquer valor fora dessas listas → 403. A task
também é conferida contra as duas listas permitidas antes de qualquer escrita.

> **Se você criar uma nova opção de alerta ou de tipo no ClickUp**, adicione o ID
> dela em `CAMPOS_ESCRITA`, em `api/_lib/clickup.js`. Sem isso a gravação da opção
> nova volta 403 — é a allowlist funcionando, não um bug.

### `/api/moskit`

| Método | `action`  | O que faz |
| ------ | --------- | --------- |
| `POST` | `deal`    | `POST /v2/deals` |
| `POST` | `project` | `POST /v2/projects` |

Nenhum outro endpoint do Moskit é alcançável. Não há pass-through do corpo: cada
campo é validado e o corpo é remontado no servidor.

Travados no servidor: `pipeline 91432`, `stage 438018`, `board 32342`,
`step 124287`, `createdBy 133497`, os IDs dos campos personalizados e o mapa de
responsáveis.

Identificação do cliente (ID Núcleo, CNPJ, razão social, mensalidade anterior) e
responsável são lidos da task do ClickUp apontada por `taskId` — não vêm do
navegador. É isso que aplica o escopo por CSM também na escrita.

---

## Cache

`vercel.json` aplica `s-maxage=300, stale-while-revalidate=600` a tudo **exceto**
`/api/` (via `source: "/((?!api/).*)"`). Cada função define seu próprio
`Cache-Control`:

| Endpoint | Cache-Control |
| -------- | ------------- |
| `/api/login` (sempre) | `no-store` |
| `/api/clickup` leitura | `private, max-age=300, stale-while-revalidate=600` |
| `/api/clickup` escrita, `/api/moskit`, todo erro | `no-store` |

**Por que `private` e não `s-maxage` na leitura:** a resposta de `action=carteira`
varia por sessão, porque o filtro de CSM é aplicado antes de responder. Num cache
compartilhado (a CDN), a resposta filtrada de um CSM poderia ser entregue a outro
CSM ou à gestão — vazamento de carteira. O frescor de 300s foi mantido de duas
formas que não têm esse problema: cache privado no navegador e um cache em memória
por instância da função, que guarda o dado **bruto**, antes da filtragem.
`Vary: Origin, Cookie` vai junto como reforço.

## Tempo de execução

A paginação da carteira saiu do navegador (sem prazo) para dentro de uma função
serverless (com prazo). Para compensar, `buscarPaginado` busca 4 páginas por vez.
Se a carteira crescer muito e você começar a ver timeout no `/api/clickup`,
acrescente ao `vercel.json`:

```json
"functions": { "api/clickup.js": { "maxDuration": 60 } }
```

O valor máximo permitido depende do plano da Vercel.

---

## Desenvolvimento local

```bash
npm i -g vercel      # uma vez
vercel link          # uma vez, associa a pasta ao projeto
vercel env pull .env.local
vercel dev
```

`.env.local` está no `.gitignore` e nunca deve ser commitado.

O cookie é emitido com `Secure`. Chrome e Firefox aceitam cookie `Secure` em
`http://localhost`, então o login funciona no `vercel dev` sem alteração.

A origem `http://<host>` só entra na lista de origens aceitas **fora de produção**
(`VERCEL_ENV=development`, que é o do `vercel dev`). Em `production` e em `preview`
só `https://` é aceito, e a ausência da variável também fecha para `https://`.

### O que validar manualmente

Com o `vercel dev` rodando em `http://localhost:3000`:

**1. Nada de segredo na página**

```bash
curl -s http://localhost:3000/dashboard_carteiras.html | grep -Ei "pk_|apikey|Authorization|@2026"
# tem que sair vazio
```

Ou `Ctrl+U` no navegador e buscar por `pk_`, `apikey` e `senha`.

**2. Sem cookie, sem dados**

```bash
curl -i "http://localhost:3000/api/clickup?action=carteira"
# 401  {"error":"Sessão ausente ou expirada...","code":"sessao_invalida"}
```

**3. Login e uso normal**

Abra o dashboard, entre com a senha da gestão. Confira: as abas dos 4 CSMs
aparecem, os cards de meta carregam, a tabela lista os clientes.

**4. Escopo do CSM** — esse é o teste que mais importa

Entre com a senha de um CSM. Depois, no console:

```js
await (await fetch('/api/clickup?action=carteira')).json()
```

Todo item de `tasks` tem que ter `gerente` daquele CSM, e só dele. Nenhum cliente
de outro CSM pode estar na resposta.

**5. Editar a sessão no console não amplia acesso**

Ainda logada como CSM:

```js
session.nivel = 'gestao'; buildTabs();
```

As abas mudam (é só desenho), mas os dados continuam sendo só os da carteira dele.
Recarregue e confirme que voltou ao normal.

**6. Consulta é somente leitura**

Entre com a senha de consulta e rode no console:

```js
await (await fetch('/api/clickup?action=set-field', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ taskId: '<id de uma task>', fieldId: '94b85690-3d47-4edf-9209-0a671cfb570b', value: true })
})).json()
// 403  code: "somente_leitura"
```

Mesma coisa em `/api/moskit?action=deal` → 403.

**7. Allowlist de campo**

Logada como gestão, troque o `fieldId` acima por
`11111111-2222-3333-4444-555555555555`:

```
403  code: "campo_nao_permitido"
```

E tente sair das listas permitidas — `action=lista&list=qualquer-coisa`,
`action=../../team` — tudo tem que voltar 400 `acao_invalida`.

**8. Fluxos de escrita continuam funcionando**

Este é o teste que grava de verdade no ClickUp e no Moskit — faça com um cliente
de teste:

- Abra um cliente → **Criar negócio no Moskit** → preencha e envie. Confira no
  Moskit que o negócio caiu no funil 91432, na etapa certa, com o responsável do
  gerente daquele cliente, e com ID Núcleo, CNPJ, razão social e mensalidade
  anterior preenchidos.
- Abra um cliente → **Abrir acompanhamento** → escolha tipo, origem e alguns
  alertas. Confira o projeto no board 32342 e, no ClickUp, os campos
  *Em acompanhamento*, *Etapa*, *Tipo* e *Alertas* atualizados.

**9. Rate limiting do login**

Erre a senha 6 vezes seguidas. A sexta tem que voltar `429` com
`code: "muitas_tentativas"`.

**10. Cabeçalhos de cache**

```bash
curl -sI "http://localhost:3000/api/login" | grep -i cache-control
# no-store
```

Depois de publicar, repita em produção e confira que a leitura da carteira volta
`private, max-age=300...` — e **não** `s-maxage`.

**11. Expiração da sessão**

Para não esperar 12h: troque o `SESSION_SECRET` na Vercel e recarregue. A próxima
chamada volta 401 e a tela de login reabre com "Sua sessão expirou".
