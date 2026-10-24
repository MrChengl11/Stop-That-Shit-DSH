/**
 * probe-control.mjs - how the RAW (unmapped) STS config treats DSH's own
 * non-file tools while a file contract is armed.
 *
 * The point: `unknown` is not the only failure mode. STS's Codex-name fallback
 * (lead-sts/src/adapters/codex-tool-classifier.cjs:8) treats any name containing
 * send/create/update/write/set/... as a WRITE, so todo_write / create_goal /
 * send_message become mutating tools with zero provable paths and fail closed.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const NL2 = String.fromCharCode(10);
const cwd = process.cwd();
const label = process.argv[3] || 'control-raw';
const dataDir = resolve('.sts-data', label);
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
process.env.PLUGIN_DATA = dataDir;

const configArg = process.argv[2] || resolve('..', 'lead-sts', 'hooks', 'hooks.json');
const { ctx } = await loadBridge({
  configPath: resolve(configArg),
  pluginRoot: resolve('..', 'lead-sts'),
  cwd,
});
const agent = makeAgent({ id: 'sess-control', cwd });
const signal = new AbortController().signal;
const exec = (name, args, callId) => ({ name, arguments: args, callId, agent, signal });

await dispatchPreStep(ctx, { agent, text: '$stop-that-shit change files=src/app.ts -- add the counter', turn: 1 });

const cases = [
  ['todo_write', { todos: [{ content: 'x', status: 'pending' }] }],
  ['send_message', { agent_id: 'a', message: 'm' }],
  ['create_goal', { objective: 'o' }],
  ['update_goal', { goal_id: 'g', revision: 1, action: 'complete' }],
  ['present', { files: [{ path: 'a.md' }] }],
  ['list_agents', {}],
  ['read', { path: 'src/app.ts' }],
];

const rows = [];
for (const [name, args] of cases) {
  const decision = await dispatchPreExecute(ctx, exec(name, args, 'k-' + name));
  const reasonCode = /Code: (S\/[A-Z_]+)/.exec(decision.reason || '');
  rows.push({
    tool: name,
    decisionKind: decision.kind,
    reasonCode: reasonCode ? reasonCode[1] : null,
    reasonHead: decision.reason ? decision.reason.split(NL2).slice(0, 4).join(' | ') : null,
  });
}
writeFileSync(resolve('results', 'control-tools-' + label + '.json'), JSON.stringify(rows, null, 2) + NL2);
for (const r of rows) console.log(r.tool.padEnd(14), r.decisionKind.padEnd(6), String(r.reasonCode).padEnd(24), r.reasonHead || '');