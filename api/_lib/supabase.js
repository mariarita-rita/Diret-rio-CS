// Cliente Supabase do lado do servidor — só REST (PostgREST), sem SDK, mesmo
// espírito de api/_lib/clickup.js e api/_lib/umbler.js: um wrapper fino de
// `fetch`, chave lida do ambiente, erro tipado em resposta não-OK, corpo de
// erro do upstream nunca repassado ao navegador.
//
// Tabelas: ver sql/trilhas-schema.sql (referência — o app não executa esse
// arquivo, ele só documenta o schema já criado manualmente no Supabase).

export class ErroConfigSupabase extends Error {
  constructor() {
    super('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configuradas.');
    this.name = 'ErroConfigSupabase';
  }
}

export class ErroSupabase extends Error {
  constructor(status, corpo) {
    super(`Supabase respondeu ${status}`);
    this.name = 'ErroSupabase';
    this.status = status;
    this.corpo = corpo;
  }
}

function credenciais() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ErroConfigSupabase();
  return { url: url.replace(/\/+$/, ''), key };
}

/**
 * Chamada bruta ao PostgREST. `path` já inclui a query string
 * (ex: '/clientes?id_nucleo=eq.ABC&select=*').
 */
async function sb(path, init = {}) {
  const { url, key } = credenciais();
  const r = await fetch(`${url}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const corpo = await r.text().catch(() => '');
    console.error(`[supabase] ${init.method || 'GET'} ${path} -> ${r.status}`);
    throw new ErroSupabase(r.status, corpo);
  }
  if (r.status === 204) return null;
  return r.json().catch(() => null);
}

const enc = encodeURIComponent;

/**
 * Igual a `sb()`, mas pagina até trazer TODAS as linhas — o Supabase limita
 * qualquer select a um máximo de linhas por chamada (1000 por padrão,
 * configurável no painel, mas sempre um teto), então uma tabela como
 * `clientes` (carteira inteira sincronizada, potencialmente milhares de
 * linhas) vinha cortada silenciosamente na linha 1000, sem erro nenhum — só
 * um pedaço dos clientes, dependendo até da ordem (sem `order=` explícito, a
 * ordem nem é estável entre chamadas). Usa o header `Range` do PostgREST pra
 * buscar em páginas e concatenar.
 */
const TAMANHO_PAGINA = 1000;
async function sbTodos(path) {
  const todos = [];
  let inicio = 0;
  for (;;) {
    const pagina = (await sb(path, { headers: { Range: `${inicio}-${inicio + TAMANHO_PAGINA - 1}` } })) || [];
    todos.push(...pagina);
    if (pagina.length < TAMANHO_PAGINA) break;
    inicio += TAMANHO_PAGINA;
  }
  return todos;
}

// ── Clientes ──────────────────────────────────────────────────────────────

/** Busca o cliente (ativo) dono deste e-mail autorizado. null se não achar. */
export async function buscarClientePorEmail(email) {
  const linhas = await sb(
    `/clientes_emails?email=eq.${enc(email)}&select=email,clientes(id,id_nucleo,cnpj,nome,produtos_ativos,ativo)`
  );
  const linha = linhas?.[0];
  if (!linha || !linha.clientes || linha.clientes.ativo === false) return null;
  return linha.clientes;
}

/** Upsert em massa por id_nucleo — usado pelo sync manual a partir do ClickUp. */
const TAMANHO_LOTE_UPSERT = 500;

/**
 * Upsert em lotes de TAMANHO_LOTE_UPSERT — mandar a carteira inteira (pode
 * passar de mil linhas) num POST só arrisca estourar o teto de linhas do
 * Supabase na resposta (`return=representation`) e o tempo da função
 * serverless. Lotes sequenciais mantêm cada chamada pequena e previsível.
 */
export async function upsertClientes(clientes) {
  if (!clientes.length) return [];
  const salvos = [];
  for (let i = 0; i < clientes.length; i += TAMANHO_LOTE_UPSERT) {
    const lote = clientes.slice(i, i + TAMANHO_LOTE_UPSERT);
    const resultado = await sb(`/clientes?on_conflict=id_nucleo`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(lote),
    });
    if (resultado) salvos.push(...resultado);
  }
  return salvos;
}

/**
 * Marca ativo=false para todo cliente que não apareceu NESTE sync — em vez de
 * `id_nucleo=not.in.(...)` com a lista inteira de ids presentes (que com a
 * carteira toda vira uma URL de dezenas de milhares de caracteres, arriscando
 * estourar limite de tamanho de requisição), compara pela marca de tempo:
 * todo cliente ativo cujo `sincronizado_em` for ANTERIOR a este sync (ou seja,
 * não foi tocado por ele) é quem sumiu da Carteira.
 */
export async function desativarClientesForaDe(momentoDoSync) {
  return sb(`/clientes?ativo=eq.true&sincronizado_em=lt.${enc(momentoDoSync)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ativo: false }),
  });
}

