// POST /api/moskit-webhook?token=...
//
// Recebe o evento de "negócio editado" do Moskit/Ollow (Marketplace ->
// Webhooks) e, quando o negócio muda pra GANHO (status WON), cria o
// projeto de implantação no ClickUp automaticamente — puxando cliente,
// CNPJ, contato, notas e produtos direto do negócio, em vez de alguém
// preencher tudo de novo à mão. O "criar projeto automático" nativo do
// Moskit existe mas não copia nenhum campo personalizado, por isso esta
// automação bypassa ele e cria direto no painel de implantação em ClickUp
// (ver plano: o Projeto nativo do Moskit deixa de ser usado).
//
// Protegido por token compartilhado na query (mesmo esquema de
// UMBLER_WEBHOOK_TOKEN em api/umbler-webhook.js) — o Moskit não assina o
// payload. Sem sessão de usuário: quem chama é o Moskit, não uma pessoa
// logada — por isso os dados de identificação do cliente vêm inteiros do
// próprio negócio/contato/empresa no Moskit, nunca do corpo recebido "cru".
//
// FORMATO DO PAYLOAD AINDA NÃO CONFIRMADO contra um evento real do Moskit —
// a doc pública não garante a forma exata. `extrairIdNegocio` tenta as
// formas mais prováveis; ajustar assim que um evento de teste chegar (mesma
// cautela documentada no cabeçalho de api/umbler-webhook.js).
//
// Sempre responde 200 (exceto token inválido): o Moskit descarta o webhook
// depois de 3 retentativas com falha — não vale a pena arriscar isso por um
// erro nosso.

import { aplicarCors, erro, lerCorpo, ErroCorpo } from './_lib/http.js';
import { listarImplantacoes, parseWaipeState } from './_lib/clickup.js';
import { criarProjetoImplantacao, sanearDadosCliente, dadosClienteFaltando, sanearOutraSolucao } from './clickup.js';
import {
  buscarNegocio,
  buscarContato,
  buscarEmpresa,
  buscarNotasNegocio,
  buscarProduto,
  CF_NEGOCIO,
  valorCampoPersonalizado,
  mapearProdutoSolucao,
  ErroConfigMoskit,
  ErroUpstreamMoskit,
} from './_lib/moskit.js';

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

    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (e) {
      if (e instanceof ErroCorpo) return res.status(200).json({ ok: true, ignorado: 'corpo_invalido' });
      throw e;
    }

    // Formato real do payload ainda em confirmação (ver cabeçalho) — loga TODO
    // evento autenticado (token já validado acima) até o parsing ser fechado
    // em definitivo; depois disso vira só um log pontual de depuração.
    console.log('[moskit-webhook] evento recebido:', JSON.stringify(corpo).slice(0, 2000));

    await processarEvento(corpo);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[moskit-webhook] falha inesperada:', e?.name, e?.message);
    // 200 mesmo em falha nossa — ver nota no topo sobre o Moskit descartar o webhook.
    return res.status(200).json({ ok: true });
  }
}

/**
 * Extrai o id do negócio do payload. Formato real ainda não confirmado (ver
 * cabeçalho) — aceita os formatos mais prováveis; se nenhum bater,
 * `processarEvento` simplesmente não encontra nada a fazer.
 */
