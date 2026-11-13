// Statistics. Pure: no imports, no DOM. Definitions: docs/PLAN.md section 7 and 9 F3, docs/CONTRACTS.md section 6.

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const asc = (xs) => [...xs].sort((a, b) => a - b);

// Linear-interpolation quantile of an ascending array (p in 0..1).
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(xs) {
  return quantile(asc(xs), 0.5);
}

export function percentileRank(x, base) {
  if (!base.length) return null;
  let below = 0;
  let equal = 0;
  for (const b of base) {
    if (b < x) below++;
    else if (b === x) equal++;
  }
  return ((below + 0.5 * equal) / base.length) * 100;
}

export function zScore(x, base) {
  const n = base.length;
  if (n < 5) return null;
  const mean = sum(base) / n;
  const sd = Math.sqrt(sum(base.map((b) => (b - mean) ** 2)) / (n - 1));
  return sd === 0 ? null : (x - mean) / sd;
}

export function anomalyPct(x, base) {
  const m = median(base);
  return m === null || m === 0 ? null : ((x - m) / m) * 100;
}

// Percentile -> diverging bin. The grey middle is 40..60 inclusive; the arms mirror each other.
export function anomalyBin(pct) {
  if (pct <= 10) return 0;
  if (pct <= 25) return 1;
  if (pct < 40) return 2;
  if (pct <= 60) return 3;
  if (pct < 75) return 4;
  if (pct < 90) return 5;
  return 6;
}

