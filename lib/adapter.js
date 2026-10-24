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
  "team_task_create", "team_task_update"
]);

/** Tools that launch another agent, consuming the delegation budget. */
export const DELEGATE_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate"]);

/** Tools that write the working tree. bash/pwsh are re-analysed by command. */
export const WRITE_TOOLS = new Set([
  "write", "edit", "str_replace_editor",
  "bash", "pwsh",
  "terminal_open", "terminal_send",
  "create_worktree",
  "ops_bash", "ops_pwsh", "ops_write_file", "ops_edit_file", "ops_replace",
  "ops_move", "ops_copy", "ops_remove", "ops_batch", "batch"
]);

const SHELL_TOOLS = new Set(["bash", "pwsh", "ops_bash", "ops_pwsh"]);

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

function textOfInput(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return String(input.command || input.patch || input.content || input.new_string || "");
}

function firstPath(input) {
  if (!input || typeof input !== "object") return "";
  return input.file_path || input.path || input.notebook_path || input.target_file || "";
}

/**
 * Classify one DSH tool call.
 *
 * @param name tool name exactly as the host dispatched it (native or ops_*).
 * @param input the frozen exec.arguments object.
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

  if (SHELL_TOOLS.has(tool)) {
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

  if (tool === "write" || tool === "edit" || tool === "str_replace_editor" || tool.startsWith("ops_write") || tool.startsWith("ops_edit")) {
    facts.mutability = "write";
    const filePath = absolutePath(firstPath(input), cwd);
    if (filePath) {
      facts.affectedPaths = [filePath];
      if (tool === "write") {
        facts.hashIntent = fileHashIntent(filePath, input && input.content);
        facts.dependencyIntent = manifestDependencyIntent(filePath, input && input.content);
      } else {
        facts.hashIntent = fileHashIntent(filePath, textOfInput(input));
        facts.dependencyIntent = manifestEditDependencyIntent(
          filePath, input && input.old_string, input && input.new_string
        );
      }
    }
    return facts;
  }

  if (tool === "run_code") {
    // Nested PTC calls are classified on their own; the container is not a
    // write. A script that touches the disk through node:fs bypasses this
    // classifier — see the README's known limits.
    facts.mutability = "control";
    return facts;
  }

  if (DELEGATE_TOOLS.has(tool)) {
    facts.mutability = "delegate";
    return facts;
  }
  if (READ_TOOLS.has(tool)) {
    facts.mutability = "read";
    return facts;
  }
  if (CONTROL_TOOLS.has(tool)) {
    facts.mutability = "control";
    return facts;
  }
  if (WRITE_TOOLS.has(tool)) {
    facts.mutability = "write";
    const filePath = absolutePath(firstPath(input), cwd);
    if (filePath) facts.affectedPaths = [filePath];
    if (tool === "apply_patch" || (input && typeof input.patch === "string")) {
      facts.hashIntent = patchHashIntent(input.patch);
      facts.dependencyIntent = patchDependencyIntent(input.patch);
    }
    return facts;
  }
  return facts;
}
