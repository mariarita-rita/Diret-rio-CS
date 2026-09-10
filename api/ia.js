// Proxy da Claude API.
//
//   POST /api/ia?action=analisar-transcricao            { transcricao }
//        Usado pela aba de proposta do simulador Waipe pra ler a transcrição
//        de uma consultoria e sugerir os outros produtos do ecossistema
//        (Gestor, Simplaz, Unique, BIME APP). O motor de sugestão de AGENTES
//        do Waipe continua sendo o de sempre (palavra-chave, no front) — esta
//        ação só preenche cliente/segmento/dores e aponta oportunidades de
//        outros produtos, nunca escreve nada no ClickUp.
//
//   POST /api/ia?action=resumir-conversa-umbler         { id }
//        SOB DEMANDA (nunca automático — custo por chamada): lê a conversa
//        recente no Umbler Talk desse projeto, resume com a IA, e grava o
//        resumo como COMENTÁRIO do projeto no ClickUp, marcado como resumo
//        de IA (ver MARCADOR_RESUMO_CONVERSA). Esse comentário é o registro
//        histórico que action=gerar-relatorio-finalizacao lê depois.
//
//   POST /api/ia?action=analisar-reuniao-implantacao    { id, transcricao }
//        Mesma ideia, pra transcrição de reunião (kickoff, diagnóstico etc)
//        — resume com a IA e grava como comentário marcado
//        (MARCADOR_RESUMO_REUNIAO).
//
//   POST /api/ia?action=gerar-relatorio-finalizacao     { id }
//        Gera o RASCUNHO do relatório de finalização do projeto — NÃO relê
//        conversas/transcrições brutas, só os comentários já marcados como
//        resumo de IA (dos dois pontos acima) + dados objetivos (dias em
//        aberto, CSM, ISM). Não salva nada sozinho: a tela mostra o rascunho
//        editável, e salvar passa pela ação normal `atualizar-implantacao`
//        (campo `finalizacao`), igual qualquer outro campo do projeto.
//
// Mesmo portão de sessão do resto do painel: consulta fica de fora (é uso
// pago, mesmo critério de podeEscrever já usado pro ClickUp). O limitador de
// chamadas por IP é COMPARTILHADO entre todas as ações desta função — é o
// controle de custo real (uso pontual, sob demanda, nunca em loop).

import { aplicarCors, erro, ipCliente, lerCorpo, taskIdValido, texto, ErroCorpo } from './_lib/http.js';
import { exigirSessao, podeEscrever, pertenceAoCsm, ErroConfig } from './_lib/auth.js';
import {
  criarComentario,
  csmDaDescricaoImplantacao,
  ISM_OPCOES,
  listarComentarios,
  LISTA_IMPLANTACOES_WAIPE,
  obterTask,
  parseWaipeState,
} from './_lib/clickup.js';
import { telefoneParaE164, buscarHistoricoConversa, ErroUmbler, ErroConfigUmbler } from './_lib/umbler.js';

const MODELO = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
// Transcrição de reunião pode passar longe do teto padrão de 100KB do resto do
// painel — 600KB de corpo dá margem generosa pra uma reunião longa.
const LIMITE_CORPO_BYTES = 600 * 1024;
const MAX_TRANSCRICAO = 500000;

// Prefixo ESTÁVEL (sem acento, texto fixo) — é por ele que
// gerar-relatorio-finalizacao acha os resumos já registrados. Nunca muda o
// texto deste marcador sem migrar os comentários já gravados.
const MARCADOR_RESUMO_CONVERSA = '[Resumo IA - Conversa]';
const MARCADOR_RESUMO_REUNIAO = '[Resumo IA - Reuniao]';

/**
 * Mesma resolução de posse usada em api/clickup.js (resolverImplantacao) —
 * duplicada aqui (função pequena) pra não acoplar os dois arquivos por causa
 * de uma função interna que não é exportada da lib.
 */
