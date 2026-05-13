'use strict';

// Minimal config loader for the OTel rollout (Phase 2a slice).
// This intentionally implements only the surface needed for the first
// vertical slice: read .ccxray.json from cwd if present, return a default
// shape otherwise. Env interpolation, literal-secret detection, gitignore
// auto-amend, personal config (.ccxray.user.json), and walk-up-to-git-root
// lookup all land in later Phase 2 sub-phases per the OpenSpec change.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = Object.freeze({
  otel: Object.freeze({
    enabled: false,
    tier: 0,
    endpoint: null,
    headers: Object.freeze({}),
    resource_attributes: Object.freeze({}),
    cardinality_overrides: Object.freeze({}),
  }),
});

function projectConfigPath(cwd) {
  return path.join(cwd || process.cwd(), '.ccxray.json');
}

function readProjectConfig(cwd) {
  const file = projectConfigPath(cwd);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { config: DEFAULT_CONFIG, source: null };
    throw new Error(`config-loader: failed to read ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config-loader: ${file} is not valid JSON (${err.message})`);
  }
  return { config: mergeWithDefaults(parsed), source: file };
}

function mergeWithDefaults(input) {
  const otel = input && typeof input.otel === 'object' && input.otel ? input.otel : {};
  return {
    otel: {
      enabled: otel.enabled === true,
      tier: Number.isInteger(otel.tier) ? otel.tier : 0,
      endpoint: typeof otel.endpoint === 'string' ? otel.endpoint : null,
      headers: otel.headers && typeof otel.headers === 'object' ? { ...otel.headers } : {},
      resource_attributes: otel.resource_attributes && typeof otel.resource_attributes === 'object'
        ? { ...otel.resource_attributes }
        : {},
      cardinality_overrides: otel.cardinality_overrides && typeof otel.cardinality_overrides === 'object'
        ? { ...otel.cardinality_overrides }
        : {},
    },
  };
}

module.exports = { readProjectConfig, projectConfigPath, DEFAULT_CONFIG };
