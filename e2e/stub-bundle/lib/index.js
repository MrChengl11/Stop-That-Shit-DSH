import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const name = "sts-native";
export const inject = [];

const LOG = path.join(os.tmpdir(), "sts-native", "load.log");

function log(message) {
  const line = "[sts-native] " + message;
  try { process.stderr.write(line + "\n"); } catch {}
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + "\n");
  } catch {}
}

/**
 * The host gate contract (dsh-tools prepareExecution, line 3332 vs 3337):
 *   { kind: "cancel" }  -> toolAbortedBeforeDispatchResult(); the reason is DISCARDED
 *                          and the model only ever sees "Error: tool call aborted before dispatch".
 *   { kind: "deny", reason } -> { content: [{ type: "text", text: "Error: <reason>" }], isError: true }
 * A guard that wants its reason delivered MUST use kind: "deny".
 */
const BANNED_PATH = /outside\.ts/i;
const BANNED_COMMAND = /rm\s+-rf|Remove-Item[^|]*-Recurse/i;

export function apply(ctx, config) {
  log("loaded pid=" + process.pid + " cwd=" + process.cwd());
  log("config=" + JSON.stringify(config ?? null));

  ctx.on("tools/pre-execute", async (exec, next) => {
    // Tool arguments live in exec.arguments. exec.args / exec.input are both undefined.
    const args = exec.arguments ?? {};
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    const command = typeof args.command === "string" ? args.command : "";

    if (BANNED_PATH.test(filePath)) {
      log("DENY " + exec.name + " (matched outside.ts)");
      return {
        kind: "deny",
        reason: "sts-native stub: access to outside.ts is forbidden by the STS Guard probe"
      };
    }
    if (BANNED_COMMAND.test(command)) {
      log("DENY " + exec.name + " (banned shell pattern)");
      return {
        kind: "deny",
        reason: "sts-native stub: destructive shell command blocked by the STS Guard probe"
      };
    }
    return next();
  }, { prepend: true });

  log("hooked tools/pre-execute OK");
}
