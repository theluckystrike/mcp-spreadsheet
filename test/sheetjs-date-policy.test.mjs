import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { localClient } from './refusal-client.mjs';

// Fixed XLSX bytes, independent of SheetJS Date-object serialization. The numeric
// fixture stores literal Excel serials 46268 + 15.5/24 and 46269. The ISO fixture
// stores literal type-d XML values 2026-09-03T15:30:00.000Z and 2026-09-04T00:00:00.000Z.
// Both represent these worksheet clock values in every client timezone.
const expected = [{ When: '2026-09-03T15:30:00' }, { When: '2026-09-04' }];
const timezones = ['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York'];
const formats = ['numeric', 'iso'];

test('literal numeric and ISO worksheet dates survive read, conversion and cross-timezone reads', async () => {
  const clients = [];
  const converted = [];
  let calls = 0;
  async function call(client, name, args) {
    calls++;
    const result = await client.call(name, args);
    assert.equal(!!result.isError, false, result.text);
    return result.text;
  }
  try {
    for (const TZ of timezones) {
      const client = await localClient({ env: { TZ } });
      clients.push({ TZ, client });
      for (const format of formats) {
        const path = join(client.dir, `${format}.xlsx`);
        copyFileSync(new URL(`./fixtures/canonical-${format}-dates.xlsx`, import.meta.url), path);
        assert.deepEqual(JSON.parse(await call(client, 'sheet_read', { path, as: 'json' })), expected, `${TZ}: ${format} read`);
        const out = join(client.dir, `${format}-converted.xlsx`);
        await call(client, 'sheet_convert', { path, to: 'xlsx', out_path: out });
        assert.deepEqual(JSON.parse(await call(client, 'sheet_read', { path: out, as: 'json' })), expected, `${TZ}: ${format} reread`);
        converted.push({ writer: TZ, format, path: out });
      }
    }
    for (const { TZ, client } of clients) {
      for (const file of converted) {
        assert.deepEqual(JSON.parse(await call(client, 'sheet_read', { path: file.path, as: 'json' })), expected,
          `${file.writer} -> ${TZ}: ${file.format}`);
      }
    }
    assert.equal(calls, 36);
  } finally {
    for (const { client } of clients.reverse()) await client.close();
  }
});
