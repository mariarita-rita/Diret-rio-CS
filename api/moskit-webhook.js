// POST /api/moskit-webhook?token=...
//
// Recebe o evento "Edição no status de negócio" (metadata.event =
// "deal-statusChanged") do Moskit/Ollow e, quando o negócio muda pra GANHO
// (status WON), cria o projeto de implantação no ClickUp automaticamente —
// puxando cliente, CNPJ, contato, notas e produtos direto do negócio, em
// vez de alguém preencher tudo de novo à mão. O "criar projeto automático"
// nativo do Moskit existe mas não copia nenhum campo personalizado, por
// isso esta automação bypassa ele e cria direto no painel de implantação em
// ClickUp (ver plano: o Projeto nativo do Moskit deixa de ser usado).
//
// Protegido por token compartilhado na query (mesmo esquema de
// UMBLER_WEBHOOK_TOKEN em api/umbler-webhook.js). Sem sessão de usuário:
// quem chama é o Moskit, não uma pessoa logada — por isso os dados de
// identificação do cliente vêm inteiros do próprio negócio/contato/empresa
// no Moskit, nunca do corpo recebido "cru".
//
// FORMATO DO PAYLOAD (confirmado com um evento real, 2026-09-11):
//   { metadata: { entity:"deal", operation:"statusChanged", hash, actor },
//     before: {...negócio antes}, after: {...negócio depois} }
// O negócio inteiro já vem embutido em `after` — não precisa (nem deve)
// buscar via GET /deals/{id} de novo. MAS o formato aqui difere da API REST
// (`_lib/moskit.js`, usada só para contato/empresa/notas/produto):
//   - campos personalizados vêm em `customFieldValues`, com `numberValue`
//     (não `numericValue` como no GET /deals/{id});
//   - `contact`/`company` são OBJETOS únicos ({id}), não arrays.
// `extrairNegocioDoEvento` normaliza isso pro mesmo shape que o resto do
// código (valorCampoPersonalizado etc.) já espera.
//
// Sempre responde 200 (exceto token inválido): o Moskit descarta o webhook
// depois de 3 retentativas com falha — não vale a pena arriscar isso por um
// erro nosso.

import { aplicarCors, erro, lerCorpo, ErroCorpo } from './_lib/http.js';
import { listarImplantacoes, parseWaipeState } from './_lib/clickup.js';
import { criarProjetoImplantacao, sanearDadosCliente, dadosClienteFaltando, sanearOutraSolucao } from './clickup.js';
import {
  buscarContato,
  buscarEmpresa,
  buscarNotasNegocio,
  buscarProduto,
  CF_NEGOCIO,
  valorCampoPersonalizado,
  mapearProdutoSolucao,
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

/** `customFieldValues` (formato do webhook, campo `numberValue`) -> mesmo
 * shape de `entityCustomFields` (formato da API REST, campo `numericValue`)
 * que `valorCampoPersonalizado` já sabe ler. */
function normalizarCustomFields(customFieldValues) {
  if (!Array.isArray(customFieldValues)) return [];
  return customFieldValues.map((c) => ({
    id: c.id,
    textValue: c.textValue,
    numericValue: c.numberValue,
    dateValue: c.dateValue,
    options: c.options,
  }));
}

/**
 * Extrai o negócio do payload do webhook (evento deal-statusChanged), já
 * normalizado: `after` é o estado pós-mudança — é ele que interessa (`before`
 * só serve de fallback se `after` vier ausente, o que não deveria acontecer
 * neste evento). Retorna null se não achar um negócio com id válido.
 */
function extrairNegocioDoEvento(corpo) {
  const negocio = corpo?.after || corpo?.before;
  if (!negocio || !Number.isFinite(Number(negocio.id))) return null;
  return {
    id: Number(negocio.id),
    status: negocio.status,
    contatoId: negocio.contact?.id ?? null,
    empresaId: negocio.company?.id ?? null,
    dealProducts: Array.isArray(negocio.dealProducts) ? negocio.dealProducts : [],
    entityCustomFields: normalizarCustomFields(negocio.customFieldValues),
  };
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
  const negocio = extrairNegocioDoEvento(corpo);
  if (!negocio) return;
  const dealId = negocio.id;

  // O mesmo evento cobre qualquer mudança de status, não só "ganhou" — só
  // interessa aqui o instante em que vira WON (ignora OPEN/LOST).
  if (negocio.status !== 'WON') return;

  // Idempotência: o webhook pode reenviar o mesmo evento (retentativa) ou
  // disparar de novo em uma edição posterior do mesmo negócio já ganho.
  const projetos = await listarImplantacoes();
  const jaExiste = projetos.some((t) => Number(parseWaipeState(t.description)?.origemMoskitDealId) === dealId);
  if (jaExiste) return;

  const [contato, empresa, notas] = await Promise.all([
    negocio.contatoId ? buscarContato(negocio.contatoId).catch(() => null) : Promise.resolve(null),
    negocio.empresaId ? buscarEmpresa(negocio.empresaId).catch(() => null) : Promise.resolve(null),
    buscarNotasNegocio(dealId).catch(() => []),
  ]);

  const dealProducts = Array.isArray(negocio.dealProducts) ? negocio.dealProducts : [];
  const produtos = await Promise.all(
    dealProducts.map((dp) => (dp?.product?.id ? buscarProduto(dp.product.id).catch(() => null) : Promise.resolve(null)))
  );

  const cliente = texto200(empresa?.name) || texto200(contato?.name) || 'Cliente sem nome';
  // O Comercial preenche o CNPJ no próprio negócio, não no cadastro da
  // empresa (esse fica em branco na prática) — por isso prioriza o campo
  // personalizado do negócio, só cai pro da empresa se aquele vier vazio.
  const cnpj = valorCampoPersonalizado(negocio.entityCustomFields, CF_NEGOCIO.CNPJ) || texto200(empresa?.cnpj);
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