export async function listarClientes() {
  return sbTodos(`/clientes?select=*&order=nome.asc`);
}

// ── E-mails autorizados ───────────────────────────────────────────────────

export async function listarEmailsDoCliente(clienteId) {
  return sb(`/clientes_emails?cliente_id=eq.${enc(clienteId)}&select=*&order=criado_em.asc`);
}

/** Todos os e-mails cadastrados, de todos os clientes — para a tela admin montar a lista de uma vez. */
export async function listarTodosEmails() {
  return sbTodos(`/clientes_emails?select=*&order=criado_em.asc`);
}

export async function adicionarEmailCliente(clienteId, email, criadoPor) {
  return sb(`/clientes_emails`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ cliente_id: clienteId, email, criado_por: criadoPor || null }]),
  });
}

export async function removerEmailCliente(emailId) {
  await sb(`/clientes_emails?id=eq.${enc(emailId)}`, { method: 'DELETE' });
}

// ── Trilhas e vídeos ──────────────────────────────────────────────────────

/** Todas as trilhas com seus vídeos — visão do admin (inclui arquivadas). */
export async function listarTrilhasAdmin() {
  return sb(
    `/trilhas?select=*,trilha_videos(*)&order=titulo.asc,ordem.asc`
  );
}

/**
 * Todas as trilhas ativas + vídeos, sem filtro de produto — quem chama (o
 * endpoint do cliente) decide quais valem pra aquele cliente: `produtos`
 * vazio na trilha significa "geral" (todo mundo vê), senão precisa dar
 * overlap com os produtos ativados do cliente. Filtrar em memória em vez de
 * na query evita a sintaxe (e a fragilidade) de filtro de overlap de array
 * via PostgREST — o volume de trilhas não justifica a complexidade.
 */
export async function listarTrilhasAtivas() {
  return sb(
    `/trilhas?ativa=eq.true&select=id,titulo,descricao,produtos,ordem,trilha_videos(id,titulo,youtube_id,ordem,duracao_segundos,nota,atividade_titulo)&trilha_videos.ativo=eq.true&order=ordem.asc`
  );
}

export async function criarTrilha({ titulo, descricao, produtos, ordem }) {
  const linhas = await sb(`/trilhas`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ titulo, descricao: descricao || null, produtos: produtos || [], ordem: ordem || 0 }]),
  });
  return linhas?.[0] || null;
}

