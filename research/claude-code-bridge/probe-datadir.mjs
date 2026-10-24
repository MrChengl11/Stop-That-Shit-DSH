/**
 * probe-datadir.mjs - where does STS store state when the bridge runs it?
 *
 * The bridge injects exactly one environment variable, CLAUDE_PROJECT_DIR
 * (dsh-hooks-claude-code lib/index.js:170-171). It never sets PLUGIN_DATA or
 * CLAUDE_PLUGIN_DATA, so STS falls back to <os.tmpdir()>/stop-that-shit-dev
 * (lead-sts/src/state.cjs:11-13): machine-global, shared by every DSH profile and
 * every Claude Code project, and eligible for temp cleanup.
 */
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const NL2 = String.fromCharCode(10);
const cwd = process.cwd();
// Deliberately UNSET: no PLUGIN_DATA, no CLAUDE_PLUGIN_DATA.
delete process.env.PLUGIN_DATA;
delete process.env.CLAUDE_PLUGIN_DATA;

const expectedDefault = resolve(tmpdir(), 'stop-that-shit-dev');
const sessionsBefore = existsSync(resolve(expectedDefault, 'sessions'))
  ? readdirSync(resolve(expectedDefault, 'sessions')).length : 0;

const { ctx, shellLog } = await loadBridge({
  configPath: resolve('..', 'lead-sts', 'hooks', 'hooks.json'),
  pluginRoot: resolve('..', 'lead-sts'),
  cwd,
});
const agent = makeAgent({ id: 'sess-datadir', cwd });
const signal = new AbortController().signal;

await dispatchPreStep(ctx, { agent, text: '$stop-that-shit change files=src/app.ts -- add the counter', turn: 1 });
const decision = await dispatchPreExecute(ctx, { name: 'write', arguments: { path: 'src/other.ts', content: 'x' }, callId: 'w1', agent, signal });

const sessionsAfter = existsSync(resolve(expectedDefault, 'sessions'))
  ? readdirSync(resolve(expectedDefault, 'sessions')).length : 0;
const hookEnv = shellLog.at(-1)?.env;

const out = {
  defaultDataRoot: expectedDefault,
  defaultDataRootExists: existsSync(expectedDefault),
  sessionFilesBefore: sessionsBefore,
  sessionFilesAfter: sessionsAfter,
  stateWrittenToDefaultRoot: sessionsAfter > sessionsBefore,
  envPassedToHook: hookEnv ?? null,
  enforcementStillWorks: decision.kind,
};
writeFileSync(resolve('results', 'datadir-default.json'), JSON.stringify(out, null, 2) + NL2);
console.log(JSON.stringify(out, null, 2));