async function resolverImplantacao(taskId) {
  const tarefa = await obterTask(taskId);
  if (!tarefa || String(tarefa.list?.id || '') !== LISTA_IMPLANTACOES_WAIPE) return null;
  if (!tarefa.parent) return { tarefa, projeto: tarefa };
  const projeto = await obterTask(String(tarefa.parent));
  if (!projeto) return null;
  return { tarefa, projeto };
}

// "ism" ve/edita tudo igual "gestao" dentro de implantacao — so csm continua
// restrito a propria carteira. A diferenca de nivel fica so nos dados
// financeiros (carteira/metas/cliente), nunca aqui.
function checarPosseProjeto(sessao, projeto) {
  const csm = csmDaDescricaoImplantacao(projeto.description);
  if (sessao.nivel === 'csm' && !pertenceAoCsm(csm, sessao.csm)) {
    return 'Este projeto não está na sua carteira.';
  }
  return null;
}

class ErroConfigIa extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY nao configurada.');
    this.name = 'ErroConfigIa';
  }
}

class ErroUpstreamIa extends Error {
  constructor(status) {
    super(`Claude API respondeu ${status}`);
    this.name = 'ErroUpstreamIa';
    this.status = status;
  }
}

// ── Rate limit por IP, mesmo padrão de api/login.js ────────────────────────
// Aqui a preocupação não é força bruta, é custo: uma chamada de IA é paga por
// uso, e isso trava um loop acidental gastando a cota — o controle de custo
// de verdade é o baixo volume de uso (uso pontual, não contínuo) + cache de
// prompt no bloco de catálogo, que se repete em toda chamada.
const JANELA_MS = 10 * 60 * 1000;
const MAX_CHAMADAS = 15;
const MAX_ENTRADAS = 5000;
const chamadas = new Map();

function limparExpirados(agora) {
  for (const [ip, reg] of chamadas) {
    if (agora - reg.inicio > JANELA_MS) chamadas.delete(ip);
  }
  if (chamadas.size > MAX_ENTRADAS) chamadas.clear();
}

function limiteAtingido(ip, agora) {
  const reg = chamadas.get(ip);
  if (!reg) return false;
  if (agora - reg.inicio > JANELA_MS) {
    chamadas.delete(ip);
    return false;
  }
  return reg.total >= MAX_CHAMADAS;
}

function registrarChamada(ip, agora) {
  const reg = chamadas.get(ip);
  if (!reg || agora - reg.inicio > JANELA_MS) {
    chamadas.set(ip, { total: 1, inicio: agora });
    return;
  }
  reg.total += 1;
}

// ── Catálogo condensado — não os PDFs crus, grandes e granulares demais ────

