# Estado e próximos passos

Documento de retomada. Escrito para que uma sessão sem histórico consiga continuar o
trabalho sem reconstruir contexto.

**Última atualização:** 2026-08-03
**Branch:** `melhorias/filtros-metas-equipe` · **HEAD:** `7bc2fbf` · **não enviada ao remoto**

> A `seguranca/api-proxy-e-auth` **já foi mesclada** na `main` (merge `20714b4`), então
> a seção 6 deste documento é histórico. A branch atual sai da `main` e traz cinco
> commits de funcionalidade — ver seção 11.

---

## 1. O que é este trabalho

Refactor de segurança do `dashboard_carteiras.html`. A página original chamava o
ClickUp e o Moskit CRM **direto do navegador**, com token, chave de API e senhas em
texto puro no HTML — num repositório **público**. O refactor moveu tudo para três
funções serverless em `/api`, com autenticação real por cookie assinado.

Estado: **código completo e validado localmente**, exceto o teste 8 (escrita real no
Moskit). Falta esse teste, o merge e o deploy.

### Contexto que não está no código

- A `main` **não tem** `dashboard_carteiras.html`: foi apagada pelo GitHub para tirar
  do ar a página com credenciais. Isso gera conflito no merge — ver seção 6.
- **As credenciais antigas devem ser tratadas como vazadas.** Apagar da `main` não
  apaga do histórico, e o repositório é público. O `CLICKUP_API_KEY` **já foi
  rotacionado** (token antigo confirmado inválido, 401 `OAUTH_025`). O `SESSION_SECRET`
  também foi rotacionado. **A chave do Moskit e as senhas dos perfis merecem o mesmo
  tratamento**, se estavam naquele arquivo.
- Outros consumidores do token do ClickUp, já verificados na rotação:
  `painel-de-analises` (OK após Redeploy), `apps-script-cs` (a constante lá é
  `CU_TOKEN_SYNC`, não `CLICKUP_API_KEY`; corrigido). Make e Zapier usam OAuth e não
  foram afetados.

---

## 2. Commits da branch

Base comum com a `main`: `419068e`. A `main` está em `d547e3f`.

| Commit | Assunto |
|---|---|
| `b82042d` | Tarefa 3: autenticação real com cookie de sessão assinado |
| `dd9fa7d` | Tarefa 1: proxy serverless do ClickUp, ações fixas e allowlists |
| `fcb4ae1` | Tarefa 2: proxy serverless do Moskit, corpo remontado no servidor |
| `836053b` | Tarefa 4: limpeza do cliente — nenhuma credencial no navegador |
| `5e02bb1` | Tarefa 5: cache, paginação em lote e documentação |
| `5132d42` | `mrrEquipe` fora do perfil consulta; match de CSM por nome completo |
| `bb7d366` | Fallback de responsável no Moskit deixa de ser silencioso |
| `1e247b7` | `.gitignore` atualizado pelo `vercel link` |
| `1a3441d` | Origem `http` restrita a loopback, sem depender de `VERCEL_ENV` |
| `416e9c4` | Corpo inválido e erro de config viram 400/500 tratados (**era crash**) |
| `a8ff0ad` | Teste 9 documentado como não executável localmente |
| `161c87f` | Validação de hash, motivo logado, hashes duplicados, sessão expirada no reload |
| `c1b6f8a` | Cota medida; escrita deixa de custar 29 chamadas; 429 acionável |
| `a4b379f` | Escrita reflete no cache e na tabela |
| `c9c44f0` | Leitura fresca pós-escrita; alertas deixam de perder dado alheio |

Backup: `..\diretorio-cs-backup-31jul.bundle` está em `5132d42` — **defasado e
redundante**, já que o remoto tem tudo. Regenerar só se quiser coerência de nome.

---

## 3. Arquitetura, em uma página

```
/dashboard_carteiras.html   estático, sem credencial nenhuma
/api/login.js               POST senha -> cookie assinado; GET sessão; POST logout
/api/clickup.js             carteira | metas | cliente | set-field
/api/moskit.js              deal | project
/api/_lib/http.js           CORS, erro, leitura de corpo, validadores
/api/_lib/auth.js           HMAC de sessão, scrypt de senha, escopo por CSM
/api/_lib/clickup.js        cliente ClickUp, cache, allowlist de campos, cota
/scripts/gerar-hash.js      gera o hash scrypt de uma senha (CommonJS)
/scripts/teste-http.mjs     suíte de caminhos de falha — 124 asserções
```

Arquivos com prefixo `_` dentro de `/api` não viram endpoints na Vercel.

**Perfis e níveis:** `consulta` (leitura, sem valor financeiro), `csm` (só a própria
carteira, leitura e escrita), `gestao` (completo). As regras são aplicadas **no
servidor**, em toda requisição.

**Escopo por CSM:** igualdade de **nome completo normalizado** (sem acento, espaço
colapsado, minúsculas) entre o campo *Gerente* da task e o nome em `PERFIS`. **Não há
casamento parcial.** Se um CSM entrar e a carteira aparecer vazia, o primeiro lugar a
olhar é a grafia do campo *Gerente* no ClickUp.

