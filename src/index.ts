#!/usr/bin/env node
/**
 * mcp-spreadsheet - open, inspect, query, edit and convert xlsx/csv files locally.
 * Built by theluckystrike. All data stays on this machine.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate } from "@theluckystrike/mcp-license";
import { existsSync, mkdirSync, renameSync, writeFileSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import * as XLSX from "xlsx";
import { z } from "zod";
import { toCsv } from "./csv.js";
import { compile, compilePredicate, columnsUsed, parse, truthy, ExprError } from "./expr.js";
import {
  Cell, FREE_MAX_BYTES, FREE_MAX_ROWS, FREE_WRITE_ROWS, LoadedSheet, Table, UserError,
  cellText, colLetter, expandPath, guessHeaderRow, headerNames, inferType, jsonCell,
  loadWorkbook, minMax, outputPath, parseRange, recentOpened, renderTable, toNumber, toTable,
} from "./sheet.js";
import { VERSION } from "./version.js";

const gate = createLicenseGate({ product: "spreadsheet" });

function text(t: string) { return { content: [{ type: "text" as const, text: t }] }; }
function fail(t: string) { return { content: [{ type: "text" as const, text: `Error: ${t}` }], isError: true as const }; }

function guard<T extends any[]>(fn: (...a: T) => Promise<{ content: any[]; isError?: boolean }>) {
  return async (...a: T) => {
    try { return await fn(...a); }
    catch (e) {
      const msg = e instanceof UserError || e instanceof ExprError ? e.message : `${(e as Error).message}`;
      return fail(msg);
    }
  };
}

/** Round half away from zero at `d` decimals, correcting for float representation first. */
function roundHalfUp(v: number, d: number): number {
  const f = Math.pow(10, d);
  const scaled = Number((v * f).toPrecision(15));
  const r = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return r / f;
}

/** Column names a formula reads, restricted to columns the sheet actually has. */
function formulaColumns(formula: string, headers: string[]): string[] {
  let used: Set<string>;
  try { used = columnsUsed(parse(formula)); } catch { return []; }
  const lower = new Map(headers.map((h) => [h.toLowerCase().trim(), h]));
  const out: string[] = [];
  for (const u of used) {
    const h = lower.get(String(u).toLowerCase().trim());
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

/** Decimal places of a cell as written, for a value that parses as a number. */
function decimalsOf(v: Cell): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (toNumber(v) === null) return null;
  const s = cellText(v).trim().replace(/[^0-9.eE+-]/g, "");
  if (/[eE]/.test(s)) return null;
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Widest decimal count seen across the given columns, or null when no column carried a
 * number at all (in which case there is nothing to infer a money shape from).
 */
function maxDecimals(recs: Record<string, Cell>[], cols: string[]): number | null {
  if (!cols.length) return null;
  let seen = false;
  let max = 0;
  for (const r of recs) {
    for (const c of cols) {
      const d = decimalsOf(r[c] as Cell);
      if (d === null) continue;
      seen = true;
      if (d > max) max = d;
      if (max > 2) return max;
    }
  }
  return seen ? max : null;
}

interface Opened { wb: ReturnType<typeof loadWorkbook>; ls: LoadedSheet; table: Table; notes: string[] }

/**
 * v3 #6: the most data rows this call can possibly need. Only safe when the whole sheet
 * is not consulted, i.e. no filter, grouping, aggregate, sort or A1 range.
 */
function rowBudget(q: { where?: string; group_by?: unknown[]; aggregate?: unknown[]; sort?: unknown; range?: string; limit?: number; offset?: number }): number | undefined {
  if (q.where || q.sort || q.range) return undefined;
  if ((q.group_by && q.group_by.length) || (q.aggregate && q.aggregate.length)) return undefined;
  return (q.offset ?? 0) + (q.limit ?? 100);
}

function open(path: string, sheet?: string, budget?: number): Opened {
  const pro = gate.isPro();
  const wb = loadWorkbook(path, { maxRows: pro ? Infinity : FREE_MAX_ROWS, rowBudget: budget });
  const ls = wb.get(sheet);
  const notes: string[] = [];
  if (!pro && wb.bytes > FREE_MAX_BYTES) {
    notes.push(`This file is ${(wb.bytes / 1048576).toFixed(1)} MB. Free tier reads files up to 5 MB and 5,000 rows, so the results below cover only the first ${ls.matrix.length} rows. ${gate.upgradeText("full-size files")}`);
  } else if (ls.truncated) {
    notes.push(`Only the first ${FREE_MAX_ROWS} rows were read (the sheet has ${ls.totalRowsSeen - 1} data rows). ${gate.upgradeText("files over 5,000 rows")}`);
  }
  return { wb, ls, table: toTable(ls), notes };
}

function withNotes(notes: string[], body: string) {
  return text(notes.length ? notes.join("\n") + "\n\n" + body : body);
}

/**
 * D-1: the free write cap must never produce a partial file that looks complete.
 * Over the cap we write nothing at all and return the reason plus a free workaround.
 */
function writeCapRefusal(rowCount: number, what: string, workaround: string, toolName: string): string | null {
  if (gate.isPro() || rowCount <= FREE_WRITE_ROWS) return null;
  return [
    `Nothing was written. ${what} would be ${rowCount} rows and the free tier writes at most ${FREE_WRITE_ROWS} rows per file.`,
    `No file was created, so you do not have a truncated file that looks complete. The source file is untouched.`,
    `Free workaround: ${workaround}`,
    gate.upgradeText(`writing more than ${FREE_WRITE_ROWS} rows`, toolName),
  ].join("\n\n");
}

function writeAtomic(file: string, data: Buffer | string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data as any);
  renameSync(tmp, file);
}

/**
 * Write headers + rows to `file`.
 *
 * v3 #16: when `base` is given (the workbook the rows came from) only the named sheet is
 * replaced; every other sheet in that workbook is written back untouched. Without it an
 * append to Sheet1 used to emit a one-sheet workbook and delete Sheet2.
 * v3 #17: Date cells are written as real date cells, not as text.
 */
function writeMatrix(file: string, headers: string[], rows: Cell[][], sheetName = "Sheet1", base?: XLSX.WorkBook) {
  const ext = extname(file).toLowerCase();
  const aoa = [headers as unknown as Cell[], ...rows];
  if (ext === ".csv" || ext === ".txt") writeAtomic(file, toCsv(aoa, ","));
  else if (ext === ".tsv") writeAtomic(file, toCsv(aoa, "\t"));
  else if (ext === ".json") writeAtomic(file, JSON.stringify(rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, jsonCell(r[i] ?? null)]))), null, 2));
  else {
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
    const name = sheetName.slice(0, 31) || "Sheet1";
    if (base && base.SheetNames.length) {
      const wb: XLSX.WorkBook = { ...base, SheetNames: base.SheetNames.slice(), Sheets: { ...base.Sheets } };
      wb.Sheets[name] = ws;
      if (!wb.SheetNames.includes(name)) wb.SheetNames.push(name);
      writeAtomic(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer);
      return;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name);
    writeAtomic(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer);
  }
}

