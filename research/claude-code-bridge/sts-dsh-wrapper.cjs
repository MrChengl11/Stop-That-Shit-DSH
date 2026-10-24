#!/usr/bin/env node
/**
 * sts-dsh-wrapper.cjs — Claude-Code-shaped shim that adapts DSH tool names to the
 * names STS's Claude classifier recognizes, then calls STS in-process.
 *
 * stdin  : the bridge's Claude Code PreToolUse payload:
 *          { session_id, transcript_path, hook_event_name, tool_name, tool_input,
 *            tool_use_id, cwd }
 * stdout : whatever handleClaudeHook() returns, verbatim (CC wire shape).
 *
 * Mapping source: the DSH tool registry names as actually registered by this
 * profile (read/write/edit/glob/grep/ops_bash/ops_inspect_local_file/...), matched
 * onto STS's CLAUDE_READ_TOOLS / write / delegate / control sets.
 */
'use strict';

const path = require('node:path');

const STS_ROOT = process.env.STS_PLUGIN_ROOT
  || path.resolve(__dirname, '..', 'lead-sts');
const { handleClaudeHook } = require(path.join(STS_ROOT, 'src', 'adapters', 'claude-hooks.cjs'));

/** DSH tool name -> Claude Code tool name. Unlisted names pass through unchanged. */
const DSH_TO_CLAUDE = {
  // reads
  read: 'Read',
  ops_inspect_local_file: 'Read',
  read_image: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  // writes
  write: 'Write',
  edit: 'Edit',
  // shell
  ops_bash: 'Bash',
  pwsh: 'Bash',
  // delegation / control
  subagent: 'Agent',
  subagent_fork: 'Agent',
  spawn_teammate: 'Agent',
  run_code: 'Bash',           // runs arbitrary code with filesystem/network access
  todo_write: 'TodoWrite',
  present: 'TodoWrite',
  skill: 'Skill',
  ask_user_question: 'AskUserQuestion',
  create_goal: 'TodoWrite',
  get_goal: 'TodoWrite',
  update_goal: 'TodoWrite',
  schedule_create: 'CronCreate',
  schedule_list: 'CronList',
  schedule_delete: 'CronDelete',
  schedule_update: 'CronCreate',
  compress: 'ToolSearch',
  decompress: 'ToolSearch',
  search_context: 'ToolSearch',
  acp_status: 'ToolSearch',
  acp_cache: 'ToolSearch',
  session_search: 'ToolSearch',
  session_trace: 'ToolSearch',
  session_event_search: 'ToolSearch',
  session_event_read: 'ToolSearch',
  session_event_trace: 'ToolSearch',
  list_agents: 'ListAgents',
  interrupt_agent: 'SendMessage',
  send_message: 'SendMessage',
  job_list: 'TaskList',
  job_output: 'TaskOutput',
  job_kill: 'TaskStop',
  working_directory: 'Bash',
  terminal_open: 'Bash',
  terminal_send: 'Bash',
  terminal_read: 'Bash',
  terminal_close: 'Bash',
  terminal_signal: 'Bash',
  terminal_list: 'Bash',
  ops_result: 'ToolSearch',
  ops_load_sdk: 'ToolSearch',
};

/** Tool-input field renames so STS's path extractors find the path. */
function adaptInput(claudeName, input) {
  if (!input || typeof input !== 'object') return input;
  const out = { ...input };
  if (claudeName === 'Read' || claudeName === 'Write' || claudeName === 'Edit') {
    if (out.path !== undefined && out.file_path === undefined) out.file_path = out.path;
  }
  if (claudeName === 'Bash') {
    if (out.code !== undefined && out.command === undefined) out.command = out.command ?? '';
  }
  return out;
}

function readStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    let settled = false;
    let body = '';
    const finish = () => { if (!settled) { settled = true; resolve(body); } };
    const timer = setTimeout(finish, 1500);
    timer.unref?.();
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { body += chunk; });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.resume();
  });
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const dshName = String(input.tool_name || '');
    const claudeName = DSH_TO_CLAUDE[dshName] || dshName;
    const mapped = {
      ...input,
      tool_name: claudeName,
      tool_input: adaptInput(claudeName, input.tool_input),
    };
    const output = handleClaudeHook(mapped, process.env.PLUGIN_DATA ? { dataDir: process.env.PLUGIN_DATA } : {});
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    const errorName = error && error.name ? error.name : 'HookError';
    process.stderr.write('STS DSH wrapper failed open: ' + errorName + '\n');
  }
})();
