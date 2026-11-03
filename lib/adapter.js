/**
 * adapter.js — DeepSeek Harness tool surface -> Stop That Shit action facts.
 *
 * This module owns every host-specific judgement:
 *   - which DSH tool name is read / write / delegate / control / unknown,
 *   - which paths a mutating call proves it touches,
 *   - whether the call carries hash or dependency intent.
 *
 * It deliberately imports no @deepseek-ai package: a third-party profile bundle
 * is resolved through a linked layer, so any bare host import can fail with
 * ERR_MODULE_NOT_FOUND. Only node: builtins and the vendored STS sources load.
 *
 * The tool sets below are the DeepSeek Harness 0.2.1-rc.5 surface that the
 * desktop and headless profiles actually mount; test/rc5-tool-inventory.mjs
 * carries that inventory as checked-in evidence, and the conformance suite
 * asserts every listed name lands in the category recorded there.
 *
 * "control" is a working-tree judgement: a tool that changes session or plugin
 * bookkeeping, or an effect outside the task tree (a chat message, an editor
 * button, a profile install), never authorizes a repository mutation. A tool
 * that can write the task tree is "write" even when it also does bookkeeping.
 * A tool this adapter cannot place positively stays "unknown", which the
 * decision layer treats as an unproven mutation (fail closed).
 */
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { analyzeShellInput, combineAffectedPaths } = require("../vendor-sts/src/shell-analysis.cjs");
const { fileHashIntent, patchHashIntent } = require("../vendor-sts/src/hash-intent.cjs");
const {
  manifestDependencyIntent,
  manifestEditDependencyIntent,
  patchDependencyIntent
} = require("../vendor-sts/src/manifest-dependencies.cjs");

/** Tools that only observe state. */
export const READ_TOOLS = new Set([
  "read", "read_image", "glob", "grep",
  "web_search", "web_fetch",
  "list_agents", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "session_search", "session_event_search", "session_trace", "session_event_trace", "session_event_read",
  "job_list", "job_output",
  "acp_status", "acp_cache", "acp_read_original_image",
  "schedule_list", "search_context", "skill", "get_goal",
  "load_workspace_dependencies", "list_subagent_models",
  "team_task_list", "team_task_get",
  // cordis inspection is a read of the live plugin tree (rc.5 presets).
  "cordis_inspect_list", "cordis_inspect_query",
  // dsh-ops (third-party profile plugin) read surface
  "ops_inspect_local_file", "ops_glob", "ops_grep", "ops_read_files", "ops_stat",
  "ops_diff", "ops_read_table", "ops_read_docx", "ops_read_pdf", "ops_result_page"
]);

/** Tools that change plugin/session bookkeeping but never the working tree. */
export const CONTROL_TOOLS = new Set([
  "todo_write", "ask_user_question", "present", "sidebar_open",
  // run_code is the PTC dispatch container: the calls it makes are dispatched
  // as nested executions (exec.parent set) and are judged on their own. The
  // container itself only interprets script text.
  "run_code",
  "compress", "decompress",
  "create_goal", "update_goal",
  "schedule_create", "schedule_update", "schedule_delete",
  "job_kill", "interrupt_agent",
  "terminal_list", "terminal_read", "terminal_close", "terminal_signal",
  "working_directory",
  "send_message", "wait_agent",
  "team_task_create", "team_task_update",
  // rc.5: presenting a plan is a bookkeeping round-trip, not a file write.
  "exit_plan_mode",
  // rc.5: profile/plugin bookkeeping (install, market browse) happens in the
  // profile directory, never in the task working tree.
  "plugin_manager", "plugin_market",
  // rc.5: the unlag editor button applies its own edits through the host's
  // transaction; the tool itself only refreshes the button.
  "unlag_refresh",
  // rc.5: dsh-ops activation and session-owned result rows.
  "ops_load_sdk", "ops_result",
  // rc.5: @zaofan/dsh-qqbot channel tools act on a chat channel, never on the
  // task working tree; enabling a family is bookkeeping as well.
  "gain_qq_tools",
  "send_media", "recall_message", "list_stickers", "sticker_tag", "sticker_delete",
  "sticker_restore", "sticker_stats", "sticker_untagged", "schedule_timer", "schedule_cancel",
  "text_break", "reply_gate", "outbound_mode", "group_join_requests", "group_approve_join",
  "group_join_auto", "session_list", "broadcast_send", "target_group", "session_wake",
  "group_mute_state", "group_recall", "group_msg_search", "recall_keywords", "group_kick",
  "qq_material", "group_recall_batch", "group_mute_member", "id_lookup", "tools_reload",
  "quote_view", "people_memo", "context_memo", "context_compact", "context_drop",
  "qq_group_admin"
]);

