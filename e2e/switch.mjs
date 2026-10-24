#!/usr/bin/env node
/**
 * switch.mjs — point the stsnative profile's plugin junction at a bundle package
 * and prove the bundle layer actually composes.
 *
 * Usage:
 *   node switch.mjs                 # switch to the real sts-plugin
 *   node switch.mjs --stub          # switch back to the local stub
 *   node switch.mjs --to <dir>      # switch to an arbitrary package dir
 *   node switch.mjs --check         # verify only, no mutation
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROFILE = path.join(process.env.USERPROFILE || "", ".dsh", "profiles", "stsnative");
const LINK = path.join(PROFILE, "node_modules", "dsh-stop-that-shit");
const PLUGIN = "D:\\harness-deepseek workspace\\dsh插件安装\\sts-plugin";
const STUB = path.join("D:\\harness-deepseek workspace\\dsh插件安装\\e2e-native", "stub-bundle");
const LAUNCHER = path.join(process.env.TEMP || process.env.TMP || path.join(process.env.USERPROFILE || "", "AppData", "Local", "Temp"), "sts-native", "run.bat");
const BUNDLE_NAME = "dsh-stop-that-shit";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };

// Resolve relative --to against the shell cwd. A Windows junction needs an
// absolute target; a relative one is resolved against the LINK's own directory.
const target = path.resolve(flag("--stub") ? STUB : (opt("--to") ?? PLUGIN));

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

/** Read and validate the package that will become the bundle. */
function inspectPackage(dir) {
  const manifestPath = path.join(dir, "package.json");
  if (!fs.existsSync(manifestPath)) fail("no package.json at " + manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== BUNDLE_NAME) {
    console.warn('WARN: package name is ' + JSON.stringify(manifest.name) + ", expected " + JSON.stringify(BUNDLE_NAME));
  }
  const bundle = manifest.dsh && manifest.dsh.bundle;
  if (bundle === undefined) {
    fail("package declares no dsh.bundle — boot would throw 'declares no dsh.bundle in its package.json'");
  }
  const patches = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
  for (const rel of patches) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) fail("dsh.bundle.patch file is missing: " + abs);
    const text = fs.readFileSync(abs, "utf8");
    const significant = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (!significant.length || !significant[0].startsWith("- ")) {
      fail("bundle patch " + abs + " is not a top-level YAML array");
    }
  }
  // The compatibility gate: engines.dsh wins; otherwise every @deepseek-ai/dsh* peer must match the runtime.
  const issues = [];
  if (manifest.engines && manifest.engines.dsh !== undefined) {
    if (manifest.engines.dsh !== "0.2.1-rc.3") issues.push("engines.dsh = " + JSON.stringify(manifest.engines.dsh));
  } else if (manifest.peerDependencies) {
    for (const [dep, range] of Object.entries(manifest.peerDependencies)) {
      if (dep !== "@deepseek-ai/dsh" && !dep.startsWith("@deepseek-ai/dsh-")) continue;
      const literal = String(range);
      if (/^workspace:/.test(literal)) continue;
      // Only flag the obvious rc.2-style mismatch; semver is not available here.
      if (!literal.includes("0.2.1-rc.3") && !literal.startsWith("^0.2.1") && !literal.startsWith("~0.2.1")) {
        issues.push(dep + " = " + literal + " (runtime is 0.2.1-rc.3)");
      }
    }
  }
  return { manifest, patches, issues };
}

const what = flag("--check") ? "checking" : "switching to";
console.log(what + ": " + target);
if (!fs.existsSync(target)) fail("target directory does not exist: " + target);
const info = inspectPackage(target);
console.log("  package: " + info.manifest.name + "@" + info.manifest.version);
console.log("  bundle patch: " + info.patches.join(", "));
if (info.issues.length > 0) {
  console.error("");
  console.error("  ⚠ COMPATIBILITY GATE — the boot will DROP this bundle (or disable its rows):");
  for (const issue of info.issues) console.error("    - " + issue);
  console.error("    Fix: omit peerDependencies/engines, or set \"engines\": { \"dsh\": \"0.2.1-rc.3\" }.");
  console.error("");
}
if (info.issues.length > 0 && !flag("--force")) fail("refusing to switch without --force");

if (!flag("--check")) {
  fs.mkdirSync(path.dirname(LINK), { recursive: true });
  // IMPORTANT: unlinkSync only removes the reparse point. rmSync(..., {recursive:true})
  // follows the junction and DELETES THE TARGET'S CONTENTS on Windows.
  try { fs.unlinkSync(LINK); } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.symlinkSync(target, LINK, "junction");
  console.log("  junction: " + LINK + " -> " + fs.readlinkSync(LINK));
}

// Prove the layer composes into the cordis tree.
const out = execFileSync("cmd", ["/c", LAUNCHER, "--profile", "stsnative", "--dump-config"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 32 * 1024 * 1024
});
const rowPattern = new RegExp("^# == " + BUNDLE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$[\\s\\S]{0,200}?- id: ", "m");
if (!rowPattern.test(out)) {
  fail("bundle row did not compose into the tree — check stderr for 'skipping profile bundle'");
}
const rowMatch = out.match(new RegExp("- id: ([^\\n]+)\\n  name: " + BUNDLE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const rowId = rowMatch ? rowMatch[1] : undefined;
if (rowId === undefined) fail("the bundle row is present but its id/name pair did not parse");
console.log("  composed row: - id: " + (rowId ?? "<see --dump-config>") + " / name: " + BUNDLE_NAME);
console.log("");
console.log("OK — the bundle layer is live. Next: node probe.mjs");
