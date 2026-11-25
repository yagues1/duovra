function () {
  // Resumen de un elemento para Live Preview. Se ejecuta bajo demanda (nunca de forma permanente) y
  // solo lee: no modifica la página. Todo lo devuelto procede de la página y es dato no confiable.
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const generated = /^(css|sc|jsx|svelte|astro|emotion|chakra)-[a-z0-9]{4,}$|^_[a-z0-9]{5,}$/i;
  const step = (n) => {
    if (n.id && !/\d{4,}/.test(n.id)) return '#' + esc(n.id);
    let part = n.tagName.toLowerCase();
    const cls = Array.prototype.filter.call(n.classList, (c) => !generated.test(c)).slice(0, 2);
    if (cls.length) part += '.' + cls.map(esc).join('.');
    const parent = n.parentElement;
    if (parent) {
      const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
    }
    return part;
  };
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && parts.length < 7; n = n.parentElement) {
    const s = step(n);
    parts.unshift(s);
    if (s.startsWith('#') || n.tagName === 'BODY') break;
  }
  const selector = parts.join(' > ');
  let unique = false;
  try { unique = el.ownerDocument.querySelectorAll(selector).length === 1; } catch (_) {}

  const r = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView || window;
  const cs = view.getComputedStyle(el);
  const keys = ['display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'gap', 'flex-direction',
    'justify-content', 'align-items', 'grid-template-columns', 'color', 'background-color', 'background-image',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'border', 'border-radius',
    'box-shadow', 'opacity', 'transform', 'transition', 'animation', 'cursor', 'z-index', 'overflow'];
  const styles = {};
  for (const k of keys) {
    const v = cs.getPropertyValue(k);
    if (v && !/^(none|normal|auto|0px|rgba\(0, 0, 0, 0\)|all 0s ease 0s|visible|static)$/.test(v)) styles[k] = cut(v, 160);
  }

  // Copia saneada del HTML: sin valores de campos ni atributos que puedan contener secretos.
  const clone = el.cloneNode(true);
  const scrub = (node) => {
    if (node.nodeType !== 1) return;
    for (const a of Array.from(node.attributes)) {
      if (a.name === 'value' || /token|secret|password|passwd|auth|session|csrf|nonce|api[-_]?key/i.test(a.name)) node.setAttribute(a.name, '[omitido]');
      else if (a.value.length > 300) node.setAttribute(a.name, cut(a.value, 300));
    }
    if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') node.removeAttribute('value');
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') node.textContent = '…';
    for (const c of Array.from(node.children)) scrub(c);
  };
  scrub(clone);
  const html = cut(clone.outerHTML.replace(/\s{2,}/g, ' '), 2400);

  const attrs = {};
  for (const name of ['role', 'aria-label', 'name', 'type', 'href', 'src', 'alt', 'placeholder', 'title', 'for']) {
    const v = el.getAttribute(name);
    if (v) attrs[name] = cut(v, 200);
  }
  const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
  const text = field ? '' : cut((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 400);

  // Origen del componente: solo cuando el propio framework lo declara en desarrollo. Nunca se deduce.
  const frameworks = [];
  let component = null;
  let source = null;
  try {
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (fiberKey) {
      frameworks.push('React');
      for (let f = el[fiberKey], i = 0; f && i < 30; f = f.return, i++) {
        if (!component && typeof f.type === 'function') component = f.type.displayName || f.type.name || null;
        if (!source && f._debugSource && f._debugSource.fileName) source = f._debugSource.fileName + ':' + f._debugSource.lineNumber;
        if (component && source) break;
      }
    }
    const vue = el.__vueParentComponent;
    if (vue || el.__vue_app__) {
      frameworks.push('Vue');
      if (vue && vue.type) {
        component = component || vue.type.name || vue.type.__name || null;
        if (!source && typeof vue.type.__file === 'string') source = vue.type.__file;
      }
    }
    if (el.__svelte_meta) {
      frameworks.push('Svelte');
      const loc = el.__svelte_meta.loc;
      if (!source && loc && typeof loc.file === 'string') source = loc.file;
    }
    if (Array.from(el.attributes).some((a) => a.name.startsWith('data-astro-'))) frameworks.push('Astro');
  } catch (_) {}

  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.prototype.slice.call(el.classList, 0, 12),
    text, selector, unique, attrs, styles, html,
    rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    page: { x: r.left + view.scrollX, y: r.top + view.scrollY, width: r.width, height: r.height },
    viewport: { width: view.innerWidth, height: view.innerHeight, dpr: view.devicePixelRatio },
    hasParent: !!el.parentElement && el.parentElement.tagName !== 'HTML',
    hasChild: !!el.firstElementChild,
    frameworks: frameworks.slice(0, 3),
    component: component ? cut(component, 80) : null,
    source: source ? cut(source, 300) : null,
    url: cut(el.ownerDocument.location.href, 600),
  };
}
