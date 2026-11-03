#!/usr/bin/env node
/**
 * setup.mjs — build the rc.5 scratch profile and launcher for the E2E rig.
 *
 * Idempotent. It owns exactly three things outside this repo:
 *   ~/.dsh/profiles/stsrc5/{package.json,cordis.yml,cordis.patch.yml}
 *   %TEMP%\sts-rc5\run.bat   (ASCII, space-free launcher)
 *   %TEMP%\sts-rc5\ws        (scenario working directory)
 *
 * It never touches ~/.dsh/profiles/stsnative (the source of the model block)
 * or ~/.dsh/profiles/desktop (the user's live session).
 *
 * Windows junction rule: a junction is removed with fs.unlinkSync. fs.rmSync on
 * a junction deletes the TARGET's contents on this platform, which would nuke
 * the real package. Do not "simplify" that line.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILE = "stsrc5";

const USERPROFILE = process.env.USERPROFILE || "";
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(USERPROFILE, "AppData", "Local");
const TEMP = process.env.TEMP || process.env.TMP || path.join(LOCALAPPDATA, "Temp");

export const EXE = path.join(LOCALAPPDATA, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");
export const CLI = path.join(
  path.dirname(EXE),
  "resources", "app.asar", "dsh", "node_modules",
  "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"
);
export const DSH_HOME = path.join(USERPROFILE, ".dsh");
export const PROFILE_DIR = path.join(DSH_HOME, "profiles", PROFILE);
export const NATIVE_PROFILE_DIR = path.join(DSH_HOME, "profiles", "stsnative");
export const TMP = path.join(TEMP, "sts-rc5");
export const WS = path.join(TMP, "ws");
export const OUT = path.join(TMP, "out");
export const LAUNCHER = path.join(TMP, "run.bat");
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const BANNER = [
  "# dsh profile root - an empty entry list. The tree is composed as patches:",
  "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any",
  "# --patch overlays. Edit cordis.patch.yml, not this file.",
  "[]",
  ""
].join("\n");

const PACKAGE_JSON = {
  name: "dsh-profile-" + PROFILE,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-stop-that-shit"] } }
};

/** Take the model-provider block from stsnative, drop its MCP insert. */
function modelPatchText() {
  const source = path.join(NATIVE_PROFILE_DIR, "cordis.patch.yml");
  if (!fs.existsSync(source)) throw new Error("missing model block source: " + source);
  const lines = fs.readFileSync(source, "utf8").split(/\r?\n/);
  const cut = lines.findIndex((line) => /^- insert:/.test(line));
  const body = (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").replace(/\s+$/, "") + "\n";
  if (!/llm-pi-ai/.test(body)) throw new Error("derived patch has no llm-pi-ai row");
  if (!/agent-default-model/.test(body)) throw new Error("derived patch has no agent-default-model row");
  if (/mcp-rea|dsh-mcp-client/.test(body)) throw new Error("derived patch still contains the MCP client insert");
  return [
    "# stsrc5 patch layer - model providers only (copied from stsnative by e2e/rc5/setup.mjs).",
    "# The MCP client insert from stsnative is intentionally dropped: this rig must boot",
    "# with no external servers so a scenario failure is never an MCP timeout.",
    "# Plugin rows come from the bundle 'dsh-stop-that-shit' itself, not from here.",
    body
  ].join("\n");
}

/** Point node_modules/dsh-stop-that-shit at this repo with a junction. */
function ensureJunction() {
  const link = path.join(PROFILE_DIR, "node_modules", "dsh-stop-that-shit");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const want = REPO;
  let state = "created";
  if (fs.existsSync(link) || isLink(link)) {
    let current = "";
    try { current = fs.realpathSync.native(link); } catch { current = ""; }
    if (current && path.resolve(current).toLowerCase() === path.resolve(want).toLowerCase()) {
      return { link, target: want, state: "ok" };
    }
    // unlinkSync, never rmSync: rmSync would recurse into the real package.
    fs.unlinkSync(link);
    state = "retargeted";
  }
  fs.symlinkSync(want, link, "junction");
  return { link, target: want, state };
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function ensureRig() {
  if (!fs.existsSync(EXE)) throw new Error("harness exe not found: " + EXE);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(path.join(WS, "src"), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  fs.writeFileSync(path.join(PROFILE_DIR, "cordis.yml"), BANNER);
  fs.writeFileSync(path.join(PROFILE_DIR, "package.json"), JSON.stringify(PACKAGE_JSON, null, 2) + "\n");
  fs.writeFileSync(path.join(PROFILE_DIR, "cordis.patch.yml"), modelPatchText());

  const junction = ensureJunction();

  const bat = [
    "@echo off",
    "rem stsrc5 headless launcher - STS rc.5 E2E rig (generated by e2e/rc5/setup.mjs).",
    "rem Lives at an ASCII, space-free path on purpose: cmd mangles quoted paths with",
    "rem spaces, and earlier rounds proved CJK paths can silently break hook spawning.",
    "setlocal",
    'set "ELECTRON_RUN_AS_NODE=1"',
    'set "DSH_DESKTOP_NODE_EXECUTABLE=' + EXE + '"',
    'cd /d "' + WS + '"',
    '"' + EXE + '" --expose-internals "' + CLI + '" --profile ' + PROFILE + ' %*',
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
  fs.writeFileSync(LAUNCHER, bat);

  return { profileDir: PROFILE_DIR, launcher: LAUNCHER, ws: WS, out: OUT, junction, exe: EXE, cli: CLI, repo: REPO };
}

if (import.meta.url === ("file:///" + process.argv[1].replace(/\\/g, "/")).toLowerCase()
  || process.argv[1].endsWith("setup.mjs")) {
  const info = ensureRig();
  console.log(JSON.stringify(info, null, 2));
  const patch = fs.readFileSync(path.join(PROFILE_DIR, "cordis.patch.yml"), "utf8");
  console.log("patch rows: " + patch.split("\n").filter((l) => /^- id:/.test(l)).join(" | "));
  console.log("patch bytes: " + Buffer.byteLength(patch));
}
