// Proxy do ClickUp. NAO e um proxy generico: aceita apenas acoes fixas e
// nunca um path livre vindo do cliente.
//
//   GET  /api/clickup?action=carteira              lista 901327787926 paginada no servidor
//   GET  /api/clickup?action=metas                 lista 901327940637
//   POST /api/clickup?action=set-field             { taskId, fieldId, value }
//   POST /api/clickup?action=log-proposta          cria task de log em 901328973414
//   GET  /api/clickup?action=listar-implantacoes   lista 901328976497 (projetos em andamento)
//   GET  /api/clickup?action=obter-implantacao     { id } -> projeto + agentes
//   POST /api/clickup?action=criar-implantacao     { cliente, contexto, agentes[] }
//   POST /api/clickup?action=atualizar-implantacao { id, etapaAtual, prioridade[], ... }
//   POST /api/clickup?action=atualizar-agente      { taskId, buildChecks?, testChecks?, ... }
//   POST /api/clickup?action=comentar-implantacao  { taskId, texto }
//   GET  /api/clickup?action=listar-comentarios    { taskId }
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
  texto,
  uuidValido,
  ErroCorpo,
} from './_lib/http.js';
import { exigirSessao, podeEscrever, pertenceAoCsm, ErroConfig } from './_lib/auth.js';
import {
  atualizarTask,
  CAMPOS_ESCRITA,
  contextoSemEstado,
  criarComentario,
  criarSubtaskAgente,
  criarTaskImplantacao,
  criarTaskPropostaWaipe,
  csmDaDescricaoImplantacao,
  EQUIPE_OPCAO,
  ErroConfigClickUp,
  ErroUpstream,
  getCarteira,
  getMetas,
  gravarCampo,
  ISM_OPCOES,
  lerClienteFresco,
  limparCampo,
  LISTA_IMPLANTACOES_WAIPE,
  listarComentarios,
  listarImplantacoes,
  localizarTask,
  obterTask,
  obterTaskComSubtasks,
  parseWaipeState,
  refletirEscrita,
  STATUS_MES_ATUAL,
  stringifyWaipeState,
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
    if (req.method === 'POST' && acao === 'log-proposta') return await logProposta(req, res, sessao);
    if (req.method === 'GET' && acao === 'listar-implantacoes') return await listarImplantacoesAcao(res, sessao);
    if (req.method === 'GET' && acao === 'obter-implantacao') return await obterImplantacaoAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'criar-implantacao') return await criarImplantacaoAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'atualizar-implantacao') {
      return await atualizarImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'atualizar-agente') return await atualizarAgenteAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'comentar-implantacao') return await comentarImplantacaoAcao(req, res, sessao);
    if (req.method === 'GET' && acao === 'listar-comentarios') return await listarComentariosAcao(req, res, sessao);

    const ACOES_VALIDAS = [
      'carteira', 'busca', 'metas', 'cliente', 'set-field', 'log-proposta',
      'listar-implantacoes', 'obter-implantacao', 'criar-implantacao',
      'atualizar-implantacao', 'atualizar-agente', 'comentar-implantacao',
      'listar-comentarios',
    ];
    if (!ACOES_VALIDAS.includes(acao)) {
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
  if (campo.tipo === 'numero') {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= campo.max) return value;
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

const PLANOS_VALIDOS = new Set(['Individual', 'Time', 'Enterprise']);

/**
 * POST ?action=log-proposta — registra uma proposta gerada pelo simulador Waipe
 * como task em LISTA_PROPOSTAS_WAIPE. Nao toca em nenhuma task de cliente das
 * listas Carteira/Metas; e so um log de atividade, uma task por proposta.
 *
 * Passa pelo mesmo portao de `podeEscrever` que `set-field` — e criacao de
 * dado, nao leitura, entao `consulta` fica de fora. A atribuicao de CSM vem da
 * SESSAO (sessao.nome), nunca do corpo: o campo `csm` que o simulador manda e
 * texto livre digitado por quem preencheu a proposta, e nao serve para
 * atribuicao confiavel.
 */
async function logProposta(req, res, sessao) {
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

  const cliente = texto(corpo.cliente, 120);
  if (!cliente) {
    return erro(res, 400, 'cliente_invalido', 'Nome do cliente é obrigatório.');
  }

  const plano = typeof corpo.plano === 'string' && PLANOS_VALIDOS.has(corpo.plano) ? corpo.plano : 'A definir';
  const segmento = texto(corpo.segmento, 120);
  const acaoOrigem = texto(corpo.acaoOrigem, 40);
  const dores = texto(corpo.dores, 600);

  let valorMensal = null;
  if (
    typeof corpo.valorMensal === 'number' &&
    Number.isFinite(corpo.valorMensal) &&
    corpo.valorMensal >= 0 &&
    corpo.valorMensal <= 999999
  ) {
    valorMensal = corpo.valorMensal;
  }

  const agentes = Array.isArray(corpo.agentes)
    ? corpo.agentes.filter((a) => typeof a === 'string').slice(0, 30).map((a) => texto(a, 80)).filter(Boolean)
    : [];

  const dataRotulo = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const nomeTask = `${cliente} — ${plano} — ${dataRotulo}`;

  const linhasDescricao = [
    `**CSM:** ${texto(sessao.nome, 120) || sessao.csm || sessao.nivel}`,
    segmento ? `**Segmento:** ${segmento}` : null,
    `**Plano:** ${plano}`,
    valorMensal !== null ? `**Investimento mensal:** R$ ${valorMensal.toFixed(2)}` : null,
    agentes.length ? `**Agentes selecionados (${agentes.length}):** ${agentes.join(', ')}` : null,
    dores ? `**Dores do cliente:**\n${dores}` : null,
    acaoOrigem ? `**Ação:** ${acaoOrigem}` : null,
  ].filter(Boolean);

  await criarTaskPropostaWaipe({
    name: nomeTask,
    markdown_description: linhasDescricao.join('\n\n'),
  });

  return res.status(200).json({ ok: true });
}

// ── Projetos em Andamento (implantação Waipe) ───────────────────────────────

const MAX_AGENTES = 20;
const ETAPAS_VALIDAS = new Set(['escopo', 'alinhamento', 'construcao', 'testes', 'entrega']);
// Vocabulario de status e fixo por espaco (ver nota em _lib/clickup.js) — so
// os 3 que fazem sentido pro fluxo de um projeto/agente ficam disponiveis aqui.
const STATUS_IMPLANTACAO_VALIDOS = new Set(['pendente', 'in progress', 'concluído']);

function sanearListaTexto(v, maxItens, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string').slice(0, maxItens).map((x) => texto(x, maxLen)).filter(Boolean);
}

function sanearListaIds(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string').slice(0, MAX_AGENTES).map((x) => texto(x, 60)).filter(Boolean);
}

function sanearChecks(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n >= 60) break;
    const chave = texto(k, 60);
    if (!chave) continue;
    out[chave] = !!val;
    n++;
  }
  return out;
}

