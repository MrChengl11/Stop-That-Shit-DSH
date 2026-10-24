#!/usr/bin/env node
// DSH -> Claude Code tool-name shim for Stop That Shit.
// The STS Claude adapter classifies tools by Claude Code names; DSH uses its own.
// This shim rewrites tool_name in the PreToolUse payload, delegates to the real
// STS hook, and passes the hook's JSON answer straight back on stdout.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const STS_HOOK = process.env.STS_HOOK || path.join(__dirname, "..", "lead-sts", "hooks", "stop-that-shit-claude.cjs");

// DSH tool name -> closest Claude Code name that STS already understands.
const MAP = {
  read: "Read", read_image: "Read", ops_inspect_local_file: "Read", ops_result: "Read",
  write: "Write", str_replace_editor: "Edit", edit: "Edit",
  glob: "Glob", ops_glob: "Glob", grep: "Grep", ops_grep: "Grep",
  bash: "Bash", pwsh: "PowerShell", terminal_send: "Bash", terminal_open: "TodoWrite",
  subagent: "Agent", subagent_fork: "Agent", spawn_teammate: "Agent", send_message: "SendMessage",
  list_agents: "ListAgents", wait_agent: "SendMessage", interrupt_agent: "SendMessage",
  team_task_create: "TodoWrite", team_task_list: "TodoWrite", team_task_get: "TodoWrite",
  team_task_update: "TodoWrite", todo_write: "TodoWrite", skill: "Skill",
  web_fetch: "WebFetch", web_search: "WebSearch",
  ask_user_question: "AskUserQuestion",
  present: "TodoWrite", schedule_create: "ScheduleWakeup",
  run_code: "ToolSearch", ops_bash: "Bash", ops_load_sdk: "ToolSearch",
  session_search: "Grep", session_trace: "Grep", compress: "TodoWrite",
  create_goal: "TodoWrite", update_goal: "TodoWrite", get_goal: "TodoWrite",
  job_list: "TodoWrite", job_output: "TodoWrite", job_kill: "TodoWrite",
  working_directory: "TodoWrite", terminal_list: "TodoWrite", terminal_read: "Read",
  terminal_signal: "Bash", terminal_close: "TodoWrite",
};

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload && typeof payload.tool_name === "string" && MAP[payload.tool_name]) {
    payload.tool_name = MAP[payload.tool_name];
  }
  let out = "";
  try {
    out = execFileSync(process.execPath, [STS_HOOK], {
      input: JSON.stringify(payload), encoding: "utf8", timeout: 5000, cwd: payload.cwd || process.cwd(),
    });
  } catch (error) { return; } // fail open, exactly like STS itself
  if (out && out.trim()) { 
    process.stdout.write(out); 
  }
});
