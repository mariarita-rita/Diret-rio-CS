// POST /api/moskit-webhook?token=...
//
// Recebe o evento de PROJETO criado no Moskit/Ollow e, quando o projeto cai
// no board "Implantação" (id 37484, módulo Projetos — ver BOARD_IMPLANTACAO
// em _lib/moskit-projetos.js), cria o projeto de implantação correspondente
// no ClickUp automaticamente — puxando cliente, CNPJ, contato(s), notas,
// planos contratados e anexos direto do Projeto do Moskit.
//
// REESCRITO EM 2026-10-01 (a pedido da usuária, "vamos mudar praticamente
// tudo"): a versão anterior disparava em "Negócio ganho" (módulo Deal) — o
// gatilho agora é a CRIAÇÃO de um Projeto (módulo Projetos), não mais um
// negócio. Preserva só a casca HTTP de antes (CORS, token, sempre responde
// 200) — todo o miolo de parsing/regras de negócio é novo.
//
// FORMATO DO PAYLOAD — AINDA NÃO CONFIRMADO COM UM EVENTO REAL: a API do
// Moskit não lista webhooks configurados (GET /webhooks -> 404), então o
// shape exato de um evento "projeto criado" (nome dos campos de
// metadata.entity/operation, se vem `contacts`/`companies` como array igual
// à API REST ou como `contact`/`company` singular igual o webhook de
// negócio antigo, etc.) só pode ser confirmado quando a usuária configurar
// esse evento na UI do Moskit e disparar um projeto de teste de verdade.
// `extrairProjetoDoEvento` abaixo tenta aceitar os dois formatos possíveis
// (REST e webhook) ao mesmo tempo, mas isso é uma suposição até ser
// confirmado pelos logs do Vercel do primeiro evento real — por isso
// `WEBHOOK_PAUSADO` continua `true`: o payload cru é sempre logado
// (evento autenticado, token já validado), mesmo pausado, pra dar pra
// inspecionar e fechar o parser em definitivo antes de ativar de vez. Mesma
// metodologia já usada pro webhook de negócio (ver header antigo, confirmado
// com evento real em 2026-09-11).
//
// Protegido por token compartilhado na query (mesmo esquema de
// UMBLER_WEBHOOK_TOKEN em api/umbler-webhook.js). Sem sessão de usuário:
// quem chama é o Moskit, não uma pessoa logada.
//
// Sempre responde 200 (exceto token inválido): o Moskit descarta o webhook
// depois de 3 retentativas com falha — não vale a pena arriscar isso por um
// erro nosso.

import { aplicarCors, erro, lerCorpo, ErroCorpo } from './_lib/http.js';
import { listarImplantacoes, parseWaipeState, anexarArquivoTask, criarComentario } from './_lib/clickup.js';
import {
  criarProjetoImplantacao,
  sanearDadosCliente,
  dadosClienteFaltando,
  sanearOutraSolucao,
  MIME_ANEXOS_VALIDOS,
  MAX_ANEXO_BYTES,
} from './clickup.js';
import { buscarUsuario } from './_lib/moskit.js';
import {
  buscarContato,
  listarNotasProjeto,
  listarAnexosProjeto,
  listarTodosSteps,
  BOARD_IMPLANTACAO,
  CF_PROJETO,
  TIPO_IMPLANTACAO_OPCOES,
  PLANOS_CONTRATADOS_OPCOES,
  CAMPOS_SIM_NAO,
} from './_lib/moskit-projetos.js';

