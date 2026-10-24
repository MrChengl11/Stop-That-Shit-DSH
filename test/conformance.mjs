#!/usr/bin/env node
/**
 * conformance.mjs — deterministic conformance suite for dsh-stop-that-shit.
 *
 * The headless E2E probe (e2e-native/probe-native.mjs) proves the plugin is wired
 * into a real DSH boot, but its assertions depend on which tool the model decides
 * to call. This suite removes the model from the loop: it drives the exact handlers
 * the plugin registers on a fake cordis ctx and asserts the decision matrix.
 *
 * Run: node test/conformance.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const DATA_DIR = path.join(os.tmpdir(), "sts-conformance-" + process.pid);
fs.rmSync(DATA_DIR, { recursive: true, force: true });

let passed = 0;
const failures = [];
function check(label, fn) {
  try { fn(); passed++; console.log("  PASS  " + label); }
  catch (error) { failures.push(label + " — " + error.message); console.log("  FAIL  " + label + " — " + error.message); }
}

/* ---------- fake cordis ctx ---------- */
function mountPlugin(config) {
  const handlers = new Map();
  const contexts = [];
  const ctx = {
    on(event, fn) { handlers.set(event, fn); },
    systemPrompt: { context(spec) { contexts.push(spec); } },
    reflect: { get() { return undefined; } }
  };
  return import(pathToFileURL(path.join(PLUGIN, "lib", "index.js")).href + "?t=" + Date.now())
    .then((mod) => { mod.apply(ctx, config); return { mod, handlers, contexts }; });
}

const CWD = "C:\\ws";
const agent = { session: { id: "session-conformance", header: { cwd: CWD } } };
const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], source: { kind: "user" } });

/** Fire a prompt through agent/inbox/claimed, then collect what pre-step injects. */
async function prompt(hook, text) {
  hook.handlers.get("agent/inbox/claimed")({ agent, message: userMessage(text) });
  const decision = await hook.handlers.get("agent/pre-step")(
    { agent, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [] })
  );
  const injected = decision.messages.map((m) => m.content[0].text);
  return { decision, injected };
}

/** Fire a tool call through tools/pre-execute. */
async function call(hook, name, args) {
  const deferred = [];
  const gate = await hook.handlers.get("tools/pre-execute")(
    { name, callId: "call-" + name + "-" + Math.random().toString(16).slice(2), arguments: args, agent, deferContext: (m) => deferred.push(m) },
    async () => ({ kind: "allow" })
  );
  return { gate, deferred };
}

const reasonOf = (gate) => (gate.kind === "deny" ? String(gate.reason).match(/Reason: (\S+)/)?.[1] : undefined);

/* ---------- suite ---------- */
const hook = await mountPlugin({ dataDir: DATA_DIR, announceWhenUnarmed: true, announceOnPrompt: true });

console.log("");
console.log("dsh-stop-that-shit conformance suite");
console.log("  plugin: " + PLUGIN);
console.log("  dataDir: " + DATA_DIR);
console.log("");
console.log("plugin shape");
check("exports name sts-native", () => assert.equal(hook.mod.name, "sts-native"));
check("declares only the systemPrompt service", () => assert.deepEqual(hook.mod.inject, ["systemPrompt"]));
check("registers agent/inbox/claimed", () => assert.ok(hook.handlers.has("agent/inbox/claimed")));
check("registers agent/pre-step", () => assert.ok(hook.handlers.has("agent/pre-step")));
check("registers tools/pre-execute", () => assert.ok(hook.handlers.has("tools/pre-execute")));
check("registers tools/post-execute", () => assert.ok(hook.handlers.has("tools/post-execute")));
check("publishes a sts:contract prompt context at order 550", () => {
  const spec = hook.contexts.find((c) => c.name === "sts:contract");
  assert.ok(spec, "no sts:contract context registered");
  assert.equal(spec.order, 550);
  assert.equal(typeof spec.text, "function");
});
check("prompt context is empty while unarmed", () => {
  const spec = hook.contexts.find((c) => c.name === "sts:contract");
  assert.equal(spec.text({ agent }), "");
});

console.log("");
console.log("directive parsing (agent/inbox/claimed -> prompt.submit)");
{
  const { injected } = await prompt(hook, "$stop-that-shit change files=src/app.ts -- refactor the handler");
  check("first-line directive arms the session", () => assert.ok(injected.length === 1, "no notice injected"));
  check("notice states the contract", () => assert.match(injected[0], /mode=change/));
  check("notice states the file boundary", () => assert.match(injected[0], /files=src\/app\.ts/));
  check("notice carries the stop ladder", () => assert.match(injected[0], /Stop Ladder/));
  check("prompt context now reports the live contract", () => {
    const text = hook.contexts.find((c) => c.name === "sts:contract").text({ agent });
    assert.match(text, /Stop That Shit \(active\)/);
  });
}

