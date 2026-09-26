// Proxy do ClickUp. NAO e um proxy generico: aceita apenas acoes fixas e
// nunca um path livre vindo do cliente.
//
//   GET  /api/clickup?action=carteira              lista 901327787926 paginada no servidor
//   GET  /api/clickup?action=metas                 lista 901327940637
//   POST /api/clickup?action=set-field             { taskId, fieldId, value }
//   POST /api/clickup?action=log-proposta          cria task de log em 901328973414
//   GET  /api/clickup?action=listar-implantacoes   lista 901328976497 (projetos em andamento)
//   GET  /api/clickup?action=obter-implantacao     { id } -> projeto + agentes
//   POST /api/clickup?action=criar-implantacao     { cliente, contexto, agentes[], solucoes[] }
//        -> exige pelo menos 1 agente OU 1 solucao (nao precisa ser baseado
//        em agente Waipe — projeto pode ser so troca de plano Gestor, BIME
//        etc.). `solucoes[]` no mesmo formato de outrasSolucoesPropostas do
//        simulador (ver sanearOutraSolucao). Tambem chamada pela automacao
//        do webhook do Moskit (api/moskit-webhook.js), via a funcao
//        criarProjetoImplantacao exportada aqui.
//   POST /api/clickup?action=definir-gerente-contas { id } -> so em projeto
//        sem CSM ainda e com ID Nucleo preenchido (!= "" e != "0"): sorteia
//        o proximo Gerente de Contas em rodizio fixo (GERENTE_OPCOES, em
//        _lib/clickup.js), grava no projeto e ja cria o cliente na lista
//        Carteiras (901327787926) — substitui o processo manual via
//        Londriconnect.
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
//   POST /api/clickup?action=criar-reserva         { projetoId?, titulo, ismId, inicio, fim, convidados? }
//        -> 409 'conflito_horario' se o ISM ja tiver reserva nesse intervalo
//        convidados: e-mails (max 10, invalidos sao descartados em silencio) —
//        viram convidados do evento do Google (convite por e-mail automatico,
//        so quando o ISM tem a agenda conectada)
//   POST /api/clickup?action=atualizar-reserva     { id, linkReuniao, convidados? } — cola o
//        link do Meet depois que a reuniao foi criada (a API do ClickUp nao gera isso);
//        convidados so muda quando enviado, senao preserva o que ja tinha
//   POST /api/clickup?action=cancelar-reserva      { id } -> libera o horario
//   POST /api/clickup?action=marcar-comparecimento-reserva { id, status:
//        "compareceu"|"nao_compareceu" } -> registra se o cliente veio ou
//        nao, pra auditoria (disputa de reembolso/multa) e pro relatorio
//        de finalizacao
//   POST /api/clickup?action=reagendar-reserva { id, novoInicio, novoFim,
//        reagendadoPor: "londrisoft"|"cliente" } -> marca a reserva atual
//        como reagendada (quem pediu) e cria uma nova no novo horario
//        (mesmo fluxo de criar-reserva: conflito + Google/Meet)
//   GET  /api/clickup?action=disponibilidade-ism { ismId, inicio, fim } ->
//        { ocupados: [{inicio, fim, titulo}] } — reservas internas + agenda
//        REAL do Google (quando conectado) desse ISM no intervalo, pro
//        calendário visual de agendamento (mostra dia/horário já tomado)
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
//   POST /api/clickup?action=salvar-modelo-mensagem { nome, texto, assunto? } ->
//        salva um modelo novo (assunto so faz sentido pro canal de e-mail)
//   GET  /api/clickup?action=conectar-email-google { tipo? } -> 302 pro
//        consentimento OAuth do Gmail (envio), AUTORIZACAO SEPARADA da
//        agenda (escopo so gmail.send+userinfo.email, nao mexe no calendar).
//        tipo="compartilhada" conecta a conta unica (so gestao); default
//        ("pessoal") conecta o Gmail da propria sessao
//   GET  /api/clickup?action=status-email-google -> { pessoal:{conectado,
//        email}, compartilhada:{conectado,email}, podeConectarCompartilhada }
//   POST /api/clickup?action=enviar-email-implantacao { id, remetente:
//        "pessoal"|"compartilhada", destinatarios[], assunto, corpo } -> manda
//        e-mail de verdade via Gmail (conexao ja feita) e registra como
//        comentario no projeto
//   GET  /api/clickup?action=listar-atividades-csq -> fila unificada da
//        Daiane/Aline (nivel "csq"): tipos virtuais calculados na hora
//        (projeto parado ha >=3 dias uteis sem interacao nem agendamento
//        futuro, reserva sem comparecimento) + Atividades persistidas
//        (mencao/churn/renovacao) nao resolvidas. So nivel csq/gestao.
//   POST /api/clickup?action=criar-atividade-csq { projetoId, tipo:
//        "churn"|"renovacao", alvoId, observacao? } -> registra diagnostico
//        de cancelamento ou handoff de renovacao pro CSM. So nivel csq/gestao.
//   POST /api/clickup?action=resolver-atividade-csq { id, resolucao? } ->
//        fecha uma Atividade persistida (nunca mexe no projeto de
//        implantacao). So nivel csq/gestao.
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
  alertasDaTask,
  alvoDaDescricaoAtividade,
  anexarArquivoTask,
  assinarLinkCurto,
  assinarTokenProjeto,
  assuntoDoModelo,
  atualizarTask,
  CAMPO_ALERTAS,
  CAMPOS_ESCRITA,
  cnpjDoAgendamentoGoogle,
  CONTA_EMAIL_COMPARTILHADA,
  contextoSemEstado,
  corpoDoModelo,
  criarAtividadeCsq,
  criarClienteCarteira,
  atualizarComentario,
  criarComentario,
  criarModeloMensagem,
  criarReserva,
  criarSubtaskAgente,
  criarTaskImplantacao,
  criarTaskPropostaWaipe,
  convidadosDaDescricaoReserva,
  criptografarSegredo,
  csmDaDescricaoImplantacao,
  CSM_OPCOES,
  descriptografarSegredo,
  diasUteisEntre,
  EQUIPE_OPCAO,
  ErroConfigClickUp,
  ErroUpstream,
  espelharAlertas,
  excluirComentario,
  excluirTask,
  GERENTE_OPCOES,
  getCarteira,
  getMetas,
  googleEventIdDaDescricaoReserva,
  gravarCampo,
  ISM_OPCOES,
  lerClienteFresco,
  limparCampo,
  linkDaDescricaoReserva,
  LISTA_ATIVIDADES_CSQ,
  LISTA_CARTEIRA,
  LISTA_IMPLANTACOES_WAIPE,
  LISTA_RESERVAS_AGENDA,
  listarAtividadesCsq,
  listarComentarios,
  listarImplantacoes,
  listarModelosMensagem,
  listarReservas,
  listarTokensGoogle,
  localizarCliente,
  localizarTask,
  obterTask,
  obterTaskComSubtasks,
  obterTokenEmail,
  obterTokenGoogle,
  origemDaDescricaoAtividade,
  parseWaipeState,
  PESSOAS_MENCIONAVEIS,
  projetoDaDescricaoAtividade,
  projetoDaDescricaoReserva,
  proximaReservaIdDaDescricaoReserva,
  reagendadoPorDaDescricaoReserva,
  refletirEscrita,
  resolucaoDaDescricaoAtividade,
  responsavelDaDescricaoReserva,
  soDigitos,
  statusDaDescricaoAtividade,
  statusDaDescricaoReserva,
  STATUS_MES_ATUAL,
  stringifyWaipeState,
  tipoDaDescricaoAtividade,
} from './_lib/clickup.js';
import { urlAutorizacaoGoogle, renovarAccessToken, consultarFreeBusy, listarFreeBusy, criarEventoComMeet, enviarEmailGmail, listarEventos, ErroGoogle, ErroConfigGoogle } from './_lib/google.js';
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
export const MIME_ANEXOS_VALIDOS = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
  'application/x-pkcs12', // certificado digital (.p12/.pfx) — copiado do negócio do Moskit
]);
export const MAX_ANEXO_BYTES = 4 * 1024 * 1024;
const LIMITE_CORPO_ANEXO = 6 * 1024 * 1024;
const RE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Anexo (arquivo ou print) saneado a partir do corpo — nunca confia no que vem sem checar tipo/tamanho antes de gastar uma chamada de upload no ClickUp. */
export function lerArquivoAnexo(corpo) {
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

// Nivel "ism"/"csq" LEEM carteira/metas/cliente (dados financeiros) no mesmo
// nivel que "consulta" — so leitura, MRR sempre zerado (ver lerCarteira/
// lerMetas/lerCliente) — nunca ESCREVEM nesses dados: set-field/log-proposta
// continuam bloqueados aqui mesmo os dois passando por podeEscrever (que so
// olha "e escritor em algum lugar do sistema", nao "pode escrever ISSO").
// Tambem nao acessam o pipeline de proposta de implantacao
// (criar/salvar-proposta/confirmar-fechamento — isso e trabalho de
// CSM/gestao; o ISM so entra depois, quando o projeto ja existe) nem
// exclusao de projeto/comentario (so Gestao — o handler de cada uma ja
// checa isso de novo, aqui e so a primeira barreira, mesmo padrao das outras).
const ACOES_PROIBIDAS_ISM = new Set([
  'set-field', 'log-proposta',
  'criar-implantacao', 'salvar-proposta-implantacao', 'confirmar-fechamento-implantacao',
  'excluir-implantacao', 'excluir-comentario-implantacao',
]);

// CSM não tem `ismId` próprio na sessão (só o nome de carteira, `csm`) — sem
// como restringir auto-escopo nessa ação, por isso ela fica de fora pra
// esse nível (ver conectarAgendaGoogleAcao: CSM ainda funciona sem Google
// conectado, só sem Meet automático).
const ACOES_PROIBIDAS_CSM = new Set(['conectar-agenda-google']);

// Fila AGREGADA de Atividades (ver todas, de todo projeto, e fechar
// qualquer uma) — csq/gestao/ism. Registrar uma atividade NUM projeto
// específico (botão "Criar atividade" dentro do projeto) é ainda mais
// amplo: csq/gestao/csm/ism (csm é quem diagnostica churn/handoff de
// renovação da própria carteira) — ver NIVEIS_CRIAR_ATIVIDADE logo abaixo.
// CSM nunca tem a fila agregada, só continua agindo nos próprios projetos.
const NIVEIS_FILA_ATIVIDADES = new Set(['csq', 'gestao', 'ism']);
const ACOES_SOMENTE_CSQ = new Set([
  'listar-atividades-csq', 'resolver-atividade-csq',
]);
const NIVEIS_CRIAR_ATIVIDADE = new Set(['csq', 'gestao', 'csm', 'ism']);

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

    // Nivel "ism"/"csq": sem escrita em carteira (set-field/log-proposta) nem
    // no pipeline de proposta (isso e trabalho de CSM/gestao) — leitura de
    // carteira/metas/cliente e permitida (mesmo nivel de "consulta", ver
    // lerCarteira/lerMetas/lerCliente). Bloqueado aqui, ANTES de rotear pra
    // funcao — nao depende de cada acao lembrar de checar sozinha.
    if ((sessao.nivel === 'ism' || sessao.nivel === 'csq') && ACOES_PROIBIDAS_ISM.has(acao)) {
      return erro(res, 403, 'nivel_nao_permitido', 'Este perfil não tem acesso a esta ação.');
    }
    if (sessao.nivel === 'csm' && ACOES_PROIBIDAS_CSM.has(acao)) {
      return erro(res, 403, 'nivel_nao_permitido', 'Este perfil não tem acesso a esta ação.');
    }
    if (ACOES_SOMENTE_CSQ.has(acao) && !NIVEIS_FILA_ATIVIDADES.has(sessao.nivel)) {
      return erro(res, 403, 'nivel_nao_permitido', 'Este perfil não tem acesso à fila de Atividades.');
    }
    if (acao === 'criar-atividade-csq' && !NIVEIS_CRIAR_ATIVIDADE.has(sessao.nivel)) {
      return erro(res, 403, 'nivel_nao_permitido', 'Este perfil não tem acesso à fila de Atividades.');
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
    if (req.method === 'POST' && acao === 'definir-gerente-contas') {
      return await definirGerenteContasAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'atualizar-implantacao') {
      return await atualizarImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'renomear-implantacao') {
      return await renomearImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'adicionar-item-implantacao') {
      return await adicionarItemImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'atualizar-agente') return await atualizarAgenteAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'comentar-implantacao') return await comentarImplantacaoAcao(req, res, sessao);
    if (req.method === 'GET' && acao === 'listar-comentarios') return await listarComentariosAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'excluir-comentario-implantacao') {
      return await excluirComentarioImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'marcar-comentario-implantacao') {
      return await marcarComentarioImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'excluir-implantacao') return await excluirImplantacaoAcao(req, res, sessao);
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
    if (req.method === 'GET' && acao === 'compromissos-hoje') return await compromissosHojeAcao(res);
    if (req.method === 'POST' && acao === 'criar-reserva') return await criarReservaAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'atualizar-reserva') return await atualizarReservaAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'cancelar-reserva') return await cancelarReservaAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'marcar-comparecimento-reserva') {
      return await marcarComparecimentoReservaAcao(req, res, sessao);
    }
    if (req.method === 'POST' && acao === 'reagendar-reserva') return await reagendarReservaAcao(req, res, sessao);
    if (req.method === 'GET' && acao === 'disponibilidade-ism') return await disponibilidadeIsmAcao(req, res, sessao);
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
    if (req.method === 'GET' && acao === 'conectar-email-google') return await conectarEmailGoogleAcao(req, res, sessao);
    if (req.method === 'GET' && acao === 'status-email-google') return await statusEmailGoogleAcao(res, sessao);
    if (req.method === 'POST' && acao === 'enviar-email-implantacao') {
      return await enviarEmailImplantacaoAcao(req, res, sessao);
    }
    if (req.method === 'GET' && acao === 'listar-atividades-csq') return await listarAtividadesCsqAcao(res, sessao);
    if (req.method === 'POST' && acao === 'criar-atividade-csq') return await criarAtividadeManualCsqAcao(req, res, sessao);
    if (req.method === 'POST' && acao === 'resolver-atividade-csq') return await resolverAtividadeCsqAcao(req, res, sessao);

    const ACOES_VALIDAS = [
      'carteira', 'busca', 'metas', 'cliente', 'set-field', 'log-proposta',
      'listar-implantacoes', 'obter-implantacao', 'criar-implantacao',
      'definir-gerente-contas',
      'atualizar-implantacao', 'renomear-implantacao', 'adicionar-item-implantacao',
      'atualizar-agente', 'comentar-implantacao',
      'listar-comentarios', 'excluir-comentario-implantacao', 'marcar-comentario-implantacao', 'excluir-implantacao',
      'anexar-arquivo-implantacao', 'salvar-proposta-implantacao',
      'confirmar-fechamento-implantacao', 'listar-reservas', 'compromissos-hoje', 'criar-reserva',
      'atualizar-reserva', 'cancelar-reserva', 'marcar-comparecimento-reserva',
      'reagendar-reserva', 'disponibilidade-ism', 'conectar-agenda-google',
      'status-google-agenda', 'iniciar-conversa-umbler',
      'sincronizar-agendamentos-google', 'vincular-agendamento-google',
      'historico-conversa-umbler', 'listar-modelos-mensagem', 'salvar-modelo-mensagem',
      'marcar-conversa-vista', 'conectar-email-google', 'status-email-google',
      'enviar-email-implantacao',
      'listar-atividades-csq', 'criar-atividade-csq', 'resolver-atividade-csq',
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

  // consulta/ism/csq nao veem valores financeiros — mesmo nivel de acesso
  // dos tres (ver ACOES_PROIBIDAS_ISM). O front tambem os esconde, mas quem
  // decide e o servidor: editar `session` no console nao revela MRR.
  if (sessao.nivel === 'consulta' || sessao.nivel === 'ism' || sessao.nivel === 'csq') {
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

  const semValorFinanceiro = sessao.nivel === 'consulta' || sessao.nivel === 'ism' || sessao.nivel === 'csq';
  return res.status(200).json({ task: semValorFinanceiro ? { ...linha, mrr: 0 } : linha });
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

  // consulta/ism/csq nao recebem valor financeiro nenhum, nem individual
  // (lerCarteira zera o mrr) nem agregado. Agregado nao identifica o
  // resultado de ninguem, mas continua sendo numero financeiro — e o README
  // define consulta (e agora ism/csq, mesmo nivel) como perfil sem acesso a
  // valor financeiro. Vale para os periodos, que carregam os limiares da
  // equipe.
  if (sessao.nivel === 'consulta' || sessao.nivel === 'ism' || sessao.nivel === 'csq') {
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

  // Alertas (🚨) é o mesmo campo na lista Implantação — espelha lá se o
  // cliente já tiver um projeto de implantação (achado por ID Núcleo, não
  // por CNPJ — ver espelharAlertas). Best-effort: a escrita principal na
  // Carteira já foi aplicada, não deve falhar por causa do espelhamento.
  if (fieldId === CAMPO_ALERTAS) {
    try {
      const linha = await localizarCliente(taskId);
      if (linha?.idNucleo) await espelharAlertas(LISTA_CARTEIRA, linha.idNucleo, valor);
    } catch (e) {
      console.error('[clickup] falha ao espelhar alertas na implantação:', e);
    }
  }

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

/**
 * Allowlist de agenda generalizada: quem pode ser responsável por uma reserva
 * (ISM ou CSM) — usada onde antes só ISM_IDS_VALIDOS valia (criar-reserva,
 * disponibilidade-ism, conectar-agenda-google). O parâmetro continua se
 * chamando `ismId` nesses endpoints (o ClickUp não diferencia ISM de CSM em
 * `assignees`, não vale renomear só por estética).
 */
const RESPONSAVEL_IDS_VALIDOS = new Set([...ISM_OPCOES, ...CSM_OPCOES].map((o) => o.id));

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

/** Nomes de ISM/CSM a partir do array `assignees` que o ClickUp devolve na task. */
function nomesIsm(assignees) {
  if (!Array.isArray(assignees)) return [];
  const porId = new Map([...ISM_OPCOES, ...CSM_OPCOES].map((i) => [i.id, i.nome]));
  return assignees.map((a) => porId.get(Number(a?.id))).filter(Boolean);
}

/**
 * Ids de ISM do projeto: `assignees` nativo quando presente, senão o
 * `ismIds` gravado no estado (ver comentário em atualizarImplantacaoAcao) —
 * usar SEMPRE esta função em vez de ler `t.assignees` direto pra listar/
 * exibir ISM, mesmo raciocínio de responsavelIdDaReserva/assigneeIdDaAtividade,
 * porque o ClickUp descarta esse assignee em silêncio quando a pessoa não
 * tem acesso de guest configurado nesta lista.
 */
function ismIdsDoProjeto(t, estado) {
  const doAssignee = sanearAssignees((t.assignees || []).map((a) => a.id));
  return doAssignee.length ? doAssignee : sanearAssignees(estado.ismIds);
}

/** Nome de ISM/CSM a partir do id resolvido (ver responsavelIdDaReserva) — '' se não achar. */
function nomeResponsavel(id) {
  const porId = new Map([...ISM_OPCOES, ...CSM_OPCOES].map((i) => [i.id, i.nome]));
  return porId.get(Number(id)) || '';
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

const PRODUTOS_SOLUCAO_VALIDOS = new Set(['Gestor', 'Simplaz Gestor', 'Simplaz Unique', 'Unique', 'BIME APP', 'Bime', 'Deploy', 'Treinamento', 'Migração Nuvem', 'Homologação de Boleto', 'Nota de Serviço', 'Londrisoft Camp 2026', 'Outro']);
const VARIANTES_SOLUCAO_VALIDAS = new Set(['Nuvem', 'Local']);
// 'vigencia': desconto do item vem da vigência contratada (3/6/12 meses,
// Londrisoft Deploy), não de alçada negociável — ver VIGENCIAS_DEPLOY_VALIDAS.
const POL_SOLUCAO_VALIDOS = new Set(['padrao', 'limite10', 'sem', 'vigencia']);
const VIGENCIAS_DEPLOY_VALIDAS = new Set([3, 6, 12]);
const GOV_WAIPE_VALIDOS = new Set(['sim', 'nao']);
const AUTOMACAO_WAIPE_VALIDOS = new Set(['pronta', 'personalizada']);

// Fase de acompanhamento de um item da lista unificada (solucao fechada) —
// tag manual editada pelo CSM, independente do checklist. FASE_ITEM_PADRAO
// entra em todo item novo; "cancelado" nao conta como pendencia pro derivado
// do projeto (ver derivarFaseProjeto).
// "analise_desistencia" só existe no vocabulário do PROJETO (faseProjetoManual)
// — nunca aparece como fase de item/agente no front, mas entra aqui porque
// esta é a mesma validação usada pros dois níveis (ver comentário acima).
// Ao contrário de "cancelado"/"entregue", não finaliza o projeto: fica em
// "Projetos em Andamento" enquanto o CSM investiga um sinal de desistência.
const FASES_ITEM_VALIDAS = new Set(['agendado', 'nao_iniciado', 'em_andamento', 'aguardando_cliente', 'aguardando_interno', 'analise_desistencia', 'cancelado', 'entregue']);
const FASE_ITEM_PADRAO = 'nao_iniciado';

// Fases de PROJETO (faseProjetoManual) em que o relógio do SLA fica pausado
// — pedido explícito da usuária: tempo esperando o cliente aparecer/responder
// (aguardando_cliente) ou esperando a data de um agendamento futuro chegar
// (agendado) não deveria contar como atraso nosso. Ver pausaSlaDesde/
// pausaSlaAcumuladaDiasUteis em atualizarImplantacaoAcao.
const FASES_SLA_PAUSADAS = new Set(['agendado', 'aguardando_cliente']);

// Urgencia do projeto — classificacao manual (CSM/ISM), sem derivacao
// automatica nenhuma. "normal" e o default quando ainda ninguem classificou,
// pra sempre ter uma bandeira valida pra mostrar no card. Campo chamado
// "urgencia", NUNCA "prioridade" — esse nome ja e usado (corpo.prioridade/
// sim.prioridade/estadoProjeto.prioridade) pra ordem dos agentes Waipe no
// pipeline de build, um array, conceito totalmente diferente.
const URGENCIAS_VALIDAS = new Set(['urgente', 'alta', 'normal', 'baixa']);
const URGENCIA_PADRAO = 'normal';
function sanearUrgencia(v) {
  return URGENCIAS_VALIDAS.has(v) ? v : URGENCIA_PADRAO;
}

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

/**
 * Mesmo critério de itemConcluido()/todosItensConcluidos() em
 * implantacao-waipe.html (duplicado aqui de propósito — o front não é um
 * módulo importável, mesmo padrão de outras duplicações pequenas já
 * documentadas neste arquivo) — item "solucao" concluído é fase entregue
 * ou cancelada; agente Waipe concluído é validação validada ou cancelada.
 * `false` sem nenhum item (nada foi confirmado como pronto/descartado
 * ainda). Usado pra travar faseProjetoManual "entregue"/"cancelado" no
 * projeto enquanto sobrar item em aberto (ver atualizarImplantacaoAcao).
 */
function todosItensConcluidos(subtasks) {
  if (!subtasks.length) return false;
  return subtasks.every((t) => {
    const e = parseWaipeState(t.description);
    if (e.tipo === 'solucao') {
      const fase = e.fase || FASE_ITEM_PADRAO;
      return fase === 'entregue' || fase === 'cancelado';
    }
    const status = (e.validacao || {}).status || 'pendente';
    return status === 'validado' || status === 'cancelado';
  });
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
  'Migração Nuvem': [
    'Coletar/confirmar dados do cliente (financeiro, contador, certificado)',
    'Configurar certificado digital',
    'Migrar a base para a nuvem',
    'Realizar testes iniciais',
    'Confirmar com o cliente que já está usando na nuvem',
  ],
  'Homologação de Boleto': [
    'Coletar dados bancários do cliente (banco, agência, conta, carteira)',
    'Configurar o banco no sistema e gerar arquivo de remessa',
    'Validar homologação junto ao banco',
    'Corrigir e reenviar em caso de erro',
    'Confirmar homologação aprovada e liberar emissão de boletos',
  ],
  'Nota de Serviço': [
    'Coletar dados de acesso à prefeitura (CPF/senha) e IE municipal',
    'Coletar tributação por serviço (CST PIS/COFINS, retenções ISS/INSS, código da lista 116/03, alíquota)',
    'Configurar numeração inicial (última NF-e, MDF-e e nota de serviço emitidas)',
    'Ativar emissão de nota de serviço e realizar teste',
    'Confirmar com o cliente que a emissão está funcionando',
  ],
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
export function sanearOutraSolucao(o) {
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
    // Só fazem sentido pra produto "Deploy" (vigência do contrato e a
    // isenção de setup, benefício exclusivo da vigência de 12 meses) — mas
    // saneados de forma genérica, sem checar o produto: outros produtos
    // simplesmente nunca os preenchem.
    vigenciaMeses: VIGENCIAS_DEPLOY_VALIDAS.has(Number(o.vigenciaMeses)) ? Number(o.vigenciaMeses) : null,
    isencaoSetup: !!o.isencaoSetup,
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

const PACOTES_IMPLANTACAO_VALIDOS = new Set(['padrao', 'intermediario', 'avancado', 'nenhum']);
const PAGAMENTO_IMPLANTACAO_VALIDOS = new Set(['avista', 'metade', 'parcelado']);

/**
 * Configuração do card "Implantação Enterprise" (pacote, sistemas externos,
 * horas adicionais, isenção do setup, forma de pagamento, ganho mensal
 * estimado pro payback) — nunca ia pro payload de salvar-proposta-implantacao,
 * então reabrir uma proposta salva sempre voltava pro pacote/isenção padrão
 * (isento sempre false), mesmo quando o CSM tinha marcado isenção antes de
 * salvar. Ver waipe-diagnostico.html (montarPayloadProposta).
 */
function sanearImplantacaoEnterprise(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    pacoteId: typeof d.pacoteId === 'string' && PACOTES_IMPLANTACAO_VALIDOS.has(d.pacoteId) ? d.pacoteId : 'intermediario',
    sistemasExternos: inteiroEntre(d.sistemasExternos, 0, 50, 0),
    horasAdicionais: numeroOuNulo(d.horasAdicionais, 0, 1000) ?? 0,
    isento: !!d.isento,
    pagamento: typeof d.pagamento === 'string' && PAGAMENTO_IMPLANTACAO_VALIDOS.has(d.pagamento) ? d.pagamento : 'avista',
    ganhoMensal: numeroOuNulo(d.ganhoMensal, 0, 9999999),
  };
}

/**
 * Checkboxes de "Seções desta proposta" (topo da aba Gerar Proposta) — "O
 * Time Digital Proposto" (fichas dos agentes) e "Tempo Devolvido à Gestão"
 * (tabela de horas), cada uma com seu próprio "Incluir". Faltava persistir
 * isso: reabrir uma proposta salva sempre voltava com as duas marcadas,
 * mesmo quando o CSM tinha desmarcado uma antes de salvar. `null`/ausente
 * (proposta salva antes dessa opção existir) sempre vira `true` nos dois —
 * era o único comportamento possível antes.
 */
function sanearSecoesFixasSelecionadas(d) {
  const origem = d && typeof d === 'object' ? d : {};
  return {
    timeDigital: origem.timeDigital !== false,
    tempoDevolvido: origem.tempoDevolvido !== false,
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
export function sanearDadosCliente(d) {
  const origem = d && typeof d === 'object' ? d : {};
  return {
    idNucleo: texto(origem.idNucleo, 60),
    cnpj: texto(origem.cnpj, 20),
    email: texto(origem.email, 200),
    telefone: texto(origem.telefone, 30),
    contatosAdicionais: sanearContatosAdicionais(origem.contatosAdicionais),
  };
}

/**
 * Outros contatos da mesma empresa (nome + telefone), além do telefone
 * principal acima — a Umbler Talk não tem noção de "contatos da mesma
 * empresa" (só telefone por telefone), então essa lista é conceito nosso,
 * guardada no projeto. Usada pelo seletor de contato do card "Conversa no
 * Utalk" (ver iniciarConversaUmblerAcao/historicoConversaUmblerAcao).
 */
function sanearContatosAdicionais(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.slice(0, 8) // teto — nunca precisa de mais que isso na prática
    .map((c) => ({ nome: texto(c?.nome, 120), telefone: texto(c?.telefone, 30) }))
    .filter((c) => c.telefone); // sem telefone, a entrada não serve pra nada
}

/**
 * Resolve qual contato usar pra Umbler Talk: o telefone informado (comparado
 * normalizado via telefoneParaE164 contra o principal + contatosAdicionais do
 * projeto — nunca deixa operar um telefone que não está cadastrado neste
 * projeto) ou, sem telefone informado, o principal (estado.telefone). Devolve
 * `null` quando o telefone efetivo não é válido, ou quando o informado não
 * bate com nenhum contato conhecido do projeto.
 */
function resolverContatoConversa(estado, telefoneInformado) {
  const contatos = [
    { nome: 'Contato principal', telefone: estado.telefone },
    ...sanearContatosAdicionais(estado.contatosAdicionais),
  ];
  if (telefoneInformado) {
    const alvo = telefoneParaE164(telefoneInformado);
    if (!alvo) return null;
    const achado = contatos.find((c) => telefoneParaE164(c.telefone) === alvo);
    return achado ? { telefoneE164: alvo, nome: achado.nome } : null;
  }
  const principal = telefoneParaE164(estado.telefone);
  return principal ? { telefoneE164: principal, nome: 'Contato principal' } : null;
}

const REGIMES_TRIBUTARIOS_VALIDOS = new Set(['Simples Nacional', 'Lucro Presumido', 'Lucro Real']);

/**
 * Dados tributários — só relevantes pra Cliente Novo (origem Moskit) com
 * Gestor ou Bime na proposta (ver precisaDadosTributarios em
 * obterImplantacaoAcao). `preenchidoEm` só é gravado pelo formulário
 * público que o cliente preenche (api/formulario-tributario.js) — uma
 * edição manual do CSM não mexe nesse campo.
 *
 * `senhaCertificado` (em claro) é o valor que este saneamento sempre
 * devolve pra quem lê/edita — vem tanto de um envio novo (campo
 * `senhaCertificado`, texto puro, ex: formulário público ou edição manual)
 * quanto de um valor já salvo (campo `senhaCertificadoCifrada`, decifrado
 * aqui). Nunca é este saneamento que cifra pra gravar — isso é
 * `dadosTributariosParaGravar`, chamado só nos pontos que de fato
 * persistem no ClickUp, senão a senha ficaria em texto puro na description.
 */
export function sanearDadosTributarios(d) {
  const origem = d && typeof d === 'object' ? d : {};
  return {
    regimeTributario: typeof origem.regimeTributario === 'string' && REGIMES_TRIBUTARIOS_VALIDOS.has(origem.regimeTributario)
      ? origem.regimeTributario
      : '',
    cstIcmsCsosn: texto(origem.cstIcmsCsosn, 60),
    pisCofins: texto(origem.pisCofins, 60),
    cfopVendas: texto(origem.cfopVendas, 100),
    numeroUltimaNf: texto(origem.numeroUltimaNf, 60),
    temCertificadoDigital: !!origem.temCertificadoDigital,
    senhaCertificado: typeof origem.senhaCertificado === 'string'
      ? texto(origem.senhaCertificado, 200)
      : (origem.senhaCertificadoCifrada ? descriptografarSegredo(origem.senhaCertificadoCifrada) : ''),
    preenchidoEm: Number.isFinite(Number(origem.preenchidoEm)) && Number(origem.preenchidoEm) > 0 ? Number(origem.preenchidoEm) : null,
  };
}

/**
 * Versão de `dadosTributarios` (já saneado) pronta pra ir no JSON gravado no
 * ClickUp — troca a senha em claro pela forma cifrada (ver
 * criptografarSegredo em _lib/clickup.js) antes de persistir. Chamar SEMPRE
 * antes de qualquer `stringifyWaipeState`/`atualizarTask` que grave
 * dadosTributarios; nunca gravar o objeto saneado direto.
 */
export function dadosTributariosParaGravar(dadosTributarios) {
  const { senhaCertificado, ...resto } = dadosTributarios;
  return { ...resto, senhaCertificadoCifrada: criptografarSegredo(senhaCertificado) };
}

/**
 * Opcionais enquanto é só rascunho de proposta — viram obrigatórios na hora
 * de confirmar o fechamento (ou de criar o projeto direto, sem passar pela
 * proposta), porque o ID Núcleo é o campo que amarra a identificação do
 * cliente entre as ferramentas depois.
 */
export function dadosClienteFaltando(dados) {
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
  const numeroOuZero = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return {
    resumoGeral: texto(origem.resumoGeral, 2000),
    riscoPercebido: RISCO_VALIDOS.has(origem.riscoPercebido) ? origem.riscoPercebido : '',
    causaDaDemora: texto(origem.causaDaDemora, 500),
    satisfacaoPercebida: SATISFACAO_VALIDOS.has(origem.satisfacaoPercebida) ? origem.satisfacaoPercebida : '',
    geradoEm: Number.isFinite(Number(origem.geradoEm)) ? Number(origem.geradoEm) : null,
    // Fatos objetivos calculados no momento em que o relatório foi gerado
    // (ver gerarRelatorioFinalizacaoAcao, api/ia.js) — não editáveis pelo
    // CSM, só revisados/salvos junto com o resto do rascunho.
    diasEmAberto: Number.isFinite(Number(origem.diasEmAberto)) ? Number(origem.diasEmAberto) : null,
    naoComparecimentos: numeroOuZero(origem.naoComparecimentos),
    reagendamentos: numeroOuZero(origem.reagendamentos),
    reagendamentosLondrisoft: numeroOuZero(origem.reagendamentosLondrisoft),
    reagendamentosCliente: numeroOuZero(origem.reagendamentosCliente),
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
    o.vigenciaMeses ? `**Vigência:** ${o.vigenciaMeses} meses${o.isencaoSetup ? ' (setup dos produtos contratados isento)' : ''}` : null,
    o.observacoes ? `**Observações para a implantação:** ${o.observacoes}` : null,
  ].filter(Boolean);
  return linhas.join('\n\n');
}

/**
 * Cria uma subtask tipo "solucao" por item de `solucoes` — usado tanto na
 * criação direta do projeto (solucoes vindas do Moskit ou digitadas à mão)
 * quanto na promoção de uma proposta (outrasSolucoesPropostas), que antes
 * duplicava este mesmo laço.
 */
/**
 * `faseInicial` (opcional, default FASE_ITEM_PADRAO) — usado por
 * criarProjetoImplantacao quando o projeto já nasce "Entregue" (migração):
 * cada item já entra com a fase e o checklist inteiro marcados, em vez de
 * "não iniciado" com nada marcado. Devolve os ids das subtasks criadas, na
 * mesma ordem de `solucoes` — quem chama usa isso pra popular `concluidos`
 * no projeto-pai (só dá pra saber esses ids depois de criados).
 */
export async function criarSubtasksSolucao(projetoId, solucoes, faseInicial) {
  const ids = [];
  for (const o of solucoes) {
    const checklist = jornadaPara(o.produto, o.ambienteMuda);
    const fase = FASES_ITEM_VALIDAS.has(faseInicial) ? faseInicial : FASE_ITEM_PADRAO;
    const subtask = await criarSubtaskAgente(projetoId, {
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
        vigenciaMeses: o.vigenciaMeses ?? null,
        isencaoSetup: !!o.isencaoSetup,
        checklist,
        // checklist pode ser null (produto sem jornada definida ainda, ex:
        // "Outro" ou troca de ambiente do Gestor/Unique — ver jornadaPara) —
        // sem o `|| []` aqui, um item assim marcado "entregue" (migração)
        // quebrava a criação inteira.
        checklistChecks: fase === 'entregue' ? Object.fromEntries((checklist || []).map((_, i) => [i, true])) : {},
        fase,
      }),
    });
    ids.push(subtask.id);
  }
  return ids;
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
  // listarImplantacoes() agora traz subtasks (agentes/soluções) junto na
  // mesma lista (ver subtasks=true, em _lib/clickup.js) — separa os
  // projetos (sem parent) das subtasks (com parent), e usa as subtasks só
  // pra montar "itens" por projeto (nome de cada agente/solução), pro
  // filtro/agrupamento por item na lista não custar 1 chamada por projeto.
  const projetos = tasks.filter((t) => !t.parent);
  const itensPorProjeto = new Map();
  // Fase de cada item (entregue/cancelado/em andamento...) só existe pra
  // subtask tipo "solucao" (Gestor/Simplaz/Unique/BIME APP/Treinamento/
  // Outro) — agente Waipe não tem esse conceito no modelo dele (segue o
  // pipeline escopo→entrega, sem "cancelado" próprio). Por isso os
  // indicadores de "tipo de item" (aba Indicadores) usam só isto, não os
  // agentes Waipe.
  const itensStatusPorProjeto = new Map();
  for (const t of tasks) {
    if (!t.parent) continue;
    const nome = texto(t.name, 120);
    if (nome) {
      if (!itensPorProjeto.has(t.parent)) itensPorProjeto.set(t.parent, []);
      itensPorProjeto.get(t.parent).push(nome);
    }
    const estadoItem = parseWaipeState(t.description);
    if (estadoItem.tipo === 'solucao' && nome) {
      if (!itensStatusPorProjeto.has(t.parent)) itensStatusPorProjeto.set(t.parent, []);
      itensStatusPorProjeto.get(t.parent).push({
        nome,
        // Nome-base do produto (sem " — Plano"), pra agrupar variações do
        // mesmo produto num "tipo de item" só nos indicadores.
        produtoBase: texto(estadoItem.produto, 60) || nome.split(' — ')[0].trim(),
        fase: FASES_ITEM_VALIDAS.has(estadoItem.fase) ? estadoItem.fase : FASE_ITEM_PADRAO,
      });
    }
  }
  const linhas = projetos.map((t) => {
    const estado = parseWaipeState(t.description);
    return {
      id: t.id,
      // Mesma preferência de obterImplantacaoAcao: "cliente" salvo no estado,
      // não o nome da task (que acumula sufixo "— Proposta — <data>" a cada
      // save) — senão a lista "Carregar proposta salva" e o dashboard mostram
      // o nome já sujo.
      cliente: texto(estado.cliente, 120) || limparSufixoProposta(t.name),
      status: t.status?.status || '',
      etapaAtual: ETAPAS_VALIDAS.has(estado.etapaAtual) ? estado.etapaAtual : 'escopo',
      csm: csmDaDescricaoImplantacao(t.description),
      ism: nomesIsm(ismIdsDoProjeto(t, estado).map((id) => ({ id }))),
      ismIds: ismIdsDoProjeto(t, estado),
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
      urgencia: sanearUrgencia(estado.urgencia),
      dataCriacao: Number.isFinite(Number(t.date_created)) ? Number(t.date_created) : null,
      // Última atualização nativa da task — usada pelo gatilho de "projeto
      // parado" da fila CSQ (ver atividadesVirtuaisParadas), não gravada
      // aqui, só exposta pra listagem em massa dar pra calcular sem 1
      // chamada por projeto.
      dataAtualizacao: Number.isFinite(Number(t.date_updated)) ? Number(t.date_updated) : null,
      // Datas reais (ver criarProjetoImplantacao/atualizarImplantacaoAcao) e
      // o relatório de finalização — precisam vir na listagem em massa (não
      // só na tela de 1 projeto aberto) pra dar pra agregar num dashboard de
      // indicadores sem 1 chamada por projeto.
      dataInicioReal: Number.isFinite(Number(estado.dataInicioReal)) ? Number(estado.dataInicioReal) : null,
      dataFimReal: Number.isFinite(Number(estado.dataFimReal)) ? Number(estado.dataFimReal) : null,
      // Pausa de SLA (ver FASES_SLA_PAUSADAS/atualizarImplantacaoAcao) — o
      // front soma isso ao calcular o prazo (slaInfo), pra tempo parado
      // esperando agendamento/cliente não contar como atraso nosso.
      pausaSlaDesde: Number.isFinite(Number(estado.pausaSlaDesde)) ? Number(estado.pausaSlaDesde) : null,
      pausaSlaAcumuladaDiasUteis: Number.isFinite(Number(estado.pausaSlaAcumuladaDiasUteis)) ? Number(estado.pausaSlaAcumuladaDiasUteis) : 0,
      finalizacao: sanearFinalizacao(estado.finalizacao),
      temMensagemNova: temMensagemNovaParaViewer(estado, sessao),
      // Alertas (🚨) — campo NATIVO do ClickUp (ver CAMPO_ALERTAS), não
      // WaipeState — precisa vir na listagem em massa pra dar pra filtrar
      // a aba de Entregues por alerta sem 1 chamada por projeto.
      ...alertasDaTask(t),
      // Nome de cada agente/solução do projeto (ex: "Simplaz Gestor —
      // Bronze", "BIME APP") — usado pro filtro/agrupamento por item.
      itens: itensPorProjeto.get(t.id) || [],
      // { nome, produtoBase, fase } de cada item tipo "solucao" — usado
      // pelos indicadores por tipo de item (aba Indicadores > Gráficos).
      itensStatus: itensStatusPorProjeto.get(t.id) || [],
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
          vigenciaMeses: VIGENCIAS_DEPLOY_VALIDAS.has(e.vigenciaMeses) ? e.vigenciaMeses : null,
          isencaoSetup: !!e.isencaoSetup,
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
      // Preferir o "cliente" salvo no estado (ver salvarPropostaImplantacaoAcao)
      // — o nome da task ganha um sufixo "— Proposta — <data>" a cada save,
      // então usá-lo aqui faria esse sufixo (às vezes mais de um, acumulado)
      // ir parar de novo no campo "Nome do cliente" ao reabrir pra editar.
      // Cai pro nome da task (limpo do sufixo de data) só pra projetos salvos
      // antes dessa mudança.
      cliente: texto(estadoProjeto.cliente, 120) || limparSufixoProposta(pai.name),
      status: pai.status?.status || '',
      csm,
      ism: nomesIsm(ismIdsDoProjeto(pai, estadoProjeto).map((id) => ({ id }))),
      ismIds: ismIdsDoProjeto(pai, estadoProjeto),
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
      urgencia: sanearUrgencia(estadoProjeto.urgencia),
      // Datas reais — precisam vir aqui também (não só na listagem em massa)
      // pra dar pra calcular o badge de SLA na tela do projeto aberto.
      dataInicioReal: Number.isFinite(Number(estadoProjeto.dataInicioReal)) ? Number(estadoProjeto.dataInicioReal) : null,
      dataFimReal: Number.isFinite(Number(estadoProjeto.dataFimReal)) ? Number(estadoProjeto.dataFimReal) : null,
      pausaSlaDesde: Number.isFinite(Number(estadoProjeto.pausaSlaDesde)) ? Number(estadoProjeto.pausaSlaDesde) : null,
      pausaSlaAcumuladaDiasUteis: Number.isFinite(Number(estadoProjeto.pausaSlaAcumuladaDiasUteis)) ? Number(estadoProjeto.pausaSlaAcumuladaDiasUteis) : 0,
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
      implantacaoEnterprise: sanearImplantacaoEnterprise(estadoProjeto.implantacaoEnterprise) || null,
      secoesFixasSelecionadas: sanearSecoesFixasSelecionadas(estadoProjeto.secoesFixasSelecionadas),
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
      contatosAdicionais: sanearContatosAdicionais(estadoProjeto.contatosAdicionais),
      // Vendedor do negócio no Moskit (quem fechou a venda) — separado do CSM
      // de propósito: CSM aqui é o gerente de contas que assume a partir da
      // implantação, um papel diferente.
      vendedor: texto(estadoProjeto.vendedor, 120),
      // Nome puro do cliente (sem prefixo do nome do projeto) — usado por
      // definir-gerente-contas pra criar o cliente na Carteira.
      clienteNome: texto(estadoProjeto.cliente, 120),
      finalizacao: sanearFinalizacao(estadoProjeto.finalizacao),
      temMensagemNova: temMensagemNovaParaViewer(estadoProjeto, sessao),
      anexos: mapearAnexos(pai.attachments),
      // Alertas (🚨) — campo NATIVO do ClickUp (não é WaipeState), lido
      // direto de pai.custom_fields; ver alertasDaTask/CAMPO_ALERTAS. É o
      // MESMO campo da Carteira: gravar aqui espelha lá, e vice-versa.
      ...alertasDaTask(pai),
      ...dadosTributariosCampos(estadoProjeto, agentes, pai.id),
    },
    agentes,
  });
}

/**
 * Dados tributários só existem (e o link do formulário só é útil) quando o
 * projeto veio da automação do Moskit ("Cliente Novo") E tem pelo menos uma
 * solução Gestor ou Bime — clientes já existentes, ou sem nenhum dos dois,
 * não passam pelo processo de coleta tributária. `agentes` é a lista já
 * montada por obterImplantacaoAcao (agentes + soluções da task).
 */
function dadosTributariosCampos(estadoProjeto, agentes, projetoId) {
  const dadosTributarios = sanearDadosTributarios(estadoProjeto.dadosTributarios);
  const precisaDadosTributarios = !!estadoProjeto.origemMoskitDealId
    && agentes.some((a) => a.tipo === 'solucao' && (a.produto === 'Gestor' || a.produto === 'Bime'));
  const linkFormularioTributario = precisaDadosTributarios && !dadosTributarios.preenchidoEm
    ? `/formulario-tributario.html?id=${projetoId}&token=${assinarTokenProjeto(projetoId)}`
    : null;
  return { dadosTributarios, precisaDadosTributarios, linkFormularioTributario };
}

/**
 * Cria o projeto (task-pai) e uma subtask por agente. So e chamada depois que
 * a pessoa revisou/editou o resultado da extração por IA na tela — a chamada
 * de IA em si roda no navegador (capability `sample`), nunca aqui.
 */
/**
 * Núcleo comum de "criar o projeto de implantação de verdade" — task-pai +
 * subtasks de agente e/ou solução. Chamado tanto por criarImplantacaoAcao
 * (via HTTP, sessão de CSM) quanto pela automação do webhook do Moskit
 * (api/moskit-webhook.js, sem sessão nenhuma) — por isso não recebe req/res,
 * só dados já saneados e validados por quem chama.
 *
 * `origemMoskitDealId` (opcional) marca projetos nascidos da automação — é
 * a chave de idempotência que o webhook usa pra não criar duplicata quando
 * o mesmo evento chega mais de uma vez.
 *
 * `origemMoskitProjetoId` (opcional) é o mesmo tipo de marca, só que pro
 * script de migração em massa dos Projetos do Moskit (módulo Projetos,
 * diferente de Negócios — ver scripts/migrar-moskit-projetos.mjs): evita
 * recriar a mesma task se o script rodar de novo.
 */
// Origem pública do painel — usada só pra montar link ABSOLUTO em mensagem
// externa (WhatsApp); dentro do próprio painel os links são sempre
// relativos. Mesmo domínio já hardcoded em outros lugares (dashboard_
// carteiras.html, API_ORIGIN_OK em implantacao-waipe.html).
const SITE_ORIGEM = 'https://diretoriocs.vercel.app';

/**
 * Dispara o webhook de boas-vindas (flow do Waipe Flow, node trigger_webhook)
 * pro cliente novo que acabou de ganhar o link do formulário tributário —
 * SÓ quando `notificarClienteNovo` vem true (ver criarProjetoImplantacao).
 * Nunca lança: falha aqui não pode derrubar a criação do projeto. Fica
 * inerte (não faz nada) enquanto WAIPE_FLOW_WEBHOOK_URL_BOAS_VINDAS não
 * estiver configurada — é assim que "implementar a chamada já" fica seguro
 * antes do flow existir de verdade no Waipe Flow.
 */
async function notificarClienteNovoWaipeFlow({ cliente, telefone, linkFormularioTributario }) {
  const url = process.env.WAIPE_FLOW_WEBHOOK_URL_BOAS_VINDAS;
  if (!url || !linkFormularioTributario) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.WAIPE_FLOW_WEBHOOK_TOKEN_BOAS_VINDAS
          ? { 'X-Waipe-Token': process.env.WAIPE_FLOW_WEBHOOK_TOKEN_BOAS_VINDAS }
          : {}),
      },
      body: JSON.stringify({
        tipo: 'cliente_novo',
        cliente,
        telefone: telefone || '',
        linkFormularioTributario: `${SITE_ORIGEM}${linkFormularioTributario}`,
      }),
    });
    if (!r.ok) console.error(`[clickup] webhook boas-vindas Waipe Flow respondeu ${r.status}`);
  } catch (e) {
    console.error('[clickup] falha ao chamar webhook de boas-vindas do Waipe Flow:', e);
  }
}

