// Proxy do ClickUp. NAO e um proxy generico: aceita apenas tres acoes fixas e
// nunca um path livre vindo do cliente.
//
//   GET  /api/clickup?action=carteira    lista 901327787926 paginada no servidor
//   GET  /api/clickup?action=metas       lista 901327940637
//   POST /api/clickup?action=set-field   { taskId, fieldId, value }
//
// Toda requisicao exige cookie de sessao valido. As regras de nivel sao
// aplicadas aqui, no servidor:
//   consulta -> somente leitura, sem set-field, e sem valores de MRR
//   csm      -> apenas registros da propria carteira, leitura e escrita
//   gestao   -> acesso completo

import {
  aplicarCors,
  erro,
  erroLimite,
  lerCorpo,
  taskIdValido,
  uuidValido,
  ErroCorpo,
} from './_lib/http.js';
import { exigirSessao, podeEscrever, pertenceAoCsm, ErroConfig } from './_lib/auth.js';
import {
  CAMPOS_ESCRITA,
  ErroConfigClickUp,
  ErroUpstream,
  getCarteira,
  getMetas,
  gravarCampo,
  lerClienteFresco,
  localizarTask,
  refletirEscrita,
} from './_lib/clickup.js';

// Leitura: 300s de frescor / 600s de revalidacao, mas em cache PRIVADO.
// A resposta varia por sessao (filtro por CSM), portanto nao pode ir para o
// cache compartilhado da CDN — ver nota no README.
const CACHE_LEITURA = 'private, max-age=300, stale-while-revalidate=600';

const MAX_LABELS = 10;

export default async function handler(req, res) {
  // req.query, como req.body, e getter lazy no runtime da Vercel: fica dentro
  // do try junto com todo o resto.
  let acao = '';

  // O try cobre o handler INTEIRO, inclusive CORS e exigirSessao. Antes eles
  // ficavam de fora, e um ErroConfig ali derrubava a funcao em vez de responder.
  try {
    acao = String(req.query?.action || '');

    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();

    const sessao = exigirSessao(req, res);
    if (!sessao) return undefined;

    if (req.method === 'GET' && acao === 'carteira') return await lerCarteira(res, sessao);
    if (req.method === 'GET' && acao === 'metas') return await lerMetas(res, sessao);
    if (req.method === 'GET' && acao === 'cliente') return await lerCliente(req, res, sessao);
    if (req.method === 'POST' && acao === 'set-field') return await escreverCampo(req, res, sessao);

    if (!['carteira', 'metas', 'cliente', 'set-field'].includes(acao)) {
      return erro(res, 400, 'acao_invalida', 'Ação inválida.');
    }
    return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido para esta ação.');
  } catch (e) {
    return tratarErro(res, e, acao);
  }
}

// ── Leitura ───────────────────────────────────────────────────────────────

async function lerCarteira(res, sessao) {
  const { linhas } = await getCarteira();

  // Filtro por CSM ANTES de responder — a carteira dos outros nunca chega ao navegador.
  let visiveis = sessao.nivel === 'csm' ? linhas.filter((l) => pertenceAoCsm(l.gerente, sessao.csm)) : linhas;

  // consulta nao ve valores financeiros. O front tambem os esconde, mas quem
  // decide e o servidor: editar `session` no console nao revela MRR.
  if (sessao.nivel === 'consulta') {
    visiveis = visiveis.map((l) => ({ ...l, mrr: 0 }));
  }

  res.setHeader('Cache-Control', CACHE_LEITURA);
  return res.status(200).json({ tasks: visiveis, total: visiveis.length });
}

/**
 * GET ?action=cliente&taskId=... — UMA linha, lida direto do ClickUp.
 *
 * Mesmo portao das outras leituras: sessao obrigatoria (ja exigida no handler),
 * escopo por CSM e MRR zerado para consulta. Nada relaxado — a unica diferenca e
 * que nao passa pelo cache e responde `no-store`, porque o motivo de existir e
 * justamente entregar a verdade: e desta linha que sai a pre-marcacao dos alertas,
 * que alimenta uma escrita de array completo.
 */
