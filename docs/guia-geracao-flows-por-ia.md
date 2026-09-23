# Guia Completo dos Nodes do Waipe Flow — para humanos e para IAs geradoras de flows

**Última sincronização doc ↔ código:** 2026-09-10

> **Propósito deste documento**: ser a referência única e autossuficiente sobre como os nodes do Waipe Flow funcionam e sobre o formato JSON de um flow. Ele foi escrito para dois públicos ao mesmo tempo:
>
> 1. **Pessoas não técnicas** — a Parte 1 explica os conceitos em linguagem simples.
> 2. **Pessoas técnicas e IAs (LLMs)** — as Partes 2 a 7 contêm a especificação exata do JSON, todos os parâmetros de cada node, limites, regras de validação e exemplos completos prontos para importar.
>
> **Uso previsto**: cole este documento em outra IA (ChatGPT, Claude, Gemini etc.) e peça: *"gere um flow do Waipe Flow que faça X"*. O JSON gerado pode ser importado diretamente no Waipe Flow em **Dashboard → Importar JSON** (ou no editor, menu **⋯ → Importar JSON…**), colando o texto ou enviando um arquivo `.json`.

---

## Parte 1 — Conceitos fundamentais (leitura para todos)

### O que é um flow?

Um **flow** é uma automação: uma receita que o sistema executa sozinho. Pense em uma linha de montagem: os dados entram por uma porta (o **gatilho**), passam por várias estações de trabalho (os **nodes**) e cada estação transforma, filtra, decide ou envia esses dados para algum lugar.

Exemplos de flows:

- "Todo dia às 9h, buscar os pedidos da API da loja, filtrar os atrasados e avisar por webhook."
- "Quando alguém enviar um formulário (webhook), classificar o texto com IA e responder na hora."

### Os três blocos de um flow

| Bloco | O que é | Analogia |
|---|---|---|
| **Node (nó)** | Uma etapa da automação. Cada node tem um **tipo** (o que ele faz) e **parâmetros** (como ele faz). | Uma estação da linha de montagem |
| **Edge (conexão/aresta)** | Uma seta que liga a saída de um node à entrada de outro. Define a ordem. | A esteira entre duas estações |
| **Gatilho (trigger)** | O node especial que inicia o flow. Todo flow tem **exatamente 1** gatilho. | O botão que liga a linha |

### Regra de ouro: o flow é um DAG

O grafo de nodes **nunca pode ter ciclo** (um caminho que volta para um node anterior). Isso se chama **DAG** — grafo direcionado acíclico. A importação **rejeita** qualquer flow com ciclo. Repetições são feitas com o node **Loop** (que fatia um array em lotes), nunca com setas de retorno.

### Como os dados viajam entre os nodes

Os dados trafegam sempre no mesmo formato: uma **lista de itens**, onde cada item é um envelope `{ "json": { ... } }`:

```json
[
  { "json": { "nome": "Ana",  "idade": 31 } },
  { "json": { "nome": "Beto", "idade": 45 } }
]
```

- Cada node recebe a lista produzida pelo node anterior e produz uma nova lista.
- A maioria dos nodes processa **item por item** (ex.: o HTTP Request faz **uma requisição por item de entrada**).
- Um flow disparado por agendamento começa com um único item vazio: `[{ "json": {} }]`. Um flow disparado por webhook começa com os dados da requisição HTTP recebida.

### Expressões `{{ }}` — o "cola dados aqui"

Dentro de muitos campos de parâmetro você pode escrever **expressões** entre chaves duplas para usar dados dinâmicos:

- `{{ $json.email }}` → o campo `email` do item atual
- `Olá, {{ $json.nome }}!` → mistura texto fixo com dados
- `{{ $node["Buscar Pedidos"].json.total }}` → um campo da saída de outro node, pelo **nome** do node

A Parte 3 documenta a sintaxe completa.

### Catálogo resumido dos 21 tipos de node

| `type` (exato) | Nome | Categoria | O que faz em uma frase |
|---|---|---|---|
| `trigger_manual` | Gatilho Manual | Gatilho | Inicia o flow quando o usuário clica em "Executar". |
| `trigger_schedule` | Agendamento | Gatilho | Inicia o flow em horários programados (diário, semanal, cron…). |
| `trigger_webhook` | Webhook | Gatilho | Inicia o flow quando uma URL pública recebe uma requisição HTTP. |
| `webhook_respond` | Responder Webhook | Integração | Define a resposta HTTP devolvida a quem chamou o webhook. |
| `edit_fields` | Editar Campos | Lógica | Cria, renomeia ou transforma campos dos itens. |
| `filter` | Filtro | Lógica | Deixa passar só os itens que atendem às condições; descarta o resto. |
| `if` | IF (Se) | Lógica | Roteia todos os itens para a saída **true** ou **false** conforme condições. |
| `switch` | Switch | Lógica | Roteia os itens para uma entre **N saídas nomeadas** conforme o valor de um campo. |
| `loop` | Loop | Lógica | Itera um array em lotes: o corpo (saída `loop`) executa uma vez por lote; a saída `done` continua ao final. Tetos padrão de 50.000 elementos e 50.000 lotes — acima disso a execução **falha** (não trunca). |
| `split_out` | Split Out | Lógica | Divide um array embutido em um item em N itens independentes (1 elemento = 1 item). |
| `merge_out` | Merge Out | Lógica | Junta N itens em **um único** item com os dados em arrays (o inverso do `split_out`; equivale ao "Aggregate" do n8n). |
| `code` | Código (JS) | Lógica | Executa JavaScript em sandbox para transformações livres. |
| `http_request` | HTTP Request | Integração | Chama qualquer API externa (GET/POST/…), com auth, body e paginação. |
| `waipe_ai` | Waipe AI | Integração | Envia uma mensagem a um modelo de IA (GPT, Gemini, DeepSeek) e anexa a resposta ao item. |
| `waipe_data` | Waipe Data | Integração | Busca dados nativos da plataforma Waipe (Gestor, Unique, Modelo Especialista, Data Lab). |
| `gmail_send` | Gmail: Enviar Email | Integração | Envia **um email por item de entrada** pela conta Google conectada via OAuth2. Requer uma credencial `google_oauth2` (conectada em Credenciais → "Conectar com Google"). |
| `google_sheets` | Google Sheets | Integração | Lista, cria, lê e escreve planilhas do Google Sheets. Requer a mesma credencial `google_oauth2` do Gmail. |
| `google_drive` | Google Drive | Integração | Busca arquivos/pastas, lê conteúdo e obtém metadados do Drive (somente leitura). Requer a mesma credencial `google_oauth2`. |
| `google_docs` | Google Docs | Integração | Busca, lê, **cria** e **atualiza** documentos do Google Docs. Requer a mesma credencial `google_oauth2` (com os escopos `documents` e `drive.file`). |
| `trigger_zapi` | Z-API: Mensagem Recebida | Gatilho | Inicia o flow quando a instância Z-API recebe uma mensagem de WhatsApp, com o payload já normalizado em português. |
| `zapi_send` | Z-API: Enviar WhatsApp | Integração | Envia **uma mensagem de WhatsApp por item de entrada** pela Z-API (texto, link, imagem, vídeo, documento, botões, listas). Requer uma credencial `zapi`. |

> **Importante para IAs geradoras**: estes são os **únicos** tipos válidos. Não existem nodes de "delay" nem de "banco de dados", e **não existe um node de "merge de dois ramos"** — `merge_out` agrega os itens de **um** ramo (N itens → 1 item). Para juntar dois ramos diferentes, aponte as edges dos dois para o **mesmo node**: o motor junta as saídas concatenando os itens (ver §2.6). Para enviar e-mail, use `gmail_send`; para WhatsApp, `zapi_send`. Qualquer `type` fora desta lista faz a importação **falhar**.

---

## Parte 2 — O formato JSON de importação (especificação exata)

### 2.1 Documento raiz

```json
{
  "waipe_flow_version": "2",
  "name": "Nome do Flow",
  "description": "Opcional — o que este flow faz",
  "triggerType": "manual",
  "scheduleConfig": null,
  "webhookMethod": null,
  "nodes": [ ... ],
  "edges": [ ... ]
}
```

| Campo | Tipo | Obrigatório | Regras |
|---|---|---|---|
| `waipe_flow_version` | string | Não (recomendado) | Aceitas: `"1"` e `"2"`. Ausente → tratado como `"1"`. Qualquer outro valor → **importação rejeitada**. Use `"2"`. |
| `name` | string | Não | Default `"Flow importado"`. Máximo **200 caracteres** (o excesso é truncado). |
| `description` | string | Não | Texto livre. |
| `triggerType` | string | Não | Só aceita `"schedule"`, `"webhook"` ou `"manual"`. Deve ser coerente com o node de gatilho presente. **Não existe `"zapi"`**: um flow com `trigger_zapi` usa `"webhook"` (o gatilho Z-API é um webhook por baixo). Valor fora da lista é **descartado** e o flow entra como `manual` — sem URL de webhook. |
| `scheduleConfig` | objeto ou null | Não | Só faz sentido com `triggerType: "schedule"` — ver §4.2 (usa a chave `type`, não `scheduleType`). |
| `webhookMethod` | string ou null | Não | Método HTTP do webhook (ex.: `"POST"`). Normalmente derivado dos parâmetros do node. |
| `webhookConfig` | objeto ou null | Não | Configuração **de runtime** do webhook, gravada em `flows.webhook_config` e lida pela rota pública. Chaves (validadas por Zod, objeto `strict`): `responseMode` (`"immediate"` \| `"on_complete"` \| `"by_node"`), `syncMaxWaitMs` (2.000–600.000, default 120.000), `maxBodyBytes` (64–50.000.000), `allowedIps` (array de IP/CIDR, máx. 256), `blockCommonBots` (boolean). Objeto inválido → **importação rejeitada** (`webhookConfig inválido`). Ver §4.3. |
| `nodes` | array | **Sim** | Array de nodes (ver 2.2). Deve ser um array (pode até ser vazio, mas um flow útil precisa de gatilho). |
| `edges` | array | **Sim** | Array de conexões (ver 2.3). |

Campos extras da exportação (`exportedAt`, `source`, `graphReflects`, `status`, `tags`) são ignorados na importação — não precisam ser gerados.

### 2.2 Estrutura de um node

```json
{
  "id": "n1",
  "type": "http_request",
  "name": "Buscar Pedidos",
  "position": { "x": 400, "y": 200 },
  "parameters": { "method": "GET", "url": "https://api.exemplo.com/pedidos" },
  "disabled": false
}
```

| Campo | Tipo | Obrigatório | Regras |
|---|---|---|---|
| `id` | string | **Sim** | Não vazio e **único** no flow. Pode ser `"n1"`, `"n2"`… ou um UUID. |
| `type` | string | **Sim** | Um dos **21** tipos exatos da Parte 1. Tipo desconhecido → importação rejeitada. |
| `name` | string | Não (recomendado) | Default = `id`. É o rótulo no canvas **e a chave usada em `$node["nome"]`** nas expressões — o nome tem de ser **único no flow** e descritivo. Desde 2026-08-18 o editor numera o nó novo cujo nome já existe e **recusa** renomear para um nome ocupado; o gerador de flow do Copilot **reprova** um flow com nomes repetidos. A importação de JSON não bloqueia (ver §2.5), mas o resultado é o mesmo: as saídas colidem. |
| `position` | objeto | **Sim** | `{ "x": número, "y": número }` — números finitos. `x` cresce para a direita, `y` para baixo. Sugestão: ~300px de espaçamento horizontal entre nodes; ramos do IF/Switch com ±150px de deslocamento vertical. |
| `parameters` | objeto | Não | Configuração do node (Parte 4). Chaves omitidas recebem os **defaults automaticamente** (merge). Parâmetros que violem o schema do tipo → importação rejeitada com a mensagem `"Parâmetros inválidos no nó {id} ({type})"`. |
| `disabled` | boolean | Não | `true` = node desativado: não executa; o fluxo segue direto pela primeira conexão de saída. |

### 2.3 Estrutura de uma edge (conexão)

```json
{ "id": "e1", "source": "n1", "target": "n2" }
{ "id": "e2", "source": "n2", "target": "n3", "sourceHandle": "true" }
```

| Campo | Tipo | Obrigatório | Regras |
|---|---|---|---|
| `id` | string | **Sim** | Não vazio; use ids únicos (`"e1"`, `"e2"`…). |
| `source` | string | **Sim** | `id` de um node existente (de onde sai a seta). |
| `target` | string | **Sim** | `id` de um node existente (para onde vai a seta). |
| `sourceHandle` | string | Condicional | **Obrigatório** para saídas de `if`, `switch` e `loop` (ver 2.4). **Omitir** para todos os outros tipos. |
| `targetHandle` | string | Não | **Sempre omitir** — os nodes têm uma única entrada sem id. |

### 2.4 Handles — as saídas nomeadas de IF, Switch e Loop

| Node de origem | `sourceHandle` das edges de saída |
|---|---|
| `if` | Exatamente `"true"` e `"false"` (minúsculas). Uma edge por handle. |
| `switch` | O `outputLabel` **exato** de cada regra (ex.: `"case_1"`, `"aprovado"`). Se `fallbackEnabled: true`, a saída de fallback usa o `fallbackLabel` (default `"Outros"`). |
| `loop` | `"loop"` (corpo, executado por lote) e `"done"` (continuação). Uma edge por handle — ver §4.9. |
| Todos os demais | Sem `sourceHandle` (omitir o campo). |

Regras adicionais:

- **Uma edge por handle** — vale para `if`, `switch` e `loop`: o editor bloqueia duas edges saindo do **mesmo** handle.
- **Nodes comuns (sem handles nomeados) podem ter várias edges de saída** e o motor executa **todos** os ramos — ver §2.6.
- Ramo do IF **não conectado** → os itens daquele ramo são **descartados silenciosamente** (não é erro).
- No `switch`, se nenhuma regra casar e não houver fallback conectado, o motor segue uma rota "default": a primeira edge **sem** `sourceHandle`; senão uma edge com handle `"default"`/`"fallback"`; senão a **primeira edge** da lista. Para comportamento previsível, **sempre conecte o fallback** ou cubra todos os valores possíveis.

### 2.5 Regras de validação da importação (todas)

A importação é **rejeitada** se qualquer uma destas regras for violada:

1. A raiz deve ser um objeto JSON com `nodes` e `edges` como arrays.
2. `waipe_flow_version` deve ser `"1"`, `"2"` ou ausente.
3. Todo node precisa de `id` (string não vazia), `type` conhecido e `position.x`/`position.y` numéricos.
4. Os `parameters` de cada node devem passar na validação (Zod) do seu tipo.
5. **No máximo 1 node de gatilho** (qualquer `type` que comece com `trigger_`).
6. Toda edge precisa de `id`, `source` e `target` não vazios, e `source`/`target` devem referenciar nodes existentes.
7. O grafo deve ser **acíclico** (DAG).
8. Strings de parâmetros que contêm `{{` não podem conter os **tokens proibidos** (ver §3.5). Exceção: `jsCode` do node `code` é código bruto e está isento.

O que a importação **não** verifica (mas quebra o flow — garanta na geração):

- **`id` de node repetido**: não é rejeitado; o motor indexa os nodes por `id` e um duplicado é perdido.
- **`name` de node repetido**: não é rejeitado; como `$node["Nome"]` resolve pelo nome, duas saídas colidem na mesma chave — o último node a executar sobrescreve o outro e as expressões que apontavam para ele devolvem **vazio, sem erro**. O worker loga um aviso ao carregar o flow e o editor avisa ao abri-lo (ver [`nomes-de-no-unicos.md`](../03-backend-worker/nomes-de-no-unicos.md)).
- **Coerência entre `triggerType` da raiz e o node de gatilho**: valores incoerentes passam na importação e produzem um flow que não dispara como esperado.

### 2.6 Regras de execução do grafo (semântica do motor)

Conhecê-las evita gerar flows que "importam mas não fazem o esperado":

- A execução começa no **primeiro node de gatilho** do array `nodes`. Daí em diante o motor usa um **escalonador dataflow em ordem topológica** (Kahn com buffer de entradas): um node só executa quando **todos** os seus pais já se resolveram. Empates são desfeitos pelo **menor `id` de node** (ordem alfabética), o que torna a sequência reproduzível. Cada node executa **no máximo uma vez** por travessia (o corpo de um `loop` é uma travessia própria, repetida por lote).
- **Fan-out é suportado**: um node comum com **várias** edges de saída entrega a sua saída a **todos** os filhos, e todos executam. Cada ramo recebe uma **cópia** dos itens (cópia rasa do `json` de topo), de modo que um ramo alterando campos de topo não contamina os irmãos. `switch` com `matchMode: "all"` continua a existir, mas já **não** é a única forma de abrir rotas paralelas.
- **Merge é suportado**: vários nodes apontando para o mesmo node (losango) fazem esse node executar **uma vez**, recebendo a **concatenação** dos itens de todos os pais que entregaram dados (na ordem determinística de resolução dos pais). É assim que se juntam dois ramos — não existe node de "merge de ramos".
- "Paralelo" aqui é **topológico, não concorrente**: a execução continua single-threaded e determinística; o que mudou é o motor percorrer múltiplos ramos em vez de uma cadeia só.
- Ramos mortos propagam: um node cujos pais **todos** deram skip (ramo não escolhido de `if`/`switch`, `filter` que esvaziou) não executa, fica `skipped` e propaga o skip adiante — junções não travam esperando um ramo morto.
- Nodes não visitados ao final ganham status `skipped`.
- Node `disabled` não executa e **encaminha o próprio input a todos os filhos** (um `loop` desativado segue só pela saída `done`).
- Se um node falha (sem mecanismo de "continuar em erro"), **o flow inteiro para** com status `failed`. Se o usuário interromper a execução (botão Parar), os nodes em curso ficam `cancelled`.
- Nos registros de execução, valores de chaves sensíveis (`token`, `secret`, `password`, `apikey`, `authorization`, `cookie`, `credential`…) aparecem mascarados como `••••••••` — apenas na exibição; a execução usa os valores reais.

