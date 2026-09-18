// GET /api/cron-relatorio-finalizacao — Vercel Cron, todo dia às 07h
// (America/Sao_Paulo = 10h UTC, ver vercel.json "crons"). Sem sessão de
// usuário: protegido só pelo header Authorization que a própria Vercel
// injeta em toda chamada de cron quando CRON_SECRET está configurado
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
//
// Por quê existe: o relatório de finalização (satisfação/risco percebido
// etc.) é métrica do próprio desempenho de quem executou o projeto — deixar
// o ISM clicar em "Gerar" e "Salvar" dava a ele a chance de ajustar a
// própria avaliação antes de qualquer um ver. Agora a ÚNICA forma de gravar
// o campo `finalizacao` é esta rotina (ver o gate de sessao.nivel==='gestao'
// em atualizarImplantacaoAcao, api/clickup.js — Gestão ainda pode corrigir
// depois, só não pode ser quem gera a primeira versão).
//
// Processa todo projeto já finalizado (status nativo "concluído" — cobre
// tanto "entregue" quanto "cancelado", ver fase_manual_vs_status_nativo_tab)
// que AINDA não tem `finalizacao.geradoEm` preenchido — nunca reprocessa um
// que já foi gerado (automático ou manualmente pela Gestão), pra não
// sobrescrever algo já avaliado. MAX_POR_EXECUCAO limita o quanto uma única
// chamada processa (custo de IA + tempo de execução da function) — o que
// sobrar fica pra próxima execução diária, já que o filtro é sempre "ainda
// sem relatório", nunca uma janela de tempo.

import { aplicarCors, erro } from './_lib/http.js';
import { listarImplantacoes, parseWaipeState, stringifyWaipeState, atualizarTask } from './_lib/clickup.js';
import { montarRelatorioFinalizacao, ErroSemRegistros, ErroRelatorioNaoJson, ErroUpstreamIa } from './ia.js';

const MAX_POR_EXECUCAO = 15;

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
      console.error('[cron-relatorio-finalizacao] CRON_SECRET ausente na configuração.');
      return res.status(500).json({ error: 'nao_configurado' });
    }
    if (req.headers.authorization !== `Bearer ${segredoEsperado}`) {
      return erro(res, 401, 'nao_autorizado', 'Não autorizado.');
    }

    const tasks = await listarImplantacoes();
    const alvos = tasks.filter((t) => {
      if (t.parent) return false; // só projeto-pai, nunca item/agente
      if (t.status?.status !== 'concluído') return false;
      const estado = parseWaipeState(t.description);
      if (!Number.isFinite(Number(estado.dataFimReal))) return false;
      return !estado.finalizacao?.geradoEm;
    });

    const processados = [];
    for (const projeto of alvos.slice(0, MAX_POR_EXECUCAO)) {
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
        console.error(`[cron-relatorio-finalizacao] falha em ${projeto.id} (${projeto.name}): ${motivo}`);
        processados.push({ id: projeto.id, nome: projeto.name, ok: false, motivo });
      }
      // Cada projeto processado bate ClickUp (listarComentarios/listarReservas/
      // atualizarTask) e a API da Claude — espaça pra não estourar a cota de
      // 100/min do ClickUp compartilhada com o resto do painel (mesmo padrão
      // usado nos scripts de migração em massa desta sessão).
      await dormir(700);
    }

    console.log(`[cron-relatorio-finalizacao] ${processados.length}/${alvos.length} processado(s) (limite ${MAX_POR_EXECUCAO} por execução).`);
    return res.status(200).json({
      ok: true,
      encontrados: alvos.length,
      processados,
    });
  } catch (e) {
    console.error('[cron-relatorio-finalizacao] erro inesperado:', e);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}
