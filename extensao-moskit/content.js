// Injeta um botão na tela de um negócio do Moskit. Ao clicar, abre o painel de
// implantação numa janela pequena com ?negocio=<id> — o painel lê o negócio pela
// API (no nosso servidor) e pré-preenche o formulário. A extensão NÃO lê a tela
// do Moskit além da URL e NÃO guarda chave nem senha nenhuma.

var SITE = 'https://diretoriocs.vercel.app';
// Padrão da URL da tela de um negócio (ex.: https://app.moskitcrm.com/deal/49977114).
var PADRAO_URL_NEGOCIO = /\/deals?\/(\d{5,})/;
var ID_BOTAO = 'londrisoft-criar-projeto-btn';

function idDoNegocioNaUrl() {
  var m = location.pathname.match(PADRAO_URL_NEGOCIO);
  return m ? m[1] : null;
}

function criarBotao() {
  var b = document.createElement('button');
  b.id = ID_BOTAO;
  b.type = 'button';
  b.textContent = '➕ Criar projeto de implantação';
  b.style.cssText = [
    'position:fixed', 'right:24px', 'bottom:28px', 'z-index:2147483647',
    'padding:16px 28px', 'border:0', 'border-radius:12px', 'cursor:pointer',
    'background:#0A41B4', 'color:#fff', 'font:700 16px/1.2 system-ui,sans-serif',
    'box-shadow:0 6px 22px rgba(10,65,180,.55)', 'animation:londrisoftPulse 2.4s ease-in-out 3'
  ].join(';');
  if (!document.getElementById('londrisoft-criar-projeto-css')) {
    var css = document.createElement('style');
    css.id = 'londrisoft-criar-projeto-css';
    css.textContent = '@keyframes londrisoftPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}' +
      '#' + ID_BOTAO + ':hover{background:#0b52e0}';
    document.head.appendChild(css);
  }
  b.addEventListener('click', function () {
    var id = idDoNegocioNaUrl();
    if (!id) return;
    window.open(
      SITE + '/implantacao-waipe.html?negocio=' + id,
      'projetoLondrisoft',
      'popup,width=520,height=820'
    );
  });
  return b;
}

// O Moskit é uma SPA: a URL muda sem recarregar a página, então reavalia sempre.
function atualizar() {
  var existente = document.getElementById(ID_BOTAO);
  if (idDoNegocioNaUrl()) {
    if (!existente) document.body.appendChild(criarBotao());
  } else if (existente) {
    existente.remove();
  }
}

atualizar();
setInterval(atualizar, 1000);
