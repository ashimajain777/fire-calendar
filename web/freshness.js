// Freshness badge text. Pure: no imports, no DOM. See docs/CONTRACTS.md section 6.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function freshness(meta, now) {
  const times = Object.values((meta && meta.sources) || {})
    .map((s) => Date.parse(s && s.last_success_utc))
    .filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : null;

  if (meta && meta.status === 'failed') {
    if (newest === null) return { level: 'critical', text: 'Last update failed.' };
    const d = new Date(newest);
    return {
      level: 'critical',
      text: `Last update failed. Showing data from ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}.`,
    };
  }
  if (newest === null) return { level: 'critical', text: 'Data status unavailable' };

  const hours = Math.max(0, (now.getTime() - newest) / 3600e3);
  if (hours < 36) {
    const h = Math.floor(hours);
    return { level: 'good', text: h < 1 ? 'Data updated less than an hour ago' : `Data updated ${plural(h, 'hour')} ago` };
  }
  return { level: hours <= 72 ? 'warning' : 'critical', text: `Data is ${plural(Math.floor(hours / 24), 'day')} old` };
}
