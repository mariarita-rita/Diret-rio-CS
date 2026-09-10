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
//   POST /api/clickup?action=comentar-implantacao  { taskId, texto, imagem? }
//        -> `imagem` ({nomeArquivo, mimeType, base64}) e opcional: um print
//        colado no comentario sobe primeiro como anexo, e a URL entra no
//        texto do comentario (o ClickUp nao aceita imagem embutida direto
//        no corpo do comentario pela API)
//   GET  /api/clickup?action=listar-comentarios    { taskId }
//   POST /api/clickup?action=anexar-arquivo-implantacao { id, nomeArquivo,
//        mimeType, base64 } -> anexa um arquivo a um projeto ou subtask
//        (agente/solucao); { imagem/pdf/office/csv/texto, ate 4MB }
//   POST /api/clickup?action=salvar-proposta-implantacao      cria/atualiza task
//        na etapa "proposta" (o simulador Waipe salva o que foi proposto e o
//        CSM reabre dias depois pra editar o que o cliente fechou)
//   POST /api/clickup?action=confirmar-fechamento-implantacao { id } -> promove
//        a proposta a projeto de implantacao de verdade (cria as subtasks)
//   GET  /api/clickup?action=listar-reservas       lista 901329017742 (agenda dos ISMs)
//   POST /api/clickup?action=criar-reserva         { projetoId?, titulo, ismId, inicio, fim }
//        -> 409 'conflito_horario' se o ISM ja tiver reserva nesse intervalo
//   POST /api/clickup?action=atualizar-reserva     { id, linkReuniao } — cola o
//        link do Meet depois que a reuniao foi criada (a API do ClickUp nao gera isso)
//   POST /api/clickup?action=cancelar-reserva      { id } -> libera o horario
//   GET  /api/clickup?action=conectar-agenda-google { ismId } -> 302 pro
//        consentimento OAuth do Google (volta em api/google-oauth-callback.js)
//   GET  /api/clickup?action=status-google-agenda  { [ismId]: conectado? }
//   POST /api/clickup?action=iniciar-conversa-umbler { id, mensagem? } -> cria
//        o contato + abre a conversa no Umbler Talk pro telefone do cliente
//        desse projeto; com `mensagem`, manda ela tambem (texto livre — os
//        canais desta org sao "Broker", nao a Cloud API oficial da Meta)
//   POST /api/clickup?action=sincronizar-agendamentos-google -> varre a agenda
//        de cada ISM conectado atras de reservas feitas pelo cliente numa
//        pagina de agendamento do Google; casa por CNPJ (cria a reserva
//        sozinho) ou devolve em `naoVinculados` pra confirmar na tela
//   POST /api/clickup?action=vincular-agendamento-google { projetoId, ismId,
//        googleEventId, titulo, inicio, fim, linkReuniao? } -> vincula
//        manualmente um item de `naoVinculados` a um projeto
//   GET  /api/clickup?action=historico-conversa-umbler { id } -> conversa
//        recente no Umbler Talk pro telefone desse projeto (so leitura, nao
//        cria contato/conversa — ver iniciar-conversa-umbler pra isso)
//   POST /api/clickup?action=marcar-conversa-vista { id } -> marca "eu ja vi"
//        (por identidade — sessao.nome) pro indicador de mensagem nova, que
//        e aceso por api/umbler-webhook.js quando o cliente responde
//   GET  /api/clickup?action=listar-modelos-mensagem -> modelos salvos de
//        mensagem de abertura, compartilhados entre todo o time
//   POST /api/clickup?action=salvar-modelo-mensagem { nome, texto } -> salva
//        um modelo novo
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
  anexarArquivoTask,
  atualizarTask,
  CAMPOS_ESCRITA,
  cnpjDoAgendamentoGoogle,
  contextoSemEstado,
  criarComentario,
  criarModeloMensagem,
  criarReserva,
  criarSubtaskAgente,
  criarTaskImplantacao,
  criarTaskPropostaWaipe,
  csmDaDescricaoImplantacao,
  EQUIPE_OPCAO,
  ErroConfigClickUp,
  ErroUpstream,
  excluirTask,
  getCarteira,
  getMetas,
  googleEventIdDaDescricaoReserva,
  gravarCampo,
  ISM_OPCOES,
  lerClienteFresco,
  limparCampo,
  linkDaDescricaoReserva,
  LISTA_IMPLANTACOES_WAIPE,
  LISTA_RESERVAS_AGENDA,
  listarComentarios,
  listarImplantacoes,
  listarModelosMensagem,
  listarReservas,
  listarTokensGoogle,
  localizarTask,
  obterTask,
  obterTaskComSubtasks,
  obterTokenGoogle,
  parseWaipeState,
  projetoDaDescricaoReserva,
  refletirEscrita,
  soDigitos,
  STATUS_MES_ATUAL,
  stringifyWaipeState,
} from './_lib/clickup.js';
import { urlAutorizacaoGoogle, renovarAccessToken, consultarFreeBusy, criarEventoComMeet, listarEventos, ErroGoogle, ErroConfigGoogle } from './_lib/google.js';
import { telefoneParaE164, garantirContato, garantirConversa, enviarMensagem, buscarHistoricoConversa, ErroUmbler, ErroConfigUmbler } from './_lib/umbler.js';

// Leitura: 300s de frescor / 600s de revalidacao, mas em cache PRIVADO.
// A resposta varia por sessao (filtro por CSM), portanto nao pode ir para o
// cache compartilhado da CDN — ver nota no README.
const CACHE_LEITURA = 'private, max-age=300, stale-while-revalidate=600';

const MAX_LABELS = 10;

// Anexos (projeto/agente/solução e print colado em comentário) — allowlist de
// tipo por MIME, nunca por extensão do nome (o nome é só rótulo). Teto de
// tamanho é sobre o arquivo CRU; o corpo da requisição em si (base64 + JSON)
// precisa de um teto maior, por isso o `limiteBytes` custom passado a
// `lerCorpo` nas duas ações que aceitam arquivo.
const MIME_ANEXOS_VALIDOS = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
]);
const MAX_ANEXO_BYTES = 4 * 1024 * 1024;
const LIMITE_CORPO_ANEXO = 6 * 1024 * 1024;
const RE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Anexo (arquivo ou print) saneado a partir do corpo — nunca confia no que vem sem checar tipo/tamanho antes de gastar uma chamada de upload no ClickUp. */
function lerArquivoAnexo(corpo) {
  const nomeArquivo = texto(corpo?.nomeArquivo, 150);
  const mimeType = typeof corpo?.mimeType === 'string' ? corpo.mimeType.trim().toLowerCase() : '';
  const base64 = typeof corpo?.base64 === 'string' ? corpo.base64.trim() : '';
  if (!nomeArquivo || !mimeType || !base64) return { erro: 'Arquivo, nome e tipo são obrigatórios.' };
  if (!MIME_ANEXOS_VALIDOS.has(mimeType)) return { erro: 'Tipo de arquivo não permitido.' };
  if (!RE_BASE64.test(base64)) return { erro: 'Arquivo corrompido.' };
  const bytesAprox = Math.floor((base64.length * 3) / 4);
  if (bytesAprox > MAX_ANEXO_BYTES) return { erro: 'Arquivo muito grande (máximo 4 MB).' };
  return { nomeArquivo, mimeType, base64 };
}

/** Anexos nativos do ClickUp (o próprio GET de task já devolve), reduzidos ao que a tela precisa mostrar. */
function mapearAnexos(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .slice(0, 30)
    .map((a) => ({ id: a.id, nome: texto(a.title, 150) || 'arquivo', url: a.url || a.url_w_query || '', extensao: texto(a.extension, 10) }))
    .filter((a) => a.url);
}