async function lerCliente(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');

  const taskId = String(req.query?.taskId || '');
  if (!taskIdValido(taskId)) {
    return erro(res, 400, 'task_invalida', 'taskId inválido.');
  }

  const linha = await lerClienteFresco(taskId);
  if (!linha) {
    return erro(res, 403, 'task_fora_do_escopo', 'Tarefa fora das listas permitidas.');
  }
  if (sessao.nivel === 'csm' && !pertenceAoCsm(linha.gerente, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este cliente não está na sua carteira.');
  }

  return res.status(200).json({ task: sessao.nivel === 'consulta' ? { ...linha, mrr: 0 } : linha });
}

async function lerMetas(res, sessao) {
  const { linhas } = await getMetas();

  // mrrEquipe acompanha `visiveis`: consulta nao recebe valor financeiro nenhum,
  // nem individual (lerCarteira zera o mrr) nem agregado. Agregado nao identifica
  // o resultado de ninguem, mas continua sendo numero financeiro — e o README
  // define consulta como perfil sem acesso a valor financeiro.
  let visiveis;
  let mrrEquipe = 0;
  if (sessao.nivel === 'gestao') {
    visiveis = linhas;
    mrrEquipe = somarMrrEquipe(linhas);
  } else if (sessao.nivel === 'csm') {
    visiveis = linhas.filter((m) => pertenceAoCsm(m.gerente, sessao.csm));
    mrrEquipe = somarMrrEquipe(linhas);
  } else {
    visiveis = [];
  }

  res.setHeader('Cache-Control', CACHE_LEITURA);
  return res.status(200).json({ tasks: visiveis, mrrEquipe });
}

/**
 * MRR liquido da equipe, usado no bonus de equipe.
 * Somado sobre TODAS as metas mesmo para o CSM — de proposito: o numero do bonus
 * e da equipe inteira, e nao permite isolar o resultado de ninguem.
 */
function somarMrrEquipe(linhas) {
  return linhas.reduce((s, m) => s + (m.mrrAt - m.downsell), 0);
}

// ── Escrita ───────────────────────────────────────────────────────────────

async function escreverCampo(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');

  if (!podeEscrever(sessao)) {
    return erro(res, 403, 'somente_leitura', 'Seu perfil tem acesso somente de leitura.');
  }

  let corpo;
  try {
    corpo = await lerCorpo(req);
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }

  const { taskId, fieldId, value } = corpo;

  if (!taskIdValido(taskId)) {
    return erro(res, 400, 'task_invalida', 'taskId inválido.');
  }
  if (!uuidValido(fieldId) || !Object.hasOwn(CAMPOS_ESCRITA, fieldId)) {
    return erro(res, 403, 'campo_nao_permitido', 'Campo não permitido para escrita.');
  }

  const campo = CAMPOS_ESCRITA[fieldId];
  const valor = validarValor(campo, value);
  if (valor === undefined) {
    return erro(res, 403, 'valor_nao_permitido', `Valor não permitido para o campo ${campo.nome}.`);
  }

  // A task precisa pertencer a uma das duas listas permitidas.
  const dono = await localizarTask(taskId);
  if (!dono) {
    return erro(res, 403, 'task_fora_do_escopo', 'Tarefa fora das listas permitidas.');
  }

  // E, para CSM, precisa ser da propria carteira.
  if (sessao.nivel === 'csm' && !pertenceAoCsm(dono.gerente, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este cliente não está na sua carteira.');
  }

  await gravarCampo(taskId, fieldId, valor);
  // Reflete no cache em vez de derruba-lo: derrubar custaria ~28 chamadas na leitura
  // seguinte, de uma cota de 100/min compartilhada por todo o time.
  refletirEscrita(taskId, fieldId, valor);
  return res.status(200).json({ ok: true, campo: campo.nome });
}

/**
 * Valida o valor de acordo com o tipo do campo.
 * @returns o valor saneado, ou undefined se for recusado.
 */
function validarValor(campo, value) {
  if (campo.tipo === 'checkbox') {
    if (value === true || value === false) return value;
    return undefined;
  }
  if (campo.tipo === 'opcao') {
    if (typeof value === 'string' && campo.opcoes.has(value)) return value;
    return undefined;
  }
  if (campo.tipo === 'lista') {
    if (!Array.isArray(value) || value.length > MAX_LABELS) return undefined;
    for (const v of value) {
      if (typeof v !== 'string' || !campo.opcoes.has(v)) return undefined;
    }
    return value;
  }
  return undefined;
}

// ── Erros ─────────────────────────────────────────────────────────────────

function tratarErro(res, e, acao) {
  if (e instanceof ErroConfigClickUp || e instanceof ErroConfig) {
    console.error('[clickup] configuracao:', e.message);
    return erro(res, 500, 'nao_configurado', 'Integração não configurada no servidor.');
  }
  if (e instanceof ErroUpstream) {
    // 429 tem tratamento proprio: a cota e de 100/min por TOKEN, compartilhada por
    // todo o time. Devolver "erro ao carregar" fazia a pessoa recarregar, e cada
    // recarga custa ~28 chamadas — a propria reacao ao erro aprofundava o erro.
    if (e.status === 429) return erroLimite(res, e.esperaSegundos);

    console.error(`[clickup] acao=${acao} upstream=${e.status}`);
    // 401/403 do ClickUp significam problema da credencial DO SERVIDOR, nao da
    // sessao do usuario. Repassar 401 faria o front derrubar a sessao sem motivo,
    // por isso esses dois casos viram 502.
    const status = e.status === 401 || e.status === 403 ? 502 : e.status;
    return erro(res, status, 'erro_clickup', `Falha na comunicação com o ClickUp (${e.status}).`);
  }
  console.error(`[clickup] acao=${acao} falha=${e?.name}: ${e?.message}`);
  return erro(res, 500, 'erro_interno', 'Erro interno ao falar com o ClickUp.');
}