export async function editarTrilha(id, campos) {
  const linhas = await sb(`/trilhas?id=eq.${enc(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...campos, atualizado_em: new Date().toISOString() }),
  });
  return linhas?.[0] || null;
}

export async function criarVideo({ trilhaId, titulo, youtubeId, ordem, duracaoSegundos, nota, atividadeTitulo }) {
  const linhas = await sb(`/trilha_videos`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      trilha_id: trilhaId,
      titulo,
      youtube_id: youtubeId,
      ordem: ordem || 0,
      duracao_segundos: duracaoSegundos || null,
      nota: nota || null,
      atividade_titulo: atividadeTitulo || null,
    }]),
  });
  return linhas?.[0] || null;
}

export async function editarVideo(id, campos) {
  const linhas = await sb(`/trilha_videos?id=eq.${enc(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(campos),
  });
  return linhas?.[0] || null;
}

export async function excluirVideo(id) {
  await sb(`/trilha_videos?id=eq.${enc(id)}`, { method: 'DELETE' });
}

/**
 * Reordena: `idsNaOrdem` é a lista de ids de vídeo já na ordem final desejada
 * — cada um recebe `ordem` = sua posição no array. Um PATCH por vídeo (não dá
 * pra fazer upsert em lote aqui: `trilha_videos` tem colunas NOT NULL sem
 * default como `titulo`/`youtube_id`/`trilha_id`, e o Postgres valida essas
 * colunas na construção da linha do INSERT mesmo quando o resultado real vai
 * ser um UPDATE via ON CONFLICT — falharia por enviar só {id, ordem}).
 */
export async function reordenarVideos(idsNaOrdem) {
  if (!idsNaOrdem.length) return;
  await Promise.all(idsNaOrdem.map((id, i) =>
    sb(`/trilha_videos?id=eq.${enc(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ordem: i }),
    })
  ));
}

/** Busca um vídeo + os produtos da trilha dona dele (para checar posse no marcar-assistido). */
export async function buscarVideoComProduto(videoId) {
  const linhas = await sb(
    `/trilha_videos?id=eq.${enc(videoId)}&select=id,trilha_id,ativo,trilhas(produtos,ativa)`
  );
  return linhas?.[0] || null;
}

// ── Visualizações ─────────────────────────────────────────────────────────

export async function listarVisualizacoesPorEmail(email) {
  return sb(`/video_visualizacoes?email=eq.${enc(email)}&select=trilha_video_id,concluido,percentual_maximo`);
}

async function buscarVisualizacao(email, trilhaVideoId) {
  const linhas = await sb(
    `/video_visualizacoes?email=eq.${enc(email)}&trilha_video_id=eq.${enc(trilhaVideoId)}&select=*`
  );
  return linhas?.[0] || null;
}

const LIMIAR_CONCLUSAO = 90;

/**
 * Registra progresso de um vídeo. `percentual_maximo` só sobe (nunca regride
 * se o cliente voltar o vídeo), e `concluido` vira true na primeira vez que
 * cruza LIMIAR_CONCLUSAO — permanece true depois, mesmo que o percentual
 * daquela sessão específica seja menor.
 */
export async function upsertVisualizacao({ clienteId, email, trilhaVideoId, percentual, progressoSegundos }) {
  const existente = await buscarVisualizacao(email, trilhaVideoId);
  const percentualMaximo = Math.max(existente?.percentual_maximo || 0, Math.min(100, Math.max(0, Math.round(percentual) || 0)));
  const jaConcluido = Boolean(existente?.concluido);
  const concluidoAgora = jaConcluido || percentualMaximo >= LIMIAR_CONCLUSAO;

  const corpo = {
    cliente_id: clienteId,
    email,
    trilha_video_id: trilhaVideoId,
    percentual_maximo: percentualMaximo,
    concluido: concluidoAgora,
    progresso_segundos: Number.isFinite(progressoSegundos) ? Math.max(0, Math.round(progressoSegundos)) : (existente?.progresso_segundos || 0),
    atualizado_em: new Date().toISOString(),
  };
  if (concluidoAgora && !jaConcluido) corpo.concluido_em = new Date().toISOString();
  else if (existente?.concluido_em) corpo.concluido_em = existente.concluido_em;

  const linhas = await sb(`/video_visualizacoes?on_conflict=email,trilha_video_id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([corpo]),
  });
  return linhas?.[0] || null;
}

// ── Indicadores (agregado por cliente) ─────────────────────────────────────

/**
 * Monta o rollup de engajamento por cliente em Node, a partir de 3 leituras
 * simples (clientes ativos, trilhas+vídeos ativos, visualizações concluídas).
 * Um projeto pequeno como este não precisa de uma view/RPC no Supabase só
 * para isso — três selects give-or-take a mesma latência de uma query só.
 */
export async function indicadoresPorCliente() {
  const [clientes, trilhas, visualizacoes] = await Promise.all([
    sbTodos(`/clientes?ativo=eq.true&select=id,id_nucleo,cnpj,nome,produtos_ativos`),
    sb(`/trilhas?ativa=eq.true&select=id,produtos,trilha_videos(id,ativo)`),
    sbTodos(`/video_visualizacoes?concluido=eq.true&select=cliente_id,trilha_video_id,concluido_em`),
  ]);

  const videosGerais = new Set(); // trilhas sem produto (produtos = []) — contam pra todo cliente
  const videosPorProduto = new Map(); // produto -> Set(videoId)
  for (const t of trilhas || []) {
    const ativos = (t.trilha_videos || []).filter((v) => v.ativo !== false).map((v) => v.id);
    if (!t.produtos || !t.produtos.length) {
      for (const id of ativos) videosGerais.add(id);
      continue;
    }
    for (const produto of t.produtos) {
      if (!videosPorProduto.has(produto)) videosPorProduto.set(produto, new Set());
      for (const id of ativos) videosPorProduto.get(produto).add(id);
    }
  }

  const concluidosPorCliente = new Map(); // clienteId -> { videos: Set, ultimaAtividade }
  for (const v of visualizacoes || []) {
    let reg = concluidosPorCliente.get(v.cliente_id);
    if (!reg) {
      reg = { videos: new Set(), ultimaAtividade: null };
      concluidosPorCliente.set(v.cliente_id, reg);
    }
    reg.videos.add(v.trilha_video_id);
    if (!reg.ultimaAtividade || (v.concluido_em && v.concluido_em > reg.ultimaAtividade)) {
      reg.ultimaAtividade = v.concluido_em;
    }
  }

  return (clientes || []).map((c) => {
    const disponiveisSet = new Set(videosGerais);
    for (const produto of c.produtos_ativos || []) {
      const set = videosPorProduto.get(produto);
      if (set) for (const id of set) disponiveisSet.add(id);
    }
    const reg = concluidosPorCliente.get(c.id);
    const assistidos = reg ? [...reg.videos].filter((id) => disponiveisSet.has(id)).length : 0;
    return {
      idNucleo: c.id_nucleo,
      cnpj: c.cnpj,
      nome: c.nome,
      videosDisponiveis: disponiveisSet.size,
      videosAssistidos: assistidos,
      percentual: disponiveisSet.size ? Math.round((assistidos / disponiveisSet.size) * 100) : null,
      ultimaAtividade: reg?.ultimaAtividade || null,
    };
  });
}

// ── Gamificação: atividades por vídeo ───────────────────────────────────────

export async function listarAtividadesPorEmail(email) {
  return sb(`/atividades_concluidas?email=eq.${enc(email)}&select=trilha_video_id`);
}

export async function marcarAtividadeConcluida(clienteId, email, trilhaVideoId) {
  const linhas = await sb(`/atividades_concluidas?on_conflict=email,trilha_video_id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ cliente_id: clienteId, email, trilha_video_id: trilhaVideoId }]),
  });
  return linhas?.[0] || null;
}

// ── Gamificação: regras de pontos ───────────────────────────────────────────

export async function listarRegras() {
  return sb(`/pontos_regras?select=*&order=ordem.asc,titulo.asc`);
}

export async function criarRegra({ titulo, tipo, criterioProdutos, pedeIdentificacao, ordem }) {
  const linhas = await sb(`/pontos_regras`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      titulo, tipo,
      criterio_produtos: criterioProdutos || [],
      pede_identificacao: Boolean(pedeIdentificacao),
      ordem: ordem || 0,
    }]),
  });
  return linhas?.[0] || null;
}

export async function editarRegra(id, campos) {
  const linhas = await sb(`/pontos_regras?id=eq.${enc(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(campos),
  });
  return linhas?.[0] || null;
}

// ── Gamificação: eventos de pontos (autodeclarada / pendente_aprovacao) ────

/** Todos os eventos, com dados da regra e do cliente — visão admin (opcionalmente filtrado por status). */
export async function listarEventos(status) {
  const filtro = status ? `&status=eq.${enc(status)}` : '';
  return sbTodos(
    `/pontos_eventos?select=*,pontos_regras(titulo,tipo),clientes(nome,id_nucleo,cnpj)${filtro}&order=criado_em.desc`
  );
}

export async function listarEventosPorEmail(email) {
  return sb(`/pontos_eventos?email=eq.${enc(email)}&select=regra_id,status,identificacao,observacao,criado_em`);
}

export async function buscarEvento(email, regraId) {
  const linhas = await sb(`/pontos_eventos?email=eq.${enc(email)}&regra_id=eq.${enc(regraId)}&select=*`);
  return linhas?.[0] || null;
}

/**
 * Cliente declara um evento (autodeclarada nasce 'aprovado' direto,
 * pendente_aprovacao nasce 'pendente'). Quem chama decide o status — ver
 * guarda em api/trilhas-cliente.js pra não deixar resubmeter por cima de um
 * evento já aprovado.
 */
export async function declararEvento({ clienteId, email, regraId, status, identificacao, observacao }) {
  const linhas = await sb(`/pontos_eventos?on_conflict=email,regra_id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{
      cliente_id: clienteId, email, regra_id: regraId, status,
      identificacao: identificacao || null, observacao: observacao || null,
    }]),
  });
  return linhas?.[0] || null;
}

export async function revisarEvento(id, status, revisadoPor) {
  const linhas = await sb(`/pontos_eventos?id=eq.${enc(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status, revisado_em: new Date().toISOString(), revisado_por: revisadoPor || null }),
  });
  return linhas?.[0] || null;
}

// ── Gamificação: prêmios ────────────────────────────────────────────────────

export async function listarPremiosAdmin() {
  return sb(`/premios?select=*,premio_faixas(*),premio_criterios(*)&order=ordem.asc,titulo.asc`);
}

export async function criarPremio({ titulo, descricao, prazoFinal, estoqueTotal, restrito, ordem }) {
  const linhas = await sb(`/premios`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      titulo, descricao: descricao || null, prazo_final: prazoFinal || null,
      estoque_total: estoqueTotal ?? null, restrito: Boolean(restrito), ordem: ordem || 0,
    }]),
  });
  return linhas?.[0] || null;
}

