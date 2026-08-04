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

**Nunca cadastre uma origem `http://` fora de loopback nesta variável** — e em
particular não a use para "resolver" problema de ambiente local mexendo nas
variáveis de Production na Vercel. Não é só recomendação: o código **recusa**.
Cada entrada passa por validação (`origemExtraValida`, em `api/_lib/http.js`) e
só é aceita se for `https://`, ou `http://` com host loopback. Entrada recusada é
descartada e registra `console.error` no log da função — se uma origem que você
cadastrou não estiver funcionando, o log diz por quê.

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
linha sai zerado, o agregado `mrrEquipe` sai `0` e `metaEquipe` sai `null` — nem os
limiares da equipe, que também são valor financeiro.

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

O 401 do `GET` — **e só o dele** — acrescenta `expirada: true` quando havia cookie
e ele não validou. É o que permite ao dashboard mostrar "Sua sessão expirou" também
depois de um F5, em vez de uma tela de login sem explicação. Nos proxies o 401
permanece genérico, byte a byte igual com e sem cookie: diferenciar lá criaria
oráculo de "existe sessão aqui". No `/api/login` não vaza nada — quem mandou cookie
inválido já sabe que tinha um.

**Configuração das senhas, recusada quando inválida:** o valor de cada `AUTH_*` é
validado em estrutura (6 campos, prefixo `scrypt`), em parâmetros (só os que o
`gerar-hash.js` emite — ver `PARAMS_ACEITOS` em `api/_lib/auth.js`) e em tamanho
**decodificado** de salt e hash, com round-trip de base64 para pegar truncamento.
Valor inválido gera `console.error` **nomeando a variável** e o motivo — nunca a
senha nem o hash — enquanto a resposta ao cliente segue 401 genérico. Duas `AUTH_*`
com hash **idêntico** fazem `/api/login` responder 500: salt é aleatório, então
valor repetido significa o mesmo conteúdo colado duas vezes, e como o primeiro
match ganha isso daria acesso ao perfil errado.

Cookie: `httpOnly`, `Secure`, `SameSite=Strict`, validade de 12h, assinado com
HMAC-SHA256. O payload carrega apenas `{ nivel, csm, nome, iat }`.

Rate limiting: 5 tentativas por IP em 15 minutos. **É um contador em memória, por
processo** — e "por processo" é mais fraco do que "por instância": no `vercel dev`
cada invocação nasce num processo novo, e o contador nunca acumula (ver teste 9).
Corta força bruta de origem única, mas não é um limite
global forte. Se algum dia precisar de garantia real, isso exige um armazenamento
compartilhado (Vercel KV ou Upstash), o que traria dependência nova.

Sempre responde `Cache-Control: no-store`.

### `/api/clickup`

| Método | `action`    | O que faz |
| ------ | ----------- | --------- |
| `GET`  | `carteira`  | lista `901327787926`, paginada inteira no servidor, `include_closed=true`, `include_custom_fields=true` |
| `GET`  | `metas`     | lista `901327940637`, `include_closed=false`, mais os agregados `mrrEquipe` e `metaEquipe` (`0` e `null` para `consulta`) |
| `GET`  | `cliente`   | `?taskId=...` → **uma** linha lida direto do ClickUp, sem cache, `no-store`. 1 chamada |
| `POST` | `set-field` | `{ taskId, fieldId, value }` |

`action=cliente` passa pelo mesmo portão das outras leituras — sessão obrigatória,
escopo por CSM (`fora_da_carteira`), `mrr` zerado para `consulta`, `taskId` validado,
e só a lista Carteira. A única diferença é não usar cache e responder `no-store`,
porque a razão de existir é entregar a verdade: é dessa linha que sai a pré-marcação
dos alertas no modal de acompanhamento, e essa pré-marcação alimenta uma escrita que
envia o array **completo**.

Não existe path livre. Os dois IDs de lista são constantes no servidor.

#### Período das metas: vem do status, não do calendário

