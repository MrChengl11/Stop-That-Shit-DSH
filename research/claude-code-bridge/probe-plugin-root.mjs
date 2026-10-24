/**
 * probe-plugin-root.mjs - what happens when `pluginRoot` is NOT configured.
 *
 * The STS hooks.json command is `node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-that-shit-claude.cjs"`.
 * The bridge substitutes that token at PARSE time only when config.pluginRoot is
 * set (dsh-hooks-claude-code lib/index.js:32-37, called at :143-146). Without it the
 * token survives into the shell command and expands to empty, so the hook exits
 * non-zero and the bridge's failure handling turns an armed guard into an ALLOW.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const NL2 = String.fromCharCode(10);
const cwd = process.cwd();
const dataDir = resolve('.sts-data', 'plugin-root');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
process.env.PLUGIN_DATA = dataDir;

const { ctx, shellLog } = await loadBridge({
  configPath: resolve('..', 'lead-sts', 'hooks', 'hooks.json'),
  // deliberately NO pluginRoot:
  cwd,
});
const agent = makeAgent({ id: 'sess-pluginroot', cwd });
const signal = new AbortController().signal;
const exec = (name, args, callId) => ({ name, arguments: args, callId, agent, signal });

const preStep = await dispatchPreStep(ctx, { agent, text: '$stop-that-shit change files=src/app.ts -- add the counter', turn: 1 });
const decision = await dispatchPreExecute(ctx, exec('write', { path: 'src/other.ts', content: 'x' }, 'w1'));
const spawn = shellLog.at(-1);

const out = {
  warnings: ctx.__warnings,
  preStepDecision: preStep,
  armedThoughGuardDead: preStep.kind === 'enter' && (preStep.messages || []).length === 0,
  preExecuteDecision: decision,
  hookCommandAsExecuted: spawn ? spawn.command : null,
  hookExitCode: spawn ? spawn.exitCode : null,
  hookStderr: spawn ? String(spawn.stderr).split(NL2).slice(0, 4).join(' | ') : null,
  outOfScopeWriteAllowed: decision.kind !== 'deny',
};
writeFileSync(resolve('results', 'plugin-root-unset.json'), JSON.stringify(out, null, 2) + NL2);
console.log(JSON.stringify(out, null, 2));
