// GET/POST /api/formulario-tributario?id=&token=
//
// Endpoint público (sem sessão) por trás de formulario-tributario.html — o
// link que o cliente recebe pra preencher os dados tributários direto no
// projeto de implantação, sem precisar de e-mail/telefone pra ida e volta.
// Só existe pra "Cliente Novo" (origem Moskit) com Gestor ou Bime na
// proposta (ver dadosTributariosCampos, em api/clickup.js) — é lá que o
// link com o token é gerado.
//
// Protegido por um token assinado (HMAC, ver assinarTokenProjeto/
// verificarTokenProjeto em api/_lib/clickup.js) amarrado ao `id` do
// projeto — sem sessão de usuário nenhuma, então sem o token qualquer id
// de task poderia ser lido/escrito por qualquer um. GET só devolve o nome
// do cliente e se já foi preenchido (nunca o resto do estado do projeto).

import { aplicarCors, erro, lerCorpo, taskIdValido, texto, ErroCorpo } from './_lib/http.js';
import {
  obterTask,
  atualizarTask,
  parseWaipeState,
  stringifyWaipeState,
  contextoSemEstado,
  anexarArquivoTask,
  verificarTokenProjeto,
  LISTA_IMPLANTACOES_WAIPE,
} from './_lib/clickup.js';
import { sanearDadosTributarios, lerArquivoAnexo } from './clickup.js';

// Mesmo teto de api/clickup.js (base64 do anexo + JSON ao redor) — duplicado
// de propósito, é só uma constante pequena, não vale acoplar os arquivos.
const LIMITE_CORPO_FORMULARIO = 6 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!aplicarCors(req, res)) {
      return erro(res, 403, 'origem_nao_permitida', 'Origem não permitida.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();

    const id = String(req.query?.id || '');
    const token = String(req.query?.token || '');
    if (!taskIdValido(id)) {
      return erro(res, 400, 'link_invalido', 'Link inválido.');
    }
    const idDoToken = verificarTokenProjeto(token);
    if (!idDoToken || idDoToken !== id) {
      return erro(res, 403, 'link_invalido', 'Link inválido ou expirado.');
    }

    const projeto = await obterTask(id);
    if (!projeto || String(projeto.list?.id || '') !== LISTA_IMPLANTACOES_WAIPE || projeto.parent) {
      return erro(res, 404, 'link_invalido', 'Link inválido.');
    }

    if (req.method === 'GET') return await lerFormularioAcao(res, projeto);
    if (req.method === 'POST') return await salvarFormularioAcao(req, res, projeto);
    return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido.');
  } catch (e) {
    console.error('[formulario-tributario] falha:', e?.name, e?.message);
    return erro(res, 500, 'erro_interno', 'Não foi possível carregar o formulário agora — tente de novo em instantes.');
  }
}

async function lerFormularioAcao(res, projeto) {
  const estado = parseWaipeState(projeto.description);
  const dadosTributarios = sanearDadosTributarios(estado.dadosTributarios);
  return res.status(200).json({
    cliente: texto(estado.cliente, 120) || projeto.name,
    jaPreenchido: !!dadosTributarios.preenchidoEm,
  });
}

async function salvarFormularioAcao(req, res, projeto) {
  let corpo;
  try {
    corpo = await lerCorpo(req, { limiteBytes: LIMITE_CORPO_FORMULARIO });
  } catch (e) {
    if (e instanceof ErroCorpo) return erro(res, 400, 'corpo_invalido', e.message);
    throw e;
  }

  const dadosTributarios = sanearDadosTributarios({ ...corpo.dadosTributarios, preenchidoEm: Date.now() });

  if (corpo.certificadoArquivo) {
    const arquivo = lerArquivoAnexo(corpo.certificadoArquivo);
    if (arquivo.erro) return erro(res, 400, 'arquivo_invalido', arquivo.erro);
    await anexarArquivoTask(projeto.id, arquivo);
  }

  const estadoAtual = parseWaipeState(projeto.description);
  await atualizarTask(projeto.id, {
    markdown_description: stringifyWaipeState(contextoSemEstado(projeto.description), {
      ...estadoAtual,
      dadosTributarios,
    }),
  });

  return res.status(200).json({ ok: true });
}
