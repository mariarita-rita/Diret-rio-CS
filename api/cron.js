// GET /api/cron?job=relatorio-finalizacao | analise-reunioes — Vercel Cron.
// Sem sessão de usuário: protegido só pelo header Authorization que a própria
// Vercel injeta em toda chamada de cron quando CRON_SECRET está configurado
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
//
// Os dois jobs vivem no MESMO arquivo (um `?job=` escolhe qual roda) só por
// causa do teto de 12 Serverless Functions do plano Hobby do Vercel — cada
// arquivo em api/ (fora de _lib/) vira uma function distinta, e já estava no
// limite. Não tem relação nenhuma de domínio entre os dois jobs; é puramente
// pra caber no teto. Ver vercel.json → "crons" (dois horários, mesmo path,
// query diferente).

import { aplicarCors, erro } from './_lib/http.js';
import {
  listarImplantacoes, parseWaipeState, stringifyWaipeState, atualizarTask,
  listarReservas, listarTokensGoogle, projetoDaDescricaoReserva,
  googleEventIdDaDescricaoReserva, responsavelDaDescricaoReserva,
  transcricaoAnalisadaDaDescricaoReserva, ISM_OPCOES,
} from './_lib/clickup.js';
import { renovarAccessToken, obterEvento, exportarDocGoogle, ErroGoogle } from './_lib/google.js';
import {
  montarRelatorioFinalizacao, ErroSemRegistros, ErroRelatorioNaoJson, ErroUpstreamIa,
  resumirReuniaoEPostar, ErroResumoVazio,
} from './ia.js';

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }

    const segredoEsperado = process.env.CRON_SECRET;
    if (!segredoEsperado) {
      console.error('[cron] CRON_SECRET ausente na configuração.');
      return res.status(500).json({ error: 'nao_configurado' });
    }
    if (req.headers.authorization !== `Bearer ${segredoEsperado}`) {
      return erro(res, 401, 'nao_autorizado', 'Não autorizado.');
    }

    const job = String(req.query?.job || 'relatorio-finalizacao');
    if (job === 'analise-reunioes') return await jobAnaliseReunioes(res);
    if (job === 'relatorio-finalizacao') return await jobRelatorioFinalizacao(res);
    return erro(res, 400, 'job_invalido', 'job inválido.');
  } catch (e) {
    console.error('[cron] erro inesperado:', e);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}

// ── Job: relatorio-finalizacao ─────────────────────────────────────────────
//
// Processa todo projeto já finalizado (status nativo "concluído" — cobre
// tanto "entregue" quanto "cancelado") que AINDA não tem `finalizacao.geradoEm`
// preenchido — nunca reprocessa um que já foi gerado. MAX_POR_EXECUCAO limita
// o quanto uma única chamada processa; o que sobrar fica pra próxima execução
// diária, já que o filtro é sempre "ainda sem relatório", nunca uma janela.

const MAX_RELATORIOS_POR_EXECUCAO = 15;

async function jobRelatorioFinalizacao(res) {
  const tasks = await listarImplantacoes();
  const alvos = tasks.filter((t) => {
    if (t.parent) return false; // só projeto-pai, nunca item/agente
    if (t.status?.status !== 'concluído') return false;
    const estado = parseWaipeState(t.description);
    if (!Number.isFinite(Number(estado.dataFimReal))) return false;
    return !estado.finalizacao?.geradoEm;
  });

  const processados = [];
  for (const projeto of alvos.slice(0, MAX_RELATORIOS_POR_EXECUCAO)) {
    try {
      const relatorio = await montarRelatorioFinalizacao(projeto);
      const estadoAtual = parseWaipeState(projeto.description);
      const finalizacao = {
        resumoGeral: relatorio.resumoGeral,
        riscoPercebido: relatorio.riscoPercebido,
        satisfacaoPercebida: relatorio.satisfacaoPercebida,
        causaDaDemora: relatorio.causaDaDemora,
        geradoEm: Date.now(),
        diasEmAberto: relatorio.diasEmAberto,
        naoComparecimentos: relatorio.naoComparecimentos,
        reagendamentos: relatorio.reagendamentos,
        reagendamentosLondrisoft: relatorio.reagendamentosLondrisoft,
        reagendamentosCliente: relatorio.reagendamentosCliente,
      };
      await atualizarTask(projeto.id, {
        markdown_description: stringifyWaipeState(projeto.description, { ...estadoAtual, finalizacao }),
      });
      processados.push({ id: projeto.id, nome: projeto.name, ok: true });
    } catch (e) {
      const motivo = e instanceof ErroSemRegistros ? 'sem_registros'
        : e instanceof ErroRelatorioNaoJson ? 'ia_resposta_invalida'
        : e instanceof ErroUpstreamIa ? 'ia_upstream'
        : e?.message || 'erro_desconhecido';
      console.error(`[cron/relatorio-finalizacao] falha em ${projeto.id} (${projeto.name}): ${motivo}`);
      processados.push({ id: projeto.id, nome: projeto.name, ok: false, motivo });
    }
    // Cada projeto bate ClickUp (comentários/reservas/atualizarTask) + IA —
    // espaça pra não estourar a cota compartilhada com o resto do painel.
    await dormir(700);
  }

  console.log(`[cron/relatorio-finalizacao] ${processados.length}/${alvos.length} processado(s) (limite ${MAX_RELATORIOS_POR_EXECUCAO}).`);
  return res.status(200).json({ ok: true, encontrados: alvos.length, processados });
}