export async function criarProjetoImplantacao({
  nomeProjeto, cliente, contexto, dadosCliente, agentes, solucoes, ismProjeto, csmNome, vendedor,
  origemMoskitDealId, origemMoskitProjetoId, faseProjetoManual, dataInicioReal, dataFimReal,
  // Só true quando quem chama SABE que é uma criação ao vivo de verdade (a
  // automação do Moskit, hoje pausada — ver webhook_moskit_pausado) — NUNCA
  // passar true de um script de migração/backfill: contaria como "cliente
  // recém-chegado" pra um cliente cuja implantação já é história, e
  // mandaria uma mensagem de boas-vindas indevida pra um número real.
  // Default false é o que mantém todo script de migração desta sessão
  // (e qualquer um futuro que não passe isso explicitamente) inofensivo.
  notificarClienteNovo = false,
}) {
  // Projeto que já nasce "Entregue" OU "Cancelado" (ex: migração de um
  // projeto do Moskit que já estava finalizado de verdade, entregue ou não)
  // precisa refletir isso em MAIS que só essa flag — senão o projeto
  // continua aparecendo em "Projetos em Andamento" (aquela aba filtra pelo
  // status NATIVO do ClickUp, não pela fase — ver listarImplantacoesAcao).
  // "Cancelado" não marca os itens como concluídos (nada foi entregue de
  // verdade) — só "Entregue" faz isso; os dois igualmente carimbam
  // dataFimReal e tiram o status nativo de "pendente"/"in progress".
  const jaEntregue = faseProjetoManual === 'entregue';
  const finalizado = jaEntregue || faseProjetoManual === 'cancelado';
  // Calculadas uma vez só e reaproveitadas nos dois stringifyWaipeState
  // abaixo (criação + o follow-up de finalização) — senão dois
  // `Date.now()` em momentos diferentes da mesma criação divergiam por
  // alguns milissegundos à toa.
  const dataInicioRealFinal = Number.isFinite(Number(dataInicioReal)) ? Number(dataInicioReal) : Date.now();
  const dataFimRealFinal = Number.isFinite(Number(dataFimReal)) ? Number(dataFimReal) : (finalizado ? Date.now() : null);
  const descricaoProjeto = stringifyWaipeState(
    // Sem csmNome (projeto ainda sem gerente de contas, ver
    // definir-gerente-contas), a linha "**CSM:**" nem entra — deixá-la vazia
    // faria csmDaDescricaoImplantacao (regex "CSM:\s*(.+)", \s cruza linha
    // em branco) capturar o começo do CONTEXTO como se fosse o nome do CSM.
    [csmNome ? `**CSM:** ${csmNome}` : null, contexto].filter(Boolean).join('\n\n'),
    {
      etapaAtual: 'escopo',
      prioridade: [],
      agenteAtualId: null,
      concluidos: [],
      agentesTotal: agentes.length + solucoes.length,
      // Nome puro do cliente (sem prefixo tipo "Cliente Novo - ") — usado
      // depois por definir-gerente-contas pra criar o cliente na Carteira
      // sem precisar re-parsear o nome do projeto.
      cliente: texto(cliente, 120),
      vendedor: texto(vendedor, 120),
      origemMoskitDealId: origemMoskitDealId ?? null,
      origemMoskitProjetoId: origemMoskitProjetoId ?? null,
      // Override manual de fase na criação — usado pela migração vinda do
      // Moskit quando o projeto já nasce sabidamente "Entregue"/"Cancelado"
      // etc. (ver FASES_ITEM_VALIDAS); null preserva o comportamento
      // automático de sempre (faseEfetiva cai pra faseProjetoDerivada).
      faseProjetoManual: FASES_ITEM_VALIDAS.has(faseProjetoManual) ? faseProjetoManual : null,
      // Data real de início/entrega — diferente de `dataCriacao` (nativo do
      // ClickUp, imutável): existe só pra dar duração certa a projeto
      // migrado, cuja task só passou a existir no ClickUp muito depois do
      // início de verdade no Moskit. `dataInicioReal` sempre grava algo (o
      // valor dado, ou agora — mesmo comportamento de sempre pra projeto
      // novo); `dataFimReal` só grava se vier explícito (projeto migrado já
      // entregue) — em projeto novo fica null até finalizar de verdade
      // (ver atualizarImplantacaoAcao, que carimba isso sozinho na hora).
      dataInicioReal: dataInicioRealFinal,
      dataFimReal: dataFimRealFinal,
      // Fallback contra o mesmo descarte silencioso de `assignees` que
      // atualizarImplantacaoAcao trata (ver comentário lá) — já nasce
      // preenchido, não só numa edição posterior.
      ismIds: sanearAssignees(ismProjeto),
      ...dadosCliente,
    }
  );

  const projeto = await criarTaskImplantacao({
    name: nomeProjeto,
    markdown_description: descricaoProjeto,
    assignees: ismProjeto,
  });

  const idsCriados = [];
  for (const a of agentes) {
    const descricaoAgenteTask = stringifyWaipeState(descricaoAgente(a.estrutura), {
      tipo: 'agente',
      estrutura: a.estrutura,
      buildChecks: {},
      testChecks: {},
      entregaChecks: {},
      prereqChecks: {},
      diagnostico: {},
      validacao: jaEntregue ? { status: 'validado', motivo: '' } : { status: 'pendente', motivo: '' },
    });
    const subtask = await criarSubtaskAgente(projeto.id, {
      name: a.estrutura.nome,
      markdown_description: descricaoAgenteTask,
      assignees: a.ism,
    });
    idsCriados.push(subtask.id);
  }

  idsCriados.push(...await criarSubtasksSolucao(projeto.id, solucoes, jaEntregue ? 'entregue' : undefined));

  if (finalizado) {
    await atualizarTask(projeto.id, {
      markdown_description: stringifyWaipeState(
        [csmNome ? `**CSM:** ${csmNome}` : null, contexto].filter(Boolean).join('\n\n'),
        {
          etapaAtual: jaEntregue ? 'entrega' : 'escopo',
          prioridade: [],
          agenteAtualId: null,
          // Cancelado não marca os itens como concluídos — nada foi
          // entregue de verdade, só encerrado.
          concluidos: jaEntregue ? idsCriados : [],
          agentesTotal: agentes.length + solucoes.length,
          cliente: texto(cliente, 120),
          vendedor: texto(vendedor, 120),
          origemMoskitDealId: origemMoskitDealId ?? null,
          origemMoskitProjetoId: origemMoskitProjetoId ?? null,
          faseProjetoManual,
          dataInicioReal: dataInicioRealFinal,
          dataFimReal: dataFimRealFinal,
          ...dadosCliente,
        }
      ),
      status: 'concluído',
    });
  }

  // Mesmo critério de "precisa de dados tributários" de dadosTributariosCampos
  // (Moskit + Gestor/Bime), calculado aqui a partir de `solucoes` (o array já
  // tem `.produto`) porque neste ponto ainda não existe o `agentes` no
  // formato pós-obterImplantacaoAcao. Projeto que já nasce finalizado
  // (migração de algo já entregue/cancelado) nunca dispara — não é
  // "recém-chegado", é história sendo registrada.
  if (notificarClienteNovo && !finalizado) {
    const precisaDadosTributarios = !!origemMoskitDealId
      && solucoes.some((s) => s.produto === 'Gestor' || s.produto === 'Bime');
    if (precisaDadosTributarios) {
      // Link CURTO aqui (não o completo de formulario-tributario.html?id=...)
      // — pedido explícito da usuária pro texto caber melhor na mensagem de
      // WhatsApp; mantém "/formulario-tributario" no caminho de propósito,
      // pra quem recebe reconhecer que é o link certo (ver assinarLinkCurto/
      // api/formulario-tributario.js).
      const linkFormularioTributario = `/formulario-tributario/${assinarLinkCurto(projeto.id)}`;
      await notificarClienteNovoWaipeFlow({
        cliente: texto(cliente, 120),
        telefone: dadosCliente?.telefone,
        linkFormularioTributario,
      });
    }
  }

  return projeto;
}

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

  const solucoesRaw = Array.isArray(corpo.solucoes) ? corpo.solucoes.slice(0, MAX_OUTRAS_SOLUCOES) : [];
  const solucoes = solucoesRaw.map(sanearOutraSolucao).filter(Boolean);

  // Projeto não precisa mais ser baseado em agente Waipe — pode nascer só
  // com solução (troca de plano Gestor, inclusão de usuário BIME, etc.).
  if (!agentes.length && !solucoes.length) {
    return erro(res, 400, 'nada_para_promover', 'É preciso ao menos um agente ou uma solução.');
  }
  const ismProjeto = sanearAssignees(corpo.ismProjeto);

  const csmNome = texto(sessao.nome, 120) || sessao.csm || sessao.nivel;

  const projeto = await criarProjetoImplantacao({
    nomeProjeto: `${cliente} — Implantação Waipe`, cliente, contexto, dadosCliente, agentes, solucoes, ismProjeto, csmNome,
  });

  return res.status(200).json({ ok: true, id: projeto.id });
}