// Nivel "ism" nao acessa dados financeiros (carteira/metas/cliente/set-field/
// log-proposta, que e o log de propostas ligado a carteira) nem o pipeline de
// proposta de implantacao (criar/salvar-proposta/confirmar-fechamento — isso
// e trabalho de CSM/gestao; o ISM so entra depois, quando o projeto ja existe).
const ACOES_PROIBIDAS_ISM = new Set([
  'carteira', 'metas', 'cliente', 'set-field', 'log-proposta',
  'criar-implantacao', 'salvar-proposta-implantacao', 'confirmar-fechamento-implantacao',
]);

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

    // Nivel "ism" e so implantacao: nada de carteira/metas/cliente (dados
    // financeiros) nem do pipeline de proposta (isso e trabalho de CSM/gestao).
    // Bloqueado aqui, ANTES de rotear pra funcao — nao depende de cada acao
    // lembrar de checar sozinha.
    if (sessao.nivel === 'ism' && ACOES_PROIBIDAS_ISM.has(acao)) {
      return erro(res, 403, 'nivel_nao_permitido', 'Este perfil não tem acesso a esta ação.');
    }

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
    if (req.method === 'POST' && acao === 'anexar-arquivo-implantacao') {
      return await anexarArquivoImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'salvar-proposta-implantacao') {
      return await salvarPropostaImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'confirmar-fechamento-implantacao') {
      return await confirmarFechamentoImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'GET' && acao === 'listar-reservas') return await listarReservasAcao(res, sessao);
    if (req.method === 'POST' && acao === 'criar-reserva') return await criarReservaAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'atualizar-reserva') return await atualizarReservaAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'cancelar-reserva') return await cancelarReservaAcao(req, res, sessao);
    if (req.method === 'GET' && acao === 'conectar-agenda-google') return await conectarAgendaGoogleAcao(req, res, sessao);
    if (req.method === 'GET' && acao === 'status-google-agenda') return await statusGoogleAgendaAcao(res);
    if (req.method === 'POST' && acao === 'iniciar-conversa-umbler') {
      return await iniciarConversaUmblerAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'sincronizar-agendamentos-google') {
      return await sincronizarAgendamentosGoogleAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'vincular-agendamento-google') {
      return await vincularAgendamentoGoogleAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'marcar-conversa-vista') {
      return await marcarConversaVistaAcao(req, res, sessao);
    }
    if (req.method === 'GET' && acao === 'historico-conversa-umbler') {
      return await historicoConversaUmblerAcao(req, res, sessao);
    }
    if (req.method === 'GET' && acao === 'listar-modelos-mensagem') {
      return await listarModelosMensagemAcao(res, sessao);
    }
    if (req.method === 'POST' && acao === 'salvar-modelo-mensagem') {
      return await salvarModeloMensagemAcao(req, res, sessao);
    }

    const ACOES_VALIDAS = [
      'carteira', 'busca', 'metas', 'cliente', 'set-field', 'log-proposta',
      'listar-implantacoes', 'obter-implantacao', 'criar-implantacao',
      'atualizar-implantacao', 'atualizar-agente', 'comentar-implantacao',
      'listar-comentarios', 'anexar-arquivo-implantacao', 'salvar-proposta-implantacao',
      'confirmar-fechamento-implantacao', 'listar-reservas', 'criar-reserva',
      'atualizar-reserva', 'cancelar-reserva', 'conectar-agenda-google',
      'status-google-agenda', 'iniciar-conversa-umbler',
      'sincronizar-agendamentos-google', 'vincular-agendamento-google',
      'historico-conversa-umbler', 'listar-modelos-mensagem', 'salvar-modelo-mensagem',
      'marcar-conversa-vista',
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
  if (campo.tipo === 'texto') {
    if (typeof value === 'string' && value.length <= campo.max) return value;
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
const MAX_OUTRAS_SOLUCOES = 10;
// "proposta" e a etapa anterior a "escopo" — projeto ainda nao promovido,
// sem subtasks reais, so o que foi proposto guardado pra revisao do CSM.
const ETAPAS_VALIDAS = new Set(['proposta', 'escopo', 'alinhamento', 'construcao', 'testes', 'entrega']);
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

// ── Etapa "proposta" — o que foi proposto, antes do fechamento ─────────────
// Preço aqui é informativo (definido no simulador de proposta, nunca
// recalculado neste servidor) — mesmo príncipio de api/ia.js: nunca confiar
// cru no corpo, mas também nunca fingir que o servidor sabe o preço certo.

/** Inteiro dentro de uma faixa, ou o padrão se vier algo fora do esperado. */
function inteiroEntre(v, min, max, padrao) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return padrao;
  return n;
}

/** Número dentro de uma faixa, ou null se vier algo fora do esperado (sem inventar padrão). */
function numeroOuNulo(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

const PRODUTOS_SOLUCAO_VALIDOS = new Set(['Gestor', 'Simplaz Gestor', 'Simplaz Unique', 'Unique', 'BIME APP', 'Treinamento', 'Outro']);
const VARIANTES_SOLUCAO_VALIDAS = new Set(['Nuvem', 'Local']);
const POL_SOLUCAO_VALIDOS = new Set(['padrao', 'limite10', 'sem']);
const GOV_WAIPE_VALIDOS = new Set(['sim', 'nao']);
const AUTOMACAO_WAIPE_VALIDOS = new Set(['pronta', 'personalizada']);

// Fase de acompanhamento de um item da lista unificada (solucao fechada) —
// tag manual editada pelo CSM, independente do checklist. FASE_ITEM_PADRAO
// entra em todo item novo; "cancelado" nao conta como pendencia pro derivado
// do projeto (ver derivarFaseProjeto).
const FASES_ITEM_VALIDAS = new Set(['nao_iniciado', 'em_andamento', 'aguardando_cliente', 'aguardando_interno', 'cancelado', 'entregue']);
const FASE_ITEM_PADRAO = 'nao_iniciado';

/**
 * Fase do PROJETO como um todo: automatica (derivada das fases dos itens +
 * do estagio do Waipe), mas com override manual (faseProjetoManual) sempre
 * que o CSM quiser forcar um valor diferente do calculado.
 *
 * "aguardando_interno" NUNCA e o resultado automatico daqui — so chega nesse
 * valor se algum item foi manualmente marcado assim pelo ISM (ver
 * FASES_ITEM_VALIDAS/seletor de fase no front). O motivo: "aguardando
 * interno" significa um bloqueio tecnico real, dependente de outra equipe —
 * nao "tem trabalho em andamento". O fallback de "tem item mexido mas nada
 * concluido/bloqueado/esperando cliente" e "em_andamento", nao um alarme
 * falso de bloqueio.
 */
function derivarFaseProjeto(fases) {
  if (!fases.length) return FASE_ITEM_PADRAO;
  const relevantes = fases.filter((f) => f !== 'cancelado');
  if (relevantes.length && relevantes.every((f) => f === 'entregue')) return 'entregue';
  if (fases.some((f) => f === 'aguardando_cliente')) return 'aguardando_cliente';
  if (fases.some((f) => f === 'aguardando_interno')) return 'aguardando_interno';
  if (!relevantes.length || relevantes.every((f) => f === FASE_ITEM_PADRAO)) return FASE_ITEM_PADRAO;
  return 'em_andamento';
}

/** Fase do "item Waipe" (sintetico — nao e uma subtask propria) a partir da Camada 1 + progresso de entrega, pra entrar na derivacao acima. */
function faseWaipeDerivada(estadoProjeto, totalAgentes) {
  if (!totalAgentes) return null;
  const camada1Pronta = !!(estadoProjeto.camada1Checks && estadoProjeto.camada1Checks['0'] && estadoProjeto.camada1Checks['1']);
  if (!camada1Pronta) return FASE_ITEM_PADRAO;
  const concluidos = Array.isArray(estadoProjeto.concluidos) ? estadoProjeto.concluidos.length : 0;
  return concluidos >= totalAgentes ? 'entregue' : 'em_andamento';
}

// Jornada (checklist) por produto — passos concretos, documentados pelo
// time (nao mais o binario generico produtoSimples/requerImplantacao).
// null = ainda sem passo a passo definido (ex: "Outro", ou Gestor/Unique
// com troca de ambiente — o material chega depois, entao so sinaliza).
const JORNADA_TEMPLATES = {
  'BIME APP': ['Ativar usuários no workspace do cliente', 'Enviar e-mail com instruções de uso', 'Finalizar'],
  'Simplaz Gestor': ['Adicionar o plano no Núcleo', 'Configurar certificado digital (se ainda não enviado)', 'Enviar e-mail com instruções de uso', 'Finalizar'],
  'Simplaz Unique': ['Adicionar o plano no Núcleo', 'Configurar certificado digital (se ainda não enviado)', 'Enviar e-mail com instruções de uso', 'Finalizar'],
  'Treinamento': ['Agendar o treinamento', 'Confirmar participantes', 'Realizar o treinamento na data agendada'],
};

/** Gestor/Unique tem 2 fluxos: mesmo ambiente e so trocar o plano; troca de
 * ambiente (Local<->Nuvem) ainda nao tem passo a passo aqui. */
function jornadaPara(produto, ambienteMuda) {
  if (produto === 'Gestor' || produto === 'Unique') return ambienteMuda ? null : ['Alterar o plano no Núcleo'];
  return JORNADA_TEMPLATES[produto] || null;
}

/** Um agente proposto (pré-alinhamento) — só nome/frente/entrega; o resto da estrutura se preenche no Alinhamento, como já acontece hoje. */
function sanearAgenteProposto(a) {
  if (!a || typeof a !== 'object') return null;
  const nome = texto(a.nome, 120);
  if (!nome) return null;
  return { nome, frente: texto(a.frente, 120), entrega: sanearListaTexto(a.entrega, 20, 200) };
}

/** Uma "outra solução" (Gestor/Simplaz/Unique/BIME APP/Treinamento/Outro) proposta pelo simulador. */
function sanearOutraSolucao(o) {
  if (!o || typeof o !== 'object') return null;
  const produto = typeof o.produto === 'string' && PRODUTOS_SOLUCAO_VALIDOS.has(o.produto) ? o.produto : null;
  if (!produto) return null;
  return {
    produto,
    planoSugerido: texto(o.planoSugerido, 80),
    variante: typeof o.variante === 'string' && VARIANTES_SOLUCAO_VALIDAS.has(o.variante) ? o.variante : null,
    motivo: texto(o.motivo, 400),
    observacoes: texto(o.observacoes, 500),
    ambienteMuda: !!o.ambienteMuda,
    quantidade: inteiroEntre(o.quantidade, 1, 500, 1),
    valorTabela: numeroOuNulo(o.valorTabela, 0, 999999),
    valorManual: numeroOuNulo(o.valorManual, 0, 999999) ?? 0,
    pol: typeof o.pol === 'string' && POL_SOLUCAO_VALIDOS.has(o.pol) ? o.pol : null,
    descontoPercent: numeroOuNulo(o.descontoPercent, 0, 100) ?? 0,
    incluir: !!o.incluir,
  };
}

/** Diagnóstico Waipe calculado no simulador (mesma faixa de valores de api/ia.js), mais o plano/valor já calculados — nunca recalculado aqui. */
function sanearDiagnosticoWaipeProposto(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    usuarios: inteiroEntre(d.usuarios, 1, 500, 1),
    empresas: inteiroEntre(d.empresas, 1, 500, 1),
    governanca: typeof d.governanca === 'string' && GOV_WAIPE_VALIDOS.has(d.governanca) ? d.governanca : 'nao',
    auditoria: typeof d.auditoria === 'string' && GOV_WAIPE_VALIDOS.has(d.auditoria) ? d.auditoria : 'nao',
    automacao: typeof d.automacao === 'string' && AUTOMACAO_WAIPE_VALIDOS.has(d.automacao) ? d.automacao : 'pronta',
    enterprisePorVolume: typeof d.enterprisePorVolume === 'string' && GOV_WAIPE_VALIDOS.has(d.enterprisePorVolume) ? d.enterprisePorVolume : 'nao',
    plano: texto(d.plano, 40),
    motivo: texto(d.motivo, 400),
    valorMensal: numeroOuNulo(d.valorMensal, 0, 999999),
  };
}

// Ids duplicados de proposito do catalogo client-side (waipe-diagnostico.html,
// CATALOGO_SECOES_PROPOSTA) e do servidor de IA (api/ia.js,
// IDS_SECOES_PROPOSTA_VALIDAS) — mesmo espirito de resolverImplantacao
// duplicado entre api/clickup.js e api/ia.js: função/constante pequena, não
// vale acoplar os arquivos só por isso.
const IDS_SECOES_PROPOSTA_VALIDAS = new Set([
  'abertura_narrativa',
  'custo_do_problema',
  'tempo_devolvido_agentes',
  'cenarios_comparativos',
]);

/** Mapa id->bool das seções de análise detalhada marcadas pelo CSM — só ids conhecidos sobrevivem. */
function sanearSecoesPropostaSelecionadas(d) {
  const origem = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  const out = {};
  for (const id of Object.keys(origem)) {
    if (IDS_SECOES_PROPOSTA_VALIDAS.has(id)) out[id] = !!origem[id];
  }
  return out;
}

/** Uma seção de análise detalhada já gerada pela IA (e possivelmente editada pelo CSM). */
function sanearSecaoPropostaGerada(s) {
  if (!s || typeof s !== 'object') return null;
  const id = typeof s.id === 'string' ? s.id : '';
  if (!IDS_SECOES_PROPOSTA_VALIDAS.has(id)) return null;
  return { id, titulo: texto(s.titulo, 150), html: texto(s.html, 6000) };
}

/** ID Núcleo/CNPJ/e-mail/telefone do cliente, saneados — sempre string (nunca null),
 * pra poder ir direto no bloco de estado sem checagem extra em cada call site. */
function sanearDadosCliente(d) {
  const origem = d && typeof d === 'object' ? d : {};
  return {
    idNucleo: texto(origem.idNucleo, 60),
    cnpj: texto(origem.cnpj, 20),
    email: texto(origem.email, 200),
    telefone: texto(origem.telefone, 30),
  };
}

/**
 * Opcionais enquanto é só rascunho de proposta — viram obrigatórios na hora
 * de confirmar o fechamento (ou de criar o projeto direto, sem passar pela
 * proposta), porque o ID Núcleo é o campo que amarra a identificação do
 * cliente entre as ferramentas depois.
 */
function dadosClienteFaltando(dados) {
  const faltando = [];
  if (!dados.idNucleo) faltando.push('ID Núcleo');
  if (!dados.cnpj) faltando.push('CNPJ');
  if (!dados.email) faltando.push('E-mail');
  if (!dados.telefone) faltando.push('Telefone');
  return faltando;
}

/**
 * "Mensagem nova" e por VIEWER, nao um estado global do projeto — cada
 * identidade (sessao.nome: "Gestão", "Bruno Vaz", "Gian Luca"...) tem seu
 * proprio ponteiro de "ate quando eu ja vi" (vistoPor), gravado por
 * marcar-conversa-vista. `ultimaMensagemClienteEm` (gravado pelo webhook do
 * Umbler Talk, ver api/umbler-webhook.js) e o UNICO estado compartilhado.
 */
function temMensagemNovaParaViewer(estado, sessao) {
  const ultima = Number(estado.ultimaMensagemClienteEm);
  if (!Number.isFinite(ultima) || ultima <= 0) return false;
  const visto = Number(estado.vistoPor?.[sessao.nome]);
  return !Number.isFinite(visto) || ultima > visto;
}

const RISCO_VALIDOS = new Set(['baixo', 'medio', 'alto']);
const SATISFACAO_VALIDOS = new Set(['positiva', 'neutra', 'negativa', 'indeterminada']);

/**
 * Relatório de finalização — rascunho gerado pela IA (ver api/ia.js,
 * action=gerar-relatorio-finalizacao) e revisado manualmente antes de salvar.
 * Nunca confia no formato de quem manda: cada campo é saneado com um padrão
 * seguro, igual ao resto do estado embutido.
 */
function sanearFinalizacao(d) {
  const origem = d && typeof d === 'object' ? d : {};
  return {
    resumoGeral: texto(origem.resumoGeral, 2000),
    riscoPercebido: RISCO_VALIDOS.has(origem.riscoPercebido) ? origem.riscoPercebido : '',
    causaDaDemora: texto(origem.causaDaDemora, 500),
    satisfacaoPercebida: SATISFACAO_VALIDOS.has(origem.satisfacaoPercebida) ? origem.satisfacaoPercebida : '',
    geradoEm: Number.isFinite(Number(origem.geradoEm)) ? Number(origem.geradoEm) : null,
  };
}

/** Descrição legível de uma "outra solução" (pra quem abre a subtask direto no ClickUp). */
function descricaoSolucao(o) {
  const valor = o.valorTabela != null ? o.valorTabela : o.valorManual;
  const linhas = [
    `**Produto:** ${o.produto}${o.planoSugerido ? ' — ' + o.planoSugerido : ''}${o.variante ? ' (' + o.variante + ')' : ''}`,
    o.motivo ? `**Como ajuda o cliente:** ${o.motivo}` : null,
    `**Quantidade:** ${o.quantidade}`,
    `**Valor unitário:** R$ ${valor.toFixed(2)}`,
    o.descontoPercent ? `**Desconto:** ${o.descontoPercent}%` : null,
    o.observacoes ? `**Observações para a implantação:** ${o.observacoes}` : null,
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
      ismIds: sanearAssignees((t.assignees || []).map((a) => a.id)),
      // Antes de promovida (etapa "proposta"), ainda não existem subtasks —
      // conta o que foi proposto pra lista não mostrar "0 itens".
      agentesTotal: Number.isFinite(estado.agentesTotal)
        ? estado.agentesTotal
        : (estado.agentesPropostos?.length || 0) + (estado.outrasSolucoesPropostas?.length || 0),
      agentesConcluidos: Array.isArray(estado.concluidos) ? estado.concluidos.length : 0,
      // Fase manual do projeto, se o CSM já tiver definido uma — a lista não
      // busca subtasks (custaria 1 chamada por projeto), então só reflete o
      // override manual aqui; a fase derivada dos itens só existe na tela
      // do projeto aberto (obter-implantacao), que já busca as subtasks.
      faseProjetoManual: FASES_ITEM_VALIDAS.has(estado.faseProjetoManual) ? estado.faseProjetoManual : null,
      dataCriacao: Number.isFinite(Number(t.date_created)) ? Number(t.date_created) : null,
      temMensagemNova: temMensagemNovaParaViewer(estado, sessao),
    };
  });
  // "ism" ve tudo igual "gestao" dentro de implantacao — a unica diferenca
  // de nivel fica nos dados financeiros (carteira/metas/cliente), nunca aqui.
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
      if (e.tipo === 'solucao') {
        const produto = texto(e.produto, 40);
        const ambienteMuda = !!e.ambienteMuda;
        // Itens fechados antes da jornada por produto existir (ou com o
        // template ainda não definido na época) ficaram com checklist nulo
        // gravado; recalcula pelo template atual em vez de repetir pra
        // sempre um aviso de "a detalhar" que já não é verdade.
        const checklist = Array.isArray(e.checklist)
          ? sanearListaTexto(e.checklist, 20, 200)
          : jornadaPara(produto, ambienteMuda);
        return {
          id: t.id,
          tipo: 'solucao',
          nome: t.name,
          status: t.status?.status || '',
          produto,
          planoSugerido: texto(e.planoSugerido, 80),
          variante: VARIANTES_SOLUCAO_VALIDAS.has(e.variante) ? e.variante : null,
          motivo: texto(e.motivo, 400),
          observacoes: texto(e.observacoes, 500),
          ambienteMuda,
          quantidade: Number.isFinite(e.quantidade) ? e.quantidade : 1,
          valorTabela: Number.isFinite(e.valorTabela) ? e.valorTabela : null,
          valorManual: Number.isFinite(e.valorManual) ? e.valorManual : 0,
          descontoPercent: Number.isFinite(e.descontoPercent) ? e.descontoPercent : 0,
          checklist,
          checklistChecks: sanearChecks(e.checklistChecks) || {},
          fase: FASES_ITEM_VALIDAS.has(e.fase) ? e.fase : FASE_ITEM_PADRAO,
          anexos: mapearAnexos(t.attachments),
        };
      }
      return {
        id: t.id,
        tipo: 'agente',
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
        anexos: mapearAnexos(t.attachments),
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  // Fase do projeto: automatica (itens da lista unificada + estagio do
  // Waipe), com override manual quando o CSM define um valor explicito.
  const totalAgentesWaipe = agentes.filter((a) => a.tipo === 'agente').length;
  const fasesItens = agentes.filter((a) => a.tipo === 'solucao').map((a) => a.fase);
  const faseWaipe = faseWaipeDerivada(estadoProjeto, totalAgentesWaipe);
  if (faseWaipe) fasesItens.push(faseWaipe);
  const faseProjetoManual = FASES_ITEM_VALIDAS.has(estadoProjeto.faseProjetoManual) ? estadoProjeto.faseProjetoManual : null;

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
      camada1Checks: sanearChecks(estadoProjeto.camada1Checks) || {},
      // Fase sintética do "item Waipe" (não é uma subtask própria — deriva de
      // camada1Checks + progresso de entrega) pra mostrar a mesma etiqueta
      // usada nas soluções também na lista unificada.
      faseWaipe,
      faseProjetoManual,
      faseProjetoDerivada: derivarFaseProjeto(fasesItens),
      // Só relevante enquanto etapaAtual === "proposta" (ou como histórico do
      // que foi proposto, depois de promovido) — arrays vazios/null nos
      // demais casos.
      agentesPropostos: Array.isArray(estadoProjeto.agentesPropostos)
        ? estadoProjeto.agentesPropostos.map(sanearAgenteProposto).filter(Boolean)
        : [],
      outrasSolucoesPropostas: Array.isArray(estadoProjeto.outrasSolucoesPropostas)
        ? estadoProjeto.outrasSolucoesPropostas.map(sanearOutraSolucao).filter(Boolean)
        : [],
      diagnosticoWaipe: sanearDiagnosticoWaipeProposto(estadoProjeto.diagnosticoWaipe) || null,
      secoesPropostaSelecionadas: sanearSecoesPropostaSelecionadas(estadoProjeto.secoesPropostaSelecionadas),
      secoesPropostaGeradas: Array.isArray(estadoProjeto.secoesPropostaGeradas)
        ? estadoProjeto.secoesPropostaGeradas.map(sanearSecaoPropostaGerada).filter(Boolean)
        : [],
      // Identificação do cliente (ID Núcleo é o campo que amarra as
      // conexões entre ferramentas) — opcional até a proposta ser
      // confirmada, obrigatório a partir dali (ver confirmarFechamentoImplantacaoAcao).
      idNucleo: texto(estadoProjeto.idNucleo, 60),
      cnpj: texto(estadoProjeto.cnpj, 20),
      email: texto(estadoProjeto.email, 200),
      telefone: texto(estadoProjeto.telefone, 30),
      finalizacao: sanearFinalizacao(estadoProjeto.finalizacao),
      temMensagemNova: temMensagemNovaParaViewer(estadoProjeto, sessao),
      anexos: mapearAnexos(pai.attachments),
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

  // Criação direta (sem passar pela proposta) já é "virar projeto de
  // implantação de verdade" — os 4 campos são obrigatórios aqui, mesmo
  // padrão de confirmar-fechamento-implantacao.
  const dadosCliente = sanearDadosCliente(corpo);
  const faltando = dadosClienteFaltando(dadosCliente);
  if (faltando.length) {
    return erro(res, 400, 'dados_cliente_incompletos', `Preencha antes de criar o projeto: ${faltando.join(', ')}.`);
  }

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
    { etapaAtual: 'escopo', prioridade: [], agenteAtualId: null, concluidos: [], agentesTotal: agentes.length, ...dadosCliente }
  );

  const projeto = await criarTaskImplantacao({
    name: `${cliente} — Implantação Waipe`,
    markdown_description: descricaoProjeto,
    assignees: ismProjeto,
  });

  for (const a of agentes) {
    const descricaoAgenteTask = stringifyWaipeState(descricaoAgente(a.estrutura), {
      tipo: 'agente',
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
    // Camada 1 (Núcleo + usuários liberados) só existe quando o projeto tem
    // agentes Waipe reais — mesmo padrão de sanearChecks já usado no agente.
    camada1Checks: sanearChecks(corpo.camada1Checks) ?? (estadoAtual.camada1Checks || {}),
    // Histórico do que foi proposto (só existe em projetos que passaram pela
    // etapa "proposta") — precisa ser preservado aqui, senão qualquer
    // atualizar-implantacao normal do dia a dia apaga esse registro.
    agentesPropostos: estadoAtual.agentesPropostos || [],
    outrasSolucoesPropostas: estadoAtual.outrasSolucoesPropostas || [],
    diagnosticoWaipe: estadoAtual.diagnosticoWaipe || null,
    // Override manual da fase do projeto — só muda quando o campo vem no
    // corpo (mesmo se vier null/inválido, o que significa "voltar a
    // automático"); se nem vier, preserva o que já estava gravado, senão
    // qualquer atualizar-implantacao do dia a dia (camada1Checks etc.) apaga.
    faseProjetoManual: 'faseProjetoManual' in corpo
      ? (FASES_ITEM_VALIDAS.has(corpo.faseProjetoManual) ? corpo.faseProjetoManual : null)
      : (FASES_ITEM_VALIDAS.has(estadoAtual.faseProjetoManual) ? estadoAtual.faseProjetoManual : null),
    // Dados de identificação do cliente — só muda quando vem no corpo (edição
    // vinda do "Resumo do projeto"), senão preserva o que já estava gravado,
    // mesmo padrão de faseProjetoManual logo acima.
    ...(('idNucleo' in corpo || 'cnpj' in corpo || 'email' in corpo || 'telefone' in corpo)
      ? sanearDadosCliente(corpo)
      : sanearDadosCliente(estadoAtual)),
    // Relatório de finalização — mesmo padrão de faseProjetoManual/dadosCliente:
    // só muda quando vem explicitamente no corpo (edição feita na tela de
    // finalização), senão preserva o que já estava salvo.
    finalizacao: 'finalizacao' in corpo
      ? sanearFinalizacao(corpo.finalizacao)
      : sanearFinalizacao(estadoAtual.finalizacao),
  };

  const payload = { markdown_description: stringifyWaipeState(tarefa.description, novoEstado) };
  if (typeof corpo.status === 'string' && STATUS_IMPLANTACAO_VALIDOS.has(corpo.status)) {
    payload.status = corpo.status;
  } else if (projeto.status?.status === 'pendente') {
    // O status nativo do ClickUp nunca era tocado por aqui — ficava preso em
    // "pendente" pra sempre, mesmo com etapa/camada1/prioridade avançando.
    // Qualquer chamada aqui já significa que alguém começou a mexer no
    // projeto: sobe pra "in progress" sozinho, sem exigir um clique manual
    // só pra isso (só na primeira vez — não sobrescreve outros status como
    // "agendado"/"concluído" já setados manualmente).
    payload.status = 'in progress';
  }
  if (Array.isArray(corpo.ism)) {
    payload.assignees = sanearAssignees(corpo.ism);
  }

  await atualizarTask(corpo.id, payload);
  return res.status(200).json({ ok: true });
}

async function iniciarConversaUmblerAcao(req, res, sessao) {
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

  const resolvido = await resolverImplantacao(corpo.id);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Projeto não encontrado.');
  const { projeto } = resolvido;

  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const estado = parseWaipeState(projeto.description);
  const telefoneE164 = telefoneParaE164(estado.telefone);
  if (!telefoneE164) {
    return erro(res, 400, 'telefone_invalido', 'Cadastre um telefone válido do cliente (Resumo do projeto) antes de iniciar a conversa.');
  }

  const contactId = await garantirContato(telefoneE164, projeto.name);
  if (!contactId) return erro(res, 502, 'erro_umbler', 'Umbler Talk não devolveu o contato criado.');
  const conversa = await garantirConversa(contactId);
  if (!conversa) return erro(res, 502, 'erro_umbler', 'Umbler Talk não devolveu a conversa criada.');

  // Mensagem de abertura e opcional (o CSM pode limpar o campo antes de
  // enviar) — se a Umbler Talk falhar em mandar, isso NAO derruba a resposta:
  // contato e conversa ja foram criados de verdade, entao devolve ok:true
  // mesmo assim, so avisando que a mensagem em si nao saiu.
  const mensagem = texto(corpo.mensagem, 4096);
  let mensagemEnviada = false;
  let mensagemErro = null;
  if (mensagem) {
    try {
      await enviarMensagem(conversa.id, mensagem);
      mensagemEnviada = true;
    } catch (e) {
      if (!(e instanceof ErroUmbler)) throw e;
      mensagemErro = 'Não deu para mandar a mensagem — a conversa foi criada, mas escreva por lá manualmente.';
    }
  }

  return res.status(200).json({
    ok: true,
    contactId,
    chatId: conversa.id,
    telefone: telefoneE164,
    chatNovo: conversa.criadaAgora,
    setor: conversa.setor,
    mensagemEnviada,
    mensagemErro,
  });
}

/**
 * So LEITURA — nao cria contato nem conversa (diferente de iniciar-conversa-umbler).
 * Devolve o historico recente pro bloco "Conversa no Utalk" no projeto, pra
 * quem for mandar mensagem ver primeiro se ja teve contato recente.
 */
async function historicoConversaUmblerAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query?.id || '');
  if (!taskIdValido(id)) {
    return erro(res, 400, 'task_invalida', 'id inválido.');
  }

  const resolvido = await resolverImplantacao(id);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Projeto não encontrado.');
  const { projeto } = resolvido;

  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const estado = parseWaipeState(projeto.description);
  const telefoneE164 = telefoneParaE164(estado.telefone);
  if (!telefoneE164) {
    return res.status(200).json({ ok: true, semTelefone: true });
  }

  const historico = await buscarHistoricoConversa(telefoneE164);
  if (!historico) {
    return res.status(200).json({ ok: true, semConversa: true });
  }
  return res.status(200).json({ ok: true, ...historico });
}