**Cota do ClickUp: 100 requisições por minuto, medida**, não estimada
(`x-ratelimit-limit: 100`; `x-ratelimit-reset` em epoch de segundos). O limite é por
**token**, e o token é um só do servidor: **a cota é compartilhada por todo o time**.
Custos atuais: carteira ~28 chamadas (2797 tasks, `limit=100`), metas 1,
`action=cliente` 1, `set-field` 2, fluxo de acompanhamento ~10.

### Variáveis de ambiente

`SESSION_SECRET`, `CLICKUP_API_KEY`, `MOSKIT_API_KEY`, `AUTH_CONSULTA`,
`AUTH_GESTAO`, `AUTH_CSM_GIAN`, `AUTH_CSM_LUCINEIA`, `AUTH_CSM_GUILHERME`,
`AUTH_CSM_PATRICIA`. Opcional: `ALLOWED_ORIGINS` (**nunca** com origem `http://` fora
de loopback — o código recusa e loga).

`vercel dev` lê o `.env.local` **no boot**: editar com ele rodando não tem efeito.
E no `vercel dev` **cada invocação roda num processo novo** (medido: PIDs distintos,
contador sempre em 1), então cache de módulo e rate limiting em memória não acumulam
nada localmente.

---

## 4. O que já foi validado

Suíte automatizada: `node scripts/teste-http.mjs` → **124/124**. Sem dependências.
O harness monta `req.body` como **getter que lança**, reproduzindo o runtime da
Vercel — sem isso a camada onde vivia o crash de `ApiError: Invalid JSON` não é
exercitada.

| Teste do README | Estado |
|---|---|
| 1. Nada de segredo na página | ✅ |
| 2. Sem cookie, sem dados → 401 | ✅ |
| 3. Login e uso normal (Gestão) | ✅ 2797 tasks |
| 4. Escopo do CSM | ✅ ver abaixo |
| 5. Editar `session` no console não amplia acesso | ✅ |
| 6. Consulta é somente leitura → 403 | ✅ |
| 7. Allowlist de campo e de valor → 403 | ✅ |
| 8. Fluxos de escrita reais | ❌ **pendente** — seção 5 |
| 9. Rate limiting do login | ⚠️ **não executável localmente**, documentado no README |
| 10. Cabeçalhos de cache | ✅ parcial — ver ressalva |
| 11. Expiração de sessão | ✅ nos dois caminhos |

**Teste 4, números:** Gestão vê 2797; por gerente 703 (Gian Luca), 701 (Patricia
Carvalho), 700 (Guilherme Camargo), 693 (Lucineia Felix) — soma exata. Gian Luca
logado vê 703, um único `gerente` distinto, nenhum nulo, `mrr` presente. Não vaza e
não esconde.

**Teste 5:** com `session.nivel='gestao'` e `session.csm='Patricia Carvalho'`
forçados no console, os dados continuaram 703 de Gian Luca, e `GET /api/login`
seguiu devolvendo `nivel: 'csm', csm: 'Gian Luca'`.

**Ressalva do teste 10:** a defesa primária foi confirmada — cada função define seu
`no-store`, e nenhuma resposta de API carrega `s-maxage`. Mas o **`vercel dev` não
aplica a configuração de `headers` do `vercel.json`**, então a regra
`source: "/((?!api/).*)"` **só é verificável em produção**.

**Teste 9, leitura correta em produção:** 429 aparecendo prova que funciona *naquele
momento, naquela instância*; 429 **não** aparecendo não prova nada. É controle
*best-effort*; a defesa real é senha forte + `scrypt`.

---

## 5. Teste 8 — plano completo

O único teste pendente, e o de maior risco: **é o único que toca as duas APIs
externas em modo de escrita**.

### 5.1 Preparação: já existe

Task descartável na lista **Carteira `901327787926`**:

| | |
|---|---|
| Nome | `ZZ TESTE TECNICO — NAO USAR` |
| **taskId** | **`86ajumrcc`** |
| Gerente | `Gian Luca` (exato — é o que faz o escopo e o `responsavelDe` funcionarem) |
| ID Núcleo | `999999` · CNPJ fictício · MRR `1` |

MRR `1` de propósito: faz a *Mensalidade anterior* chegar ao Moskit como `R$ 1,00`.
Com `0` o campo iria vazio e não seria exercitado.

Enquanto ela existir, a carteira tem **704** itens em vez de 703, e ela aparece no
dashboard para Gian Luca e para a Gestão.

**Executar logada como Gian Luca**, não como Gestão: o perfil `csm` exercita uma
verificação a mais (`api/clickup.js`, escopo por carteira na escrita) que a Gestão
pula. É superconjunto.

### 5.2 Fatia 1 — já executada ✅

`Em acompanhamento` `true` → `false` via console, com confirmação no **histórico de
atividade da task no ClickUp**. Resultados:

- **Primeira escrita bem-sucedida do refactor.**
- Cota confirmou o T2 em dado real: **69 → 67** num `set-field` (2 chamadas, contra
  29 antes) e **97 → 69** na leitura da carteira (as 28 estruturais).
