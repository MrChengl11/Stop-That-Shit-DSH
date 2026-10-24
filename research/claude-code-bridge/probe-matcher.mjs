import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';
import { resolve } from 'node:path';

const configPath = resolve(process.argv[2]);
const label = process.argv[3] || 'probe';

const { ctx, shellLog, config } = await loadBridge({
  configPath,
  pluginRoot: resolve('..', 'lead-sts'),
  projectDir: process.cwd(),
  cwd: process.cwd(),
});

const agent = makeAgent({ id: 'sess-' + label, cwd: process.cwd() });
const signal = new AbortController().signal;
const out = { label, configPath, warnings: [...ctx.__warnings], listeners: [...ctx.__listeners.keys()] };

out.preExecute = [];
for (const name of ['ops_bash','write','Bash','Write','read']) {
  const before = shellLog.length;
  let decision, error = null;
  try {
    decision = await dispatchPreExecute(ctx, { name, arguments: { command: 'git status', path: 'src/app.ts' }, callId: 'c-'+name, agent, signal });
  } catch (e) { error = String(e.message); decision = { kind: 'no-listener-fail-open' }; }
  out.preExecute.push({ name, decision, spawned: shellLog.length - before, error });
}

let preStep, preStepError = null;
try { preStep = await dispatchPreStep(ctx, { agent, text: 'hello', turn: 1 }); }
catch (e) { preStepError = String(e.message); preStep = { kind: 'no-listener-fail-open' }; }
out.preStep = preStep;
out.preStepError = preStepError;
out.totalHookSpawns = shellLog.length;
out.warningsAfter = [...ctx.__warnings];

const fsm = await import('node:fs');
fsm.writeFileSync(resolve('results', 'probe-' + label + '.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));