> **Nota de compatibilidade (mantenedores)**: o fan-out/merge é o **padrão** do motor (`WORKER_FANOUT_ENABLED` ausente = ligado). O escape hatch `WORKER_FANOUT_ENABLED=false` reverte ao percurso antigo de **cadeia única**, no qual um node comum com N edges de saída seguia **apenas a primeira** e não havia merge. Só flows executados com o flag desligado sofrem essa limitação. Ver [`docs/03-backend-worker/fan-out-paralelo.md`](../03-backend-worker/fan-out-paralelo.md).

### 2.7 Credenciais — atenção especial

Credenciais salvas (`credentialId`) **nunca** são exportadas — viram o placeholder `"CREDENTIAL_REDACTED"`, que a importação descarta. Consequência para flows gerados por IA:

- **Não invente `credentialId`.** Ao gerar um flow, use `authType` inline (`bearer_inline`, `basic_inline`, `api_key_inline`, `custom_header_inline`) com placeholders óbvios (ex.: `"SUBSTITUA_PELO_TOKEN"`), **ou** use `authType: "credential"` sem `credentialId` e instrua o usuário a selecionar a credencial no painel do node após importar.
- Flows importados entram **inativos/rascunho** — o usuário revisa, configura credenciais e ativa manualmente.
- **Google (Gmail, Sheets, Drive e Docs):** os quatro usam a **mesma** credencial `google_oauth2` — uma conexão Google serve os quatro nodes, com os escopos `gmail.send` + `spreadsheets` + `drive.readonly` + `drive.file` + `documents`. Ao gerar, deixe `credentialId` vazio (string vazia) e instrua o usuário a selecionar/conectar a conta Google no painel do node após importar (contas conectadas antes de um escopo novo precisam de "Reconectar com Google").
- **Z-API (`zapi_send`):** credencial do tipo `zapi`, com `instanceId`, `instanceToken` e `clientToken` — os **três obrigatórios** ao gravar a credencial (desde 2026-09-08; o botão "Testar credencial" consulta o `GET /status` da instância antes de salvar). Esses valores **nunca** entram nos `parameters` do node nem no JSON: deixe `credentialId: ""` e instrua o usuário a selecionar a credencial no painel. O `trigger_zapi` **não** usa credencial — a autenticação é o próprio token secreto da URL do webhook.
- **`pinnedData`** (saída fixada de um node para teste) não faz parte do formato de importação: é removido do export e **descartado** na importação. Não gere esse campo.

---

## Parte 3 — Expressões `{{ }}` em detalhe

### 3.1 Sintaxe

- Uma expressão é **JavaScript** entre `{{` e `}}`, avaliada em sandbox isolado (goja) — nunca `eval` no navegador.
- Em campos de **texto/template** (URL, mensagem, valor de campo…), pode haver **vários** blocos `{{ }}` misturados com texto fixo; o resultado é concatenado como string: `"Pedido {{ $json.id }} — total {{ $json.total }}"`.
- **Objeto ou array em campo de texto vira JSON automaticamente**: se a expressão resolve para objeto/array, o valor entregue ao node seguinte é o **JSON serializado** (`{"a":1}`, `["a","b"]`) — nunca `[object Object]` nem join por vírgula. **Não é preciso escrever `JSON.stringify(...)`** para passar um objeto adiante. Escalares e datas ficam inalterados.
- Alguns campos são avaliados como **valor tipado** (não string) e por isso exigem **exatamente um** bloco `{{ }}`: `arrayExpression` do `loop` e do `split_out`, `fieldExpression` do `switch`, `values` (modo `raw`) e `autoMappingSource` (modo `auto`) do `google_sheets`, e os dois lados de uma condição de `filter`/`if` quando o operador é **tipado** (§4.6). Nesses campos, `{{ $json.lista }}` chega como array de verdade, não como texto.
- Um campo **sem** `{{` é tratado como texto literal.

### 3.2 Variáveis disponíveis (as únicas)

| Variável | Significado | Exemplo |
|---|---|---|
| `$json` | Objeto `json` do **item atual** | `{{ $json.cliente.email }}` |
| `$node["Nome do Node"]` | Saída de um node anterior, pelo **nome** — expõe o item **pareado por índice** com o item atual (`.json`; *clamp* para o último quando os tamanhos divergem; com 1 item de saída, sempre ele) | `{{ $node["Buscar Pedidos"].json.total }}` |
| `$now` | Data-hora atual, string ISO 8601 (RFC3339, UTC) | `{{ $now }}` |
| `$today` | Data atual `AAAA-MM-DD` | `{{ $today }}` |
| `$itemIndex` | Índice (0-based) do item atual | `{{ $itemIndex }}` |
| `$items()` | Função que retorna a lista completa de itens de entrada (`[{json:{...}},…]`) | `{{ $items().length }}` |

JavaScript puro funciona dentro do bloco: ternários (`{{ $json.v > 10 ? "alto" : "baixo" }}`), métodos de string/array (`{{ $json.nome.toUpperCase() }}`), matemática, `JSON.stringify(...)` etc.

> **Formato preferido**: para referenciar a saída de **outro** node, use sempre `$node["Nome do Node"].json.campo` — é o formato que o seletor de variáveis, o autocomplete e o arrastar-e-soltar da interface geram, inclusive quando existe um único node anterior. Reserve `$json` para o **input direto** do node atual (típico em `filter`/`if`/`edit_fields` operando item a item). Ambos são válidos no motor.

### 3.3 Campos `*Mode` — fixo vs. expressão

Campos que aceitam expressão têm uma chave irmã de modo (ex.: `url`/`urlMode`, `message`/`messageMode`, `value`/`valueMode`, `left`/`leftMode`). Valores: `"fixed"` (literal, sem avaliar) ou `"expression"` (avalia os `{{ }}`). Regra prática para geração: **se o valor contém `{{`, defina o `*Mode` correspondente como `"expression"`**; caso contrário, `"fixed"` (ou omita e aceite o default do node).

### 3.4 Limites e comportamento em erro

| Limite | Valor |
|---|---|
| Timeout por expressão | **500 ms** (erro `ExpressionTimeout`) |
| Tamanho máximo do resultado | 256 KB. Exceções com teto próprio de **4 MiB**: `body` do `webhook_respond` (`WEBHOOK_RESPOND_MAX_BODY_BYTES`) e **cada campo** do corpo do `http_request` — editor JSON, pares de campos, form-urlencoded, multipart e `binaryRef` (`HTTP_NODE_MAX_BODY_BYTES`). Estourar o teto **falha o node** (nunca entrega valor vazio). |
| Profundidade de call stack | 64 |

Em erro de expressão: o node falha e derruba o flow, **exceto** no `if` (cai no ramo `false`) e no `switch` (cai na rota default/fallback).

### 3.5 Tokens proibidos (blocklist léxico)

Qualquer string de parâmetro que contenha `{{` é rejeitada na gravação/importação se contiver algum destes tokens:

```
constructor, __proto__, prototype, import, require, eval, fetch,
XMLHttpRequest, WebSocket, localStorage, sessionStorage, document,
window, globalThis, self, top, parent, Function, setTimeout, setInterval
```

Isso vale inclusive para nomes de campos dentro da expressão (ex.: `{{ $json.parent }}` é rejeitado). A busca usa **limite de palavra**, então `{{ $json.fetch_data }}` e `{{ $json.my_window }}` passam, mas `{{ $json.imported }}` é bloqueado (`import` casa dentro da palavra) — ao gerar, evite nomes de campo que **comecem** por um token proibido. Única exceção: o parâmetro `jsCode` do node `code` (código bruto, validado apenas pelos limites do sandbox — que de todo modo **não oferece** `require`, `fetch`, `process`, `setTimeout` etc.).

---

## Parte 4 — Referência completa de cada node

Convenções das tabelas: **chave** = nome exato em `parameters`; parâmetros omitidos assumem o default. Todos os nodes têm **1 entrada** (exceto gatilhos, que têm 0) e **1 saída** (exceto `if` = 2, `loop` = 2 — `loop`/`done` — e `switch` = N).

---

### 4.1 `trigger_manual` — Gatilho Manual

**Para leigos**: o flow só roda quando alguém clica em "▶ Executar". Ideal para testes e tarefas sob demanda. Funciona mesmo com o flow inativo.

**Parâmetros**: nenhum — use `"parameters": {}`.

**Saída**: repassa os dados de entrada da execução; sem dados, `[{ "json": {} }]`.

```json
{ "id": "n1", "type": "trigger_manual", "name": "Início",
  "position": { "x": 100, "y": 200 }, "parameters": {} }
```

---

### 4.2 `trigger_schedule` — Agendamento

**Para leigos**: um despertador. "Rode todo dia às 9h", "a cada 15 minutos", "toda segunda". Só dispara com o flow **Ativo**.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `scheduleType` | string | **Sim** | `"daily"` | `"minutes"` \| `"hours"` \| `"daily"` \| `"weekly"` \| `"monthly"` \| `"cron"` |
| `interval` | número | Se minutes/hours | `1` | A cada X minutos (1–59) ou horas (1–23) |
| `startMinute` | número | Não | `0` | Minuto de início (modo hours). *Aceito, mas ignorado pelo cálculo atual do agendador.* |
| `hour` | número | Se daily/weekly/monthly | `9` | Hora do disparo (0–23) |
| `minute` | número | Se daily/weekly/monthly | `0` | Minuto do disparo (0–59) |
| `weekdays` | array de números **ou** string CSV | Se weekly | `"1,2,3,4,5"` (seg–sex) | Dias da semana, **1=Segunda … 7=Domingo**. Ex.: `[1,2,3,4,5]` (recomendado para geração por IA) ou `"1,2,3,4,5"` (formato que a UI usa) — os dois formatos são equivalentes para o agendador. Vazio (array ou string) → todos os dias. Omitido → assume o default seg–sex, **não** "todos os dias". |
| `monthDays` | array de números **ou** string CSV | Se monthly | `"1"` | Dias do mês, 1–28 (valores acima de 28 são reduzidos para 28). Ex.: `[1,15]` ou `"1,15"` — formatos equivalentes. Vazio → dia 1. |
| `cronExpression` | string | Se cron | `"0 9 * * *"` | Cron de 5 campos (6º campo de segundos opcional). |
| `timezone` | string | **Sim** | `"America/Sao_Paulo"` | Fuso IANA (ex.: `"America/Sao_Paulo"`, `"UTC"`). Valor inválido (ex.: `"Foo/Bar"`) → importação rejeitada; string vazia é aceita e cai em UTC. |

**Recomendação para importação**: além dos parâmetros no node, inclua na **raiz** do documento `"triggerType": "schedule"` e um `scheduleConfig` equivalente — usando a chave **`type`** (não `scheduleType`):

```json
"scheduleConfig": { "type": "daily", "hour": 9, "minute": 0, "timezone": "America/Sao_Paulo" }
```

**Saída**: `[{ "json": {} }]` (item vazio; o flow constrói os dados nos nodes seguintes).

---

### 4.3 `trigger_webhook` — Gatilho Webhook

**Para leigos**: cria uma URL pública; quando outro sistema chama essa URL, o flow roda com os dados recebidos. A URL/token é **gerada pelo sistema** ao criar o flow — nunca faz parte do JSON de importação.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `method` | string | Não | `"POST"` | Método aceito: `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` \| `HEAD`. Outro método → HTTP 405. |
| `authType` | string | Não | `"none"` | `"none"` \| `"header_token"` \| `"basic"`. Falha de auth → HTTP 401. |
| `authHeaderName` | string | Se header_token | — | Nome do header esperado (ex.: `"X-Api-Key"`). |
| `authHeaderValue` | string | Se header_token | — | Valor esperado do token. |
| `responseMode` | string | Não | `"immediate"` | `"immediate"` (responde na hora, com `{ executionId, responseMode, status: "queued" }`) \| `"end"` (aguarda o fim do flow e responde com o resumo da execução) \| `"by_node"` (a resposta vem de um node `webhook_respond`). |
| `responseCode` | número | Não | `200` | Código HTTP. ⚠️ **Não é lido por nenhum runtime** — existe só no editor. O status real vem do `webhook_respond` (modo `by_node`) ou é definido pela própria rota. |
| `responseData` | string | Não | `"none"` | `"none"` \| `"all"` \| `"first"` \| `"field"`. ⚠️ **Também não é lido por nenhum runtime** hoje. |
| `ignoreBots` | boolean | Não | `false` | Rejeita user-agents de crawlers conhecidos. |
| `allowedIPs` | string | Não | `""` | Allowlist de IPs/CIDRs (separados por vírgula, espaço ou linha). Vazio = todos. |
| `maxBodyMB` | número | Não | `16` | Tamanho máximo do corpo aceito (1–100 MB), limitado pelo teto do servidor (`WEBHOOK_MAX_BODY_BYTES`, default 5 MB). Sem `webhookConfig.maxBodyBytes`, vale o padrão do servidor (`WEBHOOK_DEFAULT_MAX_BODY_BYTES`, 1 MB). |

**Saída** (item inicial do flow): **o corpo da requisição, e nada mais** — `[{ "json": <body recebido> }]`. Um campo enviado como `{"valor": 10}` é lido com `{{ $json.valor }}`.

> ⚠️ **Não existe envelope** `headers`/`params`/`query`/`webhookUrl`/`executionMode`: isso está previsto em [`spec-v4/trigger_webhook.md`](./spec-v4/trigger_webhook.md), mas **não** implementado (`apps/api/src/routes/webhook.ts` enfileira `[{ json: body }]`). Não gere expressões como `{{ $json.body.campo }}` nem espere cabeçalhos ou query string na entrada. Requisições `GET` (sem corpo) chegam como `[{ "json": {} }]`.

> **Onde a configuração de runtime realmente vive**: a rota pública lê a coluna `flows.webhook_config`, não os `parameters` do node. Quem traduz um para o outro é o **editor**, no save (`responseMode: "end"` → `on_complete`, `allowedIPs` → `allowedIps[]`, `maxBodyMB` → `maxBodyBytes`, `ignoreBots` → `blockCommonBots`). Consequência para flows importados: até o primeiro save no editor, o webhook responde com os **defaults** (`immediate`, sem allowlist, sem bloqueio de bots) — mesmo que o node diga `by_node`. Para que valha desde a importação, inclua também `webhookConfig` na **raiz** do documento (§2.1).

---

### 4.4 `webhook_respond` — Responder Webhook

**Para leigos**: monta a resposta HTTP que quem chamou o webhook vai receber. Só tem efeito em flows de webhook com `responseMode: "by_node"`.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `statusCode` | número | **Sim** | `200` | Código HTTP (100–599). |
| `body` | string | **Sim** | `""` | Corpo da resposta; aceita `{{ }}`. Teto próprio de **4 MiB** para o valor resolvido (`WEBHOOK_RESPOND_MAX_BODY_BYTES`) — estourar falha o node. |
| `bodyMode` | string | Não | `"fixed"` | `"fixed"` \| `"expression"`. |
| `headers` | array | Não | `[]` | Lista de `{ "name": "...", "value": "...", "valueMode": "fixed"|"expression" }` (`value` aceita `{{ }}`; `valueMode` opcional). |

**Comportamento**: grava a resposta e **repassa os itens de entrada inalterados** — pode haver nodes depois dele. Entrada vazia conta como **um item vazio** (a resposta é sempre produzida).

---

### 4.5 `edit_fields` — Editar Campos

**Para leigos**: a "planilha de transformação": cria colunas novas, copia valores, monta textos. Ex.: criar `nome_completo` juntando `nome` + `sobrenome`.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `mode` | string | **Sim** | `"manual"` | `"manual"` = a saída tem **só** os campos definidos; `"merge"` = mantém todos os campos do item e sobrescreve/adiciona os definidos. |
| `fields` | array | **Sim** | `[]` | Lista de definições de campo (abaixo). |
| `includeOtherFields` | boolean | **Sim** | `false` | No modo `manual`, `true` também copia os campos não mapeados do item de entrada. |

Cada item de `fields`:

| Chave | Tipo | Descrição |
|---|---|---|
| `name` | string | Nome do campo de saída. Aceita notação de ponto: `"endereco.cidade"` cria objeto aninhado. |
| `value` | string | Valor; aceita `{{ }}` (avaliado por item). |
| `valueMode` | string | `"fixed"` \| `"expression"`. |
| `valueType` | string | `"string"` \| `"number"` \| `"boolean"` \| `"array"` \| `"object"` \| `"binary"` — coerção aplicada após avaliar `value`. |

Coerção por `valueType`: `number` → parse de float (vazio → `0`; não numérico → mantém a string); `boolean` → `true` se o valor for `true`/`1`/`yes`; `array`/`object` → `JSON.parse` do texto (se falhar, mantém a string); `string`/`binary` → como está.

**Saída**: um item por item de entrada, com os campos resultantes.

