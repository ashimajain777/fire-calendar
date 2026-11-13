// DuckDB-WASM in the browser. See docs/CONTRACTS.md section 6. Same loading approach as web/gate.html.

// Imported inside initDB (not at the top) so the CSV helpers can be unit-tested under node.
const DUCKDB_ESM = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm';

// Apache Arrow `Type` enum values (stable across Arrow JS versions).
const ARROW_DECIMAL = 7;
const ARROW_DATE = 8;
const ARROW_TIMESTAMP = 10;

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvHeader = (columns) => `${columns.map(csvCell).join(',')}\r\n`;
const csvBody = (columns, rows) => rows.map((r) => `${columns.map((c) => csvCell(r[c])).join(',')}\r\n`).join('');

export function csvLines(columns, rows) {
  return csvHeader(columns) + csvBody(columns, rows);
}

function converter(type) {
  if (type.typeId === ARROW_DATE) return (v) => new Date(Number(v)).toISOString().slice(0, 10);
  if (type.typeId === ARROW_TIMESTAMP) return (v) => new Date(Number(v)).toISOString();
  if (type.typeId === ARROW_DECIMAL) return (v) => Number(String(v)) / 10 ** type.scale;
  return (v) => (typeof v === 'bigint' ? Number(v) : v);
}

function toRows(table) {
  const columns = table.schema.fields.map((f) => f.name);
  const vectors = columns.map((_, i) => table.getChildAt(i));
  const convert = table.schema.fields.map((f) => converter(f.type));
  const rows = new Array(table.numRows);
  for (let r = 0; r < table.numRows; r++) {
    const row = {};
    for (let c = 0; c < columns.length; c++) {
      const v = vectors[c].get(r);
      row[columns[c]] = v === null || v === undefined ? null : convert[c](v);
    }
    rows[r] = row;
  }
  return { columns, rows };
}

export async function initDB(config) {
  const duckdb = await import(DUCKDB_ESM);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // Browsers refuse a cross-origin Worker script, so a same-origin Blob imports it.
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  const con = await db.connect();

  async function run(sql) {
    try {
      return toRows(await con.query(sql));
    } catch (e) {
      const files = [...new Set([...sql.matchAll(/'([^']+\.(?:parquet|json|csv))'/g)].map((m) => m[1]))];
      throw new Error(`Couldn't load ${files.length ? files.join(', ') : 'query result'}: ${e && e.message ? e.message : e}`, { cause: e });
    }
  }

  return {
    async query(sql) {
      return (await run(sql)).rows;
    },
    // shortcut: the whole result is held in memory before the Blob is built; switch to con.send() batches if exports pass a few million rows.
    async toCSV(sql) {
      const { columns, rows } = await run(sql);
      const parts = [csvHeader(columns)];
      for (let i = 0; i < rows.length; i += 20000) parts.push(csvBody(columns, rows.slice(i, i + 20000)));
      return new Blob(parts, { type: 'text/csv;charset=utf-8' });
    },
    url(key, file) {
      const base = config && config.data && config.data[key];
      if (!base) throw new Error(`config.json has no data.${key}`);
      return new URL(base + file, location.href).href;
    },
  };
}