/** Normalise rows input (objects or arrays) to headers + matrix. */
function normaliseRows(rows: any[], existingHeaders?: string[]): { headers: string[]; matrix: Cell[][] } {
  if (!Array.isArray(rows) || rows.length === 0) throw new UserError("rows must be a non-empty array");
  const first = rows[0];
  if (Array.isArray(first)) {
    const matrix = rows.map((r: any[]) => r.map((c) => (c === undefined ? null : c))) as Cell[][];
    if (existingHeaders) {
      // v3 #15: the first array is documented as the header row, so appending
      // [["Name","Qty"],["B",2]] used to write "Name","Qty" as a data record.
      const head = matrix[0].map((c) => String(c ?? "").trim().toLowerCase());
      const want = existingHeaders.map((h) => h.trim().toLowerCase());
      const looksLikeHeader = head.length > 0 && head.every((c, i) => c === (want[i] ?? ""));
      if (!looksLikeHeader) {
        throw new UserError(`the first array is the header row and must match the file's columns. Got ${JSON.stringify(matrix[0])}, file has ${JSON.stringify(existingHeaders)}. Pass objects instead, or repeat the file's header row first.`);
      }
      return { headers: existingHeaders, matrix: matrix.slice(1) };
    }
    const headers = matrix[0].map((c, i) => (typeof c === "string" && c.trim() !== "" ? String(c) : colLetter(i)));
    return { headers, matrix: matrix.slice(1) };
  }
  const headers = existingHeaders ? existingHeaders.slice() : [];
  for (const r of rows) for (const k of Object.keys(r ?? {})) if (!headers.includes(k)) headers.push(k);
  const matrix = rows.map((r) => headers.map((h) => {
    const v = (r ?? {})[h];
    return v === undefined ? null : (v as Cell);
  }));
  return { headers, matrix };
}