A lista Metas acumula uma linha por CSM **por mês**, mais a de equipe. O recorte é
dado por **`🗓️ Ano Base`** (`5c06c44f-…`, `short_text`) + **`📅 Mês Referência`**
(`6f335424-…`, dropdown sem ano), e o **período corrente é o das linhas com status
`mês atual`**.

Por que o status e não a data: o fechamento acontece depois do fim do mês, então em
03/08 o mês corrente de trabalho ainda é julho. Filtrar pelo calendário mostraria
agosto vazio no dia 1º. Quem decide a virada é a pessoa, movendo as linhas.

Os quatro status da lista e o que o ClickUp diz deles:

| Status | `type` | Chega com `include_closed=false`? |
| --- | --- | --- |
| `mês atual` | `open` | sim |
| `meses fechados` | `custom` | sim |
| `concluído` | `done` | **incerto** |
| `finalizado` | `closed` | não |

> **O `concluído` é uma armadilha.** O que `include_closed=false` faz com statuses de
> tipo `done` (em oposição a `closed`) não é documentado de forma confiável. Enquanto
> esse status existir na lista, há um caminho para uma linha ficar invisível no
> painel. Recomendado: apagá-lo, ou passar a usá-lo de propósito.

A blindagem contra isso não depende da resposta: o seletor de período é montado a
partir das linhas que chegaram, então um período que desapareça **falta visivelmente**
no dropdown, e a ausência de `mês atual` vira erro na tela.

**Os quatro casos que falham visível** — `console.error` no log da função **e** faixa
vermelha na tela, porque estes números alimentam comissão e bônus:

| Caso | O que o painel faz |
| --- | --- |
| Nenhuma linha `mês atual` | `periodoAtual: null` + aviso dizendo o que fazer |
| Dois períodos em `mês atual` | nenhum vira corrente; o aviso nomeia os dois |
| Um CSM com 2 linhas no período | o card dele explica por que o número não aparece; o card de gestão mostra `⚠️ duplicada` |
| 2 linhas `⭐ Equipe` no período | cai na soma, marcado como não declarado |

Uma linha sem *Ano Base* ou sem *Mês Referência* fica fora de todos os períodos, é
nomeada no aviso, e **não entra na soma de mês nenhum**.

**O recorte rege tudo que consome metas** — régua individual, bloco de equipe, cards
de gestão por gerente, *MRR Incrementado*, *Perdido Downsell*, total e limiares da
equipe. Nenhum consumidor lê `metasData` direto: todos passam por
`metasDoPeriodo()`, `metaDoCsm()` ou `periodoAtivo()`, e a suíte falha se alguém
voltar a ler o array cru. Trocar de mês é **100% client-side**, sem leitura nova.

#### A meta da equipe é declarada, não somada

A lista Metas tem uma linha por CSM **e** uma linha de equipe, identificada pela
opção `⭐ Equipe` do campo *Gerente de Contas* (`EQUIPE_OPCAO`,
`a9832e95-…`). Ela **declara** o total do time.

`mrrEquipe` lê essa linha. Antes somava **todas** as linhas, e com a linha de equipe
presente o total entrava duas vezes — o painel chegou a anunciar ultrameta de equipe
(+R$ 200) para os quatro CSMs quando o correto era supermeta (+R$ 100).

A identificação é por **ID da opção**, nunca pelo rótulo. O `value` desse campo
chega como `orderindex`, então comparar por texto dependeria de resolver
orderindex → nome, e o nome carrega o emoji, que se perde num copy-paste ou numa
renomeação. E `orderindex` não serve de chave: é posição na lista, e arrastar a
opção no ClickUp mudaria o número em silêncio.

A linha de equipe **não viaja dentro de `tasks`**. Isso impede estruturalmente que
ela vire um quinto card de gerente, entre em contagem por gerente ou apareça em aba
de CSM — não depende da constante `CSMS` do front. Ela também nunca casa com um
perfil de CSM: `pertenceAoCsm` compara nome completo normalizado por igualdade
exata, e `⭐ Equipe` não é nome de ninguém.

