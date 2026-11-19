/* ==========================================================================
   justinas.space UI kit: signature, room navigation, hint, message, controls,
   room index. One call per page:

     const ui = mountUI({ id: 'hold-space' });
     ui.hint('hold space', { touch: 'press and hold' });
     ui.showHint(true);
     ui.message('4.2 light-years from home', { duration: 5.5 });
     ui.tone('light');            // dark ink, for bright moments
     ui.controls([{ type: 'toggle', label: 'sound', value: false, onChange: (on) => … }]);
     if (ui.isUiTarget(event)) return;   // in a piece's own pointer handlers

   Keys: ← → move between rooms, Esc closes the index. Space is left to the pieces.
   ========================================================================== */
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import './ui.css';
import { experiences } from '../experiences.js';
import { site } from '../site.js';

const IDLE_AFTER = 3000; // ms without input before the chrome dims
const TOUCH = matchMedia('(pointer: coarse)').matches;

const ICON_PREV = '<svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M6.5 1 1.5 6l5 5"/></svg>';
const ICON_NEXT = '<svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M1.5 1l5 5-5 5"/></svg>';
const ICON_DIAL = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1"><circle cx="5" cy="5" r="3.5"/><circle cx="5" cy="5" r="1" fill="currentColor" stroke="none"/></svg>';

const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** True when a pointer or key event started on a UI control, so a piece can ignore it. */
export function isUiTarget(e) {
  const t = e && e.target;
  return !!(t && t.closest && t.closest('[data-ui], .ui-index'));
}

/**
 * Mount the shared UI on this page.
 * @param {object} o
 * @param {string} o.id        registry id of the piece on this page
 * @param {'dark'|'light'} [o.tone]  starting ink ('dark' art gets light ink: the default)
 * @param {boolean} [o.hidden] start with the chrome hidden until ui.reveal()
 */
