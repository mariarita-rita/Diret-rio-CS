// GET /api/cron-analise-reunioes — Vercel Cron, todo dia às 21h BRT (00h UTC
// do dia seguinte, ver vercel.json "crons"). Sem sessão de usuário: protegido
// só pelo header Authorization que a própria Vercel injeta quando CRON_SECRET
// está configurado, mesmo padrão de cron-relatorio-finalizacao.js.
//
// Por quê existe: depois de uma reunião no Google Meet, o Gemini gera sozinho
// (sem ação manual do ISM) uma anotação da reunião — anexada ao evento da
// agenda e salva no Drive de quem organizou — mas leva uns 10 minutos pra
// ficar pronta. Em vez de tentar pegar isso na hora (não dá, o documento nem
// existe ainda), essa rotina varre no FIM DO DIA toda reserva já vinculada a
// um projeto, acha a anotação anexada ao evento correspondente, e roda o
// MESMO resumo por IA que "Analisar reunião" já faz manualmente
// (resumirReuniaoEPostar, extraído de api/ia.js), postando como comentário
// com o mesmo marcador — sem qualquer ação do ISM.
//
// Só processa reserva que: já tem um GoogleEventId (ver
// api/_lib/google.js:criarEventoComMeet e as três gravações em
// api/clickup.js), já aconteceu (due_date no passado), está dentro da janela
// de retentativa (JANELA_DIAS) e AINDA não foi marcada
// TranscricaoAnalisada — nunca reprocessa a mesma reunião. Reserva sem anexo
// ainda (Gemini atrasou, ou a reunião não teve anotação gerada) fica sem
// marca e é tentada de novo no próximo dia, dentro da janela.

import { aplicarCors, erro } from './_lib/http.js';
import {
  listarReservas,
  listarTokensGoogle,
  atualizarTask,
  projetoDaDescricaoReserva,
  googleEventIdDaDescricaoReserva,
  responsavelDaDescricaoReserva,
  transcricaoAnalisadaDaDescricaoReserva,
  parseWaipeState,
  ISM_OPCOES,
} from './_lib/clickup.js';
import { renovarAccessToken, obterEvento, exportarDocGoogle, ErroGoogle } from './_lib/google.js';
import { resumirReuniaoEPostar, ErroUpstreamIa, ErroResumoVazio } from './ia.js';

const MAX_POR_EXECUCAO = 15;
const JANELA_DIAS = 5; // reserva mais antiga que isso sem anotação achada: desiste, não retenta pra sempre
// mimeType do anexo do Google Docs no recurso Event.attachments — é o que a
// anotação do Gemini gera. PONTO A VALIDAR AO VIVO (ver plano): confirmar
// contra um evento real com anotação do Gemini antes de confiar nisso em
// produção — se o critério estiver errado, a varredura simplesmente não acha
// nada (fail-safe: nunca posta comentário errado, só fica sem achar).
const MIMETYPE_GOOGLE_DOC = 'application/vnd.google-apps.document';

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nomeIsm(ismId) {
  return ISM_OPCOES.find((i) => i.id === Number(ismId))?.nome || String(ismId);
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
      console.error('[cron-analise-reunioes] CRON_SECRET ausente na configuração.');
      return res.status(500).json({ error: 'nao_configurado' });
    }
    if (req.headers.authorization !== `Bearer ${segredoEsperado}`) {
      return erro(res, 401, 'nao_autorizado', 'Não autorizado.');
    }

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
    for (const reserva of alvos.slice(0, MAX_POR_EXECUCAO)) {
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
        console.error(`[cron-analise-reunioes] falha na reserva ${reserva.id} (projeto ${projetoId}, ISM ${nomeIsm(ismId)}): ${motivo}`);
        processados.push({ id: reserva.id, projetoId, ok: false, motivo });
      }
      // Cada reserva processada bate Calendar API + Drive API + ClickUp + IA —
      // mesmo espaçamento de 700ms usado em cron-relatorio-finalizacao.js, pra
      // não estourar cota compartilhada com o resto do painel.
      await dormir(700);
    }

    console.log(`[cron-analise-reunioes] ${processados.length}/${alvos.length} processado(s) (limite ${MAX_POR_EXECUCAO} por execução).`);
    return res.status(200).json({ ok: true, encontrados: alvos.length, processados });
  } catch (e) {
    console.error('[cron-analise-reunioes] erro inesperado:', e);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}
