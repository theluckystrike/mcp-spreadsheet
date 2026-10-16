// Standalone test helper copied into mirrors; never deletes another run's scope.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const base = process.env.TMPDIR || join(homedir(), 'mcp-servers-work');
mkdirSync(base, { recursive: true });
export const TEST_TMP_ROOT = mkdtempSync(join(base, `mcp-test-run-${process.pid}-`));
process.env.TMPDIR = TEST_TMP_ROOT;
export function removeTree(input) {
  const path = resolve(input), rel = relative(TEST_TMP_ROOT, path);
  if (rel.startsWith('..') || rel.startsWith('/')) throw Error('Refusing test cleanup outside this run');
  if (!existsSync(path)) return;
  if (path !== TEST_TMP_ROOT) {
    const parent = realpathSync(dirname(path)), scope = realpathSync(TEST_TMP_ROOT);
    if (parent !== scope && !parent.startsWith(scope + '/')) throw Error('Refusing test cleanup through a symlink outside this run');
  }
  const stat = lstatSync(path);
  const open = spawnSync('lsof', stat.isDirectory() ? ['-t', '+D', path] : ['-t', '--', path], { encoding: 'utf8' });
  if (open.error || open.status !== 1 || open.stdout.trim()) return;
  const bytes = p => { const s = lstatSync(p); return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + bytes(join(p, f)), 0) : s.size; };
  appendFileSync(new URL('../cleanup-manifest.jsonl', import.meta.url), JSON.stringify({ at: new Date().toISOString(), path, bytes: bytes(path), lsof: 'no open handles', reason: 'completed standalone test scope' }) + '\n');
  const unlock = p => { const s = lstatSync(p); if (s.isDirectory()) { chmodSync(p, 0o700); for (const name of readdirSync(p)) unlock(join(p, name)); } };
  unlock(path); rmSync(path, { recursive: stat.isDirectory(), force: true, maxRetries: 3 });
}
let done = false;
function cleanup() { if (done) return; done = true; try { removeTree(TEST_TMP_ROOT); } catch { /* retain instead of unsafe removal */ } }
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  const handler = () => { cleanup(); process.removeListener(signal, handler); process.kill(process.pid, signal); };
  process.on(signal, handler);
}
