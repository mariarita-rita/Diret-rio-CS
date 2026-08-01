// Cliente ClickUp do lado do servidor: listas travadas, cache de leitura,
// mapeamento dos campos e indice para validar propriedade das tasks.
//
// Nada aqui aceita path livre vindo do cliente.

const BASE = 'https://api.clickup.com/api/v2';

// Os dois IDs de lista vivem SO aqui. Jamais chegam do cliente.
export const LISTA_CARTEIRA = '901327787926';
export const LISTA_METAS = '901327940637';
export const LISTAS_PERMITIDAS = new Set([LISTA_CARTEIRA, LISTA_METAS]);

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
};

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
};

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
  /** Guarda apenas o status. O corpo da resposta do ClickUp nunca sai daqui. */
  constructor(status) {
    super(`ClickUp respondeu ${status}`);
    this.name = 'ErroUpstream';
    this.status = status;
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

/** Chamada bruta ao ClickUp. O token nunca aparece em retorno, erro ou log. */
async function cu(path, init = {}) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: chave(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    // Corpo lido e descartado para nao vazar detalhe do upstream ao navegador.
    await r.text().catch(() => '');
    throw new ErroUpstream(r.status);
  }
  return r.json();
}

// ── Leitura dos campos personalizados (portado do front) ──────────────────

function cfVal(task, id) {
  const f = task.custom_fields?.find((x) => x.id === id);
  if (!f) return null;

  if (f.type === 'labels') {
    if (!Array.isArray(f.value) || f.value.length === 0) return [];
    const opts = f.type_config?.options || [];
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
    const opt = f.type_config?.options?.find((o) => o.orderindex === f.value || o.id === f.value);
    return opt?.name || null;
  }
  if (f.type === 'checkbox') return f.value === true || f.value === 'true';
  return f.value;
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
    cnpj: cfVal(t, CF.CNPJ),
    cidade: cfVal(t, CF.CIDADE),
    finStatus: cfVal(t, CF.FIN_STATUS),
    outrosSrv: cfVal(t, CF.OUTROS_SRV) || [],
    obs: cfVal(t, CF.OBS),
    nps: cfVal(t, CF.NPS),
    acomp: cfVal(t, CF.ACOMP),
    motivoPerda: cfVal(t, CF.MOTIVO_PERDA),
    dataCancel: cfVal(t, CF.DATA_CANCEL),
    csat: cfVal(t, CF.CSAT),
  };
}

function mapMeta(t) {
  return {
    id: t.id,
    nome: t.name,
    gerente: cfVal(t, CM.GERENTE),
    mrrAt: Number(cfVal(t, CM.MRR_ATINGIDO)) || 0,
    downsell: Number(cfVal(t, CM.DOWNSELL)) || 0,
    meta: Number(cfVal(t, CM.META)) || 0,
    superMeta: Number(cfVal(t, CM.SUPER_META)) || 0,
    ultraMeta: Number(cfVal(t, CM.ULTRA_META)) || 0,
    metaEsp: Number(cfVal(t, CM.META_ESP)) || 0,
    mesRef: cfVal(t, CM.MES_REF),
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
 */
async function buscarPaginado(listaId, extra) {
  const LOTE = 4;
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

/**
 * Localiza o cliente na lista Carteira e devolve a linha completa.
 * Usado pelo /api/moskit para derivar do ClickUp — e nao do corpo enviado pelo
 * navegador — os dados de identificacao do cliente e o responsavel.
 * Se a task nao estiver no cache (cliente criado agora), recarrega uma vez.
 *
 * @returns {Promise<object|null>} a linha da carteira, ou null se nao existir
 */
export async function localizarCliente(taskId) {
  let carteira = await getCarteira();
  let achado = carteira.porId.get(taskId);
  if (!achado) {
    cacheCarteira.em = 0;
    carteira = await getCarteira();
    achado = carteira.porId.get(taskId);
  }
  return achado?.linha || null;
}

export async function getMetas() {
  return comCache(cacheMetas, async () => {
    const r = await cu(`/list/${LISTA_METAS}/task?include_closed=false`);
    const linhas = (r.tasks || []).map(mapMeta);
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
  const carteira = await getCarteira();
  const naCarteira = carteira.porId.get(taskId);
  if (naCarteira) return naCarteira;

  const metas = await getMetas();
  const nasMetas = metas.porId.get(taskId);
  if (nasMetas) return nasMetas;

  const agora = Date.now();
  const guardado = cacheTasks.get(taskId);
  if (guardado && agora - guardado.em < TTL_TASK_MS) {
    return guardado.permitida ? { listId: guardado.listId, gerente: guardado.gerente } : null;
  }

  let task;
  try {
    task = await cu(`/task/${taskId}?include_subtasks=false`);
  } catch (e) {
    if (e instanceof ErroUpstream && (e.status === 404 || e.status === 400)) {
      cacheTasks.set(taskId, { em: agora, permitida: false });
      return null;
    }
    throw e;
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

/** Invalida o cache da carteira depois de uma escrita. */
export function invalidarCarteira() {
  cacheCarteira.em = 0;
  cacheTasks.clear();
}
