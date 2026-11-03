
import fs from "node:fs";
import zlib from "node:zlib";
const dir = process.argv[2];
const file = dir + "/session.v4.jsonl.zstd";
const raw = zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8");
const lines = raw.split("\n").filter(Boolean);
console.log("lines:", lines.length);
for (const line of lines) {
  try {
    const o = JSON.parse(line);
    console.log(JSON.stringify(o).slice(0, 300));
  } catch { console.log("RAW:", line.slice(0, 200)); }
}