**Fallback por período**, para não quebrar quando a linha não existir:

| Linhas `⭐ Equipe` abertas | `mrrEquipe` | `metaEquipe.declarado` |
| --- | --- | --- |
| 1 | valor declarado pela linha | `true`, com os limiares dela |
| 0 | soma das individuais, + `console.warn` | `false`, limiares `null` |
| 2 ou mais | soma das individuais, + `console.error` e aviso na tela | `false`, limiares `null` |

Duas linhas caem no fallback de propósito: "declarado" fica ambíguo, e um número
definido é melhor que um escolhido por ordem de iteração. Com os limiares `null` o
front usa `META_EQ`, a reserva dele — e limiar declarado como `0` também cai nela,
porque meia régua é pior que a régua conhecida.

Tudo isso é **por período**: cada entrada de `periodos[]` traz o seu próprio
`equipe`, então trocar de mês troca total, limiares e faixa de bônus juntos.

`equipe.soma` e `equipe.diferenca` vêm **somente para `gestao`**: é a reconciliação
entre o declarado e a soma dos gerentes, e um CSM não precisa vê-la. A diferença
esperada é MRR órfão (ex-integrante da equipe); o objetivo é perceber erro de
digitação na hora, não no fechamento.

#### Paginação e custo da lista Metas

`getMetas` **pagina**. Antes era uma chamada sem `page`: acima de 100 linhas as mais
antigas desapareciam em silêncio, e com 5 linhas por mês o teto cairia em 2027.

`buscarPaginado` tem parâmetro de **lote** porque as duas listas têm escalas opostas:

| Lista | Volume | Lote | Custo |
| --- | --- | --- | --- |
| Carteira | 2797 tasks | 4 páginas concorrentes | ~28 chamadas |
| Metas | 5 linhas/mês | 1 | **1 chamada** até 100 linhas, 2 acima |

Com lote 4 a lista Metas gastaria 4 chamadas para buscar 5 registros — trocaria uma
correção de paginação por uma regressão de cota.

`set-field` só aceita estes cinco campos, e só estes valores:

| Campo | ID | Valores aceitos |
| ----- | -- | --------------- |
| Em acompanhamento | `94b85690-…` | `true` / `false` |
| Etapa             | `d15028f2-…` | 1 ID de opção |
| Tipo de solicitação | `a4acad54-…` | 4 IDs de opção |
| Alertas           | `6ce5db54-…` | até 10 dos 5 IDs de label |
| Evento: Camp 2026 | `54ee7ad4-…` | 4 IDs de opção |

Qualquer outro `fieldId` → 403. Qualquer valor fora dessas listas → 403. A task
também é conferida contra as duas listas permitidas antes de qualquer escrita.

**Não existe regra genérica de "qualquer dropdown".** A allowlist é uma lista fechada,
campo a campo e opção a opção, e a suíte falha se ela deixar de ser enumerável.

> **Se você criar uma nova opção de alerta, de tipo ou do Camp no ClickUp**, adicione
> o ID dela em `CAMPOS_ESCRITA`, em `api/_lib/clickup.js`. Sem isso a gravação da
> opção nova volta 403 — é a allowlist funcionando, não um bug.

#### Limpar um campo não é possível pelo proxy

O `set-field` só faz `POST /task/{id}/field/{id}` com `{value}`. Apagar o valor de um
campo personalizado no ClickUp exige `DELETE` no mesmo endpoint — **verbo que o proxy
não expõe**. Então o *Evento: Camp 2026* pode ser trocado entre as quatro opções, mas
não esvaziado: `value: null` volta **403 `valor_nao_permitido`**, e o seletor no modal
reverte com a mensagem "não dá p/ limpar".

Para desmarcar de vez, é pelo ClickUp. Habilitar isso aqui é uma decisão em aberto —
ver `docs/estado-e-proximos-passos.md`.

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

