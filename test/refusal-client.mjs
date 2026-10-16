import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, lstatSync, readdirSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function localClient({ setup, env = {} } = {}) {
  const root = join(homedir(), 'mcp-servers-work');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'r37-cap-'));
  if (setup) await setup(dir);
  const client = new Client({ name: 'refusal-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, TMPDIR: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), MCP_LICENSE_KEY: '', ...env },
    stderr: 'pipe',
  });
  async function cleanup() {
    let open;
    for (let attempt = 0; attempt < 20; attempt++) {
      open = spawnSync(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-t', '+D', dir], { encoding: 'utf8' });
      if (open.status === 1 && !open.stdout.trim()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (open.status !== 1 || open.stdout.trim()) throw new Error(`Refusing cleanup: lsof ${open.status}: ${open.stdout} ${open.stderr}`);
    function size(path) {
      const stat = lstatSync(path);
      return stat.isDirectory() ? readdirSync(path).reduce((n, file) => n + size(join(path, file)), 0) : stat.size;
    }
    const manifest = existsSync(new URL('../../../data/', import.meta.url))
      ? new URL('../../../data/build-deletions.jsonl', import.meta.url)
      : new URL('../cleanup-manifest.jsonl', import.meta.url);
    appendFileSync(manifest, JSON.stringify({ path: dir, bytes: size(dir), lsof: 'no open handles', at: new Date().toISOString(), purpose: 'R37 real free-cap stdio regression' }) + '\n');
    rmSync(dir, { recursive: true });
  }
  try { await client.connect(transport); }
  catch (error) { await transport.close(); await cleanup(); throw error; }
  return {
    dir,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { ...result, text: result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '' };
    },
    async close() { await client.close(); await cleanup(); },
  };
}