```json
{ "id": "n3", "type": "edit_fields", "name": "Normalizar",
  "position": { "x": 700, "y": 200 },
  "parameters": {
    "mode": "manual",
    "includeOtherFields": false,
    "fields": [
      { "name": "cliente", "value": "{{ $json.nome.toUpperCase() }}", "valueMode": "expression", "valueType": "string" },
      { "name": "total",   "value": "{{ $json.valor * 1.1 }}",        "valueMode": "expression", "valueType": "number" }
    ]
  } }
```

---

### 4.6 `filter` — Filtro

**Para leigos**: uma peneira. Itens que passam nas condições continuam; os demais são **descartados silenciosamente** (não é erro, eles apenas somem).

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `combine` | string | **Sim** | `"and"` | `"and"` (todas as condições) \| `"or"` (qualquer uma). |
| `conditions` | array | **Sim** | 1 condição modelo | Lista de condições (abaixo). Vazia/ausente → todos os itens passam. |
| `caseInsensitive` | boolean | Não | `true` | Ignorar maiúsculas/minúsculas. A importação preenche a chave omitida com o default da definição (`true`, paridade n8n). Nós antigos gravados **sem** a chave caem no default do motor: `true` no tipado, `false` no legado. Ao gerar, **declare o valor explicitamente**. |
| `typeValidation` | string | Não | `"loose"` | Só no motor tipado: `"loose"` converte quando possível (`"25"` → `25`; lado não conversível torna a condição `false`); `"strict"` **falha a execução** com erro descritivo quando o valor não é do tipo do operador. |
| `nullAsEmpty` | boolean | Não | `true` | Trata `null`/`undefined` como string vazia antes de comparar. **Só se aplica ao motor legado**; no tipado, ausência é tratada pelos operadores `any:exists`/`any:empty` e pela coerção. |
| `continueIfEmpty` | boolean | Não | `false` | "Continuar se todos filtrados". `false` (padrão): se **havia** itens e **nenhum** passou, o ramo é **encerrado** (nós a jusante ficam `skipped`). `true`: o flow segue com array vazio. Entrada já vazia (upstream sem itens) nunca encerra o ramo. |

Cada item de `conditions` (avaliada **por item**, `$json` = item atual):

| Chave | Tipo | Obrig. | Descrição |
|---|---|---|---|
| `left` | string | **Sim** | Lado esquerdo; normalmente expressão. Ex.: `"{{ $json.status }}"`. Default **vazio** (aponte o campo; o item inteiro não é comparável). |
| `leftMode` | string | Não | `"fixed"` \| `"expression"`. |
| `operator` | string | **Sim** | Ver os dois formatos abaixo. Default de condição nova: `"string:equals"`. |
| `right` | string | **Sim** | Lado direito. **A chave tem de existir** mesmo com operador unário — use `"right": ""` (omiti-la faz a importação falhar com `conditions.N.right: Required`). |
| `rightMode` | string | Não | `"fixed"` \| `"expression"`. |

#### Operadores — formato **tipado** (canônico, 41 opções)

O formato atual é `tipo:operacao`, como o Filter/IF v2 do n8n. É o que a interface gera e o **default** de qualquer condição nova (`string:equals`). Use este formato ao gerar flows.

| Grupo | Operadores |
|---|---|
| **Texto** (11) | `string:equals`, `string:notEquals`, `string:contains`, `string:notContains`, `string:startsWith`, `string:notStartsWith`, `string:endsWith`, `string:notEndsWith`, `string:regex`, `string:notRegex`, `string:inList` (lista separada por vírgula) |
| **Número** (7) | `number:equals`, `number:notEquals`, `number:gt`, `number:lt`, `number:gte`, `number:lte`, `number:isNumeric` |
| **Data e hora** (7) | `date:equals`, `date:notEquals`, `date:after`, `date:before`, `date:afterOrEquals`, `date:beforeOrEquals`, `date:isValid` |
| **Booleano** (4) | `boolean:true`, `boolean:false`, `boolean:equals`, `boolean:notEquals` |
| **Array** (8) | `array:contains`, `array:notContains`, `array:lengthEquals`, `array:lengthNotEquals`, `array:lengthGt`, `array:lengthLt`, `array:lengthGte`, `array:lengthLte` |
| **Geral** (4) | `any:exists`, `any:notExists`, `any:empty`, `any:notEmpty` |

**Unários** (ignoram `right`): os quatro de *Geral*, `boolean:true`, `boolean:false`, `number:isNumeric`, `date:isValid`. As operações `exists`/`notExists`/`empty`/`notEmpty` também são aceitas com qualquer prefixo de tipo (`string:empty` funciona igual a `any:empty`).

Semântica do motor tipado:

- Os lados são avaliados como **valores** (não texto) quando o campo é um único bloco `{{ }}` — daí `array:*` e `date:*` funcionarem de verdade.
- `string:equals` compara texto **exato** (sem aparar espaços), como no n8n. `string:inList` apara os espaços de cada item da lista.
- `caseInsensitive` **ligado por padrão** aqui; em `string:regex`/`string:notRegex` entra como flag `(?i)` (o padrão nunca é convertido para minúsculas). Regex inválido: condição `false` em `loose`, erro em `strict`.
- Tipo/operação desconhecidos → condição `false`, sem derrubar o node.

#### Operadores **legados** (18) — aceitos, não recomendados

Operadores **sem** `:` continuam funcionando no motor textual antigo, para que flows salvos antes do modelo tipado não mudem de comportamento. Nesse motor, `caseInsensitive` é `false` por padrão e `nullAsEmpty` se aplica.

| Binários (usam `right`) | Unários (ignoram `right`) |
|---|---|
| `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `greater_than`, `less_than`, `gte`, `lte`, `regex`, `in_list` | `is_empty`, `is_not_empty`, `is_true`, `is_false`, `is_number`, `is_date` |

Notas do motor legado: `is_empty`/`is_not_empty` consideram `""`, `"[]"` e `"{}"` vazios; comparações numéricas exigem ambos os lados numéricos (senão resultam `false`). O painel **exibe** esses operadores com o rótulo do equivalente tipado, mas só regrava o parâmetro quando o usuário troca o operador.

---

### 4.7 `if` — Condicional (2 saídas)

**Para leigos**: uma bifurcação com duas estradas: **true** e **false**. Diferente do Filtro (que joga fora), o IF apenas **direciona** — os dados não são modificados.

**Parâmetros**: idênticos ao `filter` (`combine`, `conditions`, `caseInsensitive`, `typeValidation`, `nullAsEmpty`), **sem** `continueIfEmpty`. Mesmos operadores — tipados (canônicos) e legados.

**Semântica importante**:

- A decisão é tomada **uma única vez**, avaliando as condições sobre o **primeiro item** (índice 0) da entrada — **todos** os itens seguem juntos pelo ramo escolhido (não é item a item; para separar item a item, use `filter` em cada ramo).
- Edges de saída: `sourceHandle: "true"` e `sourceHandle: "false"` (minúsculas, uma edge cada).
- Ramo não conectado → itens descartados silenciosamente.
- Erro de expressão na condição → segue o ramo `false` (o flow não falha). Exceção: com `typeValidation: "strict"`, valor de tipo errado **falha** o node.

```json
{ "id": "n2", "type": "if", "name": "Valor alto?",
  "position": { "x": 400, "y": 200 },
  "parameters": {
    "combine": "and",
    "conditions": [
      { "left": "{{ $json.valor }}", "leftMode": "expression",
        "operator": "number:gt", "right": "1000", "rightMode": "fixed" }
    ],
    "caseInsensitive": true, "typeValidation": "loose", "nullAsEmpty": true
  } }
```

Edges: `{ "id": "e2", "source": "n2", "target": "n3", "sourceHandle": "true" }` e `{ "id": "e3", "source": "n2", "target": "n4", "sourceHandle": "false" }`.

---

### 4.8 `switch` — Roteador de N saídas

**Para leigos**: um guichê de triagem: olha um valor (ex.: `status`) e manda os dados para a fila com aquele nome ("aprovado", "pendente", "Outros"…).

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `fieldExpression` | string | **Sim** | `"{{ $json.status }}"` | O valor a examinar. **Exatamente um** bloco `{{ }}` (retorna valor tipado). Avaliado sobre o primeiro item. |
| `fieldExpressionMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `dataType` | string | **Sim** | `"string"` | Como normalizar o valor: `"string"` \| `"number"` \| `"boolean"` \| `"date"`. |
| `matchMode` | string | Não | `"first"` | `"first"` = segue só a primeira regra que casar; `"all"` = segue **todas** as regras que casarem (fan-out real — única forma de paralelizar rotas). |
| `rules` | array | **Sim** | 1 regra modelo | Regras → saídas (abaixo). Regra com `outputLabel` vazio é ignorada. |
| `fallbackEnabled` | boolean | Não | `false` | Cria a saída de fallback ("nenhuma regra casou"). |
| `fallbackLabel` | string | Não | `"Outros"` | Nome (e `sourceHandle`) da saída de fallback. |

Cada item de `rules`:

| Chave | Tipo | Descrição |
|---|---|---|
| `operator` | string | Por `dataType` — **string**: `equals`, `not_equal`, `contains`, `regex`, `is_empty`, `is_not_empty` · **number**: `equals`, `not_equal`, `greater_than`, `less_than`, `gte`, `lte` · **boolean**: `equals`, `not_equal` · **date**: `equals`, `not_equal`, `greater_than`, `less_than`, `gte`, `lte`. ⚠️ Aqui é `not_equal` (sem "s"), diferente do `not_equals` do filter/if. |
| `value` | string | Valor de comparação. |
| `outputLabel` | string | Nome da saída — **precisa ser idêntico ao `sourceHandle` da edge** correspondente. |

**Resolução**: primeira regra que casa → edge com handle = `outputLabel`; senão fallback (se habilitado e com edge de handle = `fallbackLabel`); senão rota default (§2.4: edge sem handle → handle `"default"`/`"fallback"` → primeira edge). A decisão usa o **primeiro item** da entrada (como no `if`); com `matchMode: "all"`, cada regra que casar recebe todos os itens. Erro na expressão → rota default/fallback (o flow não falha).

```json
{ "id": "n2", "type": "switch", "name": "Triagem",
  "position": { "x": 400, "y": 250 },
  "parameters": {
    "fieldExpression": "{{ $json.status }}", "fieldExpressionMode": "expression",
    "dataType": "string", "matchMode": "first",
    "rules": [
      { "operator": "equals", "value": "aprovado", "outputLabel": "aprovado" },
      { "operator": "equals", "value": "pendente", "outputLabel": "pendente" }
    ],
    "fallbackEnabled": true, "fallbackLabel": "Outros"
  } }
```

Edges com `sourceHandle`: `"aprovado"`, `"pendente"` e `"Outros"`.

---

### 4.9 `loop` — Loop / Lotes

**Para leigos**: recebe uma lista e processa em pedaços (lotes), como o Loop Over Items do n8n. O Loop tem **duas saídas**: `"loop"` (cada lote) — os nodes conectados aí formam o **corpo** e executam **uma vez por lote**, recebendo os elementos do lote como itens crus (`$json` = elemento) — e `"done"` (concluído), que continua o flow ao final com todos os elementos achatados. Não existe "seta de volta": o motor re-executa o corpo internamente.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `arrayExpression` | string | **Sim** | `"{{ $json.items }}"` | Expressão (**um único** bloco `{{ }}`) que deve resultar em um **array**. Não-array → erro. |
| `arrayExpressionMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `batchSize` | número | **Sim** | `1` | Itens entregues ao corpo por iteração (1–50.000; em runtime é limitado ao teto de elementos por item). |
| `pauseBetweenBatchesSeconds` | número | **Sim** | `0` | Pausa entre iterações do corpo, em segundos (0–86.400). |
| `continueOnItemError` | boolean | **Sim** | `false` | `true`: erro no corpo em um lote vira `{ "_loopError": "...", "_batchIndex": n }` na saída "done" e o loop segue ao próximo lote; item de entrada cuja `arrayExpression` falha ou não é array vira `{ "_loopError": "...", "_itemIndex": n }`. **Não** cobre o estouro dos tetos (`loop_limit_exceeded` sempre falha). |

**Arestas**: saída do corpo usa `"sourceHandle": "loop"`; continuação usa `"sourceHandle": "done"`. **No máximo uma aresta por saída.** O corpo é **fechado**: nenhum node de fora (nem a própria saída `done`) pode apontar para um node alcançável pela saída `loop` — a execução falha na validação. Aninhamento de loops: máx. **3 níveis**.

**Tetos (falham, não truncam)**: três limites, todos com default **50.000** e ajustáveis pelo administrador do worker — elementos por item de entrada (`LOOP_MAX_ELEMENTS_PER_ITEM`), elementos totais por execução do loop (`LOOP_MAX_TOTAL_OUTPUT`) e iterações do corpo/lotes (`LOOP_MAX_BATCHES`). Estourar qualquer um deles **falha o node** com o erro `loop_limit_exceeded` **antes** de executar o primeiro lote — o motor **não** processa "só uma parte" (o marcador `_loopTruncated` de versões antigas não é mais gerado). A mensagem de erro já sugere a correção: reduzir a coleção a montante (`filter`, paginação) ou aumentar `batchSize`. Ex.: 60.000 elementos com `batchSize: 1` excedem o teto de lotes; com `batchSize: 2` passam (mas o teto de elementos totais continua em 50.000).

**Itens do corpo (saída `loop`)**: os elementos do lote, crus — objeto vira o próprio `$json`; não-objeto é embrulhado como `{ "value": elemento }`. Dentro do corpo, `$node["Nome do Loop"].json` referencia o **lote atual** (pareado por índice).

**Saída `done`**: todos os elementos achatados (um item por elemento) + marcadores de erro quando houver (`{ "_loopError", "_batchIndex" }` para lote que falhou com `continueOnItemError`; `{ "_loopError", "_itemIndex" }` para item de entrada cuja expressão não resolveu para array). Array vazio → 0 itens (o ramo done recebe lista vazia).

---

### 4.10 `code` — Código JavaScript

**Para leigos**: a "estação faz-tudo" para quem programa: escreve-se JavaScript que recebe os itens e devolve itens novos. Roda em ambiente isolado e seguro — sem internet, sem arquivos.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `mode` | string | Não | `"all_items"` | `"all_items"` = roda **uma vez** com a lista completa em `items`; `"each_item"` = roda **uma vez por item** com `$json`. |
| `jsCode` | string | **Sim** | template comentado | JavaScript **bruto** (sem `{{ }}`; os dados chegam pelas variáveis). Mínimo 1 byte, máximo **32.768 bytes**. |

**Variáveis disponíveis**: `items` (array de `{json}` — modo all_items), `$items()`, `$json` (modo each_item), `$itemIndex`, `$node["Nome"].json`, `$now`, `$today`, `console.log/info/warn/error` (capturados: máx. 50 entradas × 1 KB, exibidos no painel). **Não existem**: `require`, `import`, `process`, `fs`, `fetch`, `setTimeout`, `Buffer`, `$env`. Apenas código **síncrono**.

**Contrato de retorno**: `all_items` → retorne um array (cada elemento vira um item; envelope `{json:{...}}` é respeitado; objeto simples vira 1 item). `each_item` → retorne **um objeto** por execução. Primitivos/funções → erro didático.

**Limites**: timeout **5 s** por execução (`CODE_NODE_TIMEOUT_MS`, teto rígido 30 s); orçamento agregado de **60 s** no modo each_item (`CODE_NODE_TOTAL_TIMEOUT_MS`, teto 120 s); saída ≤ 50.000 itens e ≤ 1 MiB (`CODE_NODE_MAX_OUTPUT_BYTES`); profundidade de call stack **256** (expressões: 64); memória ~512 MB (`CODE_NODE_MEM_SOFT_LIMIT_MB`). Erros típicos: `ScriptCompileError`, `ScriptRuntimeError`, `ScriptTimeout`, `ScriptMemoryLimit`, `ScriptInvalidReturn`, `ScriptResultTooLarge`. Não há `continueOnError` — erro derruba o flow.

```json
{ "id": "n3", "type": "code", "name": "Agregar totais",
  "position": { "x": 700, "y": 200 },
  "parameters": {
    "mode": "all_items",
    "jsCode": "const total = items.reduce((s, it) => s + (it.json.valor || 0), 0);\nreturn [{ json: { total, quantidade: items.length } }];"
  } }
```

---

### 4.11 `http_request` — Requisição HTTP

**Para leigos**: o mensageiro universal: chama qualquer API/site externo para buscar ou enviar dados. Faz **uma requisição por item de entrada**.

**Principais** (obrigatórios no schema: `method`, `url`, `authType`, `timeoutSeconds`, `continueOnError`):

| Chave | Tipo | Default | Descrição |
|---|---|---|---|
| `method` | string | `"GET"` | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` \| `HEAD` \| `OPTIONS`. |
| `url` | string | `"https://"` | URL; aceita `{{ }}`. |
| `urlMode` | string | auto | `"fixed"` \| `"expression"` (use `"expression"` se a URL tiver `{{`). |
| `timeoutSeconds` | número | `30` | 1–600 s. |
| `continueOnError` | boolean | `false` | `true`: erro HTTP ≥400 ou de rede vira campos no output em vez de derrubar o flow. |

**Autenticação** (`authType`, default `"none"`):

| Valor | Campos adicionais |
|---|---|
| `"none"` | — |
| `"credential"` | `credentialId` (string — **não gerar**; o usuário seleciona após importar) |
| `"bearer_inline"` | `bearerToken` |
| `"basic_inline"` | `basicUser` (aceita `{{ }}`, com `basicUserMode`), `basicPassword` |
| `"api_key_inline"` | `apiKeyName`, `apiKeyValue`, `apiKeySendAs` (`"header"` \| `"query"`) |
| `"custom_header_inline"` | `customHeaderName`, `customHeaderValue` |