Se o *Gerente* do cliente não corresponder a nenhum CSM do mapa, o registro **é
criado** com o `createdBy` como responsável, e a resposta vem com
`code: "responsavel_nao_identificado"` mais um `aviso` legível. O dashboard mostra
esse aviso e deixa o modal aberto, em vez de fechar sozinho. No log da função fica
um `console.error` com o valor de *Gerente* que não casou. O fluxo não é bloqueado
de propósito — mas a atribuição errada não passa mais em silêncio.

---

## Regras de cálculo e exibição no dashboard

Estas vivem no `dashboard_carteiras.html`, mas mudam o que os números **significam**.

### Migração de CNPJ fora do MRR perdido

Contratar em outro CNPJ é troca de titularidade: administrativamente gera um
cancelamento e um contrato novo, mas não é venda nova nem perda real. O card
**❌ Perdido Churn** do resumo da gestão exclui esse valor, comparando
`motivoPerdaId` com `MOTIVO_MIGRACAO_CNPJ` (`00c64f34-…`) — por **ID da opção**,
porque renomear a opção no ClickUp quebraria a regra em silêncio.

O escopo é estreito de propósito. Continuam contando esses registros:

- a **lista de cancelamentos** (motivo, valor, plano, gerente);
- o **total do cabeçalho** dela, "MRR perdido: R$ X", que precisa fechar com a soma
  da coluna MRR visível logo abaixo;
- o **top 3 de motivos**, que é contagem, não valor.

O card tem um ⓘ explicando a exclusão. Sem isso o número fica inexplicável para
quem confere contra a lista.

`MOTIVO_MIGRACAO_CNPJ` existe nos **dois** lados — front e `api/_lib/clickup.js` — e
a suíte prova que são o mesmo ID. É o único desses acoplamentos com teste.

### Valor exato onde o número é ALVO

`fmtc()` abrevia acima de mil ("R$ 1,7k"). Em valor de **alvo** isso engana: com a
meta real em R$ 1.632,00 e a tela dizendo R$ 1,7k, dá para achar que bateu em
R$ 1.700. Usam `fmt()` (exato): o card **MRR Incrementado**, o valor das quatro
faixas do painel individual, os limiares da equipe e todos os valores de premiação.

Seguem abreviados, de propósito: MRR Total, Ticket Médio, Em Risco, Perdido
Downsell, Perdido Churn, os cards de gestão — agregados informativos em cards
estreitos — e os **rótulos da régua**, onde se lê posição, não valor. Os rótulos da
régua são `position:absolute` com `translateX(-50%)`: valor mais longo sobreporia o
marcador vizinho quando dois limiares ficam próximos, e sobreposição é pior que
abreviação.

Não altere `fmtc()` para "arrumar" isso — vários lugares dependem dela como está.

### Filtro de cidade

*Cidade* (`beaef1da-…`) é **texto livre**, então "Londrina", "londrina " e
"LONDRINA" chegam como três valores. O filtro agrupa pela forma normalizada
(`normTxt`: NFD sem marcas combinantes, espaço colapsado, minúsculas — a mesma
semântica de `normalizarNome` em `api/_lib/auth.js`) e exibe a **grafia mais
frequente**, com a contagem ao lado.

Empate de frequência prefere capitalização de nome próprio — nem tudo minúsculo nem
tudo maiúsculo — e só depois ordem alfabética. Frequência continua mandando:
capitalização apenas desempata.

O `value` da opção é a chave normalizada, não o rótulo, então a seleção sobrevive a
uma recarga em que a grafia vencedora mude. Registros sem cidade viram **Sem
cidade**, com uma sentinela que nenhuma cidade real produz. As opções saem de
`allData`, não da aba atual, para a lista não mudar de tamanho ao trocar de aba.

### Meta da equipe no dashboard

Um bloco consolidado — régua, os quatro limiares com o bônus de cada faixa, e o
bônus da faixa atingida — na Visão Geral **e** nas abas de CSM. Sem simulador de
comissão: comissão é individual e já vive no painel do gerente.

