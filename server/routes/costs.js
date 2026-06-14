'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../store');
const { getCostsCacheOrNull, calculateBurnRate, getEffectiveTokenLimit } = require('../cost-budget');
const { pricingTable } = require('../pricing');
const { readAllAccounts } = require('../local-usage-reader');
const { refreshCodex, refreshCodexAsync } = require('../adapters/codex-adapter');
const { resolveCcxrayHome } = require('../paths');
const { getUpstreamProfile } = require('../providers');

function isClaudeStatuslineConfigured() {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    const raw = fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    return (settings.statusLine?.command || '').includes('claude-adapter');
  } catch { return false; }
}

function hasClaudeTraffic() {
  for (const meta of Object.values(store.sessionMeta)) {
    if (meta.provider === 'anthropic') return true;
  }
  for (const entry of store.entries) {
    if (!entry.provider || entry.provider === 'anthropic') return true;
  }
  return false;
}

let _accountsCache = null;
let _refreshing = false;
let _codexRefreshTimer = null;

function _buildAccountsPayload() {
  const statusDir = path.join(resolveCcxrayHome(), 'usage-status');
  const configured = isClaudeStatuslineConfigured();
  const accounts = readAllAccounts(statusDir).map(acct => ({
    ...acct,
    brandColor: getUpstreamProfile(acct.provider)?.brandColor || null,
  }));
  return { accounts, claudeStatuslineConfigured: hasClaudeTraffic() ? configured : null };
}

function discoverCodexHomes() {
  // ponytail: scan ~/.codex, ~/.codex-work, ~/.codex-personal etc.
  const home = os.homedir();
  const results = [];
  try {
    for (const d of fs.readdirSync(home)) {
      if (!d.startsWith('.codex') || d.includes('.bak')) continue;
      if (d === '.codex') continue; // ponytail: skip bare .codex if named homes exist; added as fallback below
      if (!d.startsWith('.codex-')) continue;
      const sessions = path.join(home, d, 'sessions');
      if (fs.existsSync(sessions)) results.push({ sessions, alias: d.slice('.codex-'.length) });
    }
  } catch {}
  // fallback: no named homes → use bare ~/.codex/
  if (!results.length) {
    const sessions = path.join(home, '.codex', 'sessions');
    if (fs.existsSync(sessions)) results.push({ sessions, alias: 'default' });
  }
  return results;
}

function startCodexRefresh() {
  const statusDir = path.join(resolveCcxrayHome(), 'usage-status');
  const homes = discoverCodexHomes();
  for (const { sessions, alias } of homes) {
    try { refreshCodex(sessions, statusDir, alias); } catch {}
  }
  _accountsCache = _buildAccountsPayload();

  async function tick() {
    if (_refreshing) return;
    _refreshing = true;
    try {
      const h = discoverCodexHomes();
      for (const { sessions, alias } of h) {
        await refreshCodexAsync(sessions, statusDir, alias);
      }
      _accountsCache = _buildAccountsPayload();
    } catch {} finally { _refreshing = false; }
  }
  _codexRefreshTimer = setInterval(tick, 30_000);
  _codexRefreshTimer.unref();
}

function stopCodexRefresh() {
  if (_codexRefreshTimer) { clearInterval(_codexRefreshTimer); _codexRefreshTimer = null; }
}

// Helper: return loading response if cache not ready (triggers background computation)
function sendLoadingOrData(clientRes, dataFn) {
  const data = getCostsCacheOrNull();
  if (!data) {
    clientRes.writeHead(202, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ loading: true }));
    return;
  }
  dataFn(data);
}

function getAccountsPayload() {
  // ponytail: reads from in-memory cache; background timer refreshes it
  return _accountsCache || { accounts: [], claudeStatuslineConfigured: null };
}