/**
 * Marca "eu já vi a conversa" pra ESTA identidade (sessao.nome) — cada
 * pessoa/perfil tem seu proprio ponteiro (vistoPor), então um CSM abrindo o
 * projeto não desmarca o indicador do ISM, e vice-versa (ver
 * temMensagemNovaParaViewer). Não precisa de podeEscrever tão restrito quanto
 * outras escritas, mas segue o mesmo padrão do resto do arquivo.
 */
async function marcarConversaVistaAcao(req, res, sessao) {
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
  if (!taskIdValido(corpo.id)) return erro(res, 400, 'task_invalida', 'id inválido.');

  const resolvido = await resolverImplantacao(corpo.id);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Projeto não encontrado.');
  const { projeto } = resolvido;

  const estadoAtual = parseWaipeState(projeto.description);
  const novoEstado = {
    ...estadoAtual,
    vistoPor: { ...(estadoAtual.vistoPor || {}), [sessao.nome]: Date.now() },
  };
  await atualizarTask(projeto.id, { markdown_description: stringifyWaipeState(projeto.description, novoEstado) });
  return res.status(200).json({ ok: true });
}

async function listarModelosMensagemAcao(res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const tasks = await listarModelosMensagem();
  const modelos = tasks
    .map((t) => ({ id: t.id, nome: t.name, texto: contextoSemEstado(t.description) }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return res.status(200).json({ modelos });
}

async function salvarModeloMensagemAcao(req, res, sessao) {
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

  const nome = texto(corpo.nome, 100);
  const conteudo = texto(corpo.texto, 4096);
  if (!nome) return erro(res, 400, 'nome_invalido', 'Dê um nome pro modelo.');
  if (!conteudo) return erro(res, 400, 'texto_invalido', 'O modelo não pode ficar vazio.');

  const nova = await criarModeloMensagem({ name: nome, markdown_description: conteudo });
  return res.status(200).json({ ok: true, id: nova.id });
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
  // Subtask tipo "solucao" (Gestor/Simplaz/Unique/BIME APP/Treinamento
  // fechado) não tem estrutura de agente — só o progresso do checklist
  // (checklistChecks) é editável aqui; o resto do estado (produto/plano/
  // valor/checklist/observações) é preservado como veio da promoção.
  const novoEstado = estadoAtual.tipo === 'solucao'
    ? {
        ...estadoAtual,
        checklistChecks: sanearChecks(corpo.checklistChecks) ?? (estadoAtual.checklistChecks || {}),
        fase: FASES_ITEM_VALIDAS.has(corpo.fase) ? corpo.fase : (estadoAtual.fase || FASE_ITEM_PADRAO),
      }
    : {
        tipo: 'agente',
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
  // Mesmo raciocinio de atualizar-implantacao: mexer no checklist/progresso de
  // QUALQUER item/agente já tira o projeto do "pendente" — sobe o PROJETO
  // (nao esta subtask) pra "in progress" sozinho, só na primeira vez.
  if (projeto.status?.status === 'pendente') {
    await atualizarTask(projeto.id, { status: 'in progress' }).catch(() => {});
  }
  return res.status(200).json({ ok: true });
}

function dataRotuloHoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/**
 * POST ?action=salvar-proposta-implantacao — cria (ou atualiza, com
 * `taskIdExistente`) uma task na etapa "proposta" em LISTA_IMPLANTACOES_WAIPE.
 * Diferente de log-proposta (auditoria, uma task nova a cada clique, sem
 * estado reaproveitável), esta task guarda o estado completo do que foi
 * proposto pra o CSM reabrir dias depois — quando o cliente responder — e
 * editar o que realmente foi fechado, antes de confirmar-fechamento-implantacao.
 */
async function salvarPropostaImplantacaoAcao(req, res, sessao) {
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
  // CSM responsável: o campo "CSM / gerente de contas" do formulário é a
  // fonte preferida (a proposta pode ser preenchida por outra pessoa em
  // nome do CSM que de fato atende o cliente) — cai pra sessão só se vier
  // vazio.
  const csmFormulario = texto(corpo.csm, 120);

  const agentesPropostos = Array.isArray(corpo.agentesPropostos)
    ? corpo.agentesPropostos.slice(0, MAX_AGENTES).map(sanearAgenteProposto).filter(Boolean)
    : [];
  const outrasSolucoesPropostas = Array.isArray(corpo.outrasSolucoesPropostas)
    ? corpo.outrasSolucoesPropostas.slice(0, MAX_OUTRAS_SOLUCOES).map(sanearOutraSolucao).filter(Boolean)
    : [];
  const diagnosticoWaipe = sanearDiagnosticoWaipeProposto(corpo.diagnosticoWaipe);
  const secoesPropostaSelecionadas = sanearSecoesPropostaSelecionadas(corpo.secoesPropostaSelecionadas);
  const secoesPropostaGeradas = Array.isArray(corpo.secoesPropostaGeradas)
    ? corpo.secoesPropostaGeradas.slice(0, IDS_SECOES_PROPOSTA_VALIDAS.size).map(sanearSecaoPropostaGerada).filter(Boolean)
    : [];
  // Opcionais aqui — só viram obrigatórios em confirmar-fechamento-implantacao,
  // quando a proposta vira projeto de implantação de verdade.
  const dadosCliente = sanearDadosCliente(corpo);

  const novoEstado = {
    etapaAtual: 'proposta', agentesPropostos, outrasSolucoesPropostas, diagnosticoWaipe,
    secoesPropostaSelecionadas, secoesPropostaGeradas, ...dadosCliente,
  };
  const nomeTask = `${cliente} — Proposta — ${dataRotuloHoje()}`;

  if (corpo.taskIdExistente) {
    if (!taskIdValido(corpo.taskIdExistente)) {
      return erro(res, 400, 'task_invalida', 'taskIdExistente inválido.');
    }
    const resolvido = await resolverImplantacao(corpo.taskIdExistente);
    if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Proposta não encontrada.');
    const { tarefa, projeto } = resolvido;
    if (tarefa.id !== projeto.id) {
      return erro(res, 400, 'task_invalida', 'taskIdExistente deve ser o projeto, não uma subtask.');
    }
    const csm = csmDaDescricaoImplantacao(projeto.description);
    if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
      return erro(res, 403, 'fora_da_carteira', 'Esta proposta não está na sua carteira.');
    }
    const estadoAtual = parseWaipeState(tarefa.description);
    if (estadoAtual.etapaAtual && estadoAtual.etapaAtual !== 'proposta') {
      return erro(res, 409, 'ja_promovida', 'Esta proposta já virou um projeto de implantação.');
    }
    await atualizarTask(corpo.taskIdExistente, {
      name: nomeTask,
      markdown_description: stringifyWaipeState(
        [`**CSM:** ${csmFormulario || csm || texto(sessao.nome, 120) || sessao.csm || sessao.nivel}`, contexto].filter(Boolean).join('\n\n'),
        novoEstado
      ),
    });
    return res.status(200).json({ ok: true, id: corpo.taskIdExistente });
  }

  const csmNome = csmFormulario || texto(sessao.nome, 120) || sessao.csm || sessao.nivel;
  const projeto = await criarTaskImplantacao({
    name: nomeTask,
    markdown_description: stringifyWaipeState(
      [`**CSM:** ${csmNome}`, contexto].filter(Boolean).join('\n\n'),
      novoEstado
    ),
  });
  return res.status(200).json({ ok: true, id: projeto.id });
}

/**
 * POST ?action=confirmar-fechamento-implantacao — promove uma proposta
 * (etapa "proposta") a projeto de implantação de verdade: cria uma subtask
 * real por agente/solução marcados como incluídos (já editado pelo CSM pra
 * refletir o que o cliente realmente fechou) e avança a etapa pra "escopo".
 */
async function confirmarFechamentoImplantacaoAcao(req, res, sessao) {
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

  const resolvido = await resolverImplantacao(corpo.id);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Proposta não encontrada.');
  const { tarefa, projeto } = resolvido;
  if (tarefa.id !== projeto.id) {
    return erro(res, 400, 'task_invalida', 'Confirme o fechamento a partir da task do projeto, não de uma subtask.');
  }

  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Esta proposta não está na sua carteira.');
  }

  const estadoAtual = parseWaipeState(tarefa.description);
  if (estadoAtual.etapaAtual !== 'proposta') {
    return erro(res, 409, 'ja_promovida', 'Esta proposta já foi confirmada.');
  }

  const agentesPropostos = Array.isArray(estadoAtual.agentesPropostos)
    ? estadoAtual.agentesPropostos.map(sanearAgenteProposto).filter(Boolean)
    : [];
  const outrasSolucoesPropostas = Array.isArray(estadoAtual.outrasSolucoesPropostas)
    ? estadoAtual.outrasSolucoesPropostas.map(sanearOutraSolucao).filter((o) => o && o.incluir)
    : [];

  if (!agentesPropostos.length && !outrasSolucoesPropostas.length) {
    return erro(res, 400, 'nada_para_promover', 'Marque ao menos um agente ou solução antes de confirmar.');
  }

  // Aqui — virando projeto de implantação de verdade — os 4 campos deixam de
  // ser opcionais. O simulador já valida isso no cliente antes de chamar esta
  // ação, mas confirma de novo aqui pra não depender só do front (ex: alguém
  // chamando a API direto).
  const dadosCliente = sanearDadosCliente(estadoAtual);
  const faltando = dadosClienteFaltando(dadosCliente);
  if (faltando.length) {
    return erro(res, 400, 'dados_cliente_incompletos', `Preencha antes de confirmar o fechamento: ${faltando.join(', ')}.`);
  }

  for (const a of agentesPropostos) {
    const estrutura = {
      nome: a.nome, frente: a.frente, frequencia: '', canal: '', publico: '',
      entrega: a.entrega, sistemas: [], prereq: [],
    };
    await criarSubtaskAgente(projeto.id, {
      name: a.nome,
      markdown_description: stringifyWaipeState(descricaoAgente(estrutura), {
        tipo: 'agente',
        estrutura,
        buildChecks: {},
        testChecks: {},
        entregaChecks: {},
        prereqChecks: {},
        diagnostico: {},
        validacao: { status: 'pendente', motivo: '' },
      }),
    });
  }

  for (const o of outrasSolucoesPropostas) {
    await criarSubtaskAgente(projeto.id, {
      name: o.produto + (o.planoSugerido ? ` — ${o.planoSugerido}` : ''),
      markdown_description: stringifyWaipeState(descricaoSolucao(o), {
        tipo: 'solucao',
        produto: o.produto,
        planoSugerido: o.planoSugerido,
        variante: o.variante,
        motivo: o.motivo,
        observacoes: o.observacoes,
        ambienteMuda: o.ambienteMuda,
        quantidade: o.quantidade,
        valorTabela: o.valorTabela,
        valorManual: o.valorManual,
        descontoPercent: o.descontoPercent,
        checklist: jornadaPara(o.produto, o.ambienteMuda),
        checklistChecks: {},
        fase: FASE_ITEM_PADRAO,
      }),
    });
  }

  const novoEstadoProjeto = {
    etapaAtual: 'escopo',
    prioridade: [],
    agenteAtualId: null,
    concluidos: [],
    agentesTotal: agentesPropostos.length + outrasSolucoesPropostas.length,
    // Histórico do que foi proposto — não usado pelo pipeline a partir daqui.
    agentesPropostos: estadoAtual.agentesPropostos || [],
    outrasSolucoesPropostas: estadoAtual.outrasSolucoesPropostas || [],
    diagnosticoWaipe: estadoAtual.diagnosticoWaipe || null,
    ...dadosCliente,
  };
  await atualizarTask(projeto.id, {
    markdown_description: stringifyWaipeState(tarefa.description, novoEstadoProjeto),
  });

  return res.status(200).json({
    ok: true,
    id: projeto.id,
    criados: agentesPropostos.length + outrasSolucoesPropostas.length,
  });
}

// ── Reservas de agenda (Camada 1/Treinamento/reunião) ──────────────────────
// Lista à parte (LISTA_RESERVAS_AGENDA), sem o formato WAIPE_STATE — o
// projeto e o link do Meet ficam em 2 linhas simples na descrição
// (**Projeto:**/**Link:**), extraídas por projetoDaDescricaoReserva/
// linkDaDescricaoReserva. Não há filtro por carteira aqui: agenda dos ISMs
// é recurso compartilhado do time, não de um CSM.

const RESERVA_DURACAO_MAX_MS = 24 * 60 * 60 * 1000;
const RESERVA_JANELA_MS = 5 * 365 * 24 * 60 * 60 * 1000; // +/- 5 anos, só pra barrar lixo

/** Epoch (ms) dentro de uma janela sã, ou null se vier algo fora do esperado. */
function epocaOuNula(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const agora = Date.now();
  if (n < agora - RESERVA_JANELA_MS || n > agora + RESERVA_JANELA_MS) return null;
  return n;
}

function reservaParaFora(t) {
  return {
    id: t.id,
    titulo: t.name,
    ismId: Number(t.assignees?.[0]?.id) || null,
    ismNome: nomesIsm(t.assignees)[0] || '',
    inicio: Number(t.start_date) || null,
    fim: Number(t.due_date) || null,
    projetoId: projetoDaDescricaoReserva(t.description) || null,
    linkReuniao: linkDaDescricaoReserva(t.description) || '',
  };
}

async function listarReservasAcao(res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const tasks = await listarReservas();
  return res.status(200).json({ reservas: tasks.map(reservaParaFora) });
}

async function criarReservaAcao(req, res, sessao) {
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

  const titulo = texto(corpo.titulo, 200);
  if (!titulo) return erro(res, 400, 'titulo_invalido', 'Título da reserva é obrigatório.');

  const ismId = Number(corpo.ismId);
  if (!ISM_IDS_VALIDOS.has(ismId)) {
    return erro(res, 400, 'ism_invalido', 'Selecione um ISM válido.');
  }
  if (sessao.nivel === 'ism' && sessao.ismId && Number(sessao.ismId) !== ismId) {
    return erro(res, 403, 'fora_do_escopo', 'Você só pode registrar reserva na própria agenda.');
  }

  const inicio = epocaOuNula(corpo.inicio);
  const fim = epocaOuNula(corpo.fim);
  if (inicio === null || fim === null || fim <= inicio) {
    return erro(res, 400, 'horario_invalido', 'Início e fim precisam ser válidos, com fim depois do início.');
  }
  if (fim - inicio > RESERVA_DURACAO_MAX_MS) {
    return erro(res, 400, 'horario_invalido', 'Reserva não pode passar de 24h.');
  }

  let projetoId = null;
  if (corpo.projetoId) {
    if (!taskIdValido(corpo.projetoId)) {
      return erro(res, 400, 'task_invalida', 'projetoId inválido.');
    }
    projetoId = corpo.projetoId;
  }

  // Conflito: mesma pessoa, intervalos que se cruzam. Checa contra a lista
  // inteira de reservas (é pequena — só os horários já marcados).
  const existentes = await listarReservas();
  const conflito = existentes
    .filter((t) => Number(t.assignees?.[0]?.id) === ismId)
    .find((t) => Number(t.start_date) < fim && Number(t.due_date) > inicio);
  if (conflito) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(409).json({
      error: 'Este ISM já tem reserva nesse horário.',
      code: 'conflito_horario',
      conflito: reservaParaFora(conflito),
    });
  }

  // Se o ISM ja conectou a propria agenda do Google: checa disponibilidade
  // REAL (nao so contra as reservas ja registradas aqui) e cria a reuniao
  // com Meet automatico. Sem conexao, comportamento identico ao de sempre —
  // ninguem fica bloqueado por nao ter conectado ainda.
  let linkReuniao = null;
  const tokenGoogle = await obterTokenGoogle(ismId);
  if (tokenGoogle) {
    let accessToken;
    try {
      accessToken = await renovarAccessToken(tokenGoogle.refreshToken);
    } catch (e) {
      if (!(e instanceof ErroGoogle)) throw e;
      accessToken = null;
    }
    if (accessToken) {
      const ocupado = await consultarFreeBusy(accessToken, inicio, fim);
      if (ocupado) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(409).json({
          error: 'Este ISM tem outro compromisso na agenda do Google nesse horário.',
          code: 'conflito_horario_google',
          conflito: ocupado,
        });
      }
      linkReuniao = await criarEventoComMeet(accessToken, { titulo, inicio, fim });
    }
  }

  const linhasDescricao = [
    projetoId ? `**Projeto:** ${projetoId}` : null,
    linkReuniao ? `**Link:** ${linkReuniao}` : null,
  ].filter(Boolean);

  const nova = await criarReserva({
    name: titulo,
    start_date: inicio,
    start_date_time: true,
    due_date: fim,
    due_date_time: true,
    assignees: [ismId],
    markdown_description: linhasDescricao.join('\n\n'),
  });
  return res.status(200).json({ ok: true, id: nova.id, linkReuniao });
}

