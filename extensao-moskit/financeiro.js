// Envio automático do formulário do financeiro (Google Forms "Comercial - Financeiro - CS").
//
// Só age quando a página foi aberta pelo painel com a marca #londrisoft=BASE64 no endereço
// — nunca num formulário aberto à mão. Roda no navegador do vendedor, já logado no Google (o
// Forms exige login e registra o e-mail de quem envia). O Forms NÃO é uma página só: cada
// "Avançar" recarrega a página (POST em /formResponse), então o trabalho é feito uma página por
// vez e o estado (valores + contagem de passos) fica no sessionStorage da própria aba.
// Se algo não casar (pergunta sem valor, opção que não existe, campo obrigatório vazio), PARA,
// limpa o estado e deixa o formulário aberto com o que já foi preenchido — nunca envia pela metade.
// A marca fica no fragmento (#), que não é enviado a nenhum servidor.
(function () {
  'use strict';

  var MARCA = '#londrisoft=';
  var CHAVE = 'londrisoft-financeiro';
  var VALIDADE_MS = 5 * 60 * 1000;
  var MAX_PASSOS = 14;
  var RE_FORM = /\/forms\/(?:u\/\d+\/)?d\/e\/([^/]+)/;

  var estado = lerEstado();
  if (location.hash.indexOf(MARCA) === 0) {
    var inicial = decodificar(location.hash.slice(MARCA.length));
    var formId = (RE_FORM.exec(location.pathname) || [])[1];
    history.replaceState(null, '', location.pathname + location.search);
    if (!inicial || !formId) return;
    estado = { campos: inicial.campos, formId: formId, inicio: Date.now(), passos: 0 };
    salvarEstado();
  }
  if (!estado) return;
  var idAtual = (RE_FORM.exec(location.pathname) || [])[1];
  if (Date.now() - estado.inicio > VALIDADE_MS || idAtual !== estado.formId) { limparEstado(); return; }

  var banner = criarBanner();
  var cancelado = false;
  banner.aoCancelar(function () { cancelado = true; limparEstado(); });
  passo().catch(function (e) {
    limparEstado();
    banner.mostrar('⚠️ Não consegui enviar sozinho (' + (e && e.message ? e.message : 'erro') + '). Complete o que faltar e clique em Enviar.', 'erro', true);
  });

  // ---------------------------------------------------------------- estado
  function lerEstado() { try { return JSON.parse(sessionStorage.getItem(CHAVE) || 'null'); } catch (e) { return null; } }
  function salvarEstado() { sessionStorage.setItem(CHAVE, JSON.stringify(estado)); }
  function limparEstado() { try { sessionStorage.removeItem(CHAVE); } catch (e) { /* ignora */ } }
  function decodificar(b64) {
    try {
      var p = JSON.parse(decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))));
      return p && p.v === 1 && p.campos ? p : null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- utilidades
  function dormir(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function esperar(cond, limiteMs, passoMs) {
    var fim = Date.now() + (limiteMs || 10000);
    while (Date.now() < fim) {
      var v = cond();
      if (v) return v;
      await dormir(passoMs || 150);
    }
    return null;
  }
  function visivel(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }

  function criarBanner() {
    var el = document.getElementById('londrisoft-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'londrisoft-banner';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px 18px;font:600 15px/1.35 system-ui,sans-serif;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.3);';
      var texto = document.createElement('span'); texto.id = 'londrisoft-banner-texto'; el.appendChild(texto);
      var btn = document.createElement('button'); btn.id = 'londrisoft-banner-cancelar'; btn.type = 'button'; btn.textContent = 'Cancelar';
      btn.style.cssText = 'margin-left:14px;padding:4px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.7);background:transparent;color:inherit;cursor:pointer;font:600 13px system-ui,sans-serif;';
      el.appendChild(btn);
      (document.body || document.documentElement).appendChild(el);
    }
    return {
      mostrar: function (t, tipo, semCancelar) {
        el.style.background = tipo === 'ok' ? '#15803d' : tipo === 'erro' ? '#b45309' : '#0A41B4';
        el.style.color = '#fff';
        el.querySelector('#londrisoft-banner-texto').textContent = t;
        el.querySelector('#londrisoft-banner-cancelar').style.display = (tipo === 'ok' || semCancelar) ? 'none' : '';
      },
      aoCancelar: function (fn) { el.querySelector('#londrisoft-banner-cancelar').onclick = function () { fn(); el.remove(); }; }
    };
  }

  // O Forms só reage à sequência COMPLETA de eventos de ponteiro/mouse (um .click() puro não seleciona
  // opção de lista nem de radio) — por isso o clique é simulado inteiro. Com rolar=false (opções da
  // lista) não rola a página: rolar com o menu aberto fecha o menu e o clique se perde.
  function clicar(el, rolar) {
    if (rolar !== false) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignora */ } }
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerType: 'mouse', isPrimary: true };
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(t.indexOf('pointer') === 0 ? new PointerEvent(t, o) : new MouseEvent(t, o));
    });
  }
  function setValor(input, v) {
    var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ---------------------------------------------------------------- páginas do Forms
  function itensDaPagina() {
    var lista = [];
    document.querySelectorAll('div[role="listitem"]').forEach(function (el) {
      if (!visivel(el)) return;
      var dados = el.querySelector('[data-params]');
      var m = /\[\[(\d{6,})/.exec((dados && dados.getAttribute('data-params')) || '');
      if (m) lista.push({ el: el, entry: m[1], titulo: ((el.querySelector('[role="heading"]') || {}).innerText || '').split('\n')[0].trim() });
    });
    return lista;
  }

  async function preencher(item, valor) {
    var el = item.el;
    var lista = el.querySelector('[role="listbox"]');
    var radios = el.querySelector('[role="radiogroup"]');
    if (lista) {
      var escolhida = function () {
        var s = el.querySelector('[role="option"][aria-selected="true"]');
        return !!s && s.getAttribute('data-value') === valor;
      };
      // O menu é temperamental (animação, foco): tenta até 3 vezes e só segue quando a opção ficou marcada.
      for (var tentativa = 0; tentativa < 3 && !escolhida(); tentativa++) {
        if (lista.getAttribute('aria-expanded') === 'true') { clicar(lista, false); await dormir(500); }
        clicar(lista);
        await dormir(800);
        var opcao = Array.prototype.filter.call(el.querySelectorAll('[role="option"]'), function (o) { return o.getAttribute('data-value') === valor; })[0];
        if (!opcao) throw new Error('a opção "' + valor + '" não existe em "' + item.titulo + '"');
        clicar(opcao, false);
        await dormir(1000);
      }
      if (!escolhida()) throw new Error('não consegui selecionar "' + valor + '" em "' + item.titulo + '"');
    } else if (radios) {
      // O Forms recria o elemento ao marcar: sempre buscar de novo antes de conferir.
      var achar = function () { return Array.prototype.filter.call(el.querySelectorAll('[role="radio"]'), function (o) { return o.getAttribute('data-value') === valor; })[0]; };
      if (!achar()) throw new Error('a opção "' + valor + '" não existe em "' + item.titulo + '"');
      for (var t2 = 0; t2 < 3 && achar().getAttribute('aria-checked') !== 'true'; t2++) { clicar(achar()); await dormir(500); }
      if (achar().getAttribute('aria-checked') !== 'true') throw new Error('não consegui marcar "' + valor + '" em "' + item.titulo + '"');
    } else {
      var campo = el.querySelector('input[type="date"], input[type="text"], input[type="email"], textarea');
      if (!campo) throw new Error('não achei o campo "' + item.titulo + '"');
      setValor(campo, valor);
      await dormir(120);
    }
  }

  function botao(regex) {
    return Array.prototype.filter.call(document.querySelectorAll('[role="button"]'), function (b) {
      return visivel(b) && regex.test((b.innerText || '').trim());
    })[0];
  }
  function perguntasComErro() {
    return Array.prototype.filter.call(document.querySelectorAll('div[role="listitem"]'), function (el) {
      return /obrigat[óo]ria|Informe uma data|resposta válida/i.test((el.querySelector('[role="alert"]') || {}).innerText || '');
    }).map(function (el) { return ((el.querySelector('[role="heading"]') || {}).innerText || '').split('\n')[0].trim(); });
  }

  async function passo() {
    banner.mostrar('⏳ Enviando para o financeiro… não feche esta aba.', 'info');
    await esperar(function () { return itensDaPagina().length || /resposta foi registrada|response has been recorded/i.test(document.body.innerText || ''); }, 15000);
    if (cancelado) return;

    // Depois do Enviar o Forms mostra a confirmação (sem perguntas).
    if (!itensDaPagina().length) {
      if (/resposta foi registrada|response has been recorded/i.test(document.body.innerText || '')) {
        limparEstado();
        banner.mostrar('✅ Formulário do financeiro enviado! Esta aba vai fechar sozinha.', 'ok');
        setTimeout(function () { window.close(); }, 2500);
        return;
      }
      throw new Error('não reconheci esta página do formulário');
    }

    estado.passos += 1;
    if (estado.passos > MAX_PASSOS) throw new Error('o formulário passou do número esperado de páginas');
    salvarEstado();

    // "Registrar meu endereço de e-mail com a minha resposta" (coleta de e-mail do Forms)
    var caixa = document.querySelector('[role="checkbox"]');
    if (caixa && visivel(caixa) && caixa.getAttribute('aria-checked') !== 'true') { clicar(caixa); await dormir(250); }

    var itens = itensDaPagina();
    for (var i = 0; i < itens.length; i++) {
      var valor = estado.campos[itens[i].entry];
      if (valor === undefined || valor === null || String(valor) === '') continue;
      await preencher(itens[i], String(valor));
      if (cancelado) return;
    }

    var enviar = botao(/^(Enviar|Submit)$/i);
    var proximo = enviar ? null : botao(/^(Avançar|Next)$/i);
    if (!enviar && !proximo) throw new Error('não achei o botão Avançar/Enviar');
    await dormir(600);
    clicar(enviar || proximo);
    // Se a página recarregar, esta execução termina aqui e a próxima carga continua. Se ainda
    // estamos aqui depois de alguns segundos, o Forms barrou (pergunta obrigatória sem resposta).
    await dormir(7000);
    var faltando = perguntasComErro();
    throw new Error((enviar ? 'o envio' : 'o avanço') + ' não foi aceito' + (faltando.length ? ' — falta: ' + faltando.join(', ') : ''));
  }
})();
