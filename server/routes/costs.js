'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../store');
const { getCostsCacheOrNull, calculateBurnRate, getEffectiveTokenLimit } = require('../cost-budget');
const { pricingTable } = require('../pricing');
const { readAllAccounts } = require('../local-usage-reader');
const { resolveCcxrayHome } = require('../paths');

function isClaudeStatuslineConfigured() {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    const raw = fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    return (settings.statusLine?.command || '').includes('claude-adapter');
  } catch { return false; }
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
  const statusDir = path.join(resolveCcxrayHome(), 'usage-status');
  return {
    accounts: readAllAccounts(statusDir),
    claudeStatuslineConfigured: isClaudeStatuslineConfigured(),
  };
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

module.exports = { handleCostRoutes };