const ISM_IDS_VALIDOS = new Set(ISM_OPCOES.map((i) => i.id));

/** Ids de ISM saneados contra a allowlist ISM_OPCOES — o resto é descartado, nunca 500. */
function sanearAssignees(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    const n = Number(id);
    if (ISM_IDS_VALIDOS.has(n) && !out.includes(n)) out.push(n);
    if (out.length >= 5) break;
  }
  return out;
}

/** Nomes de ISM a partir do array `assignees` que o ClickUp devolve na task. */
function nomesIsm(assignees) {
  if (!Array.isArray(assignees)) return [];
  const porId = new Map(ISM_OPCOES.map((i) => [i.id, i.nome]));
  return assignees.map((a) => porId.get(Number(a?.id))).filter(Boolean);
}

const DIAGNOSTICO_RESPOSTAS_VALIDAS = new Set(['sim', 'nao', 'andamento']);

/** Respostas do diagnóstico de viabilidade — só perguntas com resposta ou nota sobrevivem. */
function sanearDiagnostico(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n >= 20) break;
    const chave = texto(k, 40);
    if (!chave || !val || typeof val !== 'object') continue;
    const resposta = typeof val.resposta === 'string' && DIAGNOSTICO_RESPOSTAS_VALIDAS.has(val.resposta) ? val.resposta : '';
    const nota = texto(val.nota, 300);
    if (!resposta && !nota) continue;
    out[chave] = { resposta, nota };
    n++;
  }
  return out;
}

