import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, sniffDelimiter, toCsv, coerce } from "../dist/csv.js";

test("quoted commas stay in one field", () => {
  const { rows } = parseCsv('a,b\n"Smith, John",42\n');
  assert.deepEqual(rows, [["a", "b"], ["Smith, John", "42"]]);
});

test("CRLF line endings", () => {
  const { rows } = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
  assert.deepEqual(rows, [["a", "b"], ["1", "2"], ["3", "4"]]);
});

test("embedded newline inside quotes", () => {
  const { rows } = parseCsv('note,n\n"line one\nline two",7\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], "line one\nline two");
  assert.equal(rows[1][1], "7");
});

test("doubled quotes unescape", () => {
  const { rows } = parseCsv('a\n"he said ""hi"""\n');
  assert.equal(rows[1][0], 'he said "hi"');
});

test("semicolon delimiter is sniffed", () => {
  const text = "name;qty;price\nWidget;2;3,50\nGadget;1;9,00\n";
  assert.equal(sniffDelimiter(text), ";");
  const { rows, delimiter } = parseCsv(text);
  assert.equal(delimiter, ";");
  assert.deepEqual(rows[1], ["Widget", "2", "3,50"]);
});

test("tab delimiter is sniffed", () => {
  const text = "a\tb\tc\n1\t2\t3\n";
  assert.equal(sniffDelimiter(text), "\t");
  assert.deepEqual(parseCsv(text).rows[1], ["1", "2", "3"]);
});

test("comma wins over stray semicolons in data", () => {
  const text = 'a,b,c\n"x; y",2,3\nq,4,5\n';
  assert.equal(sniffDelimiter(text), ",");
});

test("BOM is stripped from the first header", () => {
  const { rows } = parseCsv("﻿id,name\n1,x\n");
  assert.equal(rows[0][0], "id");
});

test("trailing newline does not create an empty row", () => {
  assert.equal(parseCsv("a,b\n1,2\n").rows.length, 2);
  assert.equal(parseCsv("a,b\n1,2").rows.length, 2);
});

test("empty fields are preserved", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,,3\n").rows[1], ["1", "", "3"]);
});

test("round trip through toCsv re-parses identically", () => {
  const rows = [["a", "b"], ['comma, here', 'quote " here'], ["multi\nline", 5]];
  const round = parseCsv(toCsv(rows)).rows;
  assert.deepEqual(round, [["a", "b"], ["comma, here", 'quote " here'], ["multi\nline", "5"]]);
});

test("coerce keeps leading zeros as text but converts real numbers", () => {
  assert.equal(coerce("007"), "007");
  assert.equal(coerce("42"), 42);
  assert.equal(coerce("-1.5"), -1.5);
  assert.equal(coerce("hello"), "hello");
  assert.equal(coerce(""), "");
});
