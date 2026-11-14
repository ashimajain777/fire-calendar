// Timelapse tab: hotspots day by day or week by week over a chosen window, drawn on the map.
// A year's points file is downloaded whole (up to ~34 MB), so the window is capped and loads only on the Load button.
// Pure helpers are exported and unit-tested; DOM code runs only in a browser.

import { timelapsePoints } from './queries.js';
import { showFrame, MAX_POINTS } from './map.js';

export const MAX_DAYS = 366;
const STEP_DAYS = { day: 1, week: 7 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BASE_MS = 1000; // one frame per second at 1x

const DAY = 86400000;
const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const addDays = (iso, n) => new Date(ms(iso) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / DAY);

// "8 Nov 2026"; "8–14 Nov 2026"; "29 Oct – 4 Nov 2026"; "29 Dec 2025 – 4 Jan 2026"
export function frameLabel(from, to = from) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  if (from === to) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 !== y2) return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
  if (m1 !== m2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
  return `${d1}–${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

// Frames from start to end inclusive; weeks start on the window start date and the last one ends at end.
// Empty frames are kept. Rows outside the window are left out.
export function framesFrom(rows, start, end, step) {
  const size = STEP_DAYS[step];
  if (!size) throw new TypeError(`Unknown step ${step}`);
  const span = daysBetween(start, end) + 1;
  if (!(span >= 1)) throw new RangeError('The window end is before its start');
  const frames = [];
  for (let i = 0; i * size < span; i++) {
    const t = addDays(start, i * size);
    const last = addDays(start, Math.min((i + 1) * size, span) - 1);
    frames.push({ t, end: last, label: frameLabel(t, last), points: [] });
  }
  for (const r of rows) {
    const d = String(r.acq_date).slice(0, 10);
    if (d >= start && d <= end) frames[Math.floor(daysBetween(start, d) / size)].points.push(r);
  }
  return frames;
}

// Next frame while playing, or null at the end (playback stops there).
export const nextFrame = (i, n) => (i + 1 < n ? i + 1 : null);

// Message for an invalid window, or null. Dates are YYYY-MM-DD strings.
export function windowError(from, to, coverage) {
  if (!from || !to) return 'Enter both a start and an end date.';
  if (from > to) return 'The end date is before the start date.';
  if (from < coverage.start || to > coverage.end) return `Dates must be between ${frameLabel(coverage.start)} and ${frameLabel(coverage.end)}.`;
  if (daysBetween(from, to) + 1 > MAX_DAYS) return `The window is ${daysBetween(from, to) + 1} days; the limit is ${MAX_DAYS}.`;
  return null;
}

// ---------- DOM ----------

const CSS = `
.tl-stack { display: flex; flex-direction: column; gap: 12px; }
.tl-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.tl-scrub { flex: 1 1 240px; }
.tl-scrub input { width: 100%; min-height: var(--control-h); accent-color: var(--action); }
.tl-label { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tl-count { font-variant-numeric: tabular-nums; }
.tl-bars { display: flex; align-items: flex-end; gap: 1px; height: 48px; border-bottom: 1px solid var(--line); }
.tl-bars > span { flex: 1 1 0; min-width: 1px; background: color-mix(in srgb, var(--action) 45%, transparent); }
.tl-bars > span.tl-now { background: var(--ink); }
@media (forced-colors: active) { .tl-bars > span { forced-color-adjust: none; } }
`;

function start() {
  const panel = document.getElementById('panel-timelapse');
  if (!panel) return;
  const h = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  };
  const fmt = (n) => n.toLocaleString('en-US');
  const errorText = (e) => (e && e.message ? e.message : String(e));
  document.head.append(h('style', null, CSS));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let ctx = null;      // the fc:results context the controls were built for
  let loaded = null;   // { frames, cum, i, cut }
  let timer = null;
  let seq = 0;

  const fromIn = h('input', { type: 'date', id: 'tl-from' });
  const toIn = h('input', { type: 'date', id: 'tl-to' });
  const stepSel = h('select', { id: 'tl-step' }, h('option', { value: 'day' }, 'Day'), h('option', { value: 'week' }, 'Week'));
  const loadBtn = h('button', { type: 'button', class: 'btn btn--primary' }, 'Load');
  const status = h('div', { role: 'status' });
  const player = h('div', { class: 'tl-stack', hidden: '' });

  const playBtn = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false' }, 'Play');
  const prevBtn = h('button', { type: 'button', class: 'btn' }, 'Previous');
  const nextBtn = h('button', { type: 'button', class: 'btn' }, 'Next');
  const scrub = h('input', { type: 'range', id: 'tl-scrub', min: '0', step: '1', value: '0' });
  const speedSel = h('select', { id: 'tl-speed' }, ...[1, 2, 4].map((s) => h('option', { value: String(s) }, `${s}×`)));
  const label = h('div', { class: 'tl-label' });
  const count = h('div', { class: 'tl-count', 'aria-live': 'polite' });
  const cutNote = h('p', { class: 'notice', hidden: '' });
  const bars = h('div', { class: 'tl-bars', 'aria-hidden': 'true' });
  const motionNote = h('p', { class: 'hint' });
  player.append(
    h('div', { class: 'tl-row' }, playBtn, prevBtn, nextBtn,
      h('label', { class: 'field tl-scrub' }, 'Frame', scrub),
      h('label', { class: 'field' }, 'Speed', speedSel)),
    motionNote, label, count, cutNote,
    h('div', null, h('div', { class: 'muted' }, 'Hotspots per frame (current frame dark)'), bars));

  panel.replaceChildren(h('div', { class: 'tl-stack' },
    h('p', null, `Watch hotspots appear on the map frame by frame. Choose a window of up to ${MAX_DAYS} days and press Load: each year of hotspots is a large download (tens of MB), so nothing loads until you ask.`),
    h('div', { class: 'tl-row' },
      h('label', { class: 'field' }, 'Start date', fromIn),
      h('label', { class: 'field' }, 'End date', toIn),
      h('label', { class: 'field' }, 'Step', stepSel),
      loadBtn),
    status, player));

  const say = (text, error) => status.replaceChildren(text ? h('p', { class: `notice${error ? ' notice--error' : ''}` }, text) : '');

  function pause() {
    clearTimeout(timer);
    timer = null;
    playBtn.textContent = 'Play';
    playBtn.setAttribute('aria-pressed', 'false');
    count.setAttribute('aria-live', 'polite');
  }

  function syncMotion() {
    if (reduced.matches) pause();
    playBtn.disabled = reduced.matches;
    motionNote.textContent = reduced.matches
      ? 'Automatic playback is off because your device asks for reduced motion. Step through the frames with Previous, Next or the Frame slider (arrow keys).'
      : 'Play advances one frame per second at 1×. Use Previous, Next or the Frame slider (arrow keys) to step.';
  }

  async function show(i) {
    const { frames, cum } = loaded;
    const f = frames[i];
    loaded.i = i;
    scrub.value = String(i);
    scrub.setAttribute('aria-valuetext', f.label);
    label.textContent = f.label;
    count.textContent = `${fmt(f.points.length)} ${f.points.length === 1 ? 'hotspot' : 'hotspots'} in this frame · ${fmt(cum[i])} so far`;
    cutNote.hidden = f.points.length <= MAX_POINTS;
    cutNote.textContent = cutNote.hidden ? '' : `This frame has ${fmt(f.points.length)} hotspots; the map draws the first ${fmt(MAX_POINTS)}.`;
    for (const [k, b] of [...bars.children].entries()) b.classList.toggle('tl-now', k === i);
    const caption = document.getElementById('map-caption');
    if (caption) caption.textContent = `Map shows the timelapse frame ${f.label}.`;
    await showFrame(f.points);
  }

  function tick() {
    const mine = loaded;
    const n = nextFrame(mine.i, mine.frames.length);
    if (n === null) return pause();
    // the next tick waits for the map to draw, so slow frames never pile up
    return show(n).then(() => {
      if (timer && loaded === mine) timer = setTimeout(tick, BASE_MS / Number(speedSel.value));
    }).catch((e) => { pause(); say(`Couldn't draw the frame on the map. ${errorText(e)}`, true); });
  }

  function play() {
    if (!loaded || reduced.matches) return;
    playBtn.textContent = 'Pause';
    playBtn.setAttribute('aria-pressed', 'true');
    count.setAttribute('aria-live', 'off'); // no announcement every second while playing
    if (loaded.i === loaded.frames.length - 1) show(0).catch((e) => say(errorText(e), true)); // play again from the start
    timer = setTimeout(tick, BASE_MS / Number(speedSel.value));
  }

  const step = (i) => { pause(); if (loaded) show(i).catch((e) => say(errorText(e), true)); };

  function reset(c) {
    pause();
    seq++;
    ctx = c;
    loaded = null;
    player.hidden = true;
    say('');
    loadBtn.disabled = !c;
    if (!c) return;
    const { coverage_start: min, coverage_end: max } = c.meta;
    for (const el of [fromIn, toIn]) { el.min = min; el.max = max; }
    // keep dates the user typed; default to the last 90 days of data
    if (windowError(fromIn.value, toIn.value, { start: min, end: max })) {
      toIn.value = max;
      fromIn.value = addDays(max, -89) < min ? min : addDays(max, -89);
    }
  }

  async function load() {
    const c = (window.fireCalendar && window.fireCalendar.getContext()) || ctx;
    if (!c) return say('Choose an area first.', true);
    const from = fromIn.value;
    const to = toIn.value;
    const bad = windowError(from, to, { start: c.meta.coverage_start, end: c.meta.coverage_end });
    if (bad) return say(bad, true);
    pause();
    const mine = ++seq;
    loaded = null;
    player.hidden = true;
    loadBtn.disabled = true;
    say(`Loading hotspots for ${frameLabel(from, to)}…`);
    const t0 = performance.now();
    try {
      const rows = await timelapsePoints(c.db, c.area, { from, to }, c.cats);
      if (mine !== seq) return undefined;
      const frames = framesFrom(rows, from, to, stepSel.value);
      const cum = [];
      frames.reduce((t, f, k) => (cum[k] = t + f.points.length), 0);
      const most = Math.max(1, ...frames.map((f) => f.points.length));
      bars.replaceChildren(...frames.map((f) => h('span', { style: `height:${(f.points.length / most) * 100}%` })));
      scrub.max = String(frames.length - 1);
      loaded = { frames, cum, i: 0 };
      player.hidden = false;
      syncMotion();
      say(`Loaded ${fmt(rows.length)} hotspots in ${frames.length} ${stepSel.value === 'day' ? 'daily' : 'weekly'} frames (${((performance.now() - t0) / 1000).toFixed(1)} s). All confidence levels, selected categories.`);
      await show(0);
    } catch (e) {
      if (mine === seq) { loaded = null; player.hidden = true; say(`Couldn't load the timelapse. ${errorText(e)}`, true); }
    } finally {
      if (mine === seq) loadBtn.disabled = false;
    }
    return undefined;
  }

  loadBtn.addEventListener('click', load);
  playBtn.addEventListener('click', () => (timer ? pause() : play()));
  prevBtn.addEventListener('click', () => loaded && step(Math.max(0, loaded.i - 1)));
  nextBtn.addEventListener('click', () => loaded && step(Math.min(loaded.frames.length - 1, loaded.i + 1)));
  scrub.addEventListener('input', () => step(Number(scrub.value)));
  speedSel.addEventListener('change', () => { if (timer) { pause(); play(); } });
  reduced.addEventListener('change', syncMotion);
  // leaving the tab (it gets hidden) or the browser tab stops the timer
  new MutationObserver(() => { if (panel.hidden) pause(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // new results (a new area, categories or dates) clear the map, so the timelapse starts over; it never reloads by itself
  document.addEventListener('fc:results', (e) => reset(e.detail));
  document.addEventListener('fc:loading', pause);
  document.addEventListener('fc:error', () => reset(null));
  syncMotion();
  reset(window.fireCalendar ? window.fireCalendar.getContext() : null);
}

if (typeof document !== 'undefined') start();
