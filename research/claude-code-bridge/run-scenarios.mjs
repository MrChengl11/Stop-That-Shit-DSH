/**
 * run-scenarios.mjs — drive the bridge's tools/pre-execute listener with fake
 * tool executions and print the PreToolDecision the bridge returns.
 *
 * Usage:
 *   node run-scenarios.mjs --config <hooks.json> --plugin-root <dir> [--label name]
 *
 * The bridge is loaded through harness.mjs (a minimal ctx stub). STS state lives
 * in a scratch PLUGIN_DATA directory under bridge-test/.sts-data so the real
 * user profile is never touched.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadBridge, dispatchPreExecute, dispatchPostExecute, dispatchPreStep,
  dispatchTurnStopping, makeAgent,
} from './harness.mjs';

const argv = process.argv.slice(2);
function arg(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const configPath = resolve(arg('--config', resolve('..', 'lead-sts', 'hooks', 'hooks.json')));
const pluginRoot = resolve(arg('--plugin-root', resolve('..', 'lead-sts')));
const label = arg('--label', 'run');
const projectDir = arg('--project-dir', process.cwd());
const dataDir = resolve(arg('--data-dir', resolve('.sts-data', label)));
const armedPrompt = arg('--prompt', '$stop-that-shit change files=src/app.ts -- add the counter');

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
process.env.PLUGIN_DATA = dataDir;

const { ctx, shellLog, config } = await loadBridge({ configPath, pluginRoot, projectDir, cwd: process.cwd() });

const agent = makeAgent({ id: 'sess-1', cwd: process.cwd() });
const signal = new AbortController().signal;

function exec(name, args, callId) {
  return { name, arguments: args, callId, agent, signal };
}

const out = {
  label,
  config,
  configPath,
  pluginRoot,
  dataDir,
  listeners: [...ctx.__listeners.keys()],
  warnings: ctx.__warnings,
  steps: [],
};

function record(title, value) {
  out.steps.push({ title, value });
  console.log('\n### ' + title);
  console.log(JSON.stringify(value, null, 2));
}

// --- arm STS through the UserPromptSubmit listener (agent/pre-step) ---
const preStep = await dispatchPreStep(ctx, { agent, text: armedPrompt, turn: 1 });
record('agent/pre-step (UserPromptSubmit arming) -> ' + armedPrompt, preStep);

const hookSpawns = () => shellLog.map((s) => ({
  command: s.command,
  workdir: s.workdir,
  env: s.env,
  stdin: s.stdin,
  exitCode: s.exitCode,
  stdout: s.stdout,
  stderr: s.stderr,
}));

// --- scenarios ---
const scenarios = [
  ['a. read src/app.ts (in scope, expect allow)', exec('read', { path: 'src/app.ts' }, 'c1')],
  ['b. write src/other.ts (out of scope, expect deny)', exec('write', { path: 'src/other.ts', content: 'x' }, 'c2')],
  ['c. glob **/*.ts (unknown to STS classifier)', exec('glob', { pattern: '**/*.ts' }, 'c3')],
  ['d. ops_bash git status (unknown to STS classifier)', exec('ops_bash', { command: 'git status' }, 'c4')],
  ['e. write src/app.ts (in scope, expect allow)', exec('write', { path: 'src/app.ts', content: 'y' }, 'c5')],
  ['f. read src/other.ts (read outside scope, expect allow since read tools are not path-gated)', exec('read', { path: 'src/other.ts' }, 'c6')],
];

for (const [title, e] of scenarios) {
  const decision = await dispatchPreExecute(ctx, e);
  record(title + '  [' + e.name + ']', {
    input: { name: e.name, arguments: e.arguments, callId: e.callId },
    payloadSentToHook: hookSpawns().at(-1)?.stdin ? JSON.parse(hookSpawns().at(-1).stdin) : null,
    hookStdout: hookSpawns().at(-1)?.stdout ?? null,
    decision,
  });
}

// --- post-execute (PostToolUse) with a CC-shaped tool_response object ---
const postExec = exec('write', { path: 'src/app.ts', content: 'y' }, 'c5');
const postDecision = await dispatchPostExecute(ctx, postExec, {
  content: [{ type: 'text', text: 'Wrote src/app.ts' }],
  isError: false,
});
record('g. tools/post-execute for write (what PostToolUse payload carries)', {
  decision: postDecision,
  payloadSentToHook: hookSpawns().at(-1)?.stdin ? JSON.parse(hookSpawns().at(-1).stdin) : null,
  hookStdout: hookSpawns().at(-1)?.stdout ?? null,
});

// --- turn-stopping (Stop) ---
const stop = await dispatchTurnStopping(ctx, { agent, turn: 1 });
record('h. agent/turn-stopping (Stop event) -> bridge emits no hook call unless configures Stop', {
  decision: stop,
  lastSpawn: hookSpawns().at(-1)?.command ?? null,
});

out.warningsAfter = ctx.__warnings;
out.allHookSpawns = hookSpawns();
console.log('\n### registered listeners');
console.log(JSON.stringify(out.listeners));
console.log('\n### ctx.logger.warn calls');
console.log(JSON.stringify(ctx.__warnings, null, 2));

const fs = await import('node:fs');
fs.writeFileSync(resolve('results', label + '.json'), JSON.stringify(out, null, 2));
console.log('\nwrote results/' + label + '.json');
