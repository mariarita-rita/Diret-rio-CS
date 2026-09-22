// Cliente somente-leitura do módulo PROJETOS do Moskit/Ollow (v2) — entidade
// DIFERENTE de Negócios (api/_lib/moskit.js só lê Negócios). Usado só pelo
// script de migração em massa (scripts/migrar-moskit-projetos.mjs), pra
// trazer pro painel de implantação em ClickUp os ~85 clientes que hoje só
// existem como Projeto no Moskit — não passaram pela automação de Negócio
// ganho (api/moskit-webhook.js), que é outro caminho e continua intacto.
//
// Peculiaridades da API confirmadas ao vivo (leitura, nada escrito) antes de
// escrever este arquivo — ver o plano da migração:
//   - GET /projects, GET /steps e GET /customFields sempre devolvem só 10
//     itens por chamada e IGNORAM limit/page/board como filtro de servidor
//     — a paginação de verdade é por cursor: o cabeçalho de resposta
//     `x-moskit-listing-next-page-token` traz o token da próxima página,
//     que volta como `?nextPageToken=...` na chamada seguinte. Sem esse
//     cursor, `listarTodosProjetos`/`listarTodosSteps`/`listarTodosCampos`
//     sempre devolveriam só a primeira página, silenciosamente.
//   - GET /customFields?module=PROJECT ignora o filtro de módulo (mesmo bug
//     documentado em docs/estado-e-proximos-passos.md pro module=DEAL) —
//     por isso listarTodosCampos() não filtra na URL, traz tudo paginado e
//     quem chama filtra module==='PROJECT' do lado de cá.
//   - GET /projects?board=... também é ignorado — o board de um Projeto só
//     dá pra saber indiretamente, via o `step.id` dele batido contra o mapa
//     step→board que listarTodosSteps() monta.

import { ErroConfigMoskit, ErroUpstreamMoskit } from './moskit.js';

const BASE = 'https://api.ms.prod.ollow.services/v2';

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET cru com retry em 429 (limite de taxa da API) — respeita o cabeçalho
 * `Retry-After` quando vem, senão usa backoff exponencial (1s, 2s, 4s...).
 * Usado por toda função deste arquivo que bate na API — o script de
 * migração faz muitas chamadas em sequência (uma por candidato, às vezes
 * mais de uma pra paginar a timeline), e sem isso um 429 no meio de uma
 * varredura de centenas de projetos derruba o script inteiro.
 */
async function moskitFetchCru(caminho) {
  const chave = process.env.MOSKIT_API_KEY;
  if (!chave) throw new ErroConfigMoskit();
  for (let tentativa = 0; ; tentativa++) {
    const r = await fetch(BASE + caminho, { headers: { Accept: 'application/json', apikey: chave } });
    if (r.status === 429 && tentativa < 6) {
      const retryAfterS = Number(r.headers.get('retry-after'));
      const esperaMs = Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 1000 * 2 ** tentativa;
      console.error(`[moskit-projetos] 429 em ${caminho} — esperando ${esperaMs}ms (tentativa ${tentativa + 1})`);
      await dormir(esperaMs);
      continue;
    }
    if (!r.ok) {
      const detalhe = await r.text().catch(() => '');
      console.error(`[moskit-projetos] GET ${caminho} -> ${r.status}: ${detalhe.slice(0, 500)}`);
      throw new ErroUpstreamMoskit(r.status);
    }
    return r;
  }
}

async function moskitGetComToken(caminho, token) {
  const url = token ? `${caminho}${caminho.includes('?') ? '&' : '?'}nextPageToken=${encodeURIComponent(token)}` : caminho;
  const r = await moskitFetchCru(url);
  const corpo = await r.json().catch(() => []);
  return {
    itens: Array.isArray(corpo) ? corpo : [],
    proximoToken: r.headers.get('x-moskit-listing-next-page-token'),
    total: Number(r.headers.get('x-moskit-listing-total') || 0),
  };
}

/** Pagina um endpoint inteiro por cursor até acabar (token repetir, vir vazio, ou bater o total). */
async function listarTudo(caminho) {
  let token;
  const acumulado = [];
  for (let volta = 0; volta < 500; volta++) {
    const { itens, proximoToken, total } = await moskitGetComToken(caminho, token);
    if (!itens.length) break;
    acumulado.push(...itens);
    if (!proximoToken || proximoToken === token) break;
    if (total && acumulado.length >= total) break;
    token = proximoToken;
  }
  return acumulado;
}

