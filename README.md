# mcp-spreadsheet

![spreadsheet demo](https://raw.githubusercontent.com/theluckystrike/mcp-servers/main/assets/demo-spreadsheet.gif)

**One-click install:** download `spreadsheet.mcpb` from the [latest release](https://github.com/theluckystrike/mcp-servers/releases/latest) and double-click it in Claude Desktop.

**Hosted endpoint (no install):** `https://mcp.zovo.one/mcp/spreadsheet` (streamable-http; send `Authorization: Bearer <Pro key or anonymous token from https://mcp.zovo.one/mcp/token>`).

Read-only mirror of [mcp-servers/servers/spreadsheet](https://github.com/theluckystrike/mcp-servers/tree/main/servers/spreadsheet). See [MIRROR.md](MIRROR.md).


Hand your AI assistant a spreadsheet and talk to it. Point it at any `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`, `.csv` or `.tsv` file on your machine and ask what is in it, filter it, compute a new column, or save it in another format. It handles the messy parts of real files for you: it guesses which row holds the headers, sniffs whether a CSV is separated by commas, semicolons or tabs, keeps quoted commas and newlines intact, reads numbers out of `$1,250.00` style text, and reports per-column types and empty counts. It never edits your original file: every write goes to a new path unless you explicitly choose `overwrite`. Nothing leaves the machine, and there is no API key to get.


**Read, query and extend real spreadsheets from chat without ever touching the original file.**

## 60-second install

npm publish for `@theluckystrike/mcp-spreadsheet` is pending. Until then, the `.mcpb` one-click bundle or a clone+build
is the working path -- both are verified below.

**One-click (.mcpb):** download `spreadsheet.mcpb` from the latest release and double-click it in Claude Desktop:
https://github.com/theluckystrike/mcp-servers/releases/latest

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "spreadsheet": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-spreadsheet"]
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add spreadsheet -- npx -y @theluckystrike/mcp-spreadsheet
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "spreadsheet": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-spreadsheet"]
    }
  }
}
```

The `npx` form above starts working the moment the package is published. Until then, use the .mcpb bundle above, or
build from source with exactly these three commands:

```sh
git clone https://github.com/theluckystrike/mcp-servers.git && cd mcp-servers
npm install
npm run build -w packages/mcp-license -w servers/spreadsheet
```

Then point your client's `command` at `node` with one arg: the absolute path to `servers/spreadsheet/dist/index.js`.

To run in Pro mode set `MCP_LICENSE_KEY` in the same config block, or call `license_activate` once with your key.

## Tools

| Tool | What it does |
| --- | --- |
| `sheet_info` | Sheet names, size, guessed header row, per-column type, sample values, empty counts |
| `sheet_read` | Read rows as a text table, JSON records or CSV; `limit`/`offset` paging or an A1 `range` |
| `sheet_query` | Filter with `where`, `group_by` + `aggregate` (sum, count, avg, min, max), pick columns with `select`, `sort` (aggregate aliases too), `limit` |
| `sheet_stats` | count, empty, distinct, min, max, sum, mean, median per column (top values for text columns) |
| `sheet_find` | Find text anywhere in the workbook; returns cell addresses and a row preview |
| `sheet_write` | Write rows (objects or arrays) as a new file, an append, or an explicit overwrite |
| `sheet_add_column` | Add a computed column from a formula, saved to a new file. Numeric results are rounded like their inputs (2 decimals in, 2 decimals out); `decimals` overrides |
| `sheet_convert` | Convert a sheet to csv, xlsx or json |
| `license_status` | Free or Pro, and where to upgrade |
| `license_activate` | Activate a Pro key (verified offline) |

Resource template: `sheet://<path>` returns the `sheet_info` summary for that file.
Resource: `sheet://recent` lists the files this server has opened since it started, most recent first (in memory only -- nothing is written to disk, so the list is empty again after a restart).

Prompt: `explore_sheet` walks an unfamiliar file -- `sheet_info` first, then concrete `sheet_query` calls built from the columns it actually found.

## What you can say

| You say | Tool |
| --- | --- |
| "Open sales.xlsx and tell me what's in it." | `sheet_info` |
| "Show me the first 50 rows." | `sheet_read` |
| "Which rep sold the most units in the North region? Top 5 with totals." | `sheet_query` (`group_by` + `aggregate`) |
| "How many empty cells are in the Email column, and what's the median order size?" | `sheet_stats` |
| "Find every row that mentions 'refund'." | `sheet_find` |
| "Write this as a new sheet called Q3 Results." | `sheet_write` |
| "Add a Revenue column that's Units times Unit Price, save it as a CSV next to the original." | `sheet_add_column` |
| "Convert this xlsx to JSON." | `sheet_convert` |
| "Am I on the free plan or Pro?" | `license_status` |
| "Here's my license key, activate it." | `license_activate` |

## Worked example

From `docs/USER_VALUE_R2.md`, a 400-row fixture with a title row and a blank row above the real header
(row 3), sheets `Sales` / `Reps` / `Notes`, prices stored as strings like `"1,516.16"`. One call, ground
truth confirmed against the generator: Turing 650, Hopper 567, Linus T 551, Lovelace 486, Liskov 290.