export async function editarPremio(id, campos) {
  const linhas = await sb(`/premios?id=eq.${enc(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(campos),
  });
  return linhas?.[0] || null;
}

export async function criarFaixa({ premioId, pontosMinimos, descricao, ordem }) {
  const linhas = await sb(`/premio_faixas`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ premio_id: premioId, pontos_minimos: pontosMinimos, descricao, ordem: ordem || 0 }]),
  });
  return linhas?.[0] || null;
}

export async function editarFaixa(id, campos) {
  const linhas = await sb(`/premio_faixas?id=eq.${enc(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(campos),
  });
  return linhas?.[0] || null;
}

export async function excluirFaixa(id) {
  await sb(`/premio_faixas?id=eq.${enc(id)}`, { method: 'DELETE' });
}

// ── Gamificação: critérios de pontuação por prêmio ──────────────────────────
// O "cartão de pontuação" de cada prêmio — ver comentário em
// sql/trilhas-schema.sql. Cada linha vale pontos só PRA ESTE prêmio.

export async function criarCriterio({ premioId, tipo, regraId, trilhaId, pontos, ordem }) {
  const linhas = await sb(`/premio_criterios`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      premio_id: premioId, tipo,
      regra_id: regraId || null, trilha_id: trilhaId || null,
      pontos, ordem: ordem || 0,
    }]),
  });
  return linhas?.[0] || null;
}

