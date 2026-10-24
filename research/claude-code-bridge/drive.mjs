// drive.mjs — run the REAL @deepseek-ai/dsh-hooks-claude-code bridge against the
// REAL Stop That Shit Claude hook, with and without a DSH->Claude tool-name shim.
import { loadBridge, dispatchPreExecute, dispatchPreStep, dispatchTurnStopping, makeAgent } from './harness.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = mkdtempSync(join(tmpdir(), 'dsh-bridge-e2e-'));
mkdirSync(join(cwd, 'src'), { recursive: true });
writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');

const which = process.argv[2];              // 'raw' | 'shim'
const configPath = join(process.cwd(), process.argv[3]);
const pluginRoot = process.argv[4] ?? process.cwd();
const bridge = await loadBridge({ configPath, pluginRoot, projectDir: cwd, cwd });
console.log('=== mode:', which, '| warnings:', JSON.stringify(bridge.ctx.__warnings) + ' ===');

const agent = makeAgent({ id: 'dsh-session-1', cwd });

// 1) SessionStart
const startHandler = bridge.ctx.__listeners.get('agent/created')?.[0]?.handler;
if (startHandler) {
  const r = await startHandler({ agent, source: 'startup', signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
  console.log('SessionStart   ->', JSON.stringify(r ?? null).slice(0, 200));
}

// 2) UserPromptSubmit: arm STS in change mode, contract = src/app.ts
const pr = await dispatchPreStep(bridge.ctx, { agent, text: '$stop-that-shit change files=src/app.ts -- implement the null check' });
console.log('UserPromptSubmit ->', JSON.stringify(pr).slice(0, 500));

// 3) PreToolUse matrix over DSH's real model-facing tool names
const cases = [
  ['read', { file_path: join(cwd, 'src/app.ts') }],
  ['read', { file_path: 'src/app.ts' }],
  ['write', { file_path: join(cwd, 'src/app.ts'), content: 'x' }],
  ['write', { file_path: join(cwd, 'src/other.ts'), content: 'x' }],
  ['edit', { file_path: join(cwd, 'src/app.ts'), old_string: 'a', new_string: 'b' }],
  ['glob', { pattern: '**/*.ts' }],
  ['grep', { pattern: 'export' }],
  ['bash', { command: 'git status' }],
  ['bash', { command: 'echo hi > a.txt' }],
  ['pwsh', { command: 'Get-ChildItem' }],
  ['subagent', { prompt: 'do a thing' }],
  ['spawn_teammate', { name: 'x', prompt: 'y' }],
  ['run_code', { code: '1+1' }],
  ['ops_bash', { command: 'git status' }],
  ['todo_write', { todos: [] }],
];
for (const [name, args] of cases) {
  const exec = { name, arguments: args, callId: 'call-' + name, agent, signal: undefined };
  let gate;
  try { gate = await dispatchPreExecute(bridge.ctx, exec); } catch (e) { gate = { thrown: String(e) }; }
  console.log('PreToolUse ' + name.padEnd(15) + ' -> ' + JSON.stringify(gate).slice(0, 200));
}

// 4) switch to review mode and re-test writes
const pr2 = await dispatchPreStep(bridge.ctx, { agent, text: '$stop-that-shit review -- just look around' });
console.log('UserPromptSubmit(review) ->', JSON.stringify(pr2).slice(0, 300));
for (const [name, args] of [['read', { file_path: 'src/app.ts' }], ['write', { file_path: join(cwd, 'src/app.ts'), content: 'x' }], ['bash', { command: 'ls' }]]) {
  const exec = { name, arguments: args, callId: 'call-r-' + name, agent, signal: undefined };
  const gate = await dispatchPreExecute(bridge.ctx, exec);
  console.log('review PreToolUse ' + name.padEnd(8) + ' -> ' + JSON.stringify(gate).slice(0, 200));
}
process.exit(0);