/**
 * POST ?action=definir-gerente-contas { id } — sorteia (rodízio fixo,
 * ordem de GERENTE_OPCOES) o próximo Gerente de Contas pra um projeto
 * ainda sem CSM, grava a atribuição no projeto e já cria o cliente na
 * lista Carteiras — substitui o processo manual de buscar no
 * Londriconnect pra dar entrada num cliente novo. Exige ID Núcleo já
 * preenchido (e diferente do placeholder "0" que o Comercial usa): sem
 * isso o cliente entraria na carteira sem identificação nenhuma.
 */
async function definirGerenteContasAcao(req, res, sessao) {
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
  const { tarefa, projeto } = resolvido;
  if (tarefa.id !== projeto.id) {
    return erro(res, 400, 'task_invalida', 'Defina o gerente a partir da task do projeto, não de uma subtask.');
  }

  const csmAtual = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csmAtual, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }
  if (csmAtual) {
    return erro(res, 409, 'gerente_ja_definido', 'Este projeto já tem um gerente de contas definido.');
  }

  const estadoAtual = parseWaipeState(projeto.description);
  const idNucleo = texto(estadoAtual.idNucleo, 60);
  if (!idNucleo || idNucleo === '0') {
    return erro(res, 400, 'id_nucleo_pendente', 'Preencha o ID Núcleo antes de definir o gerente de contas.');
  }

  // Rodízio: acha, entre os projetos que já passaram por este fluxo, o de
  // rodizioEm mais recente, e soma 1 (mod N) ao índice dele. Sem nenhum
  // ainda, começa do primeiro da lista (índice 0).
  const projetos = await listarImplantacoes();
  let ultimoIndex = -1;
  let ultimoEm = -1;
  for (const t of projetos) {
    const e = parseWaipeState(t.description);
    const em = Number(e.rodizioEm);
    if (Number.isFinite(em) && em > ultimoEm && Number.isInteger(e.rodizioIndex)) {
      ultimoEm = em;
      ultimoIndex = e.rodizioIndex;
    }
  }
  const proximoIndex = (ultimoIndex + 1) % GERENTE_OPCOES.length;
  const gerente = GERENTE_OPCOES[proximoIndex];

  const contexto = contextoSemEstado(projeto.description);
  await atualizarTask(projeto.id, {
    markdown_description: stringifyWaipeState(
      [`**CSM:** ${gerente.nome}`, contexto].filter(Boolean).join('\n\n'),
      { ...estadoAtual, rodizioIndex: proximoIndex, rodizioEm: Date.now() }
    ),
  });

  await criarClienteCarteira({
    nome: texto(estadoAtual.cliente, 120) || projeto.name,
    idNucleo,
    cnpj: texto(estadoAtual.cnpj, 20),
    gerenteOpcaoId: gerente.id,
  });

  return res.status(200).json({ ok: true, gerente: gerente.nome });
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

  // Relatório de finalização (satisfação/risco percebido etc.) é métrica do
  // próprio desempenho de quem executou o projeto — só Gestão pode gravar,
  // pra a primeira versão salva ser sempre a da rotina automática (ver
  // api/cron/relatorio-finalizacao.js), nunca editada por ISM/CSM antes de
  // alguém revisar. Isso vale tanto pra primeira geração quanto pra edição
  // posterior — não é permitido nenhum dos dois fora de "gestao".
  if ('finalizacao' in corpo && sessao.nivel !== 'gestao') {
    return erro(res, 403, 'somente_gestao', 'Só a Gestão pode editar o relatório de finalização.');
  }

  const estadoAtual = parseWaipeState(tarefa.description);
  // Calculada antes do objeto pra poder decidir o carimbo de dataFimReal
  // logo abaixo — mesma regra usada dentro do objeto (ver faseProjetoManual).
  const novaFaseProjetoManual = 'faseProjetoManual' in corpo
    ? (FASES_ITEM_VALIDAS.has(corpo.faseProjetoManual) ? corpo.faseProjetoManual : null)
    : (FASES_ITEM_VALIDAS.has(estadoAtual.faseProjetoManual) ? estadoAtual.faseProjetoManual : null);
  // Mesma lógica de transição usada pro carimbo de dataFimReal logo abaixo,
  // mas pra pausa de SLA (ver FASES_SLA_PAUSADAS) — precisa saber se a fase
  // ANTERIOR e a NOVA estão (ou não) numa fase que pausa o relógio.
  const estavaPausadoSla = FASES_SLA_PAUSADAS.has(estadoAtual.faseProjetoManual);
  const estaPausadoSla = FASES_SLA_PAUSADAS.has(novaFaseProjetoManual);

  // Só pode ENTRAR em "entregue"/"cancelado" (isso que finaliza o projeto,
  // ver finalizado/jaEntregue em criarProjetoImplantacao) com todo item já
  // concluído — mesmo critério de itemConcluido()/todosItensConcluidos()
  // do front, que já trava o botão "Gerar relatório de finalização", mas
  // só no front: sem essa checagem aqui, dava pra forçar a fase do projeto
  // pela API direto (ou por um bug de UI) com item pendente e ele sumir da
  // aba "Projetos em Andamento" mesmo com trabalho real ainda em aberto.
  // Só valida numa TRANSIÇÃO de verdade — resalvar a mesma fase de novo
  // (ex: outra edição qualquer no projeto já entregue) não passa por aqui.
  if (
    (novaFaseProjetoManual === 'entregue' || novaFaseProjetoManual === 'cancelado') &&
    novaFaseProjetoManual !== estadoAtual.faseProjetoManual
  ) {
    const { subtasks } = await obterTaskComSubtasks(projeto.id);
    if (!todosItensConcluidos(subtasks)) {
      return erro(res, 400, 'itens_pendentes', 'Todos os itens do projeto precisam estar Entregues ou Cancelados antes de marcar o projeto inteiro como Entregue/Cancelado.');
    }
  }
  const novoEstado = {
    // Espalha o estado atual ANTES dos campos explícitos abaixo — garante
    // que qualquer campo que não seja mexido aqui (origemMoskitDealId,
    // vendedor, cliente, rodizioIndex/rodizioEm, e qualquer campo novo que
    // vier a existir) sobrevive a um atualizar-implantacao comum. Antes essa
    // lista era montada campo a campo sem essa base, e qualquer edição do
    // dia a dia (salvar fase, dados do cliente, camada1Checks...) apagava
    // silenciosamente tudo que não estivesse citado aqui — foi assim que
    // origemMoskitDealId sumia e derrubava precisaDadosTributarios (e
    // quebraria a idempotência do webhook do Moskit) na primeira edição
    // manual depois da automação criar o projeto.
    ...estadoAtual,
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
    faseProjetoManual: novaFaseProjetoManual,
    // Carimbo automático do momento real da entrega — só na PRIMEIRA vez
    // que a fase vira "entregue" (não sobrescreve se já tinha uma data,
    // ex: migração que já veio com dataFimReal setado na criação). Sem
    // isso, a usuária precisaria lembrar de preencher isso à mão toda vez
    // que finaliza um projeto pra "dias de projeto" sair certo depois.
    //
    // Reabrir (fase manual sai de "entregue"/"cancelado" pra qualquer outra,
    // ex: pendência identificada depois) LIMPA dataFimReal — senão, ao
    // entregar de novo depois, a data antiga ficaria presa e "dias de
    // implantação" contaria errado. "Cancelado" carimba a mesma data —
    // também é um jeito de finalizar o projeto, só que sem entrega real.
    dataFimReal: (novaFaseProjetoManual === 'entregue' || novaFaseProjetoManual === 'cancelado')
      ? (estadoAtual.dataFimReal || Date.now())
      : (
          (estadoAtual.faseProjetoManual === 'entregue' || estadoAtual.faseProjetoManual === 'cancelado') &&
          novaFaseProjetoManual !== 'entregue' &&
          novaFaseProjetoManual !== 'cancelado'
            ? null
            : (estadoAtual.dataFimReal ?? null)
        ),
    // Pausa de SLA — entra em pausa (carimba pausaSlaDesde) na transição pra
    // "agendado"/"aguardando_cliente"; ao SAIR de uma dessas fases, soma os
    // dias úteis que passou pausado no acumulador e limpa o carimbo. Ficar
    // "dentro" da pausa (ex: agendado -> aguardando_cliente, as duas
    // pausam) não reinicia a contagem, só continua correndo a partir do
    // mesmo pausaSlaDesde. Ver slaInfo() no front — soma acumulado +
    // (se ainda pausado agora) o trecho corrente antes de calcular o prazo.
    pausaSlaDesde: estaPausadoSla
      ? (estavaPausadoSla ? (estadoAtual.pausaSlaDesde || Date.now()) : Date.now())
      : null,
    pausaSlaAcumuladaDiasUteis: (!estaPausadoSla && estavaPausadoSla && estadoAtual.pausaSlaDesde)
      ? (Number(estadoAtual.pausaSlaAcumuladaDiasUteis) || 0) + diasUteisEntre(estadoAtual.pausaSlaDesde, Date.now())
      : (Number(estadoAtual.pausaSlaAcumuladaDiasUteis) || 0),
    // Urgencia — mesmo padrao: so muda quando vem no corpo, senao o spread
    // de estadoAtual (logo acima) ja preserva. So repete aqui pra sanear
    // caso venha um valor invalido no corpo. NUNCA usar a chave
    // "prioridade" aqui — ela já é a ordem dos agentes Waipe (linha acima),
    // um array; sobrescrever com a urgência destruiria esse array.
    ...('urgencia' in corpo ? { urgencia: sanearUrgencia(corpo.urgencia) } : {}),
    // Dados de identificação do cliente — só muda quando vem no corpo (edição
    // vinda do "Resumo do projeto"), senão preserva o que já estava gravado,
    // mesmo padrão de faseProjetoManual logo acima.
    ...(('idNucleo' in corpo || 'cnpj' in corpo || 'email' in corpo || 'telefone' in corpo || 'contatosAdicionais' in corpo)
      ? sanearDadosCliente(corpo)
      : sanearDadosCliente(estadoAtual)),
    // Relatório de finalização — mesmo padrão de faseProjetoManual/dadosCliente:
    // só muda quando vem explicitamente no corpo (edição feita na tela de
    // finalização), senão preserva o que já estava salvo.
    finalizacao: 'finalizacao' in corpo
      ? sanearFinalizacao(corpo.finalizacao)
      : sanearFinalizacao(estadoAtual.finalizacao),
    // Dados tributários — mesmo padrão de faseProjetoManual/dadosCliente:
    // só muda quando vem no corpo (edição no "Resumo do projeto"), senão
    // preserva o que já estava salvo (inclusive o preenchidoEm gravado pelo
    // formulário público, que uma edição manual do CSM não deve apagar).
    // dadosTributariosParaGravar cifra a senha do certificado antes de ir
    // pro JSON gravado (sanearDadosTributarios só devolve em claro).
    dadosTributarios: dadosTributariosParaGravar(
      'dadosTributarios' in corpo
        ? sanearDadosTributarios(corpo.dadosTributarios)
        : sanearDadosTributarios(estadoAtual.dadosTributarios)
    ),
    // Cópia de segurança do ISM em texto (dentro do próprio JSON de estado,
    // só números — nenhum risco da corrupção por aspas literais que afeta
    // campos de texto livre) — o `assignees` nativo do ClickUp às vezes é
    // descartado em silêncio quando a pessoa não tem acesso de guest
    // configurado NESTA lista específica (mesmo bug documentado em
    // responsavelIdDaReserva/assigneeIdDaAtividade, aqui confirmado também
    // em LISTA_IMPLANTACOES_WAIPE) — sem isso, o painel mostrava "ISM
    // atualizado" (a chamada em si nunca falha) mas o valor sumia no
    // próximo carregamento. Só muda quando vem no corpo, senão preserva.
    ismIds: Array.isArray(corpo.ism) ? sanearAssignees(corpo.ism) : (estadoAtual.ismIds || []),
  };

  const payload = { markdown_description: stringifyWaipeState(tarefa.description, novoEstado) };
  if (typeof corpo.status === 'string' && STATUS_IMPLANTACAO_VALIDOS.has(corpo.status)) {
    payload.status = corpo.status;
  } else if (novaFaseProjetoManual === 'entregue' || novaFaseProjetoManual === 'cancelado') {
    // Entrar em "entregue" OU "cancelado" marca o status nativo como
    // "concluído" — é só esse status nativo que decide a aba "Projetos
    // Finalizados" (renderListaProjetosWrap filtra por ele, não pela fase
    // manual). Sem isso um projeto cancelado fica preso em "Em Andamento".
    if (projeto.status?.status !== 'concluído') {
      payload.status = 'concluído';
    }
  } else if (
    (estadoAtual.faseProjetoManual === 'entregue' || estadoAtual.faseProjetoManual === 'cancelado') &&
    projeto.status?.status === 'concluído'
  ) {
    // Reabrir o projeto (fase manual sai de "entregue"/"cancelado" pra
    // qualquer outra) tem que tirar o status nativo de "concluído" também —
    // senão o projeto continua aparecendo em "Projetos Finalizados" (aquela
    // aba filtra pelo status nativo, não pela fase) mesmo já mostrando
    // outra etiqueta.
    payload.status = 'in progress';
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

  // Alertas (🚨) é campo NATIVO do ClickUp (mesmo campo anexado também à
  // Carteira — ver CAMPO_ALERTAS/espelharAlertas), não faz parte do
  // WaipeState: só mexe quando vem explicitamente no corpo, numa chamada
  // separada da task normal acima. Reaproveita a MESMA allowlist da
  // Carteira (CAMPOS_ESCRITA[CAMPO_ALERTAS].opcoes) — um id novo só passa a
  // ser aceito aqui no dia em que também for aceito lá.
  if ('alertas' in corpo) {
    const valor = validarValor(CAMPOS_ESCRITA[CAMPO_ALERTAS], corpo.alertas);
    if (valor === undefined) {
      return erro(res, 403, 'valor_nao_permitido', 'Valor não permitido para o campo Alertas.');
    }
    await gravarCampo(corpo.id, CAMPO_ALERTAS, valor);
    const idNucleoAtual = texto(novoEstado.idNucleo, 60);
    if (idNucleoAtual) {
      try {
        await espelharAlertas(LISTA_IMPLANTACOES_WAIPE, idNucleoAtual, valor);
      } catch (e) {
        console.error('[clickup] falha ao espelhar alertas na carteira:', e);
      }
    }
  }

  return res.status(200).json({ ok: true });
}