**Query e headers**: `sendQueryParams` (bool, `false`) + `queryParams` (array de `{ "key", "value" }`); `sendHeaders` (bool, `false`) + `headers` (array de `{ "key", "value" }`). Valores aceitam `{{ }}`.

**Corpo** (enviado só em POST/PUT/PATCH/DELETE) — `contentType` (default `"application/json"`): `application/json` · `application/x-www-form-urlencoded` · `multipart/form-data` · `text/plain` · `text/xml` · `application/octet-stream`.

- JSON: `jsonBodyMode` = `"editor"` (default; corpo em `body` como string JSON, aceita `{{ }}`, com `bodyMode`) ou `"fields"` (`jsonBodyFields`: array de `{ "key", "value", "valueMode", "valueType": "string"|"number"|"boolean"|"object" }`).
- Form URL Encoded: `formUrlEncodedFields` (array de `{ "key", "value", "valueMode" }`).
- Multipart: `multipartFields` (array de `{ "key", "valueKind": "text"|"file", "value", "valueMode" }`; arquivos só por base64/literal — sem acesso a disco).
- Texto/XML: `body` + `bodyMode`. Binário: `binaryRef` + `binaryRefMode` (base64).
- **Teto por campo**: cada campo do corpo avaliado por expressão pode render até **4 MiB** (`HTTP_NODE_MAX_BODY_BYTES`, por campo e não pelo corpo somado); estourar **falha** o node com `expression_result_too_large` — nunca envia o campo vazio.

**Avançados**: `followRedirects` (`true`), `maxRedirects` (`10`, 0–50), `ignoreSSL` (`false`), `proxyUrl` (`""`).

**Paginação** — `pagination` (bool, `false`); quando `true`:

| Chave | Default | Descrição |
|---|---|---|
| `paginationType` | `"link"` | `"link"` (campo com URL da próxima página) \| `"offset"` \| `"page"` \| `"cursor"`. |
| `paginationField` | `""` | Campo do JSON de resposta com a próxima URL (`link`) ou o cursor (`cursor`). Obrigatório nesses modos. |
| `paginationItemsPath` | `""` | Caminho do array de itens na resposta (para saber quando parar). |
| `paginationOffsetParam` / `paginationLimitParam` / `paginationPageSize` | `"offset"` / `"limit"` / `100` | Modo `offset`. |
| `paginationPageParam` | `"page"` | Modo `page` (1-based). |
| `paginationCursorParam` | `"cursor"` | Modo `cursor`. |
| `maxPages` | `10` | 1–500 (teto rígido 500; orçamento de tempo total = `timeoutSeconds` × `maxPages`, limitado a 600 s). O total acumulado das páginas é limitado a **64 MiB** (`HTTP_NODE_MAX_PAGINATION_BYTES`): ao estourar, as páginas já obtidas são mantidas e a saída ganha `pagination.truncated: true`. |

**Saída por item de entrada**:

```json
{ "json": { "status": 200, "body": "…texto bruto…", "parsedBody": { "resultado": "…" } } }
```

- Status ≥ 400 → campo extra `"httpError"`; **sem** `continueOnError` o node falha e derruba o flow.
- Erro de rede com `continueOnError` → `{ "status": 0, "body": "", "parsedBody": null, "networkError": "…" }`.
- Resposta acima de **16 MiB** (`HTTP_NODE_MAX_RESPONSE_BYTES`) → erro `http_response_too_large` (com `continueOnError`, vira `networkError` no item). Pagine o pedido em vez de subir o teto.
- Com paginação → resposta da última página + bloco `"pagination": { "mode", "pageCount", "allParsedBodies": [...], "truncated"? }`.

**Segurança (SSRF)**: URLs para IPs privados, loopback e metadados de nuvem são **bloqueadas**. Gere apenas URLs públicas.

---

### 4.12 `waipe_ai` — Waipe AI

**Para leigos**: manda uma pergunta/instrução para um modelo de IA e **anexa a resposta ao item** (os dados originais são preservados). Ex.: "classifique este comentário como positivo ou negativo".

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `model` | string | Não | `"gpt-4o-mini"` | Id do modelo. A lista real vem do gateway da plataforma; a lista de **fallback** da API é `gpt-4o-mini`, `gpt-5.6-luna`, `gpt-5-mini`, `gemini-3-flash-preview`, `gemini-3.5-flash`, `deepseek-v4-flash`, `gemini-3.1-flash-lite`. O provedor é inferido pelo prefixo (`gemini*` → Google, `deepseek*` → DeepSeek, demais → OpenAI). Ao gerar, prefira `gpt-4o-mini` (default) ou um id que o usuário tenha confirmado no seletor do painel. |
| `message` | string | **Sim** | `""` | A mensagem/pergunta; aceita `{{ }}` (avaliada **por item**). |
| `messageMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `systemPrompt` | string | **Sim** (pode ser `""`) | `""` | Instruções de sistema; aceita `{{ }}`. |
| `systemPromptMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `temperature` | número | **Sim** | `0.7` | 0.0–2.0. Ignorada em modelos de raciocínio (`deepseek*`, `o1*`, `o3*`, `o4*`). |
| `maxTokens` | número | **Sim** | `1000` | 1–128.000. |
| `outputFormat` | string | Não | `"text"` | `"text"` \| `"json"` (força parse JSON da resposta; JSON inválido → erro no item). |
| `outputFieldName` | string | **Sim** | `"resposta_ia"` | Nome do campo adicionado ao `json` do item com a resposta. |
| `includeInputFields` | boolean | Não | `true` | `true` (padrão) preserva os campos do input e acrescenta a resposta; `false` faz o output conter **apenas** o campo de saída (+ dados de uso, se ligados). |
| `includeUsageData` | boolean | Não | `false` | `true` adiciona `tokens_entrada`, `tokens_saida`, `modelo_usado`. |

**Comportamento**: 1 chamada por item; com `includeInputFields: true` (padrão) o item de saída = item de entrada + campo `outputFieldName`; com `includeInputFields: false` o item de saída contém apenas `outputFieldName` (+ dados de uso, se ligados). **Erros são por item e não derrubam o node**: o item recebe `outputFieldName` com mensagem amigável + `"waipe_ia_error": true` + `"waipe_ia_error_code"`. Códigos comuns: `config_missing` (sem chave de API/gateway no ambiente), `provider_error`/`http_*` (o provedor rejeitou o pedido), `network_error` (falha de rede até o provedor), `timeout` (a resposta excedeu o tempo do job — modelos de raciocínio gerando textos longos levam minutos; aumente `WORKER_JOB_TIMEOUT_SECONDS`, padrão 300s), `empty_response` (o modelo respondeu sem texto — em geral o limite `maxTokens` foi consumido no raciocínio interno; aumente Máx. tokens), `parse_error` (resposta sem estrutura reconhecível), `json_format_error` (formato JSON obrigatório mas o modelo devolveu texto inválido). O `content` da resposta é aceito tanto como string quanto como array de partes (modo compatível do Gemini).

---

### 4.13 `waipe_data` — Waipe Data

**Para leigos**: busca dados que já vivem dentro da plataforma Waipe (ERP Gestor, Unique, modelos especialistas, relatórios do Data Lab), sem precisar montar chamadas HTTP. Requer **conector Waipe configurado** no workspace — sem conector, o node falha.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `dataSource` | string | **Sim** | `"gestor"` | `"gestor"` \| `"unique"` \| `"expert"` \| `"data_lab"`. |
| `companyIds` | array de strings | Condicional | `[]` | Empresas-alvo. Obrigatório (≥ 1) **apenas** para `gestor`: `unique` é condicional ao retorno do serviço (validado no frontend), `expert` lista pela empresa logada e `data_lab` não usa empresa. (Legado: `companyIdsText`, string multilinha.) |
| `message` | string | Condicional | `""` | Pergunta/consulta; aceita `{{ }}`. Obrigatória exceto para `data_lab` (onde é ignorada). |
| `messageMode` | string | Não | `"fixed"` | `"fixed"` \| `"expression"`. |
| `expertModelId` | string | Se `expert` | `""` | Id do modelo especialista. |
| `dataLabReportId` | string | Se `data_lab` | `""` | Id do relatório do Data Lab. |

**Saída**: itens retornados pela plataforma (`[{ "json": { ... } }]`); vazio → `[{ "json": {} }]`. Timeout interno de 120 s.

> Ao gerar flows com `waipe_data`, use ids de empresa/relatório como placeholders e avise o usuário para selecioná-los no painel do node após importar.

---

### 4.14 `split_out` — Split Out

**Para leigos**: um "desagrupador". Quando um node devolve **1 item com um array dentro** (caso típico: `http_request` com `parsedBody` contendo 50 registros), o Split Out transforma cada elemento do array em **um item independente** — aí o `filter` e o `edit_fields` conseguem trabalhar registro a registro.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `arrayExpression` | string | **Sim** | `""` | Expressão `{{ }}` que aponta o array. Ex.: `"{{ $node[\"HTTP Request\"].json.parsedBody }}"`. |
| `arrayExpressionMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `include` | string | **Sim** | `"none"` | `"none"` (item de saída contém só o elemento) \| `"all"` (copia os demais campos do item original em cada item gerado; o elemento vence conflitos). |
| `continueIfEmpty` | boolean | Não | `false` | `false`: se **havia** entrada e **nenhum** item foi gerado, o ramo é **encerrado** (jusante `skipped`). `true`: segue com array vazio. |

**Saída**: um item por elemento do array, na ordem. Elementos primitivos viram `{ "json": { "value": elemento } }`. Campo ausente/`null` → 0 itens daquele input, sem erro; valor não-array → **erro** do node. Limites **fixos**: 10.000 elementos por item de entrada e 50.000 no total — ao contrário do `loop`, o excedente é **truncado** e a saída ganha um item-marcador final `{ "_splitOutTruncated": true, "_limit": 50000, "_emitted": n }`. Erros (categoria `user`): `split_out_missing_array` (expressão vazia), `split_out_expression` (erro na expressão), `split_out_not_array`.

> Padrão recomendado: `http_request` → `split_out` → `filter` → `merge_out` — filtra os registros da API um a um e junta o resultado de volta num array, como no n8n.

---

### 4.15 `merge_out` — Merge Out

**Para leigos**: um "agrupador" — o oposto do Split Out. Recebe **vários itens** e devolve **um só**, com os dados dentro de arrays. É o que você usa depois de filtrar registro a registro para mandar tudo de uma vez a uma API, num único prompt de IA ou na resposta de um webhook (em vez de uma chamada por item).

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `mode` | string | Não | `"all_items"` | `"all_items"` (o item inteiro de cada entrada entra numa lista única) \| `"individual_fields"` (um array por campo escolhido). |
| `outputFieldName` | string | Só em `all_items` | `"data"` | Nome do campo que recebe o array. Aceita caminho aninhado: `"resultado.itens"`. |
| `include` | string | Não | `"all"` | Só em `all_items`: `"all"` \| `"selected"` \| `"except"` — recorta os campos de cada item antes de agregar. |
| `fieldsToInclude` | string | Se `include="selected"` | `""` | Nomes separados por vírgula: `"id, nome, email"`. |
| `fieldsToExclude` | string | Se `include="except"` | `""` | Nomes separados por vírgula: `"senha, token"`. |
| `fields` | array | Só em `individual_fields` | `[]` | Um objeto por array de saída: `{ "inputFieldName": "email", "renameTo": "emails" }` (`renameTo` opcional). |
| `keepMissing` | boolean | Não | `false` | Só em `individual_fields`. `false`: itens sem o campo não contribuem. `true`: entram como `null`, mantendo o alinhamento por posição. |
| `mergeLists` | boolean | Não | `false` | Quando o valor já é array, acrescenta os elementos dele em vez de aninhar array dentro de array. |
| `disableDotNotation` | boolean | Não | `false` | Trata `"a.b"` como nome literal do campo, em vez de caminho aninhado. |

> **Atenção**: os nomes de campo deste node são **literais** — nunca use `{{ }}` em `outputFieldName`, `inputFieldName`, `renameTo`, `fieldsToInclude` ou `fieldsToExclude`. Escreva `"email"`, não `"{{ $json.email }}"`.

**Saída**: **sempre 1 item**. Em `all_items`: `[{ "json": { "data": [ {…}, {…} ] } }]`. Em `individual_fields`: `[{ "json": { "emails": [...], "nomes": [...] } }]`. Entrada vazia → 1 item com a lista vazia (o node **nunca** encerra o ramo e não tem `continueIfEmpty`). O node nunca falha. Limite fixo: 50.000 valores por campo de saída — o excedente é truncado e o item ganha `"_mergeOutTruncated": true` e `"_limit": 50000`.

**Como referenciar a seguir**: `{{ $node["Merge Out"].json.data }}` (o array) ou `{{ $node["Merge Out"].json.data.length }}` (quantos itens foram agregados).

> Dentro do corpo de um `loop` o Merge Out agrega **o lote** (o corpo executa uma vez por lote). Para agregar tudo, ligue-o à saída `done`.

---

### 4.16 `gmail_send` — Gmail: Enviar Email

**Para leigos**: envia um e-mail pela conta Google conectada. Envia **um e-mail por item de entrada** (10 itens = 10 e-mails) — para mandar um único e-mail com tudo, agregue os itens antes com `merge_out` ou `code`.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `credentialId` | string (credential_ref) | Sim (runtime) | `""` | Credencial Google OAuth2 (a **mesma** do Sheets e do Drive). Deixe vazio ao gerar; o usuário conecta no painel. |
| `to` | string | **Sim** | `""` | Destinatário(s); separe vários por vírgula. Aceita `{{ }}`. Vazio em runtime → erro `gmail_missing_to`. |
| `toMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `cc` | string | Não | `""` | Cópia; aceita `{{ }}`. |
| `ccMode` | string | Não | `"expression"` | idem. |
| `bcc` | string | Não | `""` | Cópia oculta; aceita `{{ }}`. |
| `bccMode` | string | Não | `"expression"` | idem. |
| `subject` | string | **Sim** | `""` | Assunto; aceita `{{ }}`. |
| `subjectMode` | string | Não | `"expression"` | idem. |
| `bodyType` | string | Não | `"text"` | `"text"` (envia como `text/plain`) \| `"html"` (marcação, links, estilos inline). |
| `body` | string | **Sim** | `""` | Corpo do e-mail; aceita `{{ }}` (avaliado **por item**). |
| `bodyMode` | string | Não | `"expression"` | idem. |
| `continueOnError` | boolean | Não | `false` | `true`: falha de envio vira campos no output em vez de interromper o flow. |

**Saída**: **um item por item de entrada**, e o item de entrada é **substituído** pelo resultado (os campos originais não são preservados — se precisar deles adiante, referencie o node anterior com `$node["Nome"].json...`):

```json
{ "json": { "sent": true, "status": 200, "messageId": "1993…", "threadId": "1993…" } }
```

Com `continueOnError: true`, a falha vira `{ "sent": false, "status": 4xx|5xx, "httpError": "…" }` ou `{ "sent": false, "networkError": "…" }`.

**Erros de negócio (categoria `user`)**: `gmail_missing_credential` (nenhuma credencial selecionada), `gmail_credential_type` (credencial não é Google OAuth2), `gmail_missing_to` (destinatário vazio), `gmail_4xx` (Gmail rejeitou — inclui 401/403 de token/escopo expirado). `gmail_5xx` é classificado como falha do provedor (`upstream`).

> Escopo usado: `gmail.send`. Timeout da chamada HTTP: 45 s. O tipo canônico da credencial é `google_oauth2` (compartilhado com Sheets, Drive e Docs); o tipo legado `gmail_oauth2` — que o painel deste node ainda oferece ao criar uma credencial nova — é aceito pelo worker com o mesmo formato.

```json
{ "id": "n5", "type": "gmail_send", "name": "Avisar responsável",
  "position": { "x": 1300, "y": 200 },
  "parameters": {
    "credentialId": "",
    "to": "{{ $json.responsavel_email }}", "toMode": "expression",
    "subject": "Pedido {{ $json.id }} precisa de aprovação", "subjectMode": "expression",
    "bodyType": "html",
    "body": "<p>Valor: <b>{{ $json.valor }}</b></p>", "bodyMode": "expression",
    "continueOnError": false
  } }
```

---

### 4.17 `google_sheets` — Google Sheets

**Para leigos**: lê e escreve planilhas do Google. Usa a **mesma** conta Google conectada do Gmail (credencial `google_oauth2`). Escolha a **operação**: listar planilhas da conta, criar uma nova, **ler linhas**, ler valores de um intervalo, ou inserir/atualizar linhas.

**Para LER, use `get_rows`** ("Ler linha(s)"): devolve **um item por linha**, com **um campo por coluna do cabeçalho** + `rowNumber` — é o que permite `{{ $node["Ler linhas"].json.Email }}` no nó seguinte, sem `split_out`. Os filtros (`coluna = valor`) são resolvidos **por item de entrada**, então `http_request → google_sheets(get_rows)` busca uma linha por item com uma única chamada ao Google. Só use `read` quando o objetivo for mesmo a matriz 2D crua de um intervalo A1.

Para **inserir/atualizar linhas** o nó funciona como no n8n: você escolhe a **aba**, e as colunas são identificadas pelo **nome no cabeçalho** (linha `headerRow`, padrão 1). Cada item de entrada vira **uma linha** (10 itens = 10 linhas), gravadas em lote.