const CATALOGO_PRODUTOS = `
CATÁLOGO DE PRODUTOS LONDRISOFT (além do Waipe, que já tem seu próprio motor de recomendação por palavra-chave — não recomende agentes ou funcionalidades do Waipe aqui):

GESTOR (ERP) — 4 planos, por funcionalidade, cada um inclui o anterior:
- NF-e: só emissão de nota fiscal eletrônica, sem controle de vendas/estoque/financeiro.
- Básico: adiciona vendas, estoque e financeiro simples, PDV, cadastro de clientes/fornecedores.
- Intermediário: adiciona código de barras, simulação de preço, contratos, financeiro mais completo, integração com Mercado Livre.
- Avançado: multi-filial/multi-empresa, gerente de conta dedicado, consolidação financeira entre filiais. Inclui também o Módulo Indústria (produção, ordem de fabricação, ficha técnica) — MAS esse módulo não tem mais manutenção ativa: NUNCA recomende como oferta pronta; se o perfil do cliente parecer precisar dele, use o campo "atencao" pedindo pra verificar disponibilidade com a coordenação antes de ofertar.

SIMPLAZ GESTOR (empresários que já usam o Gestor) — NÃO emite nota fiscal (quem emite é o próprio Gestor, desde o plano NF-e); o Simplaz importa automaticamente o XML de saída do Gestor (sem precisar mandar por e-mail pro contador) e manifesta as notas fiscais de ENTRADA. Bronze/Prata/Ouro: a diferença é o volume de manifestação de entrada por mês (Bronze até 20 XML/mês, Prata até 150, Ouro até 300) e número de usuários — nunca confunda com o volume de notas que o cliente emite, nem com armazenamento (que é igual nos 3 planos).

SIMPLAZ UNIQUE (mesma função do Simplaz Gestor — manifestação de notas de ENTRADA, nunca emissão —, mas pra contadores que atendem vários clientes) — Bronze/Prata/Ouro: mesma lógica, aqui medida em notas por mês (Bronze até 1.000, Prata até 2.000, Ouro até 4.000) e usuários, MAIS a Integração Unique, que só existe a partir do plano Prata — é o gatilho de feature real desta linha.

UNIQUE (software contábil completo — folha, fiscal, contábil) — 4 planos:
- Light: até 6 empresas geridas, 1 usuário grátis, só os módulos essenciais.
- Plus: empresas ilimitadas, 2 usuários grátis, adiciona remessa bancária, relatórios customizados/com marca própria, painéis administrativos.
- Premium: 5 usuários grátis, gerente de conta dedicado, acesso prioritário a atualizações, cálculo de Simples Nacional integrado, depreciação de bens.
- Empresarial: 50 usuários grátis, mesmo conjunto do Premium em escala maior, pra operações grandes.

BIME APP (aplicativo de vendas externas) — sem níveis; critério binário: o cliente tem vendedor(es) atuando externamente que precisam lançar pedido/venda remotamente (fora do escritório)? Se sim, recomende o BIME APP.
`.trim();

const REGRAS_WAIPE = `
REGRAS DO DIAGNÓSTICO WAIPE (Individual/Time/Enterprise — preencha "waipeDiagnostico" com o que a transcrição indicar sobre o uso do Waipe especificamente):
- "usuarios": quantas pessoas vão usar o Waipe (mínimo 1).
- "empresas": quantas empresas do grupo econômico precisam consultar dados no Waipe (mínimo 1).
- "governanca": "sim" se o cliente precisa controlar quem acessa o quê (permissões por usuário); senão "nao".
- "auditoria": "sim" se precisa auditar o uso ou ter relatório por pessoa; senão "nao".
- "automacao": "personalizada" SÓ quando o cliente precisa mudar a estrutura de uma automação ou integrar o Waipe Flow a um sistema externo — isso é o único caminho pro Enterprise; "pronta" em qualquer outro caso (só ativar modelos prontos e ajustar parâmetros).
- "enterprisePorVolume": "sim" se o cliente pede Enterprise só por causa de volume, número de usuários ou de empresas (isso NÃO justifica Enterprise sozinho, é um sinal de alerta) — senão "nao".
- Quando a transcrição não der sinal suficiente pra um campo, use o padrão seguro: usuarios=1, empresas=1, governanca="nao", auditoria="nao", automacao="pronta", enterprisePorVolume="nao".
`.trim();