/** Tools that launch another agent, consuming the delegation budget. */
export const DELEGATE_TOOLS = new Set([
  "subagent", "subagent_fork", "spawn_teammate",
  // rc.5 `workflow` runs a model-authored orchestration script that fans work
  // out across many subagents (and may run in the background as an owned job).
  // It spends the same delegation capacity as an explicit subagent call; the
  // file writes its children attempt are separate nested executions and are
  // judged on their own, exactly like run_code's sub-dispatches.
  "workflow"
]);

/** Tools that write the working tree. bash/pwsh are re-analysed by command. */
export const WRITE_TOOLS = new Set([
  "write", "edit", "str_replace_editor",
  "bash", "pwsh",
  "terminal_open", "terminal_send",
  "create_worktree",
  "ops_bash", "ops_pwsh", "ops_write_file", "ops_edit_file", "ops_replace",
  "ops_move", "ops_copy", "ops_remove", "ops_batch", "batch"
]);

/** Tools whose mutability is decided by the command text, not by their name. */
export const SHELL_TOOLS = new Set(["bash", "pwsh", "ops_bash", "ops_pwsh"]);

/**
 * Tools whose input names the one file they rewrite, so hash and dependency
 * intent can be read from the new text (write-like) or from the old/new pair
 * (edit-like).
 */
const DIRECT_WRITE_TOOLS = new Set(["write", "edit", "str_replace_editor", "ops_write_file", "ops_edit_file"]);

/** Tools that also write a destination path named by `to`. */
const MOVE_COPY_TOOLS = new Set(["ops_move", "ops_copy"]);

/**
 * Tools that write the working tree but cannot prove which paths: a multi-file
 * replace names a search root, and a batch names operations. They stay "write"
 * with no proven path, so a declared file boundary refuses them instead of
 * letting a broad edit through (WRITE_PATH_UNPROVEN).
 */
const BROAD_WRITE_TOOLS = new Set(["ops_replace", "ops_batch", "batch"]);

function isDirectWrite(tool) {
  return DIRECT_WRITE_TOOLS.has(tool) || tool.startsWith("ops_write") || tool.startsWith("ops_edit");
}

function isWindowsAbsolute(value) {
  const text = String(value || "");
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]+\\[^\\]+/.test(text);
}