async function atualizarReservaAcao(req, res, sessao) {
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

  const tarefa = await obterTask(corpo.id);
  if (!tarefa || String(tarefa.list?.id || '') !== LISTA_RESERVAS_AGENDA) {
    return erro(res, 404, 'nao_encontrado', 'Reserva não encontrada.');
  }
  if (sessao.nivel === 'ism' && sessao.ismId && Number(tarefa.assignees?.[0]?.id) !== Number(sessao.ismId)) {
    return erro(res, 403, 'fora_do_escopo', 'Você só pode alterar reservas da própria agenda.');
  }

  const projetoId = projetoDaDescricaoReserva(tarefa.description);
  const linkReuniao = texto(corpo.linkReuniao, 300);
  const linhas = [
    projetoId ? `**Projeto:** ${projetoId}` : null,
    linkReuniao ? `**Link:** ${linkReuniao}` : null,
  ].filter(Boolean);

  await atualizarTask(corpo.id, { markdown_description: linhas.join('\n\n') });
  return res.status(200).json({ ok: true });
}

async function cancelarReservaAcao(req, res, sessao) {
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

  const tarefa = await obterTask(corpo.id);
  if (!tarefa || String(tarefa.list?.id || '') !== LISTA_RESERVAS_AGENDA) {
    return erro(res, 404, 'nao_encontrado', 'Reserva não encontrada.');
  }
  if (sessao.nivel === 'ism' && sessao.ismId && Number(tarefa.assignees?.[0]?.id) !== Number(sessao.ismId)) {
    return erro(res, 403, 'fora_do_escopo', 'Você só pode cancelar reservas da própria agenda.');
  }

  await excluirTask(corpo.id);
  return res.status(200).json({ ok: true });
}