export async function excluirCriterio(id) {
  await sb(`/premio_criterios?id=eq.${enc(id)}`, { method: 'DELETE' });
}

// ── Gamificação: elegibilidade restrita ─────────────────────────────────────

export async function listarElegiveis(premioId) {
  return sb(`/premio_elegiveis?premio_id=eq.${enc(premioId)}&select=cliente_id,clientes(nome,id_nucleo,cnpj)`);
}

/** Substitui a lista inteira de elegíveis do prêmio (apaga e recria). */
export async function definirElegiveis(premioId, clienteIds) {
  await sb(`/premio_elegiveis?premio_id=eq.${enc(premioId)}`, { method: 'DELETE' });
  if (!clienteIds.length) return [];
  return sb(`/premio_elegiveis`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(clienteIds.map((id) => ({ premio_id: premioId, cliente_id: id }))),
  });
}

export async function clienteEhElegivel(premioId, clienteId) {
  const linhas = await sb(
    `/premio_elegiveis?premio_id=eq.${enc(premioId)}&cliente_id=eq.${enc(clienteId)}&select=cliente_id`
  );
  return Boolean(linhas?.length);
}

// ── Gamificação: resgates ────────────────────────────────────────────────────

export async function listarResgates(status) {
  const filtro = status ? `&status=eq.${enc(status)}` : '';
  return sbTodos(
    `/premio_resgates?select=*,premios(titulo),premio_faixas(descricao),clientes(nome,id_nucleo,cnpj)${filtro}&order=criado_em.desc`
  );
}