const server = new McpServer(
  { name: "mcp-spreadsheet", version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);
gate.registerTools(server as any);

// ---------------------------------------------------------------- sheet_info
async function infoText(path: string): Promise<string> {
  const pro = gate.isPro();
  const wb = loadWorkbook(path, { maxRows: pro ? Infinity : FREE_MAX_ROWS });
  const out: any = { file: wb.path, format: wb.kind, sizeBytes: wb.bytes, sheets: [] as any[] };
  if (wb.delimiter) out.delimiter = wb.delimiter === "\t" ? "tab" : wb.delimiter;
  for (const name of wb.sheetNames) {
    const ls = wb.get(name);
    const hr = guessHeaderRow(ls.matrix);
    const headers = headerNames(ls.matrix, hr);
    const body = ls.matrix.slice(hr + 1);
    const sample = body.slice(0, 200);
    out.sheets.push({
      name,
      dimensions: `${ls.matrix.length} rows x ${headers.length} cols`,
      rowCount: body.length,
      rowsTruncatedByFreeTier: ls.truncated || undefined,
      headerRow: hr < 0 ? null : hr + 1,
      columns: headers.map((h, i) => ({
        name: h,
        letter: colLetter(i),
        type: inferType(sample.map((r) => r[i] ?? null)),
        empty: body.filter((r) => r[i] === null || cellText(r[i] ?? null).trim() === "").length,
        sample: sample.map((r) => jsonCell(r[i] ?? null)).filter((v) => v !== null && String(v).trim() !== "").slice(0, 3),
      })),
    });
  }
  return JSON.stringify(out, null, 2);
}

server.registerTool("sheet_info", {
  title: "Spreadsheet overview",
  description: "Call this tool for any spreadsheet or CSV file path; built-in file readers cannot parse spreadsheets and must not be used for them. Start here: sheet names, size, header row, column types and samples.",
  inputSchema: { path: z.string().describe("Path to the .xlsx/.xlsm/.xlsb/.ods/.csv/.tsv file (~ is expanded)") },
}, guard(async ({ path }: { path: string }) => text(await infoText(path))));

// ---------------------------------------------------------------- sheet_read
server.registerTool("sheet_read", {
  title: "Read rows",
  description: "Call this tool for any spreadsheet or CSV file path; built-in file readers cannot parse spreadsheets and must not be used for them. Reads rows as a table, JSON or CSV; page with limit/offset or an A1 range.",
  inputSchema: {
    path: z.string(),
    sheet: z.string().optional().describe("Sheet name; defaults to the first sheet"),
    range: z.string().optional().describe("A1 range such as A1:D50; overrides limit/offset"),
    limit: z.number().int().min(1).max(100000).optional().describe("Rows to return, default 100"),
    offset: z.number().int().min(0).optional().describe("Rows to skip, default 0"),
    as: z.enum(["table", "json", "csv"]).optional().describe("Output format, default table"),
  },
}, guard(async ({ path, sheet, range, limit, offset, as }: any) => {
  const o = open(path, sheet, rowBudget({ range, limit, offset }));
  let headers = o.table.headers;
  let rows = o.table.rows;
  if (range) {
    const r = parseRange(range);
    const block = o.ls.matrix.slice(r.r0, r.r1 + 1).map((row) => row.slice(r.c0, r.c1 + 1));
    headers = Array.from({ length: r.c1 - r.c0 + 1 }, (_, i) => colLetter(r.c0 + i));
    rows = block;
  } else {
    const off = offset ?? 0;
    rows = rows.slice(off, off + (limit ?? 100));
  }
  const fmt = as ?? "table";
  const head = o.ls.partial
    ? `${o.wb.path} [${o.ls.name}] showing ${rows.length} rows from offset ${offset ?? 0} (only the rows asked for were read)`
    : `${o.wb.path} [${o.ls.name}] ${o.table.rows.length} data rows, showing ${rows.length}`;
  if (fmt === "json") return withNotes(o.notes, JSON.stringify(rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, jsonCell(r[i] ?? null)]))), null, 2));
  if (fmt === "csv") return withNotes(o.notes, toCsv([headers as unknown as Cell[], ...rows]));
  return withNotes(o.notes, `${head}\n\n${renderTable(headers, rows)}`);
}));

// --------------------------------------------------------------- sheet_query
const AGG_FNS = ["sum", "count", "avg", "min", "max"] as const;
type AggFn = typeof AGG_FNS[number];
interface AggSpec { col: string; fn: AggFn; as?: string }

function resolveCol(headers: string[], name: string): string {
  const k = headers.find((h) => h.toLowerCase().trim() === String(name).toLowerCase().trim());
  if (!k) throw new UserError(`column ${JSON.stringify(name)} not found. Columns: ${headers.join(", ")}`);
  return k;
}

function aggValue(fn: AggFn, vals: Cell[]): Cell {
  const nonEmpty = vals.filter((v) => v !== null && String(v).trim() !== "");
  if (fn === "count") return nonEmpty.length;
  const nums = nonEmpty.map((v) => toNumber(v)).filter((n): n is number => n !== null);
  if (nums.length === 0) {
    if (fn === "min" || fn === "max") {
      const strs = nonEmpty.map((v) => String(v)).sort();
      return strs.length ? (fn === "min" ? strs[0] : strs[strs.length - 1]) : null;
    }
    return fn === "sum" ? 0 : null;
  }
  const round = (n: number) => Number(n.toFixed(10));
  if (fn === "sum") return round(nums.reduce((a, b) => a + b, 0));
  if (fn === "avg") return round(nums.reduce((a, b) => a + b, 0) / nums.length);
  // v3 #14: Math.min(...nums) blows the argument limit on a big column.
  const mm = minMax(nums)!;
  return round(fn === "min" ? mm.min : mm.max);
}

