// Cliente ClickUp do lado do servidor: listas travadas, cache de leitura,
// mapeamento dos campos e indice para validar propriedade das tasks.
//
// Nada aqui aceita path livre vindo do cliente.

const BASE = 'https://api.clickup.com/api/v2';

// Os dois IDs de lista vivem SO aqui. Jamais chegam do cliente.
export const LISTA_CARTEIRA = '901327787926';
export const LISTA_METAS = '901327940637';
export const LISTAS_PERMITIDAS = new Set([LISTA_CARTEIRA, LISTA_METAS]);

// Log de propostas geradas pelo simulador Waipe. Lista separada das duas acima —
// nao entra em LISTAS_PERMITIDAS porque essa constante gate-keeps escopo de
// CLIENTE (localizarTask/set-field), e uma task de log nao e um cliente.
export const LISTA_PROPOSTAS_WAIPE = '901328973414';

/**
 * Projetos de implantacao Waipe (Projetos em Andamento). Task-pai = cliente,
 * subtask = agente do backlog daquele cliente. Tambem fora de LISTAS_PERMITIDAS
 * pelo mesmo motivo de LISTA_PROPOSTAS_WAIPE: aquele set gate-keeps escopo de
 * CLIENTE (localizarTask/set-field), e isto e outra entidade.
 */
export const LISTA_IMPLANTACOES_WAIPE = '901328976497';

// Campos da lista Carteira
const CF = {
  ID_NUCLEO: '6126a50b-7afb-40fd-8654-26a687f34258',
  MRR: '59888807-a3f3-42f0-aebd-f63032011ed1',
  GERENTE: '3898a8f4-bb21-46d7-88ee-79d164033fdf',
  PLANO_GESTOR: '806ccb6e-5368-43de-8fca-bcb7ba25d918',
  PLANO_UNIQUE: 'fd73720e-da1b-4e8b-aa8a-02d77f38b486',
  BASE_RENOV: '06f3d2e9-f32a-4146-ac21-844b500a174e',
  CRITERIO: '28f77e01-ba41-48c9-a07b-0e89bc9ac35b',
  ALERTAS: '6ce5db54-1a1d-4dfa-944d-4b01b8832549',
  CNPJ: '1e819aec-0121-44c2-8a92-302c2f0e4450',
  CIDADE: 'beaef1da-fffa-419f-9827-093b5452f8fc',
  FIN_STATUS: 'c290f699-8d56-437c-9319-1cf282430d12',
  OUTROS_SRV: 'f8397dca-a5a5-494e-815c-3206efa7c562',
  OBS: '114a9169-2a63-42b6-b9d3-8596232d0401',
  NPS: '49b335f4-98b9-40b6-acf6-f06ca3061621',
  ACOMP: '94b85690-3d47-4edf-9209-0a671cfb570b',
  MOTIVO_PERDA: '57b588ce-81f5-4728-94e5-b22d1966862a',
  DATA_CANCEL: '7a36a0b2-6de0-4f9b-8278-d7338e42b325',
  CSAT: '98acac2a-932b-4c60-8a16-bd2e211961d5',
  EVENTO_CAMP: '54ee7ad4-4689-4d79-bec7-5ac1373d96e9',
  CAMP_VENDIDOS: '4a4400e7-6bfd-423e-9467-9c6f11c458c9',
  CAMP_CORTESIA: '62514802-d199-462a-9a44-9e8389c74951',
  CAMP_VALOR: '748dbd02-1c2f-4f31-a5f7-5cc82bcd3cb0',
};

/**
 * Opcoes do campo 📅 Evento: Camp 2026. Ficam aqui porque o front precisa dos
 * rotulos para montar o seletor, e a allowlist de escrita precisa dos ids.
 * Um id fora desta lista volta 403 — e a allowlist funcionando, nao bug.
 */
export const EVENTO_CAMP_OPCOES = [
  { id: '52fbe800-c9cf-4aca-b75e-fdbbb4ea7e07', rotulo: 'Convidado 💠' },
  { id: '69d511be-83fd-48e0-96ce-c4567a9c1e3f', rotulo: 'Inscrito ✅' },
  { id: '0a08b436-5e35-458b-a05d-93f816e81488', rotulo: 'Não Vai 🚫' },
  { id: '8ceeca28-bc44-4f86-b3ff-f6205c316dda', rotulo: 'Participou ✨' },
];

/**
 * Opcao "Contratou em outro CNPJ" do campo Motivo da perda.
 *
 * Contratar em outro CNPJ e troca de titularidade: administrativamente gera um
 * cancelamento e um contrato novo, mas nao e venda nova nem perda real. Por isso o
 * card de resumo da gestao tira esse valor do MRR perdido — e SO ele. A lista de
 * cancelamentos, o total do cabecalho dela e o top 3 de motivos seguem contando
 * normalmente, porque ali o registro administrativo e o que se quer ver.
 *
 * Exportado para que a suite prove que o front e o servidor usam o MESMO id: a
 * regra vive no front (dashboard_carteiras.html, MOTIVO_MIGRACAO_CNPJ) e uma
 * divergencia entre os dois seria silenciosa.
 */
export const MOTIVO_MIGRACAO_CNPJ = '00c64f34-41e0-4fb2-8f70-17a55b803507';

