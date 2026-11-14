import { chromium } from 'playwright';
const site = process.argv[2] || 'https://ashimajain777.github.io/fire-calendar/';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(site, { waitUntil: 'load' });
await page.waitForFunction(() => window.fireCalendar && !document.body.textContent.includes('Loading data…'), null, { timeout: 90000 });
const stops = [];
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab');
  const f = await page.evaluate(() => ({ id: document.activeElement.id, label: document.activeElement.labels?.[0]?.textContent?.trim() || document.activeElement.textContent.trim().slice(0, 24) }));
  stops.push(f.id || f.label);
  if (/west/i.test(f.label + f.id)) break;
}
console.log('tab stops:', stops.length, stops.join(' | '));
for (const [i, v] of ['73.8', '29.5', '77.5', '32.5'].entries()) { await page.keyboard.type(v); if (i < 3) await page.keyboard.press('Tab'); }
const where = await page.evaluate(() => document.activeElement.id || document.activeElement.labels?.[0]?.textContent);
await page.keyboard.press('Enter');
const ok = await page.waitForFunction(() => /Calendar updated/.test(document.querySelector('#live')?.textContent || ''), null, { timeout: 60000 }).then(() => true).catch(() => false);
console.log('enter pressed in:', where, '| query ran:', ok, '| live:', await page.evaluate(() => document.querySelector('#live')?.textContent));
const cell = page.locator('.cal-cell[tabindex="0"]').first();
if (await cell.count()) {
  await cell.focus();
  const a = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.keyboard.press('ArrowLeft');
  const b = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.keyboard.press('ArrowDown');
  const c = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  console.log('calendar arrows:', a, '->', b, '->', c);
}
await browser.close();
