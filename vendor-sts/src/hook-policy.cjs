'use strict';

// Compatibility facade for the original module path. New host integrations should
// implement the ControlEvent seam instead of importing Codex Hook shapes here.
const { handleCodexHook } = require('./adapters/codex-hooks.cjs');
const { contractContext } = require('./controller.cjs');

module.exports = { contractContext, handleHook: handleCodexHook };
