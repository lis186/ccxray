// ── Cost Budget: Client-side ──────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

let _costActiveFilter = null; // null = All
let _costPageCache = null;
let _costLiveTimer = null;
let _costLiveRefreshing = false;

function showCostPage() {
  switchTab('usage');
}
function hideCostPage() {
  switchTab('dashboard');
}

function startCostLiveRefresh() {
  stopCostLiveRefresh();
  // Soft-refresh while the Usage tab is open so account % left / reset
  // labels stay current without a full skeleton reload.
  _costLiveTimer = setInterval(() => {
    if (typeof activeTab !== 'undefined' && activeTab === 'usage') {
      softRefreshCostPage();
    }
  }, 8000);
}
function stopCostLiveRefresh() {
  if (_costLiveTimer) {
    clearInterval(_costLiveTimer);
    _costLiveTimer = null;
  }
}

/** Re-fetch cost APIs without skeleton flash; no-op if a refresh is in flight. */
async function softRefreshCostPage() {
  if (_costLiveRefreshing) return;
  if (typeof activeTab !== 'undefined' && activeTab !== 'usage') return;
  _costLiveRefreshing = true;
  try {
    const [blockData, dailyData, monthlyResp] = await Promise.all([
      fetch('/_api/costs/current-block').then(r => r.json()).catch(() => null),
      fetch('/_api/costs/daily').then(r => r.json()).catch(() => null),
      fetch('/_api/costs/monthly').then(r => r.json()).catch(() => null),
    ]);
    if (!dailyData || dailyData.loading || !monthlyResp || monthlyResp.loading) return;
    const block = (blockData && !blockData.loading) ? blockData : (_costPageCache?.blockData || { active: false });
    _costPageCache = { blockData: block, dailyData, monthlyResp };
    renderMonthlySummary(monthlyResp);
    renderDailyHeatmap(dailyData);
    renderAccounts(block, dailyData, monthlyResp);
  } catch {
    // ambient refresh — ignore
  } finally {
    _costLiveRefreshing = false;
  }
}

/** Called from the dashboard SSE path when a new turn lands. */
function onCostRelevantEntry(entry) {
  if (!entry || !entry.usage) return;
  if (typeof activeTab === 'undefined' || activeTab !== 'usage') return;
  // Debounce via soft refresh; live overlay on the server makes this pick up fast.
  softRefreshCostPage();
}

// INVARIANT: skeleton IDs must match render function lookups — see docs/decisions/0004-skeleton-lifecycle.md
function renderCostSkeletons() {
  // Left panel: account card skeleton
  const left = document.getElementById('cp-left');
  if (left) {
    const acctCard = document.getElementById('cp-accounts');
    if (acctCard) {
      acctCard.style.display = '';
      const content = document.getElementById('cp-accounts-content');
      if (content) {
        content.innerHTML =
          '<div style="margin-bottom:8px"><span class="skeleton skeleton-text" style="width:60px"></span></div>' +
          '<div style="display:flex;gap:10px">' +
            '<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px">' +
              '<div class="skeleton skeleton-block" style="width:40px;height:10px;margin-bottom:6px"></div>' +
              '<div class="skeleton skeleton-block" style="width:70px;height:18px;margin-bottom:8px"></div>' +
              '<div class="skeleton skeleton-block" style="height:5px;border-radius:3px"></div>' +
            '</div>' +
            '<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px">' +
              '<div class="skeleton skeleton-block" style="width:40px;height:10px;margin-bottom:6px"></div>' +
              '<div class="skeleton skeleton-block" style="width:70px;height:18px;margin-bottom:8px"></div>' +
              '<div class="skeleton skeleton-block" style="height:5px;border-radius:3px"></div>' +
            '</div>' +
          '</div>';
      }
    }
  }

  // Right panel: monthly + daily skeletons
  const right = document.getElementById('cp-right');
  if (right) {
    let html = '';
    // Monthly skeleton
    html += '<div id="cp-monthly" class="cost-card" style="margin-bottom:12px">';
    html += '<div class="cost-card-label">Monthly</div>';
    html += '<div style="display:flex;flex-direction:column;gap:6px">';
    for (let i = 0; i < 4; i++) {
      html += '<div style="display:flex;align-items:center;gap:8px">' +
        '<span class="skeleton skeleton-text" style="width:28px;height:11px"></span>' +
        '<div class="skeleton skeleton-block" style="flex:1;height:14px;border-radius:3px;margin-bottom:0"></div>' +
        '<span class="skeleton skeleton-text" style="width:44px;height:11px"></span>' +
      '</div>';
    }
    html += '</div></div>';

    // Daily heatmap skeleton
    html += '<div id="cp-daily" class="cost-card">';
    html += '<div class="cost-card-label">Daily Cost</div>';
    html += '<div style="display:flex;flex-direction:column;gap:2px">';
    for (let i = 0; i < 10; i++) {
      html += '<div style="display:flex;align-items:center;gap:8px;height:16px">' +
        '<span class="skeleton skeleton-text" style="width:56px;height:10px"></span>' +
        '<div class="skeleton skeleton-block" style="flex:1;height:10px;border-radius:3px;margin-bottom:0"></div>' +
        '<span class="skeleton skeleton-text" style="width:40px;height:10px"></span>' +
      '</div>';
    }
    html += '</div></div>';

    right.innerHTML = html;
  }
}