/**
 * POST ?action=renomear-implantacao { id, nome } — corrige o nome do
 * projeto (a task-pai, nunca uma subtask de agente/solução — essas têm
 * nome derivado do produto/plano, ver criarSubtasksSolucao). Existe porque
 * o nome vem do Moskit/vendedor na criação e às vezes precisa de ajuste
 * manual depois (ex: padronização, erro de digitação).
 */
async function renomearImplantacaoAcao(req, res, sessao) {
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
  const { tarefa, projeto } = resolvido;
  if (tarefa.id !== projeto.id) {
    return erro(res, 400, 'task_invalida', 'Renomeie a partir da task do projeto, não de uma subtask.');
  }

  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const nome = texto(corpo.nome, 200);
  if (!nome) {
    return erro(res, 400, 'nome_invalido', 'Nome é obrigatório.');
  }

  // O painel NUNCA mostra o "name" nativo da task pro usuário — mostra
  // "cliente" salvo no WaipeState (ver listarImplantacoesAcao/
  // obterImplantacaoAcao, que preferem estado.cliente de propósito, pra não
  // herdar o sufixo "— Proposta — <data>" que o nome da task acumula).
  // Sem atualizar os dois aqui, o "Salvar" parecia funcionar na hora (a UI
  // atualiza o cache local otimisticamente) mas o nome revertia sozinho ao
  // reabrir o projeto, porque só o "name" nativo tinha mudado.
  const estadoAtual = parseWaipeState(tarefa.description);
  await atualizarTask(corpo.id, {
    name: nome,
    markdown_description: stringifyWaipeState(tarefa.description, { ...estadoAtual, cliente: nome }),
  });

  return res.status(200).json({ ok: true, nome });
}

