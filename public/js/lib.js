import { t } from './i18n.js';

/** DOM builder. Text is always inserted as text nodes, so data can never become markup (XSS-safe by construction). */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}
/** Like Element.append but skips false/null/undefined (native append would print the word "false"). */
export function put(el, ...children) {
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); };
  children.forEach(add);
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Same-origin API client. The session lives in an HttpOnly cookie; no token ever reaches this code. */
export async function api(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'x-requested-with': 'tijara-web', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiError(0, 'NETWORK', t('errNetwork')); }
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? t('errGeneric'));
  return json;
}
export const newKey = () => crypto.randomUUID();

export function friendly(e) {
  if (!(e instanceof ApiError)) return t('errGeneric');
  if (e.status === 401 && e.code === 'UNAUTHENTICATED') return e.message;
  if (e.status === 403) return `${t('errForbidden')}: ${e.message}`;
  if (e.code === 'IN_USE') return t('inUseHint');
  if (e.code === 'INSUFFICIENT_STOCK' || e.code === 'INVALID_STATE') return `${t('errStock')} — ${e.message}`;
  return e.message || t('errGeneric');
}

let toastTimer;
export function toast(msg, isErr = false) {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const el = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: isErr ? 'alert' : 'status' }, msg);
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4500);
}

export function modal(title, content, { onClose } = {}) {
  const close = () => { back.remove(); onClose?.(); };
  const back = h('div', { class: 'modal-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    onclick: (e) => { if (e.target === back) close(); }, onkeydown: (e) => { if (e.key === 'Escape') close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', null, title),
        h('button', { type: 'button', class: 'modal-x', 'aria-label': t('close'), onclick: () => close() }, '×')),
      content));
  document.body.appendChild(back);
  // focus the first field of the content; a read-only dialog focuses its close button, so Escape always works
  (content.querySelector?.('input,select,textarea,button') ?? back.querySelector('.modal-x'))?.focus();
  return { close };
}

/** Confirmation dialog (no window.confirm: it is blocked in some embedded browsers). Resolves true/false. */
export function confirmBox(message, { danger = true, ok = t('yes') } = {}) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(message, h('div', { class: 'row' },
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), id: 'confirm-ok', type: 'button', onclick: () => { finish(true); m.close(); } }, ok),
      h('button', { class: 'btn', type: 'button', onclick: () => { finish(false); m.close(); } }, t('cancel'))), { onClose: () => finish(false) });
  });
}
export const field = (label, input, id) => [h('label', { for: id }, label), input];
export function errorBox(msg) { return h('div', { class: 'error', role: 'alert' }, msg); }
export const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