// Janela de busca de eventos na agenda de cada ISM: um pouco pro passado
// (agendamento feito hoje mais cedo) e bastante pro futuro (o cliente pode
// marcar com semanas de antecedencia).
const SYNC_GOOGLE_DIAS_ANTES = 1;
const SYNC_GOOGLE_DIAS_DEPOIS = 60;

/**
 * Varre a agenda de cada ISM conectado ao Google atras de reservas feitas
 * pelo PROPRIO CLIENTE numa pagina de "Horarios de agendamento" (fora do
 * nosso fluxo de criar-reserva). Casa pelo CNPJ (pergunta personalizada que
 * cada ISM configura na propria pagina) contra os projetos abertos: bate ->
 * cria a reserva sozinho; nao bate (ou o evento nem tem a pergunta) -> nao
 * cria nada, so devolve pra tela mostrar e o ISM vincular manualmente.
 * Idempotente: cada reserva importada carrega o GoogleEventId na descricao,
 * entao rodar de novo nao duplica.
 */
async function sincronizarAgendamentosGoogleAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  if (!podeEscrever(sessao)) {
    return erro(res, 403, 'somente_leitura', 'Seu perfil tem acesso somente de leitura.');
  }

  const tokensTasks = await listarTokensGoogle();
  const tokens = tokensTasks
    .map((t) => parseWaipeState(t.description))
    .filter((e) => Number.isFinite(Number(e.ismId)) && typeof e.refreshToken === 'string' && e.refreshToken);

  const vinculados = [];
  const naoVinculados = [];
  if (!tokens.length) {
    return res.status(200).json({ ok: true, vinculados, naoVinculados });
  }

  const agora = Date.now();
  const inicioJanela = agora - SYNC_GOOGLE_DIAS_ANTES * 24 * 60 * 60 * 1000;
  const fimJanela = agora + SYNC_GOOGLE_DIAS_DEPOIS * 24 * 60 * 60 * 1000;

  const [projetos, reservasExistentes] = await Promise.all([listarImplantacoes(), listarReservas()]);

  const cnpjParaProjeto = new Map();
  for (const p of projetos) {
    const estado = parseWaipeState(p.description);
    const cnpj = soDigitos(estado.cnpj);
    if (cnpj && !cnpjParaProjeto.has(cnpj)) cnpjParaProjeto.set(cnpj, { id: p.id, nome: p.name });
  }

  const eventosJaImportados = new Set(
    reservasExistentes.map((r) => googleEventIdDaDescricaoReserva(r.description)).filter(Boolean)
  );

  for (const tk of tokens) {
    const ismId = Number(tk.ismId);
    const ismNome = ISM_OPCOES.find((i) => i.id === ismId)?.nome || String(ismId);

    let accessToken;
    try {
      accessToken = await renovarAccessToken(tk.refreshToken);
    } catch (e) {
      if (!(e instanceof ErroGoogle)) throw e;
      continue; // token expirado/revogado nesse ISM — nao derruba o sincronismo dos outros
    }

    let eventos;
    try {
      eventos = await listarEventos(accessToken, inicioJanela, fimJanela);
    } catch (e) {
      if (!(e instanceof ErroGoogle)) throw e;
      continue;
    }

    for (const ev of eventos) {
      if (!ev?.id || eventosJaImportados.has(ev.id)) continue;
      const cnpj = cnpjDoAgendamentoGoogle(ev.description);
      if (!cnpj) continue; // evento comum, sem a pergunta de CNPJ — nao veio da pagina de agendamento

      const inicioEvento = Date.parse(ev.start?.dateTime || ev.start?.date || '');
      const fimEvento = Date.parse(ev.end?.dateTime || ev.end?.date || '');
      if (!Number.isFinite(inicioEvento) || !Number.isFinite(fimEvento)) continue;

      const linkReuniao = ev.hangoutLink || null;
      const titulo = texto(ev.summary, 200) || 'Agendamento do cliente';
      const projeto = cnpjParaProjeto.get(cnpj);

      if (projeto) {
        const linhasDescricao = [
          `**Projeto:** ${projeto.id}`,
          linkReuniao ? `**Link:** ${linkReuniao}` : null,
          `**GoogleEventId:** ${ev.id}`,
        ].filter(Boolean);
        const nova = await criarReserva({
          name: titulo,
          start_date: inicioEvento,
          start_date_time: true,
          due_date: fimEvento,
          due_date_time: true,
          assignees: [ismId],
          markdown_description: linhasDescricao.join('\n\n'),
        });
        vinculados.push({ id: nova.id, projetoId: projeto.id, projetoNome: projeto.nome, titulo, ismNome });
      } else {
        naoVinculados.push({ googleEventId: ev.id, ismId, ismNome, titulo, inicio: inicioEvento, fim: fimEvento, linkReuniao, cnpj });
      }
    }
  }

  return res.status(200).json({ ok: true, vinculados, naoVinculados });
}

