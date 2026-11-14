// Browser side of the cross-check: loads the deployed app headless, selects each area through the
// app's own API and records what the app computes. Compares with pipeline/crosscheck.py output.
// node tools-browser/crosscheck.mjs <site-url> <python-json> <out-json>
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [site = 'https://ashimajain777.github.io/fire-calendar/', pyFile = 'work/crosscheck_py.json', outFile = 'work/crosscheck.json'] = process.argv.slice(2);
const py = JSON.parse(readFileSync(pyFile, 'utf8'));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

const t0 = Date.now();
await page.goto(site + '?nocache=' + Date.now(), { waitUntil: 'load' });
// ready when setArea stops throwing "The page is still loading" (coverage loaded)
await page.waitForFunction(() => { try { window.fireCalendar.setArea; return !document.body.textContent.includes('Loading data…'); } catch { return false; } }, null, { timeout: 90000 });
const firstLoadMs = Date.now() - t0;

const rows = [];
for (const [name, ref] of Object.entries(py)) {
  const r = await page.evaluate(async (bbox) => {
    const q = await import('./queries.js');
    const t = performance.now();
    await window.fireCalendar.setArea(bbox);
    const c = window.fireCalendar.getContext();
    const ms = performance.now() - t;
    const harm = c.calendarRows.reduce((s, x) => s + x.value, 0);
    const raw = c.calendarRows.reduce((s, x) => s + x.raw, 0);
    const top = [...c.calendarRows].sort((a, b) => b.value - a.value)[0];
    const pts = await q.pointsCount(c.db, c.area, c.range, [0, 1, 2, 3, 4, 5, 6, 7]);
    const fd = await q.fireDaysBase(c.db, c.area, c.range, [0, 1, 2, 3]);
    return { cells: c.area.ids.length, harm, raw, points_all: pts, fire_days: fd, top: [top.year, top.month, top.value], ms, range: c.range };
  }, ref.bbox);
  const eq = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  const ok = r.cells === ref.cells && Math.abs(r.harm - ref.harm_landscape) <= 0.051 && r.raw === ref.raw_landscape && r.points_all === ref.points_all && r.fire_days === ref.fire_days_landscape
    && r.top[0] === ref.top_month[0] && r.top[1] === ref.top_month[1];
  rows.push({ name, ok, browser: { ...r, harm: Math.round(r.harm * 10) / 10, top: [r.top[0], r.top[1], Math.round(r.top[2] * 10) / 10], ms: Math.round(r.ms) }, python: ref });
  console.log(`${ok ? 'MATCH' : 'DIFF '} ${name.padEnd(16)} cells ${r.cells}/${ref.cells}  harm ${Math.round(r.harm)}/${Math.round(ref.harm_landscape)}  raw ${r.raw}/${ref.raw_landscape}  points ${r.points_all}/${ref.points_all}  fire-days ${r.fire_days}/${ref.fire_days_landscape}  top ${r.top[0]}-${r.top[1]}/${ref.top_month[0]}-${ref.top_month[1]}  ${Math.round(r.ms)} ms`);
}
writeFileSync(outFile, JSON.stringify({ site, firstLoadMs, rows, errors }, null, 1));
console.log(`first load ${firstLoadMs} ms; console errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log('  ', e));
await browser.close();
process.exit(rows.every((r) => r.ok) && !errors.length ? 0 : 1);