async function loadCostPage() {
  renderCostSkeletons();
  startCostLiveRefresh();

  async function fetchWithRetry(url, fallback, maxRetries = 20) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const r = await fetch(url);
        const data = await r.json();
        if (data && data.loading) {
          await new Promise(ok => setTimeout(ok, 2000));
          continue;
        }
        return data;
      } catch { return fallback; }
    }
    return fallback;
  }

  const [blockData, dailyData, monthlyResp] = await Promise.all([
    fetchWithRetry('/_api/costs/current-block', { active: false }),
    fetchWithRetry('/_api/costs/daily', []),
    fetchWithRetry('/_api/costs/monthly', { monthly: [], currentMonth: null }),
  ]);

  _costPageCache = { blockData, dailyData, monthlyResp };
  renderMonthlySummary(monthlyResp);
  renderDailyHeatmap(dailyData);
  renderAccounts(blockData, dailyData, monthlyResp);
}

// ── Account brand colors ──────────────────────────────────────────────
// Match UPSTREAM_PROFILES brandColor (anthropic / openai / xai→grok).
const _acctColors = {
  anthropic: '#e8956a',
  openai: '#74aa9c',
  grok: '#a78bfa',
};
function providerDisplayName(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'grok') return 'Grok';
  return 'Claude';
}
function acctColor(accountId) {
  if (!accountId) return 'var(--dim)';
  if (accountId.startsWith('codex')) return _acctColors.openai;
  if (accountId.startsWith('grok')) return _acctColors.grok;
  return _acctColors.anthropic;
}
function acctLabel(accountId, allAccounts) {
  if (!accountId) return 'Unknown';
  const [provider, ...rest] = accountId.split('-');
  const alias = rest.join('-');
  const name = providerDisplayName(provider);
  if (alias !== 'default') return `${name} · ${alias}`;
  // ponytail: show "default" when other accounts of same provider exist
  if (allAccounts && allAccounts.some(a => a !== accountId && a.startsWith(provider + '-'))) return `${name} · default`;
  return name;
}

// ── Accounts card ─────────────────────────────────────────────────────
// Union of (1) rate-limit status snaps (Claude/Codex 5h windows) and
// (2) cost accounts from daily byAccount (Grok has cost, no rate-limit snap).
// Active provider filter applies here too — selecting Grok must not leave a
// lone "Codex plus" rate-limit card as if that were Grok usage.
function _accountCostSummary(accountId, dailyData, monthlyResp) {
  const todayStr = new Date().toLocaleDateString('sv-SE');
  const today = (dailyData || []).find(d => d.date === todayStr);
  const todayCost = today?.byAccount?.[accountId]?.costUSD || 0;
  const monthCost = monthlyResp?.currentMonth?.byAccount?.[accountId]?.costUSD || 0;
  // Last-30 fallback when "today" is empty (timezone edge / no spend yet today).
  let last30 = 0;
  for (const d of (dailyData || []).slice(-30)) {
    last30 += d.byAccount?.[accountId]?.costUSD || 0;
  }
  return { todayCost, monthCost, last30 };
}