/** Group records by the given columns and compute the aggregates; returns records keyed by group cols + aliases. */
function groupRecords(headers: string[], recs: Record<string, Cell>[], groupBy: string[], aggs: AggSpec[]) {
  const gcols = groupBy.map((g) => resolveCol(headers, g));
  const specs = (aggs.length ? aggs : [{ col: "*", fn: "count" as AggFn, as: "count" }]).map((a) => {
    const isStar = String(a.col).trim() === "*";
    // v3 #12: every fn over "*" used to return the row count, so sum(*) silently answered
    // a different question than the one asked.
    if (isStar && a.fn !== "count") throw new UserError(`aggregate ${JSON.stringify(a.fn)} needs a column; "*" only works with count. Name the column to ${a.fn}.`);
    const col = isStar ? "*" : resolveCol(headers, a.col);
    return { col, fn: a.fn, as: a.as && a.as.trim() ? a.as.trim() : (isStar ? "count" : `${a.fn}_${col}`) };
  });
  // v3 #13: an alias that collides with a group column or another alias silently
  // overwrote it, so the Region label was replaced by the sum of Sales.
  const taken = new Map<string, string>();
  for (const c of gcols) taken.set(c.toLowerCase().trim(), `group column ${JSON.stringify(c)}`);
  for (const sp of specs) {
    const k = sp.as.toLowerCase().trim();
    const clash = taken.get(k);
    if (clash) {
      throw new UserError(`aggregate alias ${JSON.stringify(sp.as)} collides with ${clash}. Give this aggregate a different "as" name.`);
    }
    taken.set(k, `aggregate ${JSON.stringify(sp.as)}`);
  }
  const groups = new Map<string, { key: Cell[]; rows: Record<string, Cell>[] }>();
  for (const r of recs) {
    const key = gcols.map((c) => r[c] ?? null);
    const k = key.map((v) => (v === null ? "\u0000" : `${typeof v}:${cellText(v)}`)).join("\u0001");
    const g = groups.get(k) ?? { key, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }
  // v3 #11: a global aggregate (no group columns) always has exactly one group, even when
  // nothing matched, so count(*) over zero rows answers 0 instead of returning no row.
  if (!gcols.length && groups.size === 0) groups.set("", { key: [], rows: [] });
  const out = [...groups.values()].map((g) => {
    const rec: Record<string, Cell> = {};
    gcols.forEach((c, i) => { rec[c] = g.key[i]; });
    for (const sp of specs) {
      rec[sp.as] = sp.col === "*" ? g.rows.length : aggValue(sp.fn, g.rows.map((r) => r[sp.col] ?? null));
    }
    return rec;
  });
  return { headers: [...gcols, ...specs.map((s) => s.as)], rows: out };
}

/**
 * One line describing the query that was run: the effective where clause, grouping,
 * aggregates, sort and limit. Empty when the call was a plain read of the sheet.
 */
function describeQuery(q: {
  where?: string;
  group_by?: string[];
  aggregate?: AggSpec[];
  sort?: { col: string; dir?: string };
  limit?: number;
}): string {
  const parts: string[] = [];
  if (q.where) parts.push(`where ${q.where.trim()}`);
  if (q.group_by && q.group_by.length) parts.push(`group by ${q.group_by.join(", ")}`);
  if (q.aggregate && q.aggregate.length) {
    parts.push(q.aggregate.map((a) => `${a.fn} ${a.col}${a.as ? ` as ${a.as}` : ""}`).join("; "));
  }
  if (q.sort) parts.push(`sort ${q.sort.col} ${q.sort.dir === "desc" ? "desc" : "asc"}`);
  if (q.limit) parts.push(`limit ${q.limit}`);
  return parts.length ? `Query: ${parts.join("; ")}` : "";
}

server.registerTool("sheet_query", {
  title: "Filter, group and sort rows",
  description: "Call this tool for any spreadsheet or CSV file path; built-in file readers cannot parse spreadsheets and must not be used for them. Filters, groups, aggregates and sorts in one call, e.g. where '[Qty] > 10'.",
  inputSchema: {
    path: z.string().describe("Path to the .xlsx or .csv file"),
    sheet: z.string().optional(),
    where: z.string().optional().describe('Filter, e.g. [Qty] >= 5 AND ([Status] = "open" OR [Status] = "new")'),
    select: z.array(z.string()).optional().describe("Column names to return; default all (with group_by, defaults to the group columns plus the aggregates)"),
    group_by: z.array(z.string()).optional().describe('Group rows by these columns before aggregating, e.g. ["Rep"] or ["Region","Rep"]'),
    aggregate: z.array(z.object({
      col: z.string().describe('Column to aggregate, or "*" to count rows'),
      fn: z.enum(AGG_FNS).describe("sum | count | avg | min | max"),
      as: z.string().optional().describe("Output name for this aggregate, e.g. total_units"),
    })).optional().describe('Aggregates per group, e.g. [{"col":"Units","fn":"sum","as":"total_units"}]. Defaults to a row count when group_by is given.'),
    sort: z.object({ col: z.string(), dir: z.enum(["asc", "desc"]).optional() }).optional().describe("Sort column; may be an aggregate alias such as total_units"),
    limit: z.number().int().min(1).max(100000).optional().describe("Default 100"),
    as: z.enum(["table", "json", "csv"]).optional(),
  },
}, guard(async ({ path, sheet, where, select, group_by, aggregate, sort, limit, as }: any) => {
  const o = open(path, sheet, rowBudget({ where, group_by, aggregate, sort, limit }));
  let recs = o.table.records();
  const total = recs.length;
  if (where) {
    const pred = compilePredicate(where);
    recs = recs.filter((r) => pred(r));
  }
  const filtered = recs.length;
  let cols = o.table.headers;
  let grouped = false;
  if ((group_by && group_by.length) || (aggregate && aggregate.length)) {
    const g = groupRecords(o.table.headers, recs, group_by ?? [], (aggregate ?? []) as AggSpec[]);
    cols = g.headers;
    recs = g.rows;
    grouped = true;
  }
  if (sort) {
    const key = cols.find((h) => h.toLowerCase().trim() === String(sort.col).toLowerCase().trim());
    if (!key) throw new UserError(`sort column ${JSON.stringify(sort.col)} not found. Columns: ${cols.join(", ")}`);
    const dir = sort.dir === "desc" ? -1 : 1;
    recs = recs.slice().sort((a, b) => {
      const x = a[key], y = b[key];
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      const sx = String(x).toLowerCase(), sy = String(y).toLowerCase();
      const nx = Number(sx), ny = Number(sy);
      if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * dir;
      return (sx < sy ? -1 : sx > sy ? 1 : 0) * dir;
    });
  }
  const matched = recs.length;
  let headers = cols;
  if (select && select.length) headers = select.map((sname: string) => resolveCol(cols, sname));
  const shown = recs.slice(0, limit ?? 100);
  const rows = shown.map((r) => headers.map((h) => r[h] ?? null));
  const counts = grouped
    ? `${matched} groups from ${filtered} of ${total} rows, showing ${rows.length}`
    : o.ls.partial
      ? `showing ${rows.length} rows (only the rows asked for were read)`
      : `${matched} of ${total} rows match, showing ${rows.length}`;
  // Echo the query that was actually run, so a filter or grouping the user never asked
  // for is visible in the answer instead of silently narrowing the question (D-10).
  const head = [describeQuery({ where, group_by, aggregate, sort, limit }), counts].filter(Boolean).join("\n");
  const fmt = as ?? "table";
  if (fmt === "json") return withNotes(o.notes, JSON.stringify(shown.map((r) => Object.fromEntries(headers.map((h) => [h, jsonCell(r[h] ?? null)]))), null, 2));
  if (fmt === "csv") return withNotes(o.notes, toCsv([headers as unknown as Cell[], ...rows]));
  return withNotes(o.notes, `${head}\n\n${rows.length ? renderTable(headers, rows) : "(no rows matched)"}`);
}));

// --------------------------------------------------------------- sheet_stats
server.registerTool("sheet_stats", {
  title: "Column statistics",
  description: "Call this tool for any spreadsheet or CSV file path; built-in file readers cannot parse spreadsheets and must not be used for them. Whole-column statistics: count, empty, distinct, min, max, sum, mean, median.",
  inputSchema: { path: z.string(), sheet: z.string().optional(), columns: z.array(z.string()).optional().describe("Limit to these columns; default all") },
}, guard(async ({ path, sheet, columns }: any) => {
  const o = open(path, sheet);
  const wanted = columns && columns.length
    ? columns.map((s: string) => {
        const k = o.table.headers.find((h) => h.toLowerCase().trim() === s.toLowerCase().trim());
        if (!k) throw new UserError(`column ${JSON.stringify(s)} not found. Columns: ${o.table.headers.join(", ")}`);
        return k;
      })
    : o.table.headers;
  const out = wanted.map((h: string) => {
    const i = o.table.headers.indexOf(h);
    const vals = o.table.rows.map((r) => r[i] ?? null);
    const nonEmpty = vals.filter((v) => v !== null && String(v).trim() !== "");
    // v3 #4: same locale-aware parser as aggregation, not a second private one.
    const nums = nonEmpty.map((v) => toNumber(v)).filter((n): n is number => n !== null);
    const res: any = {
      column: h, type: inferType(vals), count: nonEmpty.length, empty: vals.length - nonEmpty.length,
      distinct: new Set(nonEmpty.map((v) => cellText(v))).size,
    };
    if (nums.length && nums.length >= nonEmpty.length * 0.6) {
      const sorted = nums.slice().sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const mid = Math.floor(sorted.length / 2);
      res.min = sorted[0];
      res.max = sorted[sorted.length - 1];
      res.sum = Number(sum.toFixed(10));
      res.mean = Number((sum / nums.length).toFixed(10));
      res.median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      res.numericValues = nums.length;
    } else {
      const freq = new Map<string, number>();
      for (const v of nonEmpty) freq.set(cellText(v), (freq.get(cellText(v)) ?? 0) + 1);
      res.top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, n]) => ({ value, n }));
      const lens = nonEmpty.map((v) => String(v).length);
      const lm = minMax(lens);
      if (lm) { res.min = cellText(nonEmpty[lens.indexOf(lm.min)]); res.max = cellText(nonEmpty[lens.indexOf(lm.max)]); }
    }
    return res;
  });
  return withNotes(o.notes, JSON.stringify({ file: o.wb.path, sheet: o.ls.name, rows: o.table.rows.length, columns: out }, null, 2));
}));