A aba **não precisa ter cabeçalho**: se a linha `headerRow` estiver em branco, as colunas são **criadas** antes da gravação. Com `mappingMode: "auto"` isso significa que **as chaves do JSON de entrada viram as colunas e os valores viram as células** — é o caminho para "criar planilha e despejar o JSON nela" sem configurar coluna a coluna. Numa aba que já tem cabeçalho, um campo sem coluna correspondente segue `extraDataHandling` (padrão: cria a coluna no fim).

Com `mappingMode: "auto"`, o JSON de origem é o **item de entrada** do nó — a menos que `autoMappingSource` aponte outro lugar (`"{{ $node[\"HTTP Request\"].json.dados }}"`). Use-o quando as colunas tiverem de vir da saída de **outro** nó, ou de um sub-objeto; uma **lista de objetos** vira **uma linha por elemento**.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `credentialId` | string (credential_ref) | Sim (runtime) | `""` | Credencial `google_oauth2` (conta Google conectada). Deixe vazio ao gerar; o usuário conecta no painel. |
| `operation` | string | Sim | `"read"` | `"list"` \| `"create"` \| `"get_rows"` (ler linhas como objetos) \| `"read"` (matriz A1 crua) \| `"append"` \| `"append_or_update"` \| `"update"`. |
| `spreadsheetId` | string | get_rows/read/append/append_or_update/update | `""` | ID **ou** URL da planilha (o ID é extraído da URL). Aceita `{{ }}`. |
| `spreadsheetIdMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `spreadsheetSource` | string | Não | `"list"` | Só UI (`"list"` \| `"url"`): como o valor foi escolhido no editor. |
| `sheetName` | string | get_rows/append/append_or_update/update | `""` | Nome da **aba** lida ou alvo da escrita (ex.: `"Página1"`). Aceita `{{ }}`. |
| `sheetNameMode` | string | Não | `"expression"` | idem. |
| `sheetSource` | string | Não | `"list"` | Só UI (`"list"` \| `"name"`). |
| `mappingMode` | string | Não | `"manual"` | `"manual"` (um valor por coluna, em `columnMappings`) \| `"auto"` (cada campo do JSON de origem vira uma coluna: chave = nome da coluna, valor = célula) \| `"raw"` (matriz 2D em `values` — modo antigo). |
| `columnMappings` | array | mappingMode=manual | `[]` | `[{ "column": "Email", "value": "{{ $json.email }}", "valueMode": "expression" }]`. Colunas em branco não são gravadas (no update a célula existente fica intacta). |
| `matchingColumn` | string | update/append_or_update | `""` | Coluna-chave que localiza a linha (precisa existir no cabeçalho e ter valor mapeado). |
| `autoMappingSource` | string | Não | `""` | (mappingMode=auto) **De onde vem o JSON** cujos campos viram colunas. Vazio = item de entrada do nó. Para usar outro nó: `"{{ $node[\"HTTP Request\"].json }}"` ou um sub-objeto, `"{{ $node[\"HTTP Request\"].json.dados }}"`. Precisa ser **uma expressão única** (texto literal é recusado). Se resolver para uma **lista de objetos**, grava **uma linha por elemento**. |
| `autoMappingSourceMode` | string | Não | `"expression"` | idem. |
| `extraDataHandling` | string | Não | `"insert_new_column"` | Campo a gravar **sem coluna** com esse nome no cabeçalho: `"insert_new_column"` (cria a coluna no fim), `"ignore"` (não grava o campo), `"error"` (falha). Não se aplica à aba em branco — sem cabeçalho as colunas são sempre criadas. |
| `filters` | array | Não | `[]` | (get_rows) `[{ "column": "Email", "value": "{{ $json.email }}", "valueMode": "expression" }]` — devolve as linhas cuja coluna é igual ao valor. Comparação sem diferenciar maiúsculas. Filtro com valor vazio é ignorado. |
| `combineFilters` | string | Não | `"and"` | (get_rows) `"and"` \| `"or"`. |
| `returnFirstMatch` | boolean | Não | `false` | (get_rows) Devolve só a primeira linha que casar. |
| `limit` | number | Não | `0` | (get_rows) Máximo de linhas por item de entrada; `0` = todas (teto absoluto de 10.000 por execução). |
| `valueRenderOption` | string | Não | `"FORMATTED_VALUE"` | (get_rows) `"FORMATTED_VALUE"` (texto como na tela) \| `"UNFORMATTED_VALUE"` (número/data brutos — use para contas) \| `"FORMULA"`. |
| `headerRow` | number | Não | `1` | Linha do cabeçalho (nomes das colunas). |
| `firstDataRow` | number | Não | `2` | Primeira linha de dados (busca da coluna de correspondência). |
| `range` | string | read (e mappingMode=raw) | `""` | Intervalo A1, ex.: `"Página1!A1:D50"`. Aceita `{{ }}`. |
| `rangeMode` | string | Não | `"expression"` | idem. |
| `title` | string | create | `""` | Nome da planilha a criar. Aceita `{{ }}`. |
| `titleMode` | string | Não | `"expression"` | idem. |
| `sharing` | string | Não | `"private"` | (create) Acesso da planilha criada: `"private"` (só a conta conectada) \| `"anyone_reader"` (qualquer pessoa com o link vê) \| `"anyone_writer"` (qualquer pessoa com o link edita). **Só saia de `"private"` se o usuário pedir explicitamente uma planilha pública/compartilhada por link.** |
| `values` | string | mappingMode=raw | `""` | Matriz 2D: JSON literal (`[["A","B"],["c","d"]]`) **ou** expressão que resolva para array. |
| `valuesMode` | string | Não | `"expression"` | idem. |
| `valueInputOption` | string | Não | `"USER_ENTERED"` | `"USER_ENTERED"` (interpreta fórmulas/datas) \| `"RAW"`. |
| `nameFilter` | string | Não | `""` | (list) filtra planilhas cujo nome contenha o texto. |
| `pageSize` | number | Não | `50` | (list) máximo de resultados (1–1000). |
| `continueOnError` | boolean | Não | `false` | Encapsula o erro no output em vez de interromper. |

**Saída**: `list` → um item por planilha (`id`, `name`, `modifiedTime`, `webViewLink`); `get_rows` → **um item por linha**, `{ <coluna>: <valor>, …, rowNumber }` (o item **é** a linha: não há `operation` nem envelope); `read` → um item com `{ spreadsheetId, range, values, rowCount }` (use `split_out` sobre `values` para uma linha por item); `create` → `{ spreadsheetId, spreadsheetUrl, title, sharing }` (`sharing` = acesso efetivamente aplicado); `append`/`append_or_update`/`update` com mapeamento → **um item por linha gravada**: `{ operation, action: "appended"|"updated", ok, spreadsheetId, sheet, rowNumber, row: { coluna: valor } }` (+ `matchValue` no update/upsert); com `mappingMode: "raw"` → resposta crua da API + `ok`.

**Execução:** `get_rows` lê a aba **uma vez** e resolve os filtros **por item de entrada**, concatenando os resultados na ordem da entrada. `append`/`append_or_update`/`update` com mapeamento gravam **uma linha por item** de entrada, em lote — não precisa de Loop nem de `$items()`. `create`/`read` e o modo `raw` rodam **uma vez por execução do nó** (recurso único — 10 itens de entrada **não** criam 10 planilhas); nesses casos as expressões usam o 1º item e `$items()` agrega todos. `list` roda uma vez.

**Erros de negócio (categoria `user`)**: `sheets_missing_sheet` (aba vazia), `sheets_missing_header` (cabeçalho em branco **e** nenhum campo para criar as colunas), `sheets_unknown_column` (campo sem coluna com `extraDataHandling: "error"`), `sheets_too_many_rows` (get_rows acima de 10.000 linhas), `sheets_filter_expression`, `sheets_no_mapping` (nenhuma coluna preenchida), `sheets_missing_matching_column` / `sheets_matching_column_not_found`, `sheets_missing_match_value`, `sheets_row_not_found` (update sem linha correspondente — use `append_or_update` para inserir nesse caso), `sheets_upsert_requires_mapping`, `sheets_sharing_scope_missing` (acesso público pedido numa conta sem o escopo `drive.file` — falha antes de criar), `sheets_sharing_failed` (planilha criada, mas o compartilhamento por link foi recusado — ela fica privada), `sheets_missing_spreadsheet`/`sheets_missing_range`/`sheets_missing_title`/`sheets_missing_values` (campo obrigatório da operação vazio), `sheets_auto_source_expression`/`sheets_auto_source_invalid`/`sheets_auto_source_type` (`autoMappingSource` que não é uma expressão única ou não resolve para objeto/lista de objetos), `sheets_values_json`/`sheets_values_shape` (modo `raw` com matriz inválida), `sheets_missing_credential`/`sheets_credential_type`, `sheets_4xx` (o Google recusou). `sheets_5xx` é falha do provedor (`upstream`). Timeout de 45 s por chamada.

> Escopos concedidos no consent: `gmail.send` + `spreadsheets` + `drive.readonly` + `drive.file` (este último é o que permite compartilhar por link a planilha criada). Ao adicionar Sheets a uma conta que só usava Gmail, o usuário precisa **reconectar** (novo consent) para o token ganhar o escopo de planilhas.

---

### 4.18 `google_drive` — Google Drive

**Para leigos**: encontra arquivos e pastas no Google Drive e lê o conteúdo deles. Usa a **mesma** conta Google conectada do Gmail e do Sheets (credencial `google_oauth2`). É **somente leitura** — não cria, move nem apaga nada.

Escolha a **operação**: buscar arquivos e pastas, ler o conteúdo de um arquivo ou obter só os metadados.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `credentialId` | string (credential_ref) | Sim (runtime) | `""` | Credencial `google_oauth2`. Deixe vazio ao gerar; o usuário conecta no painel. |
| `operation` | string | Sim | `"list"` | `"list"` (buscar) \| `"read"` (ler conteúdo) \| `"get"` (metadados). |
| `folderSource` | string | Não | `"root"` | Só UI: `"root"` (Meu Drive) \| `"list"` \| `"id"` \| `"any"` (todo o Drive). |
| `folderId` | string | Não | `""` | (list) Pasta alvo: ID, URL `/folders/<id>` ou `{{ }}`. Vazio = raiz. |
| `folderIdMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `recursive` | boolean | Não | `false` | (list) Inclui subpastas (até 200 pastas por execução). |
| `nameFilter` | string | Não | `""` | (list) Só itens cujo nome contenha o texto. Aceita `{{ }}`. |
| `nameFilterMode` | string | Não | `"expression"` | idem. |
| `fileTypes` | string[] | Não | `["all"]` | (list) `all`, `folder`, `document`, `spreadsheet`, `presentation`, `pdf`, `image`, `video`, `audio`. |
| `orderBy` | string | Não | `"modifiedTime desc"` | (list) Ordenação da Drive API. Opções do painel: `"modifiedTime desc"`, `"modifiedTime"`, `"createdTime desc"`, `"name"`, `"name desc"`, `"quotaBytesUsed desc"`. |
| `limit` | number | Não | `50` | (list) Máximo de itens (1–1000); paginação automática até o limite. |
| `includeTrashed` | boolean | Não | `false` | (list) Inclui itens na lixeira. |
| `includeSharedDrives` | boolean | Não | `true` | Inclui Drives compartilhados. |
| `fileSource` | string | Não | `"list"` | Só UI (`"list"` \| `"url"`). |
| `fileId` | string | read/get | `""` | Arquivo alvo: ID, URL do Drive/Docs ou `{{ }}`. |
| `fileIdMode` | string | Não | `"expression"` | idem. |
| `exportAs` | string | Não | `"auto"` | (read) `auto`, `text`, `markdown`, `csv`, `html`, `pdf` — só afeta arquivos nativos do Google. |
| `includeBinary` | boolean | Não | `false` | (read) Acrescenta `contentBase64`; obrigatório para PDF, imagens e outros binários. |
| `maxSizeMb` | number | Não | `5` | (read) Teto do conteúdo lido (1–20 MB). |
| `continueOnError` | boolean | Não | `false` | Encapsula o erro no output em vez de interromper. |

**Saída**: `list` → **um item por arquivo**; `get` → um item por item de entrada; ambos com `{ operation, id, name, mimeType, kind, size, createdTime, modifiedTime, webViewLink, parents, owners, trashed }`. `read` acrescenta `{ exportedMimeType, encoding, content, contentBase64?, truncated }`.

**Execução:** `list` roda **uma vez** por execução do nó; `read` e `get` rodam **uma vez por item de entrada**. Por isso o encadeamento `google_drive (list) → google_drive (read)` com `fileId: "{{ $node[\"Buscar arquivos\"].json.id }}"` lê todos os arquivos encontrados **sem Loop**.

**Conversões (read)**: Documentos → Markdown, Planilhas → CSV, Apresentações → texto, Desenhos → PNG. Arquivos não textuais (PDF, imagem, zip) exigem `includeBinary: true`. Texto acima de `maxSizeMb` é cortado (`truncated: true`); binário acima do limite é erro.

**Erros de negócio (categoria `user`)**: `drive_scope_missing` (conta conectada sem acesso ao Drive — reconectar), `drive_binary_not_enabled`, `drive_file_too_large`, `drive_export_unsupported`, `drive_invalid_file_id`, `drive_missing_file_id`, `drive_missing_credential`/`drive_credential_type`, `drive_4xx` (o Google recusou). `drive_5xx` é falha do provedor (`upstream`). Timeout de 120 s por chamada.

> Escopo concedido no consent: `drive.readonly` (leitura de metadados **e** conteúdo). Contas conectadas antes deste nó precisam **reconectar** para o token ganhar o escopo.

### 4.19 `google_docs` — Google Docs

**Para leigos**: encontra documentos no Google Docs, lê o texto deles, **cria** documentos novos e **atualiza** documentos existentes. Usa a **mesma** conta Google conectada do Gmail, Sheets e Drive (credencial `google_oauth2`).

