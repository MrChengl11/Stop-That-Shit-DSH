/**
 * timeout-probe.mjs — is the hooks.json `timeout` field SECONDS or MILLISECONDS?
 *
 * Claude Code documents `timeout` in seconds. The bridge multiplies it by 1000
 * (dsh-hook-protocol lib/index.js:199). This probe proves the behaviour by running
 * the same 2500 ms hook under three configs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBridge, dispatchPreExecute, makeAgent } from './harness.mjs';

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const toPosix = (p) => p.split(BS).join(chr47());
function chr47() { return String.fromCharCode(47); }
const slow = toPosix(resolve('slow-hook.cjs'));
mkdirSync(resolve('fixtures'), { recursive: true });

const cases = [
  ['timeout-1s-vs-2500ms-hook', { timeout: 1 }],
  ['timeout-5s-vs-2500ms-hook', { timeout: 5 }],
  ['no-timeout-default-600000ms', {}],
];

const cwd = process.cwd();
const agent = makeAgent({ id: 'sess-timeout', cwd });
const signal = new AbortController().signal;
const rows = [];

for (const [label, extra] of cases) {
  const command = 'node "' + slow + '" 2500 PreToolUse';
  const hook = { type: 'command', command, statusMessage: 'Checking the Stop Ladder...', ...extra };
  const configPath = resolve('fixtures', 'hooks-' + label + '.json');
  writeFileSync(configPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [hook] }] },
  }, null, 2) + NL);
  const { ctx } = await loadBridge({ configPath, pluginRoot: resolve('..', 'lead-sts'), cwd });
  const started = Date.now();
  const decision = await dispatchPreExecute(ctx, {
    name: 'read', arguments: { path: 'src/app.ts' }, callId: 't1', agent, signal,
  });
  rows.push({ label, configTimeout: extra.timeout ?? null, wallMs: Date.now() - started, decision });
}

writeFileSync(resolve('results', 'timeout-probe.json'), JSON.stringify(rows, null, 2) + NL);
console.log(JSON.stringify(rows, null, 2));
