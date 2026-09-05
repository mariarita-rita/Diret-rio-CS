// Proxy da Claude API — usado hoje só pela aba de proposta do simulador Waipe
// pra ler a transcrição de uma consultoria e sugerir os outros produtos do
// ecossistema (Gestor, Simplaz, Unique, BIME APP). O motor de sugestão de
// AGENTES do Waipe continua sendo o de sempre (palavra-chave, no front) — esta
// ação só preenche cliente/segmento/dores e aponta oportunidades de outros
// produtos, nunca escreve nada no ClickUp.
//
//   POST /api/ia?action=analisar-transcricao   { transcricao }
//
// Mesmo portão de sessão do resto do painel: consulta fica de fora (é uso
// pago, mesmo critério de podeEscrever já usado pro ClickUp).

import { aplicarCors, erro, ipCliente, lerCorpo, texto, ErroCorpo } from './_lib/http.js';
import { exigirSessao, podeEscrever, ErroConfig } from './_lib/auth.js';

const MODELO = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
// Transcrição de reunião pode passar longe do teto padrão de 100KB do resto do
// painel — 600KB de corpo dá margem generosa pra uma reunião longa.
const LIMITE_CORPO_BYTES = 600 * 1024;
const MAX_TRANSCRICAO = 500000;

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

SIMPLAZ GESTOR (empresários, gestão de notas fiscais) — Bronze/Silver/Gold: a diferença entre os planos é volume de XMLs processados por mês e número de usuários, não funcionalidade.

SIMPLAZ UNIQUE (contadores, gestão de notas fiscais de vários clientes) — Bronze/Silver/Gold: volume de manifestos e usuários, MAIS a Integração Unique, que só existe a partir do plano Silver — é o gatilho de feature real desta linha.

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

Regras gerais: só recomende um produto se a transcrição realmente sugerir a necessidade dele — não invente; "recomendacoes" pode ser array vazio; nunca recomende o Módulo Indústria como oferta pronta; "quantidadeSugerida" só quando a transcrição der um número explícito, senão null (não estime nem arredonde).

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

async function chamarClaude(transcricao) {
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
      max_tokens: 4096,
      // Sem isso o modelo gasta a maior parte do orçamento de max_tokens
      // "pensando" (thinking_tokens) e corta a resposta em JSON antes de
      // fechar — não precisamos do raciocínio exposto, só do JSON final.
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: INSTRUCOES, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Transcrição da reunião:\n\n${transcricao}` }],
    }),
  });

  if (!r.ok) {
    await r.text().catch(() => '');
    throw new ErroUpstreamIa(r.status);
  }
  const corpo = await r.json();
  const respostaTexto = corpo?.content?.find((b) => b.type === 'text')?.text || '';
  const parsed = jsonTolerante(respostaTexto);
  if (!parsed) {
    console.error(`[ia] resposta_nao_json (stop_reason=${corpo?.stop_reason}): ${respostaTexto.slice(0, 500)}`);
    throw new Error('resposta_nao_json');
  }
  return sanearResultado(parsed);
}

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

    if (req.method !== 'POST' || acao !== 'analisar-transcricao') {
      return erro(res, 400, 'acao_invalida', 'Ação inválida.');
    }

    res.setHeader('Cache-Control', 'no-store');
    if (!podeEscrever(sessao)) {
      return erro(res, 403, 'somente_leitura', 'Seu perfil tem acesso somente de leitura.');
    }

    const agora = Date.now();
    const ip = ipCliente(req);
    limparExpirados(agora);
    if (limiteAtingido(ip, agora)) {
      res.setHeader('Retry-After', String(Math.ceil(JANELA_MS / 1000)));
      return erro(res, 429, 'muitas_tentativas', 'Muitas análises em pouco tempo. Aguarde alguns minutos.');
    }

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

    registrarChamada(ip, agora);

    let resultado;
    try {
      resultado = await chamarClaude(transcricao);
    } catch (e) {
      if (e instanceof ErroConfigIa) throw e;
      if (e instanceof ErroUpstreamIa) {
        return erro(res, 502, 'falha_ia', 'A IA não respondeu — tente novamente em instantes.');
      }
      if (e.message === 'resposta_nao_json') {
        return erro(res, 502, 'falha_ia', 'A IA não devolveu um resultado válido — tente novamente.');
      }
      throw e;
    }

    return res.status(200).json(resultado);
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigIa) {
      console.error('[ia] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Análise por IA não configurada no servidor.');
    }
    console.error(`[ia] falha inesperada em action=${acao}: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno ao processar a análise.');
  }
}