- O campo ficou revertido para `false` no ClickUp.

Uma pegadinha descoberta aqui: uma releitura pela API pode vir do **cache do
navegador** (`private, max-age=300`) e mostrar o valor antigo. Para conferir, use
`cache: 'reload'` — **não** `no-store` nem cache-buster, que ignoram a cache na ida
mas não substituem a entrada guardada.

### 5.3 Fluxo A — "Criar negócio no Moskit"

**Cria 1 negócio no Moskit. Não toca no ClickUp.**

| Onde | Valor |
|---|---|
| Endpoint | `POST https://api.moskitcrm.com/v2/deals` |
| Pipeline | **91432** (Renovações) · Etapa **438018** (Novo negócio) · `status: OPEN` |
| Responsável | derivado do gerente — Gian Luca → **144977** |
| Criado por | **133497** |
| Nome, valor | do formulário |

Campos personalizados — 5 sempre, até 5 opcionais:

| Campo | ID | Origem |
|---|---|---|
| ID Núcleo | `CF_g40MLBiYSjOzYD29` | ClickUp, numérico |
| CNPJ | `CF_Lo1qjyidSaYRODer` | ClickUp, numérico |
| Razão social | `CF_oJZmP1iKCQaRzDgv` | ClickUp, texto |
| Mensalidade anterior | `CF_wPVm2Vi2Car10mK6` | ClickUp, `R$ x.xxx,xx` |
| Oportunidade | `CF_dN7MGPioiAKV8meY` | formulário, 1 de 9 ids |
| Plano atual / Base do mês / Origem / Sugestão / Observação | 5 ids | formulário, se preenchidos |

**Conferir no Moskit:** funil 91432, etapa certa, responsável do gerente daquele
cliente, e ID Núcleo, CNPJ, razão social e mensalidade anterior preenchidos.

### 5.4 Fluxo B — "Abrir acompanhamento"

**Cria 1 projeto no Moskit e altera 3 ou 4 campos de UMA task no ClickUp.**

Moskit: `POST /v2/projects`, board **32342**, step **124287** (Nova solicitação),
`archived: false`, nome montado no servidor como
`Acompanhamento - <razão social> - <rótulo do tipo>`, responsável e criador iguais ao
fluxo A, campos TIPO (`CF_3LvDvpH1iGbdrM6a`) e ORIGEM (`CF_POEMyKHZi807bDdk`), mais
CONVERSA e OBSERVAÇÃO se preenchidos.

ClickUp — três `set-field` em paralelo, mais um se houver alertas:

| Campo | `fieldId` | Depois | Reversível pela API? |
|---|---|---|---|
| Em acompanhamento | `94b85690-3d47-4edf-9209-0a671cfb570b` | `true` | **Sim** (aceita `true`/`false`) |
| Etapa | `d15028f2-40c6-44da-a5dc-3d608eef6f48` | `94eb0e3e-…` | **Não** — allowlist tem 1 opção |
| Tipo de solicitação | `a4acad54-a6da-477f-b1fc-b3cbf56bbd08` | 1 de 4 ids | Parcial — troca entre os 4, não limpa |
| Alertas | `6ce5db54-1a1d-4dfa-944d-4b01b8832549` | array selecionado | **Sim** — `[]` é aceito |

**Anote o valor ANTES** de cada campo. Sem isso não há como reverter fielmente. O
modal já abre com leitura fresca via `action=cliente`, então o estado mostrado é o
real.

**Conferir:** projeto no board 32342 e, no ClickUp, os quatro campos atualizados —
**inclusive no histórico de atividade da task**, que é a confirmação mais forte de que
a escrita partiu do proxy com a credencial nova.

### 5.5 Limpeza — nesta ordem

1. **Negócio no Moskit** — funil 91432, etapa "Novo negócio", localize pelo nome,
   excluir. Se seu usuário não puder excluir: marcar como Perdido e arquivar.
2. **Projeto no Moskit** — board 32342, step "Nova solicitação", excluir ou arquivar.
3. **Task no ClickUp** — excluir `86ajumrcc`. **Os 4 campos vão embora com ela**, o
   que resolve de uma vez os dois que a API não desfaz (*Etapa* e *Tipo*).

O proxy do Moskit **não tem caminho de exclusão**, por desenho (allowlist de duas
ações) — os itens 1 e 2 são necessariamente manuais na interface.

### 5.6 As 7 incógnitas

