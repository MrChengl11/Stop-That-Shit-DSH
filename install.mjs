#!/usr/bin/env node
/**
 * Install dsh-stop-that-shit into a DSH profile.
 *
 *   node install.mjs                    # default profile "desktop"
 *   node install.mjs --profile tui      # any other profile
 *   node install.mjs --uninstall
 *
 * What it does, idempotently:
 *   1. copies this package to %USERPROFILE%\.dsh\plugins\dsh-stop-that-shit
 *      (an ASCII, space-free home: the bundle is loaded from there by name),
 *   2. creates the profile's node_modules\dsh-stop-that-shit junction,
 *   3. adds the dependency (link:) and appends the bundle to dsh.profile.bundles.
 *
 * A running dsh with profile HMR picks the change up live; otherwise restart.
 * The junction is removed with unlinkSync — never rmSync, which on Windows
 * follows the junction and deletes the real package.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
const NAME = manifest.name;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const profile = arg("--profile", "desktop");
const uninstall = process.argv.includes("--uninstall");
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profileDir = path.join(home, "profiles", profile);
const dest = path.join(home, "plugins", NAME);
const link = path.join(profileDir, "node_modules", NAME);
const manifestPath = path.join(profileDir, "package.json");

if (!fs.existsSync(manifestPath)) {
  console.error("no such profile: " + profileDir);
  process.exit(1);
}

const profileManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const relative = path.relative(profileDir, dest).split(path.sep).join("/");

function saveProfile(next) {
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
}

if (uninstall) {
  try { fs.unlinkSync(link); console.log("unlinked " + link); } catch { console.log("no junction to remove"); }
  profileManifest.dependencies && delete profileManifest.dependencies[NAME];
  const bundles = profileManifest.dsh?.profile?.bundles ?? [];
  const kept = bundles.filter((b) => b !== NAME);
  if (profileManifest.dsh?.profile) profileManifest.dsh.profile.bundles = kept;
  saveProfile(profileManifest);
  console.log("removed from " + manifestPath + " (files left in " + dest + ")");
  process.exit(0);
}

// 1. copy to the stable home (skip when already running from there)
if (path.resolve(PACKAGE) !== path.resolve(dest)) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(PACKAGE, dest, { recursive: true, force: true });
}
console.log("package home: " + dest);

// 2. junction (unlink first — unlinkSync never touches the target)
fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
try { fs.unlinkSync(link); } catch {}
fs.symlinkSync(dest, link, "junction");
console.log("junction: " + link + " -> " + dest);
console.log("resolves to: " + fs.realpathSync(link));

// 3. profile manifest
profileManifest.dependencies = { ...profileManifest.dependencies, [NAME]: "link:" + relative };
if (!profileManifest.dsh) profileManifest.dsh = {};
if (!profileManifest.dsh.profile) profileManifest.dsh.profile = {};
const bundles = profileManifest.dsh.profile.bundles ?? [];
if (!bundles.includes(NAME)) bundles.push(NAME);
profileManifest.dsh.profile.bundles = bundles;
saveProfile(profileManifest);
console.log("profile " + profile + ": dependency link:" + relative + ", bundle registered");

console.log("\ndone. A running dsh reloads this profile live when HMR is on; otherwise restart it.");
console.log("verify: the next turn carries a \"Stop That Shit is in watch-only mode\" context line.");
