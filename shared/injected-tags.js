'use strict';

// Canonical regex matching text blocks that Claude Code (and Grok CLI, which
// injects <user_info> scaffolding as role:user) puts into user messages. These
// look like user input from the API perspective but are not human turn
// openers. The dashboard's public/messages.js holds an inline copy of the same
// pattern; tests/turn-step.test.js asserts they stay in sync.
const INJECTED_TAG_RE = /^<(system-reminder|user_info|user-prompt-submit-hook|context|antml:function_calls)[^>]*>/;

function isInjectedText(text) {
  if (typeof text !== 'string') return false;
  return INJECTED_TAG_RE.test(text.trimStart());
}

module.exports = { INJECTED_TAG_RE, isInjectedText };