/**
 * Opcao "⭐ Equipe" do campo Gerente de Contas, na lista Metas.
 *
 * A linha de equipe DECLARA o total do time, em vez de ele ser somado das quatro
 * individuais. Identificada por ID da opcao, nunca pelo rotulo:
 *
 * - o `value` desse campo chega como `orderindex` (a linha de equipe hoje vem como
 *   `4`), entao comparar por texto dependeria de resolver orderindex -> nome, e o
 *   nome carrega o emoji `⭐`, que se perde num copy-paste ou numa renomeacao;
 * - `orderindex` NAO serve de chave: e posicao na lista, e arrastar a opcao no
 *   ClickUp mudaria o `4` e quebraria a regra em silencio.
 *
 * Nenhum perfil de CSM casa com ela: pertenceAoCsm compara nome COMPLETO
 * normalizado por igualdade exata, e "⭐ Equipe" nao e nome de ninguem.
 */
export const EQUIPE_OPCAO = 'a9832e95-4c6b-4b53-834f-cebb5000a188';

// Campos da lista Metas
const CM = {
  MRR_ATINGIDO: '3f9f68a3-58f8-4a3c-9e40-131e6e7b940e',
  DOWNSELL: '099e8c77-5ea3-4ab2-81e4-0f12e18ea9f9',
  META: '66a8ff49-2a0e-4e6a-98db-7854e674a5cf',
  SUPER_META: '575f8269-a094-4ad5-8eaa-9806e128368a',
  ULTRA_META: '659aaee9-d3e9-4f89-aa65-b10e40178ab1',
  META_ESP: '28627910-6605-4389-bcca-5efccb2cc264',
  GERENTE: '3898a8f4-bb21-46d7-88ee-79d164033fdf',
  MES_REF: '6f335424-3dcc-4cf0-9df3-2cdb367efde3',
  ANO_BASE: '5c06c44f-135e-4139-ae0b-3d21cb9d6040',
};

/**
 * Status que marca o periodo corrente de trabalho na lista Metas.
 *
 * O periodo NAO vem do calendario, e sim deste status. O fechamento acontece depois
 * do fim do mes: em 03/08 o mes corrente de trabalho ainda e julho. Quem decide a
 * virada e a pessoa, movendo as linhas no ClickUp.
 *
 * ACOPLAMENTO: e o nome do status no ClickUp, em minusculas. Renomear la faz o
 * painel nao achar periodo corrente — o que aparece como ERRO VISIVEL (ver os
 * avisos de lerMetas), nunca como numero errado. A lista tem hoje quatro status:
 * `mes atual` (open), `meses fechados` (custom), `concluido` (done) e `finalizado`
 * (closed). Com include_closed=false os dois ultimos podem nao chegar.
 */
export const STATUS_MES_ATUAL = 'mês atual';

/**
 * Opcao de 📅 Mes Referencia -> numero do mes.
 *
 * Mapeado por ID da opcao, nao pelo rotulo nem pelo orderindex, pelo mesmo motivo de
 * EQUIPE_OPCAO: rotulo quebra ao renomear, orderindex quebra ao reordenar. O numero
 * serve para ORDENAR os periodos do mais recente para o mais antigo — o rotulo
 * "Janeiro" nao se ordena sozinho, e o campo nao tem ano.
 */
const MESES_OPCAO = new Map([
  ['862d5112-66ad-4143-8390-c2c6d9ca5793', 1],
  ['40780596-e94a-4e6b-ac23-21b692f89b1f', 2],
  ['45be10be-0492-4c5f-adff-315314a2a16f', 3],
  ['497d656f-3964-4729-8884-9d7b7221f503', 4],
  ['a88806dd-d478-4e13-a9d3-2e9d03fc37cf', 5],
  ['68ab70d4-0288-49b4-8c82-45769ed6ee59', 6],
  ['80ae72d6-3320-4066-bdb8-46a4ffdff41f', 7],
  ['4d3e89aa-f3ab-4b99-b33c-07d1ea4b16d4', 8],
  ['acca4e93-13a6-425c-aa05-c07d98a75fdb', 9],
  ['8f577868-8d4b-452d-ab38-26616e3c7f06', 10],
  ['6a5627f4-50a4-4276-8510-45a6e2ff3b05', 11],
  ['337e7243-d78e-4881-90e0-35fe423e8ca3', 12],
]);

/**
 * ALLOWLIST de escrita — exatamente os 4 campos que o dashboard usa.
 * Qualquer outro fieldId resulta em 403.
 * Os valores tambem sao validados: os campos de opcao/lista so aceitam os IDs
 * de opcao que o formulario oferece.
 */