const INSTRUCOES = `Você vai ler a transcrição de uma reunião de consultoria da Londrisoft com um cliente e ajudar o time de Customer Success a montar a arquitetura de solução: qual o plano Waipe ideal, quais outros produtos/planos ofertar, e por quê.

Responda APENAS com um JSON (sem texto antes ou depois, sem bloco de código markdown), neste formato exato:
{"cliente":"nome do cliente/empresa mencionado, ou string vazia se não identificado","segmento":"segmento/ramo de atuação, ou string vazia","dores":"resumo em texto simples (não markdown) das dores e do contexto do cliente hoje, como uma nota de CSM — até 800 caracteres","waipeDiagnostico":{"usuarios":1,"empresas":1,"governanca":"sim|nao","auditoria":"sim|nao","automacao":"pronta|personalizada","enterprisePorVolume":"sim|nao"},"recomendacoes":[{"produto":"Gestor|Simplaz Gestor|Simplaz Unique|Unique|BIME APP","planoSugerido":"nome do plano/tier","motivo":"por que esse produto/plano resolve uma dor especifica mencionada","atencao":"presente SO no caso do Modulo Industria ou outra ressalva que precise checagem manual — omita nos outros casos","quantidadeSugerida":"numero de usuarios/vendedores, SOMENTE quando a transcricao citar uma quantidade clara para um produto cobrado por usuario (hoje so o BIME APP) — null nos demais casos"}]}

Regras gerais: só recomende um produto se a transcrição realmente sugerir a necessidade dele — não invente; "recomendacoes" pode ser array vazio; nunca recomende o Módulo Indústria como oferta pronta; "quantidadeSugerida" só quando a transcrição der um número explícito, senão null (não estime nem arredonde); "planoSugerido" usa exatamente os nomes de plano do catálogo abaixo (ex: "Básico"/"Intermediário"/"Avançado", "Bronze"/"Prata"/"Ouro", "Light"/"Plus"/"Premium"/"Empresarial") — nunca traduza ou invente uma variação em inglês desses nomes.

${REGRAS_WAIPE}

${CATALOGO_PRODUTOS}`;

// ── Parse tolerante do texto devolvido — o modelo às vezes embrulha em ``` ──
function jsonTolerante(texto) {
  const tentativas = [texto];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(texto);
  if (fence) tentativas.push(fence[1]);
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio !== -1 && fim > inicio) tentativas.push(texto.slice(inicio, fim + 1));
  for (const t of tentativas) {
    try {
      return JSON.parse(t);
    } catch {
      /* tenta a próxima */
    }
  }
  return null;
}

const PRODUTOS_VALIDOS = new Set(['Gestor', 'Simplaz Gestor', 'Simplaz Unique', 'Unique', 'BIME APP']);
const SIM_NAO_VALIDOS = new Set(['sim', 'nao']);
const AUTOMACAO_VALIDOS = new Set(['pronta', 'personalizada']);

/** Inteiro dentro de uma faixa, ou o padrão se vier algo fora do esperado. */
function inteiroEntre(v, min, max, padrao) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return padrao;
  return n;
}