function renderAccounts(blockData, dailyData, monthlyResp) {
  const card = document.getElementById('cp-accounts');
  const el = document.getElementById('cp-accounts-content');
  if (!card || !el) return;

  const rateAccounts = (blockData && blockData.accounts) || [];
  const configured = blockData && blockData.claudeStatuslineConfigured;
  const rateById = new Map(rateAccounts.map(a => [a.id, a]));
  const costIds = collectAccounts(dailyData || []);
  const allIds = [...new Set([...rateById.keys(), ...costIds])].sort();
  const f = _costActiveFilter;
  const visibleIds = allIds.filter(id => filterMatchesAccount(f, id));

  // INVARIANT: early-return must clear innerHTML — see docs/decisions/0004-skeleton-lifecycle.md
  if (visibleIds.length === 0 && configured !== false) {
    el.innerHTML = '';
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  let html = '';
  const brandColor = acct => acct.brandColor || acctColor(acct.id) || 'var(--text)';
  const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  for (let idx = 0; idx < visibleIds.length; idx++) {
    const id = visibleIds[idx];
    const rate = rateById.get(id);
    const costs = _accountCostSummary(id, dailyData, monthlyResp);
    const sep = idx > 0 ? 'border-top:1px solid var(--border);padding-top:12px;margin-top:4px;' : '';
    const color = rate ? brandColor(rate) : acctColor(id);
    const nameStr = rate
      ? (rate.label
        || (rate.provider === 'openai' ? 'Codex'
          : (rate.provider === 'xai' || rate.provider === 'grok') ? 'Grok'
            : 'Claude'))
      : acctLabel(id, allIds);
    const plan = rate?.planType
      ? ` <span style="font-weight:400;color:var(--dim);font-size:10px">${esc(rate.planType)}</span>`
      : '';

    html += `<div style="${sep}">`;
    html += `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:8px">`;
    html += `<span style="font-weight:600;color:${color}">${esc(nameStr)}${plan}</span>`;
    if (rate) {
      const freshDot = rate.fresh
        ? '<span style="color:var(--green)">●</span> live'
        : '<span style="color:var(--dim)">○</span> cached';
      html += `<span style="font-size:10px;color:var(--dim)">${freshDot}</span>`;
    } else {
      html += `<span style="font-size:10px;color:var(--dim)">proxy cost</span>`;
    }
    html += `</div>`;

    if (rate) {
      html += `<div style="display:flex;gap:10px;margin-bottom:6px">`;
      if (rate.unlimited) {
        html += `<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px;font-size:13px;color:var(--green)">∞ Unlimited</div>`;
      } else {
        // Claude/Codex: 5-Hour (+ optional Weekly). Grok: weekly only (fiveHour null).
        if (rate.fiveHour) html += renderAccountCard('5-Hour', rate.fiveHour);
        if (rate.sevenDay) html += renderAccountCard('Weekly', rate.sevenDay);
        if (!rate.fiveHour && !rate.sevenDay) {
          html += `<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px;font-size:11px;color:var(--dim)">No quota window</div>`;
        }
      }
      html += `</div>`;
    }
    // Cost summary only for cost-only accounts (no rate-limit snap).
    // Grok has weekly SuperGrok limit from billing — no Today/Month $ row.
    const showCost = !rate;
    if (showCost) {
      html += `<div style="display:flex;gap:10px;margin-bottom:6px">`;
      html += `<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px">
        <div style="font-size:10px;color:var(--dim);margin-bottom:4px">Today</div>
        <div style="font-size:18px;font-weight:700">$${costs.todayCost.toFixed(2)}</div>
      </div>`;
      html += `<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px">
        <div style="font-size:10px;color:var(--dim);margin-bottom:4px">Month</div>
        <div style="font-size:18px;font-weight:700">$${costs.monthCost.toFixed(2)}</div>
      </div>`;
      html += `</div>`;
      if (!rate && costs.todayCost === 0 && costs.monthCost === 0 && costs.last30 > 0) {
        html += `<div style="font-size:10px;color:var(--dim)">Last 30d: $${costs.last30.toFixed(2)}</div>`;
      }
    }

    html += `</div>`;
  }

  // Claude setup hint only when Claude is in the visible set (or All with no Claude rate snap).
  const showClaudeHint = configured === false
    && !visibleIds.some(id => id.startsWith('claude-') && rateById.has(id))
    && (!f || f === 'claude:*' || (typeof f === 'string' && f.startsWith('claude-')));
  if (showClaudeHint) {
    html += `<div style="font-size:11px;color:var(--dim);border-top:1px solid var(--border);padding-top:8px;margin-top:8px;display:flex;align-items:center;justify-content:space-between">
      <span>Track Claude rate limits</span>
      <span style="display:flex;align-items:center;gap:4px;font-size:10px"><code style="background:var(--surface);padding:1px 4px;border-radius:3px">ccxray setup-statusline</code>
      <button id="cp-copy-cmd" style="background:none;color:var(--dim);border:none;padding:0;cursor:pointer;line-height:1;display:flex" title="Copy command">${copyIcon}</button></span>
    </div>`;
  }

  el.innerHTML = html;
  const copyBtn = document.getElementById('cp-copy-cmd');
  if (copyBtn) {
    const originalSvg = copyBtn.innerHTML;
    copyBtn.onclick = () => navigator.clipboard.writeText('ccxray setup-statusline').then(() => {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.innerHTML = originalSvg; }, 1500);
    });
  }
}

