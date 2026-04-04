'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createStorage } = require('./storage');

// ── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT || '5577', 10);
const ANTHROPIC_HOST = 'api.anthropic.com';
const LOGS_DIR = path.join(os.homedir(), '.ccxray', 'logs');
const LEGACY_LOGS_DIR = path.join(__dirname, '..', 'logs');
const RESTORE_DAYS = parseInt(process.env.RESTORE_DAYS || '3', 10);

// Storage adapter (local by default, S3 via STORAGE_BACKEND=s3)
const storage = createStorage();

// Model → context window fallback mapping (used when LiteLLM data unavailable)
// https://docs.anthropic.com/en/docs/about-claude/models
const MODEL_CONTEXT_FALLBACK = {
  'claude-opus-4':     200_000,
  'claude-sonnet-4':   200_000,
  'claude-haiku-4':    200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku':  200_000,
  'claude-3-opus':     200_000,
  'claude-3-sonnet':   200_000,
  'claude-3-haiku':    200_000,
};
const DEFAULT_CONTEXT = 200_000;

// Extract effective model ID from system prompt (includes [1m] suffix if present).
// API request model field never includes [1m], but system prompt does:
//   "The exact model ID is claude-opus-4-6[1m]."
function extractModelFromSystem(system) {
  if (!Array.isArray(system)) return null;
  for (const block of system) {
    const text = typeof block === 'string' ? block : (block?.text || '');
    const m = text.match(/exact model ID is (claude-[^\s.]+)/);
    if (m) return m[1];
  }
  return null;
}

function getMaxContext(model, system) {
  // Prefer model ID from system prompt (has [1m] suffix when applicable)
  const effective = extractModelFromSystem(system) || model;
  if (!effective) return DEFAULT_CONTEXT;
  // 1) Explicit suffix: "claude-opus-4-6[1m]" → 1M
  if (/\[1m\]/i.test(effective)) return 1_000_000;
  // 2) Known Claude Code defaults (200K standard plan)
  const stripped = effective.replace(/\[.*\]/, '');
  const keys = Object.keys(MODEL_CONTEXT_FALLBACK).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (stripped.startsWith(key)) return MODEL_CONTEXT_FALLBACK[key];
  }
  // 3) LiteLLM dynamic data — only for unknown models not in fallback table
  const { getModelContext } = require('./pricing');
  const dynamic = getModelContext(stripped);
  if (dynamic) return dynamic;
  return DEFAULT_CONTEXT;
}

// Ensure logs dir exists; migrate from legacy location if needed
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  // One-time migration from old package-relative logs/
  const legacyIndex = path.join(LEGACY_LOGS_DIR, 'index.ndjson');
  if (fs.existsSync(legacyIndex)) {
    try {
      const files = fs.readdirSync(LEGACY_LOGS_DIR);
      for (const f of files) {
        fs.renameSync(path.join(LEGACY_LOGS_DIR, f), path.join(LOGS_DIR, f));
      }
      console.log(`Migrated logs from ${LEGACY_LOGS_DIR} → ${LOGS_DIR}`);
    } catch (e) {
      console.error(`Log migration failed: ${e.message}`);
    }
  }
}

module.exports = {
  PORT,
  ANTHROPIC_HOST,
  LOGS_DIR,
  RESTORE_DAYS,
  storage,
  MODEL_CONTEXT_FALLBACK,
  DEFAULT_CONTEXT,
  getMaxContext,
};