/** Resolve one host path to an absolute path so decide() can compare it to a cwd. */
export function absolutePath(value, cwd) {
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return "";
  const base = typeof cwd === "string" && cwd ? cwd : process.cwd();
  if (isWindowsAbsolute(raw)) return raw.replace(/\//g, "\\");
  return path.resolve(base, raw);
}

/** The text a direct write adds: dsh-ops edits carry an `edits` array. */
function newTextOf(input) {
  if (!input || typeof input !== "object") return "";
  if (Array.isArray(input.edits)) {
    return input.edits.map((edit) => (edit && typeof edit.newText === "string" ? edit.newText : "")).join("\n");
  }
  return String(input.content ?? input.new_string ?? input.patch ?? "");
}

/** The text a direct edit removes: dsh-ops edits carry an `edits` array. */
function oldTextOf(input) {
  if (!input || typeof input !== "object") return "";
  if (Array.isArray(input.edits)) {
    return input.edits.map((edit) => (edit && typeof edit.oldText === "string" ? edit.oldText : "")).join("\n");
  }
  return String(input.old_string ?? "");
}

function firstPath(input) {
  if (!input || typeof input !== "object") return "";
  return input.file_path || input.path || input.notebook_path || input.target_file || "";
}

/** Every path a call proves it writes: the primary path plus a move/copy target. */
function provenPaths(tool, input, cwd) {
  const paths = [];
  const primary = absolutePath(firstPath(input), cwd);
  if (primary) paths.push(primary);
  if (MOVE_COPY_TOOLS.has(tool) && input && typeof input === "object") {
    const destination = absolutePath(input.to, cwd);
    if (destination && !paths.includes(destination)) paths.push(destination);
  }
  return paths;
}

/**
 * Classify one tool name without inspecting its arguments.
 *
 * @param name tool name exactly as the host dispatched it.
 * @returns {"read"|"control"|"write"|"shell"|"delegate"|"unknown"}
 */
export function toolCategory(name) {
  const tool = String(name || "");
  if (SHELL_TOOLS.has(tool)) return "shell";
  if (isDirectWrite(tool)) return "write";
  if (DELEGATE_TOOLS.has(tool)) return "delegate";
  if (READ_TOOLS.has(tool)) return "read";
  if (CONTROL_TOOLS.has(tool)) return "control";
  if (WRITE_TOOLS.has(tool)) return "write";
  return "unknown";
}

/**
 * Classify one DSH tool call.
 *
 * @param name tool name exactly as the host dispatched it (native or ops_*).
 * @param input the tool arguments, read from exec.arguments. At pre-execute
 *   exec.arguments is deep-frozen (exec itself is not; the host freezes it
 *   later, in notifyResult), so a classifier may read but never rewrite them.
 * @param cwd absolute working directory of the calling session.
 * @returns {{mutability: string, affectedPaths: string[], hashIntent: boolean,
 *            dependencyIntent: boolean, analysisReason?: string, unboundedDelegation: boolean}}
 */
export function analyzeDshTool(name, input, cwd) {
  const tool = String(name || "");
  const facts = {
    mutability: "unknown",
    affectedPaths: [],
    hashIntent: false,
    dependencyIntent: false,
    unboundedDelegation: false
  };

  const category = toolCategory(tool);

  if (category === "shell") {
    const shell = analyzeShellInput(input);
    facts.mutability = shell.mutability;
    facts.hashIntent = Boolean(shell.hashIntent);
    facts.dependencyIntent = Boolean(shell.dependencyIntent);
    if (shell.analysisReason) facts.analysisReason = shell.analysisReason;
    // Since upstream 0.2.5.1 the shell analyser names the write target of the
    // commands whose arguments prove one: mkdir, rm, cp, mv, touch, git add,
    // Set-Content, Remove-Item and a redirection. Without this union the file
    // boundary still saw no path and denied a command that had already proved
    // where it writes, with WRITE_PATH_UNPROVEN.
    facts.affectedPaths = combineAffectedPaths([], shell, (value) => absolutePath(value, cwd));
    return facts;
  }

  if (category === "delegate") {
    facts.mutability = "delegate";
    return facts;
  }

  if (category === "read") {
    facts.mutability = "read";
    return facts;
  }

  if (category === "control") {
    facts.mutability = "control";
    return facts;
  }

  if (category === "write") {
    facts.mutability = "write";
    facts.affectedPaths = provenPaths(tool, input, cwd);

    if (isDirectWrite(tool)) {
      const filePath = facts.affectedPaths[0] || "";
      if (filePath) {
        const newText = newTextOf(input);
        facts.hashIntent = fileHashIntent(filePath, newText);
        facts.dependencyIntent = tool === "write" || tool === "ops_write_file"
          ? manifestDependencyIntent(filePath, newText)
          : manifestEditDependencyIntent(filePath, oldTextOf(input), newText);
      }
      return facts;
    }

    if (BROAD_WRITE_TOOLS.has(tool)) {
      // The input names no single file: keep the write but prove no path, so a
      // declared boundary refuses it rather than trusting a search root.
      facts.affectedPaths = [];
      return facts;
    }

    if (tool === "apply_patch" || (input && typeof input.patch === "string")) {
      facts.hashIntent = patchHashIntent(input.patch);
      facts.dependencyIntent = patchDependencyIntent(input.patch);
    }
    return facts;
  }

  return facts;
}