// ---------------------------------------------------------------- sheet_find
server.registerTool("sheet_find", {
  title: "Find text",
  description: "Call this tool to search every cell of a spreadsheet or CSV for text; built-in file readers cannot parse spreadsheets. Matching is case insensitive. Returns cell addresses with a preview of the row each hit is on.",
  inputSchema: { path: z.string().describe("Path to the .xlsx/.xlsm/.xlsb/.ods/.csv/.tsv file (~ is expanded)"), text: z.string().describe("Text to look for; matched case insensitively anywhere inside a cell. Up to 200 hits are returned"), sheet: z.string().optional().describe("Sheet name; default searches every sheet") },
}, guard(async ({ path, text: needle, sheet }: any) => {
  const pro = gate.isPro();
  const wb = loadWorkbook(path, { maxRows: pro ? Infinity : FREE_MAX_ROWS });
  const q = String(needle).toLowerCase();
  const names = sheet ? [sheet] : wb.sheetNames;
  const hits: any[] = [];
  const notes: string[] = [];
  for (const n of names) {
    const ls = wb.get(n);
    if (ls.truncated) notes.push(`Sheet ${JSON.stringify(n)}: only the first ${FREE_MAX_ROWS} rows were searched. ${gate.upgradeText("searching files over 5,000 rows", "sheet_find")}`);
    for (let r = 0; r < ls.matrix.length; r++) {
      for (let c = 0; c < ls.matrix[r].length; c++) {
        const v = ls.matrix[r][c];
        if (v === null) continue;
        if (cellText(v).toLowerCase().includes(q)) {
          hits.push({ sheet: n, cell: `${colLetter(c)}${r + 1}`, value: jsonCell(v), row: ls.matrix[r].slice(0, 12).map((x) => jsonCell(x) ?? "") });
          if (hits.length >= 200) break;
        }
      }
      if (hits.length >= 200) break;
    }
    if (hits.length >= 200) break;
  }
  return withNotes(notes, JSON.stringify({ file: wb.path, query: needle, matches: hits.length, hits }, null, 2));
}));