// Quem cria o Projeto no Moskit e é só do time Comercial: ainda não tem CSM
// definido (fica em branco — NUNCA um texto literal tipo "a definir", isso
// quebra o botão "Definir Gerente de Contas" no painel, ver memória
// csm_nao_definido_omitir_nao_literal). Quem cria e já É CSM: o próprio
// criador vira CSM e vendedor ao mesmo tempo. Qualquer outro criador (fora
// das duas listas) cai no mesmo default seguro de CSM em branco.
const CSM_CRIADOR_IDS = new Set([
  155181, // Guilherme Camargo
  144977, // Gian Luca
  153658, // Lucineia Felix
  156549, // Patrícia Carvalho
]);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }

    const tokenEsperado = process.env.MOSKIT_WEBHOOK_TOKEN;
    if (!tokenEsperado) {
      console.error('[moskit-webhook] MOSKIT_WEBHOOK_TOKEN ausente na configuração.');
      return res.status(500).json({ error: 'nao_configurado' });
    }
    if (String(req.query?.token || '') !== tokenEsperado) {
      return erro(res, 403, 'token_invalido', 'Token inválido.');
    }

    // PAUSADO: o gatilho e o parsing acabaram de ser reescritos (ver cabeçalho)
    // e ainda não foram confirmados contra um evento real de "projeto
    // criado" — continua só logando o payload cru até a usuária disparar um
    // projeto de teste e o formato ser validado pelos logs do Vercel.
    const WEBHOOK_PAUSADO = true;

    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (e) {
      if (e instanceof ErroCorpo) return res.status(200).json({ ok: true, ignorado: 'corpo_invalido' });
      throw e;
    }

    // Formato do payload ainda em confirmação (ver cabeçalho) — loga TODO
    // evento autenticado, pausado ou não, até o parsing ser fechado em
    // definitivo; depois disso vira só um log pontual de depuração.
    console.log('[moskit-webhook] evento recebido:', JSON.stringify(corpo).slice(0, 2000));

    if (WEBHOOK_PAUSADO) {
      console.log('[moskit-webhook] webhook PAUSADO (ver comentário no código) — evento só logado, não processado.');
      return res.status(200).json({ ok: true, ignorado: 'webhook_pausado' });
    }

    await processarEvento(corpo);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[moskit-webhook] falha inesperada:', e?.name, e?.message);
    // 200 mesmo em falha nossa — ver nota no topo sobre o Moskit descartar o webhook.
    return res.status(200).json({ ok: true });
  }
}

/** `customFieldValues` (formato de webhook, visto no evento de negócio antigo,
 * campo `numberValue`) OU `entityCustomFields` (formato da API REST, campo
 * `numericValue`) -> sempre o mesmo shape que valorCampoPersonalizado/os
 * resolvedores de opção abaixo esperam. Aceita os dois porque o formato real
 * do evento de Projeto ainda não foi confirmado (ver cabeçalho). */
function normalizarCustomFields(campos) {
  if (!Array.isArray(campos)) return [];
  return campos.map((c) => ({
    id: c.id,
    textValue: c.textValue,
    numericValue: c.numericValue != null ? c.numericValue : c.numberValue,
    dateValue: c.dateValue,
    options: Array.isArray(c.options) ? c.options : [],
  }));
}

// As funções puras abaixo são exportadas (além do handler default) só pra
// dar pra testar o parsing isoladamente contra um projeto real, sem criar
// nada no ClickUp (ver verificação ao vivo feita em 2026-10-01, antes de
// ativar o webhook). Não mudam o comportamento do handler em nada.

/** Valor de um campo de texto/número pelo id — '' se ausente. */
export function valorCampoPersonalizado(entityCustomFields, id) {
  const campo = entityCustomFields.find((c) => c.id === id);
  if (!campo) return '';
  if (campo.textValue != null) return String(campo.textValue);
  if (campo.numericValue != null) return String(campo.numericValue);
  if (campo.dateValue != null) return String(campo.dateValue);
  return '';
}

/** Id da opção selecionada de um campo SINGLE_OPTION — null se nenhuma. */
export function opcaoUnicaSelecionada(entityCustomFields, id) {
  const campo = entityCustomFields.find((c) => c.id === id);
  return campo?.options?.[0] ?? null;
}

/** Ids das opções selecionadas de um campo MULTIPLE_OPTION — [] se nenhuma. */
export function opcoesMultiplasSelecionadas(entityCustomFields, id) {
  const campo = entityCustomFields.find((c) => c.id === id);
  return Array.isArray(campo?.options) ? campo.options : [];
}

/**
 * Extrai o Projeto do payload do webhook, já normalizado: `after` é o estado
 * pós-criação (interessa esse); `before` só serve de fallback se `after`
 * vier ausente. Aceita `contacts`/`companies` como array (formato REST) OU
 * `contact`/`company` como objeto único (formato visto no webhook de
 * negócio antigo) — ver cabeçalho sobre o formato ainda não confirmado.
 * Retorna null se não achar um projeto com id válido.
 */