function handleCostRoutes(clientReq, clientRes) {
  const pathname = clientReq.url.split('?')[0];

  if (pathname === '/_api/costs/current-block') {
    sendLoadingOrData(clientRes, data => {
      const now = Date.now();
      const acctPayload = getAccountsPayload();
      const activeBlock = data.blocks.find(b => b.isActive);
      if (!activeBlock) {
        const lastBlock = data.blocks[data.blocks.length - 1];
        if (!lastBlock) {
          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ active: false, ...acctPayload }));
          return;
        }
        clientRes.writeHead(200, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({
          active: false,
          lastBlock: {
            startTime: lastBlock.startTime,
            endTime: lastBlock.endTime,
            totalTokens: lastBlock.totalTokens,
            costUSD: Math.round(lastBlock.costUSD * 100) / 100,
            models: lastBlock.models,
            minutesAgo: Math.round((now - lastBlock._lastTs) / 60000),
          },
          ...acctPayload,
        }));
        return;
      }
      const br = calculateBurnRate(activeBlock);
      const minutesRemaining = Math.round((activeBlock._endMs - now) / 60_000);
      const rawRateLimitState = store.getRateLimitState();
      // Ignore stale rate limit data: must be within current block and <10min old
      const rateLimitState = rawRateLimitState
        && rawRateLimitState.updatedAt > activeBlock._startMs
        && (now - rawRateLimitState.updatedAt) < 600_000
        ? rawRateLimitState : null;
      const liveLimit = rateLimitState && rateLimitState.tokensLimit;
      const liveRemaining = rateLimitState && rateLimitState.tokensRemaining;
      const tokenLimit = liveLimit || getEffectiveTokenLimit();
      const tokensUsed = liveLimit ? (liveLimit - liveRemaining) : activeBlock.totalTokens;
      const percentUsed = Math.round((tokensUsed / tokenLimit) * 1000) / 10;
      const resetTime = rateLimitState && rateLimitState.inputReset || activeBlock.endTime;
      const windowStartMs = activeBlock._startMs;
      const windowEndMs = activeBlock._endMs;
      const windowDurationMs = windowEndMs - windowStartMs;
      const minutesElapsed = Math.round((now - windowStartMs) / 60_000);
      const timePct = Math.round(Math.min(100, Math.max(0, (now - windowStartMs) / windowDurationMs * 100) * 10)) / 10;
      const resp = {
        active: true,
        startTime: activeBlock.startTime,
        endTime: resetTime,
        totalTokens: tokensUsed,
        tokenLimit,
        percentUsed,
        costUSD: Math.round(activeBlock.costUSD * 100) / 100,
        models: activeBlock.models,
        burnRate: br ? br.burnRate : null,
        projection: br ? br.projection : null,
        minutesRemaining: rateLimitState && rateLimitState.inputReset
          ? Math.round((new Date(rateLimitState.inputReset).getTime() - now) / 60_000)
          : minutesRemaining,
        minutesElapsed,
        timePct,
        source: rateLimitState ? 'live' : 'jsonl',
        ...acctPayload,
      };
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify(resp));
    });
    return true;
  }

  if (pathname === '/_api/costs/daily') {
    sendLoadingOrData(clientRes, data => {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify(data.daily));
    });
    return true;
  }

  if (pathname === '/_api/costs/monthly') {
    sendLoadingOrData(clientRes, data => {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const currentMonthData = data.monthly.find(m => m.month === currentMonth) || { month: currentMonth, totalTokens: 0, costUSD: 0, models: [] };
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ monthly: data.monthly, currentMonth: currentMonthData }));
    });
    return true;
  }

  if (pathname === '/_api/pricing') {
    const result = {};
    for (const [model, rates] of Object.entries(pricingTable)) {
      result[model] = {
        input_cost_per_mtok: rates.input,
        output_cost_per_mtok: rates.output,
        cache_read_cost_per_mtok: rates.cache_read,
        cache_creation_cost_per_mtok: rates.cache_create,
      };
    }
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(result));
    return true;
  }

  return false;
}

module.exports = { handleCostRoutes, startCodexRefresh, stopCodexRefresh };