/**
 * POST ?action=adicionar-item-implantacao { id, produto, planoSugerido?,
 * variante?, motivo?, observacoes?, quantidade?, valorManual? } — cria um
 * novo item (subtask "solução") num projeto já existente. Existe pro caso
 * de o ISM descobrir, já durante a implantação, que falta algo que o
 * vendedor não tinha identificado na criação (ex: vendedor marcou "sem
 * treinamento" e o ISM percebe que o cliente precisa) — sem isso, não
 * havia como registrar/executar esse item dentro do projeto, só por fora.
 * O item novo sempre nasce "não iniciado" (nunca herda a fase do projeto),
 * mesmo que o projeto já esteja "entregue" — é trabalho novo, ainda por
 * fazer.
 */
async function adicionarItemImplantacaoAcao(req, res, sessao) {
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
  const { tarefa, projeto } = resolvido;
  if (tarefa.id !== projeto.id) {
    return erro(res, 400, 'task_invalida', 'Adicione o item a partir da task do projeto, não de uma subtask.');
  }

  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const solucao = sanearOutraSolucao(corpo);
  if (!solucao) {
    return erro(res, 400, 'produto_invalido', 'Produto inválido.');
  }

  const estadoAtual = parseWaipeState(projeto.description);
  const agentesTotalAtual = Number.isFinite(estadoAtual.agentesTotal) ? estadoAtual.agentesTotal : 0;
  if (agentesTotalAtual >= MAX_AGENTES + MAX_OUTRAS_SOLUCOES) {
    return erro(res, 400, 'limite_itens', 'Este projeto já atingiu o limite de itens.');
  }

  const [novoId] = await criarSubtasksSolucao(projeto.id, [solucao]);

  // Só incrementa o total — `concluidos` fica como está, o item novo nasce
  // pendente (nunca marcado), mesmo que o projeto já esteja "entregue".
  await atualizarTask(projeto.id, {
    markdown_description: stringifyWaipeState(projeto.description, {
      ...estadoAtual,
      agentesTotal: agentesTotalAtual + 1,
    }),
  });

  return res.status(200).json({ ok: true, id: novoId });
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
  const contato = resolverContatoConversa(estado, corpo.telefone);
  if (!contato) {
    return erro(res, 400, 'telefone_invalido', 'Cadastre um telefone válido do cliente (Resumo do projeto) antes de iniciar a conversa.');
  }
  const { telefoneE164, nome: contatoNome } = contato;

  const contactId = await garantirContato(telefoneE164, contatoNome === 'Contato principal' ? projeto.name : contatoNome);
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
    contatoNome,
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
  const contato = resolverContatoConversa(estado, req.query?.telefone);
  if (!contato) {
    return res.status(200).json({ ok: true, semTelefone: true });
  }
  const { telefoneE164, nome: contatoNome } = contato;

  const historico = await buscarHistoricoConversa(telefoneE164);
  if (!historico) {
    return res.status(200).json({ ok: true, semConversa: true, contatoNome });
  }
  return res.status(200).json({ ok: true, contatoNome, ...historico });
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
    .map((t) => ({ id: t.id, nome: t.name, texto: corpoDoModelo(t.description), assunto: assuntoDoModelo(t.description) }))
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
  const assunto = texto(corpo.assunto, 200);
  if (!nome) return erro(res, 400, 'nome_invalido', 'Dê um nome pro modelo.');
  if (!conteudo) return erro(res, 400, 'texto_invalido', 'O modelo não pode ficar vazio.');

  const descricao = assunto ? `**Assunto:** ${assunto}\n\n${conteudo}` : conteudo;
  const nova = await criarModeloMensagem({ name: nome, markdown_description: descricao });
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

  // A barra de progresso do projeto (agentesConcluidos/agentesTotal, ver
  // listarImplantacoesAcao) conta só o array `concluidos` do PROJETO — que
  // só era populado pelo pipeline de agente Waipe (sim.concluidos.push no
  // front, ao entregar um agente). Um item tipo "solucao" (Gestor/Simplaz/
  // Migração Nuvem/etc.) virando "Entregue"/"Cancelado" por este mesmo
  // endpoint NUNCA refletia aqui — o item mostrava "Entregue" na etiqueta,
  // mas o projeto continuava contando como se nada tivesse sido concluído
  // (0/N na lista, mesmo com todos os itens prontos). Mesmo critério de
  // "item concluído" já usado em todosItensConcluidos() no front: entregue
  // OU cancelado — cancelado também não é mais trabalho pendente.
  if (estadoAtual.tipo === 'solucao' && tarefa.id !== projeto.id) {
    const eraConcluido = estadoAtual.fase === 'entregue' || estadoAtual.fase === 'cancelado';
    const ficouConcluido = novoEstado.fase === 'entregue' || novoEstado.fase === 'cancelado';
    if (eraConcluido !== ficouConcluido) {
      const estadoProjeto = parseWaipeState(projeto.description);
      const concluidosAtuais = Array.isArray(estadoProjeto.concluidos) ? estadoProjeto.concluidos : [];
      const novosConcluidos = ficouConcluido
        ? Array.from(new Set([...concluidosAtuais, corpo.taskId]))
        : concluidosAtuais.filter((id) => id !== corpo.taskId);
      await atualizarTask(projeto.id, {
        markdown_description: stringifyWaipeState(projeto.description, { ...estadoProjeto, concluidos: novosConcluidos }),
      });
    }
  }

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
 * Remove o(s) sufixo(s) "— Proposta — dd/mm/aaaa" que salvarPropostaImplantacaoAcao
 * cola no NOME DA TASK a cada save — nunca no "cliente" salvo à parte, mas
 * projetos salvos antes dessa separação existir não têm esse campo, então
 * caem no fallback do nome da task (ver obterImplantacaoAcao/listarImplantacoesAcao).
 * Sem essa limpeza, o fallback devolveria o sufixo (às vezes mais de um,
 * acumulado de saves sucessivos) como se fosse parte do nome do cliente.
 * `+` no grupo não-capturante casa quantos sufixos existirem, não só o último.
 */
function limparSufixoProposta(nome) {
  return String(nome || '').replace(/(?:\s*—\s*Proposta\s*—\s*\d{2}\/\d{2}\/\d{4})+\s*$/, '').trim();
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

  // Limpa antes de validar/usar — protege contra o "Nome do cliente" ter sido
  // preenchido a partir de um projeto salvo antes de existir o campo "cliente"
  // separado (ver limparSufixoProposta), o que faria o próximo save colar
  // mais um sufixo em cima do que já tinha.
  const cliente = limparSufixoProposta(texto(corpo.cliente, 120));
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
  const implantacaoEnterprise = sanearImplantacaoEnterprise(corpo.implantacaoEnterprise);
  const secoesFixasSelecionadas = sanearSecoesFixasSelecionadas(corpo.secoesFixasSelecionadas);
  const secoesPropostaSelecionadas = sanearSecoesPropostaSelecionadas(corpo.secoesPropostaSelecionadas);
  const secoesPropostaGeradas = Array.isArray(corpo.secoesPropostaGeradas)
    ? corpo.secoesPropostaGeradas.slice(0, IDS_SECOES_PROPOSTA_VALIDAS.size).map(sanearSecaoPropostaGerada).filter(Boolean)
    : [];
  // Opcionais aqui — só viram obrigatórios em confirmar-fechamento-implantacao,
  // quando a proposta vira projeto de implantação de verdade.
  const dadosCliente = sanearDadosCliente(corpo);

  const novoEstado = {
    // "cliente" salvo à parte do nome da task (que ganha um sufixo de data a
    // cada "salvar proposta") — sem isso, reabrir a proposta pra editar
    // preenchia "Nome do cliente" com o nome da task já sufixado, e o
    // próximo save colava mais um sufixo em cima (ver obterImplantacaoAcao).
    cliente, etapaAtual: 'proposta', agentesPropostos, outrasSolucoesPropostas, diagnosticoWaipe,
    implantacaoEnterprise, secoesFixasSelecionadas, secoesPropostaSelecionadas, secoesPropostaGeradas, ...dadosCliente,
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

  await criarSubtasksSolucao(projeto.id, outrasSolucoesPropostas);

  const novoEstadoProjeto = {
    // Mantém o "cliente" salvo (ver salvarPropostaImplantacaoAcao) na
    // promoção pra projeto — senão obterImplantacaoAcao cai de volta pro
    // nome da task (já com sufixo de data) assim que a proposta é confirmada.
    cliente: texto(estadoAtual.cliente, 120) || limparSufixoProposta(tarefa.name),
    etapaAtual: 'escopo',
    prioridade: [],
    agenteAtualId: null,
    concluidos: [],
    agentesTotal: agentesPropostos.length + outrasSolucoesPropostas.length,
    // Histórico do que foi proposto — não usado pelo pipeline a partir daqui.
    agentesPropostos: estadoAtual.agentesPropostos || [],
    outrasSolucoesPropostas: estadoAtual.outrasSolucoesPropostas || [],
    diagnosticoWaipe: estadoAtual.diagnosticoWaipe || null,
    implantacaoEnterprise: estadoAtual.implantacaoEnterprise || null,
    secoesFixasSelecionadas: estadoAtual.secoesFixasSelecionadas || null,
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
// projeto, o link do Meet e os convidados ficam em linhas simples na
// descrição (**Projeto:**/**Link:**/**Convidados:**), extraídas por
// projetoDaDescricaoReserva/linkDaDescricaoReserva/convidadosDaDescricaoReserva.
// Não há filtro por carteira aqui: agenda dos ISMs é recurso compartilhado
// do time, não de um CSM.

const RESERVA_DURACAO_MAX_MS = 24 * 60 * 60 * 1000;
const RESERVA_JANELA_MS = 5 * 365 * 24 * 60 * 60 * 1000; // +/- 5 anos, só pra barrar lixo
const MAX_EMAILS_LISTA = 10;
const EMAIL_REGEX_SIMPLES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Epoch (ms) dentro de uma janela sã, ou null se vier algo fora do esperado. */
function epocaOuNula(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const agora = Date.now();
  if (n < agora - RESERVA_JANELA_MS || n > agora + RESERVA_JANELA_MS) return null;
  return n;
}

/**
 * E-mails válidos (formato simples), sem duplicata e com teto — usado tanto
 * pros convidados do Meet criado pela reserva quanto pros destinatários do
 * envio de e-mail. Silenciosamente descarta o que não é um e-mail plausível,
 * em vez de rejeitar a operação inteira por causa disso.
 */
function sanearListaEmails(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  const validos = [];
  for (const item of lista) {
    const email = texto(item, 200).toLowerCase();
    if (!email || !EMAIL_REGEX_SIMPLES.test(email) || vistos.has(email)) continue;
    vistos.add(email);
    validos.push(email);
    if (validos.length >= MAX_EMAILS_LISTA) break;
  }
  return validos;
}

/**
 * Monta as linhas `**Campo:**` da description de uma reserva — TODO ponto
 * que grava uma reserva passa por aqui, pra nunca mais esquecer de
 * preservar um campo ao reescrever a description inteira (foi assim que
 * convidados quase se perdeu num reescrita anterior de atualizar-reserva).
 */
function linhasDescricaoReserva({ projetoId, linkReuniao, convidados, status, reagendadoPor, proximaReservaId, responsavelId, googleEventId }) {
  return [
    projetoId ? `**Projeto:** ${projetoId}` : null,
    // Ver responsavelIdDaReserva: gravado sempre, não só como fallback —
    // barato de escrever, e é a única fonte confiável quando o assignee é
    // descartado em silêncio pelo ClickUp.
    responsavelId ? `**Responsavel:** ${responsavelId}` : null,
    linkReuniao ? `**Link:** ${linkReuniao}` : null,
    convidados && convidados.length ? `**Convidados:** ${convidados.join(',')}` : null,
    status && status !== 'agendado' ? `**Status:** ${status}` : null,
    reagendadoPor ? `**ReagendadoPor:** ${reagendadoPor}` : null,
    // GoogleEventId: gravado em toda reserva criada com Meet (nao so nas
    // importadas por sincronizar-agendamentos-google) — e o que permite a
    // varredura de reunioes (cron.js (job=analise-reunioes)) achar de volta o
    // evento do Google e ler o anexo da anotacao do Gemini.
    googleEventId ? `**GoogleEventId:** ${googleEventId}` : null,
    proximaReservaId ? `**ProximaReservaId:** ${proximaReservaId}` : null,
  ].filter(Boolean).join('\n\n');
}

/**
 * Id responsável pela reserva: assignee nativo do ClickUp quando presente,
 * senão o id gravado em **Responsavel:** (ver linhasDescricaoReserva) — usa
 * SEMPRE esta função em vez de ler `t.assignees` direto, pro fallback valer
 * em todo lugar (conflito de horário, escopo por sessão, disponibilidade,
 * compromissos do dia, exibição).
 */
function responsavelIdDaReserva(t) {
  return Number(t.assignees?.[0]?.id) || Number(responsavelDaDescricaoReserva(t.description)) || null;
}

function reservaParaFora(t) {
  return {
    id: t.id,
    titulo: t.name,
    ismId: responsavelIdDaReserva(t),
    ismNome: nomeResponsavel(responsavelIdDaReserva(t)),
    // 'csm' quando o responsável é um CSM (agenda sincronizada pra fila CSQ —
    // ver criarReservaAcao/RESPONSAVEL_IDS_VALIDOS), 'ism' senão.
    papel: CSM_OPCOES.some((c) => c.id === responsavelIdDaReserva(t)) ? 'csm' : 'ism',
    inicio: Number(t.start_date) || null,
    fim: Number(t.due_date) || null,
    projetoId: projetoDaDescricaoReserva(t.description) || null,
    linkReuniao: linkDaDescricaoReserva(t.description) || '',
    convidados: convidadosDaDescricaoReserva(t.description),
    status: statusDaDescricaoReserva(t.description),
    reagendadoPor: reagendadoPorDaDescricaoReserva(t.description) || null,
    proximaReservaId: proximaReservaIdDaDescricaoReserva(t.description) || null,
  };
}

/**
 * Monta as linhas `**Campo:**` da description de uma Atividade CSQ — mesma
 * técnica de linhasDescricaoReserva. `status` omitido/'pendente' não grava
 * linha (ausência = pendente, mesmo padrão de statusDaDescricaoReserva).
 */
function linhasDescricaoAtividade({ projetoId, tipo, origem, alvo, status, resolucao }) {
  return [
    projetoId ? `**Projeto:** ${projetoId}` : null,
    tipo ? `**Tipo:** ${tipo}` : null,
    origem ? `**Origem:** ${origem}` : null,
    alvo ? `**Alvo:** ${alvo}` : null,
    status && status !== 'pendente' ? `**Status:** ${status}` : null,
    resolucao ? `**Resolucao:** ${resolucao}` : null,
  ].filter(Boolean).join('\n\n');
}

/**
 * O `assignees` nativo do ClickUp às vezes é descartado em silêncio na
 * criação quando a pessoa não tem acesso de guest configurado NESSA lista
 * específica (mesmo comportamento já documentado em LISTA_GOOGLE_TOKENS/
 * tokenDoIsm, em _lib/clickup.js) — por isso o alvo "de verdade" é lido do
 * texto salvo em `**Alvo:**` (sempre começa pelo nome da pessoa), não do
 * assignee da task.
 */
function assigneeIdDaAtividade(t, alvo) {
  const doAssignee = Number(t.assignees?.[0]?.id) || null;
  if (doAssignee) return doAssignee;
  const pessoa = PESSOAS_MENCIONAVEIS.find((p) => alvo === p.nome || alvo.startsWith(`${p.nome} —`));
  return pessoa?.id || null;
}

function atividadeCsqParaFora(t) {
  const alvo = alvoDaDescricaoAtividade(t.description) || '';
  return {
    id: t.id,
    titulo: texto(t.name, 200),
    assigneeId: assigneeIdDaAtividade(t, alvo),
    projetoId: projetoDaDescricaoAtividade(t.description) || null,
    tipo: tipoDaDescricaoAtividade(t.description) || null,
    origem: origemDaDescricaoAtividade(t.description) || null,
    alvo,
    status: statusDaDescricaoAtividade(t.description),
    resolucao: resolucaoDaDescricaoAtividade(t.description) || '',
    criadaEm: Number(t.date_created) || null,
  };
}

/**
 * Quem foi mencionado por "@Nome" no texto de um comentário — allowlist
 * fechada (PESSOAS_MENCIONAVEIS), nunca texto livre. `\b` depois do nome
 * evita casar um prefixo (ex: "@Daianepoderia" não casa "Daiane").
 */
function mencoesNoTexto(texto) {
  const encontradas = new Map();
  for (const p of PESSOAS_MENCIONAVEIS) {
    const re = new RegExp(`@${p.nome}\\b`, 'i');
    if (re.test(texto)) encontradas.set(p.id, p);
  }
  return [...encontradas.values()];
}

async function listarReservasAcao(res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const tasks = await listarReservas();
  return res.status(200).json({ reservas: tasks.map(reservaParaFora) });
}

/**
 * Miolo comum de "criar uma reserva de verdade": checa conflito interno
 * (contra as reservas já registradas) e, se o ISM tiver conectado o
 * Google, consulta disponibilidade REAL e cria o Meet automático. Usada
 * tanto por criar-reserva (HTTP) quanto por reagendar-reserva — o novo
 * horário de um reagendamento passa pela MESMA checagem de disponibilidade
 * que qualquer reserva nova, não um atalho.
 *
 * Devolve `{ erro: { status, corpo } }` em caso de conflito (interno ou do
 * Google) — quem chama só precisa repassar pro `res` — ou
 * `{ linkReuniao, googleEventId }` em caso de sucesso (ambos `null` se o
 * ISM não conectou).
 */
async function criarReservaComGoogle({ titulo, ismId, inicio, fim, convidados }) {
  const existentes = await listarReservas();
  const conflito = existentes
    .filter((t) => responsavelIdDaReserva(t) === ismId)
    .find((t) => Number(t.start_date) < fim && Number(t.due_date) > inicio);
  if (conflito) {
    return {
      erro: {
        status: 409,
        corpo: { error: 'Este ISM já tem reserva nesse horário.', code: 'conflito_horario', conflito: reservaParaFora(conflito) },
      },
    };
  }

  // Se o ISM ja conectou a propria agenda do Google: checa disponibilidade
  // REAL (nao so contra as reservas ja registradas aqui) e cria a reuniao
  // com Meet automatico. Sem conexao, comportamento identico ao de sempre —
  // ninguem fica bloqueado por nao ter conectado ainda.
  let linkReuniao = null;
  let googleEventId = null;
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
        return {
          erro: {
            status: 409,
            corpo: { error: 'Este ISM tem outro compromisso na agenda do Google nesse horário.', code: 'conflito_horario_google', conflito: ocupado },
          },
        };
      }
      const evento = await criarEventoComMeet(accessToken, { titulo, inicio, fim, attendees: convidados });
      linkReuniao = evento.hangoutLink;
      googleEventId = evento.id;
    }
  }
  return { linkReuniao, googleEventId };
}

/**
 * Ao vincular um agendamento a um projeto (criar-reserva direto, sincronizar-
 * agendamentos-google por CNPJ, ou vincular-agendamento-google manual), avança
 * a fase sozinha pra "agendado" — SÓ quando o projeto ainda está no ponto de
 * partida (faseProjetoManual nulo ou "nao_iniciado"). Pedido explícito da
 * usuária: marcar uma reunião já é sinal de que o projeto saiu do zero. Nunca
 * mexe num projeto que já avançou (em_andamento, aguardando_*, entregue,
 * cancelado, análise de desistência) — uma reunião de acompanhamento comum
 * não deveria "voltar no tempo" a fase de um projeto que já está andando.
 * Escrita direta (não passa por atualizarImplantacaoAcao), então precisa
 * replicar aqui o carimbo de pausaSlaDesde que aquele endpoint faria.
 */
async function autoDefinirFaseAgendado(projetoId) {
  if (!projetoId || !taskIdValido(projetoId)) return;
  try {
    const resolvido = await resolverImplantacao(projetoId);
    if (!resolvido) return;
    const { projeto } = resolvido;
    const estadoAtual = parseWaipeState(projeto.description);
    const faseAtual = FASES_ITEM_VALIDAS.has(estadoAtual.faseProjetoManual) ? estadoAtual.faseProjetoManual : null;
    if (faseAtual !== null && faseAtual !== 'nao_iniciado') return;
    await atualizarTask(projeto.id, {
      markdown_description: stringifyWaipeState(projeto.description, {
        ...estadoAtual,
        faseProjetoManual: 'agendado',
        pausaSlaDesde: estadoAtual.pausaSlaDesde || Date.now(),
      }),
    });
  } catch (e) {
    // Nunca derruba o fluxo de agendamento por causa disso — na pior das
    // hipóteses, a fase fica pra ser ajustada manualmente depois.
    console.error('[clickup] falha ao auto-definir fase agendado:', e);
  }
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
  if (!RESPONSAVEL_IDS_VALIDOS.has(ismId)) {
    return erro(res, 400, 'ism_invalido', 'Selecione um responsável válido.');
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

  const convidados = sanearListaEmails(corpo.convidados);

  const resultado = await criarReservaComGoogle({ titulo, ismId, inicio, fim, convidados });
  if (resultado.erro) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(resultado.erro.status).json(resultado.erro.corpo);
  }
  const linkReuniao = resultado.linkReuniao;

  const nova = await criarReserva({
    name: titulo,
    start_date: inicio,
    start_date_time: true,
    due_date: fim,
    due_date_time: true,
    assignees: [ismId],
    markdown_description: linhasDescricaoReserva({ projetoId, linkReuniao, convidados, responsavelId: ismId, googleEventId: resultado.googleEventId }),
  });
  await autoDefinirFaseAgendado(projetoId);
  return res.status(200).json({ ok: true, id: nova.id, linkReuniao, convidados });
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
  const projetoId = projetoDaDescricaoReserva(tarefa.description);
  const linkReuniao = texto(corpo.linkReuniao, 300);
  // Convidados so muda quando vem explicito no corpo — senao preserva o que
  // ja tinha (essa acao e usada hoje so pra colar o link manualmente, nao
  // pode apagar os convidados marcados na criacao por causa disso).
  const convidados = Array.isArray(corpo.convidados)
    ? sanearListaEmails(corpo.convidados)
    : convidadosDaDescricaoReserva(tarefa.description);
  // Comparecimento/reagendamento nunca muda por aqui — essa acao so cola o
  // link manualmente. Preserva sempre o que ja tinha (senao colar um link
  // apagaria um "compareceu"/"reagendado" ja marcado).
  const status = statusDaDescricaoReserva(tarefa.description);
  const reagendadoPor = reagendadoPorDaDescricaoReserva(tarefa.description);
  const proximaReservaId = proximaReservaIdDaDescricaoReserva(tarefa.description);

  await atualizarTask(corpo.id, {
    markdown_description: linhasDescricaoReserva({
      projetoId, linkReuniao, convidados, status, reagendadoPor, proximaReservaId,
      responsavelId: responsavelIdDaReserva(tarefa),
      googleEventId: googleEventIdDaDescricaoReserva(tarefa.description),
    }),
  });
  return res.status(200).json({ ok: true });
}

async function marcarComparecimentoReservaAcao(req, res, sessao) {
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
  const status = corpo.status === 'compareceu' || corpo.status === 'nao_compareceu' ? corpo.status : null;
  if (!status) {
    return erro(res, 400, 'status_invalido', 'status precisa ser "compareceu" ou "nao_compareceu".');
  }

  const tarefa = await obterTask(corpo.id);
  if (!tarefa || String(tarefa.list?.id || '') !== LISTA_RESERVAS_AGENDA) {
    return erro(res, 404, 'nao_encontrado', 'Reserva não encontrada.');
  }
  await atualizarTask(corpo.id, {
    markdown_description: linhasDescricaoReserva({
      projetoId: projetoDaDescricaoReserva(tarefa.description),
      linkReuniao: linkDaDescricaoReserva(tarefa.description),
      convidados: convidadosDaDescricaoReserva(tarefa.description),
      status,
      responsavelId: responsavelIdDaReserva(tarefa),
      googleEventId: googleEventIdDaDescricaoReserva(tarefa.description),
    }),
  });
  return res.status(200).json({ ok: true, status });
}

/**
 * Marca a reserva atual como reagendada (com quem pediu) e cria uma reserva
 * NOVA com o novo horário — mesmo caminho de criar-reserva (conflito +
 * Google/Meet), reaproveitando título/projeto/ISM/convidados da antiga. A
 * antiga não é apagada: vira histórico (Status=reagendado), ligada à nova
 * por ProximaReservaId — é esse rastro que alimenta as estatísticas do
 * relatório de finalização (quantos reagendamentos, por quem).
 */
async function reagendarReservaAcao(req, res, sessao) {
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
  const reagendadoPor = corpo.reagendadoPor === 'cliente' || corpo.reagendadoPor === 'londrisoft' ? corpo.reagendadoPor : null;
  if (!reagendadoPor) {
    return erro(res, 400, 'reagendado_por_invalido', 'Informe quem pediu o reagendamento: "londrisoft" ou "cliente".');
  }
  const novoInicio = epocaOuNula(corpo.novoInicio);
  const novoFim = epocaOuNula(corpo.novoFim);
  if (novoInicio === null || novoFim === null || novoFim <= novoInicio) {
    return erro(res, 400, 'horario_invalido', 'Novo início e fim precisam ser válidos, com fim depois do início.');
  }
  if (novoFim - novoInicio > RESERVA_DURACAO_MAX_MS) {
    return erro(res, 400, 'horario_invalido', 'Reserva não pode passar de 24h.');
  }

  const tarefa = await obterTask(corpo.id);
  if (!tarefa || String(tarefa.list?.id || '') !== LISTA_RESERVAS_AGENDA) {
    return erro(res, 404, 'nao_encontrado', 'Reserva não encontrada.');
  }
  const statusAtual = statusDaDescricaoReserva(tarefa.description);
  if (statusAtual !== 'agendado') {
    return erro(res, 409, 'reserva_ja_resolvida', 'Esta reserva já foi marcada como comparecida/não comparecida/reagendada.');
  }

  const ismId = responsavelIdDaReserva(tarefa);
  const titulo = texto(tarefa.name, 200);
  const projetoId = projetoDaDescricaoReserva(tarefa.description);
  const convidados = convidadosDaDescricaoReserva(tarefa.description);

  const resultado = await criarReservaComGoogle({ titulo, ismId, inicio: novoInicio, fim: novoFim, convidados });
  if (resultado.erro) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(resultado.erro.status).json(resultado.erro.corpo);
  }

  const nova = await criarReserva({
    name: titulo,
    start_date: novoInicio,
    start_date_time: true,
    due_date: novoFim,
    due_date_time: true,
    assignees: [ismId],
    markdown_description: linhasDescricaoReserva({ projetoId, linkReuniao: resultado.linkReuniao, convidados, responsavelId: ismId, googleEventId: resultado.googleEventId }),
  });

  await atualizarTask(corpo.id, {
    markdown_description: linhasDescricaoReserva({
      projetoId,
      linkReuniao: linkDaDescricaoReserva(tarefa.description),
      convidados,
      status: 'reagendado',
      reagendadoPor,
      responsavelId: ismId,
      proximaReservaId: nova.id,
      googleEventId: googleEventIdDaDescricaoReserva(tarefa.description),
    }),
  });

  await autoDefinirFaseAgendado(projetoId);
  return res.status(200).json({ ok: true, id: nova.id, linkReuniao: resultado.linkReuniao });
}

