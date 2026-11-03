/**
 * rc5-tool-inventory.mjs — the tool names DeepSeek Harness 0.2.1-rc.5 actually
 * mounts, as checked-in data for the conformance suite.
 *
 * Why this file exists: the guard classifies a tool by name at
 * tools/pre-execute, so a tool the guard does not know is treated as an
 * unproven mutation and denied once a contract is armed. The inventory is the
 * evidence that every tool the runtime can dispatch has a deliberate
 * classification, and that no classification was guessed.
 *
 * Provenance (all read-only, 2026-11-03, runtime 0.2.1-rc.5):
 *   - Desktop: the user's real profile bundles (12 of them) composed with
 *     `--dump-config` through a mirror profile, because the CLI refuses
 *     `--profile desktop` ("managed exclusively by the Electron application").
 *     The mirror reused the desktop profile's own package.json bundle list,
 *     cordis.patch.yml user layer and a junction to its node_modules, so the
 *     composed plugin rows are the real ones. Plugin rows were then mapped to
 *     the tool names they register by reading each package inside app.asar /
 *     the profile's node_modules (`defineTool({name})`, `tools.register({name})`,
 *     `toolName` config, and dsh-ops' generated `lib/ptc/sdk.d.ts`).
 *   - Two desktop rows are mounted by @deepseek-ai/dsh-desktop-host itself and
 *     therefore never appear in --dump-config: the "desktop-office" composition
 *     loads @deepseek-ai/dsh-tool-workspace-dependencies
 *     (`load_workspace_dependencies`).
 *   - Headless: `--profile stsrc5 --dump-config` (dsh-base + dsh-headless +
 *     this plugin) with the same package-to-tool mapping.
 *
 * Deliberately NOT listed: MCP tools (`mcp__<server>__<tool>`). An MCP server
 * decides its own effects at run time, so those stay "unknown" and fail closed.
 *
 * Categories used here are the guard's own mutability vocabulary plus "shell"
 * for the tools whose mutability is decided per command:
 *   read     - observes state only
 *   control  - session/plugin bookkeeping, or an effect outside the task
 *              working tree; never mutates the task tree
 *   write    - can mutate the task working tree
 *   shell    - mutability decided by the command text (analyzeShellInput)
 *   delegate - consumes the delegation budget
 */

/** The runtime these inventories were read from. */
export const RC5_RUNTIME = "0.2.1-rc.5";

/** Dynamic tool families that are never classified statically. */
export const DYNAMIC_TOOL_PREFIXES = ["mcp__"];

/**
 * Tool names mounted by the user's real desktop profile (all 12 bundles, the
 * user patch layer, and the Electron host's own desktop-office composition).
 * @type {Record<string, "read" | "control" | "write" | "shell" | "delegate">}
 */