export function extrairProjetoDoEvento(corpo) {
  const projeto = corpo?.after || corpo?.before;
  if (!projeto || !Number.isFinite(Number(projeto.id))) return null;
  const contatosBrutos = Array.isArray(projeto.contacts)
    ? projeto.contacts
    : projeto.contact
      ? [projeto.contact]
      : [];
  return {
    id: Number(projeto.id),
    nome: typeof projeto.name === 'string' ? projeto.name : '',
    stepId: projeto.step?.id ?? null,
    criadorId: projeto.createdBy?.id ?? null,
    contatoIds: contatosBrutos.map((c) => Number(c?.id)).filter((id) => Number.isFinite(id)),
    entityCustomFields: normalizarCustomFields(projeto.entityCustomFields || projeto.customFieldValues),
  };
}

function telefoneDe(contato) {
  if (!contato) return '';
  const principal = contato.phones?.find((p) => p.id === contato.primaryPhone?.id);
  return principal?.number || contato.phones?.[0]?.number || '';
}

function emailDe(contato) {
  if (!contato) return '';
  const principal = contato.emails?.find((e) => e.id === contato.primaryEmail?.id);
  return principal?.address || contato.emails?.[0]?.address || '';
}

/**
 * Frase de contexto pros 4 campos Sim/Não (Outro CNPJ conosco?/Duplicação de
 * dados?/Migração de base?/Importação de outro sistema?) — NUNCA a resposta
 * crua ("Sim ✅"/"Não ❌"): puxar só a resposta não faz sentido fora do
 * contexto da pergunta (pedido explícito da usuária). Sem resposta
 * selecionada, a frase é omitida (ausência de resposta não é o mesmo que
 * "Não").
 */
export function fraseCampoSimNao(entityCustomFields, campoId) {
  const config = CAMPOS_SIM_NAO[campoId];
  if (!config) return null;
  const idSelecionado = opcaoUnicaSelecionada(entityCustomFields, campoId);
  if (idSelecionado == null) return null;
  return idSelecionado === config.idSim ? config.frases.sim : config.frases.nao;
}

/**
 * Planos contratados ("💠 Plano(s) Contratado(s)") -> array de { produto,
 * planoSugerido } já resolvido, incluindo a desambiguação de Simplaz (o
 * campo não diz se é Simplaz-Gestor ou Simplaz-Unique — decide pela base
 * (Gestor/Unique) que também está selecionada no mesmo projeto; sem
 * nenhuma das duas, cai no default "Simplaz Gestor" com um aviso nas
 * observações do item).
 */
export function resolverPlanosContratados(entityCustomFields) {
  const idsSelecionados = opcoesMultiplasSelecionadas(entityCustomFields, CF_PROJETO.PLANOS_CONTRATADOS);
  const entradas = idsSelecionados
    .map((id) => PLANOS_CONTRATADOS_OPCOES[id])
    .filter(Boolean);

  const temGestor = entradas.some((e) => e.produto === 'Gestor');
  const temUnique = entradas.some((e) => e.produto === 'Unique');
  const temWaipe = entradas.some((e) => e.produto.startsWith('Waipe'));

  const planos = entradas.map((e) => {
    if (e.produto !== 'Simplaz') return { produto: e.produto, planoSugerido: e.planoSugerido, observacoes: '' };
    if (temGestor) return { produto: 'Simplaz Gestor', planoSugerido: e.planoSugerido, observacoes: '' };
    if (temUnique) return { produto: 'Simplaz Unique', planoSugerido: e.planoSugerido, observacoes: '' };
    return {
      produto: 'Simplaz Gestor',
      planoSugerido: e.planoSugerido,
      observacoes: 'Base (Gestor/Unique) não identificada entre os planos contratados — confirmar com o Comercial.',
    };
  });

  return { planos, temGestor, temUnique, temWaipe };
}