export async function listarResgatesPorEmail(email) {
  return sb(`/premio_resgates?email=eq.${enc(email)}&select=premio_id,faixa_id,status,criado_em`);
}

export async function contarResgatesAtivos(premioId) {
  const linhas = await sb(`/premio_resgates?premio_id=eq.${enc(premioId)}&status=neq.cancelado&select=id`);
  return linhas?.length || 0;
}

export async function criarResgate({ premioId, faixaId, clienteId, email, whatsapp }) {
  const linhas = await sb(`/premio_resgates`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ premio_id: premioId, faixa_id: faixaId || null, cliente_id: clienteId, email, whatsapp: whatsapp || null }]),
  });
  return linhas?.[0] || null;
}

export async function atualizarResgate(id, status) {
  const linhas = await sb(`/premio_resgates?id=eq.${enc(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status, atualizado_em: new Date().toISOString() }),
  });
  return linhas?.[0] || null;
}

// ── Gamificação: cálculo de pontos POR PRÊMIO ───────────────────────────────
// Cada prêmio tem sua própria pontuação — a mesma trilha/regra/atividade pode
// valer pontos diferentes (ou nem contar) em outro prêmio, então não existe
// mais um "total do cliente" único; existe um total por prêmio, montado a
// partir do "cartão de pontuação" daquele prêmio (premio_criterios).
// Sempre calculado no servidor a partir de dados vivos — nunca confia em
// total calculado no navegador (mesma fonte usada pra mostrar a barra de
// progresso do cliente e pra validar um resgate).

/**
 * Contexto compartilhado (uma leitura só, reaproveitada pra todos os prêmios
 * de uma vez): quais trilhas existem e estão 100% concluídas, quantas
 * atividades o cliente já fez entre as trilhas liberadas a ele, e o status
 * de cada regra (automática calculada na hora, ou evento aprovado/pendente).
 */
export async function construirContextoPontos({ email, produtosAtivos }) {
  const [todasTrilhas, visualizacoes, atividadesFeitas, regras, eventosDoEmail] = await Promise.all([
    listarTrilhasAtivas(),
    listarVisualizacoesPorEmail(email),
    listarAtividadesPorEmail(email),
    listarRegras(),
    listarEventosPorEmail(email),
  ]);

  const assistidoPorVideo = new Map(visualizacoes.map((v) => [v.trilha_video_id, v.concluido]));
  const atividadeFeitaSet = new Set(atividadesFeitas.map((a) => a.trilha_video_id));
  const regraPorId = new Map(regras.map((r) => [r.id, r]));
  const eventoPorRegra = new Map(eventosDoEmail.map((e) => [e.regra_id, e]));

  const trilhaPorId = new Map(todasTrilhas.map((t) => [t.id, t]));
  const trilhaCompleta = new Map();
  for (const t of todasTrilhas) {
    const videos = t.trilha_videos || [];
    trilhaCompleta.set(t.id, videos.length > 0 && videos.every((v) => assistidoPorVideo.get(v.id)));
  }

  const trilhasLiberadas = todasTrilhas.filter(
    (t) => !t.produtos || !t.produtos.length || t.produtos.some((p) => produtosAtivos.includes(p))
  );
  const todasTrilhasLiberadasCompletas = trilhasLiberadas.length > 0 && trilhasLiberadas.every((t) => trilhaCompleta.get(t.id));

  let atividadesFeitasDisponiveis = 0;
  for (const t of trilhasLiberadas) {
    for (const v of t.trilha_videos || []) {
      if (v.atividade_titulo && atividadeFeitaSet.has(v.id)) atividadesFeitasDisponiveis++;
    }
  }

  return { produtosAtivos, trilhaPorId, trilhaCompleta, todasTrilhasLiberadasCompletas, atividadesFeitasDisponiveis, regraPorId, eventoPorRegra };
}

function tituloCriterio(c, ctx) {
  if (c.tipo === 'trilhas_disponiveis') return 'Concluir todas as trilhas disponíveis no seu acesso';
  if (c.tipo === 'trilha') return `Concluir a trilha: ${ctx.trilhaPorId.get(c.trilha_id)?.titulo || '(trilha removida)'}`;
  if (c.tipo === 'atividade') return 'Atividades práticas concluídas';
  if (c.tipo === 'regra') return ctx.regraPorId.get(c.regra_id)?.titulo || '(regra removida)';
  return '';
}

/** Avalia um critério contra o contexto do cliente. */
function avaliarCriterio(c, ctx) {
  if (c.tipo === 'trilhas_disponiveis') {
    return { obtido: ctx.todasTrilhasLiberadasCompletas, pontos: c.pontos };
  }
  if (c.tipo === 'trilha') {
    return { obtido: ctx.trilhaCompleta.get(c.trilha_id) === true, pontos: c.pontos };
  }
  if (c.tipo === 'atividade') {
    const unidades = ctx.atividadesFeitasDisponiveis;
    return { obtido: unidades > 0, pontos: c.pontos * unidades, unidades };
  }
  if (c.tipo === 'regra') {
    const regra = ctx.regraPorId.get(c.regra_id);
    if (!regra || !regra.ativa) return { obtido: false, pontos: c.pontos, status: null };
    if (regra.tipo === 'automatica') {
      const obtido = (regra.criterio_produtos || []).some((p) => ctx.produtosAtivos.includes(p));
      return { obtido, pontos: c.pontos, status: obtido ? 'aprovado' : null };
    }
    const evento = ctx.eventoPorRegra.get(c.regra_id);
    const obtido = evento?.status === 'aprovado';
    return { obtido, pontos: c.pontos, status: evento?.status || null, pedeIdentificacao: regra.pede_identificacao };
  }
  return { obtido: false, pontos: 0 };
}

/** Pontuação + detalhamento de UM prêmio (a partir dos critérios já embutidos nele). */
export function calcularPontosPremio(criterios, ctx) {
  let total = 0;
  const detalhamento = (criterios || []).map((c) => {
    const r = avaliarCriterio(c, ctx);
    if (r.obtido) total += r.pontos;
    return {
      id: c.id,
      tipo: c.tipo,
      titulo: tituloCriterio(c, ctx),
      pontos: r.pontos,
      obtido: r.obtido,
      status: r.status || null,
      regraId: c.regra_id || null,
      pedeIdentificacao: r.pedeIdentificacao || false,
    };
  });
  return { total, detalhamento };
}

/** Prêmios ativos, dentro do prazo, e elegíveis (respeitando `restrito`) para este cliente — com seus critérios e faixas. */
export async function listarPremiosParaCliente(clienteId) {
  const hoje = new Date().toISOString().slice(0, 10);
  const premios = await sb(`/premios?ativo=eq.true&select=*,premio_faixas(*),premio_criterios(*)&order=ordem.asc,titulo.asc`);
  const resultado = [];
  for (const p of premios || []) {
    if (p.prazo_final && p.prazo_final < hoje) continue;
    if (p.restrito) {
      const elegivel = await clienteEhElegivel(p.id, clienteId);
      if (!elegivel) continue;
    }
    resultado.push(p);
  }
  return resultado;
}
