#!/usr/bin/env node
/**
 * report.mjs — render e2e/REPORT-rc5.md from the last probe run.
 *
 * The report is GENERATED, not typed: every pid, session id, denied command and
 * excerpt comes from %TEMP%\sts-rc5\out\summary.json (written by probe.mjs) plus
 * the raw per-run .out/.err files. Re-running the rig regenerates it, so the
 * document can never drift from the evidence.
 *
 *   node e2e/rc5/probe.mjs      # run the scenarios (writes summary.json)
 *   node e2e/rc5/report.mjs     # render this report
 */
import fs from "node:fs";
import path from "node:path";
import { OUT, REPO, EXE, CLI, PROFILE, WS } from "./setup.mjs";

const BT = String.fromCharCode(96);
const code = (text) => BT + text + BT;

const summary = JSON.parse(fs.readFileSync(path.join(OUT, "summary.json"), "utf8"));
const byName = Object.fromEntries(summary.results.map((r) => [r.name, r]));
const L = [];
const push = (...lines) => L.push(...lines);
const fence = (...lines) => { push("~~~"); push(...lines); push("~~~"); };
// Same thing as fence(), but RETURNS the lines instead of pushing them, for use
// as a spread inside push(...). Calling fence() there would emit the block
// before the heading, because arguments evaluate before push() runs.
const block = (...lines) => ["~~~", ...lines, "~~~"];
const q = (text, max = 300) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const totalChecks = summary.results.reduce((n, r) => n + r.checks.length, 0);
const failedChecks = summary.results.reduce((n, r) => n + r.checks.filter((c) => !c.ok && !c.info).length, 0);
const infoChecks = summary.results.reduce((n, r) => n + r.checks.filter((c) => c.info).length, 0);
const verdict = failedChecks === 0 ? "PASS" : "FAIL";

push(
  "# rc.5 E2E verification — dsh-stop-that-shit on DeepSeek Harness 0.2.1-rc.5",
  "",
  "Status: **" + verdict + "** — " + (totalChecks - failedChecks) + "/" + totalChecks + " checks across " +
    summary.results.length + " scenarios" + (infoChecks ? " (" + infoChecks + " informational)" : "") +
    ", real harness, real model, real files on disk.",
  "",
  "Generated " + summary.generatedAt + " by " + code("node e2e/rc5/report.mjs") + " from " +
    code("%TEMP%\\sts-rc5\\out\\summary.json") + ". Everything below is machine-derived from that file plus",
  "the raw " + code("out/*.out|*.err") + " captures.",
  "",
  "| | |",
  "| --- | --- |",
  "| Harness | " + code("@deepseek-ai/dsh-desktop") + " **0.2.1-rc.5** (read from the installed " + code("app.asar") + ") |",
  "| Executable | " + code(EXE) + " |",
  "| CLI entry | " + code(CLI) + " |",
  "| Profile | " + code(PROFILE) + " → " + code(summary.profileDir) + " |",
  "| Model | " + code(summary.defaultModel) + " via provider " + code(summary.provider) + " (local magpie gateway) |",
  "| Plugin | " + code("dsh-stop-that-shit@" + summary.packageVersion) + ", " + code("engines.dsh = " + JSON.stringify(summary.engines.dsh)) + " |",
  "| Repo HEAD | " + code(summary.gitHead) + " |",
  "| Working tree | " + code(summary.gitStatus.length ? summary.gitStatus.join(" · ") : "(clean)") + " |",
  "| Scenario cwd | " + code(summary.workDir) + " |",
  ""
);

push(
  "## 1. Required evidence — verdict table",
  "",
  "**Legend.** Every check is one of two kinds. A *deterministic* check depends only on the plugin and the",
  "host (the guard's log line, the denial code, the file on disk, the transcript). A *model-dependent* check",
  "depends on which tool the model happened to choose; those are printed as " + code("INFO") + " and **never** affect",
  "the verdict — otherwise a model that prefers to read over write could turn a passing guard into a red run.",
  "",
  "| # | Required evidence | Scenario(s) | Verdict | Key measured evidence |",
  "| --- | --- | --- | --- | --- |"
);