/** Como inteiroEntre, mas devolve null (não um padrão) quando o dado não é confiável — usado em campos opcionais onde "sem informação" é diferente de um valor default. */
function inteiroOuNulo(v, min, max) {
  if (v === null || v === undefined) return null;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Valor dentro de um conjunto fechado, ou o padrão. */
function enumOuPadrao(v, validos, padrao) {
  return typeof v === 'string' && validos.has(v) ? v : padrao;
}

/** Mesmos campos e mesmos padrões seguros do formulário manual (1 usuário, 1 empresa, tudo "nao"/"pronta"). */
function sanearWaipeDiagnostico(bruto) {
  return {
    usuarios: inteiroEntre(bruto?.usuarios, 1, 500, 1),
    empresas: inteiroEntre(bruto?.empresas, 1, 500, 1),
    governanca: enumOuPadrao(bruto?.governanca, SIM_NAO_VALIDOS, 'nao'),
    auditoria: enumOuPadrao(bruto?.auditoria, SIM_NAO_VALIDOS, 'nao'),
    automacao: enumOuPadrao(bruto?.automacao, AUTOMACAO_VALIDOS, 'pronta'),
    enterprisePorVolume: enumOuPadrao(bruto?.enterprisePorVolume, SIM_NAO_VALIDOS, 'nao'),
  };
}

/** Nunca confia na resposta da IA crua — saneia tudo antes de devolver ao navegador. */
function sanearResultado(bruto) {
  const recomendacoesBrutas = Array.isArray(bruto?.recomendacoes) ? bruto.recomendacoes : [];
  const recomendacoes = recomendacoesBrutas
    .slice(0, 10)
    .map((r) => {
      const produto = typeof r?.produto === 'string' ? r.produto.trim() : '';
      if (!PRODUTOS_VALIDOS.has(produto)) return null;
      const quantidadeSugerida = inteiroOuNulo(r?.quantidadeSugerida, 1, 500);
      return {
        produto,
        planoSugerido: texto(r?.planoSugerido, 80),
        motivo: texto(r?.motivo, 400),
        ...(texto(r?.atencao, 300) ? { atencao: texto(r?.atencao, 300) } : {}),
        ...(quantidadeSugerida !== null ? { quantidadeSugerida } : {}),
      };
    })
    .filter(Boolean);

  return {
    cliente: texto(bruto?.cliente, 120),
    segmento: texto(bruto?.segmento, 120),
    dores: texto(bruto?.dores, 800),
    waipeDiagnostico: sanearWaipeDiagnostico(bruto?.waipeDiagnostico),
    recomendacoes,
  };
}

/**
 * Chamada crua à Claude API — devolve só o texto da resposta. Cada ação faz
 * seu próprio parse/saneamento (JSON estruturado ou texto livre, conforme o
 * caso), porque o formato esperado muda de ação pra ação.
 */
async function chamarClaudeTexto({ system, mensagem, maxTokens }) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) throw new ErroConfigIa();

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': chave,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: maxTokens,
      // Sem isso o modelo gasta a maior parte do orçamento de max_tokens
      // "pensando" (thinking_tokens) e corta a resposta antes de fechar —
      // não precisamos do raciocínio exposto, só do resultado final.
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: mensagem }],
    }),
  });

  if (!r.ok) {
    await r.text().catch(() => '');
    throw new ErroUpstreamIa(r.status);
  }
  const corpo = await r.json();
  const respostaTexto = corpo?.content?.find((b) => b.type === 'text')?.text || '';
  if (!respostaTexto.trim()) {
    console.error(`[ia] resposta_vazia (stop_reason=${corpo?.stop_reason})`);
    throw new Error('resposta_vazia');
  }
  return respostaTexto;
}

async function chamarClaude(transcricao) {
  const respostaTexto = await chamarClaudeTexto({
    system: INSTRUCOES,
    mensagem: `Transcrição da reunião:\n\n${transcricao}`,
    maxTokens: 4096,
  });
  const parsed = jsonTolerante(respostaTexto);
  if (!parsed) {
    console.error(`[ia] resposta_nao_json: ${respostaTexto.slice(0, 500)}`);
    throw new Error('resposta_nao_json');
  }
  return sanearResultado(parsed);
}

// ── Ação: analisar-transcricao (proposta comercial) ────────────────────────

async function analisarTranscricaoAcao(req, res) {
  let corpo;
  try {
    corpo = await lerCorpo(req, { limiteBytes: LIMITE_CORPO_BYTES });
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }

  const transcricao = texto(corpo.transcricao, MAX_TRANSCRICAO);
  if (transcricao.length < 20) {
    return erro(res, 400, 'transcricao_invalida', 'Cole a transcrição da reunião antes de analisar.');
  }

  let resultado;
  try {
    resultado = await chamarClaude(transcricao);
  } catch (e) {
    if (e instanceof ErroUpstreamIa) return erro(res, 502, 'falha_ia', 'A IA não respondeu — tente novamente em instantes.');
    if (e.message === 'resposta_nao_json' || e.message === 'resposta_vazia') {
      return erro(res, 502, 'falha_ia', 'A IA não devolveu um resultado válido — tente novamente.');
    }
    throw e;
  }
  return res.status(200).json(resultado);
}

// ── Ação: resumir-conversa-umbler ──────────────────────────────────────────

