/**
 * The parsing engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, workbook store). The two modules
 * re-exported here -- the RFC 4180 CSV reader and the locale-aware number parser -- are
 * generic, have no filesystem, network or licence dependency at import time, and are
 * consumed by a sibling server (servers/bank-statement) so a bank CSV is parsed by
 * exactly the same code that parses a spreadsheet CSV.
 *
 * Stability: the names below are the contract. `.../dist/csv.js` deep imports are not.
 */

/* ------------------------------------------------------------------ CSV */
export type { ParseCsvOpts, ParsedCsv } from "./csv.js";
export { coerce, csvEscape, CsvError, DELIMITERS, parseCsv, sniffDelimiter, toCsv } from "./csv.js";

/* --------------------------------------------------------------- numbers */
export {
  parseNumberBody, parseNumberForCompare, parseNumberLoose, parseNumberStrict,
} from "./num.js";