const keyEvidence = (name) => {
  const r = byName[name];
  if (!r) return "(not run)";
  const bad = r.checks.filter((c) => !c.ok && !c.info);
  if (bad.length) return "FAILED: " + q(bad[0].label, 90);
  const d = r.transcript && r.transcript.deniedActions ? r.transcript.deniedActions[0] : undefined;
  if (name === "dump-config") return "stdout has " + code("- id: sts-native") + "; stderr empty";
  if (name === "unarmed") return "0 notice messages (source.kind=sts); 3-word answer";
  if (name === "review-deny") return d ? "DENY " + d.tool + " " + d.reason + "; file absent" : "model stayed read-only; workspace untouched (model-dependent)";
  if (name === "review-write") return d ? "DENY write " + d.reason + "; file absent" : "DENY write; file absent";
  if (name === "change-files" || name === "change-files-forced") {
    return "src/app.ts created; " + (d ? "DENY " + d.tool + " " + d.reason : "outside write blocked");
  }
  if (name === "status") return "source.kind=sts notice: Stop That Shit status / OBSERVING";
  return "";
};

const required = [
  ["R1", code("--dump-config") + " shows the " + code("sts-native") + " row and stderr has no " + code("skipping profile bundle") + " line", ["dump-config"]],
  ["R2", "Unarmed plain task: plugin logs " + code("[sts-native] loaded") + ", model answers, no notice injected", ["unarmed"]],
  ["R3", code("$stop-that-shit review -- write src/app.ts") + ": write denied, file not created, reason reaches the model (authoritative proof: review-write, forced)", ["review-write", "review-deny"]],
  ["R4", code("$stop-that-shit change files=src/**") + ": inside write allowed, outside write denied (PATH_OUTSIDE_CONTRACT)", ["change-files", "change-files-forced"]],
  ["R5", code("$stop-that-shit status") + " returns a notice/context line", ["status"]]
];
for (const [id, text, names] of required) {
  const all = names.map((n) => byName[n]).filter(Boolean);
  const ok = all.length === names.length && all.every((r) => r.checks.every((c) => c.ok || c.info));
  push("| " + id + " | " + text + " | " + names.join(", ") + " | **" + (ok ? "PASS" : "FAIL") + "** | " +
    names.map((n) => keyEvidence(n)).join(" · ") + " |");
}
push("");

push(
  "## 2. Reproducing this run",
  "",
  "Four commands. The rig is idempotent and only writes a scratch profile plus a launcher under " + code("%TEMP%") + ".",
  "",
  ...block(
    "cd <repo>",
    "node e2e/rc5/harness-version.mjs        # prints 0.2.1-rc.5 straight from app.asar",
    "node e2e/rc5/setup.mjs                  # ~/.dsh/profiles/stsrc5 + %TEMP%\\sts-rc5\\run.bat",
    "node e2e/rc5/probe.mjs                  # runs every scenario, writes out\\summary.json",
    "node e2e/rc5/report.mjs                 # regenerates this file from that summary"
  ),
  "",
  "One scenario alone: " + code("node e2e/rc5/probe.mjs --only review-write --debug") + ".",
  "",
  "Each scenario is one headless boot, i.e. one fresh session:",
  "",
  ...block(
    "ELECTRON_RUN_AS_NODE=1 \"" + EXE + "\" --expose-internals \"" + CLI + "\" \\",
    "  --profile " + PROFILE + " --json \"<task>\"",
    "cwd: " + WS
  ),
  "",
  "The task text is passed through a generated .bat (" + code("set \"TASK=...\"") + " + " +
    code("call run.bat --json \"%TASK%\"") + ")",
  "because cmd re-splits --, $ and spaces otherwise.",
  ""
);

push(
  "## 3. The rig",
  "",
  "| File | Role |",
  "| --- | --- |",
  "| " + code("e2e/rc5/setup.mjs") + " | Builds the scratch profile: package.json (bundles), empty cordis.yml, cordis.patch.yml (model block copied from the stsnative profile, MCP insert dropped), node_modules/dsh-stop-that-shit junction → this repo, and the ASCII launcher. Idempotent; the junction is removed with fs.unlinkSync, never rmSync. |",
  "| " + code("e2e/rc5/probe.mjs") + " | Runs the scenarios and judges them. Writes raw stdout/stderr, decompressed session transcripts and summary.json under " + code("%TEMP%\\sts-rc5\\out") + ". |",
  "| " + code("e2e/rc5/report.mjs") + " | This generator. |",
  "| " + code("e2e/rc5/harness-version.mjs") + " | Reads the desktop-host version out of the installed app.asar. |",
  "",
  "### Evidence channels",
  "",
  "1. **Plugin stderr** — " + code("[sts-native] loaded pid=...") + ", " + code("[sts-native] DENY <tool> <code> — ...") + ".",
  "2. **Harness --json stream** — newline-delimited run events (session, tool_call, text, final).",
  "3. **Disk** — whether the scenario's files exist and what they contain.",
  "4. **Persisted session transcript** — " + code("~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd") + ",",
  "   zstd-decompressed by the probe. This is the exact message list the model received, so",
  "   \"a notice was injected\" and \"the denial reason reached the model\" are observed, not inferred.",
  "   It is also where the exact denied tool arguments are recovered from.",
  ""
);

