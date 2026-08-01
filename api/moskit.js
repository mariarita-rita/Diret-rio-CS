// Proxy do Moskit CRM. Duas acoes e nada mais:
//
//   POST /api/moskit?action=deal     -> POST https://api.moskitcrm.com/v2/deals
//   POST /api/moskit?action=project  -> POST https://api.moskitcrm.com/v2/projects
//
// Nao existe pass-through do corpo do cliente. Cada campo e lido, validado e
// remontado aqui. Os IDs estruturais (pipeline, stage, board, step, createdBy) e
// os campos personalizados sao constantes do servidor. Os dados de identificacao
// do cliente e o responsavel vem do ClickUp, nao do navegador.

import {
  aplicarCors,
  erro,
  lerCorpo,
  opcaoPermitida,
  taskIdValido,
  texto,
  ErroCorpo,
} from './_lib/http.js';
import { exigirSessao, podeEscrever, pertenceAoCsm, ErroConfig } from './_lib/auth.js';
import { ErroConfigClickUp, ErroUpstream, localizarCliente } from './_lib/clickup.js';

const BASE = 'https://api.moskitcrm.com/v2';

// ── IDs travados no servidor ──────────────────────────────────────────────
const PIPELINE_RENOVACOES = 91432;
const STAGE_NOVO_NEGOCIO = 438018;
const ACOMP_BOARD = 32342;
const ACOMP_STEP = 124287; // Nova solicitacao
const CREATED_BY = 133497;

// Responsaveis no Moskit, resolvidos a partir do gerente registrado no ClickUp.
const RESPONSAVEIS = {
  'Gian Luca': 144977,
  'Lucineia Felix': 153658,
  'Guilherme Camargo': 155181,
  'Patricia Carvalho': 156549,
};

// Campos personalizados do negocio
const CF_DEAL = {
  ID_NUCLEO: 'CF_g40MLBiYSjOzYD29',
  CNPJ: 'CF_Lo1qjyidSaYRODer',
  RAZAO_SOCIAL: 'CF_oJZmP1iKCQaRzDgv',
  PLANO_ATUAL: 'CF_Lo1qjyiPiaYQNDer',
  MENS_ANTERIOR: 'CF_wPVm2Vi2Car10mK6',
  BASE_MES: 'CF_y5lm56iyiVXGRDwW',
  OPORTUNIDADE: 'CF_dN7MGPioiAKV8meY',
  ORIGEM: 'CF_A4wMWNiLiBoLXqB8',
  SUGESTAO: 'CF_VrKMbQiaC8ZwAqZY',
  OBSERVACAO: 'CF_0WGqoEiKCad6GmnP',
};

// Campos personalizados do projeto de acompanhamento
const CF_PROJ = {
  TIPO: 'CF_3LvDvpH1iGbdrM6a',
  ORIGEM: 'CF_POEMyKHZi807bDdk',
  CONVERSA: 'CF_3LvDvpH4CLBLPM6a',
  OBSERVACAO: 'CF_Rg7MnxHLC3lE2Dvd',
};

// ── Allowlists de opcao ───────────────────────────────────────────────────
const OPC_OPORTUNIDADE = new Set([
  578315, 608595, 608596, 608597, 695146, 696462, 709771, 709772, 709773,
]);
const OPC_ORIGEM_DEAL = new Set([
  571190, 571193, 582285, 582288, 582289, 613839, 694711, 694858, 695069, 725595, 761137, 780590,
]);
const OPC_PLANO = new Set([
  569288, 569289, 569290, 569291, 569292, 569293, 569294, 569295, 569296, 569297, 569298, 569299,
  569300, 569301, 569302, 569303, 569304,
]);
const OPC_BASE_MES = new Set([
  569447, 569448, 569449, 569450, 569451, 569452, 569453, 569454, 569455, 569456, 569457, 569458,
]);

// Tipo de solicitacao do acompanhamento: o rotulo tambem fica aqui, porque o
// nome do projeto e montado no servidor.
const TIPOS_ACOMP = new Map([
  [729737, 'Acompanhamento'],
  [729738, 'Diagnóstico'],
  [729739, 'Risco de Churn'],
  [729740, 'Oportunidade de up e cross'],
]);
const OPC_ORIGEM_ACOMP = new Set([729733, 729734, 729735, 729736]);

const MAX_NOME = 200;
const MAX_TEXTO = 4000;
const MAX_VALOR = 100000000;

// Aviso devolvido ao navegador quando o responsavel nao pode ser identificado.
// Diz o que fazer sem expor mapa de ids, nome de variavel nem detalhe do upstream.
const AVISO_SEM_RESPONSAVEL =
  'Atenção: criado SEM responsável identificado. O gerente deste cliente não ' +
  'corresponde a nenhum CSM cadastrado — defina o responsável manualmente no Moskit.';

// ── Handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!aplicarCors(req, res)) {
    return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sessao = exigirSessao(req, res);
  if (!sessao) return undefined;

  const acao = String(req.query?.action || '');
  if (acao !== 'deal' && acao !== 'project') {
    return erro(res, 400, 'acao_invalida', 'Ação inválida.');
  }
  if (req.method !== 'POST') {
    return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
  }
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

  try {
    // O cliente e sempre resolvido pelo taskId no ClickUp. E dali que saem
    // ID Nucleo, CNPJ, razao social, mensalidade e responsavel.
    if (!taskIdValido(corpo.taskId)) {
      return erro(res, 400, 'task_invalida', 'taskId inválido.');
    }
    const cliente = await localizarCliente(corpo.taskId);
    if (!cliente) {
      return erro(res, 403, 'cliente_fora_do_escopo', 'Cliente não encontrado na carteira.');
    }
    if (sessao.nivel === 'csm' && !pertenceAoCsm(cliente.gerente, sessao.csm)) {
      return erro(res, 403, 'fora_da_carteira', 'Este cliente não está na sua carteira.');
    }

    return acao === 'deal'
      ? await criarNegocio(res, corpo, cliente)
      : await criarProjeto(res, corpo, cliente);
  } catch (e) {
    return tratarErro(res, e, acao);
  }
}

// ── action=deal ───────────────────────────────────────────────────────────

async function criarNegocio(res, corpo, cliente) {
  const nome = texto(corpo.nome, MAX_NOME);
  if (!nome) return erro(res, 400, 'nome_obrigatorio', 'Nome do negócio é obrigatório.');

  const oportunidade = opcaoPermitida(corpo.oportunidade, OPC_OPORTUNIDADE);
  if (oportunidade === null) {
    return erro(res, 400, 'oportunidade_invalida', 'Selecione um tipo de oportunidade válido.');
  }

  const valorBruto = Number(corpo.valor);
  if (!Number.isFinite(valorBruto) || valorBruto < 0 || valorBruto > MAX_VALOR) {
    return erro(res, 400, 'valor_invalido', 'Valor da negociação inválido.');
  }
  const valor = Math.round(valorBruto * 100) / 100;

  const plano = opcaoPermitida(corpo.plano, OPC_PLANO);
  const base = opcaoPermitida(corpo.base, OPC_BASE_MES);
  const origem = opcaoPermitida(corpo.origem, OPC_ORIGEM_DEAL);
  const sugestao = texto(corpo.sugestao, MAX_TEXTO);
  const obs = texto(corpo.obs, MAX_TEXTO);

  // Identificacao do cliente: sempre do ClickUp, nunca do corpo recebido.
  const campos = [
    { id: CF_DEAL.ID_NUCLEO, numericValue: soNumero(cliente.idNucleo) },
    { id: CF_DEAL.CNPJ, numericValue: soNumero(cliente.cnpj) },
    { id: CF_DEAL.RAZAO_SOCIAL, textValue: String(cliente.nome || '') },
    { id: CF_DEAL.MENS_ANTERIOR, textValue: moedaBR(cliente.mrr) },
    { id: CF_DEAL.OPORTUNIDADE, options: [oportunidade] },
  ];
  if (obs) campos.push({ id: CF_DEAL.OBSERVACAO, textValue: obs });
  if (sugestao) campos.push({ id: CF_DEAL.SUGESTAO, textValue: sugestao });
  if (plano !== null) campos.push({ id: CF_DEAL.PLANO_ATUAL, options: [plano] });
  if (base !== null) campos.push({ id: CF_DEAL.BASE_MES, options: [base] });
  if (origem !== null) campos.push({ id: CF_DEAL.ORIGEM, options: [origem] });

  const responsavel = responsavelDe(cliente.gerente);

  const criado = await moskit('/deals', {
    name: nome,
    price: valor,
    status: 'OPEN',
    pipeline: { id: PIPELINE_RENOVACOES },
    stage: { id: STAGE_NOVO_NEGOCIO },
    responsible: { id: responsavel.id },
    createdBy: { id: CREATED_BY },
    entityCustomFields: campos,
  });

  return res.status(200).json({
    ok: true,
    id: criado?.id ?? null,
    ...(responsavel.identificado
      ? {}
      : { aviso: AVISO_SEM_RESPONSAVEL, code: 'responsavel_nao_identificado' }),
  });
}

// ── action=project ────────────────────────────────────────────────────────