const VALIDACAO_STATUS_VALIDOS = new Set(['pendente', 'validado', 'adiado', 'cancelado']);

/** Status de validação do agente no alinhamento, com motivo (obrigatório só na prática, não aqui). */
function sanearValidacao(v) {
  if (!v || typeof v !== 'object') return null;
  const status = typeof v.status === 'string' && VALIDACAO_STATUS_VALIDOS.has(v.status) ? v.status : 'pendente';
  return { status, motivo: texto(v.motivo, 300) };
}

/** Um agente do backlog, saneado a partir do corpo enviado por criar-implantacao. */
function sanearAgente(a) {
  if (!a || typeof a !== 'object') return null;
  const nome = texto(a.nome, 120);
  if (!nome) return null;
  return {
    nome,
    frente: texto(a.frente, 120),
    frequencia: texto(a.frequencia, 120),
    canal: texto(a.canal, 120),
    publico: texto(a.publico, 200),
    entrega: sanearListaTexto(a.entrega, 20, 200),
    sistemas: sanearListaTexto(a.sistemas, 20, 80),
    prereq: sanearListaTexto(a.prereq, 20, 200),
  };
}

/** Descrição legível (pra quem abre a task direto no ClickUp) da estrutura do agente. */
function descricaoAgente(a) {
  const linhas = [
    a.frente ? `**Frente:** ${a.frente}` : null,
    a.frequencia || a.canal ? `**Frequência/Canal:** ${[a.frequencia, a.canal].filter(Boolean).join(' — ')}` : null,
    a.publico ? `**Público:** ${a.publico}` : null,
    a.sistemas.length ? `**Sistemas:** ${a.sistemas.join(', ')}` : null,
    a.entrega.length ? `**Entrega:**\n${a.entrega.map((e) => `- ${e}`).join('\n')}` : null,
    a.prereq.length ? `**Pré-requisitos:**\n${a.prereq.map((e) => `- ${e}`).join('\n')}` : null,
  ].filter(Boolean);
  return linhas.join('\n\n');
}

/**
 * Resolve a task-pai (projeto) de um id que tanto pode ser o proprio projeto
 * quanto um agente (subtask) dele. `null` quando a task nao existe ou nao e
 * desta lista — usado por toda ação de escrita abaixo pra checar posse antes
 * de tocar em qualquer dado.
 */
async function resolverImplantacao(taskId) {
  const tarefa = await obterTask(taskId);
  if (!tarefa || String(tarefa.list?.id || '') !== LISTA_IMPLANTACOES_WAIPE) return null;
  if (!tarefa.parent) return { tarefa, projeto: tarefa };
  const projeto = await obterTask(String(tarefa.parent));
  if (!projeto) return null;
  return { tarefa, projeto };
}

async function listarImplantacoesAcao(res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const tasks = await listarImplantacoes();
  const linhas = tasks.map((t) => {
    const estado = parseWaipeState(t.description);
    return {
      id: t.id,
      cliente: t.name,
      status: t.status?.status || '',
      etapaAtual: ETAPAS_VALIDAS.has(estado.etapaAtual) ? estado.etapaAtual : 'escopo',
      csm: csmDaDescricaoImplantacao(t.description),
      ism: nomesIsm(t.assignees),
      agentesTotal: Number.isFinite(estado.agentesTotal) ? estado.agentesTotal : 0,
      agentesConcluidos: Array.isArray(estado.concluidos) ? estado.concluidos.length : 0,
    };
  });
  const visiveis = sessao.nivel === 'csm' ? linhas.filter((l) => pertenceAoCsm(l.csm, sessao.csm)) : linhas;
  return res.status(200).json({ tasks: visiveis, total: visiveis.length });
}