const INSTRUCOES_RESUMO_CONVERSA = `Você vai ler uma conversa de WhatsApp entre o time de Customer Success da Londrisoft e um cliente, durante um projeto de implantação do Waipe.

Resuma em até 4 frases, em texto simples (sem markdown, sem título): o assunto tratado, o status atual (ex: aguardando resposta do cliente, confirmou horário, relatou um problema, pediu pra remarcar), e qualquer sinal de satisfação ou insatisfação do cliente que apareça na conversa. Seja objetivo — não invente informação que não está na conversa. Se a conversa for só sobre agendamento, sem nada relevante além disso, diga isso em uma frase só.`;

async function resumirConversaUmblerAcao(req, res, sessao) {
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
  const negado = checarPosseProjeto(sessao, projeto);
  if (negado) return erro(res, 403, 'fora_da_carteira', negado);

  const estado = parseWaipeState(projeto.description);
  const telefoneE164 = telefoneParaE164(estado.telefone);
  if (!telefoneE164) {
    return erro(res, 400, 'telefone_invalido', 'Cadastre o telefone do cliente (Resumo do projeto) antes de resumir a conversa.');
  }

  let historico;
  try {
    historico = await buscarHistoricoConversa(telefoneE164);
  } catch (e) {
    if (e instanceof ErroUmbler || e instanceof ErroConfigUmbler) throw e;
    throw e;
  }
  if (!historico || !historico.mensagens?.length) {
    return erro(res, 400, 'sem_conversa', 'Não há conversa registrada ainda com esse telefone no Umbler Talk.');
  }

  const textoConversa = historico.mensagens
    .map((m) => `${m.deCliente ? 'Cliente' : 'Equipe'}: ${m.texto}`)
    .join('\n');

  let resumo;
  try {
    resumo = texto(await chamarClaudeTexto({ system: INSTRUCOES_RESUMO_CONVERSA, mensagem: textoConversa, maxTokens: 400 }), 2000);
  } catch (e) {
    if (e instanceof ErroUpstreamIa) return erro(res, 502, 'falha_ia', 'A IA não respondeu — tente novamente em instantes.');
    if (e.message === 'resposta_vazia') return erro(res, 502, 'falha_ia', 'A IA não devolveu um resumo válido.');
    throw e;
  }
  if (!resumo) return erro(res, 502, 'falha_ia', 'A IA não devolveu um resumo válido.');

  await criarComentario(projeto.id, `${MARCADOR_RESUMO_CONVERSA}\n${resumo}`);
  return res.status(200).json({ ok: true, resumo });
}

// ── Ação: analisar-reuniao-implantacao ─────────────────────────────────────

const INSTRUCOES_RESUMO_REUNIAO = `Você vai ler a transcrição de uma reunião entre o time de Implantação da Londrisoft e um cliente, durante um projeto de implantação do Waipe.

Resuma em texto simples (sem markdown, sem título), em até 250 palavras: as ferramentas/sistemas que o cliente usa hoje, regras ou processos importantes que ele mencionou, quais agentes ou funcionalidades foram discutidos como prioridade, e qualquer sinal de satisfação, insatisfação ou risco percebido. Seja objetivo — não invente informação que não está na transcrição.`;