export const CAMPOS_ESCRITA = {
  [CF.ACOMP]: {
    nome: 'Em acompanhamento',
    tipo: 'checkbox',
  },
  'd15028f2-40c6-44da-a5dc-3d608eef6f48': {
    nome: 'Etapa',
    tipo: 'opcao',
    opcoes: new Set(['94eb0e3e-de65-432d-b74d-a342689d5d85']),
  },
  'a4acad54-a6da-477f-b1fc-b3cbf56bbd08': {
    nome: 'Tipo de solicitacao',
    tipo: 'opcao',
    opcoes: new Set([
      '95a588fd-93b6-435e-bcea-0d92053b9fde', // Acompanhamento
      '5bf34afa-7aac-42d3-9681-8f7950881605', // Diagnostico
      '489f815d-7155-415d-af04-c4f03688d785', // Risco de Churn
      '52dcd948-9d90-4cd1-9254-536c1c2fbb0d', // Oportunidade de up e cross
    ]),
  },
  // Acrescentado explicitamente, campo a campo e opcao a opcao. NAO existe regra
  // generica de "qualquer drop_down": a allowlist continua sendo uma lista fechada.
  [CF.EVENTO_CAMP]: {
    nome: 'Evento: Camp 2026',
    tipo: 'opcao',
    opcoes: new Set(EVENTO_CAMP_OPCOES.map((o) => o.id)),
    /**
     * UNICO campo limpavel, de proposito. O campo existe para o gerente sinalizar sem
     * precisar de acesso ao ClickUp; se corrigir um clique errado exigisse abrir o
     * ClickUp, ele funcionaria pela metade. "Nao Vai 🚫" cobre "o cliente nao vai",
     * nao cobre "marquei a linha errada".
     *
     * Etapa, Tipo de solicitacao, Alertas e Em acompanhamento NAO sao limpaveis:
     * fazem parte do fluxo de acompanhamento, onde apagar nao e desfazer — Etapa
     * vazia deixaria a task fora do fluxo, e Alertas tem `[]` como limpeza legitima
     * via POST, que ja funciona.
     */
    limpavel: true,
  },
  // Campanha de metas do Camp 2026 (quantidade + comissão). Numeros, nao opcoes: sem
  // Set de ids para validar, so o teto em `max` contra digitacao errada.
  [CF.CAMP_VENDIDOS]: {
    nome: 'Camp 2026 - Ingressos vendidos',
    tipo: 'numero',
    max: 999,
  },
  [CF.CAMP_CORTESIA]: {
    nome: 'Camp 2026 - Ingressos cortesia',
    tipo: 'numero',
    max: 999,
  },
  [CF.CAMP_VALOR]: {
    nome: 'Camp 2026 - Valor vendido (R$)',
    tipo: 'numero',
    max: 999999,
  },
  [CF.ALERTAS]: {
    nome: 'Alertas',
    tipo: 'lista',
    opcoes: new Set([
      'ddaddf7d-9ffa-49de-9b53-6e63acbbceb3', // Risco de Churn
      '06759f74-83bb-427a-8ddd-77aa2f9f94c5', // Cliente Insatisfeito
      'dca403db-9fe3-43ce-9877-674fd45c181a', // Baixa Utilizacao
      '2f6c9a19-8788-45be-b0b4-1e8bf2090d1e', // Inadimplencia
      'f12e9041-767e-41b3-9f6e-9fdd277496c5', // Nao responde
    ]),
  },
};

// ── Erros ─────────────────────────────────────────────────────────────────

export class ErroUpstream extends Error {
  /**
   * Guarda o status e, quando o upstream informa, os segundos até a cota liberar.
   * O corpo da resposta nunca sai daqui.
   */
  constructor(status, esperaSegundos = null) {
    super(`ClickUp respondeu ${status}`);
    this.name = 'ErroUpstream';
    this.status = status;
    this.esperaSegundos = esperaSegundos;
  }
}

export class ErroConfigClickUp extends Error {
  constructor() {
    super('CLICKUP_API_KEY nao configurada.');
    this.name = 'ErroConfigClickUp';
  }
}

function chave() {
  const k = process.env.CLICKUP_API_KEY;
  if (!k) throw new ErroConfigClickUp();
  return k;
}

// ── Cota do ClickUp ───────────────────────────────────────────────────────
// O limite e por TOKEN e por MINUTO, e o token e um so, do servidor: a cota e
// compartilhada por todas as pessoas usando o dashboard. O ClickUp informa o
// estado em toda resposta, e antes esses cabecalhos eram descartados junto com o
// resto — o que tornava o custo por operacao uma estimativa.
const cota = { limite: null, restante: null, reset: null, anunciado: false };

/** Estado de cota observado nesta instancia. Somente numeros, nada sensivel. */
export function cotaClickUp() {
  return { ...cota };
}

function registrarCota(r) {
  const limite = Number(r.headers.get('x-ratelimit-limit'));
  const restante = Number(r.headers.get('x-ratelimit-remaining'));
  const reset = Number(r.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(limite)) cota.limite = limite;
  if (Number.isFinite(restante)) cota.restante = restante;
  if (Number.isFinite(reset)) cota.reset = reset;

  // Uma linha por processo, so para registrar o limite do plano.
  if (!cota.anunciado && cota.limite !== null) {
    cota.anunciado = true;
    console.log(`[clickup] cota do plano: ${cota.limite}/min (restante agora: ${cota.restante})`);
  }

  // Uma leitura de carteira inteira consome ~28 chamadas. Avisar antes de estourar.
  if (cota.limite && cota.restante !== null && cota.restante <= Math.max(30, cota.limite * 0.2)) {
    console.error(`[clickup] COTA BAIXA: restante=${cota.restante}/${cota.limite} reset=${cota.reset}`);
  }
}