| # | Incógnita | Estado |
|---|---|---|
| 1 | A escrita no ClickUp realmente grava (`gravarCampo`) | ✅ **fechada** na fatia 1 |
| 2 | Os `fieldId` e ids de opção de `CAMPOS_ESCRITA` são os reais | ⚠️ **parcial** — só o checkbox *Em acompanhamento* foi exercitado. *Etapa*, *Tipo* e *Alertas* seguem não verificados |
| 3 | **O Moskit aceita o corpo remontado** — pipeline, stage, board, step, createdBy, os 14 `CF_*` e o formato de `entityCustomFields` | ⚠️ **parcial.** Os 14 `CF_*`, o formato de `entityCustomFields` e os IDs de opção foram **confirmados contra o Moskit real** — ver seção 11.5. Continua aberto se o POST de criação é **aceito** (pipeline, stage, board, step, createdBy, responsible) |
| 4 | `localizarCliente` extrai ID Núcleo, CNPJ, razão social e mensalidade; `responsavelDe` mapeia o responsável | ⚠️ **parcial** — a extração foi confirmada na pré-checagem da fatia 1; o mapeamento de responsável **não** foi exercitado |
| 5 | O aviso `responsavel_nao_identificado` **não** dispara com gerente válido | ❌ aberta |
| 6 | Mudanças de front do `bb7d366`: mensagem de sucesso, `white-space:pre-line`, modal não fechar quando há aviso | ❌ aberta |
| 7 | S1/`refletirEscrita` refletindo a alteração na tabela | ❌ aberta — o S1 vive dentro de `criarAcompanhamento` e não é acionado por `apiPost` direto do console |

### 5.7 Triagem de erro

Recusas **nossas**, que nunca chegaram ao ClickUp: `campo_nao_permitido` (403, id
fora de `CAMPOS_ESCRITA`), `valor_nao_permitido` (403), `task_fora_do_escopo` (403,
task fora das duas listas), `fora_da_carteira` (403, escopo de CSM).

Recusas **do upstream**: `erro_clickup` **404** → id de campo ou de task errado;
**400** → campo não existe na lista ou tipo incompatível; **502** → nós mapeamos
401/403 do ClickUp para 502, ou seja **problema de credencial/permissão**, não de id;
`limite_clickup` **429** → cota; `nao_configurado` **500** → chave ausente.

**Limitação declarada:** `_lib/clickup.js` **descarta o corpo do erro do ClickUp** de
propósito, e loga só o status. Num 400 você saberá *que* falhou, não *por quê*. Para
descobrir: reproduza a mesma chamada direto contra a API do ClickUp no seu terminal,
ou acrescente **uma linha temporária** de log do detalhe — e remova depois.

---

## 6. Merge

Um único conflito, confirmado por simulação em memória (`git merge-tree`):

```
CONFLICT (modify/delete): dashboard_carteiras.html deleted in origin/main
and modified in HEAD. Version HEAD left in tree.
```

Nada mais conflita: a `main` só apagou esse arquivo; a branch modificou-o e adicionou
os demais.

```powershell
git checkout main
git pull
git merge seguranca/api-proxy-e-auth        # para no conflito
# git status mostra:  deleted by us:  dashboard_carteiras.html
git checkout MERGE_HEAD -- dashboard_carteiras.html
git add dashboard_carteiras.html
git commit
```

`MERGE_HEAD` é explícito e não depende de número de estágio. Verificado: o blob na
árvore mesclada é idêntico ao da branch, e essa versão está **limpa** de `pk_`,
`apikey`, `Authorization`, `const SENHAS` e `@2026`.

Antes de commitar:

```powershell
git diff --cached --stat      # 11 arquivos, dashboard entre eles
git status --porcelain        # nenhum "U"
node scripts/teste-http.mjs   # 124/124
```

**Não resolva pela interface do GitHub** — o editor de conflitos da web não lida com
modify/delete.

---

## 7. Checklist de verificação em produção

**1. Segredos fora do cliente**
```bash
curl -s https://<dominio>/dashboard_carteiras.html | grep -Ei "pk_|apikey|Authorization"   # vazio
```

**2. Cache — fazer primeiro**
```bash
curl -sI https://<dominio>/dashboard_carteiras.html | grep -i cache-control
#   esperado: s-maxage=300, stale-while-revalidate=600
curl -sI https://<dominio>/api/login | grep -i cache-control
#   esperado: no-store, e NENHUM s-maxage
```
Logada, na leitura da carteira: `private, max-age=300, stale-while-revalidate=600`.
**Se aparecer `s-maxage` aí, pare o deploy** — é vazamento de carteira entre perfis
pela CDN.

**3. CORS** — `http://` do próprio domínio tem de dar **403** em produção:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: http://<dominio>"  https://<dominio>/api/login   # 403
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.test" https://<dominio>/api/login   # 403
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://<dominio>" https://<dominio>/api/login   # 401
```

**4. Sem sessão, sem dado** — `GET /api/clickup?action=carteira` → 401 `sessao_invalida`.

**5. Escopo por CSM** — logada como CSM:
`await (await fetch('/api/clickup?action=carteira')).json()` → todo item com o
`gerente` daquele CSM e só dele. Depois `session.nivel='gestao'; buildTabs();` — as
abas mudam, os dados não.

**6. Corpo malformado não derruba** (era o bloqueador de `416e9c4`):
```bash
for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code} " -X POST \
  -H "Content-Type: application/json" -d '{ isso nao e json' https://<dominio>/api/login; done
