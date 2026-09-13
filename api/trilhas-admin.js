// GET  /api/trilhas-admin                 -> lista todas as trilhas + vídeos (inclui arquivadas)
// POST /api/trilhas-admin  { acao, ... }   -> criar_trilha | editar_trilha | arquivar_trilha
//                                             criar_video | editar_video | arquivar_video
//
// Uso interno (sessão cs_sessao, mesma da Carteira/Implantação). Leitura para
// qualquer nível autenticado; escrita exige podeEscrever (gestão/csm/ism —
// consulta é só-leitura em todo o resto do app, e aqui não é diferente).

import { aplicarCors, erro, lerCorpo, ErroCorpo, texto } from './_lib/http.js';
import { ErroConfig, exigirSessao, podeEscrever } from './_lib/auth.js';
import {
  listarTrilhasAdmin,
  criarTrilha,
  editarTrilha,
  criarVideo,
  editarVideo,
  ErroConfigSupabase,
  ErroSupabase,
} from './_lib/supabase.js';

const RE_YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Aceita um id puro ou uma URL do YouTube e devolve só o id de 11 caracteres, ou null. */
function extrairYoutubeId(v) {
  const s = String(v || '').trim();
  if (RE_YOUTUBE_ID.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1);
      return RE_YOUTUBE_ID.test(id) ? id : null;
    }
    if (u.hostname.endsWith('youtube.com')) {
      const v2 = u.searchParams.get('v');
      if (v2 && RE_YOUTUBE_ID.test(v2)) return v2;
      const m = u.pathname.match(/\/(embed|shorts)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    // não era URL — já tentamos como id puro acima
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();

    const sessao = exigirSessao(req, res);
    if (!sessao) return undefined;

    if (req.method === 'GET') {
      const trilhas = await listarTrilhasAdmin();
      return res.status(200).json({ trilhas });
    }
    if (req.method !== 'POST') {
      return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
    }
    if (!podeEscrever(sessao)) {
      return erro(res, 403, 'sem_permissao', 'Este nível de acesso não pode editar trilhas.');
    }

    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (e) {
      if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
      throw e;
    }

    return await executarAcao(String(corpo.acao || ''), corpo, res);
  } catch (e) {
    if (e instanceof ErroConfig || e instanceof ErroConfigSupabase) {
      console.error('[trilhas-admin] configuracao:', e.message);
      return erro(res, 500, 'nao_configurado', 'Serviço não configurado no servidor.');
    }
    if (e instanceof ErroSupabase) {
      console.error('[trilhas-admin] supabase:', e.status);
      return erro(res, 502, 'erro_upstream', 'Falha ao acessar o banco de trilhas.');
    }
    console.error(`[trilhas-admin] falha inesperada: ${e?.name}: ${e?.message}`);
    return erro(res, 500, 'erro_interno', 'Erro interno.');
  }
}

async function executarAcao(acao, corpo, res) {
  if (acao === 'criar_trilha') {
    const titulo = texto(corpo.titulo, 200);
    const produto = texto(corpo.produto, 100);
    if (!titulo || !produto) return erro(res, 400, 'campos_invalidos', 'Título e produto são obrigatórios.');
    const trilha = await criarTrilha({
      titulo,
      descricao: texto(corpo.descricao, 2000) || null,
      produto,
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0,
    });
    return res.status(200).json({ trilha });
  }

  if (acao === 'editar_trilha') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const campos = {};
    if (corpo.titulo !== undefined) campos.titulo = texto(corpo.titulo, 200);
    if (corpo.descricao !== undefined) campos.descricao = texto(corpo.descricao, 2000) || null;
    if (corpo.produto !== undefined) campos.produto = texto(corpo.produto, 100);
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    const trilha = await editarTrilha(id, campos);
    return res.status(200).json({ trilha });
  }

  if (acao === 'arquivar_trilha') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const trilha = await editarTrilha(id, { ativa: Boolean(corpo.ativa) });
    return res.status(200).json({ trilha });
  }

  if (acao === 'criar_video') {
    const trilhaId = texto(corpo.trilhaId, 64);
    const titulo = texto(corpo.titulo, 200);
    const youtubeId = extrairYoutubeId(corpo.youtube);
    if (!trilhaId || !titulo || !youtubeId) {
      return erro(res, 400, 'campos_invalidos', 'trilhaId, título e um vídeo do YouTube válido são obrigatórios.');
    }
    const video = await criarVideo({
      trilhaId,
      titulo,
      youtubeId,
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : 0,
      duracaoSegundos: Number.isInteger(corpo.duracaoSegundos) ? corpo.duracaoSegundos : null,
    });
    return res.status(200).json({ video });
  }

  if (acao === 'editar_video') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const campos = {};
    if (corpo.titulo !== undefined) campos.titulo = texto(corpo.titulo, 200);
    if (corpo.youtube !== undefined) {
      const youtubeId = extrairYoutubeId(corpo.youtube);
      if (!youtubeId) return erro(res, 400, 'campos_invalidos', 'Vídeo do YouTube inválido.');
      campos.youtube_id = youtubeId;
    }
    if (corpo.ordem !== undefined && Number.isInteger(corpo.ordem)) campos.ordem = corpo.ordem;
    const video = await editarVideo(id, campos);
    return res.status(200).json({ video });
  }

  if (acao === 'arquivar_video') {
    const id = texto(corpo.id, 64);
    if (!id) return erro(res, 400, 'campos_invalidos', 'id é obrigatório.');
    const video = await editarVideo(id, { ativo: Boolean(corpo.ativo) });
    return res.status(200).json({ video });
  }

  return erro(res, 400, 'acao_desconhecida', `Ação desconhecida: ${acao}`);
}