```
You: Which rep sold the most units in the North region? Top 5 with totals.

  sheet_query {
    path: "/Users/you/sales.xlsx", sheet: "Sales",
    where: "[Region] = \"North\"",
    group_by: ["Rep"],
    aggregate: [{ col: "Units", fn: "sum", as: "total_units" }],
    sort: { col: "total_units", dir: "desc" },
    limit: 5
  }

Assistant: Query: where [Region] = "North"; group by Rep; sum Units as total_units;
sort total_units desc; limit 5
5 groups from 102 of 400 rows, showing 5

Alan Turing     650
Grace Hopper    567
Linus T         551
Ada Lovelace    486
Barbara Liskov  290
```

The response now echoes the exact query it ran (the `Query:` line) before the numbers, so a filter you
did not ask for -- an accidental `AND [Status] = "Closed"`, say -- is visible instead of silently
narrowing the answer.

A second example, adding a column and saving without touching the source:

```
You: Add a Revenue column and save it as a CSV next to the original.

  sheet_add_column {
    path: "/Users/you/sales.xlsx", sheet: "Sales",
    name: "Revenue", formula: "[Units] * [Unit Price]",
    out_path: "/Users/you/sales.csv"
  }

Assistant: Wrote 400 rows (401 lines with header) to sales.csv.
Revenue = Units * Unit Price on every row, total 10,142,542.04.
Source file untouched.
```

### The `where` and `formula` language

A small expression language, parsed and evaluated directly. There is no `eval` and no code execution: a bare word is always a column name, never a JavaScript value.

- Columns: `[Unit Price]` for names with spaces, `Qty` otherwise. Lookup is case insensitive.
- Comparisons: `=` `!=` `>` `>=` `<` `<=` `contains` `startswith` `endswith`
- Logic: `AND` `OR` `NOT` and parentheses. `AND` binds tighter than `OR`.
- Arithmetic in formulas: `+` `-` `*` `%` `/` with the usual precedence.
- Strings: `'single'` or `"double"` quotes; double a quote to escape it.

```
[Qty] >= 5 AND ([Status] = "open" OR [Region] contains "north")
[Amount] > 1000 AND NOT [Customer] startswith 'Test'
```

Formula example for `sheet_add_column`: `[Qty] * [Unit Price]`. When every column the formula reads holds at most 2 decimals, the result is rounded to 2 decimals, so `[Amount] * 1.23` on money gives `40.79` rather than `40.7868`. Pass `decimals` (0-10) to choose the precision yourself.

Numbers written as text in a CSV are converted by pattern, not by length: `1250.00`, `12.00` and `1,250.00` all become numbers in the xlsx output, so Excel's own `SUM` counts them. Identifier-shaped and ambiguous values stay text: `007` keeps its leading zeros and `1.250,00` is left alone rather than guessed at.

Text comparisons ignore case and surrounding whitespace. Values like `$1,250.00`, `1 250`, and `12%` compare as numbers, so `[Amount] > 1000` works on a column your spreadsheet stored as text.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Every tool that reads a file (`sheet_info`, `sheet_read`, `sheet_query`, `sheet_stats`, `sheet_find`, `sheet_add_column`, `sheet_convert`) | Files up to 5 MB and 5,000 rows | No limit (up to the 50 MB file ceiling) |
| `sheet_write`, `sheet_add_column`, `sheet_convert` | Up to 500 rows written per file; over that nothing is written and the tool says so | No limit |
| Sheets, formats, expression language | All | All |

Over a free read limit the tool still does the work and returns the part it is allowed to return (the first 5,000 rows), with a note saying what was left out. Over the free write limit nothing at all is written: a partial file that looks complete is worse than no file, so the tool refuses, tells you the row count and the cap, and suggests a free workaround (filter the rows down first, or write in 500-row batches). Nothing fails silently.

## Get Pro

$19 one-time for this server, $39 for every server, lifetime: https://mcp.zovo.one/buy/spreadsheet

## How it stores data

This server keeps no database of its own -- it reads and writes the spreadsheet files you point it at,
directly on your disk, and nothing else. Every write (`sheet_write`, `sheet_add_column`, `sheet_convert`
in `overwrite` mode) goes to a temporary file in the same directory first, then is renamed into place, so
an interrupted write leaves either the untouched original or the complete new file, never a truncated
one. Because there is no shared state file, there is no advisory lock to take: two calls writing to two
different output paths cannot collide, and a call to `overwrite` the same file twice in a row is simply
two writes in sequence. To back up your data, back up the spreadsheet files themselves -- there is
nothing else to copy.

## Limits and honest caveats

- Free reads cap at 5,000 rows and 5 MB; free writes cap at 500 rows per file and **refuse rather than
  truncate** -- you get an error naming the row count and the cap, never a shorter file that looks
  complete.
- The hard ceiling is 50 MB regardless of tier; a file over that is refused outright with a clear message
  rather than risking memory exhaustion.