function _fmtQuotaCount(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

function renderAccountCard(label, win) {
  if (!win) return '';
  // Prefer one-decimal left% when provided (Grok weekly can be <<1% used).
  const leftRaw = win.leftPct != null ? win.leftPct : (100 - (win.usedPct || 0));
  const leftPct = Math.round(leftRaw * 10) / 10;
  const barColor = leftPct > 30 ? 'var(--green)' : leftPct > 10 ? 'var(--yellow)' : 'var(--red)';
  // Real resetsAt → "Resets in …". Else optional windowLabel (e.g. period name).
  const resetStr = win.resetLabel ? `Resets in ${esc(win.resetLabel)}` : '';
  let periodStr = '';
  if (win.periodStart && win.periodEnd) {
    const fmt = (iso) => {
      try {
        const d = new Date(iso);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      } catch { return ''; }
    };
    const a = fmt(win.periodStart), b = fmt(win.periodEnd);
    if (a && b) periodStr = `${a} → ${b}`;
  } else if (!win.resetLabel && win.windowLabel) {
    periodStr = win.windowLabel;
  }
  const unit = win.unit === 'credits' ? '' : (win.unit === 'tok' ? ' tok' : '');
  const usageStr = (win.used != null && win.limit != null)
    ? `${esc(_fmtQuotaCount(win.used))} / ${esc(_fmtQuotaCount(win.limit))}${esc(unit)}`
    : '';
  // Prefer provider window label for the card title when present (Monthly/Weekly).
  const title = win.windowLabel || label;
  return `<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px">
    <div style="font-size:10px;color:var(--dim);margin-bottom:4px">${esc(title)}</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:6px">${leftPct}% <span style="font-size:11px;font-weight:400;color:var(--dim)">left</span></div>
    <div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:6px">
      <div style="height:100%;width:${Math.min(leftPct,100)}%;background:${barColor};border-radius:3px"></div>
    </div>
    ${usageStr ? `<div style="font-size:10px;color:var(--dim);margin-bottom:2px">${usageStr}</div>` : ''}
    ${resetStr ? `<div style="font-size:10px;color:var(--dim)">${resetStr}</div>` : ''}
    ${periodStr ? `<div style="font-size:10px;color:var(--dim)">${esc(periodStr)}</div>` : ''}
  </div>`;
}

// ── Filter bar ────────────────────────────────────────────────────────
function collectAccounts(dailyData) {
  const set = new Set();
  for (const d of dailyData) {
    if (d.byAccount) for (const k of Object.keys(d.byAccount)) set.add(k);
  }
  // Include accounts from rate-limit data even if they have no cost history
  const accts = _costPageCache?.blockData?.accounts;
  if (accts) for (const a of accts) { if (a.id) set.add(a.id); }
  return [...set].sort();
}

// ponytail: filter can be null (All), "claude:*" / "codex:*" (provider), or "claude-personal" (account)
function filterMatchesAccount(filter, acctId) {
  if (!filter) return true;
  if (filter.endsWith(':*')) return acctId.startsWith(filter.slice(0, -2) + '-');
  return filter === acctId;
}
function filteredCost(day, filter) {
  if (!filter) return day.costUSD || 0;
  if (!day.byAccount) return 0;
  if (!filter.endsWith(':*')) return day.byAccount[filter]?.costUSD || 0;
  let sum = 0;
  for (const [k, v] of Object.entries(day.byAccount)) { if (filterMatchesAccount(filter, k)) sum += v.costUSD || 0; }
  return sum;
}

function _applyFilter(filter) {
  _costActiveFilter = filter || null;
  if (_costPageCache) {
    renderMonthlySummary(_costPageCache.monthlyResp);
    renderDailyHeatmap(_costPageCache.dailyData);
    renderAccounts(_costPageCache.blockData, _costPageCache.dailyData, _costPageCache.monthlyResp);
  } else {
    loadCostPage();
  }
}

function _providerBtnLabel(provider, filter) {
  const name = providerDisplayName(provider);
  if (!filter || !filter.startsWith(provider)) return name;
  if (filter === provider + ':*') return name;
  const alias = filter.slice(provider.length + 1);
  return `${name} · ${alias}`;
}

function _isProviderActive(provider, filter) {
  if (!filter) return false;
  return filter === provider + ':*' || (filter.startsWith(provider + '-'));
}

function renderFilterBar(container, accounts) {
  if (!accounts.length) return;
  const providers = [...new Set(accounts.map(a => a.split('-')[0]))].sort();
  const f = _costActiveFilter;
  const allActive = !f;

  const btnStyle = (active, color) =>
    `font-size:10px;padding:2px 8px;border:none;cursor:pointer;background:${active ? (color || 'var(--accent)') : 'var(--surface)'};color:${active ? '#000' : (color || 'var(--dim)')}`;
  const arrowStyle = (active, color) =>
    `font-size:10px;padding:2px 4px 2px 0;border:none;cursor:pointer;background:${active ? (color || 'var(--accent)') : 'var(--surface)'};color:${active ? '#000' : (color || 'var(--dim)')}`;

  let html = '<div id="cp-filter-bar" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;align-items:flex-start">';
  html += `<button class="cp-filter-btn" data-filter="" style="${btnStyle(allActive, null)};border-radius:10px;border:1px solid ${allActive ? 'var(--accent)' : 'var(--border)'}">All</button>`;

  for (const p of providers) {
    const color = acctColor(p + '-x');
    const active = _isProviderActive(p, f);
    const label = _providerBtnLabel(p, f);
    const pAccounts = accounts.filter(a => a.startsWith(p + '-'));
    const borderColor = active ? color : 'var(--border)';

    html += `<span class="cp-provider-group" data-provider="${esc(p)}" style="position:relative;display:inline-flex;border-radius:10px;border:1px solid ${borderColor}">`;
    html += `<button class="cp-filter-btn cp-provider-btn" data-filter="${esc(p + ':*')}" style="${btnStyle(active, color)};border-radius:10px 0 0 10px;padding-left:8px">${esc(label)}</button>`;
    html += `<button class="cp-arrow-btn" data-provider="${esc(p)}" style="${arrowStyle(active, color)};border-radius:0 10px 10px 0">▾</button>`;

    html += `<div class="cp-dropdown" data-provider="${esc(p)}" style="display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:6px;min-width:140px;padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,0.3)">`;
    const providerName = providerDisplayName(p);
    html += `<div class="cp-dropdown-item" data-filter="${esc(p + ':*')}" style="padding:4px 10px;font-size:10px;cursor:pointer;color:${color}">All ${esc(providerName)}</div>`;
    for (const id of pAccounts) {
      const alias = id.slice(p.length + 1);
      html += `<div class="cp-dropdown-item" data-filter="${esc(id)}" style="padding:4px 10px 4px 18px;font-size:10px;cursor:pointer;color:var(--text)">· ${esc(alias)}</div>`;
    }
    html += `</div>`;
    html += `</span>`;
  }
  html += '</div>';
  container.insertAdjacentHTML('afterbegin', html);

  const bar = container.querySelector('#cp-filter-bar');

  // All button + provider button clicks
  bar.addEventListener('click', e => {
    const filterBtn = e.target.closest('.cp-filter-btn:not(.cp-provider-btn)');
    if (filterBtn && filterBtn.dataset.filter === '') { _applyFilter(null); return; }
    const provBtn = e.target.closest('.cp-provider-btn');
    if (provBtn) { _applyFilter(provBtn.dataset.filter); return; }
    const arrow = e.target.closest('.cp-arrow-btn');
    if (arrow) {
      e.stopPropagation();
      const p = arrow.dataset.provider;
      const dd = bar.querySelector(`.cp-dropdown[data-provider="${p}"]`);
      const wasOpen = dd.style.display !== 'none';
      bar.querySelectorAll('.cp-dropdown').forEach(d => d.style.display = 'none');
      if (!wasOpen) dd.style.display = '';
      return;
    }
    const item = e.target.closest('.cp-dropdown-item');
    if (item) {
      bar.querySelectorAll('.cp-dropdown').forEach(d => d.style.display = 'none');
      _applyFilter(item.dataset.filter);
      return;
    }
  });

  // Close dropdown on outside click — single handler, no leak
  if (!window._cpDropdownClose) {
    window._cpDropdownClose = e => {
      if (!e.target.closest('.cp-provider-group')) {
        document.querySelectorAll('#cp-filter-bar .cp-dropdown').forEach(d => d.style.display = 'none');
      }
    };
    document.addEventListener('click', window._cpDropdownClose);
  }

  // Hover highlight on dropdown items
  bar.addEventListener('mouseover', e => {
    const item = e.target.closest('.cp-dropdown-item');
    if (item) item.style.background = 'var(--surface-hover)';
  });
  bar.addEventListener('mouseout', e => {
    const item = e.target.closest('.cp-dropdown-item');
    if (item) item.style.background = '';
  });
}

// ── Daily heatmap ─────────────────────────────────────────────────────
function renderDailyHeatmap(dailyData) {
  let container = document.getElementById('cp-daily');
  if (!container) {
    const fp = document.getElementById('cp-right');
    if (!fp) return;
    container = document.createElement('div');
    container.id = 'cp-daily';
    container.className = 'cost-card';
    fp.appendChild(container);
  }
  const accounts = collectAccounts(dailyData);

  // Filter to last 30 days with data (or all if filter active)
  const recent = dailyData.slice(-30);
  const f = _costActiveFilter;
  const maxCost = Math.max(...recent.map(d => filteredCost(d, f)), 0.01);

  const dateRange = recent.length ? `${recent[0].date} – ${recent[recent.length - 1].date}` : '';
  let html = `<div class="cost-card-label">Daily Cost <span style="text-transform:none;letter-spacing:0">(${esc(dateRange)})</span></div>`;
  html += '<div style="display:flex;flex-direction:column;gap:2px">';

  for (const day of recent) {
    const cost = filteredCost(day, f);
    const pct = Math.min(100, (cost / maxCost) * 100);
    const weekday = new Date(day.date + 'T12:00:00').toLocaleDateString('en', { weekday: 'short' });
    const isWeekend = weekday === 'Sat' || weekday === 'Sun';

    html += `<div style="display:flex;align-items:center;gap:8px;font-size:10px;height:16px;opacity:${cost === 0 ? 0.3 : 1}">`;
    html += `<span style="width:56px;text-align:right;color:${isWeekend ? 'var(--dim)' : 'var(--text)'};flex-shrink:0">${day.date.slice(5)} ${weekday}</span>`;
    html += `<div style="flex:1;height:10px;background:var(--border);border-radius:3px;overflow:hidden;display:flex">`;

    if (f || !day.byAccount || !Object.keys(day.byAccount).length) {
      const color = f ? acctColor(f.endsWith(':*') ? f.slice(0,-2)+'-x' : f) : 'var(--accent)';
      html += `<div style="height:100%;width:${pct}%;background:${color};border-radius:3px;min-width:${cost > 0 ? 2 : 0}px"></div>`;
    } else {
      const sorted = Object.entries(day.byAccount).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [acctId, acctData] of sorted) {
        const aPct = Math.max(0, (acctData.costUSD / maxCost) * 100);
        if (aPct <= 0) continue;
        html += `<div style="height:100%;width:${aPct}%;background:${acctColor(acctId)};min-width:1px" title="${esc(acctLabel(acctId, accounts))}: $${acctData.costUSD.toFixed(2)}"></div>`;
      }
    }
    html += `</div>`;
    html += `<span style="width:48px;text-align:right;color:var(--dim);flex-shrink:0">$${cost.toFixed(2)}</span>`;
    html += `</div>`;
  }
  html += '</div>';

  // 30-day total
  const total30 = recent.reduce((s, d) => s + filteredCost(d, f), 0);
  const activeDays = recent.filter(d => filteredCost(d, f) > 0).length;
  const avgPerDay = activeDays > 0 ? total30 / activeDays : 0;
  html += `<div style="display:flex;justify-content:space-between;font-size:11px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">`;
  html += `<span style="color:var(--dim)">Last ${recent.length} days: <span style="color:var(--text);font-weight:600">$${total30.toFixed(2)}</span></span>`;
  html += `<span style="color:var(--dim)">avg $${avgPerDay.toFixed(2)}/active day</span>`;
  html += `</div>`;

  container.innerHTML = html;

  // Re-render filter bar properly (with event handler)
  const fp = document.getElementById('cp-right');
  if (fp) {
    let existing = document.getElementById('cp-filter-bar');
    if (existing) existing.remove();
    if (accounts.length > 0) renderFilterBar(fp, accounts);
  }
}