// --------------------------------------------------------------- sheet_write
server.registerTool("sheet_write", {
  title: "Write rows",
  description:
    "Call this tool to write rows to an excel (xlsx) or csv/tsv/json file. Returns the rows, columns, byte size and column names of the file written.",
  inputSchema: {
    path: z.string().describe("Source file for append/overwrite, or the intended file for new_file (~ is expanded)"),
    sheet: z.string().optional().describe("Sheet to write; default is the first sheet of the source, or \"Sheet1\" for a new file. Other sheets of an existing workbook are kept unchanged"),
    rows: z.array(z.union([z.record(z.any()), z.array(z.any())])).describe("Array of objects, whose keys become the headers, or an array of arrays with the header row first"),
    mode: z.enum(["new_file", "append", "overwrite"]).describe("new_file writes a brand new file and refuses to clobber an existing one; append adds the rows under the existing data; overwrite replaces the file contents"),
    out_path: z.string().optional().describe("Where to write; default is a new file next to the source for new_file, or the source itself for append/overwrite. The output format follows this extension: .xlsx, .csv, .tsv or .json. An extension is required"),
  },
}, guard(async ({ path, sheet, rows, mode, out_path }: any) => {
  const notes: string[] = [];
  let headers: string[];
  let matrix: Cell[][];
  let target: string;
  let sheetName = sheet ?? "Sheet1";
  let base: XLSX.WorkBook | undefined;

  if (mode === "new_file") {
    const n = normaliseRows(rows);
    headers = n.headers; matrix = n.matrix;
    target = out_path ? expandPath(out_path) : expandPath(path);
    if (existsSync(target)) throw new UserError(`${target} already exists. Pass out_path for a new name, or mode "overwrite" to replace it.`);
  } else {
    const o = open(path, sheet);
    sheetName = sheet ?? o.ls.name;
    headers = o.table.headers;
    const n = normaliseRows(rows, headers);
    matrix = mode === "append" ? [...o.table.rows, ...n.matrix] : n.matrix;
    target = out_path ? expandPath(out_path) : o.wb.path;
    base = o.wb.raw;
    if (base && base.SheetNames.length > 1) {
      notes.push(`Sheets kept unchanged: ${base.SheetNames.filter((s2) => s2 !== sheetName).map((s2) => JSON.stringify(s2)).join(", ")}. Formulas and formatting on ${JSON.stringify(sheetName)} itself are replaced by values.`);
    }
    notes.push(...o.notes);
  }
  if (extname(target) === "") throw new UserError(`out_path ${target} has no file extension; use .xlsx, .csv, .tsv or .json`);
  const refusal = writeCapRefusal(matrix.length, "This write", `write the rows in batches of ${FREE_WRITE_ROWS} or fewer to separate files, or filter the data down first (sheet_query with a where filter) and write only the rows you need.`, "sheet_write");
  if (refusal) return withNotes(notes, refusal);
  writeMatrix(target, headers, matrix, sheetName, base);
  const size = statSync(target).size;
  return withNotes(notes, `Wrote ${matrix.length} rows x ${headers.length} columns to ${target} (${size} bytes, mode ${mode}).\nColumns: ${headers.join(", ")}`);
}));