function extrairIdNegocio(corpo) {
  const candidatos = [corpo?.dealId, corpo?.data?.id, corpo?.data?.dealId, corpo?.entity?.id, corpo?.id];
  for (const c of candidatos) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function telefoneDe(entidade) {
  if (!entidade) return '';
  const principal = entidade.phones?.find((p) => p.id === entidade.primaryPhone?.id);
  return principal?.number || entidade.phones?.[0]?.number || '';
}

function emailDe(entidade) {
  if (!entidade) return '';
  const principal = entidade.emails?.find((e) => e.id === entidade.primaryEmail?.id);
  return principal?.address || entidade.emails?.[0]?.address || '';
}

async function processarEvento(corpo) {
  const dealId = extrairIdNegocio(corpo);
  if (!dealId) return;

  let negocio;
  try {
    negocio = await buscarNegocio(dealId);
  } catch (e) {
    if (e instanceof ErroConfigMoskit) {
      console.error('[moskit-webhook] MOSKIT_API_KEY ausente na configuração.');
      return;
    }
    if (e instanceof ErroUpstreamMoskit) {
      console.error(`[moskit-webhook] falha ao buscar negócio ${dealId}: ${e.status}`);
      return;
    }
    throw e;
  }
  // O mesmo evento cobre qualquer edição no negócio, não só "ganhou" — só
  // interessa aqui o instante em que o status vira WON.
  if (!negocio || negocio.status !== 'WON') return;

  // Idempotência: o webhook pode reenviar o mesmo evento (retentativa) ou
  // disparar de novo em uma edição posterior do mesmo negócio já ganho.
  const projetos = await listarImplantacoes();
  const jaExiste = projetos.some((t) => Number(parseWaipeState(t.description)?.origemMoskitDealId) === dealId);
  if (jaExiste) return;

  const contatoId = negocio.contacts?.[0]?.id ?? null;
  const empresaId = negocio.companies?.[0]?.id ?? null;
  const [contato, empresa, notas] = await Promise.all([
    contatoId ? buscarContato(contatoId).catch(() => null) : Promise.resolve(null),
    empresaId ? buscarEmpresa(empresaId).catch(() => null) : Promise.resolve(null),
    buscarNotasNegocio(dealId).catch(() => []),
  ]);

  const dealProducts = Array.isArray(negocio.dealProducts) ? negocio.dealProducts : [];
  const produtos = await Promise.all(
    dealProducts.map((dp) => (dp?.product?.id ? buscarProduto(dp.product.id).catch(() => null) : Promise.resolve(null)))
  );

  const cliente = texto200(empresa?.name) || texto200(contato?.name) || 'Cliente sem nome';
  const cnpj = texto200(empresa?.cnpj);
  const telefone = telefoneDe(contato) || telefoneDe(empresa);
  const email = emailDe(contato) || emailDe(empresa);
  const idNucleo = valorCampoPersonalizado(negocio.entityCustomFields, CF_NEGOCIO.ID_NUCLEO);
  const observacao = valorCampoPersonalizado(negocio.entityCustomFields, CF_NEGOCIO.OBSERVACAO);
  const notasTexto = (Array.isArray(notas) ? notas : [])
    .map((n) => n.description)
    .filter(Boolean)
    .join('\n\n');
  const contexto = [observacao, notasTexto].filter(Boolean).join('\n\n').slice(0, 6000);

  const dadosCliente = sanearDadosCliente({ idNucleo, cnpj, email, telefone });
  const faltando = dadosClienteFaltando(dadosCliente);
  if (faltando.length) {
    console.error(`[moskit-webhook] negócio ${dealId} sem dados suficientes (${faltando.join(', ')}) — projeto não criado`);
    return;
  }

  const solucoes = dealProducts
    .map((dp, i) => {
      const { produto, nomeOriginal } = mapearProdutoSolucao(dp?.product?.id != null ? { id: dp.product.id, name: produtos[i]?.name } : null);
      return sanearOutraSolucao({
        produto,
        planoSugerido: nomeOriginal,
        quantidade: dp?.quantity,
        valorManual: dp?.finalPrice ? dp.finalPrice / 100 : 0,
        observacoes: produto === 'Outro' && nomeOriginal ? `Produto original no Moskit: ${nomeOriginal}` : '',
        incluir: true,
      });
    })
    .filter(Boolean);

  if (!solucoes.length) {
    console.error(`[moskit-webhook] negócio ${dealId} ganho sem produtos vinculados — projeto não criado`);
    return;
  }

  const projeto = await criarProjetoImplantacao({
    cliente,
    contexto,
    dadosCliente,
    agentes: [],
    solucoes,
    ismProjeto: [],
    csmNome: 'Automação Moskit',
    origemMoskitDealId: dealId,
  });

  console.log(`[moskit-webhook] projeto ${projeto.id} criado a partir do negócio ${dealId} (${cliente})`);
}

function texto200(v) {
  return typeof v === 'string' ? v.trim().slice(0, 200) : '';
}
