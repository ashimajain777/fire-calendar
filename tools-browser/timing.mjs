// Query timings on the deployed app: page load, cold first query, then warm runs for a district-sized box and
// for all of India (one warm-up, then 3 timed runs each, in a fresh browser context per area).
// node tools-browser/timing.mjs [site] [out-json]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const site = process.argv[2] || 'https://ashimajain777.github.io/fire-calendar/';
const outFile = process.argv[3] || 'work/timing.json';
const AREAS = { district: [75.5, 30.5, 76.5, 31.5], india: [68, 6, 98, 38] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const out = { site, when: new Date().toISOString() };
for (const [name, bbox] of Object.entries(AREAS)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const t0 = Date.now();
  await page.goto(site + '?t=' + Date.now(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.fireCalendar && !document.body.textContent.includes('Loading data…'), null, { timeout: 120000 });
  const loadMs = Date.now() - t0;
  const runs = [];
  for (let i = 0; i < 4; i++) {
    runs.push(await page.evaluate(async (b) => {
      const t = performance.now();
      await window.fireCalendar.setArea(b);
      const c = window.fireCalendar.getContext();
      return { ms: Math.round(performance.now() - t), queryMs: Math.round(c.queryMs), cells: c.area.ids.length };
    }, bbox));
  }
  out[name] = { loadMs, cold: runs[0], warm: runs.slice(1), errors };
  console.log(`${name}: load ${loadMs} ms, cold ${runs[0].ms} ms (query ${runs[0].queryMs}), warm ${runs.slice(1).map((r) => `${r.ms} (query ${r.queryMs})`).join(' / ')} ms, cells ${runs[0].cells}, errors ${errors.length}`);
  await ctx.close();
}
writeFileSync(outFile, JSON.stringify(out, null, 1));
await browser.close();