async function analisarReuniaoImplantacaoAcao(req, res, sessao) {
  let corpo;
  try {
    corpo = await lerCorpo(req, { limiteBytes: LIMITE_CORPO_BYTES });
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }
  if (!taskIdValido(corpo.id)) return erro(res, 400, 'task_invalida', 'id inválido.');

  const transcricao = texto(corpo.transcricao, MAX_TRANSCRICAO);
  if (transcricao.length < 20) {
    return erro(res, 400, 'transcricao_invalida', 'Cole a transcrição da reunião antes de analisar.');
  }

  const resolvido = await resolverImplantacao(corpo.id);
  if (!resolvido) return erro(res, 404, 'nao_encontrado', 'Projeto não encontrado.');
  const { projeto } = resolvido;
  const negado = checarPosseProjeto(sessao, projeto);
  if (negado) return erro(res, 403, 'fora_da_carteira', negado);

  let resumo;
  try {
    resumo = texto(await chamarClaudeTexto({ system: INSTRUCOES_RESUMO_REUNIAO, mensagem: transcricao, maxTokens: 900 }), 3000);
  } catch (e) {
    if (e instanceof ErroUpstreamIa) return erro(res, 502, 'falha_ia', 'A IA não respondeu — tente novamente em instantes.');
    if (e.message === 'resposta_vazia') return erro(res, 502, 'falha_ia', 'A IA não devolveu um resumo válido.');
    throw e;
  }
  if (!resumo) return erro(res, 502, 'falha_ia', 'A IA não devolveu um resumo válido.');

  await criarComentario(projeto.id, `${MARCADOR_RESUMO_REUNIAO}\n${resumo}`);
  return res.status(200).json({ ok: true, resumo });
}

// ── Ação: gerar-relatorio-finalizacao ──────────────────────────────────────

const INSTRUCOES_RELATORIO_FINAL = `Você vai gerar o RASCUNHO de um relatório de finalização de um projeto de implantação do Waipe, com base SOMENTE nos resumos já registrados ao longo do projeto (não invente além do que eles dizem) e nos dados objetivos informados.

Responda APENAS com um JSON (sem texto antes ou depois, sem bloco de código), neste formato exato:
{"resumoGeral":"resumo em texto simples do que aconteceu no projeto, até 800 caracteres","riscoPercebido":"baixo|medio|alto","causaDaDemora":"string vazia se os resumos não derem sinal de causa específica de atraso, senão uma frase curta","satisfacaoPercebida":"positiva|neutra|negativa|indeterminada"}

Regras: "satisfacaoPercebida" deve ser "indeterminada" quando os resumos não tiverem sinal suficiente pra inferir isso — é esperado e aceitável, não force uma resposta só porque o campo existe. "riscoPercebido" reflete o risco de o cliente terminar insatisfeito ou com algo mal resolvido, não risco comercial. "causaDaDemora" só quando houver sinal claro (ex: vários reagendamentos, demora do cliente em responder, problema técnico recorrente).`;

async function gerarRelatorioFinalizacaoAcao(req, res, sessao) {
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
  const negado = checarPosseProjeto(sessao, projeto);
  if (negado) return erro(res, 403, 'fora_da_carteira', negado);

  const comentarios = await listarComentarios(projeto.id);
  const resumosRegistrados = comentarios
    .map((c) => String(c.comment_text || ''))
    .filter((t) => t.startsWith(MARCADOR_RESUMO_CONVERSA) || t.startsWith(MARCADOR_RESUMO_REUNIAO));
  if (!resumosRegistrados.length) {
    return erro(res, 400, 'sem_registros', 'Nenhum resumo de conversa ou reunião foi registrado neste projeto ainda — use "Resumir conversa" ou "Analisar reunião" primeiro.');
  }

  const csm = csmDaDescricaoImplantacao(projeto.description);
  const ismNomes = (projeto.assignees || [])
    .map((a) => ISM_OPCOES.find((i) => i.id === Number(a.id))?.nome)
    .filter(Boolean);
  const diasEmAberto = Number.isFinite(Number(projeto.date_created))
    ? Math.max(0, Math.round((Date.now() - Number(projeto.date_created)) / 86400000))
    : null;
  const dadosObjetivos = [
    diasEmAberto !== null ? `Dias em aberto: ${diasEmAberto}.` : null,
    `CSM: ${csm || '—'}.`,
    `ISM responsável: ${ismNomes.length ? ismNomes.join(', ') : '—'}.`,
  ].filter(Boolean).join(' ');

  const mensagem = `${dadosObjetivos}\n\nResumos registrados ao longo do projeto:\n\n${resumosRegistrados.join('\n\n---\n\n')}`;

  let respostaTexto;
  try {
    respostaTexto = await chamarClaudeTexto({ system: INSTRUCOES_RELATORIO_FINAL, mensagem, maxTokens: 1024 });
  } catch (e) {
    if (e instanceof ErroUpstreamIa) return erro(res, 502, 'falha_ia', 'A IA não respondeu — tente novamente em instantes.');
    if (e.message === 'resposta_vazia') return erro(res, 502, 'falha_ia', 'A IA não devolveu um resultado válido.');
    throw e;
  }
  const parsed = jsonTolerante(respostaTexto);
  if (!parsed) {
    console.error(`[ia] relatorio_nao_json: ${respostaTexto.slice(0, 500)}`);
    return erro(res, 502, 'falha_ia', 'A IA não devolveu um resultado válido — tente novamente.');
  }

  return res.status(200).json({
    ok: true,
    resumoGeral: texto(parsed.resumoGeral, 2000),
    riscoPercebido: RISCO_PERCEBIDO_VALIDOS.has(parsed.riscoPercebido) ? parsed.riscoPercebido : '',
    causaDaDemora: texto(parsed.causaDaDemora, 500),
    satisfacaoPercebida: SATISFACAO_PERCEBIDA_VALIDOS.has(parsed.satisfacaoPercebida) ? parsed.satisfacaoPercebida : 'indeterminada',
    resumosConsiderados: resumosRegistrados.length,
  });
}

