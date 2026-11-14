// Checks two paths no other script covers. node tools-browser/paths.mjs [site] [out-json]
//  (a) retry: the first two requests for a dekad tile are aborted; the area query must still succeed.
//  (b) mouse drawing: a rectangle and a polygon drawn on the map give the same cells as their bounding box typed in the form.
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const site = process.argv[2] || 'https://ashimajain777.github.io/fire-calendar/';
const outFile = process.argv[3] || 'work/paths.json';
const PUNJAB = [73.8, 29.5, 77.5, 32.5];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const out = {};

async function open(ctx) {
  const page = await ctx.newPage();
  await page.goto(site + '?t=' + Date.now(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.fireCalendar && !document.body.textContent.includes('Loading data…'), null, { timeout: 120000 });
  return page;
}
const state = (page) => page.evaluate(() => {
  const c = window.fireCalendar.getContext();
  const alert = document.querySelector('#status [role="alert"]');
  return { ok: !!c, cells: c ? c.area.ids.length : null, geometry: c ? c.area.geometry : null, alert: alert ? alert.textContent : null };
});

// (a) retry
{
  const ctx = await browser.newContext();
  let aborted = 0;
  let served = 0;
  await ctx.route(/\/data\/dekad\/dekad_t\d+\.parquet/, (route) => {
    if (aborted < 2) { aborted++; return route.abort('failed'); }
    served++;
    return route.continue();
  });
  const page = await open(ctx);
  const t = Date.now();
  await page.evaluate((b) => window.fireCalendar.setArea(b).catch(() => {}), PUNJAB);
  const s = await state(page);
  out.retry = { aborted, served, queryOk: s.ok, cells: s.cells, alert: s.alert, ms: Date.now() - t };
  console.log('retry:', JSON.stringify(out.retry));
  await ctx.close();
}

// (b) mouse drawing vs the bounding-box form
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await open(ctx);
  const canvas = page.locator('#map canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500); // basemap settles
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const bboxOf = (g) => {
    const xs = g.coordinates[0].map((p) => p[0]);
    const ys = g.coordinates[0].map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const viaForm = async (b) => {
    for (const [id, v] of [['bb-w', b[0]], ['bb-s', b[1]], ['bb-e', b[2]], ['bb-n', b[3]]]) await page.fill(`#${id}`, String(v));
    await page.getByRole('button', { name: 'Use bounding box' }).click();
    await page.waitForFunction((n) => (window.fireCalendar.getContext()?.area.ids.length ?? -1) >= 0 && document.querySelector('#live').textContent.includes('Calendar updated'), null, { timeout: 60000 });
    return (await state(page)).cells;
  };
  const waitFor = async (prev) => page.waitForFunction((p) => {
    const c = window.fireCalendar.getContext();
    return c && JSON.stringify(c.area.geometry) !== p;
  }, prev, { timeout: 60000 });

  // rectangle: two clicks on opposite corners
  await page.getByRole('button', { name: 'Draw rectangle on map' }).click();
  await page.mouse.click(cx - 90, cy - 60);
  await page.mouse.click(cx + 90, cy + 60);
  await waitFor('null');
  const rect = await state(page);
  const rectBox = bboxOf(rect.geometry);
  const rectForm = await viaForm(rectBox);
  out.rectangle = { drawnCells: rect.cells, formCells: rectForm, bbox: rectBox.map((v) => +v.toFixed(4)), match: rect.cells === rectForm };
  console.log('rectangle:', JSON.stringify(out.rectangle));

  // polygon: four corner clicks, then Enter to finish (gl-draw)
  const before = JSON.stringify((await state(page)).geometry);
  await page.getByRole('button', { name: 'Draw polygon on map' }).click();
  for (const [dx, dy] of [[-70, -40], [70, -40], [70, 40], [-70, 40]]) { await page.mouse.click(cx + dx, cy + dy); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter');
  await waitFor(before);
  const poly = await state(page);
  const polyBox = bboxOf(poly.geometry);
  const polyForm = await viaForm(polyBox);
  out.polygon = { drawnCells: poly.cells, formCells: polyForm, vertices: poly.geometry.coordinates[0].length - 1, match: poly.cells === polyForm };
  console.log('polygon:', JSON.stringify(out.polygon));
  await page.screenshot({ path: 'docs/report-assets/paths-draw.png' });
  await ctx.close();
}

writeFileSync(outFile, JSON.stringify(out, null, 1));
await browser.close();
const pass = out.retry.queryOk && out.retry.aborted === 2 && !out.retry.alert && out.rectangle.match && out.polygon.match;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
