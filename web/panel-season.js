// Season tab: typical onset, peak and end of the fire season, and how each year compares.
// See docs/PLAN.md section 9 F3. Pure helpers are exported and unit-tested; DOM code runs only in a browser.

import { season, median, dekadToDateLabel } from './stats.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ORDINALS = ['first', 'second', 'third', 'fourth'];
const BADGES = {
  early: { icon: '◀', word: 'early' },
  late: { icon: '▶', word: 'late' },
  longer: { icon: '＋', word: 'longer' },
  shorter: { icon: '－', word: 'shorter' },
  incomplete: { icon: '…', word: 'incomplete' },
  none: { icon: '○', word: 'no fires' },
};
const UNIT = { harm_n: 'hotspots', harm_fd: 'fire-days' };

export function seasonSentence(s) {
  if (!s || s.status !== 'ok') return 'Not enough fires in this area to define a season.';
  const d = dekadToDateLabel;
  const extra = (s.secondary || []).map((x) => ` Secondary peak: ${d(x.from)} to ${d(x.to)}, ${Math.round(x.share * 100)} % of the year.`).join('');
  if (!s.twoSeasons) return `Fire season here typically runs from ${d(s.onset)} to ${d(s.end)} and peaks around ${d(s.peak)} (±10 days).${extra}`;
  const count = ['two', 'three', 'four'][s.peaks.length - 2] || String(s.peaks.length);
  return [
    `This area has ${count} fire seasons in a typical year.`,
    ...s.peaks.map((p, i) => `The ${ORDINALS[i] || `${i + 1}th`} peaks around ${d(p)} (±10 days).`),
    `Taken together, 80 % of a typical year's fires fall between ${d(s.onset)} and ${d(s.end)}.`,
  ].join(' ') + extra;
}

// Median per dekad (36 values) over the base years; a base year with no rows counts as zero.
export function climatology(dekadRows, baseYears) {
  const byYear = new Map(baseYears.map((y) => [y, new Array(36).fill(0)]));
  for (const r of dekadRows) {
    const a = byYear.get(r.year);
    if (a) a[(r.month - 1) * 3 + r.dekad - 1] += r.value;
  }
  return Array.from({ length: 36 }, (_, i) => median([...byYear.values()].map((a) => a[i])) ?? 0);
}

// Everything the strip draws, on an axis of 36 dekads that begins at the season's circular start (k = 0..35),
// so a season crossing New Year is one bar. Rows are newest first.
export function seasonBars(s, clim) {
  if (!s || s.status !== 'ok') return null;
  const k = (dekad) => (dekad - s.start + 36) % 36;
  const axis = Array.from({ length: 36 }, (_, i) => (s.start + i) % 36);
  const months = [];
  for (const dekad of axis) {
    const name = MONTHS[Math.floor(dekad / 3)];
    const last = months[months.length - 1];
    if (last && last.name === name) last.span++;
    else months.push({ name, span: 1 });
  }
  const top = Math.max(...clim);
  const mark = (dekad) => ({ k: k(dekad), label: dekadToDateLabel(dekad) });
  // A season-year starts at `start` in calendar year `year`; name it by the calendar year(s) the typical season falls in.
  const newYear = 36 - s.start; // axis position of 1–10 Jan of the next calendar year (36: never)
  const label = (year) => {
    if (k(s.end) < newYear) return String(year);
    if (k(s.onset) >= newYear) return String(year + 1);
    return `${year}–${String((year + 1) % 100).padStart(2, '0')}`;
  };
  return {
    axis, months,
    clim: axis.map((dekad) => ({ dekad, value: clim[dekad], share: top > 0 ? clim[dekad] / top : 0, label: dekadToDateLabel(dekad) })),
    onset: mark(s.onset), peak: mark(s.peak), end: mark(s.end), peaks: s.peaks.map(mark),
    rows: [...s.years].sort((a, b) => b.year - a.year).map((y) => {
      const measured = y.onset !== null;
      const badges = measured ? y.flags.map((f) => BADGES[f]).filter(Boolean) : [y.complete === false ? BADGES.incomplete : BADGES.none];
      return {
        year: y.year, label: label(y.year), from: measured ? k(y.onset) : null, to: measured ? k(y.end) : null, length: y.length, badges,
        text: measured ? `${dekadToDateLabel(y.onset)} to ${dekadToDateLabel(y.end)}` : badges[0].word,
      };
    }),
  };
}

