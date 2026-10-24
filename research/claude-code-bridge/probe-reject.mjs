/**
 * probe-reject.mjs - what the bridge hands back when a UserPromptSubmit hook blocks.
 *
 * STS answers a malformed directive with the legacy top-level
 * {"decision":"block","reason":"..."} (lead-sts/src/adapters/claude-hooks.cjs:131-139).
 * The bridge folds that into merged.decision='deny' and then returns a bare
 * {kind:'reject'} (dsh-hooks-claude-code lib/index.js:244) - the reason is thrown away.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBridge, dispatchPreStep, makeAgent } from './harness.mjs';

const NL2 = String.fromCharCode(10);
const cwd = process.cwd();
const dataDir = resolve('.sts-data', 'reject');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
process.env.PLUGIN_DATA = dataDir;

const { ctx, shellLog } = await loadBridge({
  configPath: resolve('..', 'lead-sts', 'hooks', 'hooks.json'),
  pluginRoot: resolve('..', 'lead-sts'),
  cwd,
});
const agent = makeAgent({ id: 'sess-reject', cwd });

const badPrompt = '$stop-that-shit nope -- do it';
const decision = await dispatchPreStep(ctx, { agent, text: badPrompt, turn: 1 });
const spawn = shellLog.at(-1);

const out = {
  prompt: badPrompt,
  hookStdout: spawn ? spawn.stdout.trim() : null,
  bridgeDecision: decision,
  reasonPreserved: Object.prototype.hasOwnProperty.call(decision, 'reason'),
};
writeFileSync(resolve('results', 'prompt-reject.json'), JSON.stringify(out, null, 2) + NL2);
console.log(JSON.stringify(out, null, 2));
