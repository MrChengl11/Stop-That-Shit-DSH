/**
 * agents-probe.mjs — does the bridge's PostToolUse payload let STS release a
 * delegation reservation?
 *
 * STS reserves agent budget on the PreToolUse of a delegate tool and only
 * releases it when a later action.after event proves the child finished
 * (STS src/adapters/claude-hooks.cjs:90 reads input.tool_response.status).
 * The bridge sends tool_response as a FLATTENED STRING
 * (dsh-hooks-claude-code lib/index.js:390 blocksToText(result.content)), so
 * the status is unreadable and the reservation can never be released.
 *
 * Two arms, identical STS state layout:
 *   arm "bridge"  — post-execute goes through the real bridge payload
 *   arm "direct"  — the same hook script is handed a CC-shaped
 *                   tool_response object {status:'completed'}
 * Then a second delegation attempt shows whether the 1-agent budget was freed.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadBridge, dispatchPreExecute, dispatchPostExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const NL2 = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const toPosix = (p) => p.split(BS).join('/');
const cwd = process.cwd();
const wrapper = resolve('sts-dsh-wrapper.cjs');

function resetData(label) {
  const dir = resolve('.sts-data', label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runWrapperDirect(dataDir, payload) {
  const r = spawnSync(process.execPath, [wrapper], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: dataDir, STS_PLUGIN_ROOT: resolve('..', 'lead-sts') },
    cwd,
  });
  return { exitCode: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

async function arm(label, dataDir) {
  process.env.PLUGIN_DATA = dataDir;
  const { ctx } = await loadBridge({
    configPath: resolve('hooks-dsh.json'),
    pluginRoot: resolve('..', 'lead-sts'),
    cwd,
  });
  const agent = makeAgent({ id: 'sess-agents', cwd });
  const signal = new AbortController().signal;
  const exec = (name, args, callId) => ({ name, arguments: args, callId, agent, signal });
  const armDecision = await dispatchPreStep(ctx, {
    agent,
    text: '$stop-that-shit change files=src/app.ts agents=1 -- add the counter',
    turn: 1,
  });
  return { ctx, agent, signal, exec, armDecision };
}

const rows = {};

// ---- arm 1: the real bridge payload for PostToolUse ----
{
  const dataDir = resetData('agents-bridge');
  const { ctx, exec } = await arm('agents-bridge', dataDir);
  const first = await dispatchPreExecute(ctx, exec('subagent', { description: 'x', prompt: 'do y' }, 'd1'));
  const post = await dispatchPostExecute(ctx, exec('subagent', { description: 'x', prompt: 'do y' }, 'd1'), {
    content: [{ type: 'text', text: '{"status":"completed","agentId":"agent-1"}' }],
    isError: false,
  });
  const second = await dispatchPreExecute(ctx, exec('subagent', { description: 'x', prompt: 'do z' }, 'd2'));
  rows.bridge = {
    dataDir,
    armDecision: armDecisionSummary(ctx),
    firstDelegation: first,
    postExecuteDecision: post,
    secondDelegation: second,
    secondIsDenied: second.kind === 'deny',
  };
}

// ---- arm 2: the same hook script, handed a CC-shaped tool_response object ----
{
  const dataDir = resetData('agents-direct');
  const { ctx, exec } = await arm('agents-direct', dataDir);
  const first = await dispatchPreExecute(ctx, exec('subagent', { description: 'x', prompt: 'do y' }, 'd1'));
  const directPost = runWrapperDirect(dataDir, {
    session_id: 'sess-agents',
    transcript_path: '',
    hook_event_name: 'PostToolUse',
    tool_name: 'subagent',
    tool_input: { description: 'x', prompt: 'do y' },
    tool_use_id: 'd1',
    tool_response: { status: 'completed', agentId: 'agent-1' },
    cwd,
  });
  const second = await dispatchPreExecute(ctx, exec('subagent', { description: 'x', prompt: 'do z' }, 'd2'));
  rows.direct = {
    dataDir,
    firstDelegation: first,
    directPostHook: directPost,
    secondDelegation: second,
    secondIsDenied: second.kind === 'deny',
  };
}

function armDecisionSummary(ctx) {
  return ctx.__warnings;
}

writeFileSync(resolve('results', 'agents-probe.json'), JSON.stringify(rows, null, 2) + NL2);
console.log(JSON.stringify(rows, null, 2));