// Rows of the "Show table" view, newest first.
export function seasonTable(s) {
  const bars = seasonBars(s, new Array(36).fill(0));
  if (!bars) return [];
  return bars.rows.map((r) => {
    const measured = r.from !== null;
    return {
      year: r.label,
      onset: measured ? dekadToDateLabel(bars.axis[r.from]) : '—',
      end: measured ? dekadToDateLabel(bars.axis[r.to]) : '—',
      length: measured ? `${r.length} ${r.length === 1 ? 'dekad' : 'dekads'} (about ${r.length * 10} days)` : '—',
      flags: r.badges.map((b) => b.word).join(', ') || '—',
    };
  });
}

const fmt = (v) => (v < 10 && !Number.isInteger(v)
  ? v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  : Math.round(v).toLocaleString('en-US'));

// ---------- DOM ----------

// Grid columns: label, 36 dekads, badges. Column of axis position k is k + 2.
const CSS = `
.ssn-stack { display: flex; flex-direction: column; gap: 12px; }
.ssn-lead { font-size: 18px; max-width: 70ch; }
.ssn-scroll { overflow-x: auto; padding: 4px; }
.ssn-inner { min-width: 860px; }
.ssn-row { display: grid; grid-template-columns: 72px repeat(36, minmax(0, 1fr)) 176px; align-items: center; }
.ssn-chart { grid-auto-rows: 22px; align-items: stretch; }
.ssn-months > *, .ssn-name { font-size: 12px; color: var(--ink-2); }
.ssn-months > * { border-left: 1px solid var(--line); padding-left: 4px; }
.ssn-name { padding-right: 8px; text-align: right; align-self: end; }
.ssn-bar { align-self: end; margin: 0 1px; min-height: 1px; background: var(--seq-4); border-radius: 2px 2px 0 0; }
.ssn-base { border-top: 1px solid var(--line); }
.ssn-mark { z-index: 1; width: 0; border-left: 2px solid var(--ink); pointer-events: none; }
.ssn-mark--onset { justify-self: start; }
.ssn-mark--peak { justify-self: center; border-left-style: dashed; }
.ssn-mark--end { justify-self: end; border-left-style: dotted; }
.ssn-tag { z-index: 2; padding: 0 6px; font-size: 13px; font-weight: 600; line-height: 22px; white-space: nowrap; }
.ssn-years { margin: 8px 0 0; padding: 0; list-style: none; }
.ssn-years li { min-height: 24px; border-top: 1px solid color-mix(in srgb, var(--line) 50%, transparent); }
.ssn-year { grid-row: 1; grid-column: 1; padding-right: 8px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
.ssn-band { grid-row: 1; align-self: stretch; background: var(--panel); }
.ssn-span { grid-row: 1; height: 12px; background: var(--seq-5); border-radius: 6px; }
.ssn-badges { grid-row: 1; grid-column: 38; display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 0 2px 8px; }
.ssn-badge { display: inline-flex; gap: 4px; padding: 0 6px; border: 1px solid var(--ink-2); border-radius: 999px; font-size: 12px; line-height: 18px; white-space: nowrap; }
.ssn-table { overflow-x: auto; }
@media (forced-colors: active) { .ssn-bar, .ssn-span { forced-color-adjust: none; } }
`;