/** Vincula manualmente um agendamento do Google (achado por sincronizar-agendamentos-google
 * sem CNPJ correspondente) a um projeto — o ISM escolhe na tela. Mesmo formato de reserva
 * do caminho automatico, inclusive o GoogleEventId (evita duplicar num sincronismo futuro). */
async function vincularAgendamentoGoogleAcao(req, res, sessao) {
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

  if (!taskIdValido(corpo.projetoId)) {
    return erro(res, 400, 'task_invalida', 'projetoId inválido.');
  }
  const ismId = Number(corpo.ismId);
  if (!ISM_OPCOES.some((i) => i.id === ismId)) {
    return erro(res, 400, 'ism_invalido', 'ISM inválido.');
  }
  if (sessao.nivel === 'ism' && sessao.ismId && Number(sessao.ismId) !== ismId) {
    return erro(res, 403, 'fora_do_escopo', 'Você só pode vincular agendamentos da própria agenda.');
  }
  const googleEventId = texto(corpo.googleEventId, 200);
  if (!googleEventId) {
    return erro(res, 400, 'evento_invalido', 'googleEventId é obrigatório.');
  }
  const inicio = epocaOuNula(corpo.inicio);
  const fim = epocaOuNula(corpo.fim);
  if (inicio === null || fim === null || fim <= inicio) {
    return erro(res, 400, 'horario_invalido', 'Início e fim precisam ser válidos, com fim depois do início.');
  }

  const titulo = texto(corpo.titulo, 200) || 'Agendamento do cliente';
  const linkReuniao = typeof corpo.linkReuniao === 'string' ? texto(corpo.linkReuniao, 300) : null;
  const linhasDescricao = [
    `**Projeto:** ${corpo.projetoId}`,
    linkReuniao ? `**Link:** ${linkReuniao}` : null,
    `**GoogleEventId:** ${googleEventId}`,
  ].filter(Boolean);

  const nova = await criarReserva({
    name: titulo,
    start_date: inicio,
    start_date_time: true,
    due_date: fim,
    due_date_time: true,
    assignees: [ismId],
    markdown_description: linhasDescricao.join('\n\n'),
  });
  return res.status(200).json({ ok: true, id: nova.id });
}

