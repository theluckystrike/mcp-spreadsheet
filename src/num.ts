/**
 * One locale-aware numeric parser, shared by CSV coercion, aggregation and the
 * expression language (Codex v3 items 4, 5, 7). Every place that turns a cell of text
 * into a number goes through `parseNumberBody` here, so "12,99" cannot mean 12.99 in one
 * code path and 1299 in another.
 *
 * Accepted shapes:
 *   plain            42   -1.5   .5   1e3   1250.00
 *   english grouped  1,250.00   1,250
 *   space grouped    1 250.00   1 250   (also NBSP / narrow NBSP)
 *   european         12,99   1250,00   1.234,56   1 250,00
 *
 * European decimal comma is accepted ONLY in the unambiguous shape: a comma followed by
 * exactly two digits at the end of the string, with dots or spaces (never commas) used
 * for grouping. Anything else that mixes separators ("1,2500.00", "1,234,56") is not a
 * number and stays text.
 */

/** Non-breaking / thin spaces used as grouping separators in European locales. */
const SPACES = new RegExp("[\\u00a0\\u202f\\u2009\\u2007]", "g");

const PLAIN = /^[+-]?(?:\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const EN_GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const SPACE_GROUPED = /^[+-]?\d{1,3}(?: \d{3})+(?:\.\d+)?$/;
/** comma + exactly two digits at the end; dots or spaces group the integer part */
const EU_DECIMAL = /^[+-]?(?:\d{1,3}(?:[. ]\d{3})+|\d+),\d{2}$/;

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a bare numeric body (no currency, no percent, no parentheses) using the
 * separator rules above. Returns null when the string is not unambiguously a number.
 */
export function parseNumberBody(input: string): number | null {
  const s = input.replace(SPACES, " ").trim();
  if (s === "" || !/\d/.test(s)) return null;
  if (EU_DECIMAL.test(s)) return finite(Number(s.replace(/[. ]/g, "").replace(",", ".")));
  if (EN_GROUPED.test(s)) return finite(Number(s.replace(/,/g, "")));
  if (SPACE_GROUPED.test(s)) return finite(Number(s.replace(/ /g, "")));
  if (PLAIN.test(s)) return finite(Number(s));
  return null;
}

/** True when a multi-digit value is written with a leading zero, i.e. it is an identifier. */
function looksLikeIdentifier(s: string): boolean {
  return /^[+-]?0\d/.test(s);
}

/**
 * v3 #5: an integer that cannot be represented exactly must not silently change value.
 * "9007199254740993" stays text rather than becoming 9007199254740992.
 */
function losesPrecision(s: string, n: number): boolean {
  if (/[eE]/.test(s)) return false;
  return Number.isInteger(n) && !Number.isSafeInteger(n);
}

/**
 * Strict parse for CSV import: the cell must be a number and nothing else. Identifiers
 * ("007") and unsafe integers stay text; no currency symbols are stripped.
 */
export function parseNumberStrict(raw: string): number | null {
  const s = raw.replace(SPACES, " ").trim();
  if (looksLikeIdentifier(s)) return null;
  const n = parseNumberBody(s);
  if (n === null) return null;
  if (losesPrecision(s, n)) return null;
  return n;
}

interface LooseOpts {
  /** keep "007" and other leading-zero identifiers as text instead of parsing them */
  identifiers?: boolean;
}

/**
 * Lenient parse for aggregation and comparisons: strips currency symbols and codes,
 * a trailing percent sign and accounting parentheses, then applies the same separator
 * rules. Returns null when nothing numeric is left.
 */
export function parseNumberLoose(v: unknown, opts: LooseOpts = {}): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (v === null || v === undefined) return null;
  let s = String(v).replace(SPACES, " ").trim();
  if (s === "") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1).trim(); }
  let pct = false;
  if (s.endsWith("%")) { pct = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/^[^\d+\-.,]+/, "").replace(/[^\d.,]+$/, "").trim();
  if (opts.identifiers && looksLikeIdentifier(s)) return null;
  const n = parseNumberBody(s);
  if (n === null) return null;
  return sign * (pct ? n / 100 : n);
}

/**
 * Parse for expression comparisons (v3 #7): same leniency as aggregation, but a value
 * the CSV layer deliberately preserved as text ("007") is NOT a number here either, so
 * `[Code] = 7` compares "007" against "7" as strings and is false.
 */
export function parseNumberForCompare(v: unknown): number | null {
  return parseNumberLoose(v, { identifiers: true });
}