export async function listarTodosProjetos() {
  return listarTudo('/projects');
}

export async function listarTodosSteps() {
  return listarTudo('/steps');
}

export async function listarTodosCamposPersonalizados() {
  return listarTudo('/customFields');
}

export async function buscarContato(id) {
  const r = await moskitFetchCru(`/contacts/${id}`);
  return r.json().catch(() => null);
}

export async function buscarEmpresa(id) {
  const r = await moskitFetchCru(`/companies/${id}`);
  return r.json().catch(() => null);
}

/**
 * Notas de um Projeto — `GET /projects/{id}/notes`, paginado por cursor
 * igual /projects, /steps, /customFields (confirmado: x-moskit-listing-
 * next-page-token/total presentes e funcionam). Usar SEMPRE isto pra buscar
 * notas de migração — uma chamada crua sem seguir o cursor corta
 * silenciosamente em 10 itens (bug real encontrado em 2026-09-18: o projeto
 * ALF tinha 11 notas, a nota mais recente — e mais importante, a que
 * fechava o projeto — ficou de fora até a usuária notar que faltava).
 */
export async function listarNotasProjeto(projetoId) {
  return listarTudo(`/projects/${projetoId}/notes`);
}

/**
 * Anexos de um Projeto — `GET /projects/{id}/attachments`, mesma paginação
 * por cursor confirmada (total/next-page-token presentes). Mesmo motivo de
 * listarNotasProjeto: nunca buscar anexo com fetch cru sem paginar.
 */
export async function listarAnexosProjeto(projetoId) {
  return listarTudo(`/projects/${projetoId}/attachments`);
}

/**
 * Timeline de eventos de um Projeto — `GET /projects/{id}/timeline`, achado
 * na investigação (não documentado em lugar nenhum do repo). Cada evento
 * tem `date`, `event` (ex: "project-step-changed", "responsible-changed",
 * "whatsapp-initiated", "attachment-added") e `description` em HTML.
 *
 * ATENÇÃO — NÃO usa o mesmo cursor dos outros endpoints: confirmado ao vivo
 * (2026-09-18) que este endpoint nunca devolve `x-moskit-listing-next-page-
 * token`/`total` (ficam null), mesmo quando existem mais eventos do que os
 * 10 default — então `listarTudo` (baseado em seguir o token) nunca
 * paginava, e o projeto ALF perdeu silenciosamente 9 dos 17 eventos reais
 * (parou em 13/08, faltando tudo de 08/09). O que FUNCIONA é pedir
 * `?quantity=` grande de uma vez só — testado, `quantity=50` trouxe os 17
 * eventos completos desse projeto. Sem header de total pra confirmar que
 * "500" é sempre suficiente, mas é uma margem generosa pra qualquer projeto
 * de implantação real (a timeline cresce por evento administrativo, não por
 * volume de dado do cliente).
 */
export async function listarTimelineProjeto(projetoId) {
  const r = await moskitFetchCru(`/projects/${projetoId}/timeline?quantity=500`);
  const corpo = await r.json().catch(() => []);
  return Array.isArray(corpo) ? corpo : [];
}

/**
 * Data em que o Projeto ENTROU no step que ele está agora — é isso que a
 * usuária quer pro recorte de Acompanhamento/Finalizado (não a última
 * interação qualquer, que podia ser de anos atrás mesmo num projeto
 * "recém-finalizado"). `GET /projects/{id}` não expõe essa data direto; o
 * jeito é ler a timeline e achar o evento `project-step-changed` mais
 * recente — ele é a transição PARA o step atual do projeto (assumindo que
 * ninguém mudou o step manualmente sem gerar esse evento, o que não temos
 * como verificar, mas é o mesmo evento que o próprio Moskit usa pra
 * registrar a mudança). Cai pra `dateCreated` do projeto se não achar
 * nenhum evento de mudança de etapa (projeto criado direto nesse step).
 */
export async function dataEntradaNoStepAtual(projeto) {
  const eventos = await listarTimelineProjeto(projeto.id);
  const mudancasDeStep = eventos.filter((e) => e.event === 'project-step-changed' && e.date);
  if (!mudancasDeStep.length) return projeto.dateCreated ? Date.parse(projeto.dateCreated) : null;
  const maisRecente = mudancasDeStep.reduce((a, b) => (Date.parse(b.date) > Date.parse(a.date) ? b : a));
  return Date.parse(maisRecente.date);
}