// ── Monthly summary ───────────────────────────────────────────────────
function renderMonthlySummary(monthlyResp) {
  let container = document.getElementById('cp-monthly');
  if (!container) {
    const fp = document.getElementById('cp-right');
    if (!fp) return;
    container = document.createElement('div');
    container.id = 'cp-monthly';
    container.className = 'cost-card';
    fp.appendChild(container);
  }

  const allMonths = monthlyResp.monthly || [];
  // INVARIANT: early-return must clear innerHTML — see docs/decisions/0004-skeleton-lifecycle.md
  if (!allMonths.length) { container.innerHTML = ''; return; }
  const accounts = collectAccounts(_costPageCache?.dailyData || []);

  const years = [...new Set(allMonths.map(m => m.month.slice(0, 4)))].sort();
  if (!window._costYearFilter || !years.includes(window._costYearFilter)) window._costYearFilter = years[years.length - 1];
  const months = allMonths.filter(m => m.month.startsWith(window._costYearFilter));

  let html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
  html += '<div class="cost-card-label" style="margin-bottom:0">Monthly</div>';
  if (years.length > 1) {
    html += '<select id="cp-year-filter" style="font-size:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:1px 4px;cursor:pointer">';
    for (const y of years) html += `<option value="${y}"${y === window._costYearFilter ? ' selected' : ''}>${y}</option>`;
    html += '</select>';
  } else {
    html += `<span style="font-size:10px;color:var(--dim)">${esc(years[0])}</span>`;
  }
  html += '</div>';
  html += '<div style="display:flex;flex-direction:column;gap:4px">';

  const f = _costActiveFilter;
  const maxCost = Math.max(...months.map(m => filteredCost(m, f)), 0.01);

  for (const m of months) {
    const cost = filteredCost(m, f);
    const pct = Math.min(100, (cost / maxCost) * 100);
    html += `<div style="display:flex;align-items:center;gap:8px;font-size:11px">`;
    html += `<span style="width:36px;text-align:right;color:var(--text);flex-shrink:0">${m.month.slice(5)}</span>`;
    html += `<div style="flex:1;height:14px;background:var(--border);border-radius:3px;overflow:hidden;display:flex">`;

    if (f || !m.byAccount || !Object.keys(m.byAccount).length) {
      const color = f ? acctColor(f.endsWith(':*') ? f.slice(0,-2)+'-x' : f) : 'var(--accent)';
      html += `<div style="height:100%;width:${pct}%;background:${color};border-radius:3px;min-width:${cost > 0 ? 2 : 0}px"></div>`;
    } else {
      const sorted = Object.entries(m.byAccount).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [acctId, acctData] of sorted) {
        const aPct = Math.max(0, (acctData.costUSD / maxCost) * 100);
        if (aPct <= 0) continue;
        html += `<div style="height:100%;width:${aPct}%;background:${acctColor(acctId)};min-width:1px" title="${esc(acctLabel(acctId, accounts))}: $${acctData.costUSD.toFixed(2)}"></div>`;
      }
    }
    html += `</div>`;
    html += `<span style="width:56px;text-align:right;color:var(--dim);flex-shrink:0">$${cost.toFixed(2)}</span>`;
    html += `</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
  const yearSel = document.getElementById('cp-year-filter');
  if (yearSel) yearSel.onchange = () => { window._costYearFilter = yearSel.value; renderMonthlySummary(monthlyResp); };
}
