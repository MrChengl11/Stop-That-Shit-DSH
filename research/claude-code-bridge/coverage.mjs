/**
 * coverage.mjs — which Claude Code events can the bridge actually reach?
 *
 * Registers every event STS's hooks/hooks.json registers, each pointing at
 * mark.cjs <EventName> so a hook process leaves a marker file. Then it drives
 * every extension point the bridge registers and reports which markers
 * appeared: a registered event with no marker has no bridge wiring.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadBridge, dispatchPreExecute, dispatchPostExecute, dispatchPreStep,
  dispatchTurnStopping, makeAgent, getHandler,
} from './harness.mjs';

const NL = String.fromCharCode(10);
const toPosix = (p) => p.split(String.fromCharCode(92)).join('/');

const markerDir = resolve('fixtures', 'markers');
rmSync(markerDir, { recursive: true, force: true });
mkdirSync(markerDir, { recursive: true });
mkdirSync(resolve('fixtures'), { recursive: true });

const STS_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SessionEnd', 'SubagentStart', 'PostToolUseFailure', 'PermissionDenied',
];
const markScript = toPosix(resolve('mark.cjs'));
const markerArg = toPosix(markerDir);
const groups = (event) => {
  const command = 'node "' + markScript + '" ' + event + ' "' + markerArg + '"';
  const hook = { type: 'command', command, timeout: 5, statusMessage: 'Checking the Stop Ladder...' };
  return event === 'UserPromptSubmit' ? [{ hooks: [hook] }] : [{ matcher: '*', hooks: [hook] }];
};
const configPath = resolve('fixtures', 'hooks-all-events.json');
writeFileSync(configPath, JSON.stringify({
  hooks: Object.fromEntries(STS_EVENTS.map((event) => [event, groups(event)])),
}, null, 2) + NL);

const cwd = process.cwd();
const { ctx } = await loadBridge({ configPath, pluginRoot: resolve('..', 'lead-sts'), cwd });
const agent = makeAgent({ id: 'sess-cov', cwd });
const signal = new AbortController().signal;
const exec = (name, args, callId) => ({ name, arguments: args, callId, agent, signal });

await getHandler(ctx, 'agent/created')({ agent, source: 'startup', signal });
const preStep = await dispatchPreStep(ctx, { agent, text: 'hello', turn: 1 });
const pre = await dispatchPreExecute(ctx, exec('read', { path: 'src/app.ts' }, 'cov1'));
const post = await dispatchPostExecute(ctx, exec('read', { path: 'src/app.ts' }, 'cov1'), {
  content: [{ type: 'text', text: 'file contents' }], isError: false,
});
const stop = await dispatchTurnStopping(ctx, { agent, turn: 1 });
await getHandler(ctx, 'subagent/start')({ id: 'child-1', runId: 'run-1' });
await getHandler(ctx, 'subagent/end')({ id: 'child-1', runId: 'run-1' });
await new Promise((r) => setTimeout(r, 2000));

const reached = readdirSync(markerDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
const out = {
  registeredEvents: STS_EVENTS,
  markersObserved: reached,
  reached: Object.fromEntries(STS_EVENTS.map((e) => [e, reached.includes(e)])),
  unreachable: STS_EVENTS.filter((e) => !reached.includes(e)),
  bridgeListeners: [...ctx.__listeners.keys()],
  warnings: ctx.__warnings,
  extensionPointResults: {
    'agent/created': 'ran',
    'agent/pre-step': preStep,
    'tools/pre-execute': pre,
    'tools/post-execute': post,
    'agent/turn-stopping': stop,
    'subagent/start': 'ran',
    'subagent/end': 'ran',
  },
};
writeFileSync(resolve('results', 'coverage-events.json'), JSON.stringify(out, null, 2) + NL);
console.log(JSON.stringify(out, null, 2));