// ---------------------------------------------------------- sheet_add_column
server.registerTool("sheet_add_column", {
  title: "Add a column",
  description:
    "Call this tool to add a computed column and save the result to a NEW file; the source is never modified unless out_path points at it. Returns the new file path, the row count and a preview of the first rows.",
  inputSchema: {
    path: z.string().describe("Path to the source .xlsx/.xlsm/.xlsb/.ods/.csv/.tsv file (~ is expanded); it is never modified"),
    sheet: z.string().optional().describe("Sheet name; default is the first sheet"),
    name: z.string().describe("Name of the new column. It must not already exist on the sheet"),
    formula: z.string().optional().describe('Expression over the columns of each row, in the same expression language as sheet_query, e.g. "[Qty] * [Unit Price]" or \'[Country] = "PL"\'. Give either formula or values'),
    decimals: z.number().int().min(0).max(10).optional().describe("Round numeric formula results to this many decimals. Default: the widest decimal count of the columns the formula reads, capped at 2 when they all hold 2 or fewer (money in, money out); otherwise no rounding beyond float cleanup"),
    values: z.array(z.any()).optional().describe("Explicit values, one per data row, instead of a formula. Missing entries are left blank"),
    out_path: z.string().optional().describe("Output file; default <source>-plus-<column>.<same ext>. The source file is left untouched unless this points at it"),
  },
}, guard(async ({ path, sheet, name, formula, values, out_path, decimals }: any) => {
  if (!formula && !values) throw new UserError("give either formula or values");
  const o = open(path, sheet);
  const notes = [...o.notes];
  const headers = [...o.table.headers];
  if (headers.some((h) => h.toLowerCase().trim() === String(name).toLowerCase().trim())) throw new UserError(`column ${JSON.stringify(name)} already exists`);
  const recs = o.table.records();
  let computed: Cell[];
  if (formula) {
    const f = compile(formula);
    // D-R13: "[Amount] * 1.23" over money produced 40.7868 in a column the user named
    // "Amount with VAT". Money in, money out: if every operand column the formula reads
    // holds at most 2 decimals, round the result to 2. decimals overrides explicitly.
    const operands = formulaColumns(formula, headers);
    const inputDecimals = maxDecimals(recs, operands);
    const round = typeof decimals === "number"
      ? decimals
      : inputDecimals !== null && inputDecimals <= 2 ? 2 : null;
    if (typeof decimals !== "number" && round === 2 && operands.length) {
      notes.push(`Numeric results rounded to 2 decimals because ${operands.map((c) => JSON.stringify(c)).join(", ")} hold at most 2. Pass decimals to change that.`);
    }
    computed = recs.map((r) => {
      const v = f(r);
      if (v === null || v === undefined) return null;
      if (typeof v === "boolean") return v;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) return null;
        return round === null ? Number(v.toFixed(10)) : Number(roundHalfUp(v, round).toFixed(round));
      }
      return String(v);
    });
  } else {
    if (values.length !== recs.length) notes.push(`values has ${values.length} entries for ${recs.length} data rows; missing entries are blank.`);
    computed = recs.map((_, i) => (values[i] === undefined ? null : values[i]));
  }
  headers.push(String(name));
  const matrix = o.table.rows.map((r, i) => [...r, computed[i] ?? null]);
  const target = out_path ? expandPath(out_path) : outputPath(o.wb.path, undefined, `-plus-${String(name).replace(/[^A-Za-z0-9_-]+/g, "_")}`);
  if (!out_path && existsSync(target)) throw new UserError(`${target} already exists; pass out_path to choose another name`);
  const refusal = writeCapRefusal(matrix.length, `The file with the new column`, `narrow the sheet first with sheet_query (for example a where filter on the rows you care about, as: "csv", saved with sheet_write), then add the column to that smaller file; or use sheet_stats / sheet_query aggregates if you only need the totals rather than the whole file.`, "sheet_add_column");
  if (refusal) return withNotes(notes, refusal);
  writeMatrix(target, headers, matrix, o.ls.name);
  const preview = renderTable(headers, matrix.slice(0, 5));
  return withNotes(notes, `Added column ${JSON.stringify(name)} and wrote ${matrix.length} rows to ${target}. The original file was not changed.\n\n${preview}`);
}));