export async function processarEvento(corpo) {
  const projeto = extrairProjetoDoEvento(corpo);
  if (!projeto) return;
  const projetoMoskitId = projeto.id;

  // Só interessa um Projeto do board "Implantação" — qualquer outro board
  // do módulo Projetos (ex: Renovação, Pós-venda) é ignorado aqui.
  const steps = await listarTodosSteps();
  const step = steps.find((s) => s.id === projeto.stepId);
  if (!step || step.board?.id !== BOARD_IMPLANTACAO) return;

  // Idempotência: o webhook pode reenviar o mesmo evento (retentativa) ou
  // disparar de novo numa edição posterior do mesmo projeto já criado.
  const projetosClickUp = await listarImplantacoes();
  const jaExiste = projetosClickUp.some(
    (t) => Number(parseWaipeState(t.description)?.origemMoskitProjetoId) === projetoMoskitId
  );
  if (jaExiste) return;

  const ecf = projeto.entityCustomFields;

  const tipoImplantacaoId = opcaoUnicaSelecionada(ecf, CF_PROJETO.TIPO_IMPLANTACAO);
  const tipoImplantacaoLabel = TIPO_IMPLANTACAO_OPCOES[tipoImplantacaoId] || 'Implantação';
  const razaoSocial = valorCampoPersonalizado(ecf, CF_PROJETO.RAZAO_SOCIAL) || projeto.nome || 'Cliente sem nome';
  const cliente = semAspasRetas(`${tipoImplantacaoLabel} - ${razaoSocial}`);

  const cnpj = valorCampoPersonalizado(ecf, CF_PROJETO.CNPJ) || valorCampoPersonalizado(ecf, CF_PROJETO.CNPJ_RELACIONADO);
  // Vazio nunca bloqueia a criação — a usuária pediu explicitamente pra não
  // travar por falta de ID Núcleo (projeto criado pelo Comercial ainda não
  // tem esse dado); preenche com '0' e segue.
  const idNucleo = valorCampoPersonalizado(ecf, CF_PROJETO.ID_NUCLEO) || '0';

  const criadorId = projeto.criadorId;
  const criadorUsuario = criadorId ? await buscarUsuario(criadorId).catch(() => null) : null;
  const vendedor = semAspasRetas(texto200(criadorUsuario?.name) || 'Não identificado');
  const csmNome = criadorId && CSM_CRIADOR_IDS.has(criadorId) ? vendedor : '';

  const contatos = (
    await Promise.all(projeto.contatoIds.map((id) => buscarContato(id).catch(() => null)))
  ).filter(Boolean);
  const contatoPrincipal = contatos[0] || null;
  const telefone = telefoneDe(contatoPrincipal);
  const email = emailDe(contatoPrincipal);
  // O principal tem nome próprio (nomeContato, junto do telefone/e-mail
  // dele); os demais contatos do Moskit entram em contatosAdicionais —
  // nenhum se perde, e o principal não aparece duplicado no seletor de
  // contatos da conversa do Utalk.
  const nomeContato = semAspasRetas(texto200(contatoPrincipal?.name));
  const contatosAdicionais = contatos.slice(1)
    .map((c) => ({ nome: semAspasRetas(texto200(c?.name)), telefone: telefoneDe(c) }))
    .filter((c) => c.telefone);

  const dadosCliente = sanearDadosCliente({ idNucleo, cnpj, email, telefone, nomeContato, contatosAdicionais });
  const faltando = dadosClienteFaltando(dadosCliente);
  const ausentesNaoBloqueantes = faltando.filter((f) => f === 'E-mail' || f === 'Telefone');
  if (ausentesNaoBloqueantes.length) {
    console.error(`[moskit-webhook] projeto ${projetoMoskitId} criado sem ${ausentesNaoBloqueantes.join(', ')} (contato do Moskit sem esse dado)`);
  }
  const bloqueantes = faltando.filter((f) => !ausentesNaoBloqueantes.includes(f));
  if (bloqueantes.length) {
    console.error(`[moskit-webhook] projeto ${projetoMoskitId} sem dados suficientes (${bloqueantes.join(', ')}) — projeto não criado`);
    return;
  }

  // Contexto: necessidades do cliente + observações pro CS, sem duplicar
  // quando os dois campos vêm com o mesmo texto (acontece na prática) — mais
  // as 4 frases de Sim/Não (nunca a resposta crua, ver fraseCampoSimNao).
  const necessidades = valorCampoPersonalizado(ecf, CF_PROJETO.NECESSIDADES_CLIENTE).trim();
  const observacoesCs = valorCampoPersonalizado(ecf, CF_PROJETO.OBSERVACOES_CS).trim();
  const textosLivres = necessidades.toLowerCase() === observacoesCs.toLowerCase()
    ? [necessidades]
    : [necessidades, observacoesCs];
  const frasesSimNao = [
    CF_PROJETO.OUTRO_CNPJ_CONOSCO,
    CF_PROJETO.DUPLICACAO_DE_DADOS,
    CF_PROJETO.MIGRACAO_DE_BASE,
    CF_PROJETO.IMPORTACAO_DE_OUTRO_SISTEMA,
  ].map((campoId) => fraseCampoSimNao(ecf, campoId));
  const contexto = semAspasRetas([...textosLivres, ...frasesSimNao].filter(Boolean).join('\n\n')).slice(0, 6000);

  const resolvidos = resolverPlanosContratados(ecf);
  const { temGestor, temUnique, temWaipe } = resolvidos;
  // "Treinamento": o cliente já tem o produto e só precisa aprender a usar —
  // cada plano vira um item de Treinamento ("Treinamento — Gestor Básico
  // Cloud"), nunca a inclusão do plano em si (pedido da usuária, 2026-10-02).
  const planos = tipoImplantacaoId === 777785
    ? resolvidos.planos.map((p) => ({ ...p, planoSugerido: [p.produto, p.planoSugerido].filter(Boolean).join(' '), produto: 'Treinamento' }))
    : resolvidos.planos;

  // "Cliente Novo": sempre entra o item base (Gestor/Unique) + 3 treinamentos
  // nomeados a partir dessa mesma base, mais 1 treinamento Waipe quando
  // algum plano Waipe também foi contratado.
  const itensExtras = [];
  if (tipoImplantacaoId === 760358) {
    const baseTreinamento = temGestor ? 'Gestor' : temUnique ? 'Unique' : null;
    if (baseTreinamento) {
      for (let i = 1; i <= 3; i++) {
        itensExtras.push({ produto: 'Treinamento', planoSugerido: `${baseTreinamento} ${i}`, observacoes: '' });
      }
    } else {
      console.error(`[moskit-webhook] projeto ${projetoMoskitId}: Cliente Novo sem Gestor nem Unique entre os planos contratados — treinamentos padrão não adicionados.`);
    }
    if (temWaipe) {
      itensExtras.push({ produto: 'Treinamento', planoSugerido: 'Waipe', observacoes: '' });
    }
  }

  const solucoes = [...planos, ...itensExtras]
    .map((p) => sanearOutraSolucao({
      produto: p.produto,
      planoSugerido: p.planoSugerido,
      observacoes: p.observacoes || '',
      quantidade: 1,
      valorManual: 0,
      incluir: true,
    }))
    .filter(Boolean);

  if (!solucoes.length) {
    console.error(`[moskit-webhook] projeto ${projetoMoskitId} criado sem nenhum plano contratado reconhecido — projeto não criado`);
    return;
  }

  const projetoClickUp = await criarProjetoImplantacao({
    nomeProjeto: cliente,
    cliente,
    contexto,
    dadosCliente,
    agentes: [],
    solucoes,
    ismProjeto: [],
    csmNome,
    vendedor,
    origemMoskitProjetoId: projetoMoskitId,
  });

  await copiarAnexosDoProjeto(projetoClickUp.id, projetoMoskitId);
  await migrarNotasComoComentarios(projetoClickUp.id, projetoMoskitId);

  console.log(`[moskit-webhook] projeto ${projetoClickUp.id} criado a partir do Projeto Moskit ${projetoMoskitId} (${cliente})`);
}

