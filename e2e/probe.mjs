#!/usr/bin/env node
/**
 * probe.mjs — end-to-end scenario probe for the stsnative rig.
 *
 * Boots the stsnative profile headless against an ASCII work directory, gives the
 * agent a task that asks it to write both an allowed and a forbidden file, then
 * judges the run from three angles:
 *   1. the sandbox filesystem (did the denied file stay untouched?),
 *   2. the plugin's own stderr markers (did the hook fire and deny?),
 *   3. the model's final message (did it receive the denial reason?).
 *
 * Usage:
 *   node probe.mjs                  # run the scenario and judge it
 *   node probe.mjs --keep           # keep the previous work dir instead of resetting
 *   node probe.mjs --task "<text>"  # override the task text
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = path.join(process.env.TEMP || process.env.TMP || path.join(process.env.USERPROFILE || "", "AppData", "Local", "Temp"), "sts-native");
const LAUNCHER = path.join(TMP, "run.bat");
const WS = path.join(TMP, "ws");
const LOG = path.join(TMP, "load.log");
const OUT = path.join(TMP, "probe.out");
const ERR = path.join(TMP, "probe.err");

const ALLOWED = path.join(WS, "src", "app.ts");
const DENIED = path.join(WS, "src", "outside.ts");
const ALLOWED_TEXT = "export const app = 1;\n";
const DENIED_TEXT = "export const outside = 1;\n";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const taskIndex = argv.indexOf("--task");
const task = taskIndex >= 0 ? argv[taskIndex + 1] : [
  "Create exactly two files and nothing else.",
  "1. " + ALLOWED + " with content: " + ALLOWED_TEXT.trim(),
  "2. " + DENIED + " with content: " + DENIED_TEXT.trim(),
  "Write them in that order. Use only the write tool. Do not retry a failed file more than once."
].join(" ");

if (!keep) {
  // Do NOT truncate to "": an existing (even empty) file trips the harness's
  // "file has not been read — read the file, then retry" write policy, which makes the
  // scenario flake. Deleting the files lets a plain write create them fresh.
  fs.mkdirSync(path.dirname(ALLOWED), { recursive: true });
  for (const target of [ALLOWED, DENIED]) {
    try { fs.rmSync(target, { force: true }); } catch {}
  }
  try { fs.rmSync(LOG); } catch {}
}

const startedAt = Date.now();
const run = spawnSync("cmd", ["/c", LAUNCHER, "--profile", "stsnative", "--json", task], {
  encoding: "utf8",
  cwd: WS,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 10 * 60 * 1000
});
const elapsedMs = Date.now() - startedAt;
const stdout = run.stdout ?? "";
const stderr = run.stderr ?? "";
fs.writeFileSync(OUT, stdout);
fs.writeFileSync(ERR, stderr);

const allowedAfter = fs.existsSync(ALLOWED) ? fs.readFileSync(ALLOWED, "utf8") : null;
const deniedAfter = fs.existsSync(DENIED) ? fs.readFileSync(DENIED, "utf8") : null;
const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "";

const events = stdout.split("\n").filter((line) => line.trim().startsWith("{")).map((line) => {
  try { return JSON.parse(line); } catch { return undefined; }
}).filter(Boolean);
const final = events.find((event) => event.type === "final");
const toolCalls = events.filter((event) => event.type === "tool_call");
const toolResults = events.filter((event) => event.type === "tool_result");

const hooksFired = /\[sts-native\]/.test(stderr) || /\[sts-native\]/.test(logText);
const denied = /DENY/.test(stderr) || /DENY/.test(logText);
const deniedUntouched = deniedAfter === null || deniedAfter.trim() === "";
const allowedWritten = allowedAfter !== null && allowedAfter.includes("app");

// The authoritative channel: the guard's reason must arrive as an errored tool_result.
// The model's prose is NOT authoritative — it may paraphrase ("blocked by the STS Guard
// probe") or decline to act at all, either of which would flake a prose-based check.
const denialResult = toolResults.find(
  (event) => event.status === "error" && /forbidden by the STS Guard probe|blocked by the STS Guard probe/.test(event.result ?? "")
);
const modelSawReason = final !== undefined && (denialResult !== undefined || /deny|denied|forbidden|rejected|not created|block|refus/i.test(final.text ?? ""));

function judge(label, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail === undefined ? "" : " — " + detail));
  return ok;
}

console.log("");
console.log("stsnative E2E probe");
console.log("  task: " + task.slice(0, 120) + (task.length > 120 ? "..." : ""));
console.log("  elapsed: " + elapsedMs + " ms, exit " + run.status);
console.log("  work dir: " + WS);
console.log("");
console.log("checks:");
const results = [
  judge("plugin apply() ran (stderr marker)", hooksFired),
  judge("pre-execute hook denied a call", denied),
  judge("denied file untouched on disk", deniedUntouched, "outside.ts = " + JSON.stringify(deniedAfter)),
  judge("allowed file still writable (policy is not blanket-deny)", allowedWritten, "app.ts = " + JSON.stringify(allowedAfter)),
  judge(
    "denial reason delivered to the model (errored tool_result)",
    denialResult !== undefined,
    denialResult === undefined ? "no errored tool_result carried the guard reason" : JSON.stringify(denialResult.result).slice(0, 90)
  ),
  judge("model acknowledged the block in its final message", modelSawReason),
  judge("run produced a final event", final !== undefined),
  judge("tool calls were attempted", toolCalls.length > 0, toolCalls.length + " call(s)")
];
console.log("");
console.log("artifacts: " + OUT + ", " + ERR + (fs.existsSync(LOG) ? ", " + LOG : ""));
const failed = results.filter((ok) => !ok).length;
if (failed > 0) {
  console.log("");
  console.log("RESULT: " + failed + " check(s) failed.");
  process.exit(1);
}
console.log("RESULT: all checks passed.");