export function monthToDate(dekadRows, lastDataDate, baseYears) {
  // UTC parts: FIRMS acquisition dates are UTC, and new Date('2026-11-05') is UTC midnight.
  let year = lastDataDate.getUTCFullYear();
  let month = lastDataDate.getUTCMonth() + 1;
  const day = lastDataDate.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let dekads = [10, 20, lastDay].flatMap((end, i) => (day >= end ? [i + 1] : []));
  const mode = dekads.length ? 'mtd' : 'last_month';
  if (!dekads.length) {
    dekads = [1, 2, 3];
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  const total = (y) => sum(dekadRows
    .filter((r) => r.year === y && r.month === month && dekads.includes(r.dekad))
    .map((r) => r.value));
  return {
    mode, year, month, dekads,
    current: total(year),
    base: baseYears.filter((y) => y !== year).map(total),
  };
}

export function rankings(calendarRows, n = 5) {
  const desc = (a, b) => b.value - a.value;
  const byYear = new Map();
  for (const r of calendarRows) byYear.set(r.year, (byYear.get(r.year) ?? 0) + r.value);
  return {
    months: calendarRows.filter((r) => r.value > 0)
      .map(({ year, month, value }) => ({ year, month, value })).sort(desc).slice(0, n),
    years: [...byYear].map(([year, value]) => ({ year, value })).filter((r) => r.value > 0).sort(desc).slice(0, n),
  };
}

// Offsets (from the first element) where the cumulative share first reaches 10 % and 90 %.
function window1090(series) {
  const total = sum(series);
  if (!(total > 0)) return null;
  let cum = 0;
  let onset = null;
  for (let k = 0; k < series.length; k++) {
    cum += series[k];
    if (onset === null && cum >= 0.1 * total - 1e-9) onset = k;
    if (cum >= 0.9 * total - 1e-9) return { onset, end: k };
  }
  return { onset, end: series.length - 1 };
}

// Clusters of dekads at or above 20 % of the peak, split by 3 or more consecutive dekads below it.
function clusters(clim, peakValue) {
  const active = (i) => clim[((i % 36) + 36) % 36] >= 0.2 * peakValue;
  let first = -1;
  for (let i = 0; i < 36 && first < 0; i++) {
    if (active(i) && !active(i - 1) && !active(i - 2) && !active(i - 3)) first = i;
  }
  if (first < 0) return [Array.from({ length: 36 }, (_, i) => i)];
  const out = [];
  let pending = [];
  for (let k = 0; k < 36; k++) {
    const i = (first + k) % 36;
    if (!active(i)) {
      pending.push(i);
    } else if (!out.length || pending.length >= 3) {
      out.push([i]);
      pending = [];
    } else {
      out[out.length - 1].push(...pending, i);
      pending = [];
    }
  }
  return out;
}

export function season(dekadRows, baseYears) {
  const none = { status: 'insufficient', start: null, onset: null, peak: null, end: null, twoSeasons: false, peaks: [], years: [] };
  const zeros = new Array(36).fill(0);
  const byYear = new Map();
  let lastPos = -Infinity; // year * 36 + dekad index of the newest row
  for (const r of dekadRows) {
    const i = (r.month - 1) * 3 + r.dekad - 1;
    if (!byYear.has(r.year)) byYear.set(r.year, [...zeros]);
    byYear.get(r.year)[i] += r.value;
    lastPos = Math.max(lastPos, r.year * 36 + i);
  }
  if (!baseYears.length) return none;
  const base = baseYears.map((y) => byYear.get(y) ?? zeros);
  if (sum(base.map(sum)) / base.length < 30) return none;
  const clim = zeros.map((_, i) => median(base.map((a) => a[i])));
  const peakValue = Math.max(...clim);
  if (!(peakValue > 0)) return none;

  const start = (clim.indexOf(Math.min(...clim)) + 1) % 36;
  const peak = clim.indexOf(peakValue);
  const fromStart = (k) => (start + k) % 36;
  const win = window1090(zeros.map((_, k) => clim[fromStart(k)]));

  const total = sum(clim);
  const big = clusters(clim, peakValue)
    .filter((c) => sum(c.map((i) => clim[i])) >= 0.25 * total)
    .sort((a, b) => ((a[0] - start + 36) % 36) - ((b[0] - start + 36) % 36));
  const twoSeasons = big.length >= 2;
  const peaks = twoSeasons ? big.map((c) => c.reduce((best, i) => (clim[i] > clim[best] ? i : best))) : [peak];

  // A season-year is the 36 dekads from `start`, labelled by the calendar year it starts in.
  // It is only measured when the data reaches its last dekad; a partial total would shift 10 % and 90 %.
  const years = [...byYear.keys()].sort((a, b) => a - b).map((year) => {
    const complete = year * 36 + start + 35 <= lastPos;
    const series = zeros.map((_, k) => (byYear.get(year + (start + k >= 36 ? 1 : 0)) ?? zeros)[fromStart(k)]);
    const w = complete ? window1090(series) : null;
    return { year, complete, off: w, length: w ? w.end - w.onset + 1 : null };
  });
  const baseSeasons = years.filter((y) => y.off && baseYears.includes(y.year));
  const q = (xs, p) => quantile(asc(xs), p);
  const onsets = baseSeasons.map((y) => y.off.onset);
  const lengths = baseSeasons.map((y) => y.length);

  return {
    status: 'ok', start, onset: fromStart(win.onset), peak, end: fromStart(win.end), twoSeasons, peaks,
    years: years.map(({ year, complete, off, length }) => {
      const flags = [];
      if (off && baseSeasons.length) {
        if (off.onset < q(onsets, 0.25)) flags.push('early');
        if (off.onset > q(onsets, 0.75)) flags.push('late');
        if (length > q(lengths, 0.75)) flags.push('longer');
        if (length < q(lengths, 0.25)) flags.push('shorter');
      }
      return { year, onset: off ? fromStart(off.onset) : null, end: off ? fromStart(off.end) : null, length, flags, complete };
    }),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function dekadToDateLabel(i) {
  const m = Math.floor(i / 3);
  const days = ['1–10', '11–20', `21–${MONTH_DAYS[m]}`][i % 3];
  return `${days} ${MONTHS[m]}`;
}
