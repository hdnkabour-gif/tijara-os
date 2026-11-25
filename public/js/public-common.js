/** Shared helpers for the PUBLIC pages (menu, tracking): no account, no session, nothing from the staff app. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : String(c)); };
  kids.forEach(add);
  return el;
}
export class PublicError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
export async function call(method, path, body, headers = {}) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'tijara-web', ...headers }, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PublicError(r.status, j?.error?.code, j?.error?.message ?? 'error');
  return j;
}
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
export const prefs = store;
export const lang = () => store.get('tj_pub_lang') ?? (navigator.language?.startsWith('ar') ? 'ar' : 'fr');
export function setLang(l) { store.set('tj_pub_lang', l); applyLang(); }
export function applyLang() { const l = lang(); document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr'; }
export const money = (v) => new Intl.NumberFormat(lang() === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { style: 'currency', currency: 'MAD' }).format(Number(v));
export const qty = (v) => new Intl.NumberFormat(lang() === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { maximumFractionDigits: 3 }).format(Number(v));
/** a time slot in the shop's local time (Casablanca), e.g. "mar. 25 · 12:30" */
export const slotLabel = (iso) => new Intl.DateTimeFormat(lang() === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { timeZone: 'Africa/Casablanca', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export function applyBrand(primary, accent) {
  const s = document.documentElement.style;
  if (primary) s.setProperty('--brand', primary);
  if (accent) s.setProperty('--accent', accent);
}
