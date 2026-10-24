#!/usr/bin/env node
/**
 * mark.cjs <EventName> [markerDir]
 * Records which Claude Code event actually reached a hook process.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const event = process.argv[2] || 'unknown';
const dir = process.argv[3] || path.join(__dirname, 'fixtures', 'markers');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, event + '.json'), JSON.stringify({ event, at: new Date().toISOString() }) + '\n');
// No stdout: a silent, non-blocking success.