/**
 * Copia pro projeto todo arquivo já anexado ao Projeto no Moskit. Cada
 * arquivo passa pela MESMA allowlist de MIME/tamanho do upload manual — um
 * anexo que não passa é só ignorado (logado), nunca derruba a criação.
 */
async function copiarAnexosDoProjeto(projetoClickUpId, projetoMoskitId) {
  const anexos = await listarAnexosProjeto(projetoMoskitId).catch((e) => {
    console.error(`[moskit-webhook] falha ao listar anexos do projeto ${projetoMoskitId}:`, e?.message);
    return [];
  });
  for (const anexo of Array.isArray(anexos) ? anexos : []) {
    const nomeArquivo = texto200(anexo?.filename) || 'arquivo';
    try {
      const mimeType = String(anexo?.mimeType || '').toLowerCase();
      if (!MIME_ANEXOS_VALIDOS.has(mimeType)) {
        console.error(`[moskit-webhook] anexo "${nomeArquivo}" do projeto ${projetoMoskitId} ignorado: tipo "${mimeType}" não permitido.`);
        continue;
      }
      if (Number(anexo?.size) > MAX_ANEXO_BYTES) {
        console.error(`[moskit-webhook] anexo "${nomeArquivo}" do projeto ${projetoMoskitId} ignorado: maior que o limite (${anexo.size} bytes).`);
        continue;
      }
      const resposta = await fetch(anexo.url);
      if (!resposta.ok) {
        console.error(`[moskit-webhook] falha ao baixar anexo "${nomeArquivo}" do projeto ${projetoMoskitId}: ${resposta.status}`);
        continue;
      }
      const buffer = Buffer.from(await resposta.arrayBuffer());
      await anexarArquivoTask(projetoClickUpId, { nomeArquivo, mimeType, base64: buffer.toString('base64') });
    } catch (e) {
      console.error(`[moskit-webhook] falha ao copiar anexo "${nomeArquivo}" do projeto ${projetoMoskitId}:`, e?.message);
    }
  }
}