// ------------------------------------------------------------- sheet_convert
server.registerTool("sheet_convert", {
  title: "Convert file",
  description: "Call this tool to convert a sheet between excel (xlsx), csv and json. Writes a new file next to the source unless out_path is given; the source is never modified. Returns the new file path with its row and column counts.",
  inputSchema: {
    path: z.string().describe("Path to the source .xlsx/.xlsm/.xlsb/.ods/.csv/.tsv file (~ is expanded); it is never modified"),
    to: z.enum(["csv", "xlsx", "json"]).describe("Target format; the default out_path takes this as its extension"),
    sheet: z.string().optional().describe("Sheet to convert; default is the first sheet. Only that one sheet is written"),
    out_path: z.string().optional().describe("Where to write; default is the source name with the new extension, next to the source. It must differ from the source path"),
  },
}, guard(async ({ path, to, sheet, out_path }: any) => {
  const o = open(path, sheet);
  const notes = [...o.notes];
  const target = out_path ? expandPath(out_path) : outputPath(o.wb.path, undefined, "", `.${to}`);
  if (target === o.wb.path) throw new UserError("the converted file would overwrite the source; pass out_path");
  if (!out_path && existsSync(target)) throw new UserError(`${target} already exists; pass out_path to choose another name`);
  const refusal = writeCapRefusal(o.table.rows.length, "The converted file", `filter first with sheet_query (where + limit, as: "csv") and save that subset, or convert the sheet in ${FREE_WRITE_ROWS}-row slices.`, "sheet_convert");
  if (refusal) return withNotes(notes, refusal);
  writeMatrix(target, o.table.headers, o.table.rows, o.ls.name);
  return withNotes(notes, `Converted ${o.wb.path} [${o.ls.name}] to ${target} (${o.table.rows.length} rows, ${o.table.headers.length} columns).`);
}));

// ------------------------------------------------------------------ resource
server.registerResource(
  "sheet",
  new ResourceTemplate("sheet://{path}", { list: undefined }),
  { title: "Spreadsheet overview", description: "sheet://<path> returns the sheet_info summary for a spreadsheet file", mimeType: "application/json" },
  async (uri: URL, vars: any) => {
    const raw = Array.isArray(vars.path) ? vars.path[0] : vars.path;
    try {
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: await infoText(decodeURIComponent(String(raw))) }] };
    } catch (e) {
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Error: ${(e as Error).message}` }] };
    }
  },
);

server.registerPrompt("explore_sheet", {
  title: "Explore a spreadsheet",
  description: "Look at an unfamiliar spreadsheet: run sheet_info first, then propose concrete sheet_query calls over the columns it actually has.",
  argsSchema: {
    path: z.string().optional().describe("Path to the .xlsx/.ods/.csv/.tsv file to explore"),
    question: z.string().optional().describe("What you want out of the file, e.g. \"revenue per country in 2026\""),
  },
}, ({ path, question }: { path?: string; question?: string }) => {
  const p = path && path.trim() ? path.trim() : "<path to the file>";
  const q = question && question.trim() ? question.trim() : null;
  return {
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          `Explore the spreadsheet ${p}${q ? ` so you can answer: ${q}` : ""}. Use the spreadsheet tools only - built-in file readers cannot parse spreadsheets.`,
          `1. sheet_info {path: ${JSON.stringify(p)}} first, always. Report the sheet names, the row count, the header row and, for every column, its name, letter, inferred type and sample values.`,
          `2. Do not guess column names. Every later call must use the exact header strings sheet_info printed.`,
          `3. From those columns, propose three to five concrete sheet_query calls with real arguments, e.g. sheet_query {path: ${JSON.stringify(p)}, select: ["<a text column>"], aggregate: "sum", of: "<a numeric column>", group_by: "<a text column>"} and a filtered one such as sheet_query {path: ${JSON.stringify(p)}, where: "[<a date or number column>] >= <value>", limit: 20}. Say in one line what each would answer.`,
          `4. Run the ones that bear on the question${q ? "" : " I am most likely to care about"}, and give me the numbers.`,
          `5. If a column looks derived (a total, a VAT amount), say so and offer sheet_add_column {path: ${JSON.stringify(p)}, name: "<new column>", formula: "[<col a>] * [<col b>]"} rather than editing the source file.`,
        ].join("\n"),
      },
    }],
  };
});

// D-S5: a fixed URI alongside the sheet://{path} template. Registered as a plain
// resource so it is matched before the template and shows up in resources/list.
server.registerResource(
  "recent-sheets",
  "sheet://recent",
  {
    title: "Recently opened spreadsheets",
    description: "The spreadsheet files this server has opened since it started, most recent first. Held in memory only; nothing is written to disk.",
    mimeType: "application/json",
  },
  async (uri: URL) => {
    const files = recentOpened();
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          count: files.length,
          note: "Session only, most recent first. This server keeps no state on disk, so the list is empty again after a restart.",
          files: files.map((f) => ({ path: f.path, opened: f.opened, resource: `sheet://${encodeURIComponent(f.path)}` })),
        }, null, 2),
      }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`mcp-spreadsheet ${VERSION} ready (${gate.isPro() ? "pro" : "free"})\n`);
}
main().catch((e) => { process.stderr.write(`fatal: ${(e as Error).stack}\n`); process.exit(1); });