// Board do módulo Projetos que interessa pra essa migração (id real,
// confirmado via GET /boards) — a usuária, depois de ver a primeira
// contagem (706, bem mais que o esperado), definiu o recorte exato: só
// este board, só estes 8 steps (nem "Novo cliente"/"Boas-vindas &
// diagnóstico", que ainda nem começaram de verdade, nem "Analisar
// Desistência", nem o board separado "Arquivo - Finalizado" — esse
// arquivo fica de fora por completo).
export const BOARD_IMPLANTACAO = 37484; // "Implantação"

// Sem filtro de data — todo "não arquivado" (project.archived === false)
// nesses steps entra, não importa a última interação.
export const STEPS_SEM_FILTRO_DE_DATA = {
  AGUARDANDO_DADOS_IMPLANTACAO: 145990,
  IMPLANTACAO_AGENDADA: 145838,
  REALIZAR_ENTREGA: 145839,
  TREINAMENTO: 145840,
  REAGENDAMENTO: 146361,
  BLOQUEADO: 148328,
};

// Só entram os "não arquivados" cuja ÚLTIMA INTERAÇÃO caiu no recorte de
// data (ver dataUltimaInteracao) — pedido explícito da usuária pra não
// trazer histórico antigo demais desses dois steps específicos.
export const STEPS_COM_FILTRO_DE_DATA = {
  ACOMPANHAMENTO: 145841,
  FINALIZADO: 145842,
};

// Ids reais dos campos personalizados do módulo PROJECT (confirmados via
// GET /customFields, paginado por completo e filtrado module==='PROJECT').
// Cada valor é o `id` do campo — ver valorCampoPersonalizado (mesma função
// de api/_lib/moskit.js, reaproveitada pelo script).
export const CF_PROJETO = {
  RAZAO_SOCIAL: 'CF_K7Rm8XHRCg2o1mbN',
  CNPJ: 'CF_K7Rm8XHNSg2olmbN',
  CNPJ_RELACIONADO: 'CF_E79MrKHXSazkZmZJ', // "Qual o CNPJ relacionado? (se houver)" — fallback quando CNPJ vem vazio
  ID_NUCLEO: 'CF_42Ama1HaSXRaVmjl',
  QUANTIDADE_USUARIOS: 'CF_YXoDkYHNSKxB0MGE',
  RESPONSAVEL_EMPRESA: 'CF_gvGm3PH0CWkv9D45',
  NECESSIDADES_CLIENTE: 'CF_gvGm3PH0CWkvrD45', // "Principais necessidades do cliente"
  OBSERVACOES_CS: 'CF_QJXmAZHjCNKQND25', // "Observações adicionais para o CS" — texto livre, geralmente o mais longo
  OBSERVACOES_CSQ: 'CF_gPpD7rHkCd0Jlmvo',
  PRODUTOS_CONTRATADOS: 'CF_42Ama1HZCXRa8mjl',
  // Dados tributários — mesmos conceitos que o painel já grava em
  // persistirDadosTributarios (implantacao-waipe.html).
  REGIME_TRIBUTARIO: 'CF_gPpD7rHnidwPvmvo',
  CST_ICMS_CSOSN: 'CF_GwyMgjH9C9kQ8qLA',
  PIS_COFINS: 'CF_2wpDl9HnCa7LeqvL',
  CFOP_VENDAS: 'CF_gPpD7rHkCdwPLmvo',
  NUMERO_ULTIMA_NF: 'CF_3NrDZlHnCOyp3MP5',
  TEM_CERTIFICADO_DIGITAL: 'CF_R7PDN8HviKG6WMWJ',
  TIPO_CERTIFICADO: 'CF_dVKmQNHbi4p7xDWR',
  // Só preenchidos em projetos finalizados — a "informação a mais" que a
  // usuária notou nesse grupo.
  AVALIACAO_EXPERIENCIA: 'CF_AE5mpdHQilBn5mO3',
  EXPECTATIVAS_ATENDIDAS: 'CF_075MJZH4iPezjMaz',
  O_QUE_FALTOU: 'CF_R7PDN8HGCKG6RMWJ',
  // Links (Drive) — não são anexo binário, por isso a migração não precisa
  // baixar/reenviar arquivo nenhum pra esses.
  DOC_CSM_OU_COMERCIAL: 'CF_x1kq69HnC6vB9DzY',
  DOC_INICIAL_IMPLANTACAO: 'CF_KaZmKBHOCEoQvMJk',
  DOC_FINAL_IMPLANTACAO: 'CF_G5rMeyHNCXxk5Myj',
};
