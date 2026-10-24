'use strict';
const fs = require('node:fs');
const path = require('node:path');
const src = path.resolve('..', 'lead-sts', 'hooks', 'hooks.json');
const cfg = JSON.parse(fs.readFileSync(src, 'utf8'));
const wrapper = path.resolve('sts-dsh-wrapper.cjs');
for (const group of cfg.hooks.PreToolUse) {
  for (const hook of group.hooks) {
    hook.command = 'node "' + wrapper.replace(/\\/g, '/') + '"';
  }
}
fs.writeFileSync(path.resolve('hooks-dsh.json'), JSON.stringify(cfg, null, 2) + '\n');
console.log('wrote hooks-dsh.json');
