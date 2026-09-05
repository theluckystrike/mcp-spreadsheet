import test from "node:test";
import assert from "node:assert/strict";
import { compile, compilePredicate, parse, tokenize, ExprError } from "../dist/expr.js";

const row = {
  "Qty": 4,
  "Unit Price": 12.5,
  "Region": "North West",
  "Status": "open",
  "Note": 'he said "hi"',
  "Empty": null,
  "Amount": "$1,250.00",
};

const p = (src) => compilePredicate(src)(row);
const v = (src) => compile(src)(row);

test("comparison on a bracketed column", () => {
  assert.equal(p("[Qty] > 3"), true);
  assert.equal(p("[Qty] > 4"), false);
  assert.equal(p("[Qty] >= 4"), true);
  assert.equal(p("[Qty] <= 3"), false);
});

test("bare column names without spaces", () => {
  assert.equal(p("Qty = 4"), true);
  assert.equal(p("Status != 'closed'"), true);
});

test("string equality is case and whitespace insensitive", () => {
  assert.equal(p("[Status] = 'OPEN'"), true);
  assert.equal(p('[Status] = " open "'), true);
});

test("contains / startswith / endswith", () => {
  assert.equal(p("[Region] contains 'west'"), true);
  assert.equal(p("[Region] contains 'south'"), false);
  assert.equal(p("[Region] startswith 'North'"), true);
  assert.equal(p("[Region] endswith 'West'"), true);
});

test("AND binds tighter than OR", () => {
  // false AND false OR true  ->  (false AND false) OR true  -> true
  assert.equal(p("[Qty] > 100 AND [Qty] < 0 OR [Status] = 'open'"), true);
  // true OR false AND false -> true OR (false AND false) -> true
  assert.equal(p("[Status] = 'open' OR [Qty] > 100 AND [Qty] < 0"), true);
  // with parentheses the same tokens flip
  assert.equal(p("([Status] = 'open' OR [Qty] > 100) AND [Qty] < 0"), false);
});

test("parentheses group correctly", () => {
  assert.equal(p("([Qty] = 4 OR [Qty] = 5) AND [Region] contains 'north'"), true);
  assert.equal(p("[Qty] = 4 OR ([Qty] = 5 AND [Region] contains 'zzz')"), true);
});

test("NOT negates", () => {
  assert.equal(p("NOT [Status] = 'closed'"), true);
  assert.equal(p("!([Qty] > 3)"), false);
});

test("arithmetic precedence in formulas", () => {
  assert.equal(v("[Qty] * [Unit Price]"), 50);
  assert.equal(v("1 + 2 * 3"), 7);
  assert.equal(v("(1 + 2) * 3"), 9);
  assert.equal(v("-[Qty] + 10"), 6);
  assert.equal(v("[Qty] / 8"), 0.5);
});

test("quoted strings with embedded quotes", () => {
  assert.equal(p(`[Note] contains 'said "hi"'`), true);
  assert.equal(p(`[Note] = 'he said "hi"'`), true);
  assert.equal(tokenize(`'it''s'`)[0].v, "it's");
  assert.equal(tokenize(`"a\\"b"`)[0].v, 'a"b');
});

test("currency and comma text compares numerically", () => {
  assert.equal(p("[Amount] > 1000"), true);
  assert.equal(p("[Amount] < 1000"), false);
});

test("missing and empty columns are falsy, never throw", () => {
  assert.equal(p("[Empty] = ''"), true);
  assert.equal(p("[No Such Column] contains 'x'"), false);
  assert.equal(v("[No Such Column] * 2"), null);
});

test("string concatenation when a side is not numeric", () => {
  assert.equal(v("[Region] + '!' "), "North West!");
});

test("division by zero yields null instead of Infinity", () => {
  assert.equal(v("[Qty] / 0"), null);
});

test("column lookup is case insensitive", () => {
  assert.equal(p("[unit price] = 12.5"), true);
});

test("malformed expressions raise ExprError", () => {
  assert.throws(() => parse("[Qty] >"), ExprError);
  assert.throws(() => parse("[Qty"), ExprError);
  assert.throws(() => parse("'unterminated"), ExprError);
  assert.throws(() => parse("1 2"), ExprError);
});

test("no code execution: identifiers are columns, not globals", () => {
  assert.equal(compile("process")({}), null);
  assert.equal(compile("constructor")({}), null);
});
