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

  let r;
  // 429 (limite de taxa da API): até 3 retentativas com espera curta — o
  // rascunho de negócio dispara várias leituras em paralelo e não deve falhar
  // por um pico momentâneo.
  for (let tentativa = 0; ; tentativa++) {
    r = await fetch(BASE + caminho, {
      headers: { Accept: 'application/json', apikey: chave },
    });
    if (r.status !== 429 || tentativa >= 3) break;
    const retryAfterS = Number(r.headers.get('retry-after'));
    const esperaMs = Number.isFinite(retryAfterS) && retryAfterS > 0 ? Math.min(retryAfterS, 5) * 1000 : 1000 * 2 ** tentativa;
    await new Promise((resolve) => setTimeout(resolve, esperaMs));
  }
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
export async function buscarUsuario(id) {
  return moskitGet(`/users/${id}`);
}
export async function buscarAnexosNegocio(dealId) {
  return moskitGet(`/deals/${dealId}/attachments`);
}

/**
 * Ids dos campos personalizados do NEGÓCIO no Moskit — cadastrados na
 * interface do Moskit, não pelo código. Preencher com os ids reais (GET
 * /customFields, module=DEAL) antes do teste ao vivo do webhook.
 */
export const CF_NEGOCIO = {
  ID_NUCLEO: 'CF_g40MLBiYSjOzYD29', // campo "ID NÚCLEO" (module DEAL, type NUMBER)
  // Mesmo id de CF_DEAL.CNPJ em api/moskit.js — o Comercial preenche o CNPJ
  // no PRÓPRIO NEGÓCIO, não no cadastro da empresa (aquele fica em branco na
  // prática), por isso o webhook lê daqui, não de buscarEmpresa(...).cnpj.
  // Campo tipo NUMBER: atenção que um CNPJ começando com "0" perde o zero à
  // esquerda quando salvo como número — limitação do campo no Moskit, não
  // do código.
  CNPJ: 'CF_Lo1qjyidSaYRODer',
  // Inferido de um evento real de teste (negócio "TESTE - Cliente novo"): o
  // único campo personalizado do negócio com um texto livre parecido com
  // observação ("Já e cliente Londrisoft cnpj: ..., tem várias outras
  // empresas") tinha este id — NÃO é o mesmo campo de CF_DEAL.OBSERVACAO em
  // api/moskit.js (aquele é de outro pipeline, Renovações). Ainda precisa
  // confirmar o nome exato do campo com a usuária.
  OBSERVACAO: 'CF_POEMywieC5JWdDdk', // confirmado ao vivo (2026-10-02): "Observações para a implantação"
  RAZAO_SOCIAL: 'CF_oJZmP1iKCQaRzDgv', // "Razão Social"
  OBSERVACAO_NEGOCIO: 'CF_0WGqoEiKCad6GmnP', // "Observação do negócio"
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
  [607645, 'Bime'], // Bime (funcionalidades básicas) — dispara Dados Tributários, diferente de Bime APP
  [607646, 'BIME APP'], // Bime APP
  [732083, 'Treinamento'], // Treinamento
  //
  // Deliberadamente de fora (caem no fallback "Outro", com o nome original
  // do Moskit preservado nas observações da subtask — nada some):
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

function telefoneDe(entidade) {
  if (!entidade) return '';
  const principal = entidade.phones?.find((p) => p.id === entidade.primaryPhone?.id);
  return principal?.number || entidade.phones?.[0]?.number || '';
}

function emailDe(entidade) {
  if (!entidade) return '';
  const principal = entidade.emails?.find((e) => e.id === entidade.primaryEmail?.id);
  return principal?.address || entidade.emails?.[0]?.address || '';
}

/**
 * Lê um NEGÓCIO do Moskit (REST, GET /deals/{id}) e monta o rascunho que
 * pré-preenche o assistente de novo projeto (botão na tela do negócio →
 * formulário do painel). Só leitura. Formato REST confirmado ao vivo
 * (2026-10-02): `contacts`/`companies` são ARRAYS ({id}), campos
 * personalizados em `entityCustomFields`, `dealProducts[].price` em centavos
 * (valor unitário) e `finalPrice` = quantidade × price.
 *
 * Quem decide se pode virar projeto (status WON, duplicidade) é quem chama —
 * aqui só se devolve o que o negócio tem.
 */
export async function montarRascunhoDoNegocio(dealId) {
  const negocio = await buscarNegocio(dealId);
  const cf = Array.isArray(negocio.entityCustomFields) ? negocio.entityCustomFields : [];
  const contatoId = negocio.contacts?.[0]?.id ?? null;
  const empresaId = negocio.companies?.[0]?.id ?? null;
  const responsavelId = negocio.responsible?.id ?? null;
  const dealProducts = Array.isArray(negocio.dealProducts) ? negocio.dealProducts : [];

  const [contato, empresa, notas, responsavel, anexos, produtos] = await Promise.all([
    contatoId ? buscarContato(contatoId).catch(() => null) : null,
    empresaId ? buscarEmpresa(empresaId).catch(() => null) : null,
    buscarNotasNegocio(dealId).catch(() => []),
    responsavelId ? buscarUsuario(responsavelId).catch(() => null) : null,
    buscarAnexosNegocio(dealId).catch(() => []),
    Promise.all(dealProducts.map((dp) => (dp?.product?.id ? buscarProduto(dp.product.id).catch(() => null) : null))),
  ]);

  const solucoes = dealProducts.map((dp, i) => {
    const { produto, nomeOriginal } = mapearProdutoSolucao(dp?.product?.id != null ? { id: dp.product.id, name: produtos[i]?.name } : null);
    const quantidade = Number(dp?.quantity) > 0 ? Number(dp.quantity) : 1;
    const unitarioCentavos = Number.isFinite(Number(dp?.price)) ? Number(dp.price) : 0;
    return {
      produto,
      planoSugerido: nomeOriginal,
      variante: '',
      observacoes: produto === 'Outro' && nomeOriginal ? `Produto original no Moskit: ${nomeOriginal}` : '',
      quantidade,
      valorManual: Math.round(unitarioCentavos) / 100,
    };
  });

  const textos = [
    valorCampoPersonalizado(cf, CF_NEGOCIO.OBSERVACAO),
    valorCampoPersonalizado(cf, CF_NEGOCIO.OBSERVACAO_NEGOCIO),
  ].map((t) => t.trim()).filter(Boolean);
  const textosUnicos = textos.filter((t, i) => textos.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i);
  // Nota que só repete (ou já está contida em) uma observação do negócio não entra de novo.
  const jaDito = (t) => textosUnicos.some((o) => o.toLowerCase().includes(t.trim().toLowerCase()));
  const notasTexto = (Array.isArray(notas) ? notas : []).map((n) => n.description).filter((t) => t && !jaDito(t));

  return {
    id: Number(dealId),
    status: negocio.status,
    nomeNegocio: negocio.name || '',
    cliente: (valorCampoPersonalizado(cf, CF_NEGOCIO.RAZAO_SOCIAL) || empresa?.name || negocio.name || contato?.name || '').trim(),
    idNucleo: valorCampoPersonalizado(cf, CF_NEGOCIO.ID_NUCLEO),
    cnpj: valorCampoPersonalizado(cf, CF_NEGOCIO.CNPJ) || empresa?.cnpj || '',
    nomeContato: contato?.name || '',
    telefone: telefoneDe(contato) || telefoneDe(empresa),
    email: emailDe(contato) || emailDe(empresa),
    contexto: [...textosUnicos, ...notasTexto].join('\n\n').slice(0, 6000),
    solucoes,
    vendedor: responsavel?.name || '',
    totalAnexos: Array.isArray(anexos) ? anexos.length : 0,
  };
}