Escolha a **operação**: buscar documentos, ler o conteúdo, criar um documento ou atualizar um documento.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `credentialId` | string (credential_ref) | Sim (runtime) | `""` | Credencial `google_oauth2`. Deixe vazio ao gerar; o usuário conecta no painel. |
| `operation` | string | Sim | `"list"` | `"list"` (buscar) \| `"get"` (ler) \| `"create"` (criar) \| `"update"` (atualizar). |
| `nameFilter` | string | Não | `""` | (list) Só documentos cujo nome contenha o texto. Aceita `{{ }}`. |
| `nameFilterMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `folderSource` | string | Não | `"any"` | Só UI: `"any"` (todo o Drive, padrão) \| `"root"` \| `"list"` \| `"id"`. |
| `folderId` | string | Não | `""` | (list) Pasta **da busca** — não confundir com `targetFolderId`. |
| `folderIdMode` | string | Não | `"expression"` | idem. |
| `recursive` | boolean | Não | `false` | (list) Inclui subpastas (até 200 pastas por execução). |
| `limit` | number | Não | `50` | (list) Máximo de documentos (1–1000). |
| `orderBy` | string | Não | `"modifiedTime desc"` | (list) Ordenação da Drive API. Opções do painel: `"modifiedTime desc"`, `"modifiedTime"`, `"createdTime desc"`, `"name"`, `"name desc"`. |
| `includeTrashed` | boolean | Não | `false` | (list) Inclui itens na lixeira. |
| `includeSharedDrives` | boolean | Não | `true` | Inclui Drives compartilhados. |
| `documentSource` | string | Não | `"list"` | Só UI (`"list"` \| `"url"`). |
| `documentId` | string | get/update | `""` | Documento alvo: ID, URL `/document/d/<id>` ou `{{ }}`. |
| `documentIdMode` | string | Não | `"expression"` | idem. |
| `exportAs` | string | Não | `"markdown"` | (get) `"markdown"` \| `"text"` \| `"html"`. |
| `maxSizeMb` | number | Não | `5` | (get) Teto do conteúdo lido (1–20 MB). |
| `title` | string | create | `""` | Nome do documento criado. Aceita `{{ }}`. |
| `titleMode` | string | Não | `"expression"` | idem. |
| `contentFormat` | string | Não | `"markdown"` | (create) `"markdown"` \| `"html"` (ambos **convertidos** em documento formatado) \| `"text"` \| `"empty"`. |
| `content` | string | create (opc.) / update `append`+`replace_all` | `""` | Conteúdo inicial ou texto a escrever. Máx. **1 MB**. Aceita `{{ }}`. |
| `contentMode` | string | Não | `"expression"` | idem. |
| `targetFolderSource` | string | Não | `"root"` | Só UI: pasta de destino do create. |
| `targetFolderId` | string | Não | `""` | (create) Pasta **de destino**. Vazio = raiz do Meu Drive. |
| `targetFolderIdMode` | string | Não | `"expression"` | idem. |
| `sharing` | string | Não | `"private"` | (create) Acesso do documento criado: `"private"` (só a conta conectada) \| `"anyone_reader"` (qualquer pessoa com o link vê) \| `"anyone_writer"` (qualquer pessoa com o link edita). **Só saia de `"private"` se o usuário pedir explicitamente um documento público/compartilhado por link.** |
| `updateAction` | string | Não | `"append"` | (update) `"append"` \| `"replace_all"` \| `"replace_text"`. |
| `appendNewline` | boolean | Não | `true` | (update `append`) Insere quebra de linha antes do texto. |
| `textReplacements` | array | update `replace_text` | `[]` | Linhas `{ search, replace, replaceMode }`. Máx. 50. |
| `matchCase` | boolean | Não | `false` | (update `replace_text`) Diferencia maiúsculas. |
| `continueOnError` | boolean | Não | `false` | Encapsula o erro no output em vez de interromper. |

**Saída**: `list`/`get` → `{ operation, id, name, mimeType, kind, createdTime, modifiedTime, webViewLink, parents, owners, trashed }`, e o `get` acrescenta `{ exportedMimeType, encoding, content, truncated }`. `create` → `{ operation, id, name, webViewLink, contentFormat, converted, folderId?, sharing }` (`sharing` = acesso efetivamente aplicado). `update` → `{ operation, id, updateAction, webViewLink, occurrencesChanged? }`.

**Execução:** `list` roda **uma vez** por execução do nó; `get`, `create` e `update` rodam **uma vez por item de entrada** (teto de **50 documentos por execução** nas escritas). Por isso `google_docs (list) → google_docs (get)` com `documentId: "{{ $node[\"Buscar documentos\"].json.id }}"` lê todos os documentos encontrados **sem Loop**.

**Formatação:** conteúdo **formatado** (títulos, listas, negrito, tabelas) só sai de `create` com `contentFormat: "markdown"` ou `"html"` — o Google converte no upload. Em `update`, `append`/`replace_all` inserem **texto puro**; para preencher um modelo mantendo a formatação, use `replace_text`.

**Marcadores (`replace_text`):** cada linha é `{ "search": "<<cliente>>", "replace": "{{ $json.cliente }}", "replaceMode": "expression" }`. O `search` é **literal** — nunca avaliado como expressão. Prefira `<<nome>>` a `{{nome}}` para não confundir com as expressões do Waipe.

**Erros de negócio (categoria `user`)**: `docs_scope_missing` (conta conectada sem escopo de Docs — reconectar), `docs_not_a_document`, `docs_missing_title`, `docs_missing_content`, `docs_content_too_large`, `docs_max_documents`, `docs_max_replacements`, `docs_missing_replacements`, `docs_bad_document_id`, `docs_bad_folder_id`, `docs_missing_document_id`, `docs_bad_update_action`, `docs_sharing_failed` (documento criado, mas o compartilhamento por link foi recusado — ele fica privado), `docs_missing_credential`/`docs_credential_type`, `docs_4xx` (o Google recusou). `docs_5xx` é falha do provedor (`upstream`). Timeout de 120 s por chamada.

> Escopos concedidos no consent: `documents` (criar/atualizar) e `drive.file` (criar o arquivo na pasta escolhida, com conversão), além do `drive.readonly` já existente. Contas conectadas antes deste nó precisam **reconectar** para `create`/`update`; `list`/`get` funcionam sem isso.

Exemplo importável — relatório do dia gerado por IA e gravado no Docs:

```json
{
  "waipe_flow_version": "2",
  "name": "Relatório diário no Google Docs",
  "description": "Todo dia às 7h: busca dados, resume com IA e cria um documento formatado.",
  "triggerType": "schedule",
  "scheduleConfig": { "type": "daily", "hour": 7, "minute": 0, "timezone": "America/Sao_Paulo" },
  "nodes": [
    { "id": "n1", "type": "trigger_schedule", "name": "Todo dia 7h",
      "position": { "x": 100, "y": 200 },
      "parameters": { "type": "daily", "hour": 7, "minute": 0, "timezone": "America/Sao_Paulo" } },
    { "id": "n2", "type": "http_request", "name": "Buscar vendas",
      "position": { "x": 380, "y": 200 },
      "parameters": {
        "method": "GET",
        "url": "https://api.exemplo.com/vendas/ontem",
        "urlMode": "fixed",
        "authType": "none",
        "timeoutSeconds": 30,
        "continueOnError": false
      } },
    { "id": "n3", "type": "waipe_ai", "name": "Resumir",
      "position": { "x": 660, "y": 200 },
      "parameters": {
        "model": "gpt-4o-mini",
        "message": "Resume as vendas de ontem em Markdown, com um título de nível 1 e uma lista de destaques:\n\n{{ $node[\"Buscar vendas\"].json.parsedBody }}",
        "messageMode": "expression",
        "outputFieldName": "output"
      } },
    { "id": "n4", "type": "google_docs", "name": "Criar documento",
      "position": { "x": 940, "y": 200 },
      "parameters": {
        "credentialId": "",
        "operation": "create",
        "title": "Relatório de vendas — {{ $today }}",
        "titleMode": "expression",
        "contentFormat": "markdown",
        "content": "{{ $node[\"Resumir\"].json.output }}",
        "contentMode": "expression",
        "targetFolderSource": "root",
        "targetFolderId": "",
        "targetFolderIdMode": "expression",
        "continueOnError": false
      } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3" },
    { "id": "e3", "source": "n3", "target": "n4" }
  ]
}
```

---

### 4.20 `trigger_zapi` — Z-API: Mensagem Recebida

**Para leigos**: o flow começa quando alguém manda uma mensagem de WhatsApp para o número conectado à Z-API. O usuário cola a URL do flow no webhook "Ao receber" do painel da Z-API; cada mensagem que passar pelos filtros vira **uma execução**, já com os dados traduzidos para campos em português (`telefone`, `texto`, `tipo`…).

Funciona sobre a mesma infraestrutura do `trigger_webhook` (o flow ganha uma URL `/webhook/:token`, que **precisa ser HTTPS** — a Z-API recusa outra coisa). Diferenças: a resposta à Z-API é **sempre `200` imediata** (ela não espera o flow terminar; não há `responseMode`), e o gatilho **não usa credencial** — a credencial `zapi` é só do `zapi_send`.

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `ignoreFromMe` | boolean | Não | `true` | Descarta mensagens enviadas pelo próprio número conectado (`fromMe`). |
| `ignoreGroups` | boolean | Não | `false` | Descarta mensagens recebidas em grupos (`isGroup`). |
| `ignoreNotifications` | boolean | Não | `true` | Descarta eventos que não são mensagem (entrada/saída de grupo, chamada perdida, mensagem apagada…). |
| `acceptedTypes` | array de strings | Não | `[]` | Vazio = todos os tipos (inclusive `outro`). Valores: `"texto"`, `"imagem"`, `"audio"`, `"video"`, `"documento"`, `"botao"`, `"lista"`, `"localizacao"`, `"contato"`. |

**Filtros são por flow e acontecem antes de a execução existir**: um payload descartado **não cria execução** (não aparece no histórico); a Z-API recebe `200 {"status":"filtered"}` para não reenviar. Ordem: notificação → `fromMe` → grupo → tipo. (Os filtros do painel da Z-API valem para a instância inteira; os do node valem só para este flow.)

**Raiz do documento**: `"triggerType": "webhook"` (não existe `"zapi"` — ver §2.1) e `"webhookMethod": "POST"`. Não gere `webhookConfig` para este gatilho (a resposta é sempre imediata).

**Saída** (item inicial do flow — use sempre `$node["Nome do gatilho"].json.campo`):

```json
{ "json": {
  "telefone": "5543999999999", "nome_contato": "Ana", "mensagem_id": "3EB0…",
  "tipo": "texto", "texto": "Olá, qual o horário?", "midia_url": null, "midia_nome": null,
  "botao_id": null, "e_grupo": false, "participante": null, "enviado_por_mim": false,
  "recebido_em": "2026-09-03T14:22:18.000Z", "evento": "ReceivedCallback",
  "telefone_conectado": "5543988888888", "payload_original": { "…": "corpo cru recebido da Z-API" }
} }
```

| Campo | Conteúdo |
|---|---|
| `tipo` | Derivado do bloco presente no payload: `texto`, `imagem`, `audio`, `video`, `documento`, `botao` (resposta a botão), `lista` (resposta a lista de opções), `localizacao`, `contato` ou **`outro`** (enquetes, reações, pedidos… — o payload completo continua em `payload_original`). |
| `texto` | Texto da mensagem; em mídia é a **legenda**; em `botao`/`lista` é o rótulo escolhido. |
| `midia_url` / `midia_nome` | URL do arquivo (imagem, vídeo, áudio, documento — disponível nos servidores da Z-API por 30 dias) e nome do documento. |
| `botao_id` | Id do botão tocado ou da opção escolhida (`buttonId`/`selectedRowId`) — é como um flow de menu sabe o que o usuário escolheu. |
| `e_grupo`, `participante` | Se veio de grupo e o telefone de quem escreveu no grupo. |
| `recebido_em` | ISO 8601 (o `momment` da Z-API, em milissegundos). |
| `evento` | `type` cru da Z-API (`ReceivedCallback` numa mensagem recebida) — distingue callbacks quando a mesma URL é usada em vários webhooks. |
| `telefone_conectado` | Número da instância que recebeu a mensagem. |

**Campo ausente ou vazio vem como `null`** (nunca falha o gatilho). Para responder à mensagem exata no `zapi_send`, use `mensagem_id` em `replyToMessageId`.

```json
{ "id": "n1", "type": "trigger_zapi", "name": "Recebe WhatsApp",
  "position": { "x": 100, "y": 200 },
  "parameters": { "ignoreFromMe": true, "ignoreGroups": true, "ignoreNotifications": true,
                  "acceptedTypes": ["texto", "botao", "lista"] } }
```

---

### 4.21 `zapi_send` — Z-API: Enviar WhatsApp

**Para leigos**: envia mensagens de WhatsApp pela instância Z-API conectada — texto, link com preview, imagem, vídeo, documento, botões ou lista de opções. Envia **uma mensagem por item de entrada** (10 itens = 10 mensagens); para mandar uma só, agregue antes com `merge_out`.

Requer uma credencial do tipo **`zapi`** (`instanceId`, `instanceToken`, `clientToken` — ver §2.7). Deixe `credentialId: ""` ao gerar. A URL da Z-API é montada no worker a partir da credencial; **nada de token no JSON**.

**Base (todas as operações)**:

| Chave | Tipo | Obrig. | Default | Descrição |
|---|---|---|---|---|
| `credentialId` | string (credential_ref) | Sim (runtime) | `""` | Credencial `zapi`. Sem ela → `zapi_credential_missing`. |
| `operation` | string | **Sim** | `"send_text"` | Uma das 8 operações abaixo. Desconhecida → importação rejeitada. |
| `phone` | string | Sim (runtime) | `""` | DDI + DDD + número; aceita `{{ }}`. Máscara, espaços, parênteses, hífen e `+` são removidos (`+55 (43) 99999-9999` → `5543999999999`). **Id de grupo** (`…-1614721132` ou `…@g.us`) passa intacto. Vazio/sem dígitos → `zapi_invalid_phone`. |
| `phoneMode` | string | Não | `"expression"` | `"fixed"` \| `"expression"`. |
| `delayMessage` | número | Não | `0` | Atraso antes de enviar, inteiro **0–15 s**. `0` = padrão da Z-API (1–3 s). Fora do intervalo → importação rejeitada. (O painel oculta o campo em `send_button_actions`, mas o valor é enviado em qualquer operação.) |
| `delayTyping` | número | Não | `0` | Tempo exibindo "Digitando…", inteiro **0–15 s**. Só `send_text` e `send_link`. |
| `replyToMessageId` | string | Não | `""` | Id da mensagem a responder (use `mensagem_id` do `trigger_zapi`); aceita `{{ }}` (`replyToMessageIdMode`). Só texto, link, imagem, vídeo e documento. |
| `continueOnError` | boolean | Não | `false` | `true`: falha de envio vira `zapi_ok: false` + `zapi_status` + `zapi_erro` no item e o flow segue. |

**Operações** — `operation` decide quais campos são lidos (todos os campos de texto aceitam `{{ }}` e têm o par `*Mode`, default `"expression"`):

| `operation` | Campos obrigatórios (runtime) | Campos opcionais |
|---|---|---|
| `send_text` | `message` | — |
| `send_link` | `message`, `linkUrl`, `title`, `linkDescription`, `image` (imagem do preview) | `linkType` (`"SMALL"` (default) \| `"MEDIUM"` \| `"LARGE"`) |
| `send_image` | `image` | `caption`, `viewOnce` (boolean) |
| `send_video` | `video` | `caption`, `viewOnce`, `async` (boolean — a Z-API processa em segundo plano; falha posterior não aparece no resultado) |
| `send_document` | `document`, `extension` | `fileName`, `caption` |
| `send_button_actions` | `message`, `buttonActions[]` (≥ 1) | `title`, `footer`, `image` |
| `send_button_list` | `message`, `buttons[]` (≥ 1) | — |
| `send_option_list` | `message`, `optionListTitle`, `optionListButtonLabel`, `options[]` (≥ 1) | — |

Regras por operação:

- **Mídia** (`image`, `video`, `document`): URL **pública** ou Base64 com prefixo `data:`. URL privada, loopback ou de metadados de nuvem → `zapi_media_unreachable` (quem baixa a mídia é a Z-API, mas a validação anti-SSRF é feita no worker). Vídeo: máx. 100 MB, preferir H.264.
- **`send_link`**: a Z-API exige que a URL apareça também **no final do texto** de `message`; sem isso o preview não é gerado.
- **`send_document`**: `extension` ∈ `"pdf"` (default) \| `"xlsx"` \| `"docx"` \| `"csv"` \| `"txt"` \| `"zip"` \| `"other"`; com `"other"`, informe `extensionCustom` (só letras e números, sem ponto — a extensão compõe o caminho do endpoint; formato inválido → importação rejeitada / `zapi_invalid_extension`).
- **Botões** (`send_button_actions`, `send_button_list`): exigem aceitar os Termos de uso dos botões no painel Z-API, e o comportamento varia entre WhatsApp comum/Business e conversa/grupo. Quando a estabilidade importar, prefira `send_option_list` — que, por sua vez, **não funciona em grupos**. A escolha do usuário volta no `trigger_zapi` como `tipo: "botao"`/`"lista"` com `botao_id`.

Forma das listas (gravadas **planas**, sem aninhamento; `id` vazio recebe a posição `"1"`, `"2"`… — o `id` é o que volta em `botao_id`):

```json
"buttonActions": [ { "id": "sim", "type": "REPLY", "label": "Sim" }, { "id": "nao", "type": "REPLY", "label": "Não" } ]
"buttonActions": [ { "id": "1", "type": "URL",  "label": "Ver site", "url": "https://exemplo.com" },
                   { "id": "2", "type": "CALL", "label": "Ligar",    "phone": "5543999999999" } ]
"buttons":       [ { "id": "1", "label": "Sim" } ]
"options":       [ { "id": "1", "title": "Suporte", "description": "Falar com a equipe" } ]
```

`buttonActions[].type` é `"REPLY"`, `"URL"` (exige `url` começando por `http://`/`https://`) ou `"CALL"` (exige `phone`). `label`, `url`, `phone`, `title` e `description` aceitam `{{ }}` (`labelMode`, `urlMode`, `phoneMode`, `titleMode`, `descriptionMode`). **Nunca misture `REPLY` com `CALL`/`URL` no mesmo node** — a importação é recusada com `zapi_button_mix_not_allowed` (o WhatsApp Web gera erro); `CALL` + `URL` juntos são aceitos.

**O que a importação valida (Zod)**: `operation` conhecida; `delayMessage`/`delayTyping` inteiros 0–15; mistura `REPLY` + `CALL`/`URL`; `extension` com caracteres inválidos; `url` de botão preenchida sem `http(s)://` (uma expressão `{{ }}` passa). **Campos obrigatórios vazios não são recusados na importação** (um node recém-criado precisa ser salvável) — são verificados em runtime (`zapi_missing_field`).

**Execução**:

1. Carrega a credencial e consulta **`GET /status` da instância uma vez** por execução do node: a Z-API aceita e enfileira mensagens com a instância desconectada (responde `200` com `messageId`), então só essa consulta detecta a desconexão. `connected: false` → `zapi_instance_disconnected` (com `continueOnError`, o erro é encapsulado em **todos** os itens).
2. Por item: avalia as expressões, normaliza o telefone, monta o corpo e faz o `POST`. Timeout de 45 s por requisição; sem retry e sem controle de ritmo (100 itens = 100 requisições sequenciais; `delayMessage` é atraso de entrega no WhatsApp, não da API).
3. Entrada **vazia** conta como **um item vazio**: o node sempre tenta enviar pelo menos uma mensagem (com `{{ $json.telefone }}` vazio, falha com `zapi_invalid_phone` — falha visível em vez de silêncio).
4. Campo opcional cuja expressão resolve para vazio é **omitido** do pedido; se a Z-API exigir esse campo, o envio falha com `zapi_null_not_allowed`. Erro de avaliação de expressão **nunca** é engolido.
5. "Testar nó" no editor **não envia nada**: devolve `nodeTestSkipped: true` com o telefone normalizado e a mensagem avaliada.

**Saída**: um item por item de entrada, **preservando os campos de entrada** e acrescentando:

```json
{ "json": { "…campos de entrada": "…", "zapi_ok": true, "zapi_status": 200,
            "zapi_message_id": "D241XXXX732339502B68", "zapi_zaap_id": "3999984263738042930CD6ECDE9VDWSA" } }
```

Com `continueOnError: true`, a falha vira `{ "zapi_ok": false, "zapi_status": <HTTP ou 0>, "zapi_erro": "…" }`.

**Erros (categoria `user`)**: `zapi_credential_missing`, `zapi_credential_type`, `zapi_instance_disconnected`, `zapi_client_token_invalid` (Client-Token ausente/inválido na credencial), `zapi_status_refused` (`GET /status` recusado — Client-Token ou id/token da instância errados), `zapi_invalid_phone`, `zapi_missing_field`, `zapi_media_unreachable`, `zapi_invalid_extension`, `zapi_button_mix_not_allowed`, `zapi_invalid_button_url`, `zapi_invalid_button_type`, `zapi_unknown_operation`, `zapi_null_not_allowed`, `zapi_4xx` (a Z-API recusou; a mensagem traz o HTTP e o corpo devolvido). `zapi_5xx`, `zapi_status_unavailable` e `zapi_network_error` são falhas do provedor (`upstream`).

Exemplo de node (resposta automática à mensagem recebida — o flow completo está em §5.7):

```json
{ "id": "n3", "type": "zapi_send", "name": "Responder no WhatsApp",
  "position": { "x": 700, "y": 200 },
  "parameters": {
    "credentialId": "",
    "operation": "send_text",
    "phone": "{{ $node[\"Recebe WhatsApp\"].json.telefone }}", "phoneMode": "expression",
    "message": "Olá {{ $node[\"Recebe WhatsApp\"].json.nome_contato }}, recebemos a sua mensagem!", "messageMode": "expression",
    "replyToMessageId": "{{ $node[\"Recebe WhatsApp\"].json.mensagem_id }}", "replyToMessageIdMode": "expression",
    "continueOnError": false
  } }
```

---

## Parte 5 — Exemplos completos de flows importáveis

### 5.1 Mínimo — manual → HTTP → transformação

```json
{
  "waipe_flow_version": "2",
  "name": "Buscar cotação do dólar",
  "description": "Execução manual: consulta uma API pública e formata o resultado.",
  "triggerType": "manual",
  "nodes": [
    { "id": "n1", "type": "trigger_manual", "name": "Início",
      "position": { "x": 100, "y": 200 }, "parameters": {} },
    { "id": "n2", "type": "http_request", "name": "Consultar API",
      "position": { "x": 400, "y": 200 },
      "parameters": {
        "method": "GET",
        "url": "https://economia.awesomeapi.com.br/json/last/USD-BRL",
        "urlMode": "fixed",
        "authType": "none",
        "timeoutSeconds": 30,
        "continueOnError": false
      } },
    { "id": "n3", "type": "edit_fields", "name": "Formatar",
      "position": { "x": 700, "y": 200 },
      "parameters": {
        "mode": "manual",
        "includeOtherFields": false,
        "fields": [
          { "name": "moeda",   "value": "USD/BRL", "valueMode": "fixed", "valueType": "string" },
          { "name": "cotacao", "value": "{{ $json.parsedBody.USDBRL.bid }}", "valueMode": "expression", "valueType": "number" },
          { "name": "consultado_em", "value": "{{ $now }}", "valueMode": "expression", "valueType": "string" }
        ]
      } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3" }
  ]
}
```

### 5.2 Webhook com IF e respostas distintas (responseMode `by_node`)

```json
{
  "waipe_flow_version": "2",
  "name": "Triagem de pedidos via webhook",
  "description": "Recebe um pedido por webhook; valor > 1000 exige aprovação.",
  "triggerType": "webhook",
  "webhookMethod": "POST",
  "webhookConfig": { "responseMode": "by_node", "syncMaxWaitMs": 120000, "blockCommonBots": false },
  "nodes": [
    { "id": "n1", "type": "trigger_webhook", "name": "Receber Pedido",
      "position": { "x": 100, "y": 250 },
      "parameters": {
        "method": "POST",
        "authType": "header_token",
        "authHeaderName": "X-Api-Key",
        "authHeaderValue": "SUBSTITUA_PELO_TOKEN",
        "responseMode": "by_node",
        "responseCode": 200,
        "responseData": "none",
        "ignoreBots": false,
        "allowedIPs": "",
        "maxBodyMB": 16
      } },
    { "id": "n2", "type": "if", "name": "Valor alto?",
      "position": { "x": 420, "y": 250 },
      "parameters": {
        "combine": "and",
        "conditions": [
          { "left": "{{ $json.valor }}", "leftMode": "expression",
            "operator": "number:gt", "right": "1000", "rightMode": "fixed" }
        ],
        "caseInsensitive": true,
        "typeValidation": "loose",
        "nullAsEmpty": true
      } },
    { "id": "n3", "type": "webhook_respond", "name": "Responder: em análise",
      "position": { "x": 740, "y": 130 },
      "parameters": {
        "statusCode": 202,
        "body": "{\"status\":\"em_analise\",\"pedido\":\"{{ $json.id }}\"}",
        "bodyMode": "expression",
        "headers": [ { "name": "Content-Type", "value": "application/json" } ]
      } },
    { "id": "n4", "type": "webhook_respond", "name": "Responder: aprovado",
      "position": { "x": 740, "y": 370 },
      "parameters": {
        "statusCode": 200,
        "body": "{\"status\":\"aprovado\",\"pedido\":\"{{ $json.id }}\"}",
        "bodyMode": "expression",
        "headers": [ { "name": "Content-Type", "value": "application/json" } ]
      } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3", "sourceHandle": "true" },
    { "id": "e3", "source": "n2", "target": "n4", "sourceHandle": "false" }
  ]
}
```

### 5.3 Agendado — buscar, filtrar, classificar com IA e enviar

```json
{
  "waipe_flow_version": "2",
  "name": "Resumo diário de tickets críticos",
  "description": "Todo dia às 8h: busca tickets, filtra os abertos, resume com IA e envia para outro sistema.",
  "triggerType": "schedule",
  "scheduleConfig": { "type": "daily", "hour": 8, "minute": 0, "timezone": "America/Sao_Paulo" },
  "nodes": [
    { "id": "n1", "type": "trigger_schedule", "name": "Todo dia 8h",
      "position": { "x": 100, "y": 200 },
      "parameters": {
        "scheduleType": "daily", "hour": 8, "minute": 0,
        "timezone": "America/Sao_Paulo"
      } },
    { "id": "n2", "type": "http_request", "name": "Buscar Tickets",
      "position": { "x": 400, "y": 200 },
      "parameters": {
        "method": "GET",
        "url": "https://api.exemplo.com/tickets?since={{ $today }}",
        "urlMode": "expression",
        "authType": "bearer_inline",
        "bearerToken": "SUBSTITUA_PELO_TOKEN",
        "timeoutSeconds": 30,
        "continueOnError": false
      } },
    { "id": "n3", "type": "loop", "name": "Um ticket por item",
      "position": { "x": 700, "y": 200 },
      "parameters": {
        "arrayExpression": "{{ $json.parsedBody.tickets }}",
        "arrayExpressionMode": "expression",
        "batchSize": 1,
        "pauseBetweenBatchesSeconds": 0,
        "continueOnItemError": false
      } },
    { "id": "n4", "type": "filter", "name": "Só abertos",
      "position": { "x": 1000, "y": 200 },
      "parameters": {
        "combine": "and",
        "conditions": [
          { "left": "{{ $json.status }}", "leftMode": "expression",
            "operator": "string:equals", "right": "aberto", "rightMode": "fixed" }
        ],
        "caseInsensitive": true,
        "typeValidation": "loose",
        "nullAsEmpty": true
      } },
    { "id": "n5", "type": "waipe_ai", "name": "Classificar urgência",
      "position": { "x": 1300, "y": 200 },
      "parameters": {
        "model": "gpt-4o-mini",
        "message": "Classifique a urgência deste ticket como baixa, media ou alta. Responda apenas a palavra. Ticket: {{ JSON.stringify($json) }}",
        "messageMode": "expression",
        "systemPrompt": "Você é um triador de suporte. Responda com uma única palavra.",
        "systemPromptMode": "fixed",
        "temperature": 0.2,
        "maxTokens": 10,
        "outputFormat": "text",
        "outputFieldName": "urgencia",
        "includeUsageData": false
      } },
    { "id": "n6", "type": "http_request", "name": "Enviar resultado",
      "position": { "x": 1600, "y": 200 },
      "parameters": {
        "method": "POST",
        "url": "https://hooks.exemplo.com/tickets-classificados",
        "urlMode": "fixed",
        "authType": "none",
        "contentType": "application/json",
        "jsonBodyMode": "editor",
        "body": "{\"ticket\": {{ JSON.stringify($json) }}, \"urgencia\": \"{{ $json.urgencia }}\"}",
        "bodyMode": "expression",
        "timeoutSeconds": 30,
        "continueOnError": true
      } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3" },
    { "id": "e3", "source": "n3", "target": "n4", "sourceHandle": "loop" },
    { "id": "e4", "source": "n4", "target": "n5" },
    { "id": "e5", "source": "n5", "target": "n6" }
  ]
}
```

### 5.4 Switch com três rotas + fallback e código de agregação

```json
{
  "waipe_flow_version": "2",
  "name": "Roteamento por status com agregação",
  "triggerType": "manual",
  "nodes": [
    { "id": "n1", "type": "trigger_manual", "name": "Início",
      "position": { "x": 100, "y": 300 }, "parameters": {} },
    { "id": "n2", "type": "switch", "name": "Rotear por status",
      "position": { "x": 400, "y": 300 },
      "parameters": {
        "fieldExpression": "{{ $json.status }}",
        "fieldExpressionMode": "expression",
        "dataType": "string",
        "matchMode": "first",
        "rules": [
          { "operator": "equals", "value": "novo",      "outputLabel": "novo" },
          { "operator": "equals", "value": "andamento", "outputLabel": "andamento" },
          { "operator": "equals", "value": "fechado",   "outputLabel": "fechado" }
        ],
        "fallbackEnabled": true,
        "fallbackLabel": "Outros"
      } },
    { "id": "n3", "type": "edit_fields", "name": "Marcar novo",
      "position": { "x": 720, "y": 100 },
      "parameters": { "mode": "merge", "includeOtherFields": false,
        "fields": [ { "name": "fila", "value": "triagem", "valueMode": "fixed", "valueType": "string" } ] } },
    { "id": "n4", "type": "edit_fields", "name": "Marcar andamento",
      "position": { "x": 720, "y": 260 },
      "parameters": { "mode": "merge", "includeOtherFields": false,
        "fields": [ { "name": "fila", "value": "acompanhamento", "valueMode": "fixed", "valueType": "string" } ] } },
    { "id": "n5", "type": "edit_fields", "name": "Marcar fechado",
      "position": { "x": 720, "y": 420 },
      "parameters": { "mode": "merge", "includeOtherFields": false,
        "fields": [ { "name": "fila", "value": "arquivo", "valueMode": "fixed", "valueType": "string" } ] } },
    { "id": "n6", "type": "code", "name": "Resumo",
      "position": { "x": 720, "y": 580 },
      "parameters": {
        "mode": "all_items",
        "jsCode": "return [{ json: { aviso: \"status desconhecido\", total: items.length, exemplo: items[0] ? items[0].json : null } }];"
      } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3", "sourceHandle": "novo" },
    { "id": "e3", "source": "n2", "target": "n4", "sourceHandle": "andamento" },
    { "id": "e4", "source": "n2", "target": "n5", "sourceHandle": "fechado" },
    { "id": "e5", "source": "n2", "target": "n6", "sourceHandle": "Outros" }
  ]
}
```

### 5.5 Registros da API um a um → agregados → e-mail (`split_out` + `merge_out` + `gmail_send`)

Padrão recomendado quando a API devolve **um item com um array dentro**: separar, filtrar registro a registro, juntar de volta e enviar **um único** e-mail.

```json
{
  "waipe_flow_version": "2",
  "name": "Aviso diário de pedidos atrasados",
  "description": "Busca pedidos, separa em itens, filtra os atrasados, agrega e envia um e-mail.",
  "triggerType": "schedule",
  "scheduleConfig": { "type": "daily", "hour": 7, "minute": 30, "timezone": "America/Sao_Paulo" },
  "nodes": [
    { "id": "n1", "type": "trigger_schedule", "name": "Todo dia 7h30",
      "position": { "x": 100, "y": 200 },
      "parameters": { "scheduleType": "daily", "hour": 7, "minute": 30, "timezone": "America/Sao_Paulo" } },
    { "id": "n2", "type": "http_request", "name": "Buscar Pedidos",
      "position": { "x": 400, "y": 200 },
      "parameters": {
        "method": "GET",
        "url": "https://api.exemplo.com/pedidos?status=aberto",
        "urlMode": "fixed",
        "authType": "bearer_inline",
        "bearerToken": "SUBSTITUA_PELO_TOKEN",
        "timeoutSeconds": 30,
        "continueOnError": false
      } },
    { "id": "n3", "type": "split_out", "name": "Um pedido por item",
      "position": { "x": 700, "y": 200 },
      "parameters": {
        "arrayExpression": "{{ $node[\"Buscar Pedidos\"].json.parsedBody }}",
        "arrayExpressionMode": "expression",
        "include": "none",
        "continueIfEmpty": false
      } },
    { "id": "n4", "type": "filter", "name": "Só atrasados",
      "position": { "x": 1000, "y": 200 },
      "parameters": {
        "combine": "and",
        "conditions": [
          { "left": "{{ $json.dias_atraso }}", "leftMode": "expression",
            "operator": "number:gt", "right": "0", "rightMode": "fixed" }
        ],
        "caseInsensitive": true,
        "typeValidation": "loose",
        "nullAsEmpty": true,
        "continueIfEmpty": false
      } },
    { "id": "n5", "type": "merge_out", "name": "Agregar atrasados",
      "position": { "x": 1300, "y": 200 },
      "parameters": {
        "mode": "all_items",
        "outputFieldName": "pedidos",
        "include": "selected",
        "fieldsToInclude": "id, cliente, valor, dias_atraso"
      } },
    { "id": "n6", "type": "gmail_send", "name": "Enviar resumo",
      "position": { "x": 1600, "y": 200 },
      "parameters": {
        "credentialId": "",
        "to": "operacao@exemplo.com", "toMode": "fixed",
        "subject": "{{ $node[\"Agregar atrasados\"].json.pedidos.length }} pedidos atrasados em {{ $today }}", "subjectMode": "expression",
        "bodyType": "text",
        "body": "Pedidos atrasados:\n\n{{ $node[\"Agregar atrasados\"].json.pedidos }}", "bodyMode": "expression",
        "continueOnError": false
      } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3" },
    { "id": "e3", "source": "n3", "target": "n4" },
    { "id": "e4", "source": "n4", "target": "n5" },
    { "id": "e5", "source": "n5", "target": "n6" }
  ]
}
```

Pontos que fazem este flow funcionar:

- O `merge_out` devolve **1 item**, então o `gmail_send` envia **um** e-mail (não um por pedido).
- `{{ $node["Agregar atrasados"].json.pedidos }}` no corpo é um array e sai **serializado como JSON** — sem `JSON.stringify`.
- Se nenhum pedido estiver atrasado, o `filter` (`continueIfEmpty: false`) **encerra o ramo**: nada é agregado e nenhum e-mail é enviado; `n5`/`n6` ficam `skipped`.

### 5.6 Fan-out e merge — dois ramos a partir de um node comum

Um node comum pode alimentar **vários** filhos, e vários filhos podem convergir num só node (§2.6).

```json
{
  "waipe_flow_version": "2",
  "name": "Fan-out: registrar e notificar",
  "triggerType": "manual",
  "nodes": [
    { "id": "n1", "type": "trigger_manual", "name": "Início",
      "position": { "x": 100, "y": 300 }, "parameters": {} },
    { "id": "n2", "type": "http_request", "name": "Buscar Vendas",
      "position": { "x": 400, "y": 300 },
      "parameters": { "method": "GET", "url": "https://api.exemplo.com/vendas", "urlMode": "fixed",
        "authType": "none", "timeoutSeconds": 30, "continueOnError": false } },
    { "id": "n3", "type": "split_out", "name": "Uma venda por item",
      "position": { "x": 700, "y": 300 },
      "parameters": { "arrayExpression": "{{ $node[\"Buscar Vendas\"].json.parsedBody }}",
        "arrayExpressionMode": "expression", "include": "none", "continueIfEmpty": false } },
    { "id": "n4", "type": "filter", "name": "Alto valor",
      "position": { "x": 1000, "y": 160 },
      "parameters": { "combine": "and",
        "conditions": [ { "left": "{{ $json.valor }}", "leftMode": "expression",
          "operator": "number:gte", "right": "10000", "rightMode": "fixed" } ],
        "caseInsensitive": true, "typeValidation": "loose", "nullAsEmpty": true,
        "continueIfEmpty": true } },
    { "id": "n5", "type": "filter", "name": "Cliente novo",
      "position": { "x": 1000, "y": 440 },
      "parameters": { "combine": "and",
        "conditions": [ { "left": "{{ $json.cliente_novo }}", "leftMode": "expression",
          "operator": "boolean:true", "right": "", "rightMode": "fixed" } ],
        "caseInsensitive": true, "typeValidation": "loose", "nullAsEmpty": true,
        "continueIfEmpty": true } },
    { "id": "n6", "type": "merge_out", "name": "Juntar destaques",
      "position": { "x": 1300, "y": 300 },
      "parameters": { "mode": "all_items", "outputFieldName": "destaques", "include": "all" } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3" },
    { "id": "e3", "source": "n3", "target": "n4" },
    { "id": "e4", "source": "n3", "target": "n5" },
    { "id": "e5", "source": "n4", "target": "n6" },
    { "id": "e6", "source": "n5", "target": "n6" }
  ]
}
```

- `n3` tem **duas** edges de saída (sem `sourceHandle`): `n4` **e** `n5` executam, cada um com uma cópia dos itens.
- `n6` tem **dois pais**: executa **uma vez** com a concatenação das saídas de `n4` e `n5` (nessa ordem — menor `id` primeiro). Uma venda que satisfaça os dois filtros aparece **duas vezes**; deduplique com `code` se isso importar.
- `continueIfEmpty: true` nos filtros evita que um ramo vazio encerre o seu lado; com `false`, o ramo vazio simplesmente não entrega nada a `n6`, que ainda executa com o que veio do outro pai.

---

### 5.7 WhatsApp — menu de atendimento com Z-API (`trigger_zapi` + `if` + `zapi_send`)

Recebe a mensagem, responde na hora se a pessoa perguntou o horário e, caso contrário, envia uma **lista de opções**. A escolha volta como nova mensagem (`tipo: "lista"`, `botao_id` = `id` da opção) e pode ser tratada por um segundo flow ou por um `switch` sobre `botao_id`.

```json
{
  "waipe_flow_version": "2",
  "name": "Atendimento WhatsApp",
  "description": "Responde perguntas de horário e oferece um menu de opções pela Z-API.",
  "triggerType": "webhook",
  "webhookMethod": "POST",
  "nodes": [
    { "id": "n1", "type": "trigger_zapi", "name": "Recebe WhatsApp",
      "position": { "x": 100, "y": 250 },
      "parameters": { "ignoreFromMe": true, "ignoreGroups": true, "ignoreNotifications": true,
                      "acceptedTypes": ["texto"] } },
    { "id": "n2", "type": "if", "name": "Perguntou o horário?",
      "position": { "x": 400, "y": 250 },
      "parameters": {
        "combine": "and",
        "conditions": [
          { "left": "{{ $node[\"Recebe WhatsApp\"].json.texto }}", "leftMode": "expression",
            "operator": "string:contains", "right": "horário", "rightMode": "fixed" }
        ],
        "caseInsensitive": true, "typeValidation": "loose", "nullAsEmpty": true
      } },
    { "id": "n3", "type": "zapi_send", "name": "Responder horário",
      "position": { "x": 720, "y": 130 },
      "parameters": {
        "credentialId": "",
        "operation": "send_text",
        "phone": "{{ $node[\"Recebe WhatsApp\"].json.telefone }}", "phoneMode": "expression",
        "message": "Olá {{ $node[\"Recebe WhatsApp\"].json.nome_contato }}! Atendemos de segunda a sexta, das 8h às 18h.", "messageMode": "expression",
        "replyToMessageId": "{{ $node[\"Recebe WhatsApp\"].json.mensagem_id }}", "replyToMessageIdMode": "expression",
        "continueOnError": false
      } },
    { "id": "n4", "type": "zapi_send", "name": "Enviar menu",
      "position": { "x": 720, "y": 370 },
      "parameters": {
        "credentialId": "",
        "operation": "send_option_list",
        "phone": "{{ $node[\"Recebe WhatsApp\"].json.telefone }}", "phoneMode": "expression",
        "message": "Olá! Como podemos ajudar?", "messageMode": "fixed",
        "optionListTitle": "Atendimento", "optionListTitleMode": "fixed",
        "optionListButtonLabel": "Ver opções", "optionListButtonLabelMode": "fixed",
        "options": [
          { "id": "horario", "title": "Horário de atendimento", "description": "Dias e horários em que atendemos" },
          { "id": "pedido",  "title": "Status do pedido",       "description": "Consultar um pedido em andamento" },
          { "id": "humano",  "title": "Falar com atendente",    "description": "Encaminhar para uma pessoa" }
        ],
        "continueOnError": false
      } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3", "sourceHandle": "true" },
    { "id": "e3", "source": "n2", "target": "n4", "sourceHandle": "false" }
  ]
}
```

Pontos que fazem este flow funcionar:

- `triggerType` é `"webhook"` (não `"zapi"`); `acceptedTypes: ["texto"]` faz mídias, áudios e respostas de lista serem descartadas **antes** de criar execução.
- O `if` decide sobre o único item do gatilho; os dois `zapi_send` referenciam o gatilho pelo **nome** (`$node["Recebe WhatsApp"]`), não por `$json`.
- `send_option_list` não funciona em grupos — por isso `ignoreGroups: true`.
- Após importar, o usuário seleciona a credencial `zapi` nos dois nodes de envio e cola a URL do flow no webhook "Ao receber" da Z-API (HTTPS).

---

## Parte 6 — Checklist para a IA geradora (verificar antes de entregar o JSON)

1. ☐ `waipe_flow_version: "2"` presente na raiz.
2. ☐ `nodes` e `edges` são arrays; `name` do flow tem ≤ 200 caracteres.
3. ☐ **Exatamente 1** node de gatilho (`trigger_manual`, `trigger_schedule`, `trigger_webhook` ou `trigger_zapi`), e `triggerType` da raiz coerente com ele (`trigger_zapi` → `"webhook"`).
4. ☐ Todos os `type` pertencem à lista dos **21** tipos válidos — nenhum tipo inventado.
5. ☐ Todos os `id` de nodes são únicos e não vazios; todos os `name` de nodes são únicos (necessário para `$node["..."]`).
6. ☐ Toda edge referencia `source`/`target` existentes; nenhum ciclo no grafo.
7. ☐ Edges saindo de `if` têm `sourceHandle` `"true"`/`"false"`; edges saindo de `switch` têm `sourceHandle` idêntico a um `outputLabel` (ou ao `fallbackLabel`); edges saindo de `loop` têm `"loop"`/`"done"`; **nenhuma outra edge** tem `sourceHandle`; nenhuma edge tem `targetHandle`.
8. ☐ No máximo **uma** edge por handle de saída (`if`/`switch`/`loop`). Nodes comuns **podem** ter várias edges de saída — todos os ramos executam (§2.6); use isso de propósito, não por acidente.
9. ☐ Campos com `{{ }}` têm o `*Mode` correspondente em `"expression"`; expressões usam apenas `$json`, `$node["..."]`, `$now`, `$today`, `$itemIndex`, `$items()`.
10. ☐ Nenhum token proibido (§3.5) em strings com `{{` (ex.: `window`, `fetch`, `require`, `setTimeout`, `parent`…).
11. ☐ Campos de valor tipado (`loop.arrayExpression`, `split_out.arrayExpression`, `switch.fieldExpression`) contêm **exatamente um** bloco `{{ }}`; nomes de campo do `merge_out` e colunas do `google_sheets` **sem** `{{ }}` (são literais).
12. ☐ `trigger_schedule`: `weekdays`/`monthDays` como array de números (`[1,2,3]`, recomendado) ou string CSV (`"1,2,3"`) — os dois formatos são aceitos; ranges dentro dos limites do §4.2 (a importação valida); `timezone` IANA válida; raiz com `scheduleConfig` equivalente (chave `type`).
13. ☐ Nenhum `credentialId`, token real ou segredo no JSON — placeholders claros (`"SUBSTITUA_PELO_TOKEN"`) e aviso ao usuário para configurar credenciais após importar.
14. ☐ `position` com números razoáveis (ex.: x iniciando em 100, passo ~300; ramos com y distintos) — o layout importa para a leitura no canvas.
15. ☐ Operadores corretos: em `filter`/`if` use o formato **tipado** `tipo:operacao` (`string:equals`, `number:gt`, `boolean:true`, `any:empty`… — §4.6); em `switch` os operadores são os do próprio node e "diferente de" é `not_equal` (sem "s").
16. ☐ JSON sintaticamente válido (sem comentários, sem vírgulas sobrando).
17. ☐ `zapi_send`: `operation` definida; `credentialId: ""`; em `send_button_actions` **nunca** misturar `REPLY` com `CALL`/`URL` (a importação rejeita); `delayMessage`/`delayTyping` inteiros entre 0 e 15; `send_option_list` só para conversas individuais.
18. ☐ `loop`: coleções acima de 50.000 elementos ou de 50.000 lotes **falham** (`loop_limit_exceeded`) — reduza a montante ou aumente `batchSize` (§4.9).

---

## Parte 7 — Erros comuns e como evitá-los

| Erro | Consequência | Correção |
|---|---|---|
| Inventar node (`"delay"`, `"email"`, `"whatsapp"`, `"merge"`…) | Importação rejeitada | Use apenas os 21 tipos; espera/repetição = `loop`; **agregar os itens de um ramo** = `merge_out`; junção de dois ramos = apontar edges para o mesmo node; e-mail = `gmail_send`; WhatsApp = `zapi_send`. |
| Dois gatilhos no mesmo flow | Importação rejeitada | Um flow, um gatilho. Crie flows separados. |
| Edge de retorno para "repetir" (ciclo) | Importação rejeitada (DAG) | Use `loop` para lotes ou `code` para iteração dentro de um node. |
| `sourceHandle` errado no IF (`"sim"`, `"yes"`, ausente) | Ramo nunca executa / edge inválida | Exatamente `"true"` e `"false"`, minúsculas. |
| Ler o corpo do webhook como `{{ $json.body.campo }}` | Campo vazio: o item inicial **é** o corpo, não um envelope | Use `{{ $json.campo }}` (§4.3). Cabeçalhos e query string não chegam ao flow. |
| Configurar `by_node`/allowlist só nos `parameters` do node webhook | Até o primeiro save no editor, a rota usa os defaults (`immediate`, sem filtro) | Inclua `webhookConfig` na raiz do JSON (§2.1) ou avise o usuário para abrir e salvar o flow. |
| `outputLabel` ≠ `sourceHandle` no Switch | Itens caem na rota default | Copie o `outputLabel` literal para o `sourceHandle` da edge. |
| Duas edges saindo de um node comum | **Os dois ramos executam** (fan-out) — se a intenção era uma rota só, o flow faz trabalho a mais (ex.: dois `http_request` disparados) | Confirme se o fan-out é intencional; para escolher **uma** rota conforme o dado, use `if` ou `switch`. |
| Dois ramos convergindo num node esperando "só um deles" | O node executa uma vez com a **concatenação** dos itens dos dois pais — itens podem duplicar | Aceite a concatenação (é o merge), ou deduplique com `code`. Em `if`, só um dos ramos entrega, então convergir os dois é seguro. |
| `interval`/`hour`/`minute` fora do range, cron malformado ou `timezone` inválida no `trigger_schedule` | Importação rejeitada | Respeite os ranges do §4.2 (interval 1–59 min / 1–23 h, hour 0–23, minute 0–59), cron com 5–6 campos e timezone IANA. |
| Ligar a continuação do flow na saída `loop` do Loop | Corpo e continuação se misturam / validação falha | O corpo (executado por lote) vai na saída `loop`; a continuação vai na saída `done`. O corpo é fechado: nenhuma aresta externa pode entrar nele. |
| Esquecer que `http_request`/`waipe_ai` executam **por item** | Custo/tempo inesperado (N chamadas) | Reduza itens antes (`filter`) ou junte-os num só com `merge_out` (ou `code`). |
| Usar `fetch`/`require`/`setTimeout` em expressão ou no `code` | Rejeição na importação (expressões) ou erro em runtime (code) | Sandbox não tem I/O; chamadas externas só via node `http_request`. |
| Condição do IF pensada "por item" | Todos os itens vão para o mesmo ramo (decisão usa o item 0) | Para separar item a item, use `filter` (um em cada ramo) em vez de `if`. |
| Colocar segredos reais no JSON | Vazamento; export redige como `CREDENTIAL_REDACTED`, mas o import não | Placeholders + configurar credenciais na UI após importar. |
| URL interna/privada no `http_request` (ex.: `http://192.168…`, `http://localhost`) | Bloqueado pela proteção SSRF em runtime | Apenas URLs públicas. |
| `$node["nome"]` esperando a lista completa de itens | `$node["nome"].json` devolve **um** item — o **pareado por índice** com o item atual (clamp para o último quando os tamanhos divergem; com 1 item de saída, sempre ele) | Para percorrer a lista completa do node anterior imediato, use `$items()`; para agregar N itens num só, use `merge_out`. |
| Operador legado em condição nova (`"equals"`, `"greater_than"`) | Funciona, mas cai no motor textual antigo: sem comparação por tipo real e com `caseInsensitive` **desligado** por padrão | Use o formato tipado (`string:equals`, `number:gt`…) — §4.6. |
| Contar com o default de `caseInsensitive` | O default difere por motor (tipado ligado, legado desligado) | Declare `caseInsensitive` explicitamente em `filter`/`if`. |
| Omitir `right` numa condição com operador unário (`any:empty`, `boolean:true`…) | Importação rejeitada: `Parâmetros inválidos no nó … (filter)` / `conditions.0.right: Required` | Inclua sempre a chave: `"right": ""`. |
| Esperar que o `gmail_send` preserve os campos do item | O item de saída é **substituído** por `{ sent, status, messageId, threadId }` | Se precisar dos dados originais depois do envio, referencie o node anterior: `$node["Nome"].json.campo`. |
| Contar com o `loop` para "processar o que der" numa coleção enorme | Acima de 50.000 elementos ou 50.000 lotes o node **falha** com `loop_limit_exceeded` — nada é processado | Reduza a coleção antes (`filter`, paginação) ou aumente `batchSize` (§4.9). Só `split_out` e `merge_out` ainda **truncam** (com marcador). |
| `triggerType: "zapi"` na raiz | Valor descartado na importação: o flow entra como `manual`, **sem URL de webhook** | Use `"webhook"` para flows com `trigger_zapi` (§4.20). |
| `zapi_send` com botões `REPLY` misturados a `CALL`/`URL` | Importação rejeitada (`zapi_button_mix_not_allowed`) | Envie a resposta rápida num node separado; `CALL` + `URL` podem ir juntos. |
| Deixar vazio um campo que a Z-API exige (ex.: `image`, `title`, `linkDescription` no `send_link`) | Campo vazio é **omitido** do pedido e a Z-API recusa (`zapi_null_not_allowed` / `zapi_missing_field`) | Preencha todos os campos obrigatórios da operação (§4.21). |

---

## Apêndice — Onde isto vive no código (para mantenedores)

| Assunto | Fonte de verdade |
|---|---|
| Tipos `Flow`/`FlowNode`/`FlowEdge` e `NodeType` (21 tipos) | `packages/shared-types/src/index.ts` |
| Parser/validação de importação | `packages/flow-import/src/index.ts` (+ `importMigration.ts`, versões suportadas) |
| Defaults e schemas Zod dos parâmetros | `packages/node-definitions/src/nodes/*.ts` e `parameter-schemas.ts` |
| Operadores de condição (tipados + aliases legados) | `packages/node-definitions/src/nodes/condition-operators.ts` |
| Blocklist de expressões | `apps/api/src/lib/validateFlowNodeParameters.ts` |
| Execução dos nodes (Go) | `apps/worker/internal/exec/*.go` (`flowexec.go`, `logicnodes.go`, `conditions_typed.go`, `http_exec.go`, `waipe_ai.go`, `waipe_data.go`, `code.go`, `splitout.go`, `mergeout.go`, `gmail_send.go`, `google_sheets.go` + `google_sheets_rows.go` + `google_sheets_mapped.go`, `google_drive.go`, `google_docs.go`, `zapi_send.go`) |
| Tetos do Loop (`LOOP_MAX_ELEMENTS_PER_ITEM`, `LOOP_MAX_TOTAL_OUTPUT`, `LOOP_MAX_BATCHES`) | `apps/worker/internal/exec/looplimits.go` |
| Gatilho Z-API: filtros e normalização do payload | `apps/api/src/lib/zapiWebhookPayload.ts` (chamado por `apps/api/src/routes/webhook.ts`) |
| Travessia do grafo: fan-out, merge, `skipped` | `apps/worker/internal/exec/scheduler.go` (`runScheduler`, `fanoutEnabled`) + cabeçalho de `dag.go` |
| Sandbox de expressões (Go) | `apps/worker/internal/sandbox/sandbox.go` (timeout 500 ms, `nodeItemJSONFor`, `valueToString`) e `script.go` (node `code`) |
| Lista de modelos do `waipe_ai` | `apps/api/src/lib/waipeIaModels.ts` (gateway + fallback) |
| Agendador | `apps/api/src/lib/scheduleNextRun.ts` + `apps/worker/internal/schedule/` |
| Handles no canvas | `apps/web/src/components/canvas/BaseNode.tsx` + `apps/web/src/lib/branchHandles.ts` |
| Rotas de import/export | `POST /flows/import` (`?preview=true`), `GET /flows/:id/export` — `apps/api/src/routes/flows.ts` |

Ao alterar qualquer um desses pontos, **atualize este guia** e a data de sincronização no topo. Documentos relacionados: [`estado-atual.md`](./estado-atual.md) (matriz técnica por node), [`spec-v4/`](./spec-v4/README.md) (recorte de produto), [`code/README.md`](./code/README.md) (contrato técnico do node `code`), [`trigger_zapi/README.md`](./trigger_zapi/README.md) e [`zapi_send/README.md`](./zapi_send/README.md) (contratos dos nodes Z-API), [`google_sheets/`](./google_sheets/README.md) · [`google_drive/`](./google_drive/README.md) · [`google_docs/`](./google_docs/README.md) · [`gmail_send/`](./gmail_send/README.md) (contratos dos nodes Google), [`fan-out-paralelo.md`](../03-backend-worker/fan-out-paralelo.md) (travessia do grafo) e [`expressoes-serializacao-de-valores.md`](../03-backend-worker/expressoes-serializacao-de-valores.md) (como um valor de expressão chega ao node seguinte).