function start() {
  const panel = document.getElementById('panel-season');
  if (!panel) return;
  const h = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  };
  document.head.append(h('style', null, CSS));
  let tableOpen = false;

  function strip(bars, ctx) {
    const col = (k, span = 1) => `grid-column: ${k + 2} / span ${span};`;
    // month labels, one row of text per marker, then the bars
    const markers = [['onset', 'Onset', bars.onset], ...bars.peaks.map((p) => ['peak', 'Peak', p]), ['end', 'End', bars.end]];
    const barsRow = markers.length + 2;
    let at = 0;
    const months = bars.months.map((m) => {
      const node = h('span', { style: `${col(at, m.span)} grid-row: 1;` }, m.span > 1 ? m.name : '');
      at += m.span;
      return node;
    });
    const chart = h('div', { class: 'ssn-row ssn-chart', style: `grid-template-rows: repeat(${markers.length + 1}, 22px) 120px;` },
      h('div', { class: 'ssn-months', style: 'display: contents' }, ...months),
      ...markers.flatMap(([kind, word, m], i) => {
        const left = m.k < 22;
        return [
          h('span', { class: 'ssn-tag', style: `grid-row: ${i + 2}; ${left ? `grid-column: ${m.k + 2} / -1; justify-self: start;` : `grid-column: 1 / ${m.k + 3}; justify-self: end;`}` }, `${word} ${m.label}`),
          h('span', { class: `ssn-mark ssn-mark--${kind}`, style: `${col(m.k)} grid-row: ${i + 2} / ${barsRow + 1};`, 'aria-hidden': 'true' }),
        ];
      }),
      h('span', { class: 'ssn-name', style: `grid-column: 1; grid-row: ${barsRow};` }, 'Typical'),
      ...bars.clim.map((c, k) => h('span', {
        class: 'ssn-bar', style: `${col(k)} grid-row: ${barsRow}; height: ${(c.share * 100).toFixed(1)}%;`, title: `${c.label}: ${fmt(c.value)} ${UNIT[ctx.metric]} in a typical year`,
      })));
    const years = h('ul', { class: 'ssn-years', 'aria-label': 'Season by year, newest first' }, ...bars.rows.map((r) => h('li', { class: 'ssn-row' },
      h('span', { class: 'ssn-year' }, r.label, h('span', { class: 'visually-hidden' }, `: ${r.text}${r.from === null ? '' : `, ${r.length * 10} days`}`)),
      h('span', { class: 'ssn-band', style: `grid-column: ${bars.onset.k + 2} / ${bars.end.k + 3};`, 'aria-hidden': 'true' }),
      r.from === null ? '' : h('span', { class: 'ssn-span', style: `grid-column: ${r.from + 2} / ${r.to + 3};`, title: `${r.label}: ${r.text}` }),
      h('span', { class: 'ssn-badges' }, ...r.badges.map((b) => h('span', { class: 'ssn-badge' }, h('span', { 'aria-hidden': 'true' }, b.icon), b.word))))));
    return h('div', { class: 'ssn-scroll', role: 'group', tabindex: '0', 'aria-label': 'Typical fire season by 10-day period, and the season of each year' },
      h('div', { class: 'ssn-inner' }, chart, h('div', { class: 'ssn-base' }), years));
  }

  function table(rows) {
    const columns = [['year', 'Year'], ['onset', 'Onset'], ['end', 'End'], ['length', 'Length'], ['flags', 'Flags']];
    return h('table', { class: 'data-table' },
      h('caption', { class: 'visually-hidden' }, 'Fire season by year'),
      h('thead', null, h('tr', null, ...columns.map(([, name]) => h('th', { scope: 'col' }, name)))),
      h('tbody', null, ...rows.map((r) => h('tr', null, ...columns.map(([key], i) => h(i ? 'td' : 'th', i ? null : { scope: 'row' }, r[key]))))));
  }

  function render(ctx) {
    const s = season(ctx.dekadRows, ctx.baseYears, { firstDataDate: ctx.meta.coverage_start, lastDataDate: ctx.lastDataDate });
    const lead = h('p', { class: 'ssn-lead' }, seasonSentence(s));
    const clim = climatology(ctx.dekadRows, ctx.baseYears);
    const bars = seasonBars(s, clim);
    if (!bars) return panel.replaceChildren(lead);
    const span = `${ctx.baseYears[0]}–${ctx.baseYears[ctx.baseYears.length - 1]}`;
    const tableWrap = h('div', { class: 'ssn-table', id: 'ssn-table' }, table(seasonTable(s)));
    tableWrap.hidden = !tableOpen;
    const toggle = h('button', { type: 'button', class: 'btn', 'aria-expanded': String(tableOpen), 'aria-controls': 'ssn-table' }, tableOpen ? 'Hide table' : 'Show table');
    toggle.addEventListener('click', () => {
      tableOpen = !tableOpen;
      tableWrap.hidden = !tableOpen;
      toggle.setAttribute('aria-expanded', String(tableOpen));
      toggle.textContent = tableOpen ? 'Hide table' : 'Show table';
    });
    return panel.replaceChildren(h('div', { class: 'ssn-stack' },
      lead,
      h('p', { class: 'hint' }, `Blue bars: ${UNIT[ctx.metric]} per 10-day period in a typical year (median of ${span}); the tallest bar is ${fmt(Math.max(...clim))}. `
        + 'Onset and end are where a year reaches 10 % and 90 % of its fires. The shaded band in each year row is the typical season; the bar is that year. '
        + 'A year is flagged early or late when its onset, and longer or shorter when its length, falls outside the middle half of the base years.'),
      strip(bars, ctx),
      h('div', null, toggle),
      tableWrap));
  }

  document.addEventListener('fc:results', (e) => render(e.detail));
  document.addEventListener('fc:error', () => panel.replaceChildren());
}

if (typeof document !== 'undefined') start();
