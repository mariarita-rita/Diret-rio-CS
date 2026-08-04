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
  EQUIPE_OPCAO,
  ErroConfigClickUp,
  ErroUpstream,
  getCarteira,
  getMetas,
  gravarCampo,
  lerClienteFresco,
  limparCampo,
  localizarTask,
  refletirEscrita,
  STATUS_MES_ATUAL,
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
    if (req.method === 'GET' && acao === 'busca') return await lerBusca(res, sessao);
    if (req.method === 'GET' && acao === 'metas') return await lerMetas(res, sessao);
    if (req.method === 'GET' && acao === 'cliente') return await lerCliente(req, res, sessao);
    if (req.method === 'POST' && acao === 'set-field') return await escreverCampo(req, res, sessao);

    if (!['carteira', 'busca', 'metas', 'cliente', 'set-field'].includes(acao)) {
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
 * Campos que a busca devolve. Lista FECHADA, e a fronteira e a forma da resposta.
 *
 * Existe porque um CSM precisava perguntar a gestao em qual carteira um cliente
 * estava: `action=carteira` filtra por CSM, de proposito, e continua filtrando. Em
 * vez de afrouxar aquela regra, esta acao devolve uma projecao propositalmente pobre.
 *
 * O que NAO esta aqui, e nao pode entrar sem decisao explicita: mrr, planoGestor,
 * planoUnique, finStatus, alertas, nps, csat, obs, descricao, motivoPerda, baseRenov,
 * eventoCamp. "Quem atende o cliente X" e informacao de roteamento interno; valor de
 * contrato e inadimplencia nao sao.
 *
 * Nao ha flag de nivel aqui: nenhum perfil consegue tirar valor financeiro desta
 * acao, porque o valor financeiro nao e copiado.
 */
const CAMPOS_BUSCA = ['id', 'idNucleo', 'cnpj', 'nome', 'cidade', 'gerente', 'status'];

/**
 * GET ?action=busca — diretorio de clientes, sem valor financeiro, sem filtro de CSM.
 *
 * CUSTO ZERO de cota quando a carteira esta quente: reusa o mesmo getCarteira() e o
 * mesmo cache de 5 min de `action=carteira`. Frio, custa as mesmas ~28 chamadas —
 * nao ha leitura nova, e uma chamada aquece a outra.
 */
async function lerBusca(res, sessao) {
  const { linhas } = await getCarteira();

  // Projecao por lista fechada. Copiar campo a campo, e nao `{...l}` menos alguns, e
  // o que garante que um campo novo em mapTask nao apareca aqui por acidente.
  const visiveis = linhas.map((l) => {
    const fora = {};
    for (const k of CAMPOS_BUSCA) fora[k] = l[k] ?? null;
    return fora;
  });

  res.setHeader('Cache-Control', CACHE_LEITURA);
  return res.status(200).json({ tasks: visiveis, total: visiveis.length, campos: CAMPOS_BUSCA });
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

const MESES_ROTULO = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/** Chave estavel do periodo. Ordena como texto porque o mes tem dois digitos. */
function chavePeriodo(m) {
  if (!m.anoBase || !m.mesNum) return null;
  return `${m.anoBase}-${String(m.mesNum).padStart(2, '0')}`;
}

async function lerMetas(res, sessao) {
  const { linhas } = await getMetas();

  // A linha de equipe sai de `individuais` ANTES de qualquer conta. Ela declara o
  // total do time; somada junto, dobrava o resultado. Era exatamente o que
  // acontecia: as 5 linhas somadas davam R$ 22.096,52 contra os R$ 11.067,76 reais,
  // e o painel anunciava ultrameta de equipe a quem tinha batido a supermeta.
  const individuais = linhas.filter((m) => m.gerenteId !== EQUIPE_OPCAO);

  const { periodos, periodoAtual, avisosGerais } = resolverPeriodos(linhas, individuais);

  // consulta nao recebe valor financeiro nenhum, nem individual (lerCarteira zera o
  // mrr) nem agregado. Agregado nao identifica o resultado de ninguem, mas continua
  // sendo numero financeiro — e o README define consulta como perfil sem acesso a
  // valor financeiro. Vale para os periodos, que carregam os limiares da equipe.
  if (sessao.nivel === 'consulta') {
    res.setHeader('Cache-Control', CACHE_LEITURA);
    return res.status(200).json({
      tasks: [], periodos: [], periodoAtual: null, avisosGerais: [],
    });
  }

  const daGestao = sessao.nivel === 'gestao';
  const visiveis = (daGestao ? individuais : individuais.filter((m) => pertenceAoCsm(m.gerente, sessao.csm)))
    .map((m) => ({ ...m, periodo: chavePeriodo(m) }));

  // A reconciliacao declarado x soma e so da gestao: um CSM nao precisa dela.
  const periodosVisiveis = periodos.map((p) => ({
    ...p,
    equipe: daGestao ? p.equipe : { ...p.equipe, soma: undefined, diferenca: undefined },
  }));

  res.setHeader('Cache-Control', CACHE_LEITURA);
  return res.status(200).json({
    tasks: visiveis,
    periodos: periodosVisiveis,
    periodoAtual,
    avisosGerais,
  });
}

/**
 * Agrupa as linhas por periodo (Ano Base + Mes Referencia) e resolve, para cada um,
 * o total da equipe e os problemas de dado.
 *
 * O periodo corrente vem do STATUS `mês atual`, nao do calendario: o fechamento
 * acontece depois do fim do mes, entao em 03/08 o mes corrente de trabalho ainda e
 * julho. Quem decide a virada e a pessoa, movendo as linhas no ClickUp.
 *
 * REGRA DE OURO daqui: nunca devolver 0 nem escolha arbitraria como se fosse
 * resultado. Estes numeros alimentam comissao e bonus. Todo caso ambiguo vira aviso
 * na tela E console.error no log da funcao.
 */
function resolverPeriodos(linhas, individuais) {
  const avisosGerais = [];
  const grupos = new Map(); // chave -> { linhas:[], individuais:[], equipes:[] }

  const semPeriodo = [];
  for (const m of linhas) {
    const chave = chavePeriodo(m);
    if (!chave) { semPeriodo.push(m); continue; }
    if (!grupos.has(chave)) grupos.set(chave, { linhas: [], individuais: [], equipes: [] });
    const g = grupos.get(chave);
    g.linhas.push(m);
    if (m.gerenteId === EQUIPE_OPCAO) g.equipes.push(m);
    else g.individuais.push(m);
  }

  if (semPeriodo.length) {
    const quais = semPeriodo.map((m) => m.nome || m.id).join(', ');
    avisosGerais.push(
      `${semPeriodo.length} linha(s) sem Ano Base ou Mês Referência preenchidos, fora de qualquer período: ${quais}`
    );
    console.error(`[clickup] metas sem periodo (Ano Base/Mes Referencia vazios): ${quais}`);
  }

  // Periodo corrente = os que tem alguma linha em `mês atual`. Mais de um periodo
  // assim e erro de operacao, nao empate a resolver.
  const chavesAtuais = [...grupos.entries()]
    .filter(([, g]) => g.linhas.some((m) => m.statusMeta === STATUS_MES_ATUAL))
    .map(([chave]) => chave);

  let periodoAtual = null;
  if (chavesAtuais.length === 1) {
    periodoAtual = chavesAtuais[0];
  } else if (chavesAtuais.length === 0) {
    avisosGerais.push(
      `Nenhuma linha com status "${STATUS_MES_ATUAL}" na lista Metas. Sem período corrente definido — marque as linhas do mês em andamento.`
    );
    console.error(`[clickup] metas: nenhuma linha com status "${STATUS_MES_ATUAL}". Periodo corrente indefinido.`);
  } else {
    const rotulos = chavesAtuais.map(rotuloPeriodo).join(' e ');
    avisosGerais.push(
      `${chavesAtuais.length} períodos diferentes marcados como "${STATUS_MES_ATUAL}": ${rotulos}. Deixe apenas o mês em andamento.`
    );
    console.error(`[clickup] metas: ${chavesAtuais.length} periodos em "${STATUS_MES_ATUAL}" (${chavesAtuais.join(', ')}). Periodo corrente ambiguo.`);
  }

  const periodos = [...grupos.entries()]
    .map(([chave, g]) => montarPeriodo(chave, g, chave === periodoAtual))
    // Mais recente primeiro. A chave `AAAA-MM` ordena corretamente como texto.
    .sort((a, b) => b.chave.localeCompare(a.chave));

  return { periodos, periodoAtual, avisosGerais };
}

function rotuloPeriodo(chave) {
  const [ano, mes] = chave.split('-');
  return `${MESES_ROTULO[Number(mes) - 1] || mes}/${ano}`;
}

/**
 * Um periodo: total da equipe, limiares e os problemas de dado que impedem confiar
 * nos numeros dele.
 *
 * `equipe.declarado` distingue o total DECLARADO pela linha "⭐ Equipe" da soma das
 * individuais. O fallback para a soma existe para nao quebrar quando a linha nao foi
 * criada; duas linhas de equipe tambem caem nele, porque "declarado" fica ambiguo e
 * um numero definido e melhor que um escolhido por ordem de iteracao.
 */
function montarPeriodo(chave, g, atual) {
  const avisos = [];
  const soma = g.individuais.reduce((s, m) => s + (m.mrrAt - m.downsell), 0);

  // Mais de uma linha do mesmo CSM no periodo: nao ha como escolher.
  const porGerente = new Map();
  for (const m of g.individuais) {
    const k = m.gerente || '(sem gerente)';
    porGerente.set(k, (porGerente.get(k) || 0) + 1);
  }
  const duplicados = [...porGerente.entries()].filter(([, n]) => n > 1);
  for (const [nome, n] of duplicados) {
    avisos.push(`${nome} tem ${n} linhas em ${rotuloPeriodo(chave)}. A meta individual dele não pode ser exibida até sobrar uma.`);
    console.error(`[clickup] metas: ${n} linhas de "${nome}" no periodo ${chave}.`);
  }

  let equipe;
  if (g.equipes.length === 1) {
    const eq = g.equipes[0];
    const mrr = eq.mrrAt - eq.downsell;
    equipe = {
      mrr, declarado: true,
      meta: eq.meta, superMeta: eq.superMeta, ultraMeta: eq.ultraMeta, metaEsp: eq.metaEsp,
      soma, diferenca: mrr - soma,
    };
  } else {
    if (g.equipes.length > 1) {
      avisos.push(`${g.equipes.length} linhas "⭐ Equipe" em ${rotuloPeriodo(chave)}. Usando a soma dos gerentes até sobrar uma.`);
      console.error(`[clickup] metas: ${g.equipes.length} linhas "⭐ Equipe" no periodo ${chave}.`);
    } else if (atual) {
      // Só alarma no periodo corrente: mes antigo sem linha de equipe e historico,
      // nao problema a resolver agora.
      console.warn(`[clickup] metas: periodo corrente ${chave} sem linha "⭐ Equipe". Usando a soma de ${g.individuais.length} individuais.`);
    }
    equipe = {
      mrr: soma, declarado: false,
      meta: null, superMeta: null, ultraMeta: null, metaEsp: null,
      soma, diferenca: 0,
    };
  }

  return {
    chave,
    ano: Number(chave.split('-')[0]),
    mes: Number(chave.split('-')[1]),
    rotulo: rotuloPeriodo(chave),
    atual,
    // Gerentes com linha duplicada: o front esconde o numero deles em vez de mostrar
    // um dos dois.
    gerentesAmbiguos: duplicados.map(([nome]) => nome),
    equipe,
    avisos,
  };
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

  // `null` significa limpar, e no ClickUp isso e DELETE — nao existe POST com value
  // null. Chega aqui somente para campos `limpavel`, ja filtrado em validarValor.
  if (valor === null) {
    await limparCampo(taskId, fieldId);
  } else {
    await gravarCampo(taskId, fieldId, valor);
  }
  // Reflete no cache em vez de derruba-lo: derrubar custaria ~28 chamadas na leitura
  // seguinte, de uma cota de 100/min compartilhada por todo o time.
  refletirEscrita(taskId, fieldId, valor);
  return res.status(200).json({ ok: true, campo: campo.nome, limpo: valor === null });
}

/**
 * Valida o valor de acordo com o tipo do campo.
 * @returns o valor saneado, `null` para limpar, ou undefined se for recusado.
 */
function validarValor(campo, value) {
  // Limpar o campo. So nos campos marcados `limpavel` na allowlist, e so com null
  // EXPLICITO — `value` ausente continua sendo recusado, para que um corpo
  // incompleto nunca apague dado por acidente.
  if (value === null) {
    return campo.limpavel ? null : undefined;
  }
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