const DISPONIBILIDADE_JANELA_MAX_MS = 60 * 24 * 60 * 60 * 1000; // 60 dias — teto pra nao virar varredura enorme

/**
 * Blocos ocupados de um ISM num intervalo — pro calendário visual de
 * agendamento (mostra dia/horário já tomado antes de tentar registrar).
 * Junta reservas internas + agenda REAL do Google (quando conectado, via
 * listarEventos — o mesmo usado pelo sincronismo reverso). Não deduplica
 * uma reserva nossa contra o espelho dela no Google: o mesmo intervalo
 * pintado duas vezes não muda a informação mostrada. Só leitura — sem
 * exigir podeEscrever, qualquer sessão pode consultar pra agendar.
 */
async function disponibilidadeIsmAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const ismId = Number(req.query?.ismId);
  if (!RESPONSAVEL_IDS_VALIDOS.has(ismId)) {
    return erro(res, 400, 'ism_invalido', 'Selecione um responsável válido.');
  }
  const inicio = epocaOuNula(req.query?.inicio);
  const fim = epocaOuNula(req.query?.fim);
  if (inicio === null || fim === null || fim <= inicio) {
    return erro(res, 400, 'intervalo_invalido', 'Início e fim precisam ser válidos, com fim depois do início.');
  }
  if (fim - inicio > DISPONIBILIDADE_JANELA_MAX_MS) {
    return erro(res, 400, 'intervalo_invalido', 'Intervalo não pode passar de 60 dias.');
  }

  const reservas = await listarReservas();
  const ocupados = reservas
    .filter((t) => responsavelIdDaReserva(t) === ismId)
    .filter((t) => Number(t.start_date) < fim && Number(t.due_date) > inicio)
    .map((t) => ({ inicio: Number(t.start_date) || null, fim: Number(t.due_date) || null, titulo: texto(t.name, 200) }));

  const tokenGoogle = await obterTokenGoogle(ismId);
  if (tokenGoogle) {
    try {
      const accessToken = await renovarAccessToken(tokenGoogle.refreshToken);
      // FreeBusy — a MESMA API usada em criarReservaComGoogle pra checar
      // conflito de verdade na hora de salvar (ver consultarFreeBusy). Usar
      // aqui também, em vez de listarEventos (events.list), garante que a
      // grade nunca mostra livre um horário que o servidor vai recusar
      // depois: as duas APIs do Google podem divergir (ex: convite ainda
      // não respondido) e events.list já bateu nisso na prática.
      const blocos = await listarFreeBusy(accessToken, inicio, fim);
      for (const b of blocos) {
        const inicioBloco = Date.parse(b.start || '');
        const fimBloco = Date.parse(b.end || '');
        if (!Number.isFinite(inicioBloco) || !Number.isFinite(fimBloco)) continue;
        ocupados.push({ inicio: inicioBloco, fim: fimBloco, titulo: 'Compromisso (Google)' });
      }
    } catch (e) {
      // Token expirado/revogado — mostra so as reservas internas em vez de
      // derrubar a tela (mesma tolerancia de sincronizar-agendamentos-google).
      if (!(e instanceof ErroGoogle)) throw e;
    }
  }

  return res.status(200).json({ ocupados });
}