async function criarProjeto(res, corpo, cliente) {
  const tipo = opcaoPermitida(corpo.tipo, new Set(TIPOS_ACOMP.keys()));
  if (tipo === null) {
    return erro(res, 400, 'tipo_invalido', 'Selecione um tipo de solicitação válido.');
  }
  const origem = opcaoPermitida(corpo.origem, OPC_ORIGEM_ACOMP);
  if (origem === null) {
    return erro(res, 400, 'origem_invalida', 'Selecione uma origem de solicitação válida.');
  }

  const conversa = texto(corpo.conversa, MAX_TEXTO);
  const obs = texto(corpo.obs, MAX_TEXTO);

  const campos = [
    { id: CF_PROJ.TIPO, options: [tipo] },
    { id: CF_PROJ.ORIGEM, options: [origem] },
  ];
  if (conversa) campos.push({ id: CF_PROJ.CONVERSA, textValue: conversa });
  if (obs) campos.push({ id: CF_PROJ.OBSERVACAO, textValue: obs });

  // Nome do projeto montado no servidor a partir do cliente e do rotulo do tipo.
  const nome = `Acompanhamento - ${cliente.nome} - ${TIPOS_ACOMP.get(tipo)}`.slice(0, MAX_NOME);

  const responsavel = responsavelDe(cliente.gerente);

  const criado = await moskit('/projects', {
    name: nome,
    archived: false,
    board: { id: ACOMP_BOARD },
    step: { id: ACOMP_STEP },
    responsible: { id: responsavel.id },
    createdBy: { id: CREATED_BY },
    entityCustomFields: campos,
  });

  return res.status(200).json({
    ok: true,
    id: criado?.id ?? null,
    ...(responsavel.identificado
      ? {}
      : { aviso: AVISO_SEM_RESPONSAVEL, code: 'responsavel_nao_identificado' }),
  });
}

// ── Cliente Moskit ────────────────────────────────────────────────────────

export class ErroConfigMoskit extends Error {
  constructor() {
    super('MOSKIT_API_KEY nao configurada.');
    this.name = 'ErroConfigMoskit';
  }
}

async function moskit(caminho, corpo) {
  const chave = process.env.MOSKIT_API_KEY;
  if (!chave) throw new ErroConfigMoskit();

  const r = await fetch(BASE + caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: chave },
    body: JSON.stringify(corpo),
  });

  if (!r.ok) {
    // O detalhe fica no log da funcao na Vercel; o navegador recebe so o status.
    const detalhe = await r.text().catch(() => '');
    console.error(`[moskit] POST ${caminho} -> ${r.status}: ${detalhe.slice(0, 500)}`);
    throw new ErroUpstream(r.status);
  }
  return r.json().catch(() => ({}));
}

// ── Utilidades ────────────────────────────────────────────────────────────

/**
 * Responsável no Moskit, resolvido a partir do gerente registrado no ClickUp.
 *
 * Quando não casa, a criação continua — bloquear o fluxo seria pior — mas o
 * fallback deixa de ser silencioso: registra ERRO no log da função com o valor
 * que não casou e devolve `identificado: false`, para o handler avisar quem está
 * usando. Antes, o negócio nascia atribuído ao createdBy sem nenhum sinal, e a
 * pessoa só descobria olhando o funil no Moskit.
 *
 * @returns {{id: number, identificado: boolean}}
 */
function responsavelDe(gerente) {
  const nome = String(gerente || '');
  for (const [csm, id] of Object.entries(RESPONSAVEIS)) {
    if (pertenceAoCsm(nome, csm)) return { id, identificado: true };
  }
  console.error(
    `[moskit] responsavel nao identificado: gerente=${JSON.stringify(nome)} nao casa com ` +
      `nenhum CSM do mapa; criando com createdBy=${CREATED_BY} como fallback`
  );
  return { id: CREATED_BY, identificado: false };
}

function soNumero(v) {
  const n = Number(String(v ?? '').replace(/\D/g, ''));
  return Number.isSafeInteger(n) ? n : 0;
}

/** "R$ 5.000,00" — mesmo formato que o campo readonly do formulario mostrava. */
function moedaBR(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  const [inteiro, centavos] = n.toFixed(2).split('.');
  return 'R$ ' + inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + centavos;
}

function tratarErro(res, e, acao) {
  if (e instanceof ErroConfigMoskit || e instanceof ErroConfigClickUp || e instanceof ErroConfig) {
    console.error('[moskit] configuracao:', e.message);
    return erro(res, 500, 'nao_configurado', 'Integração não configurada no servidor.');
  }
  if (e instanceof ErroUpstream) {
    const status = e.status === 401 || e.status === 403 ? 502 : e.status;
    return erro(res, status, 'erro_moskit', `Falha na comunicação com o Moskit (${e.status}).`);
  }
  console.error(`[moskit] acao=${acao} falha=${e?.name}: ${e?.message}`);
  return erro(res, 500, 'erro_interno', 'Erro interno ao falar com o Moskit.');
}
