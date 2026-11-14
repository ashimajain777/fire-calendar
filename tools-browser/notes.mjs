// Live check of the round-2 notes: small-area uncertainty note (A2) and the season sentence (A5).
import { chromium } from 'playwright';
const site = process.argv[2] || 'https://ashimajain777.github.io/fire-calendar/';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(site, { waitUntil: 'load' });
await page.waitForFunction(() => window.fireCalendar && !document.body.textContent.includes('Loading data…'), null, { timeout: 120000 });
const res = {};
for (const [name, bbox] of Object.entries({ jharia: [86.1, 23.6, 86.5, 23.9], punjab: [73.8, 29.5, 77.5, 32.5] })) {
  await page.evaluate((x) => window.fireCalendar.setArea(x), bbox);
  await page.getByRole('tab', { name: 'Season' }).click();
  await page.waitForTimeout(1500);
  res[name] = await page.evaluate(() => {
    const c = window.fireCalendar.getContext();
    const conv = c.calendarRows.filter((r) => r.harm_from !== 0 && r.value > 0);
    return {
      cells: c.area.ids.length,
      notices: [...document.querySelectorAll('#status .notice')].map((n) => n.textContent),
      widenedMonths: c.calendarRows.filter((r) => r.widened).length, convertedMonths: conv.length,
      season: document.querySelector('#panel-season p')?.textContent,
    };
  });
  console.log(name, JSON.stringify(res[name]));
}
await b.close();
