// Live smoke checks of the round-2 features on the deployed site: Compare (B1) and exposure KPI (B3),
// plus Timelapse (B2) and Climate (B4) when their tabs exist. node tools-browser/features.mjs [site] [out-json]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const site = process.argv[2] || 'https://ashimajain777.github.io/fire-calendar/';
const outFile = process.argv[3] || 'work/features.json';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(site + '?t=' + Date.now(), { waitUntil: 'load' });
await page.waitForFunction(() => window.fireCalendar && !document.body.textContent.includes('Loading data…'), null, { timeout: 120000 });
const out = { errors };
const single = async (bbox) => page.evaluate(async (x) => { await window.fireCalendar.setArea(x); return window.fireCalendar.getContext().calendarRows.reduce((s, r) => s + r.value, 0); }, bbox);
const PUNJAB = [73.8, 29.5, 77.5, 32.5];
const UK = [77.5, 28.7, 81.1, 31.5];

// B3 exposure KPI
await single(PUNJAB);
await page.waitForFunction(() => { const v = document.querySelector('#kpi-exposure .kpi-value'); return v && v.textContent && v.textContent !== '…'; }, null, { timeout: 60000 });
out.exposure = await page.evaluate(() => ({ value: document.querySelector('#kpi-exposure .kpi-value').textContent, note: document.querySelector('#kpi-exposure .kpi-note').textContent }));
console.log('exposure:', JSON.stringify(out.exposure));

// B1 compare: A = Punjab (main), B = Uttarakhand; then swap
const ukTotal = await single(UK);
const pjTotal = await single(PUNJAB);
const compare = async (bbox) => {
  await page.getByRole('tab', { name: 'Compare' }).click();
  for (const [id, v] of [['cmp-w', bbox[0]], ['cmp-s', bbox[1]], ['cmp-e', bbox[2]], ['cmp-n', bbox[3]]]) await page.fill(`#${id}`, String(v));
  await page.locator('#cmp-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#cmp-out table').length > 0 && !document.querySelector('#cmp-out [aria-busy="true"]'), null, { timeout: 90000 });
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const legends = [...document.querySelectorAll('#panel-compare .legend')].map((l) => l.textContent.replace(/\s+/g, ' ').trim());
    const rows = [...document.querySelectorAll('#cmp-out table tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
    return { legends, firstRows: rows.slice(0, 3), calendars: document.querySelectorAll('#panel-compare table.cal-table').length };
  });
};
const ab = await compare(UK);
await single(UK);
const ba = await compare(PUNJAB);
out.compare = { punjabSingle: Math.round(pjTotal), uttarakhandSingle: Math.round(ukTotal), ab, ba };
console.log('compare A=Punjab B=UK:', JSON.stringify(ab.firstRows), 'calendars', ab.calendars, 'legends equal', new Set(ab.legends).size <= 1);
console.log('compare A=UK B=Punjab:', JSON.stringify(ba.firstRows));

// B2 timelapse (if present)
if (await page.getByRole('tab', { name: 'Timelapse' }).count()) {
  await single(PUNJAB);
  await page.getByRole('tab', { name: 'Timelapse' }).click();
  await page.fill('#tl-from', '2025-10-01');
  await page.fill('#tl-to', '2025-11-30');
  await page.selectOption('#tl-step', 'day');
  const t0 = Date.now();
  await page.getByRole('button', { name: /^Load/ }).click();
  await page.waitForFunction(() => /so far/.test(document.querySelector('.tl-count')?.textContent || ''), null, { timeout: 120000 });
  const loadMs = Date.now() - t0;
  await page.focus('#tl-scrub');
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  const last = await page.evaluate(() => document.querySelector('.tl-count').textContent);
  const expected = await page.evaluate(async () => { const q = await import('./queries.js'); const c = window.fireCalendar.getContext(); return q.pointsCount(c.db, c.area, { from: '2025-10', to: '2025-11' }, c.cats); });
  const soFar = Number((last.match(/([\d,]+) so far/) || [])[1]?.replace(/,/g, ''));
  out.timelapse = { loadMs, lastFrameText: last, frameSum: soFar, pointsCount: expected, match: soFar === expected };
  console.log('timelapse:', JSON.stringify(out.timelapse));
}
// B4 climate (if present)
out.climatePanel = await page.evaluate(() => !!document.querySelector('#climate-panel'));
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('console errors:', errors.length, errors.slice(0, 3));
await b.close();