const RISCO_PERCEBIDO_VALIDOS = new Set(['baixo', 'medio', 'alto']);
const SATISFACAO_PERCEBIDA_VALIDOS = new Set(['positiva', 'neutra', 'negativa', 'indeterminada']);

const ACOES_IA = {
  'analisar-transcricao': analisarTranscricaoAcao,
  'resumir-conversa-umbler': resumirConversaUmblerAcao,
  'analisar-reuniao-implantacao': analisarReuniaoImplantacaoAcao,
  'gerar-relatorio-finalizacao': gerarRelatorioFinalizacaoAcao,
};

export default async function handler(req, res) {
  let acao = '';
  try {
    acao = String(req.query?.action || '');

    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();

    const sessao = exigirSessao(req, res);
    if (!sessao) return undefined;

    const acaoFn = ACOES_IA[acao];
    if (req.method !== 'POST' || !acaoFn) {
      return erro(res, 400, 'acao_invalida', 'Ação inválida.');
    }

    res.setHeader('Cache-Control', 'no-store');
    if (!podeEscrever(sessao)) {
      return erro(res, 403, 'somente_leitura', 'Seu perfil tem acesso somente de leitura.');
    }

    // Limitador de custo COMPARTILHADO entre as 4 ações — cada uma custa
    // uma chamada paga, então o teto é único, não por ação.
    const agora = Date.now();
    const ip = ipCliente(req);
    limparExpirados(agora);
    if (limiteAtingido(ip, agora)) {
      res.setHeader('Retry-After', String(Math.ceil(JANELA_MS / 1000)));
      return erro(res, 429, 'muitas_tentativas', 'Muitas análises em pouco tempo. Aguarde alguns minutos.');
    }
    registrarChamada(ip, agora);

    return await acaoFn(req, res, sessao);
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigIa) {
      console.error('[ia] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Análise por IA não configurada no servidor.');
    }
    if (e instanceof ErroConfigUmbler) {
      console.error('[ia] configuracao Umbler:', e.message);
      return erro(res, 500, 'umbler_nao_configurado', 'Integração com o Umbler Talk não está configurada no servidor.');
    }
    if (e instanceof ErroUmbler) {
      console.error(`[ia] falha_umbler=${e.status}`);
      return erro(res, 502, 'erro_umbler', 'Falha ao falar com o Umbler Talk.');
    }
    console.error(`[ia] falha inesperada em action=${acao}: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno ao processar a análise.');
  }
}
