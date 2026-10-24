
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const cwd = mkdtempSync(join(tmpdir(), 'sts-unarmed-'));
mkdirSync(join(cwd, 'src'), { recursive: true });
writeFileSync(join(cwd, 'src/app.ts'), 'export const a = 1;\n');
const configPath = join(process.cwd(), 'hooks-raw.json');
const pluginRoot = process.argv[2];
const bridge = await loadBridge({ configPath, pluginRoot, projectDir: cwd, cwd });
const agent = makeAgent({ id: 'dsh-unarmed-sess', cwd });
console.log('warnings:', JSON.stringify(bridge.ctx.__warnings ?? []));
// No $stop-that-shit directive at all — ordinary prompt.
const r = await dispatchPreStep(bridge.ctx, { agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'please fix the bug in src/app.ts' }] }], turn: 1 });
console.log('plain prompt ->', JSON.stringify(r ?? null));
for (const [name, args] of [
  ['read', { path: 'src/app.ts' }],
  ['write', { path: 'src/app.ts', content: 'x' }],
  ['bash', { command: 'git status' }],
  ['bash', { command: 'rm -rf build' }],
  ['glob', { pattern: '**/*.ts' }],
  ['run_code', { code: 'console.log(1)' }],
  ['subagent', { prompt: 'do it' }],
]) {
  const g = await dispatchPreExecute(bridge.ctx, { callId: 'c-' + name, name, arguments: args, agent });
  console.log('UNARMED', name.padEnd(10), '->', JSON.stringify(g).slice(0, 120));
}
