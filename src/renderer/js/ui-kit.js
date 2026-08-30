import { el, $ } from './util.js';

/* ============================== Bildirimler =============================== */

export function toast(title, detail, kind = 'info', ms = 4200) {
  const node = el('div', { class: `toast ${kind}` },
    el('div', { class: 'tbody' },
      el('div', { class: 'tt' }, title),
      detail ? el('div', { class: 'td' }, detail) : null
    )
  );
  $('#toasts').append(node);
  const close = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener('click', close);
  if (ms) setTimeout(close, ms);
  return close;
}

/* ================================ Modallar =============================== */

let openModals = 0;

export function modal({ title, subtitle, body, footer, wide, onClose, closeOnBackdrop = true }) {
  const content = el('div', { class: `modal${wide ? ' wide' : ''}` });

  const head = el('div', { class: 'modal-head' },
    el('div', {},
      el('h2', {}, title),
      subtitle ? el('p', {}, subtitle) : null
    ),
    el('button', { class: 'icon-btn', 'data-icon': 'close', onclick: () => close() })
  );

  const bodyNode = el('div', { class: 'modal-body' });
  if (body) bodyNode.append(body);

  content.append(head, bodyNode);
  if (footer) content.append(el('div', { class: 'modal-foot' }, footer));

  const backdrop = el('div', { class: 'modal-backdrop' }, content);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && closeOnBackdrop) close();
  });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    openModals--;
    if (onClose) onClose();
  }

  $('#modalRoot').append(backdrop);
  openModals++;
  return { root: backdrop, content, body: bodyNode, close, replaceBody: (n) => { bodyNode.replaceChildren(n); } };
}

export function confirmDialog({ title, message, confirmText = 'Onayla', danger }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal({
      title,
      body: el('p', { style: { fontSize: '13.5px', color: 'var(--tx-2)', lineHeight: '1.6', whiteSpace: 'pre-line' } }, message),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => finish(false) }, 'Vazgec'),
        el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, confirmText)
      ],
      onClose: () => finish(false)
    });
  });
}

export function promptDialog({ title, label, placeholder, value = '', confirmText = 'Olustur' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', placeholder: placeholder || '', value });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal({
      title,
      body: el('label', { class: 'field' }, el('span', {}, label), input),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Vazgec'),
        el('button', { class: 'btn primary', onclick: () => finish(input.value.trim() || null) }, confirmText)
      ],
      onClose: () => finish(null)
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim() || null);
    });
    setTimeout(() => input.focus(), 40);
  });
}

/* ============================= Baglam menusu ============================= */

let ctxCleanup = null;

export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = el('div', { class: 'ctx-menu' });

  for (const item of items) {
    if (!item) continue;
    if (item.type === 'sep') { menu.append(el('div', { class: 'ctx-sep' })); continue; }
    if (item.type === 'label') { menu.append(el('div', { class: 'ctx-label' }, item.text)); continue; }
    if (item.type === 'slider') {
      const valNode = el('span', {}, item.format ? item.format(item.value) : String(item.value));
      const range = el('input', {
        type: 'range',
        min: item.min ?? 0, max: item.max ?? 200, step: item.step ?? 1, value: item.value
      });
      const paint = () => {
        const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
        range.style.setProperty('--pct', `${pct}%`);
        valNode.textContent = item.format ? item.format(Number(range.value)) : range.value;
      };
      range.addEventListener('input', () => { paint(); item.onInput(Number(range.value)); });
      paint();
      menu.append(el('div', { class: 'ctx-slider' },
        el('div', { class: 'cs-head' }, el('span', {}, item.text), valNode),
        range
      ));
      continue;
    }
    menu.append(el('button', {
      class: `ctx-item${item.danger ? ' danger' : ''}`,
      'data-icon': item.icon || false,
      onclick: () => { closeContextMenu(); item.onClick && item.onClick(); }
    }, el('span', {}, item.text)));
  }

  $('#ctxRoot').append(menu);

  const r = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 10);
  const py = Math.min(y, window.innerHeight - r.height - 10);
  menu.style.left = `${Math.max(6, px)}px`;
  menu.style.top = `${Math.max(6, py)}px`;

  const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);

  ctxCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closeContextMenu);
    menu.remove();
    ctxCleanup = null;
  };
  return menu;
}

export function closeContextMenu() {
  if (ctxCleanup) ctxCleanup();
}