export function mountUI({ id, tone = 'dark', hidden = false } = {}) {
  const index = Math.max(0, experiences.findIndex((x) => x.id === id));
  const here = experiences[index];
  const n = experiences.length;
  const prev = experiences[(index - 1 + n) % n];
  const next = experiences[(index + 1) % n];

  document.documentElement.dataset.theme = here.theme || 'space';

  const links = site.links.filter((l) => l.href)
    .map((l) => `<a href="${esc(l.href)}" rel="noopener" target="_blank">${esc(l.label)}</a>`).join('');

  const groups = [];
  experiences.forEach((x, i) => {
    let g = groups.find((gr) => gr.name === x.collection);
    if (!g) groups.push((g = { name: x.collection, items: [] }));
    g.items.push({ x, i });
  });
  const indexHtml = groups.map((g) => `
      <p class="ui-label ui-index-group">${esc(g.name)}</p>
      <ol>${g.items.map(({ x, i }) => `
        <li><a class="ui-room" href="${x.path}"${i === index ? ' aria-current="page"' : ''}>
          <span class="ui-label ui-room-num">${pad(i + 1)}</span>
          <span><span class="ui-room-title">${esc(x.title)}</span><span class="ui-room-desc">${esc(x.description || '')}</span></span>
        </a></li>`).join('')}
      </ol>`).join('');

  const root = document.createElement('div');
  root.className = 'ui' + (hidden ? ' is-hidden' : '');
  root.dataset.tone = tone;
  root.innerHTML = `
    <footer class="ui-sig ui-chrome" data-ui>
      <p class="ui-sig-name">${esc(site.name)}</p>
      ${links ? `<div class="ui-sig-links">${links}</div>` : ''}
    </footer>

    <div class="ui-centre" aria-live="polite">
      <span class="ui-hint" aria-hidden="true"></span>
      <span class="ui-message"></span>
    </div>

    <div class="ui-corner ui-chrome" data-ui>
      <div class="ui-panel ui-label" role="group" aria-label="Piece controls" hidden></div>
      <button class="ui-button ui-label ui-toggle" type="button" aria-expanded="false">${ICON_DIAL}<span></span></button>
      <nav class="ui-nav" aria-label="Rooms">
        <span class="ui-nav-title">${esc(here.title)}</span>
        <div class="ui-nav-row ui-label">
          <a class="ui-link ui-arrow" href="${prev.path}" aria-label="Previous: ${esc(prev.title)}">${ICON_PREV}</a>
          <button class="ui-button ui-count" type="button" aria-haspopup="dialog" aria-label="All rooms">${pad(index + 1)} / ${pad(n)}</button>
          <a class="ui-link ui-arrow" href="${next.path}" aria-label="Next: ${esc(next.title)}">${ICON_NEXT}</a>
        </div>
      </nav>
    </div>

    <div class="ui-index" role="dialog" aria-modal="true" aria-label="All rooms" inert>
      <button class="ui-button ui-label ui-index-close" type="button">close</button>
      <div class="ui-index-body">${indexHtml}
        <p class="ui-label ui-index-keys">${TOUCH ? '' : '← → to move between rooms · esc to close'}</p>
      </div>
    </div>`;
  document.body.append(root);

  const $ = (s) => root.querySelector(s);
  const hintEl = $('.ui-hint'), msgEl = $('.ui-message');
  const panel = $('.ui-panel'), toggle = $('.ui-toggle'), indexEl = $('.ui-index');

  // A mouse click must not leave focus on a control: Space would then press it as well as drive the piece.
  root.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  /* ---- idle: dim the chrome after a few seconds without input ---- */
  let idleTimer = 0;
  const busy = () => root.classList.contains('is-index-open') || !panel.hidden || root.contains(document.activeElement);
  const wake = () => {
    root.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function check() {
      if (busy()) idleTimer = setTimeout(check, IDLE_AFTER);
      else root.classList.add('is-idle');
    }, IDLE_AFTER);
  };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, wake, { passive: true });
  wake();

  /* ---- room index ---- */
  let lastFocus = null;
  const openIndex = (open) => {
    root.classList.toggle('is-index-open', open);
    indexEl.inert = !open;
    if (open) { lastFocus = document.activeElement; (indexEl.querySelector('[aria-current]') || $('.ui-index-close')).focus({ preventScroll: true }); }
    else if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  };
  $('.ui-count').addEventListener('click', () => openIndex(true));
  $('.ui-index-close').addEventListener('click', () => openIndex(false));
  indexEl.addEventListener('click', (e) => { if (e.target === indexEl) openIndex(false); });

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && root.classList.contains('is-index-open')) { openIndex(false); return; }
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') location.href = prev.path;
    else if (e.key === 'ArrowRight') location.href = next.path;
  });

  /* ---- controls panel ---- */
  let items = [];
  const renderPanel = () => {
    panel.innerHTML = '';
    for (const it of items) {
      if (it.type === 'toggle') {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ui-button';
        const paint = () => { b.setAttribute('aria-pressed', String(!!it.value)); b.innerHTML = `<span>${esc(it.label)}</span><span class="ui-value">${it.value ? (it.on || 'on') : (it.off || 'off')}</span>`; };
        b.addEventListener('click', () => { it.value = !it.value; paint(); it.onChange && it.onChange(it.value); });
        paint(); panel.append(b);
      } else if (it.type === 'range') {
        const l = document.createElement('label');
        l.className = 'ui-range';
        l.innerHTML = `<span>${esc(it.label)}</span><input type="range" min="${it.min ?? 0}" max="${it.max ?? 1}" step="${it.step ?? 0.01}" value="${it.value ?? 0}">`;
        l.querySelector('input').addEventListener('input', (e) => { it.value = +e.target.value; it.onChange && it.onChange(it.value); });
        panel.append(l);
      } else {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ui-button'; b.textContent = it.label;
        b.addEventListener('click', () => it.onClick && it.onClick());
        panel.append(b);
      }
    }
    if (here.about) {
      const about = document.createElement('p');
      about.className = 'ui-about'; about.textContent = here.about;
      if (items.length) {
        about.hidden = true;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ui-button'; b.textContent = 'about this piece';
        b.setAttribute('aria-expanded', 'false');
        b.addEventListener('click', () => { about.hidden = !about.hidden; b.setAttribute('aria-expanded', String(!about.hidden)); });
        panel.append(b);
      }
      panel.append(about);
    }
    // With no controls of its own, the toggle opens the piece's about text directly.
    toggle.hidden = !items.length && !here.about;
    paintToggle();
  };
  const paintToggle = () => {
    toggle.lastElementChild.textContent = !panel.hidden ? 'close' : items.length ? 'controls' : 'about';
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  };
  toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; paintToggle(); });
  renderPanel();

  /* ---- hint & message ---- */
  let msgTimer = 0;
  const ui = {
    root,
    isUiTarget,
    /** Set the hint's text; `touch` replaces it on touch screens. Shown with showHint(true). */
    hint(text, { touch } = {}) { hintEl.textContent = (TOUCH && touch) || text || ''; return ui; },
    showHint(on) { root.classList.toggle('has-hint', !!on); return ui; },
    /** A transient status line. duration in seconds; 0 keeps it until message(null). */
    message(text, { duration = 0 } = {}) {
      clearTimeout(msgTimer);
      if (!text) { root.classList.remove('has-message'); return ui; }
      msgEl.textContent = text;
      root.classList.add('has-message');
      if (duration > 0) msgTimer = setTimeout(() => root.classList.remove('has-message'), duration * 1000);
      return ui;
    },
    /** 'dark' = light ink for dark art (default), 'light' = dark ink for bright art. */
    tone(t) { root.dataset.tone = t === 'light' ? 'light' : 'dark'; return ui; },
    /** Replace the piece's controls: [{ type: 'toggle'|'range'|'button', label, value, onChange|onClick }]. */
    controls(list) { items = list || []; renderPanel(); return ui; },
    /** Fade the chrome in after mountUI({ hidden: true }). */
    reveal() {
      if (!root.classList.contains('is-hidden')) return ui;
      root.classList.add('is-revealing'); root.classList.remove('is-hidden');
      setTimeout(() => root.classList.remove('is-revealing'), 4000);
      wake();
      return ui;
    },
  };
  return ui;
}