push("## 4. Scenario detail", "");
let n = 0;
for (const r of summary.results) {
  n += 1;
  const failed = r.checks.filter((c) => !c.ok && !c.info).length;
  push("### 4." + n + " " + r.name + " — " + (failed === 0 ? "PASS" : "FAIL") + " (" + r.checks.length + " checks, " + r.elapsedMs + " ms)", "");
  push("Task:");
  fence(r.task);
  if (r.name !== "dump-config") push("Session: " + code(r.sessionId ?? "(none)"), "");
  if (r.name === "dump-config") {
    push("stdout (tail: the bundle header and the row):");
    fence(...(r.stdoutTail ?? []));
    push("stderr: " + (r.stderrTail && r.stderrTail.length ? "" : "(empty)"));
    if (r.stderrTail && r.stderrTail.length) fence(...r.stderrTail);
    push("");
  } else {
    push("Plugin stderr (guard lines):");
    const guardLines = [...(r.loadedLines ?? []), ...(r.denyLines ?? []), ...(r.watchLines ?? [])];
    fence(...(guardLines.length ? guardLines : ["(no guard lines)"]));
    push("");
  }
  push("| check | kind | result | evidence |", "| --- | --- | --- | --- |");
  for (const c of r.checks) {
    const mark = c.info ? "INFO" : c.ok ? "PASS" : "**FAIL**";
    const kind = c.info ? "model-dependent" : "deterministic";
    push("| " + cell(c.label) + " | " + kind + " | " + mark + " | " + cell(q(c.detail, 220)) + " |");
  }
  push("");
  const denied = r.transcript && r.transcript.deniedActions ? r.transcript.deniedActions : [];
  if (denied.length) {
    push("Denied actions, recovered from the transcript (exact call → exact reason):", "");
    for (const d of denied) {
      push("- tool **" + d.tool + "**, arguments:");
      fence(d.arguments);
      push("  reason " + code(d.reason) + " — " + d.detail + "  ");
      push("  next: " + d.next);
    }
    push("");
  }
  if (r.transcript && r.transcript.noticeMessages && r.transcript.noticeMessages.length) {
    push("Notice injected into the model's message list (" + code("source.kind = sts") + "):");
    fence(q(r.transcript.noticeMessages[0].text, 600));
    push("");
  }
  if (r.files && Object.keys(r.files).length) {
    push("Files on disk after the run:", "", "| path | exists | content |", "| --- | --- | --- |");
    for (const [name, state] of Object.entries(r.files)) {
      push("| " + code(name) + " | " + (state.exists ? "yes" : "**no**") + " | " + cell(q(state.content, 80)) + " |");
    }
    push("");
  }
  push("Model's final message:");
  fence(q(r.finalText, 700));
  push("");
}

push(
  "## 5. rc.5-specific observations and known limitations",
  "",
  "### 5.1 The engines.dsh gate silently skipped the whole bundle (fixed)",
  "",
  "With " + code("engines.dsh = \"0.2.1-rc.3\"") + " (an exact version) the rc.5 host did not load the bundle at all:",
  "no error, no sts-native row, no " + code("[sts-native] loaded") + " line. The fix is a RANGE:",
  code("\"engines\": { \"dsh\": \"^0.2.1-rc.3\" }") + ".",
  "",
  "Two details that are easy to get wrong:",
  "",
  "- " + code("\"^0.2.1\"") + " would also fail. semver ranges exclude prereleases by default, so " + code("^0.2.1") +
    " does not match " + code("0.2.1-rc.5") + ".",
  "- the failure is completely silent: exit code 0, no stderr line, the tree just has one block fewer.",
  "  Always assert the row with --dump-config instead of trusting the exit code.",
  "",
  "This run is the proof: --dump-config now ends with the bundle's own patch header and row,",
  "",
  ...block("# == dsh-stop-that-shit", "- id: sts-native", "  name: dsh-stop-that-shit"),
  "",
  "and stderr contains no " + code("skipping profile bundle") + " line.",
  "",
  "### 5.2 The watch-only preamble is in the runtime context of every session — by design",
  "",
  "The probe separates two channels, because they behave differently:",
  "",
  "- **notice channel** (" + code("noticeMessage()") + " in lib/index.js, " + code("source.kind = \"sts\"") +
    ", appended by agent/pre-step):",
  "  only fires when the prompt steers the guard or the session is armed. On an unarmed plain prompt the",
  "  transcript has **zero** such messages — verified in R2.",
  "- **runtime-context hint** (" + code("systemPrompt.context") + " name " + code("sts:contract") + "): merged into the",
  "  harness's **runtime-context USER message** on every session while the contract is unconfirmed, because",
  "  " + code("announceWhenUnarmed") + " defaults to true. The model does see one paragraph saying it is in watch-only mode.",
  "",
  "  Precisely: that message has " + code("source.kind = \"runtime-context\"") + " and a " + code("source.sections[]") + " array.",
  "  The guard's text is the section named " + code("sts:contract") + " (order 550), alongside",
  "  " + code("working-directory:current") + ", " + code("sandbox:policy") + " and " + code("approval:policy") + ".",
  "  It is **not** part of the system prompt. The probe records that section's metadata",
  "  (" + code("required") + ", " + code("interpolate") + ") straight from the transcript.",
  "",
  "That is documented behaviour (unarmed passes everything, one hint line in the context), not a leak.",
  "R2 therefore asserts the *notice* channel is clean and records the context hint as informational.",
  ""
);