/** Início/fim (epoch ms) do dia de hoje em América/Sao_Paulo — Brasil não tem
 * horário de verão desde 2019, então -03:00 é fixo, sem precisar de Intl. */
function limitesHojeSP() {
  const iso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return { inicio: Date.parse(`${iso}T00:00:00-03:00`), fim: Date.parse(`${iso}T23:59:59-03:00`) };
}

/**
 * GET ?action=compromissos-hoje — visão do dia de TODOS os ISMs juntos, pra
 * tela inicial (Compromissos do dia). Junta reservas internas (registradas
 * aqui, com projeto vinculado) com a agenda REAL do Google de quem já
 * conectou — sem isso, um compromisso marcado direto no Google (ou por uma
 * página de agendamento externa) simplesmente não aparecia, mesmo
 * acontecendo de verdade hoje (só reserva feita por "Registrar reserva"
 * aparecia). Dedupe por sobreposição de horário: um evento do Google que já
 * bate com uma reserva interna do mesmo ISM não entra de novo (evita
 * mostrar o mesmo compromisso duas vezes quando o Meet foi criado
 * automático e espelhado na agenda dele).
 */
async function compromissosHojeAcao(res) {
  res.setHeader('Cache-Control', 'no-store');
  const { inicio, fim } = limitesHojeSP();

  const reservas = (await listarReservas())
    .filter((t) => {
      const ini = Number(t.start_date);
      return Number.isFinite(ini) && ini >= inicio && ini <= fim;
    })
    .map((t) => ({
      ismId: responsavelIdDaReserva(t),
      ismNome: nomeResponsavel(responsavelIdDaReserva(t)) || 'ISM não informado',
      titulo: texto(t.name, 200),
      inicio: Number(t.start_date) || null,
      fim: Number(t.due_date) || null,
      projetoId: projetoDaDescricaoReserva(t.description) || null,
      linkReuniao: linkDaDescricaoReserva(t.description) || '',
      origem: 'interno',
    }));

  const compromissos = reservas.slice();
  await Promise.all([...ISM_OPCOES, ...CSM_OPCOES].map(async (ism) => {
    const tokenGoogle = await obterTokenGoogle(ism.id);
    if (!tokenGoogle) return;
    try {
      const accessToken = await renovarAccessToken(tokenGoogle.refreshToken);
      const eventos = await listarEventos(accessToken, inicio, fim);
      const reservasDoIsm = reservas.filter((r) => r.ismId === ism.id);
      for (const ev of eventos) {
        const inicioEvento = Date.parse(ev.start?.dateTime || ev.start?.date || '');
        const fimEvento = Date.parse(ev.end?.dateTime || ev.end?.date || '');
        if (!Number.isFinite(inicioEvento) || !Number.isFinite(fimEvento)) continue;
        const jaRepresentado = reservasDoIsm.some((r) => r.inicio < fimEvento && r.fim > inicioEvento);
        if (jaRepresentado) continue;
        compromissos.push({
          ismId: ism.id,
          ismNome: ism.nome,
          titulo: texto(ev.summary, 200) || 'Compromisso',
          inicio: inicioEvento,
          fim: fimEvento,
          projetoId: null,
          linkReuniao: '',
          // Link do próprio evento na agenda do Google (não é o Meet —
          // é a página do compromisso) — só existe pra evento "cru" do
          // Google, reserva interna abre pelo projeto vinculado.
          linkAgenda: texto(ev.htmlLink, 500) || '',
          origem: 'google',
        });
      }
    } catch (e) {
      // Token expirado/revogado — mostra so as reservas internas em vez de
      // derrubar a tela (mesma tolerancia de sincronizar-agendamentos-google).
      if (!(e instanceof ErroGoogle)) throw e;
    }
  }));

  return res.status(200).json({ compromissos });
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
        await autoDefinirFaseAgendado(projeto.id);
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
  await autoDefinirFaseAgendado(corpo.projetoId);
  return res.status(200).json({ ok: true, id: nova.id });
}

/** 302 pro consentimento OAuth do Google — devolve o redirect, a troca de code por
 * token acontece do outro lado, em api/google-oauth-callback.js (fora deste dispatcher). */
async function conectarAgendaGoogleAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const ismId = Number(req.query?.ismId);
  if (!RESPONSAVEL_IDS_VALIDOS.has(ismId)) {
    return erro(res, 400, 'ism_invalido', 'ismId inválido.');
  }
  // Um ISM so conecta a PROPRIA agenda — nunca a de outro (o ismId da sessao
  // vem assinado, nao da pra forjar so trocando o parametro na URL).
  if (sessao.nivel === 'ism' && sessao.ismId && Number(sessao.ismId) !== ismId) {
    return erro(res, 403, 'fora_do_escopo', 'Você só pode conectar a própria agenda.');
  }
  let url;
  try {
    url = urlAutorizacaoGoogle('calendar', ismId);
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
  await Promise.all([...ISM_OPCOES, ...CSM_OPCOES].map(async (o) => {
    status[o.id] = !!(await obterTokenGoogle(o.id));
  }));
  return res.status(200).json({ status });
}

// ── Fila CSQ (Atividades) — Daiane/Aline ───────────────────────────────

const DIAS_UTEIS_PARADO_MIN = 3;

/**
 * Projetos sem interação há >=3 dias úteis (seg-sex, ver diasUteisEntre) E
 * sem nenhuma reserva futura agendada/reagendada — tipo VIRTUAL, nada
 * gravado (compatível com "o projeto nunca sai do painel de implantação").
 * Projeto já fechado (Closed/concluído) não entra: parado não faz sentido
 * pra algo que já terminou.
 */
function atividadesVirtuaisParadas(projetos, reservas) {
  const agora = Date.now();
  return projetos
    .filter((t) => t.status?.status !== 'Closed' && t.status?.status !== 'concluído')
    // Etapa "proposta" é pré-implantação (CSM/simulador ainda fechando com o
    // cliente) — o CSQ não tem nenhuma interação esperada nesse tipo de
    // registro ainda, então não deve entrar na fila como "parado".
    .filter((t) => parseWaipeState(t.description).etapaAtual !== 'proposta')
    .map((t) => {
      const diasUteis = diasUteisEntre(Number(t.date_updated) || 0, agora);
      if (diasUteis < DIAS_UTEIS_PARADO_MIN) return null;
      const temAgendamentoFuturo = reservas.some((r) =>
        projetoDaDescricaoReserva(r.description) === t.id &&
        ['agendado', 'reagendado'].includes(statusDaDescricaoReserva(r.description)) &&
        Number(r.start_date) > agora);
      if (temAgendamentoFuturo) return null;
      return {
        id: `parado:${t.id}`,
        tipo: 'projeto_parado',
        projetoId: t.id,
        cliente: t.name,
        diasUteis,
        prioridade: 100 + diasUteis,
      };
    })
    .filter(Boolean);
}

/**
 * Reservas marcadas "não compareceu" sem reagendamento seguinte — tipo
 * VIRTUAL, lido direto de listarReservas() (marcarComparecimentoReservaAcao
 * já existe, só nunca tinha sido lido como fila de trabalho).
 */
function atividadesVirtuaisNaoComparecimento(reservas, projetosValidosIds) {
  return reservas
    .filter((r) => statusDaDescricaoReserva(r.description) === 'nao_compareceu')
    .filter((r) => !proximaReservaIdDaDescricaoReserva(r.description))
    // Projeto excluído -> reserva órfã, ninguém nunca vai reagendar por ela
    // (a tela de reagendamento vive dentro do projeto) -> não é mais uma
    // atividade de verdade, só lixo acumulado na fila.
    .filter((r) => projetosValidosIds.has(projetoDaDescricaoReserva(r.description)))
    .map((r) => ({
      id: `nao_compareceu:${r.id}`,
      tipo: 'nao_compareceu',
      projetoId: projetoDaDescricaoReserva(r.description) || null,
      cliente: texto(r.name, 200),
      prioridade: 90,
    }));
}

const PRIORIDADE_ATIVIDADE_PERSISTIDA = { churn: 95, mencao: 85, renovacao: 75 };

/**
 * GET ?action=listar-atividades-csq — fila unificada da Daiane/Aline: tipos
 * virtuais calculados na hora (sem cron — as duas chamadas de base já são
 * "no-store") + Atividades persistidas não resolvidas. Só nível csq/gestao
 * (ver ACOES_SOMENTE_CSQ).
 */
