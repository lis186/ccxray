'use strict';

const optionLike = token => typeof token === 'string' && token.length > 1 && token[0] === '-';

function hasClaudeBackgroundFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && (i === 0 || !optionLike(args[i - 1]))) return false;
    if (arg === '--bg' || arg === '--background') return true;
  }
  return false;
}

module.exports = { hasClaudeBackgroundFlag };
