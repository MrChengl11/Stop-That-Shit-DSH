#!/usr/bin/env node
/**
 * harness-version.mjs — print the DSH desktop-host version straight out of the
 * installed app.asar, so the report never has to trust a remembered number.
 *
 *   node e2e/rc5/harness-version.mjs ["C:\\...\\resources\\app.asar"]
 *
 * ASAR layout: uint32 header-size field (always 4), uint32 JSON-header size,
 * JSON directory tree, then the file payloads.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
  "Programs", "DeepSeek Harness", "resources", "app.asar"
);
const file = process.argv[2] || DEFAULT;

const fd = fs.openSync(file, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const header = Buffer.alloc(headerSize);
fs.readSync(fd, header, 0, headerSize, 16);
const tree = JSON.parse(header.toString("utf8"));
const base = 16 + headerSize;

const WANTED = /^(?:package\.json|dsh\/package\.json)$|dsh-desktop-host\/package\.json$/;
const found = [];
(function walk(node, prefix) {
  if (!node || !node.files) return;
  for (const [name, entry] of Object.entries(node.files)) {
    const current = prefix ? prefix + "/" + name : name;
    if (name === "package.json" && WANTED.test(current)) found.push({ path: current, entry });
    walk(entry, current);
  }
})(tree, "");

let version = null;
for (const { path: p, entry } of found) {
  // asar stores offset as a STRING; Number() it or every entry is skipped.
  const offset = Number(entry.offset);
  const size = Number(entry.size);
  if (entry.files || !Number.isFinite(offset) || !Number.isFinite(size) || size > 8192) continue;
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, base + offset);
  try {
    const pkg = JSON.parse(buf.toString("utf8"));
    console.log(p + " => " + pkg.name + " " + pkg.version);
    if (/dsh-desktop-host$/.test(pkg.name)) version = pkg.version;
  } catch {}
}
fs.closeSync(fd);
console.log("desktop-host version: " + (version ?? "(not found)"));
process.exit(version ? 0 : 1);