Renderiza sempre que houver valor, não só quando algum bônus foi conquistado:
metade do valor dele é responder "qual era a meta da equipe mesmo".

`reguaHTML()` é **uma** função usada pelo painel individual e pelo bloco de equipe;
a suíte falha se aparecer uma segunda cópia. Os limiares saem da linha `⭐ Equipe`;
`META_EQ` é só reserva, e limiar declarado como `0` ou vazio também cai nela.

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

### Frescor depois de escrever

O `private, max-age=300` faz o navegador guardar cópia própria da carteira. Sem
tratamento, depois de uma escrita a pessoa recarregava e via o valor **antigo** — o
que parece perda de dado, e é pior que a tela simplesmente não atualizar.

Três mecanismos, nenhum deles afrouxando o cache no uso normal:

1. **Marca em `sessionStorage`** (`cs_escrita_recente`): toda escrita bem-sucedida a
   grava, de forma centralizada em `api()`. Precisa ser `sessionStorage` e não
   variável — o caso a corrigir é justamente o F5, que apaga memória.
2. **`cache: 'reload'`** na leitura seguinte a uma escrita, e **sempre** no botão
   ↻ Recarregar. Não use `no-store` nem cache-buster aqui: os dois ignoram a cache na
   ida mas **não substituem** a entrada guardada, então a leitura seguinte volta a
   servir o corpo velho. `reload` busca da rede e regrava.
   A marca é apagada só **depois** do sucesso, para que falha de rede não deixe a
   pessoa presa no valor antigo, e para que não seja toda leitura da janela a ir à rede.
3. **`action=cliente`** ao abrir o modal de acompanhamento, para a pré-marcação dos
   alertas partir do ClickUp e não da tela.

A defasagem que **permanece**: instâncias diferentes têm cache próprio por até 5
minutos, então quem não escreveu pode ver o estado anterior por esse tempo. Não há
risco de perda em *Em acompanhamento*, *Etapa* e *Tipo*, que são escritas de valor
absoluto. O botão ↻ Recarregar é a saída explícita, e o "Atualizado HH:MM" torna a
defasagem visível.

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

A origem `http://<host>` só é aceita quando o host é **loopback** (`localhost`,
`127.0.0.1` ou `[::1]`, com porta opcional). É o caso do `vercel dev`, e não é o
caso de nenhum deploy, onde o host é o domínio da Vercel ou o customizado.

A regra é o host, e **não** variável de ambiente, por um motivo medido: no runtime
das funções sob `vercel dev`, `VERCEL_ENV` e `NODE_ENV` **não existem** — a única
marca de ambiente definida é `VERCEL_URL`. Qualquer regra que dependa delas
classifica o desenvolvimento local como produção e derruba o CORS local. Host
sempre existe, em qualquer runtime, e num deploy publicado nunca é loopback.

A decisão exige que `host` **e** `x-forwarded-host` (quando presente) sejam
loopback: `x-forwarded-host` é, em princípio, escrito pelo cliente, e liberação de
esquema não se apoia em cabeçalho assim. Há ainda uma segunda tranca redundante:
com `VERCEL_ENV` em `production` ou `preview`, `http://` é recusado de qualquer
forma.

### Testes automatizados dos caminhos de falha

```bash
node scripts/teste-http.mjs
```

Sem dependências, só Node. Garante a regra de que **nada derruba a função**: corpo
malformado, `Content-Type` ausente ou diferente de `application/json`, corpo vazio,
corpo acima do limite, JSON válido mas não-objeto e `SESSION_SECRET` ausente ou
curto — todos viram 400 ou 500 tratado, nos três endpoints. Inclui uma rajada de 60
corpos malformados.

O harness monta `req.body` como **getter que lança**, reproduzindo o runtime da
Vercel. Isso é essencial: entregar `body` já parseado como propriedade comum não
exercita a camada onde o parse acontece, e foi o ponto cego que deixou passar um
`ApiError: Invalid JSON` capaz de derrubar a função inteira.