/** Segundos a esperar, preferindo Retry-After e caindo para X-RateLimit-Reset. */
function esperaDe(r) {
  const ra = Number(r.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.ceil(ra);
  const reset = Number(r.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // Alguns retornos vem em epoch de segundos, outros em segundos relativos.
    const agora = Math.floor(Date.now() / 1000);
    const delta = reset > agora ? reset - agora : reset;
    if (delta > 0 && delta <= 3600) return Math.ceil(delta);
  }
  return null;
}

/**
 * Chamada bruta ao ClickUp. O token nunca aparece em retorno, erro ou log.
 *
 * `semCorpo` existe para o DELETE de campo personalizado, que responde 200 com corpo
 * VAZIO. Sem isso o `r.json()` lançaria DEPOIS de a escrita ter sido aplicada, e a
 * funcao devolveria 500 para uma operacao bem-sucedida — o front reverteria o seletor
 * e a pessoa acharia que nao limpou, quando limpou. E a mentira que a reversao em erro
 * existe para evitar, ao contrario.
 */
async function cu(path, init = {}, { semCorpo = false } = {}) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: chave(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  registrarCota(r);

  if (!r.ok) {
    // Corpo lido e descartado para nao vazar detalhe do upstream ao navegador.
    await r.text().catch(() => '');
    const espera = r.status === 429 ? esperaDe(r) : null;
    if (r.status === 429) {
      console.error(
        `[clickup] 429 limite de requisicoes. espera=${espera !== null ? espera + 's' : 'nao informada'} ` +
          `restante=${cota.restante}/${cota.limite}`
      );
    }
    throw new ErroUpstream(r.status, espera);
  }
  if (semCorpo) {
    await r.text().catch(() => '');
    return {};
  }
  return r.json();
}

// ── Leitura dos campos personalizados (portado do front) ──────────────────

/** id de opcao -> rotulo, aprendido do type_config nas leituras. Ver cfVal. */
const rotulosAprendidos = new Map();

function cfVal(task, id) {
  const f = task.custom_fields?.find((x) => x.id === id);
  if (!f) return null;

  if (f.type === 'labels') {
    const opts = f.type_config?.options || [];
    // Aprende id -> rotulo do proprio ClickUp. E o que permite refletir uma escrita
    // no cache sem reler a lista inteira, e sem hardcodar acentuacao de rotulo.
    for (const o of opts) {
      if (o?.id) rotulosAprendidos.set(o.id, o.label || o.name || null);
    }
    if (!Array.isArray(f.value) || f.value.length === 0) return [];
    return f.value
      .map((v) => {
        if (typeof v === 'object' && v !== null) return v.label || v.name || null;
        const opt = opts.find((o) => o.id === v || o.orderindex === v);
        return opt?.label || opt?.name || null;
      })
      .filter(Boolean);
  }

  if (f.value === null || f.value === undefined) return null;

  if (f.type === 'drop_down') {
    // Aprende id -> rotulo tambem para drop_down, pelo mesmo motivo dos labels:
    // refletirEscrita precisa do rotulo da opcao gravada para atualizar a linha em
    // cache sem reler a lista inteira, e sem hardcodar acentuacao nem emoji.
    for (const o of f.type_config?.options || []) {
      if (o?.id) rotulosAprendidos.set(o.id, o.name || o.label || null);
    }
    const opt = f.type_config?.options?.find((o) => o.orderindex === f.value || o.id === f.value);
    return opt?.name || null;
  }
  if (f.type === 'checkbox') return f.value === true || f.value === 'true';
  return f.value;
}

/**
 * Id da opcao escolhida num drop_down — o UUID estavel, nunca o rotulo.
 *
 * Mesma motivacao de cfLabelIds, para o outro tipo de campo: cfVal() traduz
 * drop_down para o NOME da opcao e descarta o id, e regra de negocio casada por
 * rotulo quebra em silencio quando alguem renomeia a opcao no ClickUp.
 *
 * O `value` de um drop_down vem como `orderindex` (numero) OU como id da opcao
 * (string) — a API alterna entre os dois. Por isso a busca replica a de cfVal e
 * so entao devolve `opt.id`: `orderindex` NAO serve de chave, porque e posicao na
 * lista e muda quando alguem reordena as opcoes.
 */
function cfOpcaoId(task, id) {
  const f = task.custom_fields?.find((x) => x.id === id);
  if (!f || f.type !== 'drop_down') return null;
  if (f.value === null || f.value === undefined) return null;
  const opt = f.type_config?.options?.find((o) => o.orderindex === f.value || o.id === f.value);
  return opt?.id || null;
}

/**
 * Ids crus de um campo de labels.
 * mapTask traduz labels para NOMES e, ao fazer isso, perdia os ids — e sem eles o
 * front era obrigado a casar rotulo por texto para pre-marcar os alertas. Casamento
 * por texto e a mesma fragilidade de substring que ja nos mordeu em pertenceAoCsm, e
 * aqui alimenta uma escrita: marcar a tag errada GRAVA a tag errada.
 */
function cfLabelIds(task, id) {
  const f = task.custom_fields?.find((x) => x.id === id);
  if (!f || f.type !== 'labels' || !Array.isArray(f.value)) return [];
  return f.value
    .map((v) => (v && typeof v === 'object' ? v.id : v))
    .filter((v) => typeof v === 'string' && v);
}

/** Linha da carteira enviada ao navegador — bem menor que a task crua. */
function mapTask(t) {
  return {
    id: t.id,
    nome: t.name,
    status: (t.status?.status || '').toLowerCase(),
    descricao: t.description || '',
    idNucleo: cfVal(t, CF.ID_NUCLEO),
    mrr: Number(cfVal(t, CF.MRR)) || 0,
    gerente: cfVal(t, CF.GERENTE),
    planoGestor: cfVal(t, CF.PLANO_GESTOR),
    planoUnique: cfVal(t, CF.PLANO_UNIQUE),
    baseRenov: cfVal(t, CF.BASE_RENOV),
    criterio: cfVal(t, CF.CRITERIO),
    alertas: cfVal(t, CF.ALERTAS) || [],
    alertasIds: cfLabelIds(t, CF.ALERTAS),
    cnpj: cfVal(t, CF.CNPJ),
    cidade: cfVal(t, CF.CIDADE),
    finStatus: cfVal(t, CF.FIN_STATUS),
    outrosSrv: cfVal(t, CF.OUTROS_SRV) || [],
    obs: cfVal(t, CF.OBS),
    nps: cfVal(t, CF.NPS),
    acomp: cfVal(t, CF.ACOMP),
    motivoPerda: cfVal(t, CF.MOTIVO_PERDA),
    // Id da opcao ao lado do rotulo: o resumo da gestao exclui "Contratou em outro
    // CNPJ" do MRR perdido, e essa regra compara por ID. Ver MOTIVO_MIGRACAO_CNPJ.
    motivoPerdaId: cfOpcaoId(t, CF.MOTIVO_PERDA),
    dataCancel: cfVal(t, CF.DATA_CANCEL),
    csat: cfVal(t, CF.CSAT),
    // Rotulo para exibir e id para pre-selecionar o seletor. Mesmo padrao de
    // motivoPerdaId: o id e o que alimenta a escrita, e casar por texto para gravar
    // significaria gravar a opcao errada quando alguem renomear no ClickUp.
    eventoCamp: cfVal(t, CF.EVENTO_CAMP),
    eventoCampId: cfOpcaoId(t, CF.EVENTO_CAMP),
    campVendidos: Number(cfVal(t, CF.CAMP_VENDIDOS)) || 0,
    campCortesia: Number(cfVal(t, CF.CAMP_CORTESIA)) || 0,
    campValor: Number(cfVal(t, CF.CAMP_VALOR)) || 0,
  };
}

function mapMeta(t) {
  const mesRefId = cfOpcaoId(t, CM.MES_REF);
  const anoBruto = cfVal(t, CM.ANO_BASE);
  const ano = Number(String(anoBruto ?? '').trim());
  return {
    id: t.id,
    nome: t.name,
    // Status da propria task: e o que define o periodo corrente. Ver STATUS_MES_ATUAL.
    statusMeta: (t.status?.status || '').toLowerCase(),
    gerente: cfVal(t, CM.GERENTE),
    // Id da opcao ao lado do rotulo, pelo mesmo motivo de motivoPerdaId: a linha de
    // equipe e identificada por ID, nunca pelo texto "⭐ Equipe". Ver EQUIPE_OPCAO.
    gerenteId: cfOpcaoId(t, CM.GERENTE),
    mrrAt: Number(cfVal(t, CM.MRR_ATINGIDO)) || 0,
    downsell: Number(cfVal(t, CM.DOWNSELL)) || 0,
    meta: Number(cfVal(t, CM.META)) || 0,
    superMeta: Number(cfVal(t, CM.SUPER_META)) || 0,
    ultraMeta: Number(cfVal(t, CM.ULTRA_META)) || 0,
    metaEsp: Number(cfVal(t, CM.META_ESP)) || 0,
    mesRef: cfVal(t, CM.MES_REF),
    mesRefId,
    // Numero do mes e ano, para ordenar periodos. null quando o campo esta vazio ou
    // com opcao desconhecida — quem consome trata como "periodo indefinido" em vez
    // de assumir um mes qualquer.
    mesNum: MESES_OPCAO.get(mesRefId) ?? null,
    anoBase: Number.isInteger(ano) && ano >= 2000 && ano <= 2100 ? ano : null,
  };
}

// ── Cache de leitura (por instancia, TTL de 5 min) ─────────────────────────

const TTL_MS = 5 * 60 * 1000;
const TTL_TASK_MS = 5 * 60 * 1000;
const MAX_PAGINAS = 100;

const cacheCarteira = { em: 0, dados: null, pendente: null };
const cacheMetas = { em: 0, dados: null, pendente: null };
const cacheTasks = new Map(); // taskId -> { em, permitida, listId, gerente }

async function comCache(slot, produzir) {
  const agora = Date.now();
  if (slot.dados && agora - slot.em < TTL_MS) return slot.dados;
  if (slot.pendente) return slot.pendente;

  slot.pendente = (async () => {
    const dados = await produzir();
    slot.dados = dados;
    slot.em = Date.now();
    return dados;
  })();

  try {
    return await slot.pendente;
  } finally {
    // Em caso de falha o cache antigo continua valendo; a proxima chamada tenta de novo.
    slot.pendente = null;
  }
}

/**
 * Paginacao completa da lista, em lotes concorrentes.
 * No navegador esse laco era sequencial e sem prazo; aqui ele roda dentro de uma
 * funcao serverless, que tem limite de tempo. Buscar LOTE paginas por vez corta o
 * tempo de parede sem chegar perto do limite de requisicoes do ClickUp.
 * Promise.all preserva a ordem, então a ordem das tasks nao muda.
 *
 * `lote` e parametro porque as duas listas tem escalas opostas. A Carteira tem 2797
 * tasks (28 paginas) e o lote de 4 corta o tempo de parede. A lista Metas tem 5
 * linhas por mes: com lote 4 ela custaria 4 chamadas para buscar 5 registros, contra
 * 1 antes de paginar. Com lote 1 e o `last_page` do ClickUp, volta a 1 chamada
 * enquanto couber numa pagina, e 2 quando passar de 100 linhas.
 */
async function buscarPaginado(listaId, extra, lote = 4) {
  const LOTE = Math.max(1, lote);
  const out = [];
  let fim = false;

  for (let page = 0; page < MAX_PAGINAS && !fim; page += LOTE) {
    const paginas = [];
    for (let i = 0; i < LOTE && page + i < MAX_PAGINAS; i++) paginas.push(page + i);

    const respostas = await Promise.all(
      paginas.map((p) => cu(`/list/${listaId}/task?page=${p}&limit=100&${extra}`))
    );

    for (const r of respostas) {
      const tasks = r.tasks || [];
      if (tasks.length === 0) {
        fim = true;
        break;
      }
      out.push(...tasks);
      // As paginas seguintes do lote, se houver, vem depois do fim da lista.
      if (r.last_page) {
        fim = true;
        break;
      }
    }
  }
  return out;
}

/** Carteira completa, paginada inteiramente aqui no servidor, + indice por task. */
export async function getCarteira() {
  return comCache(cacheCarteira, async () => {
    const tasks = await buscarPaginado(
      LISTA_CARTEIRA,
      'include_closed=true&include_custom_fields=true'
    );
    const linhas = tasks.map(mapTask);
    const porId = new Map();
    for (const l of linhas) porId.set(l.id, { listId: LISTA_CARTEIRA, gerente: l.gerente, linha: l });
    return { linhas, porId };
  });
}

/** Dados do slot SE ja estiverem quentes. Nunca dispara busca. */
function soSeQuente(slot) {
  return slot.dados && Date.now() - slot.em < TTL_MS ? slot.dados : null;
}

/**
 * Localiza o cliente na lista Carteira e devolve a linha completa.
 * Usado pelo /api/moskit para derivar do ClickUp — e nao do corpo enviado pelo
 * navegador — os dados de identificacao do cliente e o responsavel.
 *
 * CUSTO: aproveita a carteira se ela ja estiver quente; senao busca UMA task.
 * A versao anterior chamava getCarteira() e, se nao achasse, invalidava e chamava
 * de novo — 28 a 56 chamadas ao ClickUp para resolver um cliente, contra uma cota
 * medida de 100/min compartilhada por todo o time.
 *
 * @returns {Promise<object|null>} a linha da carteira, ou null se nao existir
 */
export async function localizarCliente(taskId) {
  const carteira = soSeQuente(cacheCarteira);
  if (carteira) {
    const achado = carteira.porId.get(taskId);
    if (achado) return achado.linha;
  }

  const task = await buscarTaskUnica(taskId);
  if (!task) return null;
  // Cliente vem SO da lista Carteira. Metas nao serve aqui.
  if (String(task?.list?.id || '') !== LISTA_CARTEIRA) return null;
  return mapTask(task);
}

/**
 * Linha do cliente lida DIRETO do ClickUp, sem passar pelo cache. Custa 1 chamada.
 *
 * Existe porque a escrita de alertas envia o array COMPLETO dos selecionados, e a
 * selecao inicial vem do que a tela mostra. Com dado velho, um alerta acrescentado
 * por outra pessoa nao esta no array enviado e desaparece sem aviso. O dashboard
 * antigo lia direto do ClickUp, entao essa janela era de segundos; o cache que
 * introduzimos a esticou para minutos. Isto devolve a janela ao tamanho anterior.
 *
 * localizarCliente() continua preferindo o cache: no caminho do Moskit os dados de
 * identificacao (ID Nucleo, CNPJ, razao social) nao mudam.
 */
export async function lerClienteFresco(taskId) {
  const task = await buscarTaskUnica(taskId);
  if (!task) return null;
  if (String(task?.list?.id || '') !== LISTA_CARTEIRA) return null;

  const linha = mapTask(task);
  // Se o cache estiver quente, aproveita para alinha-lo com o que acabamos de ler.
  const alvo = soSeQuente(cacheCarteira)?.porId.get(taskId);
  if (alvo?.linha) Object.assign(alvo.linha, linha);
  return linha;
}

/** Busca uma task por id. Devolve null quando o ClickUp diz que nao existe. */
async function buscarTaskUnica(taskId) {
  try {
    return await cu(`/task/${taskId}?include_subtasks=false`);
  } catch (e) {
    if (e instanceof ErroUpstream && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/**
 * Lista Metas inteira, paginada.
 *
 * Antes era UMA chamada sem `page`: acima de 100 linhas as mais antigas
 * desapareciam em silencio. Com 5 linhas por mes sao 60 no primeiro ano e 120 no
 * segundo, entao o teto seria batido em 2027 sem nenhum sinal.
 *
 * `include_closed=false` de proposito: FINALIZADO e arquivo, e o seletor de periodo
 * so oferece o que ainda esta em jogo. O efeito colateral aceito e nao dar para
 * abrir um mes finalizado no painel.
 *
 * Lote 1 para nao trocar 1 chamada por 4 numa lista pequena — ver buscarPaginado.
 */
export async function getMetas() {
  return comCache(cacheMetas, async () => {
    const tasks = await buscarPaginado(LISTA_METAS, 'include_closed=false', 1);
    const linhas = tasks.map(mapMeta);
    const porId = new Map();
    for (const l of linhas) porId.set(l.id, { listId: LISTA_METAS, gerente: l.gerente });
    return { linhas, porId };
  });
}

/**
 * Confirma que a task pertence a uma das duas listas permitidas e devolve o
 * gerente dono dela. Usa os indices ja carregados; se a task for nova e ainda
 * nao estiver no cache, faz UMA chamada extra e guarda o resultado.
 *
 * @returns {Promise<{listId:string, gerente:string|null}|null>} null = fora do escopo
 */
export async function localizarTask(taskId) {
  const agora = Date.now();

  // 1. Indice de tasks ja resolvidas: ZERO chamadas.
  const guardado = cacheTasks.get(taskId);
  if (guardado && agora - guardado.em < TTL_TASK_MS) {
    return guardado.permitida ? { listId: guardado.listId, gerente: guardado.gerente } : null;
  }

  // 2. Caches de leitura, SO se ja estiverem quentes: ZERO chamadas.
  //    Aqui NAO chamamos getCarteira()/getMetas() de proposito. Elas custam 28 e 1
  //    chamadas quando frias, e uma escrita nao pode pagar isso: a ordem anterior
  //    (carteira inteira primeiro) fazia cada set-field custar 29 chamadas de uma
  //    cota medida em 100/min, e invalidarCarteira() garantia que a escrita
  //    seguinte pagasse de novo.
  const carteira = soSeQuente(cacheCarteira);
  if (carteira) {
    const naCarteira = carteira.porId.get(taskId);
    if (naCarteira) return naCarteira;
  }
  const metas = soSeQuente(cacheMetas);
  if (metas) {
    const nasMetas = metas.porId.get(taskId);
    if (nasMetas) return nasMetas;
  }

  // 3. A task sozinha: UMA chamada. Nao encontrar no cache quente nao decide nada
  //    — a task pode ser nova, ou estar na outra lista.
  const task = await buscarTaskUnica(taskId);
  if (!task) {
    cacheTasks.set(taskId, { em: agora, permitida: false });
    return null;
  }

  const listId = String(task?.list?.id || '');
  if (!LISTAS_PERMITIDAS.has(listId)) {
    cacheTasks.set(taskId, { em: agora, permitida: false });
    return null;
  }

  const gerente = cfVal(task, CF.GERENTE);
  if (cacheTasks.size > 2000) cacheTasks.clear();
  cacheTasks.set(taskId, { em: agora, permitida: true, listId, gerente });
  return { listId, gerente };
}

/** POST em /task/{taskId}/field/{fieldId}. Ambos os ids ja validados pelo endpoint. */
export async function gravarCampo(taskId, fieldId, value) {
  return cu(`/task/${taskId}/field/${fieldId}`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

/**
 * Apaga o valor de um campo personalizado.
 *
 * No ClickUp isso e DELETE no mesmo endpoint — nao existe "POST com value null".
 * E o UNICO caminho de escrita do proxy que nao e POST, e chega aqui somente para os
 * campos marcados `limpavel` em CAMPOS_ESCRITA. Hoje so o Evento: Camp 2026.
 *
 * Responde 200 com corpo vazio, por isso `semCorpo`.
 */
export async function limparCampo(taskId, fieldId) {
  return cu(`/task/${taskId}/field/${fieldId}`, { method: 'DELETE' }, { semCorpo: true });
}

/**
 * Cria uma task de log em LISTA_PROPOSTAS_WAIPE — uma por proposta gerada no
 * simulador Waipe. `payload` ja vem validado e saneado pelo endpoint
 * (log-proposta, em clickup.js); esta funcao so faz o POST.
 */
export async function criarTaskPropostaWaipe(payload) {
  return cu(`/list/${LISTA_PROPOSTAS_WAIPE}/task`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Cria a task-pai de um projeto de implantacao em LISTA_IMPLANTACOES_WAIPE.
 * `payload` ja vem validado pelo endpoint (criar-implantacao, em clickup.js).
 */
export async function criarTaskImplantacao(payload) {
  return cu(`/list/${LISTA_IMPLANTACOES_WAIPE}/task`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Cria uma subtask (agente do backlog) presa a `parentId`, na mesma lista. */
export async function criarSubtaskAgente(parentId, payload) {
  return cu(`/list/${LISTA_IMPLANTACOES_WAIPE}/task`, {
    method: 'POST',
    body: JSON.stringify({ ...payload, parent: parentId }),
  });
}

/** PUT generico em /task/{id} — nome, descricao, status, due_date. */
export async function atualizarTask(taskId, payload) {
  return cu(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

/** GET de uma task sozinha, sem subtasks. `null` se o ClickUp disser 404/400. */
export async function obterTask(taskId) {
  try {
    return await cu(`/task/${taskId}`);
  } catch (e) {
    if (e instanceof ErroUpstream && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/**
 * Todas as tasks-pai de LISTA_IMPLANTACOES_WAIPE. Lote 1: e uma lista pequena
 * (uma linha por cliente em implantacao), mesmo raciocinio de getMetas.
 */
export async function listarImplantacoes() {
  return buscarPaginado(LISTA_IMPLANTACOES_WAIPE, 'include_closed=true', 1);
}

/**
 * Uma task-pai (projeto) e suas subtasks (agentes), cada uma com a descricao
 * completa. `include_subtasks=true` no GET devolve os IDS das subtasks; o
 * conteudo de cada uma (description) so vem confiavel buscando-a de novo —
 * por isso o Promise.all abaixo, no mesmo padrao de buscarPaginado.
 */
export async function obterTaskComSubtasks(taskId) {
  const pai = await cu(`/task/${taskId}?include_subtasks=true`);
  const subIds = Array.isArray(pai.subtasks) ? pai.subtasks.map((s) => s.id).filter(Boolean) : [];
  const subtasks = subIds.length ? await Promise.all(subIds.map((id) => cu(`/task/${id}`))) : [];
  return { pai, subtasks };
}

/** Comentario nativo do ClickUp numa task (nota do ISM durante o fluxo). */
export async function criarComentario(taskId, texto) {
  return cu(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: texto }),
  });
}

/** Comentarios nativos de uma task, mais recentes primeiro (como o ClickUp devolve). */
export async function listarComentarios(taskId) {
  const r = await cu(`/task/${taskId}/comment`);
  return Array.isArray(r.comments) ? r.comments : [];
}

/**
 * ISMs (Implementation Success Managers) responsaveis por implantacao — papel
 * diferente do CSM (que e dono de carteira, atribuido por texto). Aqui e
 * assignee DE VERDADE do ClickUp, por isso a allowlist e por id de usuario do
 * workspace (confirmados via clickup_get_workspace_members), no mesmo espirito
 * de CAMPOS_ESCRITA: um id fora daqui e descartado, nunca vira 500.
 */
export const ISM_OPCOES = [
  { id: 118125102, nome: 'Bruno Vaz' },
  { id: 48933858, nome: 'Erica Fernanda' },
];

// ── Estado do fluxo Waipe embutido na descricao ────────────────────────────
//
// O workflow de status do ClickUp e fixo por espaco (pendente/in progress/
// agendado/bloqueado/cancelado/concluido/Closed — confirmado lendo
// LISTA_PROPOSTAS_WAIPE, mesmo espaco) e nao ha ferramenta para criar um novo
// conjunto de status por lista. Por isso a etapa fina do fluxo (escopo ->
// alinhamento -> construcao -> testes -> entrega), a fila de prioridade e os
// checklists por agente NAO viram status: viram um bloco JSON no fim da
// descricao da task.
//
// IMPORTANTE, confirmado com uma task real: o ClickUp reescreve
// `markdown_description` para texto simples na leitura (`description` e
// `text_content`) e DESCARTA toda sintaxe markdown — negrito, divisor `---`,
// fence de codigo, tudo. Um delimitador como ```` ```waipe-state ```` some
// no round-trip; so o TEXTO fica. Por isso o bloco nao e localizado por
// marcador nenhum: e o ULTIMO valor JSON valido da descricao, procurado de
// tras para frente a partir do `{` mais proximo do fim.
function localizarBlocoEstado(description) {
  const texto = String(description || '');
  let pos = texto.length;
  for (;;) {
    const idx = texto.lastIndexOf('{', pos - 1);
    if (idx === -1) return null;
    try {
      return { inicio: idx, valor: JSON.parse(texto.slice(idx).trim()) };
    } catch {
      pos = idx;
    }
  }
}

/** Le o bloco de estado de uma descricao. `{}` se ausente ou corrompido. */
export function parseWaipeState(description) {
  return localizarBlocoEstado(description)?.valor || {};
}

/** Descricao sem o bloco de estado — o texto que faz sentido mostrar a uma pessoa. */
export function contextoSemEstado(description) {
  const texto = String(description || '');
  const achado = localizarBlocoEstado(texto);
  return (achado ? texto.slice(0, achado.inicio) : texto).trimEnd();
}

/** Substitui (ou acrescenta) o bloco de estado ao final da descricao. */
export function stringifyWaipeState(description, state) {
  return `${contextoSemEstado(description)}\n\n${JSON.stringify(state)}`;
}

/**
 * Extrai o nome do CSM da linha gravada por criar-implantacao. Aceita com ou
 * sem `**` ao redor: a task RECEM-CRIADA ainda tem o markdown intacto no
 * corpo que acabamos de montar, mas qualquer leitura de volta do ClickUp ja
 * devolve isso como texto simples (ver nota acima).
 */
export function csmDaDescricaoImplantacao(description) {
  const m = /\*{0,2}CSM:\*{0,2}\s*(.+)/.exec(String(description || ''));
  return m ? m[1].trim() : '';
}

/**
 * Invalida o cache da carteira. Ultimo recurso: a proxima leitura paga ~28 chamadas.
 *
 * `cacheTasks` NAO e limpo: ele guarda listId e gerente, e nenhum campo da allowlist
 * de escrita altera qualquer um dos dois. Limpar era desperdicio de cota.
 */
export function invalidarCarteira() {
  cacheCarteira.em = 0;
}

/**
 * Reflete uma escrita já confirmada na linha em cache, em vez de derrubar o cache.
 *
 * Motivo: a linha em cache ficava velha depois de escrever, e a pessoa via o valor
 * antigo — marcava de novo, e cada recarga custa ~28 chamadas de uma cota de 100/min
 * compartilhada pelo time. Derrubar o cache resolveria a corretude ao custo de 28
 * chamadas na leitura seguinte; refletir custa zero.
 *
 * Só é chamada depois de `200` do ClickUp, então a escrita está aplicada.
 */
export function refletirEscrita(taskId, fieldId, valor) {
  const carteira = soSeQuente(cacheCarteira);
  if (!carteira) return; // cache frio: a proxima leitura ja vem do ClickUp
  const alvo = carteira.porId.get(taskId);
  if (!alvo?.linha) return;

  if (fieldId === CF.ACOMP) {
    alvo.linha.acomp = valor === true;
    return;
  }

  if (fieldId === CF.ALERTAS) {
    const rotulos = (Array.isArray(valor) ? valor : []).map((id) => rotulosAprendidos.get(id));
    if (rotulos.some((r) => !r)) {
      // Rotulo desconhecido: preferir custo a divergencia.
      invalidarCarteira();
      return;
    }
    alvo.linha.alertas = rotulos;
    alvo.linha.alertasIds = Array.isArray(valor) ? [...valor] : [];
    return;
  }

  if (fieldId === CF.EVENTO_CAMP) {
    // null = campo limpo (DELETE). Nada a aprender, nada a invalidar.
    if (valor === null) {
      alvo.linha.eventoCamp = null;
      alvo.linha.eventoCampId = null;
      return;
    }
    const rotulo = rotulosAprendidos.get(valor);
    if (!rotulo) {
      // Rotulo desconhecido: preferir custo a divergencia, como nos alertas.
      invalidarCarteira();
      return;
    }
    alvo.linha.eventoCamp = rotulo;
    alvo.linha.eventoCampId = valor;
    return;
  }

  if (fieldId === CF.CAMP_VENDIDOS) {
    alvo.linha.campVendidos = valor;
    return;
  }
  if (fieldId === CF.CAMP_CORTESIA) {
    alvo.linha.campCortesia = valor;
    return;
  }
  if (fieldId === CF.CAMP_VALOR) {
    alvo.linha.campValor = valor;
    return;
  }

  // Etapa e Tipo de solicitacao nao aparecem na linha que mapTask devolve — nao ha
  // nada a refletir, e o cache continua valido.
}
