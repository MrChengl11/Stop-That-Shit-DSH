#!/usr/bin/env node
/**
 * slow-hook.cjs <delayMs> <eventName>
 * Sleeps, then emits a PreToolUse deny. Used to measure the timeout unit.
 */
'use strict';
const delayMs = Number(process.argv[2] || 0);
const event = process.argv[3] || 'PreToolUse';
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: 'slow hook reached its decision after ' + delayMs + 'ms',
    },
  }) + '\n');
}, delayMs);
