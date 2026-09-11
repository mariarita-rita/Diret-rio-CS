// Cliente somente-leitura da API pública do Moskit/Ollow (v2). Usado pela
// automação do webhook (api/moskit-webhook.js) para buscar os dados do
// negócio ganho antes de criar o projeto de implantação no ClickUp.
//
// Não reaproveita api/moskit.js — aquele arquivo faz o caminho oposto
// (POST /deals, POST /projects: ClickUp -> Moskit, usado no fluxo de
// renovação/risco de churn) e exige sessão de usuário. Aqui só se lê, sem
// sessão nenhuma (quem chama é o webhook).

const BASE = 'https://api.ms.prod.ollow.services/v2';

export class ErroConfigMoskit extends Error {
  constructor() {
    super('MOSKIT_API_KEY não configurada.');
    this.name = 'ErroConfigMoskit';
  }
}

export class ErroUpstreamMoskit extends Error {
  constructor(status) {
    super(`Moskit respondeu ${status}`);
    this.name = 'ErroUpstreamMoskit';
    this.status = status;
  }
}

async function moskitGet(caminho) {
  const chave = process.env.MOSKIT_API_KEY;
  if (!chave) throw new ErroConfigMoskit();

  const r = await fetch(BASE + caminho, {
    headers: { Accept: 'application/json', apikey: chave },
  });
  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    console.error(`[moskit-lib] GET ${caminho} -> ${r.status}: ${detalhe.slice(0, 500)}`);
    throw new ErroUpstreamMoskit(r.status);
  }
  return r.json().catch(() => ({}));
}

export async function buscarNegocio(id) {
  return moskitGet(`/deals/${id}`);
}
export async function buscarContato(id) {
  return moskitGet(`/contacts/${id}`);
}
export async function buscarEmpresa(id) {
  return moskitGet(`/companies/${id}`);
}
export async function buscarNotasNegocio(id) {
  return moskitGet(`/deals/${id}/notes`);
}
export async function buscarProduto(id) {
  return moskitGet(`/products/${id}`);
}

/**
 * Ids dos campos personalizados do NEGÓCIO no Moskit — cadastrados na
 * interface do Moskit, não pelo código. Preencher com os ids reais (GET
 * /customFields, module=DEAL) antes do teste ao vivo do webhook.
 */
export const CF_NEGOCIO = {
  ID_NUCLEO: 'CF_g40MLBiYSjOzYD29', // campo "ID NÚCLEO" (module DEAL, type NUMBER)
  OBSERVACAO: 'CF_0WGqoEiKCad6GmnP', // mesmo id de CF_DEAL.OBSERVACAO em api/moskit.js
};

/** Valor de um campo personalizado pelo id, já como texto — '' se ausente. */
export function valorCampoPersonalizado(entityCustomFields, id) {
  if (!id || !Array.isArray(entityCustomFields)) return '';
  const campo = entityCustomFields.find((c) => c.id === id);
  if (!campo) return '';
  if (campo.textValue != null) return String(campo.textValue);
  if (campo.numericValue != null) return String(campo.numericValue);
  if (campo.dateValue != null) return String(campo.dateValue);
  return '';
}

/**
 * Produto do Moskit (catálogo de vendas) -> um dos valores aceitos em
 * PRODUTOS_SOLUCAO_VALIDOS (api/clickup.js). Chave é o id do produto no
 * Moskit — a usuária precisa passar os ids reais do catálogo; até lá, todo
 * produto cai no fallback "Outro" (nada é descartado, só fica genérico até
 * alguém completar o mapa).
 */
export const MAPA_PRODUTO_MOSKIT = new Map([
  // Linha Gestor (planos + usuário adicional).
  [513428, 'Gestor'], // Plano NFe Cloud
  [513471, 'Gestor'], // Plano NFe local
  [513472, 'Gestor'], // Plano Básico Cloud
  [513473, 'Gestor'], // Plano Básico local
  [513474, 'Gestor'], // Plano Intermediário Cloud
  [513476, 'Gestor'], // Plano Intermediário local
  [513479, 'Gestor'], // Plano Avançado Cloud
  [513480, 'Gestor'], // Plano Avançado local
  [513504, 'Gestor'], // Usuário adicional GESTOR NUVEM (BASE)
  [513505, 'Gestor'], // Usuário adicional GESTOR LOCAL (BASE)
  [513506, 'Gestor'], // Usuário adicional GESTOR NUVEM
  [513507, 'Gestor'], // Usuário adicional GESTOR LOCAL
  // Linha Unique (planos + usuário adicional).
  [513481, 'Unique'], // Plano Unique Light
  [513482, 'Unique'], // Plano Unique Plus
  [513483, 'Unique'], // Plano Unique Premium
  [513503, 'Unique'], // Usuário adicional Unique
  // Simplaz — separado por Gestor/Unique conforme o nome do produto.
  [514268, 'Simplaz Gestor'], // Simplaz Bronze - Gestor
  [514270, 'Simplaz Gestor'], // Simplaz Prata - Gestor
  [514272, 'Simplaz Gestor'], // Simplaz Ouro - Gestor
  [514269, 'Simplaz Unique'], // Simplaz Bronze - Unique
  [514271, 'Simplaz Unique'], // Simplaz Prata - Unique
  [514273, 'Simplaz Unique'], // Simplaz Ouro - Unique
  [711508, 'Simplaz Gestor'], // Simplaz Personalizado - Gestor
  [607646, 'BIME APP'], // Bime APP
  [732083, 'Treinamento'], // Treinamento
  //
  // Deliberadamente de fora (caem no fallback "Outro", com o nome original
  // do Moskit preservado nas observações da subtask — nada some):
  // - 607645 "Bime" (funcionalidade básica, produto diferente do "Bime APP"
  //   acima — não presumi que seja a mesma coisa).
  // - Certificados digitais, Classificador tributário, Analytics, Mobile,
  //   Consulta CPF, Reajuste Anual, Incremento/Redução Downsell, Projeto
  //   Sob Demanda, Cota Londrisoft Camp — nenhum bate com um valor de
  //   PRODUTOS_SOLUCAO_VALIDOS.
  // - "Waipe Individual/Time/Enterprise" (+ usuário adicional e excedente/
  //   hora de implantação) — ver pergunta feita à usuária: PRODUTOS_SOLUCAO_
  //   VALIDOS não tem nenhum valor "Waipe" hoje, e agentes Waipe já são
  //   decididos à parte no diagnóstico (CS/ISM), não como produto do Moskit.
]);

/** { produto, nomeOriginal } a partir de um produto do Moskit ({id, name}). */
export function mapearProdutoSolucao(produtoMoskit) {
  const mapeado = produtoMoskit?.id != null ? MAPA_PRODUTO_MOSKIT.get(produtoMoskit.id) : null;
  return { produto: mapeado || 'Outro', nomeOriginal: produtoMoskit?.name || '' };
}