- The `where`/`formula` language is intentionally small: no regular expressions, no custom functions,
  no cross-sheet references in a single formula. It covers comparisons, boolean logic and arithmetic,
  nothing more.
- **Writing an xlsx replaces one sheet, not the workbook.** `sheet_write` with `append` or `overwrite`
  reads the whole workbook, swaps the sheet you named and writes every other sheet back, so
  `Sheet2` and its data survive an append to `Sheet1`. What is *not* preserved is the sheet being
  written: it is rebuilt from values, so formulas, cell formatting, conditional formatting, charts,
  data validation and merged cells on **that one sheet** become plain values. Other sheets keep their
  cells as read. Take a copy first if the target sheet carries formatting you cannot recreate.
- **Numbers written as text are read with locale-aware rules.** `1,250.00`, `1 250.00`, `$1,250.00`,
  `12,99`, `1.234,56` and `EUR 1 250,00` all read as numbers; a decimal comma is only accepted in the
  unambiguous shape (a comma with exactly two digits at the end, dots or spaces grouping). Anything
  that mixes separators another way (`1,2500.00`) stays text rather than being guessed at. Values
  with leading zeros (`007`) and integers too large for exact arithmetic
  (over 9,007,199,254,740,991) stay text so they are never silently altered.
- **Dates keep their cell type.** A date cell read from an xlsx stays a date through queries and
  through a conversion back to xlsx. In text, CSV and JSON output it is rendered as ISO:
  `2026-09-04` for a date, `2026-09-03T15:30:00` when the cell carries a time.
- `sheet_info`'s header-row guess is a heuristic (looks for the first row with lower emptiness and higher
  text density than the rows above it). It handles a title row and a blank row above the header; it is
  not proof against every layout, and you can always confirm what it picked before querying.

## Troubleshooting

- **`npx` hangs or fails to find the package**: npm publish for this package is pending. Use the `.mcpb`
  bundle or the clone-and-build path above until it lands.
- **Using the `.mcpb` bundle**: it installs into Claude Desktop directly; there is no separate config
  step.
- **Using the clone path**: the server binary is `servers/spreadsheet/dist/index.js` after
  `npm run build`. Point your client's `command` at `node` with that absolute path as the only argument.
- **Node version**: requires Node >= 18. Check with `node -v`.
- **"Path does not exist"**: the message includes the resolved absolute path (with `~` expanded) -- check
  it against where the file actually lives, especially inside a sandboxed or containerized client.
- **A write is refused with a row-count message**: you hit the free 500-row write cap. Filter the data
  down with `sheet_query` first, write in batches, or activate Pro.
- **Nothing shows up / silent failures**: logs go to stderr only, never stdout. In Claude Desktop check
  Settings -> Developer -> the server's log file; in Claude Code check the terminal or `--mcp-debug`.

## Safety

- Paths that do not exist are refused with the resolved path in the message; `~` is expanded.
- Files over 50 MB are refused with a clear message rather than exhausting memory.
- `sheet_add_column` and `sheet_convert` write to a new file and refuse to clobber an existing one unless you pass `out_path` yourself.
- `sheet_write` with `mode: "new_file"` refuses to write over an existing file. Only `mode: "overwrite"` replaces file contents.
- Output files are written to a temporary name and renamed into place, so an interrupted write cannot truncate a file.

## Privacy

All data stays local. Files are read from and written to your own disk, license keys are verified offline with an embedded public key, and the server makes no network requests at all.

## Pairs with

- [mcp-time-tracker](../time-tracker/README.md) -- export a CSV with `export_csv`, then query and reshape it here.
- [mcp-invoice](../invoice/README.md) -- pull line items out of a spreadsheet before turning them into an invoice.
- [mcp-price-tracker](../price-tracker/README.md) -- analyze exported price history as a sheet.
- [office-suite](../office-suite/README.md) -- all four servers behind one install, one config entry.
- Guide: [Ask questions about an Excel or CSV file from Cursor or Claude](https://mcp.zovo.one/guides/read-excel-in-cursor)

## FAQ

**Does it handle a spreadsheet with a title row above the headers?**
Yes. `sheet_info` guesses the header row and reports which row it picked, so an export with a title line
and a blank line above the real headers opens correctly without you specifying anything.

**Can it group and sum, or does it only filter?**
It groups. `sheet_query` takes `group_by` plus `aggregate` with sum, count, avg, min or max, and can sort
by an aggregate alias, so top-N-by-category questions are a single call.

**Will it overwrite my original file?**
No, not unless you explicitly pass an output path that points at the source. `sheet_add_column` and
`sheet_convert` write a new file next to the original by default.

**What happens on the free tier with a file bigger than the limit?**
Reads return the first 5,000 rows with a note naming what was omitted. Writes over 500 rows are refused
outright rather than producing a truncated file, and the message tells you the row count, the cap and a
free way round.

**Is my data sent anywhere?**
No. The server runs locally on your machine and reads your files directly. It makes no network requests,
and it stores nothing of its own beyond the files you ask it to write.

Built by [theluckystrike](https://github.com/theluckystrike). Support: support@zovo.one
