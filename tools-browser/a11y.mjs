// Automated accessibility scan (axe-core, WCAG 2.1 A/AA) of both pages after a real query, in light and dark,
// plus a scripted keyboard pass and a 200 % zoom check. node tools-browser/a11y.mjs [site]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const site = process.argv[2] || 'https://ashimajain777.github.io/fire-calendar/';
const axeSrc = readFileSync(new URL('./node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
mkdirSync('../docs/report-assets', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const out = {};
async function ready(page) {
  await page.waitForFunction(() => window.fireCalendar && !document.body.textContent.includes('Loading data…'), null, { timeout: 90000 });
}
async function axe(page, label) {
  await page.addScriptTag({ content: axeSrc });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  out[label] = r;
  console.log(`axe ${label}: ${r.length} violation types`);
  r.forEach((v) => console.log(`   [${v.impact}] ${v.id} x${v.n}: ${v.help} | ${v.sample.join(' ; ')}`));
}
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
  await page.goto(site, { waitUntil: 'load' });
  await ready(page);
  await page.evaluate(() => window.fireCalendar.setArea([73.8, 29.5, 77.5, 32.5]));
  await page.waitForTimeout(1500);
  await axe(page, `index-${theme}`);
  for (const tab of ['Trend', 'Anomalies', 'Season', 'Categories', 'Download']) {
    const t = page.getByRole('tab', { name: tab });
    if (await t.count()) { await t.click(); await page.waitForTimeout(2500); }
  }
  await axe(page, `index-tabs-${theme}`);
  await page.screenshot({ path: `../docs/report-assets/a11y-index-${theme}.png`, fullPage: false });
  const m = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
  await m.goto(site + 'methodology.html', { waitUntil: 'load' });
  await m.waitForTimeout(12000);
  await axe(m, `methodology-${theme}`);
  await m.close(); await page.close();
}
// keyboard-only: reach the bounding-box form, fill it, submit with Enter, then move in the calendar with arrows
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(site, { waitUntil: 'load' });
  await ready(page);
  const visited = [];
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => { const a = document.activeElement; return { id: a.id, tag: a.tagName, label: a.labels?.[0]?.textContent?.trim() || a.getAttribute('aria-label') || a.textContent.trim().slice(0, 30), ring: getComputedStyle(a).outlineStyle !== 'none' || getComputedStyle(a).boxShadow !== 'none' } });
    visited.push(f);
    if (/west/i.test(f.label || '') || /west/i.test(f.id)) reached = true;
  }
  if (reached) {
    for (const v of ['73.8', '29.5', '77.5', '32.5']) { await page.keyboard.type(v); await page.keyboard.press('Tab'); }
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Calendar updated/.test(document.querySelector('[aria-live]')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
  }
  const live = await page.evaluate(() => document.querySelector('[aria-live]')?.textContent);
  const cell = page.locator('.cal-cell[tabindex="0"]').first();
  let calNav = null;
  if (await cell.count()) {
    await cell.focus();
    const before = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    await page.keyboard.press('ArrowRight');
    const after = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    calNav = { before, after, moved: before !== after };
  }
  const noRing = visited.filter((v) => !v.ring).map((v) => v.id || v.label);
  out.keyboard = { tabsToWestField: reached ? visited.length : null, liveRegion: live, calNav, focusWithoutVisibleRing: noRing };
  console.log('keyboard:', JSON.stringify(out.keyboard));
  // 200 % zoom equivalent: CSS width 640 px at device scale 2
  const z = await browser.newPage({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 2 });
  await z.goto(site, { waitUntil: 'load' }); await ready(z);
  await z.evaluate(() => window.fireCalendar.setArea([73.8, 29.5, 77.5, 32.5])); await z.waitForTimeout(1500);
  out.zoom200 = await z.evaluate(() => ({ pageScrollX: document.documentElement.scrollWidth > window.innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  await z.screenshot({ path: '../docs/report-assets/a11y-zoom200.png' });
  console.log('zoom 200%:', JSON.stringify(out.zoom200));
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto(site, { waitUntil: 'load' }); await ready(p);
  await p.evaluate(() => window.fireCalendar.setArea([73.8, 29.5, 77.5, 32.5])); await p.waitForTimeout(1500);
  out.mobile390 = await p.evaluate(() => ({ pageScrollX: document.documentElement.scrollWidth > window.innerWidth + 1, scrollWidth: document.documentElement.scrollWidth }));
  await p.screenshot({ path: '../docs/report-assets/a11y-mobile390.png' });
  console.log('mobile 390:', JSON.stringify(out.mobile390));
}
writeFileSync('../work/a11y.json', JSON.stringify(out, null, 1));
await browser.close();