A suíte também cobre **regras de cálculo**, não só caminhos de falha: `motivoPerdaId`
nas duas formas de `value` que o ClickUp usa, a meta de equipe declarada com os dois
fallbacks e o isolamento dos três perfis, e o agrupamento do filtro de cidade.

Três desses testes leem o **próprio `dashboard_carteiras.html`**, extraem funções
dele (`normTxt`, `opcoesCidade`, `limiaresEquipe`) e as carregam como módulo. É como
uma página estática sem bundler fica testável. Consequência: **renomear essas funções
faz o teste falhar**, em vez de passar a testar outra coisa em silêncio. O mesmo
mecanismo prova que `MOTIVO_MIGRACAO_CNPJ` é o mesmo ID nos dois lados e que
`reguaHTML` é uma declaração com dois usos.

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

**9. Rate limiting do login — NÃO EXECUTÁVEL LOCALMENTE**

Em produção: erre a senha 6 vezes seguidas; a sexta deve voltar `429` com
`code: "muitas_tentativas"`.

**Não tente localmente — não funciona, e não é bug.** O `vercel dev` cria um
**processo novo por invocação**. Medido com um endpoint de contador temporário:
cinco chamadas seguidas devolveram `chamadas: 1` nas cinco, com PID diferente em
cada uma (21288, 704, 12928, 16488, 2356). O `Map` de tentativas
(`api/login.js:31`) nasce vazio a cada requisição, então nenhuma quantidade de
tentativas dispara o 429 — testado, seis tentativas seguidas retornaram
`senha_incorreta`, inclusive com `X-Forwarded-For` fixo para descartar variação de
IP.

A lógica em si está correta, e é verificável fora do runtime: em processo único dá
cinco 401 e depois 429 com `Retry-After`, senha certa durante o bloqueio continua
429, e IP diferente entra normalmente.

**Como ler o resultado em produção:**

- 429 aparecendo prova que o controle funciona **naquele momento, naquela
  instância**.
- 429 **não** aparecendo não prova nada — pode ser instância nova, pode ser
  reciclagem, pode ser escalonamento distribuindo as tentativas.

**Portanto:** este controle é *best-effort*. Ele corta força bruta ingênua de
origem única contra uma instância quente, e evita que um atacante force trabalho
de `scrypt` ilimitado no servidor. Não é limite global, não é durável e não é por
perfil. **A defesa real é senha forte + `scrypt`** — o rate limiting é conveniência
sobre isso, não a proteção principal. Garantia real exigiria estado compartilhado
(Vercel KV ou Upstash), com a dependência nova que vem junto.

**10. Cabeçalhos de cache**

```bash
curl -sI "http://localhost:3000/api/login" | grep -i cache-control
# no-store
```

Depois de publicar, repita em produção e confira que a leitura da carteira volta
`private, max-age=300...` — e **não** `s-maxage`.

**11. Expiração da sessão**

Para não esperar 12h: troque o `SESSION_SECRET` e reinicie o `vercel dev` (o
`.env.local` só é lido no boot). Nada a reverter — o segredo novo é tão válido
quanto o antigo.

Verifique os **dois** caminhos, que são diferentes:

- Com a página aberta, sem recarregar: `try { await api('/api/clickup?action=metas'); } catch(e) {}`
  no console → overlay com "Sua sessão expirou. Entre novamente."
- Depois **F5** → a mesma mensagem. Isso depende do `expirada: true` no
  `GET /api/login`; sem ele, `restaurarSessao()` engolia o 401 e a pessoa recebia a
  tela de login em branco, sem saber por que foi deslogada. Acontece a cada rotação
  do segredo.

Entrar de novo com qualquer perfil deve funcionar normalmente.

O ramo do TTL de 12h em si é coberto por `scripts/teste-http.mjs` (caso 19), que
forja `iat` antigo com um segredo de teste: 11h59 válido, 12h01 expirado, `iat` no
futuro além da tolerância recusado, e token assinado com outro segredo recusado.
