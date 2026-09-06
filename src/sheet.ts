import { closeSync, existsSync, openSync, readSync, statSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { resolve, extname, dirname, basename, join } from "node:path";
import * as XLSX from "xlsx";
import { parseCsv, coerce } from "./csv.js";
import { parseNumberLoose } from "./num.js";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const FREE_MAX_ROWS = 5000;
export const FREE_MAX_BYTES = 5 * 1024 * 1024;
export const FREE_WRITE_ROWS = 500;

export class UserError extends Error {}

/** A leading `<scheme>://` means the caller has a URL, not a local path. Checked BEFORE
 * any resolution, so a URL is never joined against the server's cwd and the refusal
 * never has a path in it, let alone one that leaks the cwd. */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// D-R83: a URL handed to `path` used to be silently resolved as a relative filesystem
// path, producing a "file not found" error that leaked the server's own cwd. Refused by
// name instead.
export function expandPath(p: string): string {
  if (typeof p !== "string" || p.trim() === "") throw new UserError("path is required");
  if (URL_SCHEME_RE.test(p.trim())) {
    throw new UserError(
      `"${p.trim()}" is a URL, not a file path; this tool reads local files. On the hosted route, ` +
      `use the url argument of sheet_load. Locally, download it first and pass the path it was saved to.`,
    );
  }
  let s = p.trim();
  if (s === "~") s = homedir();
  else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  return resolve(s);
}

export function requireExisting(p: string): string {
  const full = expandPath(p);
  if (!existsSync(full)) throw new UserError(`file not found: ${full}`);
  const st = statSync(full);
  if (st.isDirectory()) throw new UserError(`${full} is a directory, not a spreadsheet file`);
  if (st.size > MAX_FILE_BYTES) {
    throw new UserError(`file is ${(st.size / 1048576).toFixed(1)} MB which is over the 50 MB limit this server can open safely. Split the file or export the sheet you need.`);
  }
  return full;
}

export type Cell = string | number | boolean | Date | null;

/**
 * v3 #17: an xlsx date cell stays a Date through the internal model so a conversion back
 * to xlsx writes a date cell, not text. Rendered as ISO, with the time only when the cell
 * actually carries one.
 */
export function formatCellDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const ms = d.getMilliseconds();
  if (!d.getHours() && !d.getMinutes() && !d.getSeconds() && !ms) return base;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${base}T${time}${ms ? "." + p(ms, 3) : ""}`;
}

/** Text form of a cell for tables, CSV output and JSON output. */
export function cellText(c: Cell): string {
  if (c === null || c === undefined) return "";
  if (c instanceof Date) return formatCellDate(c);
  return String(c);
}

/** JSON-safe form of a cell: Dates become ISO strings, everything else is unchanged. */
export function jsonCell(c: Cell): string | number | boolean | null {
  if (c === null || c === undefined) return null;
  if (c instanceof Date) return formatCellDate(c);
  return c;
}

export interface LoadedSheet {
  name: string;
  matrix: Cell[][];       // raw rows, exactly as stored
  truncated: boolean;     // free-tier row cap hit
  totalRowsSeen: number;
  /** true when parsing stopped at rowBudget, so totalRowsSeen is not the file's row count */
  partial?: boolean;
}

export interface Workbook {
  path: string;
  kind: "csv" | "xlsx";
  bytes: number;
  sheetNames: string[];
  delimiter?: string;
  /** the parsed xlsx workbook, so a write can replace one sheet and keep the rest (v3 #16) */
  raw?: XLSX.WorkBook;
  get(sheet?: string): LoadedSheet;
}

function normMatrix(rows: unknown[][]): Cell[][] {
  return rows.map((r) => r.map((c) => {
    if (c === undefined || c === null || c === "") return null;
    if (typeof c === "number" || typeof c === "boolean" || typeof c === "string") return c;
    if (c instanceof Date) return Number.isFinite(c.getTime()) ? c : null;
    return String(c);
  }));
}

function trimTrailing(m: Cell[][]): Cell[][] {
  let end = m.length;
  while (end > 0 && m[end - 1].every((c) => c === null)) end--;
  return m.slice(0, end);
}

export interface LoadOpts {
  maxRows?: number;
  /**
   * v3 #6: the most data rows any caller can possibly need. When set, a CSV is read and
   * parsed only up to that many rows instead of reading, parsing and coercing the whole
   * file to then slice 100 rows off the front.
   */
  rowBudget?: number;
}

/** Read just enough of a CSV to yield `maxRows` complete rows. Returns the text read. */
function readCsvHead(full: string, maxRows: number, delimiter?: string): { text: string; bytesRead: number; eof: boolean } {
  const size = statSync(full).size;
  const fd = openSync(full, "r");
  const dec = new StringDecoder("utf8");
  const buf = Buffer.allocUnsafe(1 << 20);
  let text = "";
  let bytesRead = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, bytesRead);
      bytesRead += n;
      text += n > 0 ? dec.write(buf.subarray(0, n)) : dec.end();
      const eof = n === 0 || bytesRead >= size;
      if (eof) return { text, bytesRead, eof: true };
      const probe = parseCsv(text, delimiter, { maxRows: maxRows + 1, partial: true });
      if (!probe.complete) return { text: text.slice(0, probe.consumed), bytesRead, eof: false };
    }
  } finally { closeSync(fd); }
}

export interface RecentOpen { path: string; opened: string; }

const RECENT_MAX = 20;
/**
 * D-S5: the files opened in THIS process, most recent first, for sheet://recent.
 * In memory only - this server is stateless on disk and must stay that way.
 */
const recentOpens: RecentOpen[] = [];

export function recentOpened(): RecentOpen[] {
  return recentOpens.map((e) => ({ ...e }));
}

function recordOpen(full: string): void {
  const i = recentOpens.findIndex((e) => e.path === full);
  if (i >= 0) recentOpens.splice(i, 1);
  recentOpens.unshift({ path: full, opened: new Date().toISOString() });
  if (recentOpens.length > RECENT_MAX) recentOpens.length = RECENT_MAX;
}

export function loadWorkbook(pathIn: string, opts: LoadOpts = {}): Workbook {
  const full = requireExisting(pathIn);
  recordOpen(full);
  const bytes = statSync(full).size;
  const ext = extname(full).toLowerCase();
  const maxRows = opts.maxRows ?? Infinity;

  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    const forced = ext === ".tsv" ? "\t" : undefined;
    const budget = opts.rowBudget;
    // rowBudget + 1 for the header row; a header row is never all we need.
    const head = budget !== undefined && Number.isFinite(budget)
      ? readCsvHead(full, Math.max(1, budget) + 1, forced)
      : { text: readFileSync(full, "utf8"), bytesRead: bytes, eof: true };
    const parsed = parseCsv(head.text, forced, head.eof ? {} : { maxRows: Math.max(1, budget ?? 0) + 1, partial: true });
    const partial = !head.eof;
    const all = trimTrailing(normMatrix(parsed.rows.map((r) => r.map((c) => coerce(c)))));
    const name = basename(full);
    return {
      path: full, kind: "csv", bytes, sheetNames: [name], delimiter: parsed.delimiter,
      get(sheet?: string): LoadedSheet {
        if (sheet && sheet !== name && sheet !== "0") throw new UserError(`${name} is a CSV file; it has one sheet named ${JSON.stringify(name)}`);
        const body = all.length > 1 ? all.slice(0, Math.max(1, Math.min(all.length, maxRows + 1))) : all;
        return { name, matrix: body, truncated: body.length < all.length, totalRowsSeen: all.length, partial };
      },
    };
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(readFileSync(full), { type: "buffer", cellDates: true, cellNF: false, cellText: false });
  } catch (e) {
    throw new UserError(`could not open ${full} as a spreadsheet (${(e as Error).message}). Supported: .xlsx .xlsm .xlsb .xls .ods .csv .tsv`);
  }
  const sheetNames = wb.SheetNames.slice();
  return {
    path: full, kind: "xlsx", bytes, sheetNames, raw: wb,
    get(sheet?: string): LoadedSheet {
      const name = sheet ?? sheetNames[0];
      if (!sheetNames.includes(name)) throw new UserError(`sheet ${JSON.stringify(name)} not found. Sheets: ${sheetNames.map((s) => JSON.stringify(s)).join(", ")}`);
      const ws = wb.Sheets[name];
      const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false, raw: true }) as unknown[][];
      const all = trimTrailing(normMatrix(raw));
      const body = all.length > 1 ? all.slice(0, Math.max(1, Math.min(all.length, maxRows + 1))) : all;
      return { name, matrix: body, truncated: body.length < all.length, totalRowsSeen: all.length };
    },
  };
}

/** Guess which row holds the headers. Returns index into matrix, or -1 if none. */
export function guessHeaderRow(m: Cell[][]): number {
  const limit = Math.min(m.length, 12);
  for (let i = 0; i < limit; i++) {
    const row = m[i];
    const filled = row.filter((c) => c !== null && String(c).trim() !== "");
    if (filled.length === 0) continue;
    // v3 #9: a one-cell report title must not become the header row just because the
    // title row is physically one cell wide. Score it against the rows that follow: if
    // any nearby row has more filled cells, this row is a title, not a header.
    if (filled.length < 2) {
      const widest = m.slice(i + 1, i + 6).reduce((w, r) => Math.max(w, r.filter((c) => c !== null && String(c).trim() !== "").length), 0);
      if (row.length > 1 || widest >= 2) continue;
    }
    const allText = filled.every((c) => typeof c === "string" && String(c).trim() !== "");
    const uniq = new Set(filled.map((c) => String(c).trim().toLowerCase())).size === filled.length;
    if (!allText || !uniq) continue;
    const next = m[i + 1];
    if (!next) return i;
    const nextFilled = next.filter((c) => c !== null);
    if (nextFilled.length === 0) continue;
    return i;
  }
  return m.length && m[0].some((c) => typeof c === "string") ? 0 : -1;
}

export function headerNames(m: Cell[][], headerRow: number): string[] {
  const width = m.reduce((w, r) => Math.max(w, r.length), 0);
  const names: string[] = [];
  const seen = new Map<string, number>();
  for (let c = 0; c < width; c++) {
    let n = headerRow >= 0 ? cellText(m[headerRow]?.[c] ?? null).trim() : "";
    if (n === "") n = colLetter(c);
    const prev = seen.get(n.toLowerCase());
    if (prev !== undefined) { seen.set(n.toLowerCase(), prev + 1); n = `${n}_${prev + 1}`; }
    else seen.set(n.toLowerCase(), 0);
    names.push(n);
  }
  return names;
}

/**
 * Coerce a cell to a number for aggregation: accepts real numbers and text such as
 * "1,250.00", "$1,250.00", "EUR 1 250,00", "(300)" and "12.5%". Returns null when there is no number.
 * v3 #4: the separator rules live in src/num.ts and are shared with CSV coercion and the
 * expression language, so "12,99" is 12.99 in every code path rather than 1299 in one.
 */
export function toNumber(v: unknown): number | null {
  return parseNumberLoose(v);
}

/**
 * v3 #14: Math.min(...nums) / Math.max(...nums) throw "too many arguments" on a column of
 * roughly 150,000 numbers. One pass, no spread.
 */
export function minMax(nums: number[]): { min: number; max: number } | null {
  if (!nums.length) return null;
  let min = nums[0], max = nums[0];
  for (const n of nums) { if (n < min) min = n; if (n > max) max = n; }
  return { min, max };
}

export function colLetter(i: number): string {
  let s = "";
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

export interface Table { headers: string[]; rows: Cell[][]; headerRow: number; records(): Record<string, Cell>[] }

export function toTable(ls: LoadedSheet): Table {
  const hr = guessHeaderRow(ls.matrix);
  const headers = headerNames(ls.matrix, hr);
  const rows = ls.matrix.slice(hr + 1);
  const width = headers.length;
  const padded = rows.map((r) => { const out = r.slice(0, width); while (out.length < width) out.push(null); return out; });
  return {
    headers, headerRow: hr, rows: padded,
    records() { return padded.map((r) => { const o: Record<string, Cell> = {}; headers.forEach((h, i) => { o[h] = r[i] ?? null; }); return o; }); },
  };
}

export function inferType(values: Cell[]): string {
  let n = 0, b = 0, d = 0, s = 0, empty = 0;
  const dateRe = /^\d{4}-\d{2}-\d{2}([T ]|$)|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  for (const v of values) {
    if (v === null || String(v).trim() === "") { empty++; continue; }
    if (typeof v === "number") { n++; continue; }
    if (typeof v === "boolean") { b++; continue; }
    if (v instanceof Date) { d++; continue; }
    const t = String(v).trim();
    if (dateRe.test(t)) { d++; continue; }
    if (/^-?[$€£]?[\d,]*\.?\d+%?$/.test(t) && /\d/.test(t)) { n++; continue; }
    s++;
  }
  const total = n + b + d + s;
  if (total === 0) return "empty";
  if (s === 0 && d > 0 && d >= n) return "date";
  if (s === 0 && n > 0 && n >= d) return "number";
  if (s === 0 && b > 0) return "boolean";
  return "text";
}

/** Parse an A1-style range like "A1:C10" or "B2". Returns 0-based inclusive bounds. */
export function parseRange(range: string): { r0: number; c0: number; r1: number; c1: number } {
  const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(range.trim());
  if (!m) throw new UserError(`range ${JSON.stringify(range)} is not A1 notation (examples: A1:D50, B2)`);
  const col = (s: string) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const r0 = Number(m[2]) - 1, c0 = col(m[1]);
  const r1 = m[4] ? Number(m[4]) - 1 : r0, c1 = m[3] ? col(m[3]) : c0;
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}

export function outputPath(input: string, outPath: string | undefined, suffix: string, ext?: string): string {
  if (outPath) return expandPath(outPath);
  const dir = dirname(input);
  const base = basename(input, extname(input));
  const e = ext ?? (extname(input) || ".csv");
  return join(dir, `${base}${suffix}${e}`);
}

export function renderTable(headers: string[], rows: Cell[][], maxWidth = 40): string {
  const cells = [headers, ...rows.map((r) => r.map((c) => cellText(c)))];
  const widths = headers.map((_, i) => Math.min(maxWidth, cells.reduce((w, r) => Math.max(w, String(r[i] ?? "").length), 0)));
  const line = (r: (string | Cell)[]) => "| " + widths.map((w, i) => {
    let s = String(r[i] ?? "");
    if (s.length > w) s = s.slice(0, w - 1) + "…";
    return s.padEnd(w);
  }).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [line(headers), sep, ...rows.map((r) => line(r.map((c) => cellText(c))))].join("\n");
}
