/**
 * Tiny safe expression language for sheet_query (where) and sheet_add_column (formula).
 * No eval, no Function. Grammar:
 *   or        := and ( ("OR"|"||") and )*
 *   and       := not ( ("AND"|"&&") not )*
 *   not       := ("NOT"|"!") not | cmp
 *   cmp       := add ( ("="|"=="|"!="|"<>"|">"|">="|"<"|"<="|"contains"|"startswith"|"endswith") add )?
 *   add       := mul ( ("+"|"-") mul )*
 *   mul       := unary ( ("*"|"/"|"%") unary )*
 *   unary     := "-" unary | primary
 *   primary   := number | string | "[" name "]" | bareword | "(" or ")"
 * Column names: [With Spaces] or bareword. Strings: 'single' or "double", doubled quote escapes.
 */

import { parseNumberForCompare } from "./num.js";

export type Row = Record<string, unknown>;

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "col"; v: string }
  | { t: "op"; v: string }
  | { t: "word"; v: string }
  | { t: "end" };

const WORD_OPS = new Set(["contains", "startswith", "endswith", "and", "or", "not", "true", "false", "null"]);

export class ExprError extends Error {}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "[") {
      const j = src.indexOf("]", i + 1);
      if (j < 0) throw new ExprError("unclosed [ in column name");
      out.push({ t: "col", v: src.slice(i + 1, j).trim() });
      i = j + 1; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = "";
      for (;;) {
        if (j >= src.length) throw new ExprError("unterminated string literal");
        if (src[j] === c) {
          if (src[j + 1] === c) { s += c; j += 2; continue; }
          j++; break;
        }
        if (src[j] === "\\" && (src[j + 1] === c || src[j + 1] === "\\")) { s += src[j + 1]; j += 2; continue; }
        s += src[j]; j++;
      }
      out.push({ t: "str", v: s });
      i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      if ((src[j] === "e" || src[j] === "E") && /[0-9+-]/.test(src[j + 1] ?? "")) { j += 2; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      const raw = src.slice(i, j).replace(/_/g, "");
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ExprError(`bad number: ${raw}`);
      out.push({ t: "num", v: n });
      i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (["!=", ">=", "<=", "==", "<>", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("=<>+-*/%()!".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      const w = src.slice(i, j);
      if (WORD_OPS.has(w.toLowerCase())) out.push({ t: "op", v: w.toLowerCase() });
      else out.push({ t: "word", v: w });
      i = j; continue;
    }
    throw new ExprError(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  out.push({ t: "end" });
  return out;
}

export type Node =
  | { k: "lit"; v: unknown }
  | { k: "col"; name: string }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "un"; op: string; e: Node };

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...v: string[]) => { const t = toks[p]; return t.t === "op" && v.includes(t.v); };
  const eat = (v: string) => { if (isOp(v)) { p++; return true; } return false; };

  function primary(): Node {
    const t = peek();
    if (t.t === "num") { p++; return { k: "lit", v: t.v }; }
    if (t.t === "str") { p++; return { k: "lit", v: t.v }; }
    if (t.t === "col") { p++; return { k: "col", name: t.v }; }
    if (t.t === "word") { p++; return { k: "col", name: t.v }; }
    if (t.t === "op" && (t.v === "true" || t.v === "false")) { p++; return { k: "lit", v: t.v === "true" }; }
    if (t.t === "op" && t.v === "null") { p++; return { k: "lit", v: null }; }
    if (isOp("(")) { p++; const e = or(); if (!eat(")")) throw new ExprError("missing )"); return e; }
    throw new ExprError(`unexpected ${t.t === "end" ? "end of expression" : JSON.stringify((t as any).v)}`);
  }
  function unary(): Node { if (isOp("-")) { p++; return { k: "un", op: "-", e: unary() }; } return primary(); }
  function mul(): Node {
    let l = unary();
    while (isOp("*", "/", "%")) { const op = (peek() as any).v; p++; l = { k: "bin", op, l, r: unary() }; }
    return l;
  }
  function add(): Node {
    let l = mul();
    while (isOp("+", "-")) { const op = (peek() as any).v; p++; l = { k: "bin", op, l, r: mul() }; }
    return l;
  }
  function cmp(): Node {
    const l = add();
    if (isOp("=", "==", "!=", "<>", ">", ">=", "<", "<=", "contains", "startswith", "endswith")) {
      let op = (peek() as any).v; p++;
      if (op === "==") op = "="; if (op === "<>") op = "!=";
      return { k: "bin", op, l, r: add() };
    }
    return l;
  }
  function not(): Node { if (isOp("not", "!")) { p++; return { k: "un", op: "not", e: not() }; } return cmp(); }
  function and(): Node {
    let l = not();
    while (isOp("and", "&&")) { p++; l = { k: "bin", op: "and", l, r: not() }; }
    return l;
  }
  function or(): Node {
    let l = and();
    while (isOp("or", "||")) { p++; l = { k: "bin", op: "or", l, r: and() }; }
    return l;
  }
  const e = or();
  if (peek().t !== "end") throw new ExprError("trailing input in expression");
  return e;
}

/**
 * v3 #7: one shared locale-aware parser. A value the CSV layer preserved as text ("007")
 * is not a number here either, and "12,99" is 12.99 rather than 1299, so `[Code] = 7` is
 * false on "007" and `[Price] > 13` is false on "12,99".
 */
function num(v: unknown): number | null {
  return parseNumberForCompare(v);
}

/** True when the value is text that carries no number at all (so ordering it is meaningless). */
function isNonNumericText(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "" && num(v) === null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") { const s = v.trim().toLowerCase(); return s !== "" && s !== "false" && s !== "0" && s !== "no"; }
  return true;
}

function lookup(row: Row, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const lower = name.toLowerCase().trim();
  for (const k of Object.keys(row)) if (k.toLowerCase().trim() === lower) return row[k];
  return null;
}

export function evaluate(node: Node, row: Row): unknown {
  switch (node.k) {
    case "lit": return node.v;
    case "col": return lookup(row, node.name);
    case "un": {
      if (node.op === "not") return !truthy(evaluate(node.e, row));
      const n = num(evaluate(node.e, row));
      return n === null ? null : -n;
    }
    case "bin": {
      const op = node.op;
      if (op === "and") return truthy(evaluate(node.l, row)) && truthy(evaluate(node.r, row));
      if (op === "or") return truthy(evaluate(node.l, row)) || truthy(evaluate(node.r, row));
      const a = evaluate(node.l, row);
      const b = evaluate(node.r, row);
      switch (op) {
        case "+": {
          const x = num(a), y = num(b);
          if (x === null || y === null) {
            if (typeof a === "string" || typeof b === "string") return str(a) + str(b);
            return null;
          }
          return x + y;
        }
        case "-": case "*": case "/": case "%": {
          const x = num(a), y = num(b);
          if (x === null || y === null) return null;
          if (op === "-") return x - y;
          if (op === "*") return x * y;
          if (y === 0) return null;
          return op === "/" ? x / y : x % y;
        }
        case "contains": return str(a).toLowerCase().includes(str(b).toLowerCase());
        case "startswith": return str(a).toLowerCase().startsWith(str(b).toLowerCase());
        case "endswith": return str(a).toLowerCase().endsWith(str(b).toLowerCase());
        case "=": case "!=": {
          let eq: boolean;
          const x = num(a), y = num(b);
          if (x !== null && y !== null) eq = x === y;
          else eq = str(a).trim().toLowerCase() === str(b).trim().toLowerCase();
          return op === "=" ? eq : !eq;
        }
        case ">": case ">=": case "<": case "<=": {
          const x = num(a), y = num(b);
          let c: number;
          if (x !== null && y !== null) c = x < y ? -1 : x > y ? 1 : 0;
          // v3 #8: a number against non-numeric text has no order. Comparing them
          // lexically made [v] > 2 true for "abc"; the pair is simply not comparable.
          else if ((x !== null && isNonNumericText(b)) || (y !== null && isNonNumericText(a))) return false;
          else {
            const sa = str(a).toLowerCase(), sb = str(b).toLowerCase();
            c = sa < sb ? -1 : sa > sb ? 1 : 0;
          }
          if (op === ">") return c > 0;
          if (op === ">=") return c >= 0;
          if (op === "<") return c < 0;
          return c <= 0;
        }
      }
      throw new ExprError(`unknown operator ${op}`);
    }
  }
}

/** Compile once, run per row. Returns a predicate/value function. */
export function compile(src: string): (row: Row) => unknown {
  const ast = parse(src);
  return (row: Row) => evaluate(ast, row);
}
export function compilePredicate(src: string): (row: Row) => boolean {
  const f = compile(src);
  return (row: Row) => truthy(f(row));
}
/** Column names referenced by an expression (for error messages). */
export function columnsUsed(node: Node, acc = new Set<string>()): Set<string> {
  if (node.k === "col") acc.add(node.name);
  else if (node.k === "bin") { columnsUsed(node.l, acc); columnsUsed(node.r, acc); }
  else if (node.k === "un") columnsUsed(node.e, acc);
  return acc;
}
