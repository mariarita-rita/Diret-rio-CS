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
export async function upsertClientes(clientes) {
  if (!clientes.length) return [];
  return sb(`/clientes?on_conflict=id_nucleo`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(clientes),
  });
}

/** Marca ativo=false para todo cliente cujo id_nucleo não está mais na Carteira. */
export async function desativarClientesForaDe(idsNucleoPresentes) {
  if (!idsNucleoPresentes.length) return [];
  const lista = idsNucleoPresentes.map((v) => enc(v)).join(',');
  return sb(`/clientes?ativo=eq.true&id_nucleo=not.in.(${lista})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ativo: false }),
  });
}

export async function listarClientes() {
  return sb(`/clientes?select=*&order=nome.asc`);
}

// ── E-mails autorizados ───────────────────────────────────────────────────

export async function listarEmailsDoCliente(clienteId) {
  return sb(`/clientes_emails?cliente_id=eq.${enc(clienteId)}&select=*&order=criado_em.asc`);
}

/** Todos os e-mails cadastrados, de todos os clientes — para a tela admin montar a lista de uma vez. */
export async function listarTodosEmails() {
  return sb(`/clientes_emails?select=*&order=criado_em.asc`);
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
    `/trilhas?ativa=eq.true&select=id,titulo,descricao,produtos,ordem,trilha_videos(id,titulo,youtube_id,ordem,duracao_segundos)&trilha_videos.ativo=eq.true&order=ordem.asc`
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

export async function criarVideo({ trilhaId, titulo, youtubeId, ordem, duracaoSegundos }) {
  const linhas = await sb(`/trilha_videos`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      trilha_id: trilhaId,
      titulo,
      youtube_id: youtubeId,
      ordem: ordem || 0,
      duracao_segundos: duracaoSegundos || null,
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
    sb(`/clientes?ativo=eq.true&select=id,id_nucleo,cnpj,nome,produtos_ativos`),
    sb(`/trilhas?ativa=eq.true&select=id,produtos,trilha_videos(id,ativo)`),
    sb(`/video_visualizacoes?concluido=eq.true&select=cliente_id,trilha_video_id,concluido_em`),
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
