'use strict';

function normalizeEpoch(v) {
  return v > 1e10 ? Math.floor(v / 1000) : v;
}

module.exports = { normalizeEpoch };