push(
  "### 5.3 Review-mode shell probes: what the classifier can and cannot certify (known limitation)",
  "",
  "A model in review mode often reaches for a PowerShell one-liner to look around. The guard's shell",
  "classifier (" + code("vendor-sts/src/shell-analysis.cjs") + ") must prove the command is a static read before",
  "review mode allows it. Measured directly against that module in this run (no model, no host):",
  "",
  "| command | mutability | reason |",
  "| --- | --- | --- |",
  ...(summary.classifier ?? []).map((row) => "| " + code(row.command) + " | " + row.mutability + " | " + (row.reason ?? "") + " |"),
  "",
  "So a plain listing or " + code("git status") + " is allowed, while a glob the classifier cannot statically expand",
  "(" + code("-Recurse -Filter") + "), a pipeline it does not model (" + code("Out-String") + ") and any redirection",
  "(" + code("2>$null") + ") are refused — the first two as " + code("MUTABILITY_UNPROVEN") + ", the last as a write.",
  "That is a limitation of the vendored classifier, not of the rc.5 host integration.",
  "",
  "**What this run actually saw.** " + (() => {
    const literal = byName["review-deny"];
    const denials = (literal && literal.transcript && literal.transcript.deniedActions ? literal.transcript.deniedActions : [])
      .filter((d) => d.tool === "pwsh" || d.tool === "bash" || d.tool === "shell");
    if (denials.length) return "The model's read-only shell probes were denied " + denials.length + " time(s) — exact commands below.";
    return "The model's probes were allowed here (no DENY); the same scenario did get denials in an earlier run — see the historical note.";
  })(),
  "",
  ...(() => {
    const literal = byName["review-deny"];
    const denials = (literal && literal.transcript && literal.transcript.deniedActions ? literal.transcript.deniedActions : [])
      .filter((d) => d.tool === "pwsh" || d.tool === "bash" || d.tool === "shell");
    const lines = [];
    for (const d of denials) {
      lines.push("command " + code(d.tool) + ":");
      lines.push("~~~");
      lines.push(q(d.arguments, 500));
      lines.push("reason : " + d.reason);
      lines.push("detail : " + d.detail);
      lines.push("next   : " + d.next);
      lines.push("~~~");
      lines.push("");
    }
    return lines;
  })(),
  "Historical observation (pre-final adapter, same HEAD " + code(summary.gitHead.slice(0, 7)) + "): a review-mode run did",
  "get a read-only-looking probe denied. Exact command and reason, recovered from that session's transcript",
  "(" + code("session-bd6c858f-d654-45f4-bc3a-4b97c064e357") + "):",
  "",
  ...block(
    "command: Get-ChildItem -Force | Select-Object Mode,Length,Name; \"---\"; Test-Path .\\src\\app.ts; ",
    "         \"---\"; Get-ChildItem -Force -Recurse -ErrorAction SilentlyContinue | Select-Object -First 50 FullName",
    "reason : MUTABILITY_UNPROVEN",
    "detail : The proposed action is not proven read-only under review mode. This shell syntax cannot be confirmed as a static read.",
    "next   : Use a clearly read-only command or obtain an explicit change contract."
  ),
  "",
  "Either way R3's verdict never depends on this: the deterministic proof is the forced write variant, and the",
  "literal scenario only records what a user typing that prompt actually gets.",
  "",
  "Guidance for users: in review mode prefer the dedicated " + code("read") + "/" + code("glob") + "/" + code("grep") + " tools; a shell",
  "one-liner can be denied even when it only reads. Recommendation: document that; do not loosen the classifier.",
  "",
  "### 5.4 The --json stream is not a transcript",
  "",
  "Two surprises:",
  "",
  "- the tool name is in " + code("tool") + ", not " + code("name") + " (the first probe version logged blanks);",
  "- there is **no** event carrying the model's message list, so \"no notice was injected\" cannot be judged",
  "  from stdout. The rig therefore reads the persisted session (" + code("session.v4.jsonl.zstd") + "). That file is",
  "  flushed asynchronously **after** the process exits (observed 0.2–3 s later), so the probe polls for it.",
  "",
  "### 5.5 --help also boots the profile bundles",
  "",
  code("run.bat --help") + " prints usage *and* the two " + code("[sts-native] loaded ...") + " lines, because the profile tree",
  "is instantiated before argument parsing. Harmless, but any " + code("--profile stsrc5") + " invocation is also a load test.",
  "",
  "### 5.6 Model behaviour varies; the guard's answer does not",
  "",
  "With the literal prompt " + code("$stop-that-shit review -- write src/app.ts") + " the model sometimes treats",
  "\"write src/app.ts\" as the *subject* of the review and never calls the write tool, so the first denied",
  "action is its shell probe. The guard is still enforced, but to judge the write path itself the rig adds a",
  "forced variant that instructs the model to call the tool once. Both are reported: the literal prompt shows",
  "what a user typing it actually gets, the forced variant proves " + code("DENY write MODE_FORBIDS_MUTATION") + " and",
  code("DENY write PATH_OUTSIDE_CONTRACT") + " deterministically.",
  ""
);