/* ================================ Lightbox =============================== */

export function lightbox(src, type = 'image') {
  const media = type === 'video'
    ? el('video', { src, controls: true, autoplay: true })
    : el('img', { src, alt: '' });
  const box = el('div', { class: 'lightbox' },
    media,
    el('button', { class: 'icon-btn lb-close', 'data-icon': 'close' })
  );
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', (e) => { if (e.target !== media) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
}

/* =============================== Emoji secici ============================ */

const EMOJI_GROUPS = [
  ['Sik kullanilan', [0x1F602, 0x1F44D, 0x2764, 0x1F525, 0x1F604, 0x1F622, 0x1F621, 0x1F44C,
                      0x1F389, 0x1F44F, 0x1F914, 0x1F926, 0x1F62D, 0x1F60E, 0x1F480, 0x1F4AF]],
  ['Yuzler', [0x1F600, 0x1F603, 0x1F606, 0x1F609, 0x1F60A, 0x1F60D, 0x1F618, 0x1F61C,
              0x1F914, 0x1F610, 0x1F634, 0x1F644, 0x1F62C, 0x1F631, 0x1F624, 0x1F620,
              0x1F607, 0x1F921, 0x1F92F, 0x1F92A, 0x1F975, 0x1F976, 0x1F97A, 0x1F929]],
  ['El ve beden', [0x1F44D, 0x1F44E, 0x1F44C, 0x270C, 0x1F91E, 0x1F918, 0x1F44A, 0x270A,
                   0x1F64F, 0x1F4AA, 0x1F440, 0x1F9E0, 0x1F441, 0x1F445, 0x1F446, 0x1F447]],
  ['Nesneler', [0x1F3AE, 0x1F4BB, 0x1F3A7, 0x1F3A4, 0x1F4F1, 0x1F4A1, 0x1F4A3, 0x1F3C6,
                0x1F381, 0x1F37B, 0x2615, 0x1F355, 0x1F354, 0x1F680, 0x26A1, 0x2B50]],
  ['Simgeler', [0x2764, 0x1F494, 0x2728, 0x1F525, 0x1F4A5, 0x1F4A2, 0x2705, 0x274C,
                0x26A0, 0x1F6AB, 0x1F534, 0x1F7E2, 0x1F535, 0x1F7E1, 0x1F3B5, 0x1F514]]
];

export function emojiPicker(anchorRect, onPick) {
  closeEmojiPicker();
  const panel = el('div', { class: 'emoji-panel' });

  for (const [name, codes] of EMOJI_GROUPS) {
    panel.append(el('div', { class: 'emoji-cat' }, name));
    const grid = el('div', { class: 'emoji-grid' });
    for (const cp of codes) {
      const ch = String.fromCodePoint(cp);
      grid.append(el('button', { type: 'button', onclick: () => { onPick(ch); closeEmojiPicker(); } }, ch));
    }
    panel.append(grid);
  }

  $('#emojiRoot').append(panel);
  const r = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(anchorRect.left - r.width + 40, window.innerWidth - r.width - 8))}px`;
  panel.style.top = `${Math.max(8, anchorRect.top - r.height - 8)}px`;

  const onDown = (e) => { if (!panel.contains(e.target)) closeEmojiPicker(); };
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  emojiCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    panel.remove();
    emojiCleanup = null;
  };
  return panel;
}

let emojiCleanup = null;
export function closeEmojiPicker() { if (emojiCleanup) emojiCleanup(); }

export const QUICK_REACTIONS = [0x1F44D, 0x2764, 0x1F602, 0x1F62E, 0x1F622, 0x1F525]
  .map((c) => String.fromCodePoint(c));

/* ============================== Kucuk parcalar =========================== */

export function avatarNode(user, size) {
  const node = el('div', { class: 'avatar', style: { background: user.color || 'var(--accent)' } },
    el('span', {}, (user.username || '?').trim().slice(0, 2).toUpperCase())
  );
  if (size) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
    node.style.fontSize = `${Math.round(size * 0.36)}px`;
  }
  node.append(el('i', { class: 'mic-ring' }));
  return node;
}

export function bindRange(input, onInput) {
  const paint = () => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--pct', `${pct}%`);
  };
  input.addEventListener('input', () => { paint(); onInput && onInput(Number(input.value)); });
  paint();
  return paint;
}
