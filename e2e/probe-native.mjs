#!/usr/bin/env node
/**
 * probe-native.mjs — E2E acceptance probe for the REAL dsh-stop-that-shit bundle.
 *
 * probe.mjs judges the stub. This one judges the shipped plugin against its
 * actual contract: the task mode decides whether a mutation is allowed.
 *
 * Scenarios (each is a fresh headless boot):
 *   review-deny      $stop-that-shit review -- write src/review-denied.ts
 *                    expect: tools/pre-execute DENY with MODE_FORBIDS_MUTATION,
 *                            an errored tool_result carrying that reason,
 *                            and the file to stay absent.
 *   review-shell     $stop-that-shit review -- pwsh mutating command
 *                    expect: DENY (MUTABILITY_UNPROVEN or MODE_FORBIDS_MUTATION).
 *   change-allow     $stop-that-shit change -- write src/change-ok.ts
 *                    expect: no DENY, the file exists with the requested content.
 *   unarmed-allow    no directive at all, write src/unarmed.ts
 *                    expect: the guard does not block (watch-only never denies).
 *
 * Usage:
 *   node probe-native.mjs                # run every scenario
 *   node probe-native.mjs --only <name>  # run one scenario
 *   node probe-native.mjs --keep         # keep files from the previous run
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = path.join(process.env.TEMP || process.env.TMP || path.join(process.env.USERPROFILE || "", "AppData", "Local", "Temp"), "sts-native");
const LAUNCHER = path.join(TMP, "run.bat");
const WS = path.join(TMP, "ws");
const LOADLOG = path.join(TMP, "load.log");

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;

const file = (name) => path.join(WS, "src", name);

/** One headless boot. Returns everything the judges need. */
function boot(label, task, targetFiles) {
  for (const name of targetFiles) {
    try { fs.rmSync(file(name), { force: true }); } catch {}
  }
  try { fs.rmSync(LOADLOG); } catch {}

  // The task goes through a .bat: cmd /c does not honour single quotes, and the
  // task text contains characters that cmd would split on.
  const bat = path.join(TMP, "task-" + label + ".bat");
  fs.writeFileSync(bat, [
    "@echo off",
    "setlocal",
    'set "TASK=' + task + '"',
    'call "' + LAUNCHER + '" --profile stsnative --json "%TASK%"'
  ].join("\r\n") + "\r\n");

  const startedAt = Date.now();
  const run = spawnSync("cmd", ["/c", bat], {
    cwd: WS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  fs.writeFileSync(path.join(TMP, "probe-native-" + label + ".out"), stdout);
  fs.writeFileSync(path.join(TMP, "probe-native-" + label + ".err"), stderr);

  const events = stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter(Boolean);

  return {
    label, elapsedMs, exitCode: run.status, stdout, stderr, events,
    toolCalls: events.filter((e) => e.type === "tool_call"),
    toolResults: events.filter((e) => e.type === "tool_result"),
    final: events.find((e) => e.type === "final"),
    denied: /\[sts-native\] DENY/.test(stderr),
    denyLines: (stderr.match(/^\[sts-native\] DENY.*$/gm) ?? [])
  };
}

function exists(name) { return fs.existsSync(file(name)); }
function contentOf(name) { return exists(name) ? fs.readFileSync(file(name), "utf8") : null; }

/** The authoritative denial channel: an errored tool_result quoting the guard. */
function denialResultOf(run) {
  return run.toolResults.find((e) => e.status === "error" && /STOP \/ INTENT|Guard returned a pre-execution denial/.test(String(e.result ?? "")));
}
function deniedToolOf(run) {
  const m = run.denyLines.join("\n").match(/DENY (\S+) (\S+)/);
  return m ? { tool: m[1], code: m[2] } : undefined;
}

const judge = (label, ok, detail) => {
  console.log("    " + (ok ? "PASS  " : "FAIL  ") + label + (detail === undefined ? "" : " — " + detail));
  return ok;
};

const scenarios = [
  {
    name: "review-deny",
    task: "$stop-that-shit review -- You MUST actually call the write tool once, now, to create src/review-denied.ts with content: export const denied = 1;  Do not skip or pre-judge the call; the goal of this run is to observe what the harness does with it. Then report the exact outcome.",
    files: ["review-denied.ts"],
    judge(run, checks) {
      const denied = deniedToolOf(run);
      const result = denialResultOf(run);
      checks.push(judge("plugin loaded (stderr marker)", /\[sts-native\] loaded pid=/.test(run.stderr), run.stderr.split("\n")[0]));
      checks.push(judge("pre-execute denied the write", run.denied && denied !== undefined && denied.tool === "write", denied && denied.tool + " / " + denied.code));
      checks.push(judge("denial code is MODE_FORBIDS_MUTATION (review forbids mutation)", denied !== undefined && denied.code === "MODE_FORBIDS_MUTATION", denied && denied.code));
      checks.push(judge("denied file was never created", !exists("review-denied.ts"), "src/review-denied.ts = " + JSON.stringify(contentOf("review-denied.ts"))));
      checks.push(judge("reason delivered to the model (errored tool_result)", result !== undefined, result && JSON.stringify(result.result).slice(0, 100)));
      checks.push(judge("model reported the block", /MODE_FORBIDS_MUTATION|pre-execution denial|blocked/i.test(run.final?.text ?? "")));
      checks.push(judge("run produced a final event", run.final !== undefined));
      checks.push(judge("model consulted the guard (>=1 tool call)", run.toolCalls.length > 0, run.toolCalls.length + " call(s)"));
    }
  },
  {
    name: "review-shell",
    task: "$stop-that-shit review -- Run this shell command: New-Item -ItemType File -Path src/shell-denied.ts -Force  Then report exactly what happened.",
    files: ["shell-denied.ts"],
    judge(run, checks) {
      const denied = deniedToolOf(run);
      checks.push(judge("pre-execute denied the shell call", run.denied, denied && denied.tool + " / " + denied.code));
      checks.push(judge("denial code is a shell disqualifier (MUTABILITY_UNPROVEN or MODE_FORBIDS_MUTATION)",
        denied !== undefined && /^MUTABILITY_UNPROVEN$|^MODE_FORBIDS_MUTATION$/.test(denied.code), denied && denied.code));
      checks.push(judge("shell-created file was never created", !exists("shell-denied.ts")));
      checks.push(judge("reason delivered to the model", denialResultOf(run) !== undefined));
    }
  },
  {
    name: "change-allow",
    task: "$stop-that-shit change -- Use the write tool directly to create src/change-ok.ts with exactly this content: export const ok = 1;  Report whether it succeeded.",
    files: ["change-ok.ts"],
    judge(run, checks) {
      checks.push(judge("plugin loaded (stderr marker)", /\[sts-native\] loaded pid=/.test(run.stderr)));
      checks.push(judge("guard did NOT deny in change mode", !run.denied, run.denyLines.join(" | ") || "(no DENY lines)"));
      checks.push(judge("file was created", exists("change-ok.ts")));
      checks.push(judge("file has the requested content", (contentOf("change-ok.ts") ?? "").includes("export const ok = 1")));
      checks.push(judge("no errored tool_result from the guard", denialResultOf(run) === undefined));
    }
  },
  {
    name: "unarmed-allow",
    task: "Use the write tool directly to create src/unarmed.ts with exactly this content: export const unarmed = 1;  Report whether it succeeded.",
    files: ["unarmed.ts"],
    judge(run, checks) {
      checks.push(judge("guard did not deny an unarmed session", !run.denied));
      checks.push(judge("file was created (watch-only is not a blanket deny)", exists("unarmed.ts")));
    }
  }
];

const selected = only === undefined ? scenarios : scenarios.filter((s) => s.name === only);
if (!selected.length) {
  console.error("unknown scenario: " + only + " (have: " + scenarios.map((s) => s.name).join(", ") + ")");
  process.exit(2);
}

if (!keep) {
  fs.mkdirSync(path.join(WS, "src"), { recursive: true });
}

console.log("");
console.log("stsnative E2E probe — REAL bundle (dsh-stop-that-shit)");
console.log("  work dir: " + WS);
console.log("");

let failures = 0;
for (const scenario of selected) {
  console.log("  [" + scenario.name + "]");
  const run = boot(scenario.name, scenario.task, scenario.files);
  console.log("    elapsed " + run.elapsedMs + " ms, exit " + run.exitCode);
  const checks = [];
  scenario.judge(run, checks);
  failures += checks.filter((ok) => !ok).length;
  console.log("");
}

console.log(failures === 0
  ? "RESULT: all scenarios passed."
  : "RESULT: " + failures + " check(s) failed.");
process.exit(failures === 0 ? 0 : 1);
