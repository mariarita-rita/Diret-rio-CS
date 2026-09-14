// Catálogo fixo de campos que uma regra de pontos (autodeclarada ou
// pendente_aprovacao) pode pedir ao cliente ao declarar. Abrir um campo novo
// pra qualquer regra é mexer só aqui — não precisa de formulário bespoke por
// campanha (ver pontos_regras.campos_formulario em sql/trilhas-schema.sql).
import { texto } from './http.js';

export const CATALOGO_CAMPOS = {
  nome: { rotulo: 'Nome', tipo: 'text' },
  email: { rotulo: 'E-mail', tipo: 'email' },
  cnpj: { rotulo: 'CNPJ', tipo: 'text' },
  whatsapp: { rotulo: 'WhatsApp', tipo: 'text' },
  data_inscricao: { rotulo: 'Data de inscrição', tipo: 'date' },
  horario_contato: { rotulo: 'Melhor horário para contato', tipo: 'text' },
  observacao: { rotulo: 'Observação', tipo: 'textarea' },
};

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida e saneia a config de campos de uma regra: array de
 * { chave, obrigatorio }. Ignora chaves fora do catálogo e duplicadas.
 * Retorna null só se `v` nem for um array.
 */
export function sanearCamposFormulario(v) {
  if (!Array.isArray(v)) return null;
  const vistos = new Set();
  const saneado = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const chave = String(item.chave || '');
    if (!CATALOGO_CAMPOS[chave] || vistos.has(chave)) continue;
    vistos.add(chave);
    saneado.push({ chave, obrigatorio: Boolean(item.obrigatorio) });
  }
  return saneado;
}

/** Poda as respostas do cliente pras chaves que a regra realmente pede. */
export function limparRespostas(camposFormulario, respostasBrutas) {
  const bruto = respostasBrutas && typeof respostasBrutas === 'object' ? respostasBrutas : {};
  const limpo = {};
  for (const campo of camposFormulario || []) {
    const valor = texto(bruto[campo.chave], 500);
    if (valor) limpo[campo.chave] = valor;
  }
  return limpo;
}

/**
 * Confere se as respostas (já limpas por limparRespostas) atendem ao que a
 * regra pede: obrigatórios preenchidos, e-mail com cara de e-mail. Retorna a
 * mensagem de erro, ou null se estiver tudo certo.
 */
export function validarRespostas(camposFormulario, respostasLimpas) {
  for (const campo of camposFormulario || []) {
    const def = CATALOGO_CAMPOS[campo.chave];
    if (!def) continue;
    const valor = respostasLimpas[campo.chave];
    if (campo.obrigatorio && !valor) return `Preencha o campo "${def.rotulo}".`;
    if (valor && def.tipo === 'email' && !RE_EMAIL.test(valor)) return `E-mail inválido em "${def.rotulo}".`;
  }
  return null;
}
