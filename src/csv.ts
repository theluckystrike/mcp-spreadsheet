/** RFC 4180 CSV parser with delimiter sniffing. No dependencies. */

import { parseNumberStrict } from "./num.js";

export class CsvError extends Error {}

export const DELIMITERS = [",", ";", "\t", "|"] as const;

/** Sniff the delimiter by counting occurrences outside quotes across the first lines. */
export function sniffDelimiter(text: string, sample = 64): string {
  const counts: Record<string, number[]> = {};
  for (const d of DELIMITERS) counts[d] = [];
  let inQ = false, line = 0;
  const cur: Record<string, number> = {};
  for (const d of DELIMITERS) cur[d] = 0;
  for (let i = 0; i < text.length && line < sample; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') i++; else inQ = false; }
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === "\n") {
      for (const d of DELIMITERS) { counts[d].push(cur[d]); cur[d] = 0; }
      line++; continue;
    }
    if (c === "\r") continue;
    if (c in cur) cur[c]++;
  }
  for (const d of DELIMITERS) counts[d].push(cur[d]);
  let best = ",", bestScore = -1;
  for (const d of DELIMITERS) {
    const rows = counts[d].filter((n, idx) => idx === 0 || n > 0 || counts[d][0] > 0);
    const nonZero = counts[d].filter((n) => n > 0).length;
    if (nonZero === 0) continue;
    const first = counts[d][0];
    const consistent = counts[d].filter((n) => n === first && n > 0).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) { bestScore = score; best = d; }
    void rows;
  }
  return best;
}

export interface ParseCsvOpts {
  /** stop after this many rows have been completed (v3 #6: limit/offset must not parse the whole file) */
  maxRows?: number;
  /** the text is a prefix of a larger file, so an open quote at the end is not an error */
  partial?: boolean;
}

export interface ParsedCsv {
  rows: string[][];
  delimiter: string;
  /** characters of `text` actually consumed (index just past the last completed row) */
  consumed: number;
  /** false when parsing stopped early because maxRows was reached */
  complete: boolean;
}

/** Parse CSV text into a matrix of strings. Handles CRLF, quoted delimiters and embedded newlines. */
export function parseCsv(text: string, delimiter?: string, opts: ParseCsvOpts = {}): ParsedCsv {
  let src = text;
  let base = 0;
  if (src.charCodeAt(0) === 0xfeff) { src = src.slice(1); base = 1; }
  const d = delimiter ?? sniffDelimiter(src);
  const maxRows = opts.maxRows ?? Infinity;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  let started = false;
  let consumed = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") { inQ = true; started = true; continue; }
    if (c === d) { row.push(field); field = ""; started = true; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = ""; started = false;
      consumed = i + 1;
      if (rows.length >= maxRows) return { rows, delimiter: d, consumed: consumed + base, complete: false };
      continue;
    }
    field += c;
    started = true;
  }
  // v3 #3: EOF inside a quoted field swallowed the rest of the file into one cell.
  if (inQ && !opts.partial) throw new CsvError('unterminated quoted field: a \'"\' was opened and never closed. Check for a stray double quote in the file.');
  if (started || field !== "" || row.length) { row.push(field); rows.push(row); consumed = src.length; }
  return { rows, delimiter: d, consumed: consumed + base, complete: true };
}

/**
 * Coerce a CSV string cell to number/boolean when unambiguous.
 *
 * D-R12: the decision is by PATTERN, never by string length, so "403.00" stays a number
 * and Excel's own SUM does not skip it. v3 #4/#5: the pattern rules now live in
 * src/num.ts and are shared with aggregation and expression comparison, so locale
 * numbers and unsafe integers are judged the same way everywhere.
 */
export function coerce(v: string): string | number | boolean {
  const s = v.trim();
  if (s === "") return "";
  const n = parseNumberStrict(s);
  if (n !== null) return n;
  if (s === "true" || s === "TRUE") return true;
  if (s === "false" || s === "FALSE") return false;
  return v;
}

export function csvEscape(v: unknown, delimiter = ","): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (s.includes('"') || s.includes(delimiter) || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(rows: unknown[][], delimiter = ","): string {
  return rows.map((r) => r.map((c) => csvEscape(c, delimiter)).join(delimiter)).join("\n");
}
