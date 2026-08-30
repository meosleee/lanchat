/* Kucuk yardimcilar */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function throttle(fn, ms = 200) {
  let last = 0;
  let queued = null;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else {
      clearTimeout(queued);
      queued = setTimeout(() => {
        last = Date.now();
        fn(...a);
      }, ms - (now - last));
    }
  };
}

export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Bugun';
  if (same(d, yest)) return 'Dun';
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

const PALETTE = ['#5b8cff', '#3ba55d', '#faa61a', '#ed4245', '#9b59b6', '#1abc9c', '#e91e63', '#f97316', '#06b6d4', '#8b5cf6'];

export function colorFor(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 91, g: 140, b: 255 };
}

export function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Basit olay yayicisi */
export class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) {
    const off = this.on(evt, (...a) => { off(); fn(...a); });
    return off;
  }
  off(evt, fn) {
    const set = this._h.get(evt);
    if (set) set.delete(fn);
  }
  emit(evt, ...args) {
    const set = this._h.get(evt);
    if (set) {
      for (const fn of [...set]) {
        try { fn(...args); } catch (err) { console.error(`[emitter:${evt}]`, err); }
      }
    }
    const star = this._h.get('*');
    if (star) for (const fn of [...star]) { try { fn(evt, ...args); } catch {} }
  }
}

/** Cok basit markdown: **kalin** *egik* `kod` ```blok``` ~~ustu cizili~~ > alinti, link, ||spoiler|| */
export function renderMarkdown(text) {
  const blocks = [];
  let src = escapeHtml(text);

  src = src.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre class="code-block"${lang ? ` data-lang="${lang}"` : ''}><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `%%CB${blocks.length - 1}%%`;
  });

  src = src.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

  src = src
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|\n]+)\|\|/g, '<span class="spoiler" data-spoiler>$1</span>');

  src = src.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer noopener">$1</a>');

  src = src
    .split('\n')
    .map((line) => (line.startsWith('&gt; ') ? `<blockquote>${line.slice(5)}</blockquote>` : line))
    .join('\n');

  src = src.replace(/\n/g, '<br>');
  src = src.replace(/%%CB(\d+)%%/g, (_m, i) => blocks[Number(i)]);
  return src;
}

const EMOJI_ONLY = new RegExp('^(?:\\p{Extended_Pictographic}|\\p{Emoji_Component}|\\uFE0F|\\u200D)+$', 'u');

/** Mesaj sadece emojiden mi olusuyor? (buyuk gosterim icin) */
export function isOnlyEmoji(text) {
  const t = String(text).trim();
  if (!t || t.length > 12) return false;
  return EMOJI_ONLY.test(t);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function uid(p = 'id') {
  return `${p}_${Math.random().toString(36).slice(2, 10)}`;
}