async function obterImplantacaoAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query?.id || '');
  if (!taskIdValido(id)) {
    return erro(res, 400, 'task_invalida', 'id inválido.');
  }

  const { pai, subtasks } = await obterTaskComSubtasks(id).catch((e) => {
    if (e instanceof ErroUpstream && (e.status === 404 || e.status === 400)) return { pai: null, subtasks: [] };
    throw e;
  });
  if (!pai || String(pai.list?.id || '') !== LISTA_IMPLANTACOES_WAIPE) {
    return erro(res, 404, 'nao_encontrado', 'Projeto não encontrado.');
  }

  const csm = csmDaDescricaoImplantacao(pai.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const estadoProjeto = parseWaipeState(pai.description);
  const agentes = subtasks
    .map((t) => {
      const e = parseWaipeState(t.description);
      return {
        id: t.id,
        nome: t.name,
        status: t.status?.status || '',
        dueDate: t.due_date || null,
        ism: nomesIsm(t.assignees),
        ismIds: sanearAssignees((t.assignees || []).map((a) => a.id)),
        estrutura: e.estrutura || {},
        buildChecks: e.buildChecks || {},
        testChecks: e.testChecks || {},
        entregaChecks: e.entregaChecks || {},
        prereqChecks: e.prereqChecks || {},
        diagnostico: e.diagnostico || {},
        validacao: e.validacao || { status: 'pendente', motivo: '' },
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  return res.status(200).json({
    projeto: {
      id: pai.id,
      cliente: pai.name,
      status: pai.status?.status || '',
      csm,
      ism: nomesIsm(pai.assignees),
      ismIds: sanearAssignees((pai.assignees || []).map((a) => a.id)),
      contexto: contextoSemEstado(pai.description),
      etapaAtual: ETAPAS_VALIDAS.has(estadoProjeto.etapaAtual) ? estadoProjeto.etapaAtual : 'escopo',
      prioridade: sanearListaIds(estadoProjeto.prioridade),
      agenteAtualId: typeof estadoProjeto.agenteAtualId === 'string' ? estadoProjeto.agenteAtualId : null,
      concluidos: sanearListaIds(estadoProjeto.concluidos),
    },
    agentes,
  });
}

/**
 * Cria o projeto (task-pai) e uma subtask por agente. So e chamada depois que
 * a pessoa revisou/editou o resultado da extração por IA na tela — a chamada
 * de IA em si roda no navegador (capability `sample`), nunca aqui.
 */
async function criarImplantacaoAcao(req, res, sessao) {
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

  const cliente = texto(corpo.cliente, 120);
  if (!cliente) {
    return erro(res, 400, 'cliente_invalido', 'Nome do cliente é obrigatório.');
  }
  const contexto = texto(corpo.contexto, 6000);

  const agentesRaw = Array.isArray(corpo.agentes) ? corpo.agentes.slice(0, MAX_AGENTES) : [];
  const agentes = agentesRaw
    .map((a) => ({ estrutura: sanearAgente(a), ism: sanearAssignees(a?.ism) }))
    .filter((a) => a.estrutura);
  if (!agentes.length) {
    return erro(res, 400, 'agentes_invalidos', 'É preciso ao menos um agente.');
  }
  const ismProjeto = sanearAssignees(corpo.ismProjeto);

  const csmNome = texto(sessao.nome, 120) || sessao.csm || sessao.nivel;
  const descricaoProjeto = stringifyWaipeState(
    [`**CSM:** ${csmNome}`, contexto].filter(Boolean).join('\n\n'),
    { etapaAtual: 'escopo', prioridade: [], agenteAtualId: null, concluidos: [], agentesTotal: agentes.length }
  );

  const projeto = await criarTaskImplantacao({
    name: `${cliente} — Implantação Waipe`,
    markdown_description: descricaoProjeto,
    assignees: ismProjeto,
  });

  for (const a of agentes) {
    const descricaoAgenteTask = stringifyWaipeState(descricaoAgente(a.estrutura), {
      estrutura: a.estrutura,
      buildChecks: {},
      testChecks: {},
      entregaChecks: {},
      prereqChecks: {},
      diagnostico: {},
      validacao: { status: 'pendente', motivo: '' },
    });
    await criarSubtaskAgente(projeto.id, {
      name: a.estrutura.nome,
      markdown_description: descricaoAgenteTask,
      assignees: a.ism,
    });
  }

  return res.status(200).json({ ok: true, id: projeto.id });
}

async function atualizarImplantacaoAcao(req, res, sessao) {
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

  if (!taskIdValido(corpo.id)) {
    return erro(res, 400, 'task_invalida', 'id inválido.');
  }
  if (!ETAPAS_VALIDAS.has(corpo.etapaAtual)) {
    return erro(res, 400, 'etapa_invalida', 'etapaAtual inválida.');
  }

  const resolvido = await resolverImplantacao(corpo.id);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Projeto não encontrado.');
  const { tarefa, projeto } = resolvido;

  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const estadoAtual = parseWaipeState(tarefa.description);
  const novoEstado = {
    etapaAtual: corpo.etapaAtual,
    prioridade: sanearListaIds(corpo.prioridade),
    agenteAtualId: typeof corpo.agenteAtualId === 'string' ? texto(corpo.agenteAtualId, 60) : null,
    concluidos: sanearListaIds(corpo.concluidos),
    agentesTotal: Number.isFinite(estadoAtual.agentesTotal) ? estadoAtual.agentesTotal : 0,
  };

  const payload = { markdown_description: stringifyWaipeState(tarefa.description, novoEstado) };
  if (typeof corpo.status === 'string' && STATUS_IMPLANTACAO_VALIDOS.has(corpo.status)) {
    payload.status = corpo.status;
  }
  if (Array.isArray(corpo.ism)) {
    payload.assignees = sanearAssignees(corpo.ism);
  }

  await atualizarTask(corpo.id, payload);
  return res.status(200).json({ ok: true });
}

async function atualizarAgenteAcao(req, res, sessao) {
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

  if (!taskIdValido(corpo.taskId)) {
    return erro(res, 400, 'task_invalida', 'taskId inválido.');
  }

  const resolvido = await resolverImplantacao(corpo.taskId);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Agente não encontrado.');
  const { tarefa, projeto } = resolvido;

  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const estadoAtual = parseWaipeState(tarefa.description);
  const novoEstado = {
    estrutura: sanearAgente(corpo.estrutura) || estadoAtual.estrutura || {},
    buildChecks: sanearChecks(corpo.buildChecks) ?? (estadoAtual.buildChecks || {}),
    testChecks: sanearChecks(corpo.testChecks) ?? (estadoAtual.testChecks || {}),
    entregaChecks: sanearChecks(corpo.entregaChecks) ?? (estadoAtual.entregaChecks || {}),
    prereqChecks: sanearChecks(corpo.prereqChecks) ?? (estadoAtual.prereqChecks || {}),
    diagnostico: sanearDiagnostico(corpo.diagnostico) ?? (estadoAtual.diagnostico || {}),
    validacao: sanearValidacao(corpo.validacao) ?? (estadoAtual.validacao || { status: 'pendente', motivo: '' }),
  };

  const payload = { markdown_description: stringifyWaipeState(tarefa.description, novoEstado) };
  if (typeof corpo.status === 'string' && STATUS_IMPLANTACAO_VALIDOS.has(corpo.status)) {
    payload.status = corpo.status;
  }
  if (corpo.dueDate === null) {
    payload.due_date = null;
  } else if (typeof corpo.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(corpo.dueDate)) {
    payload.due_date = Date.parse(`${corpo.dueDate}T12:00:00-03:00`);
  }
  if (Array.isArray(corpo.ism)) {
    payload.assignees = sanearAssignees(corpo.ism);
  }

  await atualizarTask(corpo.taskId, payload);
  return res.status(200).json({ ok: true });
}

async function listarComentariosAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const taskId = String(req.query?.taskId || '');
  if (!taskIdValido(taskId)) {
    return erro(res, 400, 'task_invalida', 'taskId inválido.');
  }

  const resolvido = await resolverImplantacao(taskId);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Tarefa não encontrada.');
  const csm = csmDaDescricaoImplantacao(resolvido.projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const comentarios = await listarComentarios(taskId);
  const mapeados = comentarios.map((c) => ({
    id: c.id,
    texto: c.comment_text || '',
    autor: c.user?.username || '',
    data: c.date || null,
  }));
  return res.status(200).json({ comentarios: mapeados });
}

async function comentarImplantacaoAcao(req, res, sessao) {
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

  if (!taskIdValido(corpo.taskId)) {
    return erro(res, 400, 'task_invalida', 'taskId inválido.');
  }
  const comentario = texto(corpo.texto, 2000);
  if (!comentario) {
    return erro(res, 400, 'texto_invalido', 'Comentário vazio.');
  }

  const resolvido = await resolverImplantacao(corpo.taskId);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Tarefa não encontrada.');
  const csm = csmDaDescricaoImplantacao(resolvido.projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  await criarComentario(corpo.taskId, comentario);
  return res.status(200).json({ ok: true });
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
