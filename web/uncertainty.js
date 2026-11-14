// Honest uncertainty for converted (pre-NOAA-20) values: the measured leave-one-year-out error of each conversion
// link, read from data/validation/summary.json, interpolated by area size between the 1-degree-box result and the
// whole-region result (log scale), and combined along the chain a value was converted through.
// Pure module: no DOM, no network.

export const LINKS = ['terra_aqua', 'aqua_snpp', 'snpp_noaa20'];
const CELLS_PER_BOX = 100; // a 1-degree box holds 10 x 10 cells of 0.1 degree

// harm_from codes (CONTRACTS 4.2) -> links the value went through. 3 (gap-filled) takes the longest chain: conservative.
const CHAIN = { 0: [], 1: ['snpp_noaa20'], 2: ['aqua_snpp', 'snpp_noaa20'], 4: LINKS, 3: LINKS };

// Median absolute error per link for an area of `cells` cells, given `regionCells` cells in the whole region.
export function linkErrors(summary, cells, regionCells) {
  const loyo = summary && summary.loyo && summary.loyo[summary.chosen_variant];
  if (!loyo) return null;
  const nBoxes = cells / CELLS_PER_BOX;
  const nRegion = regionCells / CELLS_PER_BOX;
  // 0 at one box (or smaller: no measurement below one box, so the 1-degree error applies), 1 at the whole region
  const t = nRegion > 1 ? Math.min(1, Math.max(0, Math.log(Math.max(nBoxes, 1)) / Math.log(nRegion))) : 1;
  const out = {};
  for (const link of LINKS) {
    const box = loyo[link] && loyo[link].box1deg && loyo[link].box1deg.mdape;
    const region = loyo[link] && loyo[link].region_month && loyo[link].region_month.mdape;
    if (!Number.isFinite(box) || !Number.isFinite(region)) return null;
    out[link] = box + (region - box) * t;
  }
  return out;
}

// Relative error of a value converted from the source coded by harm_from (independent links add in quadrature).
export function chainError(errors, harmFrom) {
  const links = CHAIN[harmFrom] || [];
  return Math.sqrt(links.reduce((s, l) => s + errors[l] ** 2, 0));
}

// Calendar rows with lo/hi widened to value x (1 -/+ error) wherever that is wider than the ratio band.
export function widenRows(rows, errors) {
  if (!errors) return rows;
  return rows.map((r) => {
    const e = chainError(errors, r.harm_from);
    if (!e || !r.value) return r;
    const lo = Math.max(0, r.value * (1 - e));
    const hi = r.value * (1 + e);
    return lo < r.lo || hi > r.hi ? { ...r, lo: Math.min(r.lo, lo), hi: Math.max(r.hi, hi), widened: true } : r;
  });
}

// The note for small areas: null unless the area is under `maxBoxes` 1-degree boxes and a converted value is shown.
export function smallAreaNote(rows, errors, cells, maxBoxes = 5) {
  if (!errors || cells / CELLS_PER_BOX >= maxBoxes) return null;
  const e = Math.max(0, ...rows.filter((r) => r.value > 0 && r.harm_from !== 0).map((r) => chainError(errors, r.harm_from)));
  return e > 0 ? `Before 2018, values for small areas are approximate (±${Math.round(e * 100)} %).` : null;
}