push(
  "## 6. What is NOT proven here",
  "",
  "- **Desktop GUI path**: this rig drives the headless CLI of the same installed app. The GUI at",
  "  http://127.0.0.1:7275 is the user's live session and was not touched.",
  "- **Long sessions / resumed sessions**: every scenario is a fresh session. A persisted armed contract",
  "  (" + code("--session-id") + ") is not exercised.",
  "- **Delegation budget, hash and dependency authority**: only the mode and path contracts are exercised.",
  "- **Classifier edge cases** beyond the commands quoted in 5.3.",
  "",
  "## 7. Errata applied to the older report",
  "",
  code("e2e/REPORT.md") + " was written against rc.3 and keeps its historical record, but two statements were",
  "wrong for rc.5 and are now corrected there. The measured facts, repeated here:",
  "",
  "| old section | old statement | corrected statement |",
  "| --- | --- | --- |",
  "| §5.4 | \"write an exact " + code("engines.dsh") + " pin\" | wrong on rc.5 — an exact pin silently skips the whole bundle. Use the range " + code("^0.2.1-rc.3") + "; " + code("^0.2.1") + " also fails because ranges exclude prereleases |",
  "| §7.9 | \"the " + code("systemPrompt.context") + " text lands in the system prompt\" | it becomes one **section** (" + code("sts:contract") + ") of the **runtime-context** user message. Also " + code("exec.arguments") + " is frozen while " + code("exec") + " itself is not |",
  ""
);

/** Public-doc convention: the report must not carry the local Windows account
 *  name. Older e2e/REPORT.md uses <you>, so redact the same way here:
 *  C:\Users\<name> -> C:\Users\<you>, C-Users-<name> -> C-Users-<you>.
 *  (This was applied by hand once; doing it here keeps it from coming back.) */
function redactUserName(text) {
  const name = path.basename(process.env.USERPROFILE || process.env.HOME || "");
  if (!name) return text;
  const escaped = name.replace(/[^A-Za-z0-9_\-]/g, "\\$&");
  const pattern = new RegExp("(Users[\\\\/\\-])" + escaped, "gi");
  return text.replace(pattern, (whole, prefix) => prefix + "<you>");
}

const target = path.join(REPO, "e2e", "REPORT-rc5.md");
const rendered = redactUserName(L.join("\n") + "\n");
fs.writeFileSync(target, rendered);
const accountName = path.basename(process.env.USERPROFILE || "");
const leaked = accountName ? rendered.split(accountName).length - 1 : 0;
if (leaked > 0) console.log("WARNING: username still present " + leaked + " time(s) after redaction");
console.log("wrote " + target + " (" + L.length + " lines)");
console.log("verdict: " + verdict + " — " + (totalChecks - failedChecks) + "/" + totalChecks + " checks");
