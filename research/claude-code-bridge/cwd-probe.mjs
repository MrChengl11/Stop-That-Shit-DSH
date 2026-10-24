/**
 * cwd-probe.mjs — does STS depend on the payload `cwd` for relative-path checks,
 * and does the bridge actually supply it?
 *
 * STS resolves declared/allowed paths against input.cwd
 * (lead-sts/src/adapters/claude-hooks.cjs:97,105 -> src/decision.cjs:25-34).
 * The bridge DOES send cwd (dsh-hooks-claude-code lib/index.js:185), so the
 * relative-path policy works — but this probe also shows what happens when a
 * host adapter omits it, which is the failure mode to guard against.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const NL2 = String.fromCharCode(10);
const BS2 = String.fromCharCode(92);
const toPosix = (p) => p.split(BS2).join('/');
const cwd = process.cwd();
const wrapper = resolve('sts-dsh-wrapper.cjs');

const dataDir = resolve('.sts-data', 'cwd-probe');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
process.env.PLUGIN_DATA = dataDir;

const { ctx } = await loadBridge({ configPath: resolve('hooks-dsh.json'), pluginRoot: resolve('..', 'lead-sts'), cwd });
const agent = makeAgent({ id: 'sess-cwd', cwd });
const signal = new AbortController().signal;
const exec = (name, args, callId) => ({ name, arguments: args, callId, agent, signal });

await dispatchPreStep(ctx, { agent, text: '$stop-that-shit change files=src/app.ts -- add the counter', turn: 1 });

const absolutePath = toPosix(resolve(cwd, 'src/app.ts'));

function directPreToolUse(payload) {
  const r = spawnSync(process.execPath, [wrapper], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd,
    env: { ...process.env, PLUGIN_DATA: dataDir, STS_PLUGIN_ROOT: resolve('..', 'lead-sts') },
  });
  return { exitCode: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

const base = {
  session_id: 'sess-cwd', transcript_path: '', hook_event_name: 'PreToolUse',
  tool_name: 'write', tool_input: { path: absolutePath, content: 'x' }, tool_use_id: 'w1',
};

const withCwd = directPreToolUse({ ...base, cwd });
const withoutCwd = directPreToolUse({ ...base });
const bridgeDecision = await dispatchPreExecute(ctx, exec('write', { path: absolutePath, content: 'x' }, 'w2'));

const out = {
  absolutePath,
  withCwd: { hookStdout: withCwd.stdout },
  withoutCwd: { hookStdout: withoutCwd.stdout },
  bridgeDecision,
};
writeFileSync(resolve('results', 'cwd-probe.json'), JSON.stringify(out, null, 2) + NL2);
console.log(JSON.stringify(out, null, 2));