# dez 400 seguidos, e o endpoint continua respondendo depois
```

**7. Rate limiting** — 6 senhas erradas; ler o resultado conforme a seção 4.

**8. Sessão expirada nos dois caminhos** — rotacione o `SESSION_SECRET` e confira a
mensagem "Sua sessão expirou" **com a página aberta** e **após F5**.

**9. Cota do ClickUp** — no log da função deve aparecer `[clickup] cota do plano:
100/min` uma vez por instância, e `COTA BAIXA` só sob pressão real.

**10. Log da função** — nenhuma senha, hash ou token em lugar nenhum.
`[login] AUTH_*: valor invalido` só deve aparecer se houver configuração ruim.

---

## 8. Fila de manutenção

### Cache e cota

| # | Item |
|---|---|
| 5 | `fresh=1` para furar o cache da **instância** num refresh explícito. Fecha a defasagem de até 5 min entre instâncias. Custa 28 chamadas por uso; precisa de guarda contra repetição |
| 6 | **ETag + `304`** em vez de equilibrar `max-age`. É a resposta correta de HTTP: sempre fresco, revalidação barata, zero chamadas ao ClickUp com cache quente. **Substituiria os itens 1, 2 e 5** do trabalho de frescor |
| 7 | S2: `set-field` devolver a linha atualizada, em vez de o front remendar localmente |
| 8 | **Eliminar o RMW dos alertas.** Hoje a janela está de volta ao tamanho de antes do refactor (tempo de preencher o formulário), o que é **paridade, não correção**. Fechar exige enviar delta (`add`/`rem`, se o campo de labels do ClickUp aceitar — **verificar antes de prometer**) ou mesclar no servidor. Depende de uma decisão de produto: "estes são os alertas" (substituir) ou "acrescente estes" (unir) — a interface atual não distingue |
| T4 | Retry com backoff no 429, limitado. Inútil se o `Retry-After` for grande: a função tem prazo |
| T5 | Os 3 `set-field` em sequência em vez de `Promise.all`. Pouco relevante depois do T2 |
| S4 | Cache compartilhado (Vercel KV/Upstash). **Recusado por ora**: dependência nova e escopo próprio |

### Correções conhecidas, não feitas

| Item | Onde | Risco |
|---|---|---|
| ~~`getMetas` não pagina~~ | `_lib/clickup.js` | ✅ **resolvido** — pagina com lote 1, mantendo 1 chamada até 100 linhas |
| ~~Duas linhas abertas do mesmo CSM~~ | front | ✅ **resolvido** pelo filtro de período: CSM duplicado no período tem o número escondido, com aviso |
| `opcaoPermitida` devolve `null` e o campo é **omitido em silêncio** do negócio: `plano`, `base` e `origem` inválidos não viram erro | `moskit.js` | Negócio criado incompleto sem ninguém saber. Contraste: `oportunidade` e o `tipo`/`origem` do projeto devolvem 400 |
| `soNumero` → `0` quando não numérico | `moskit.js` | ID Núcleo ou CNPJ `0` no Moskit, em silêncio |
| `cfVal` → `null` para campo ausente | `_lib/clickup.js` | Se um id de campo mudar no ClickUp, a coluna inteira vira `null` sem erro. Com o match exato de gerente, isso daria **carteira vazia para todos** |
| `criado?.id ?? null` + `r.json().catch(() => ({}))` | `moskit.js` | Resposta 2xx sem id vira `{ok:true, id:null}`, e a tela mostra "ID: null" |
| `login.js` limpa **todos** os contadores acima de 5000 entradas | `login.js` | Quem consegue 5000 IPs (ou 5000 valores de `X-Forwarded-For`) zera o rate limiting de todo mundo |
| `X-Forwarded-Host` + `Origin` forjados fazem a função ecoar `Access-Control-Allow-Origin` para origem arbitrária | `_lib/http.js` | **Não explorável por navegador**: `XFH` não é safelisted, dispara preflight, e `Access-Control-Allow-Headers` só permite `Content-Type`. Fechar exigiria parar de usar `XFH` para montar a origem — não fiz sem poder testar em produção |
| `N`/`r` do scrypt limitados a `PARAMS_ACEITOS` | `_lib/auth.js` | **Já corrigido** em `161c87f`. Ao aumentar o custo no futuro: **adicione** a tupla nova e **mantenha** a antiga até todos os hashes serem regerados |

### Visual

| Item | Detalhe |
|---|---|
| **Cores fora da paleta da marca** | Reportado pela usuária; **especificação pendente**. Falta o inventário de quais cores e qual é a paleta oficial da Londrisoft. As cores atuais estão em variáveis CSS no topo do `dashboard_carteiras.html` |

---

## 9. Funcionalidades pedidas e ainda não feitas

Cinco pedidos originais que **não** foram implementados — o trabalho até aqui foi
todo de segurança e de correções que ele expôs. **A especificação detalhada de cada
um não está neste documento**; confirmar com a usuária antes de implementar.

| # | Funcionalidade | O que se sabe |
|---|---|---|
| 1 | **Campo Evento Camp 2026 editável** | ✅ **feita** na branch `melhorias/periodo-metas-evento-camp`, com limpeza do campo inclusa. O `DELETE` ainda não foi exercitado contra o ClickUp real — roteiro em 12.3 |
| 2 | **Filtro de cidade** | ✅ **feita** em `4bb90c7` |
| 3 | **Excluir do MRR perdido o churn por "Contratou em outro CNPJ"** | ✅ **feita** em `ebddcf6` |
| 4 | **Valor exato no card de MRR incrementado** | ✅ **feita** em `d964b56`. A dúvida "incremento do mês ou acumulado" não existia: o card sempre foi a soma de *MRR Atingido* das linhas de meta, e só a formatação mudou |
| 5 | **Premiação total no painel do gerente** | ✅ **feita** em `7bc2fbf`, como bloco consolidado de meta de equipe. `consulta` continua recebendo `0` e agora `metaEquipe: null` |

---

## 10. Ordem sugerida a partir daqui

1. **Deploy da branch atual.** O commit `2e32cbe` corrige número errado em tela — ver
   seção 11.1. É o item mais urgente.
2. **Teste 8** — os dois fluxos com a task `86ajumrcc`, limpeza na ordem da seção 5.5.
   Fecha as incógnitas 2 a 7. É o maior risco técnico restante.
3. **Checklist de produção** da seção 7, começando pelo item 2 (cache).
4. **Fila de manutenção** — os itens 8 e 6 primeiro: o 8 é o único com risco de perda
   de dado, e o 6 substitui três remendos por uma solução só.
5. **Funcionalidade 1 da seção 9**, a única que restou.

---

## 11. Branch `melhorias/filtros-metas-equipe`

Cinco commits sobre a `main`, **sem push e sem merge**. Suíte em **184/184**.

| Commit | Assunto |
|---|---|
| `ebddcf6` | Migração de CNPJ fora do MRR perdido do resumo |
| `4bb90c7` | Filtro por cidade com normalização |
| `d964b56` | Valores de meta sem abreviação |
| `2e32cbe` | **`mrrEquipe` declarado pela linha de equipe, não somado** |
| `7bc2fbf` | Régua de progresso da equipe com aviso de divergência |

As regras que cada um implementa estão no README, seção *Regras de cálculo e exibição
no dashboard* e *A meta da equipe é declarada, não somada*. Aqui fica só o que não
cabe lá.

### 11.1 Por que o deploy é urgente

`somarMrrEquipe` somava **todas** as linhas da lista Metas. Com a linha
`🎯 Meta — Equipe | Jul/2026` declarando o total, ele entrava duas vezes:

| | |
|---|---|
| soma das 4 individuais | R$ 11.067,76 ← correto |
| linha de equipe (declarado) | R$ 11.028,76 |
| **`mrrEquipe` em produção** | **R$ 22.096,52** |
| ultrameta de equipe | R$ 17.295,18 |

Resultado: o painel anuncia **"Ultrameta equipe! +R$ 200"** para os quatro CSMs,
quando o correto é supermeta, **+R$ 100**. Número errado em tela, afetando o bônus
que quatro pessoas estão vendo.

**Eram três números errados, não um** — confirmado em produção pela usuária. Os cards
**📈 MRR Incrementado** e **📉 Perdido Downsell** saem de `metasData.reduce(...)` no
front, e `metasData` era `tasks`, que trazia a quinta linha:

| Card | Antes | Correto |
|---|---|---|
| 📈 MRR Incrementado | R$ 22.518,32 | R$ 11.259,16 |
| 📉 Perdido Downsell | R$ 421,80 | R$ 191,40 |
| Bônus equipe | ultrameta, +R$ 200 | supermeta, +R$ 100 |

`2e32cbe` corrige os três de uma vez, porque a raiz é a mesma: a linha de equipe deixa
de viajar dentro de `tasks`. Nenhuma conta do front precisou mudar — o que mostra que
tirar a linha do array foi a correção certa, e não filtrar em cada `reduce`.

Os cards de gestão por gerente **não** eram afetados: usam `metasData.find(...)` por
nome de gerente, e `⭐ Equipe` não casa com nenhum.

**Mitigação sem deploy:** fechar a tarefa `86ajvcgc7` no ClickUp. `include_closed=false`
a remove da resposta e a soma volta ao valor correto. Não é instantâneo — `getMetas`
tem cache de 5 min por instância e a resposta vai ao navegador com `max-age=300`, então
pode oscilar por alguns minutos. Reversível e sem perda: os valores digitados
permanecem. **Reabrir depois do deploy** para ativar a leitura declarada e o aviso de
divergência.

### 11.2 Pendências no ClickUp — ação da usuária

| # | Item | Efeito no código |
|---|---|---|
| 1 | A linha `⭐ Equipe` (`86ajvcgc7`) está com *Mês Referência* = **Junho**, enquanto o nome diz `Jul/2026` e as quatro individuais dizem **Julho** | **Nenhum** — o período não é filtrado por mês. Mas é erro de digitação na linha que declara os totais |
| 2 | Divergência de **R$ 39,00**, toda em downsell: declarado `230,40` contra `191,40` na soma das individuais. *MRR Atingido* bate exatamente (`11.259,16`) | Nenhum. O aviso de divergência (`7bc2fbf`) passa a exibi-la para a gestão. A origem é de conferência |
| 3 | O campo `🤝 Bônus Equipe` estava em **200** — erro de digitação, **corrigido para 100** pela usuária | Nenhum: o código não lê esse campo, usa `BONUS_EQ_VAL`. Virou decisão pendente — ver abaixo |

### 11.2.1 Decisão pendente: `🤝 Bônus Equipe` como fonte da verdade?

Hoje o valor do bônus vem de `BONUS_EQ_VAL` (`{super:100, ultra:200}`), **constante no
front**. O campo `🤝 Bônus Equipe` (`c6585dcb-c590-411d-9213-517b7f3c119c`, currency) da
linha de equipe existe e é preenchido à mão, mas **o código o ignora**.

A pergunta: ele deve virar a fonte da verdade do bônus, como fizemos com os limiares em
`2e32cbe`? **Não implementado — decidir antes.**

O que pesa a favor: mesma direção dos limiares, e mudar o bônus deixaria de exigir
deploy. O que pesa contra, e é a diferença real em relação aos limiares: os limiares são
**um por faixa** e cada linha declara os quatro, enquanto este campo é **um valor só**.
Ele não diz de qual faixa é — o `200` de agora era o bônus da ultrameta enquanto o
líquido só alcançava a supermeta, e foi justamente esse descasamento que produziu o erro
de digitação. Usá-lo como fonte exigiria decidir se ele é "o bônus da faixa atingida
hoje" (derivável, portanto redundante e sujeito a divergir) ou "o bônus desta faixa"
(precisaria de quatro campos, um por faixa, como os limiares).

Recomendação, para quando for decidir: **quatro campos, um por faixa**, ou manter a
constante. Um campo único com semântica ambígua é a pior das três.

### 11.3 Decisões tomadas, para não serem re-litigadas

- **Cabeçalho de Cancelamentos continua somando tudo**, inclusive migração de CNPJ.
  Ele precisa fechar com a soma da coluna MRR das linhas logo abaixo. Só o card do
  resumo exclui.
- **Rótulos da régua seguem abreviados** (`fmtc`). São alvos, mas ali se lê posição, e
  são `position:absolute` — valor exato sobreporia o marcador vizinho.
- **Quebra em duas linhas do card MRR Incrementado abaixo de ~420px** é aceita. Nada é
  cortado; a linha de cards fica mais alta. Nenhuma fonte foi reduzida.
- **Downsell não está contaminado por motivo de perda.** Investigado e **encerrado**:
  downsell é negócio perdido com motivo próprio "Downsell", fluxo separado que não
  entra em relatório de cancelamento e não se mistura com os outros motivos. `mrrLiq`,
  `mrrEquipe` e o card *Perdido Downsell* saem da lista Metas, e nenhuma regra de
  `motivoPerda` os alcança. **Não reabrir.**
- **O bloco de equipe mostra as quatro faixas, não três.** A linha do ClickUp tem
  *Meta Especial* preenchida (R$ 20.000) e a tabela na descrição das tarefas
  individuais também a lista, com "bônus surpresa". Reverter para três é apagar uma
  linha em `renderEquipe`.

### 11.6 Branch seguinte: `melhorias/periodo-metas-evento-camp`

Sai da `main` em `f0ce524` (já mesclada e no ar). **Sem push e sem merge.**
Suíte em **261/261**.

| Commit | Assunto |
|---|---|
| `2d34a93` | Filtro de período por Ano Base e Mês Referência |
| *este* | Campo Evento: Camp 2026 editável |

As regras estão no README, em *Período das metas* e na tabela de `set-field`.

#### 12.1 Ação sua no ClickUp: apague o status `concluído`

A lista Metas tem **quatro** status, não três. Além de `mês atual` (`open`),
`meses fechados` (`custom`) e `finalizado` (`closed`), existe **`concluído`, tipo
`done`** — quase certamente resto do template.

O que `include_closed=false` faz com `done` (em oposição a `closed`) não é documentado
de forma confiável, e **não deu para verificar**: as cinco linhas estão todas em
`mês atual`. Enquanto esse status existir, há um caminho para uma linha ficar invisível
no painel.

Para verificar em vez de apagar: marque uma linha descartável como `concluído` e veja
se ela continua aparecendo no seletor de período.

O desenho não depende da resposta — o seletor é montado do que chegou, então um período
que desapareça **falta visivelmente** — mas o status é ruído com risco anexado.

#### 12.2 Limpar o Evento: Camp 2026 — implementado

Decidido e feito. `limparCampo()` com `DELETE`, marcador `limpavel: true` só na entrada
do Camp, e `value: null` aceito apenas nos campos marcados. Detalhes no README.

**O `DELETE` nunca falou com o ClickUp de verdade.** A suíte prova a nossa metade —
método, endpoint, allowlist, escopo por perfil e o corpo vazio — mas que o ClickUp
aceite `DELETE` nesse endpoint segue sendo suposição baseada na documentação. É a
mesma classe de incógnita da 5.6, e o roteiro de verificação está em 12.3.

#### 12.3 Verificação do DELETE — reversível, sem sujar dado

Escolher um cliente com o *Evento: Camp 2026* **vazio**, marcar uma opção e limpar
devolve exatamente o estado inicial. Nada a desfazer se der certo, nada perdido se
der errado.

1. No painel, filtre um cliente cujo Camp esteja `—` na coluna **Camp 2026**. Anote o
   ID Núcleo — é o estado a restaurar.
2. Abra o cliente, escolha **Convidado 💠**. Esperar `✓ salvo` e o badge azul na
   tabela.
3. No ClickUp, abra a task: o campo deve estar em *Convidado 💠*, e o **histórico de
   atividade** deve registrar a mudança. O histórico é a confirmação mais forte de que
   a escrita partiu do proxy com a credencial do servidor.
4. Volte ao painel e escolha **— sem marcação —**. Esperar `✓ limpo` e a coluna voltar
   a `—`.
5. No ClickUp, confirme o campo **vazio** e uma **segunda entrada** no histórico. Essa
   é a prova de que o `DELETE` funcionou.

Se o passo 4 mostrar `✕ não limpou`: o `DELETE` foi recusado. O seletor reverte
sozinho, o dado no ClickUp continua em *Convidado 💠*, e aí basta limpar pelo ClickUp
para voltar ao estado inicial. No log da função vai aparecer
`[clickup] acao=set-field upstream=<status>` — **405** significaria que o ClickUp não
aceita `DELETE` ali, e o caminho passaria a ser `POST` com um valor sentinela.

Custo: 4 chamadas no total (2 por gravação).

### 11.4 Campo "Solicitante" no Moskit — encontrado

Para trabalho futuro (rastrear quem pediu a criação). **Nada implementado.**

| Módulo | `CF_` | Tipo | Vínculo |
|---|---|---|---|
| **DEAL** | `CF_POEMywieC56n7Ddk` | `TEXT` | funil **91432** (Base de clientes) |
| **PROJECT** | `CF_x1kq69HnC6WL3DzY` | `TEXT` | sem funil (projetos não têm) |

**IDs distintos por módulo** — não dá para reusar um só. **`TEXT` nos dois, então não
há opções a mapear**: é texto livre, e vale a mesma lição da *Cidade* (agrupar exige
normalizar). Lidos dos registros `48104129` (negócio) e `1689954` (projeto), ambos
devolvendo `"Anderson"`.

**Pegadinha da leitura:** o valor **não** vem em `value`. O `entityCustomFields` usa
`textValue`, `numericValue` ou `options` conforme o tipo:

```json
{ "id": "CF_POEMywieC56n7Ddk", "textValue": "Anderson" }
{ "id": "CF_g40MLBiYSjOzYD29", "numericValue": 10748 }
{ "id": "CF_Lo1qjyiPiaYQNDer", "options": [569294] }
```

Um leitor que procure `.value` acha o campo e reporta vazio — foi o que aconteceu na
primeira varredura desta investigação.

**Duas armadilhas da API, para a próxima varredura:**

- `GET /v2/customFields` devolve **10** campos e **ignora todo filtro** (`module`,
  `limit`, `page`, `active`). Não é inventário: o *Solicitante* não estava lá, e vários
  campos que o `moskit.js` já usa também não. O caminho confiável é ler registros reais.
- `GET /v2/deals?limit=100` devolve **10**. O `limit` não é respeitado — pagine de
  verdade.
- `GET /v2/persons` e `/v2/tasks` dão **404**: campos de PERSON são invisíveis por aqui.

### 11.5 Incógnita 3 quase fechada, de graça

A varredura acima validou o que a seção 5.6 listava como **maior risco do refactor** —
os 14 `CF_*` transcritos do HTML antigo sem verificação. Contra o Moskit real:

- **Os 10 `CF_DEAL` batem exatamente**, todos presentes no negócio `48104129` do funil
  91432, com os nomes esperados.
- **Os 4 `CF_PROJ` existem e têm os nomes certos** (`Tipo de solicitação`,
  `💠 Origem da solicitação`, `O que você gostaria de conversar…`, `Observação`).
- **O formato de `entityCustomFields` que o `moskit.js` monta está correto**: ele já usa
  `numericValue` / `textValue` / `options`, que é exatamente o que a API devolve.
- **Os IDs de opção são numéricos e estão nas allowlists.** O negócio real trazia
  `569294` (Plano atual), `569448` (Base do mês), `608597` (Oportunidade) e `695069`
  (Origem) — todos dentro de `OPC_PLANO`, `OPC_BASE_MES`, `OPC_OPORTUNIDADE` e
  `OPC_ORIGEM_DEAL`, e com o mesmo tipo (número, não string).

**O que continua aberto:** se o Moskit **aceita o POST** com `pipeline`, `stage`,
`board`, `step`, `createdBy` e `responsible` como o servidor os monta. Os campos e o
formato deixaram de ser incógnita; o corpo da criação, não. O teste 8 fica menor, mas
não desnecessário.