export const DESKTOP_TOOLS = {
  // --- dsh-base / dsh-web-app presets (ptc is the desktop default) ---
  read: "read",
  read_image: "read",
  glob: "read",
  grep: "read",
  web_search: "read",
  web_fetch: "read",
  list_agents: "read",
  list_mcp_resources: "read",
  list_mcp_resource_templates: "read",
  read_mcp_resource: "read",
  job_list: "read",
  job_output: "read",
  schedule_list: "read",
  skill: "read",
  get_goal: "read",
  list_subagent_models: "read",
  cordis_inspect_list: "read",
  cordis_inspect_query: "read",
  working_directory: "control",
  ask_user_question: "control",
  present: "control",
  todo_write: "control",
  create_goal: "control",
  update_goal: "control",
  schedule_create: "control",
  schedule_update: "control",
  schedule_delete: "control",
  job_kill: "control",
  interrupt_agent: "control",
  send_message: "control",
  wait_agent: "control",
  exit_plan_mode: "control",
  run_code: "control",
  plugin_manager: "control",
  plugin_market: "control",
  write: "write",
  edit: "write",
  bash: "shell",
  pwsh: "shell",
  subagent: "delegate",
  subagent_fork: "delegate",
  // dsh-tool-workflow names its tool from config (toolName defaults to
  // "workflow"); mounted by dsh-base/headless and the standard/cordis presets.
  workflow: "delegate",

  // --- dsh-experimental-agent-team-profile ---
  spawn_teammate: "delegate",
  team_task_create: "control",
  team_task_list: "read",
  team_task_get: "read",
  team_task_update: "control",

  // --- dsh-experimental-tool-worktree ---
  create_worktree: "write",

  // --- dsh-experimental-terminal-bundle ---
  terminal_open: "write",
  terminal_send: "write",
  terminal_read: "control",
  terminal_list: "control",
  terminal_signal: "control",
  terminal_close: "control",

  // --- dsh-experimental-session-search ---
  session_search: "read",
  session_event_search: "read",
  session_trace: "read",
  session_event_trace: "read",
  session_event_read: "read",

  // --- @deepseek-ai/dsh-desktop-host "desktop-office" composition ---
  load_workspace_dependencies: "read",

  // --- dsh-unlag (button bookkeeping; no working-tree effect) ---
  unlag_refresh: "control",

  // --- @zaofan/dsh-qqbot (chat side effects, never the task tree) ---
  gain_qq_tools: "control",
  send_media: "control",
  recall_message: "control",
  list_stickers: "control",
  sticker_tag: "control",
  sticker_delete: "control",
  sticker_restore: "control",
  sticker_stats: "control",
  sticker_untagged: "control",
  schedule_timer: "control",
  schedule_cancel: "control",
  text_break: "control",
  reply_gate: "control",
  outbound_mode: "control",
  group_join_requests: "control",
  group_approve_join: "control",
  group_join_auto: "control",
  session_list: "control",
  broadcast_send: "control",
  target_group: "control",
  session_wake: "control",
  group_mute_state: "control",
  group_recall: "control",
  group_msg_search: "control",
  recall_keywords: "control",
  group_kick: "control",
  qq_material: "control",
  group_recall_batch: "control",
  group_mute_member: "control",
  id_lookup: "control",
  tools_reload: "control",
  quote_view: "control",
  people_memo: "control",
  context_memo: "control",
  context_compact: "control",
  context_drop: "control",
  qq_group_admin: "control",

  // --- dsh-ops 0.4.4 (native file/PTC tools; ops_bash replaces bash/pwsh) ---
  ops_bash: "shell",
  ops_glob: "read",
  ops_grep: "read",
  ops_stat: "read",
  ops_diff: "read",
  ops_read_files: "read",
  ops_read_table: "read",
  ops_read_docx: "read",
  ops_read_pdf: "read",
  ops_inspect_local_file: "read",
  ops_load_sdk: "control",
  ops_result: "control",
  ops_write_file: "write",
  ops_edit_file: "write",
  ops_replace: "write",
  ops_move: "write",
  ops_copy: "write",
  ops_remove: "write",
  ops_batch: "write"
};

/**
 * Tool names mounted by the headless profile (dsh-base + dsh-headless), as
 * measured in the stsrc5 dump and confirmed against a live headless session's
 * model-visible tool list.
 *
 * Rows that exist but do not register a tool on this machine/profile are left
 * out on purpose: `bash` is disabled on win32 (`pwsh` is the only shell),
 * `plugin_manager` needs a profile context, `list_subagent_models` needs the
 * subagent row's model-selection config, and the three MCP resource tools exist
 * only while an MCP resource server is configured. Every one of those names is
 * still classified (see the desktop inventory and READ_TOOLS), so nothing here
 * is the only coverage for a name.
 * @type {Record<string, "read" | "control" | "write" | "shell" | "delegate">}
 */
export const HEADLESS_TOOLS = {
  read: "read",
  read_image: "read",
  glob: "read",
  grep: "read",
  web_search: "read",
  web_fetch: "read",
  list_agents: "read",
  job_list: "read",
  job_output: "read",
  skill: "read",
  get_goal: "read",
  working_directory: "control",
  todo_write: "control",
  create_goal: "control",
  update_goal: "control",
  job_kill: "control",
  interrupt_agent: "control",
  send_message: "control",
  exit_plan_mode: "control",
  write: "write",
  edit: "write",
  pwsh: "shell",
  subagent: "delegate",
  subagent_fork: "delegate",
  workflow: "delegate"
};