// ── Job: analise-reunioes ──────────────────────────────────────────────────
//
// Depois de uma reunião no Meet, o Gemini gera sozinho (sem ação do ISM) uma
// anotação — anexada ao evento da agenda e salva no Drive de quem organizou —
// mas leva uns 10 minutos pra ficar pronta. Esse job varre no FIM DO DIA toda
// reserva já vinculada a um projeto, acha a anotação anexada ao evento
// correspondente, e roda o MESMO resumo por IA que "Analisar reunião" já faz
// manualmente (resumirReuniaoEPostar, api/ia.js), postando como comentário.
//
// Só processa reserva que: já tem GoogleEventId (gravado por toda reserva
// criada com Meet, ver api/clickup.js), já aconteceu (due_date no passado),
// está dentro da janela de retentativa (JANELA_DIAS) e AINDA não foi marcada
// TranscricaoAnalisada. Reserva sem anexo ainda (Gemini atrasou, ou a
// reunião não gerou anotação) fica sem marca e é tentada de novo no próximo
// dia, dentro da janela.

const MAX_REUNIOES_POR_EXECUCAO = 15;
const JANELA_DIAS = 5; // reserva mais antiga que isso sem anotação achada: desiste, não retenta pra sempre
// mimeType do anexo do Google Docs no recurso Event.attachments — é o que a
// anotação do Gemini gera. Validar ao vivo contra um evento real antes de
// confiar 100% nisso em produção — se o critério estiver errado, a
// varredura simplesmente não acha nada (fail-safe: nunca posta comentário
// errado, só fica sem achar).
const MIMETYPE_GOOGLE_DOC = 'application/vnd.google-apps.document';

function nomeIsm(ismId) {
  return ISM_OPCOES.find((i) => i.id === Number(ismId))?.nome || String(ismId);
}

async function jobAnaliseReunioes(res) {
  const agora = Date.now();
  const limiteJanela = agora - JANELA_DIAS * 24 * 60 * 60 * 1000;

  const [reservas, tokensTasks] = await Promise.all([listarReservas(), listarTokensGoogle()]);

  const alvos = reservas.filter((r) => {
    if (!projetoDaDescricaoReserva(r.description)) return false;
    if (!googleEventIdDaDescricaoReserva(r.description)) return false;
    if (transcricaoAnalisadaDaDescricaoReserva(r.description)) return false;
    const fim = Number(r.due_date);
    if (!Number.isFinite(fim) || fim > agora || fim < limiteJanela) return false;
    return true;
  });

  // listarTokensGoogle devolve a task crua — o refreshToken/ismId estão no
  // JSON salvo por salvarTokenGoogle (parseWaipeState), mesmo formato que
  // sincronizarAgendamentosGoogleAcao já usa em api/clickup.js.
  const tokensValidos = tokensTasks
    .map((t) => parseWaipeState(t.description))
    .filter((e) => Number.isFinite(Number(e.ismId)) && typeof e.refreshToken === 'string' && e.refreshToken);

  const refreshTokenPorIsm = new Map(tokensValidos.map((t) => [Number(t.ismId), t.refreshToken]));
  const accessTokenPorIsm = new Map(); // cache: 1 renovação por ISM por execução, não por reserva

  const processados = [];
  for (const reserva of alvos.slice(0, MAX_REUNIOES_POR_EXECUCAO)) {
    const ismId = Number(responsavelDaDescricaoReserva(reserva.description)) || Number(reserva.assignees?.[0]?.id) || null;
    const projetoId = projetoDaDescricaoReserva(reserva.description);
    const googleEventId = googleEventIdDaDescricaoReserva(reserva.description);

    try {
      if (!ismId || !refreshTokenPorIsm.has(ismId)) {
        throw new Error('ism_sem_google_conectado');
      }

      let accessToken = accessTokenPorIsm.get(ismId);
      if (!accessToken) {
        accessToken = await renovarAccessToken(refreshTokenPorIsm.get(ismId));
        accessTokenPorIsm.set(ismId, accessToken);
      }

      const evento = await obterEvento(accessToken, googleEventId);
      const anexo = (evento?.attachments || []).find((a) => a.mimeType === MIMETYPE_GOOGLE_DOC);
      if (!anexo?.fileId) {
        processados.push({ id: reserva.id, projetoId, ok: false, motivo: 'sem_anotacao_ainda' });
        await dormir(300);
        continue;
      }

      const transcricao = await exportarDocGoogle(accessToken, anexo.fileId);
      if (!transcricao || transcricao.trim().length < 20) {
        throw new Error('anotacao_vazia');
      }

      await resumirReuniaoEPostar(projetoId, transcricao);

      await atualizarTask(reserva.id, {
        markdown_description: `${reserva.description}\n\n**TranscricaoAnalisada:** true`,
      });
      processados.push({ id: reserva.id, projetoId, ok: true });
    } catch (e) {
      const motivo = e instanceof ErroGoogle ? `google_${e.status}`
        : e instanceof ErroUpstreamIa ? 'ia_upstream'
        : e instanceof ErroResumoVazio ? 'ia_resposta_invalida'
        : e?.message || 'erro_desconhecido';
      console.error(`[cron/analise-reunioes] falha na reserva ${reserva.id} (projeto ${projetoId}, ISM ${nomeIsm(ismId)}): ${motivo}`);
      processados.push({ id: reserva.id, projetoId, ok: false, motivo });
    }
    // Cada reserva bate Calendar API + Drive API + ClickUp + IA — mesmo
    // espaçamento usado no job de relatório, pra não estourar cota
    // compartilhada com o resto do painel.
    await dormir(700);
  }

  console.log(`[cron/analise-reunioes] ${processados.length}/${alvos.length} processado(s) (limite ${MAX_REUNIOES_POR_EXECUCAO}).`);
  return res.status(200).json({ ok: true, encontrados: alvos.length, processados });
}
