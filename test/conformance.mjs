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
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  CONTROL_TOOLS, DELEGATE_TOOLS, READ_TOOLS, SHELL_TOOLS, WRITE_TOOLS, toolCategory
} from "../lib/adapter.js";
import {
  DESKTOP_TOOLS, DYNAMIC_TOOL_PREFIXES, HEADLESS_TOOLS, RC5_RUNTIME
} from "./rc5-tool-inventory.mjs";

// The delegation ledger is vendored CommonJS; read it directly so the suite can
// assert what the seams did to real state instead of trusting an echo.
const vendor = createRequire(import.meta.url);
const { readState, updateSession } = vendor("../vendor-sts/src/state.cjs");
const { applyDelegationFact, inspectDelegation } = vendor("../vendor-sts/src/delegation-state.cjs");

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
function mountPlugin(config, options = {}) {
  const handlers = new Map();
  const contexts = [];
  const ctx = {
    on(event, fn) { handlers.set(event, fn); },
    systemPrompt: { context(spec) { contexts.push(spec); } },
    // A real profile exposes the live working-directory projection here; tests
    // that need it pass `workingDirectory`, every other test sees undefined and
    // the guard falls back to the session header.
    reflect: { get(name) { return name === "workingDirectory" ? options.workingDirectory : undefined; } }
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

/** The ledger's reserved delegation upper bound, read from the session state. */
function reservedDelegations(dataDir) {
  return inspectDelegation(readState("session-conformance", dataDir).delegation).reservedUpperBound;
}

/**
 * Drive one tool call through BOTH tool seams and sample the delegation ledger
 * around them: before pre-execute, between the seams, and after post-execute.
 */
async function roundTrip(hook, name, args, dataDir, callId) {
  const id = callId || "call-" + name + "-" + Math.random().toString(16).slice(2);
  const exec = { name, callId: id, arguments: args, agent, deferContext: () => {} };
  const before = reservedDelegations(dataDir);
  const gate = await hook.handlers.get("tools/pre-execute")(exec, async () => ({ kind: "allow" }));
  const during = reservedDelegations(dataDir);
  await hook.handlers.get("tools/post-execute")({ ...exec }, { isError: false, content: [] }, async () => ({ kind: "accept" }));
  const after = reservedDelegations(dataDir);
  return { gate, before, during, after, callId: id };
}

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
console.log("DeepSeek Harness 0.2.1-rc.5 tool inventory");
{
  check("the inventory targets the runtime this suite was written for", () => assert.equal(RC5_RUNTIME, "0.2.1-rc.5"));
  check("every desktop-profile tool is classified as the inventory records", () => {
    for (const [name, expected] of Object.entries(DESKTOP_TOOLS)) {
      assert.equal(toolCategory(name), expected, name + " classified " + toolCategory(name) + ", inventory says " + expected);
    }
  });
  check("every headless-profile tool is classified as the inventory records", () => {
    for (const [name, expected] of Object.entries(HEADLESS_TOOLS)) {
      assert.equal(toolCategory(name), expected, name + " classified " + toolCategory(name) + ", inventory says " + expected);
    }
  });
  check("no inventory tool is left unknown (that would fail closed on a live call)", () => {
    const unknown = [...Object.keys(DESKTOP_TOOLS), ...Object.keys(HEADLESS_TOOLS)].filter((name) => toolCategory(name) === "unknown");
    assert.deepEqual(unknown, []);
  });
  check("the headless surface is a subset of the desktop surface", () => {
    const missing = Object.keys(HEADLESS_TOOLS).filter((name) => !Object.hasOwn(DESKTOP_TOOLS, name));
    assert.deepEqual(missing, []);
  });
  check("both inventories agree on shared names", () => {
    for (const [name, expected] of Object.entries(HEADLESS_TOOLS)) {
      assert.equal(DESKTOP_TOOLS[name], expected, name + " is " + DESKTOP_TOOLS[name] + " on desktop but " + expected + " on headless");
    }
  });
  check("the inventory records the recorded surface sizes", () => {
    assert.equal(Object.keys(DESKTOP_TOOLS).length, 117);
    assert.equal(Object.keys(HEADLESS_TOOLS).length, 25);
  });
  check("every dynamic tool family stays unclassified (fail closed)", () => {
    assert.deepEqual(DYNAMIC_TOOL_PREFIXES, ["mcp__"]);
    for (const prefix of DYNAMIC_TOOL_PREFIXES) {
      assert.equal(toolCategory(prefix + "rea__open_binary"), "unknown");
      assert.equal(toolCategory(prefix + "some_server__write_file"), "unknown");
    }
  });
  check("a tool the adapter has never seen stays unclassified", () => {
    assert.equal(toolCategory("brand_new_host_tool"), "unknown");
    assert.equal(toolCategory(""), "unknown");
    assert.equal(toolCategory(undefined), "unknown");
  });
  check("a name is never classified in two conflicting ways", () => {
    const buckets = [["read", READ_TOOLS], ["control", CONTROL_TOOLS], ["delegate", DELEGATE_TOOLS]];
    const seen = new Map();
    for (const [category, set] of buckets) {
      for (const name of set) {
        assert.equal(seen.has(name), false, name + " is in both " + seen.get(name) + " and " + category);
        seen.set(name, category);
      }
    }
    // Write tools may also be shell tools: the shell branch decides their
    // mutability per command, so that overlap is deliberate.
    for (const name of WRITE_TOOLS) {
      const category = seen.get(name);
      assert.ok(category === undefined || category === "shell", name + " is a write tool and also " + category);
    }
  });
  check("the rc.5-only tools that used to fall through are classified", () => {
    const expected = {
      exit_plan_mode: "control", gain_qq_tools: "control", unlag_refresh: "control",
      list_subagent_models: "read", plugin_manager: "control", plugin_market: "control",
      cordis_inspect_list: "read", cordis_inspect_query: "read",
      ops_load_sdk: "control", ops_result: "control", workflow: "delegate",
      load_workspace_dependencies: "read", run_code: "control"
    };
    for (const [name, category] of Object.entries(expected)) assert.equal(toolCategory(name), category, name);
  });
  check("the shell tools stay command-analysed", () => {
    assert.deepEqual([...SHELL_TOOLS].sort(), ["bash", "ops_bash", "ops_pwsh", "pwsh"]);
  });
}

/* ---------- tiny semver: the subset engines.dsh needs ---------- */
/**
 * Parse a SemVer 2.0.0 version into its comparable parts.
 * @param text candidate version.
 * @returns the parsed version, or null.
 */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text || "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split(".") : [] };
}

/** SemVer precedence for one prerelease identifier pair. */
function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence: <0, 0, >0. A release sorts after its prereleases. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error("invalid version comparison " + JSON.stringify([a, b]));
  for (const key of ["major", "minor", "patch"]) {
    const delta = left[key] - right[key];
    if (delta !== 0) return Math.sign(delta);
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const delta = compareIdentifier(left.pre[index], right.pre[index]);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * node-semver's satisfies() for an exact version or a caret range.
 *
 * This mirrors what @deepseek-ai/dsh-app-boot does when it gates a profile
 * bundle: semver.satisfies(runtimeVersion, range, { includePrerelease: true }).
 * Anything else throws, so a future manifest edit cannot silently pass a range
 * this suite never checked.
 * @param version the dsh runtime version.
 * @param range the declared engines.dsh range.
 * @param options includePrerelease, as the host passes it.
 * @returns whether the runtime version satisfies the range.
 */
function satisfiesRange(version, range, options = {}) {
  const includePrerelease = options.includePrerelease === true;
  const text = String(range || "").trim();
  const parsed = parseVersion(version);
  if (!parsed) throw new Error("invalid version " + JSON.stringify(version));
  if (text.startsWith("^")) {
    const lower = parseVersion(text.slice(1));
    if (!lower) throw new Error("invalid range " + JSON.stringify(range));
    const upper = lower.major > 0
      ? { major: lower.major + 1, minor: 0, patch: 0 }
      : lower.minor > 0
        ? { major: 0, minor: lower.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: lower.patch + 1 };
    const upperText = upper.major + "." + upper.minor + "." + upper.patch + "-0";
    if (compareVersions(version, text.slice(1)) < 0) return false;
    if (compareVersions(version, upperText) >= 0) return false;
    if (parsed.pre.length === 0 || includePrerelease) return true;
    // Without includePrerelease a prerelease only matches a comparator set that
    // names a prerelease of the same [major, minor, patch] tuple.
    return lower.pre.length > 0
      && lower.major === parsed.major && lower.minor === parsed.minor && lower.patch === parsed.patch;
  }
  if (parseVersion(text)) return compareVersions(version, text) === 0;
  throw new Error("unsupported engines range " + JSON.stringify(range));
}

console.log("");
console.log("plugin manifest (package.json)");
{
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, "package.json"), "utf8"));
  check("version is the release this work produces", () => assert.equal(manifest.version, "0.2.1"));
  check("engines.dsh is a range, not an exact pin", () => assert.equal(manifest.engines.dsh, "^0.2.1-rc.3"));
  check("engines.node is unchanged", () => assert.equal(manifest.engines.node, ">=22"));
  check("the declared range accepts the installed 0.2.1-rc.5", () => {
    assert.equal(satisfiesRange("0.2.1-rc.5", manifest.engines.dsh, { includePrerelease: true }), true);
  });
  check("the declared range accepts the 0.2.1 release", () => {
    assert.equal(satisfiesRange("0.2.1", manifest.engines.dsh, { includePrerelease: true }), true);
  });
  check("the declared range accepts a later 0.2.x", () => {
    assert.equal(satisfiesRange("0.2.2", manifest.engines.dsh, { includePrerelease: true }), true);
    assert.equal(satisfiesRange("0.2.2-rc.1", manifest.engines.dsh, { includePrerelease: true }), true);
  });
  check("the declared range rejects 0.3.0", () => {
    assert.equal(satisfiesRange("0.3.0", manifest.engines.dsh, { includePrerelease: true }), false);
  });
  check("the declared range rejects a 0.3.0 prerelease", () => {
    assert.equal(satisfiesRange("0.3.0-rc.1", manifest.engines.dsh, { includePrerelease: true }), false);
  });
  check("the declared range rejects an older 0.2.0", () => {
    assert.equal(satisfiesRange("0.2.0", manifest.engines.dsh, { includePrerelease: true }), false);
  });
  check("an exact pin like 0.2.1-rc.3 would skip the rc.5 bundle", () => {
    assert.equal(satisfiesRange("0.2.1-rc.5", "0.2.1-rc.3", { includePrerelease: true }), false);
  });
  check("a caret range without the prerelease would exclude every rc", () => {
    assert.equal(satisfiesRange("0.2.1-rc.5", "^0.2.1", { includePrerelease: true }), false);
  });
  check("the bundle patch inserts the plugin entry the dump reports", () => {
    const patch = fs.readFileSync(path.join(PLUGIN, "cordis.patch.yml"), "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: sts-native/);
    assert.match(patch, /name: dsh-stop-that-shit/);
  });
}

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
console.log("rc.5 seams and tool surface regressions");
{
  check("the prompt context opts out of {{variable}} interpolation", () => {
    const spec = hook.contexts.find((c) => c.name === "sts:contract");
    assert.equal(spec.interpolate, false, "rc.5 throws on an unknown prompt variable, which would abort assembly");
  });
  check("the prompt context survives runtime-context suppression", () => {
    // A preset may call systemPrompt.suppressRuntimeContext(); rc.5 then keeps
    // only required contexts, and the contract text would silently vanish.
    const spec = hook.contexts.find((c) => c.name === "sts:contract");
    assert.equal(spec.required, true);
  });
}
{
  // rc.5: session.header.cwd is the creation-time snapshot; a later cd appends a
  // working-directory/change projection, so the live service must win.
  const moved = await mountPlugin(
    { dataDir: path.join(DATA_DIR, "cwd-live"), announceWhenUnarmed: true, announceOnPrompt: true },
    { workingDirectory: { get: () => "D:\\elsewhere" } }
  );
  await prompt(moved, "$stop-that-shit change files=src/app.ts -- refactor");
  // An absolute path under the stale header root is inside the old boundary and
  // outside the live one, so it discriminates which root the guard used.
  const { gate } = await call(moved, "write", { file_path: "C:\\ws\\src\\app.ts", content: "x" });
  check("the live working-directory projection wins over the stale header", () => assert.equal(gate.kind, "deny"));
  check("the reason is PATH_OUTSIDE_CONTRACT", () => assert.equal(reasonOf(gate), "PATH_OUTSIDE_CONTRACT"));
  const relative = await call(moved, "write", { file_path: "src/app.ts", content: "x" });
  check("a relative path is judged against the live projection", () => assert.equal(relative.gate.kind, "allow"));
}
{
  const broken = await mountPlugin(
    { dataDir: path.join(DATA_DIR, "cwd-broken"), announceWhenUnarmed: true, announceOnPrompt: true },
    { workingDirectory: { get() { throw new Error("no projection service"); } } }
  );
  await prompt(broken, "$stop-that-shit change files=src/app.ts -- refactor");
  const { gate } = await call(broken, "write", { file_path: "src/app.ts", content: "x" });
  check("a failing projection service falls back to the header instead of denying", () => assert.equal(gate.kind, "allow"));
}
{
  // dsh-ops names the file in `path`, and its edit shape is an `edits` array.
  await prompt(strict, "$stop-that-shit change files=package.json deps=deny -- edit the manifest");
  const { gate } = await call(strict, "ops_edit_file", {
    path: "package.json",
    expectedRevision: "0".repeat(64),
    edits: [{ oldText: '"name": "x"', newText: '"name": "x",\n  "dependencies": { "left-pad": "1.0.0" }' }]
  });
  check("ops_edit_file adding a dependency under deps=deny -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is DEPENDENCY_NOT_AUTHORIZED", () => assert.equal(reasonOf(gate), "DEPENDENCY_NOT_AUTHORIZED"));
}
{
  await prompt(strict, "$stop-that-shit change files=src/** -- touch a file");
  const inside = await call(strict, "ops_write_file", { path: "src/inside.ts", content: "export const x = 1;\n" });
  check("ops_write_file inside the boundary -> allow", () => assert.equal(inside.gate.kind, "allow"));
  const outside = await call(strict, "ops_write_file", { path: "other/outside.ts", content: "x" });
  check("ops_write_file outside the boundary -> deny", () => assert.equal(outside.gate.kind, "deny"));
  check("reason is PATH_OUTSIDE_CONTRACT", () => assert.equal(reasonOf(outside.gate), "PATH_OUTSIDE_CONTRACT"));
}
{
  await prompt(strict, "$stop-that-shit change files=src/** -- move a file");
  const { gate } = await call(strict, "ops_move", { path: "src/inside.ts", to: "D:/elsewhere/x.ts" });
  check("ops_move whose destination leaves the boundary -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is PATH_OUTSIDE_CONTRACT", () => assert.equal(reasonOf(gate), "PATH_OUTSIDE_CONTRACT"));
}
{
  await prompt(strict, "$stop-that-shit change files=src/** -- replace across files");
  const { gate } = await call(strict, "ops_replace", { path: "src", pattern: "a", replacement: "b" });
  check("ops_replace proves no single path -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is WRITE_PATH_UNPROVEN", () => assert.equal(reasonOf(gate), "WRITE_PATH_UNPROVEN"));
}
{
  await prompt(strict, "$stop-that-shit review files=src -- audit");
  const plan = await call(strict, "exit_plan_mode", { plan: "# plan" });
  check("exit_plan_mode is bookkeeping, allowed under review", () => assert.equal(plan.gate.kind, "allow"));
  const mcp = await call(strict, "mcp__rea__open_binary", { path: "target.exe" });
  check("an MCP tool stays unproven under review -> deny", () => assert.equal(mcp.gate.kind, "deny"));
  check("reason is MUTABILITY_UNPROVEN", () => assert.equal(reasonOf(mcp.gate), "MUTABILITY_UNPROVEN"));
}
{
  // A reservation is only released by tools/post-execute, and this suite drives
  // pre-execute alone, so the delegation budget needs a session of its own.
  const budget = await mountPlugin({ dataDir: path.join(DATA_DIR, "workflow"), announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(budget, "$stop-that-shit change files=src/** agents=1 -- orchestrate");
  const workflow = await call(budget, "workflow", { script: "return 1" });
  check("workflow spends delegation capacity and is allowed while budget remains", () => assert.equal(workflow.gate.kind, "allow"));
  const again = await call(budget, "workflow", { script: "return 1" });
  check("the workflow reservation is held like a subagent's", () => assert.equal(again.gate.kind, "deny"));
  check("reason is AGENT_BUDGET_EXHAUSTED", () => assert.equal(reasonOf(again.gate), "AGENT_BUDGET_EXHAUSTED"));
}
{
  const noBudget = await mountPlugin({ dataDir: path.join(DATA_DIR, "workflow-zero"), announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(noBudget, "$stop-that-shit change files=src/** agents=0 -- do it yourself");
  const { gate } = await call(noBudget, "workflow", { script: "return 1" });
  check("workflow with agents=0 -> deny", () => assert.equal(gate.kind, "deny"));
  check("reason is AGENT_BUDGET_EXHAUSTED", () => assert.equal(reasonOf(gate), "AGENT_BUDGET_EXHAUSTED"));
}

console.log("");
console.log("delegation ledger: every delegate tool owes an after-fact");
{
  // One slot only: the second delegate call can only be accepted if the first
  // one's reservation was released. That is the regression this guards.
  const dir = path.join(DATA_DIR, "ledger-foreground");
  const ledger = await mountPlugin({ dataDir: dir, announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(ledger, "$stop-that-shit change files=src/** agents=1 -- delegate once");
  const sub = await roundTrip(ledger, "subagent", { prompt: "help" }, dir);
  check("a foreground subagent reserves one slot", () => assert.equal(sub.during, sub.before + 1));
  check("a foreground subagent is allowed", () => assert.equal(sub.gate.kind, "allow"));
  check("post-execute releases the subagent reservation", () => assert.equal(sub.after, sub.before));
  const workflow = await roundTrip(ledger, "workflow", { script: "return 1" }, dir);
  check("a foreground workflow is accepted after that release", () => assert.equal(workflow.gate.kind, "allow"));
  check("a foreground workflow reserves one slot", () => assert.equal(workflow.during, workflow.before + 1));
  check("post-execute releases the workflow reservation too", () => assert.equal(workflow.after, workflow.before));
  const team = await roundTrip(ledger, "spawn_teammate", { name: "t", prompt: "help" }, dir);
  check("spawn_teammate also releases its reservation", () => assert.equal(team.after, team.before));
}
{
  // run_in_background returns while the children keep running, so the ledger
  // must keep holding the slot: reporting "joined" here would hand the same
  // capacity to the next delegation.
  const dir = path.join(DATA_DIR, "ledger-background");
  const background = await mountPlugin({ dataDir: dir, announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(background, "$stop-that-shit change files=src/** agents=1 -- background orchestration");
  const round = await roundTrip(background, "workflow", { script: "return 1", run_in_background: true }, dir);
  check("a background workflow is allowed", () => assert.equal(round.gate.kind, "allow"));
  check("a background workflow reserves one slot", () => assert.equal(round.during, round.before + 1));
  check("its slot stays held (running, not joined)", () => assert.equal(round.after, round.during));
  const next = await roundTrip(background, "subagent", { prompt: "help" }, dir);
  check("the held slot still blocks the next delegation", () => assert.equal(next.gate.kind, "deny"));
  check("reason is AGENT_BUDGET_EXHAUSTED", () => assert.equal(reasonOf(next.gate), "AGENT_BUDGET_EXHAUSTED"));
}
{
  // A denied delegate call never reserved capacity, so its after-fact is a
  // no-op: the ledger must be unchanged, including for a background workflow
  // whose marker was taken at pre-execute.
  const dir = path.join(DATA_DIR, "ledger-denied");
  const denied = await mountPlugin({ dataDir: dir, announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(denied, "$stop-that-shit change files=src/** agents=0 -- do it yourself");
  const round = await roundTrip(denied, "workflow", { script: "return 1", run_in_background: true }, dir);
  check("a denied background workflow is refused", () => assert.equal(round.gate.kind, "deny"));
  check("a denied delegation reserves nothing", () => assert.equal(round.during, round.before));
  check("and its after-fact leaves the ledger untouched", () => assert.equal(round.after, round.before));
}
{
  // Prove no after-fact is emitted for a non-delegate tool: forge a reservation
  // for the call id it will use. A dispatched "joined" would release it.
  const dir = path.join(DATA_DIR, "ledger-nondelegate");
  const plain = await mountPlugin({ dataDir: dir, announceWhenUnarmed: true, announceOnPrompt: true });
  await prompt(plain, "$stop-that-shit change files=src/** -- write a file");
  const callId = "call-forged-nondelegate";
  updateSession("session-conformance", dir, (state) => ({
    ...state,
    delegation: applyDelegationFact(state.delegation, { kind: "accepted", id: callId, count: 1, completionScope: "call" })
  }));
  const round = await roundTrip(plain, "write", { file_path: "src/app.ts", content: "export const app = 1;\n" }, dir, callId);
  check("the write itself is allowed", () => assert.equal(round.gate.kind, "allow"));
  check("a non-delegate tool reserves nothing", () => assert.equal(round.during, round.before));
  check("and no after-fact is emitted for it (the forged slot survives)", () => assert.equal(round.after, round.before));
}

console.log("");
const total = passed + failures.length;
if (failures.length > 0) {
  console.log("RESULT: " + failures.length + "/" + total + " check(s) FAILED");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("RESULT: " + passed + "/" + total + " checks passed.");