async function listarAtividadesCsqAcao(res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const [tasks, reservas, registradas] = await Promise.all([
    listarImplantacoes(),
    listarReservas(),
    listarAtividadesCsq(),
  ]);
  const projetos = tasks.filter((t) => !t.parent);
  const nomeProjeto = new Map(projetos.map((t) => [t.id, t.name]));
  const projetosValidosIds = new Set(projetos.map((t) => t.id));

  const persistidas = registradas
    .map(atividadeCsqParaFora)
    .filter((a) => a.status !== 'resolvida')
    // Projeto excluído -> não sobra nada pra abrir/agir; a atividade em si
    // perdeu o sentido (mesmo raciocínio do nao_compareceu órfão abaixo).
    .filter((a) => projetosValidosIds.has(a.projetoId))
    .map((a) => ({
      ...a,
      cliente: nomeProjeto.get(a.projetoId) || '',
      prioridade: PRIORIDADE_ATIVIDADE_PERSISTIDA[a.tipo] || 60,
    }));

  const atividades = [
    ...atividadesVirtuaisParadas(projetos, reservas),
    ...atividadesVirtuaisNaoComparecimento(reservas, projetosValidosIds),
    ...persistidas,
  ].sort((a, b) => b.prioridade - a.prioridade);

  return res.status(200).json({ atividades });
}

/**
 * POST ?action=criar-atividade-csq { projetoId, tipo: "churn"|"renovacao"|
 * "lembrete", alvoId, observacao?, dueDate? } -> registra diagnóstico de
 * cancelamento, handoff de renovação pro CSM, ou um lembrete genérico
 * (com prazo opcional, ex: uma régua de SLA). Entrada sempre MANUAL
 * (webhook do Moskit continua pausado, não é tocado por isso) — vira uma
 * Atividade persistida, o projeto de implantação nunca é alterado por
 * essa ação.
 */
async function criarAtividadeManualCsqAcao(req, res, sessao) {
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
  const tipo = corpo.tipo === 'churn' || corpo.tipo === 'renovacao' || corpo.tipo === 'lembrete' ? corpo.tipo : null;
  if (!tipo) {
    return erro(res, 400, 'tipo_invalido', 'tipo precisa ser "churn", "renovacao" ou "lembrete".');
  }
  const alvoId = Number(corpo.alvoId);
  const pessoaAlvo = PESSOAS_MENCIONAVEIS.find((p) => p.id === alvoId);
  if (!pessoaAlvo) {
    return erro(res, 400, 'alvo_invalido', 'Selecione um responsável válido.');
  }

  const resolvido = await resolverImplantacao(corpo.projetoId);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Projeto não encontrado.');

  const observacao = texto(corpo.observacao, 500);
  const NOME_TIPO_ATIVIDADE = { churn: 'Churn', renovacao: 'Renovação', lembrete: 'Lembrete' };
  const payload = {
    name: `${NOME_TIPO_ATIVIDADE[tipo]}: ${texto(resolvido.projeto.name, 120)}`,
    assignees: [alvoId],
    markdown_description: linhasDescricaoAtividade({
      projetoId: resolvido.projeto.id,
      tipo,
      alvo: [pessoaAlvo.nome, observacao].filter(Boolean).join(' — '),
    }),
  };
  // Prazo opcional (ex: uma das réguas de SLA por urgência do painel) —
  // mesmo formato/validação de data usado em atualizarAgenteAcao.
  if (typeof corpo.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(corpo.dueDate)) {
    payload.due_date = Date.parse(`${corpo.dueDate}T12:00:00-03:00`);
    payload.due_date_time = true;
  }
  const nova = await criarAtividadeCsq(payload);
  return res.status(200).json({ ok: true, id: nova.id });
}

/**
 * POST ?action=resolver-atividade-csq { id, resolucao? } -> fecha uma
 * Atividade persistida (mencao/churn/renovacao). Só reescreve a task em
 * LISTA_ATIVIDADES_CSQ — nunca toca no projeto de implantação.
 */
async function resolverAtividadeCsqAcao(req, res, sessao) {
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
  if (!tarefa || String(tarefa.list?.id || '') !== LISTA_ATIVIDADES_CSQ) {
    return erro(res, 404, 'nao_encontrado', 'Atividade não encontrada.');
  }

  await atualizarTask(corpo.id, {
    markdown_description: linhasDescricaoAtividade({
      projetoId: projetoDaDescricaoAtividade(tarefa.description),
      tipo: tipoDaDescricaoAtividade(tarefa.description),
      origem: origemDaDescricaoAtividade(tarefa.description),
      alvo: alvoDaDescricaoAtividade(tarefa.description),
      status: 'resolvida',
      resolucao: texto(corpo.resolucao, 500),
    }),
  });
  return res.status(200).json({ ok: true });
}

/**
 * 302 pro consentimento OAuth do GMAIL (envio) — AUTORIZACAO SEPARADA da
 * agenda, mesmo esquema de redirect (troca de code por token acontece em
 * api/google-oauth-callback.js). `tipo=compartilhada` conecta a conta unica
 * da Londrisoft (so Gestao); default conecta o Gmail da propria sessao.
 */
async function conectarEmailGoogleAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const tipo = req.query?.tipo === 'compartilhada' ? 'compartilhada' : 'pessoal';
  if (tipo === 'compartilhada' && sessao.nivel !== 'gestao') {
    return erro(res, 403, 'fora_do_escopo', 'Só a Gestão pode conectar a conta compartilhada.');
  }
  const alvo = tipo === 'compartilhada' ? CONTA_EMAIL_COMPARTILHADA : sessao.nome;
  let url;
  try {
    url = urlAutorizacaoGoogle('email', alvo);
  } catch (e) {
    if (e instanceof ErroConfigGoogle) {
      return erro(res, 500, 'google_nao_configurado', 'Integração com o Google ainda não foi configurada.');
    }
    throw e;
  }
  res.setHeader('Location', url);
  return res.status(302).end();
}

/** Se a propria sessao (e a conta compartilhada) ja conectaram o Gmail pra envio. */
async function statusEmailGoogleAcao(res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  const [tokenPessoal, tokenCompartilhado] = await Promise.all([
    obterTokenEmail(sessao.nome),
    obterTokenEmail(CONTA_EMAIL_COMPARTILHADA),
  ]);
  return res.status(200).json({
    pessoal: { conectado: !!tokenPessoal, email: tokenPessoal?.emailConectado || null },
    compartilhada: { conectado: !!tokenCompartilhado, email: tokenCompartilhado?.emailConectado || null },
    podeConectarCompartilhada: sessao.nivel === 'gestao',
  });
}

async function enviarEmailImplantacaoAcao(req, res, sessao) {
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

  const destinatarios = sanearListaEmails(corpo.destinatarios);
  if (!destinatarios.length) {
    return erro(res, 400, 'destinatarios_invalidos', 'Informe ao menos um e-mail válido de destinatário.');
  }
  const assunto = texto(corpo.assunto, 200);
  const corpoTexto = texto(corpo.corpo, 10000);
  if (!assunto) return erro(res, 400, 'assunto_invalido', 'O e-mail precisa de um assunto.');
  if (!corpoTexto) return erro(res, 400, 'corpo_invalido_email', 'O e-mail não pode ficar vazio.');

  const remetenteCompartilhado = corpo.remetente === 'compartilhada';
  const alvo = remetenteCompartilhado ? CONTA_EMAIL_COMPARTILHADA : sessao.nome;
  const tokenEmail = await obterTokenEmail(alvo);
  if (!tokenEmail) {
    return erro(
      res, 409,
      remetenteCompartilhado ? 'email_compartilhado_nao_conectado' : 'email_nao_conectado',
      remetenteCompartilhado
        ? 'A conta compartilhada ainda não foi conectada.'
        : 'Conecte seu Gmail antes de enviar (veja o card de e-mail no projeto).',
    );
  }

  let accessToken;
  try {
    accessToken = await renovarAccessToken(tokenEmail.refreshToken);
  } catch (e) {
    if (!(e instanceof ErroGoogle)) throw e;
    console.error('[enviar-email] renovarAccessToken falhou:', e.status, JSON.stringify(e.corpo));
    return erro(res, 409, 'email_conexao_invalida', 'A conexão do Gmail expirou ou foi revogada — reconecte.');
  }

  try {
    await enviarEmailGmail(accessToken, {
      de: tokenEmail.emailConectado, para: destinatarios, assunto, corpoTexto,
    });
  } catch (e) {
    if (!(e instanceof ErroGoogle)) throw e;
    // Diagnostico temporario: "recusado" cobre varias causas do lado do
    // Google (Gmail API desativada no projeto, escopo faltando por ter
    // conectado antes dessa API existir, conta fora da allowlist de teste
    // etc.) — logar o corpo real da resposta evita ficar adivinhando.
    console.error('[enviar-email] Gmail recusou o envio:', e.status, JSON.stringify(e.corpo));
    return erro(res, 502, 'erro_envio_email', 'O Gmail recusou o envio — tente de novo em instantes.');
  }

  await criarComentario(
    projeto.id,
    `📧 **E-mail enviado por ${sessao.nome}** (${tokenEmail.emailConectado})\n` +
      `**Para:** ${destinatarios.join(', ')}\n**Assunto:** ${assunto}\n\n${corpoTexto}`,
  );

  return res.status(200).json({ ok: true, enviadoComo: tokenEmail.emailConectado, destinatarios });
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
  const mapeados = comentarios.map((c) => {
    const bruto = c.comment_text || '';
    // [[AUTOR:Nome]] pode vir DEPOIS de [[PIN]]/[[DESTAQUE]] (marcados
    // sempre são prependados na frente de tudo que já existia, ver
    // marcarComentarioImplantacaoAcao) — nunca antes. Mantém os dois
    // intactos no texto devolvido: o front ainda precisa deles pra saber
    // se o comentário está fixado/destacado.
    const m = MARCADOR_AUTOR_RE.exec(bruto);
    return {
      id: c.id,
      texto: m ? (m[1] || '') + (m[2] || '') + bruto.slice(m[0].length) : bruto,
      autor: m ? m[3] : (c.user?.username || ''),
      data: c.date || null,
    };
  });
  return res.status(200).json({ comentarios: mapeados });
}

// Ver comentarImplantacaoAcao (por que existe) e listarComentariosAcao (onde é lido).
const MARCADOR_AUTOR_RE = /^(\[\[PIN\]\])?(\[\[DESTAQUE\]\])?\[\[AUTOR:([^\]]*)\]\]/;

// Fixar/destacar um comentário não é um campo nativo do ClickUp — vive como
// um marcador no INÍCIO do próprio texto do comentário (mesmo espírito do
// prefixo [[FLOW]] já usado pra "fluxo salvo"). O front usa a mesma lógica
// pra ler de volta (esconde o marcador, some só a formatação).
function metaComentarioTexto(bruto) {
  let t = String(bruto || '');
  let pin = false;
  let destaque = false;
  let mudou = true;
  while (mudou) {
    mudou = false;
    if (t.startsWith('[[PIN]]')) { pin = true; t = t.slice(7); mudou = true; }
    if (t.startsWith('[[DESTAQUE]]')) { destaque = true; t = t.slice(12); mudou = true; }
  }
  return { pin, destaque, texto: t };
}

/**
 * POST ?action=marcar-comentario-implantacao { taskId, comentarioId, pin?,
 * destaque? } — fixa (aparece sempre no topo, pra todo mundo ver primeiro)
 * e/ou destaca (fundo diferenciado, sem subir de posição) um comentário.
 * `pin`/`destaque` só mudam quando vêm no corpo — omitir preserva o valor
 * atual (permite alternar só um dos dois sem precisar saber o outro).
 */
async function marcarComentarioImplantacaoAcao(req, res, sessao) {
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
  const comentarioId = texto(corpo.comentarioId, 40);
  if (!comentarioId) {
    return erro(res, 400, 'comentario_invalido', 'comentarioId inválido.');
  }

  const resolvido = await resolverImplantacao(corpo.taskId);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Tarefa não encontrada.');
  const csm = csmDaDescricaoImplantacao(resolvido.projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return erro(res, 403, 'fora_da_carteira', 'Este projeto não está na sua carteira.');
  }

  const comentarios = await listarComentarios(corpo.taskId);
  const alvo = comentarios.find((c) => String(c.id) === comentarioId);
  if (!alvo) return erro(res, 404, 'comentario_nao_encontrado', 'Comentário não encontrado.');

  const atual = metaComentarioTexto(alvo.comment_text || '');
  const pin = 'pin' in corpo ? !!corpo.pin : atual.pin;
  const destaque = 'destaque' in corpo ? !!corpo.destaque : atual.destaque;
  const novoTexto = (pin ? '[[PIN]]' : '') + (destaque ? '[[DESTAQUE]]' : '') + atual.texto;

  await atualizarComentario(comentarioId, novoTexto);
  return res.status(200).json({ ok: true, pin, destaque });
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

  // O comentário no ClickUp sempre aparece "postado por" quem for o dono da
  // CLICKUP_API_KEY compartilhada — nunca a pessoa de verdade logada no
  // painel (ISM/CSM/Gestão são só perfis da NOSSA sessão, sem usuário
  // próprio no ClickUp). Sem isso, o comentário da Erica aparecia com o
  // nome da Maria Rita, e ninguém sabia quem escreveu de verdade. Marcador
  // no INÍCIO do texto (mesmo padrão de [[PIN]]/[[DESTAQUE]], ver
  // metaComentarioTexto) — listarComentariosAcao lê e usa como "autor" no
  // lugar do usuário nativo do ClickUp, e tira o marcador antes de devolver
  // pro front.
  const autorMarcado = sessao.nome ? `[[AUTOR:${texto(sessao.nome, 60).replace(/\]/g, '')}]]` : '';
  const comentarioSalvo = await criarComentario(corpo.taskId, autorMarcado + textoFinal);

  // "@Nome" no texto vira uma Atividade CSQ pra quem foi mencionado — não
  // bloqueia o comentário se falhar (o comentário em si já foi salvo).
  const mencoes = comentario ? mencoesNoTexto(comentario) : [];
  if (mencoes.length) {
    const nomeProjeto = texto(resolvido.projeto.name, 120);
    await Promise.all(mencoes.map((pessoa) => criarAtividadeCsq({
      name: `Menção de ${sessao.nome || 'alguém'}: ${nomeProjeto}`,
      assignees: [pessoa.id],
      markdown_description: linhasDescricaoAtividade({
        projetoId: resolvido.projeto.id,
        tipo: 'mencao',
        origem: comentarioSalvo?.id ? String(comentarioSalvo.id) : '',
        alvo: pessoa.nome,
      }),
    }))).catch((e) => console.error('[csq] falha ao criar atividade de mencao:', e));
  }

  return res.status(200).json({ ok: true });
}

/**
 * Exclui um comentário do projeto. Só nível Gestão — comentário é o
 * histórico do que aconteceu no projeto (usado pelo relatório de
 * finalização), apagar é exceção pra limpar teste, não fluxo normal do
 * dia a dia (por isso nem `podeEscrever` cobre isso, é mais restrito).
 */
async function excluirComentarioImplantacaoAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  if (sessao.nivel !== 'gestao') {
    return erro(res, 403, 'nivel_nao_permitido', 'Só o perfil Gestão pode excluir comentários.');
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
  const comentarioId = texto(corpo.comentarioId, 40);
  if (!comentarioId) {
    return erro(res, 400, 'comentario_invalido', 'comentarioId inválido.');
  }

  // Confirma que a task pertence à Implantação antes de excluir qualquer
  // coisa nela — mesmo portão de posse das outras ações desta lista.
  const resolvido = await resolverImplantacao(corpo.taskId);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Tarefa não encontrada.');

  await excluirComentario(comentarioId);
  return res.status(200).json({ ok: true });
}

/**
 * Exclui um projeto de implantação inteiro (e as subtasks junto — o
 * ClickUp cascade-deleta sozinho). Só nível Gestão, e só a partir da task
 * do PROJETO — nunca de uma subtask, pra nunca apagar um projeto inteiro
 * por engano ao tentar excluir só um item dele.
 */
async function excluirImplantacaoAcao(req, res, sessao) {
  res.setHeader('Cache-Control', 'no-store');
  if (sessao.nivel !== 'gestao') {
    return erro(res, 403, 'nivel_nao_permitido', 'Só o perfil Gestão pode excluir projetos.');
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
  if (resolvido.tarefa.id !== resolvido.projeto.id) {
    return erro(res, 400, 'task_invalida', 'Exclua a partir da task do projeto, não de uma subtask.');
  }

  await excluirTask(corpo.id);
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