console.log("");
console.log("mutation inside the boundary is allowed");
{
  const { gate } = await call(hook, "write", { file_path: "src/app.ts", content: "export const app = 1;\n" });
  check("write src/app.ts -> allow", () => assert.equal(gate.kind, "allow"));
}
{
  const { gate } = await call(hook, "edit", { file_path: "src/app.ts", old_string: "1", new_string: "2" });
  check("edit src/app.ts -> allow", () => assert.equal(gate.kind, "allow"));
}
{
  const { gate } = await call(hook, "read", { file_path: "src/app.ts" });
  check("read src/app.ts -> allow", () => assert.equal(gate.kind, "allow"));
}
{
  const { gate } = await call(hook, "pwsh", { command: "Get-ChildItem src", description: "list" });
  check("read-only pwsh -> allow", () => assert.equal(gate.kind, "allow"));
}

console.log("");
console.log("mutation outside the boundary is denied");
{
  const { gate } = await call(hook, "write", { file_path: "src/outside.ts", content: "x" });
  check("write src/outside.ts -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is PATH_OUTSIDE_CONTRACT", () => assert.equal(reasonOf(gate), "PATH_OUTSIDE_CONTRACT"));
  check("denial text starts with STOP / SCOPE", () => assert.match(gate.reason, /^STOP \/ SCOPE\n/));
  check("denial names the offending path", () => assert.match(gate.reason, /outside[.\\/]ts/));
  check("denial carries code, state and next step", () => {
    assert.match(gate.reason, /Code: S\/PATH_OUTSIDE_CONTRACT/);
    assert.match(gate.reason, /State: ARMED \/ change/);
    assert.match(gate.reason, /Next: /);
  });
}
{
  const { gate } = await call(hook, "write", { file_path: "D:/elsewhere/x.ts", content: "x" });
  check("absolute path outside cwd -> deny", () => assert.equal(gate.kind, "deny"));
}
{
  // The shell analyser names the target of a mkdir: the boundary can judge the
  // path instead of falling back to WRITE_PATH_UNPROVEN.
  const { gate } = await call(hook, "pwsh", { command: "mkdir -p src/new", description: "mkdir" });
  check("shell write with a proven target outside the boundary -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is PATH_OUTSIDE_CONTRACT", () => assert.equal(reasonOf(gate), "PATH_OUTSIDE_CONTRACT"));
  check("denial names the proven target", () => assert.match(gate.reason, /src.new/));
}
{
  const { gate } = await call(hook, "pwsh", { command: "touch src/app.ts", description: "touch" });
  check("shell write with a proven target inside the boundary -> allow", () => assert.equal(gate.kind, "allow"));
}
{
  const { gate } = await call(hook, "pwsh", { command: "git add -A", description: "stage" });
  check("shell write that names no target -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is WRITE_PATH_UNPROVEN", () => assert.equal(reasonOf(gate), "WRITE_PATH_UNPROVEN"));
}
{
  const { gate } = await call(hook, "pwsh", { command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"', description: "script" });
  check("unclassifiable shell -> deny", () => assert.equal(gate.kind, "deny"));
}

console.log("");
console.log("PTC container and delegation");
{
  const { gate } = await call(hook, "run_code", { code: "await tools.write({file_path:'src/app.ts'})" });
  check("run_code container -> allow (nested calls are judged individually)", () => assert.equal(gate.kind, "allow"));
}
{
  const { gate } = await call(hook, "subagent", { prompt: "help" });
  check("subagent with unlimited budget -> allow", () => assert.equal(gate.kind, "allow"));
}

console.log("");
console.log("fail-open on malformed input");
{
  const gate = await hook.handlers.get("tools/pre-execute")(
    { name: "write", callId: "broken", arguments: undefined, agent: undefined },
    async () => ({ kind: "allow" })
  );
  check("call without an agent -> next() (allow)", () => assert.equal(gate.kind, "allow"));
}

/* ---- second mount: mode gates and budget ---- */
const strict = await mountPlugin({ dataDir: DATA_DIR, announceWhenUnarmed: true, announceOnPrompt: true });

console.log("");
console.log("review mode forbids mutation");
{
  await prompt(strict, "$stop-that-shit review files=src -- audit the code");
  const { gate } = await call(strict, "write", { file_path: "src/app.ts", content: "x" });
  check("write under review -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is MODE_FORBIDS_MUTATION", () => assert.equal(reasonOf(gate), "MODE_FORBIDS_MUTATION"));
  check("denial text starts with STOP / INTENT", () => assert.match(gate.reason, /^STOP \/ INTENT\n/));
}
{
  const { gate } = await call(strict, "read", { file_path: "src/app.ts" });
  check("read under review -> allow", () => assert.equal(gate.kind, "allow"));
}
{
  const { gate } = await call(strict, "pwsh", { command: 'Get-ChildItem -Force | Select-Object Name; "x"', description: "pipe" });
  check("shell whose mutability is unproven under review -> deny", () => assert.equal(gate.kind, "deny"));
}

console.log("");
console.log("hash and dependency policy");
{
  await prompt(strict, "$stop-that-shit change files=src/hashy.ts -- add a hash helper");
  const { gate } = await call(strict, "write", {
    file_path: "src/hashy.ts",
    content: "import { createHash } from 'node:crypto';\nexport const h = (s) => createHash('sha256').update(s).digest('hex');\n"
  });
  check("write introducing createHash under hash=deny -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is HASH_NOT_AUTHORIZED", () => assert.equal(reasonOf(gate), "HASH_NOT_AUTHORIZED"));
}
{
  await prompt(strict, "$stop-that-shit change files=package.json -- add a dependency");
  const { gate } = await call(strict, "write", {
    file_path: "package.json",
    content: JSON.stringify({ name: "x", dependencies: { "left-pad": "1.0.0" } }, null, 2)
  });
  check("write adding a dependency under deps=ask -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is DEPENDENCY_NOT_AUTHORIZED", () => assert.equal(reasonOf(gate), "DEPENDENCY_NOT_AUTHORIZED"));
}
// Dependency authority is decided before the file boundary: under deps=allow a
// package manager (whose write target the guard cannot know) must not be refused
// for WRITE_PATH_UNPROVEN.
{
  await prompt(strict, "$stop-that-shit change files=src/** deps=allow -- install a package");
  const { gate } = await call(strict, "pwsh", { command: "npm install yaml", description: "install" });
  check("dependency install under deps=allow -> allow", () => assert.equal(gate.kind, "allow"));
}
{
  await prompt(strict, "$stop-that-shit change files=src/** deps=deny -- install a package");
  const { gate } = await call(strict, "pwsh", { command: "npm install yaml", description: "install" });
  check("dependency install under deps=deny -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is DEPENDENCY_NOT_AUTHORIZED", () => assert.equal(reasonOf(gate), "DEPENDENCY_NOT_AUTHORIZED"));
}

console.log("");
console.log("agent budget");
{
  await prompt(strict, "$stop-that-shit change files=src agents=0 -- do it yourself");
  const { gate } = await call(strict, "subagent", { prompt: "help" });
  check("subagent with agents=0 -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is AGENT_BUDGET_EXHAUSTED", () => assert.equal(reasonOf(gate), "AGENT_BUDGET_EXHAUSTED"));
}

console.log("");
console.log("watch level reports instead of denying");
{
  const watch = await mountPlugin({ dataDir: path.join(DATA_DIR, "watch"), announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(watch, "$stop-that-shit change watch files=src/app.ts -- refactor");
  const { gate, deferred } = await call(watch, "write", { file_path: "src/app.ts", content: "export const app = 1;\n" });
  check("watch level allows the action", () => assert.equal(gate.kind, "allow"));
}
{
  const watch2 = await mountPlugin({ dataDir: path.join(DATA_DIR, "watch2"), announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(watch2, "$stop-that-shit change watch files=src/app.ts -- refactor");
  const { gate, deferred } = await call(watch2, "write", { file_path: "src/outside.ts", content: "x" });
  check("watch level allows an out-of-boundary write", () => assert.equal(gate.kind, "allow"));
  check("watch level reports it through deferContext", () => {
    assert.ok(deferred.length >= 1, "the guard returned no context for a report_and_defer decision");
    assert.match(deferred[0].content[0].text, /^WATCH \//);
  });
}

console.log("");
console.log("runtime commands");
{
  const status = await mountPlugin({ dataDir: path.join(DATA_DIR, "status"), announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(status, "$stop-that-shit change files=src/app.ts -- refactor");
  const { injected } = await prompt(status, "$stop-that-shit status");
  check("status command returns a notice", () => assert.equal(injected.length, 1));
  check("status notice reports the live state", () => assert.match(injected[0], /State: ARMED \/ change/));
  check("status notice admits the host effect is unobserved", () => assert.match(injected[0], /Host effect: unobserved/));
}

console.log("");
console.log("a directive that is not on the first line");
{
  const late = await mountPlugin({ dataDir: path.join(DATA_DIR, "late"), announceWhenUnarmed: true, announceOnPrompt: true });
  const { injected } = await prompt(late, "Refactor the handler.\n$stop-that-shit review -- audit");
  check("a late directive does not arm the session", () => assert.equal(injected.length, 0));
  const { gate } = await call(late, "write", { file_path: "src/app.ts", content: "x" });
  check("an unarmed session allows the write", () => assert.equal(gate.kind, "allow"));
}

console.log("");
console.log("a plain prompt never injects a notice");
{
  const fresh = await mountPlugin({ dataDir: path.join(DATA_DIR, "plain"), announceWhenUnarmed: true, announceOnPrompt: true });
  const { injected } = await prompt(fresh, "Refactor src/app.ts and run the tests.");
  check("ordinary task -> no injected notice", () => assert.equal(injected.length, 0));
}

console.log("");
const total = passed + failures.length;
if (failures.length > 0) {
  console.log("RESULT: " + failures.length + "/" + total + " check(s) FAILED");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("RESULT: " + passed + "/" + total + " checks passed.");