/** 302 pro consentimento OAuth do Google — devolve o redirect, a troca de code por
 * token acontece do outro lado, em api/google-oauth-callback.js (fora deste dispatcher). */
async function conectarAgendaGoogleAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const ismId = Number(req.query?.ismId);
  if (!ISM_IDS_VALIDOS.has(ismId)) {
    return erro(res, 400, 'ism_invalido', 'ismId inválido.');
  }
  // Um ISM so conecta a PROPRIA agenda — nunca a de outro (o ismId da sessao
  // vem assinado, nao da pra forjar so trocando o parametro na URL).
  if (sessao.nivel === 'ism' && sessao.ismId && Number(sessao.ismId) !== ismId) {
    return erro(res, 403, 'fora_do_escopo', 'Você só pode conectar a própria agenda.');
  }
  let url;
  try {
    url = urlAutorizacaoGoogle(ismId);
  } catch (e) {
    if (e instanceof ErroConfigGoogle) {
      return erro(res, 500, 'google_nao_configurado', 'Integração com o Google ainda não foi configurada.');
    }
    throw e;
  }
  res.setHeader('Location', url);
  return res.status(302).end();
}

/** { [ismId]: true|false } — se cada ISM ja conectou a propria agenda do Google. */
async function statusGoogleAgendaAcao(res) {
  res.setHeader('Cache-Control', 'no-store');
  const status = {};
  await Promise.all(ISM_OPCOES.map(async (o) => {
    status[o.id] = !!(await obterTokenGoogle(o.id));
  }));
  return res.status(200).json({ status });
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
    corpo = await lerCorpo(req, { limiteBytes: LIMITE_CORPO_ANEXO });
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }

  if (!taskIdValido(corpo.taskId)) {
    return erro(res, 400, 'task_invalida', 'taskId inválido.');
  }
  const comentario = texto(corpo.texto, 2000);

  // `imagem` e opcional: um print colado no comentario. O ClickUp nao aceita
  // imagem embutida no corpo do comentario pela API — sobe como anexo comum
  // e a URL entra no texto (o cliente ClickUp mostra preview inline sozinho
  // pra link de anexo próprio, sem precisar de markdown).
  let arquivo = null;
  if (corpo.imagem) {
    arquivo = lerArquivoAnexo(corpo.imagem);
    if (arquivo.erro) return erro(res, 400, 'arquivo_invalido', arquivo.erro);
    if (!arquivo.mimeType.startsWith('image/')) {
      return erro(res, 400, 'arquivo_invalido', 'Só é possível colar imagens no comentário.');
    }
  }
  if (!comentario && !arquivo) {
    return erro(res, 400, 'texto_invalido', 'Comentário vazio.');
  }

  const resolvido = await resolverImplantacao(corpo.taskId);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Tarefa não encontrada.');
  const csm = csmDaDescricaoImplantacao(resolvido.projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  let textoFinal = comentario;
  if (arquivo) {
    const anexado = await anexarArquivoTask(corpo.taskId, arquivo);
    textoFinal = [comentario, anexado.url].filter(Boolean).join('\n');
  }

  await criarComentario(corpo.taskId, textoFinal);
  return res.status(200).json({ ok: true });
}

async function anexarArquivoImplantacaoAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  if (!podeEscrever(sessao)) {
    return erro(res, 403, 'somente_leitura', 'Seu perfil tem acesso somente de leitura.');
  }

  let corpo;
  try {
    corpo = await lerCorpo(req, { limiteBytes: LIMITE_CORPO_ANEXO });
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }

  if (!taskIdValido(corpo.id)) {
    return erro(res, 400, 'task_invalida', 'id inválido.');
  }
  const arquivo = lerArquivoAnexo(corpo);
  if (arquivo.erro) return erro(res, 400, 'arquivo_invalido', arquivo.erro);

  const resolvido = await resolverImplantacao(corpo.id);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Tarefa não encontrada.');
  const csm = csmDaDescricaoImplantacao(resolvido.projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const anexado = await anexarArquivoTask(corpo.id, arquivo);
  return res.status(200).json({
    ok: true,
    anexo: { id: anexado.id, nome: anexado.title || arquivo.nomeArquivo, url: anexado.url, extensao: anexado.extension || '' },
  });
}

// ── Erros ─────────────────────────────────────────────────────────────────

function tratarErro(res, e, acao) {
  if (e instanceof ErroConfigClickUp || e instanceof ErroConfig) {
    console.error('[clickup] configuracao:', e.message);
    return erro(res, 500, 'nao_configurado', 'Integração não configurada no servidor.');
  }
  if (e instanceof ErroConfigGoogle) {
    console.error('[clickup] configuracao Google:', e.message);
    return erro(res, 500, 'google_nao_configurado', 'Integração com o Google não está configurada no servidor.');
  }
  if (e instanceof ErroGoogle) {
    // Falha do lado do GOOGLE (token expirado/revogado, freebusy, criacao do
    // evento) — nao e o ClickUp que falhou. Sem isso, criar-reserva com um
    // ISM conectado cai no catch-all generico e mente dizendo "ClickUp".
    console.error(`[clickup] acao=${acao} falha_google=${e.status}:`, JSON.stringify(e.corpo)?.slice(0, 300));
    return erro(res, 502, 'erro_google', 'Falha ao falar com a agenda do Google desse ISM — pode ser token expirado/revogado. Tente reconectar a agenda dele.');
  }
  if (e instanceof ErroConfigUmbler) {
    console.error('[clickup] configuracao Umbler:', e.message);
    return erro(res, 500, 'umbler_nao_configurado', 'Integração com o Umbler Talk não está configurada no servidor.');
  }
  if (e instanceof ErroUmbler) {
    console.error(`[clickup] acao=${acao} falha_umbler=${e.status}:`, JSON.stringify(e.corpo)?.slice(0, 300));
    return erro(res, 502, 'erro_umbler', 'Falha ao falar com o Umbler Talk.');
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
