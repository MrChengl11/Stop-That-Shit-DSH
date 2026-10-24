/**
 * probe-latency.mjs - per-tool-call overhead of running STS through the bridge.
 * Every DSH tool call with a matching PreToolUse group spawns a fresh node
 * process (hook-protocol runner -> ctx.shell.execute), so measure the round trip.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const NL2 = String.fromCharCode(10);
const cwd = process.cwd();
const label = process.argv[2] || 'raw';
const configPath = process.argv[3] || resolve('..', 'lead-sts', 'hooks', 'hooks.json');
const dataDir = resolve('.sts-data', 'latency-' + label);
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
process.env.PLUGIN_DATA = dataDir;

const { ctx } = await loadBridge({ configPath: resolve(configPath), pluginRoot: resolve('..', 'lead-sts'), cwd });
const agent = makeAgent({ id: 'sess-latency', cwd });
const signal = new AbortController().signal;
await dispatchPreStep(ctx, { agent, text: '$stop-that-shit change files=src/app.ts -- add the counter', turn: 1 });

const samples = [];
for (let i = 0; i < 7; i++) {
  const t0 = process.hrtime.bigint();
  await dispatchPreExecute(ctx, { name: 'read', arguments: { path: 'src/app.ts' }, callId: 'l' + i, agent, signal });
  samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const sorted = [...samples].sort((a, b) => a - b);
const out = {
  label,
  configPath: resolve(configPath),
  samplesMs: samples.map((n) => Math.round(n)),
  medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
  minMs: Math.round(sorted[0]),
  maxMs: Math.round(sorted[sorted.length - 1]),
};
writeFileSync(resolve('results', 'latency-' + label + '.json'), JSON.stringify(out, null, 2) + NL2);
console.log(JSON.stringify(out));