/**
 * Cada Nota do Projeto no Moskit vira o SEU PRÓPRIO comentário nativo no
 * ClickUp (não um só consolidado) — formatado com data/hora real e o nome de
 * quem comentou, resolvido via buscarUsuario. Autores repetidos são
 * cacheados num Map pra não buscar o mesmo usuário várias vezes.
 */
async function migrarNotasComoComentarios(projetoClickUpId, projetoMoskitId) {
  const notas = await listarNotasProjeto(projetoMoskitId).catch((e) => {
    console.error(`[moskit-webhook] falha ao listar notas do projeto ${projetoMoskitId}:`, e?.message);
    return [];
  });
  const nomesPorAutor = new Map();
  async function nomeDoAutor(id) {
    if (!id) return 'Moskit';
    if (nomesPorAutor.has(id)) return nomesPorAutor.get(id);
    const usuario = await buscarUsuario(id).catch(() => null);
    const nome = texto200(usuario?.name) || `Usuário ${id}`;
    nomesPorAutor.set(id, nome);
    return nome;
  }
  // Ordem cronológica real (a API devolve mais recente primeiro) — comentário
  // mais antigo entra primeiro, igual ao protocolo de migração manual.
  const ordenadas = [...(Array.isArray(notas) ? notas : [])].sort(
    (a, b) => Date.parse(a.dateCreated || 0) - Date.parse(b.dateCreated || 0)
  );
  for (const nota of ordenadas) {
    const texto = String(nota?.description || '').trim();
    if (!texto) continue;
    try {
      const autor = await nomeDoAutor(nota?.user?.id);
      const dataHora = nota.dateCreated
        ? new Date(nota.dateCreated).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : '';
      const prefixo = dataHora ? `${dataHora} — ${autor}:` : `${autor}:`;
      await criarComentario(projetoClickUpId, `${prefixo} ${texto}`);
    } catch (e) {
      console.error(`[moskit-webhook] falha ao migrar nota do projeto ${projetoMoskitId} como comentário:`, e?.message);
    }
  }
}

function texto200(v) {
  return typeof v === 'string' ? v.trim().slice(0, 200) : '';
}

/**
 * Aspas retas corrompem o bloco de estado JSON embutido no description (o
 * ClickUp remove a barra de escape ao salvar, ver memória
 * bug_aspas_waipestate) — `cliente`/`vendedor`/`csmNome` vão direto pro JSON
 * de estado (criarProjetoImplantacao usa `texto()`, que só trunca, nunca
 * sanitiza) e `contexto` é texto digitado por cliente/comercial no Moskit,
 * então pode perfeitamente conter uma aspa reta. Mesma defesa já usada em
 * api/clickup.js (semAspasRetas/textoLivre): troca por aspas simples em vez
 * de tentar escapar certo algo que o ClickUp vai desescapar de qualquer jeito.
 */
function semAspasRetas(s) {
  return String(s || '').replace(/"/g, "'");
}
