// ── Cost Budget: Client-side ──────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

let _costActiveFilter = null; // null = All
let _costPageCache = null;

function showCostPage() {
  switchTab('usage');
}
function hideCostPage() {
  switchTab('dashboard');
}

async function loadCostPage() {
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
  renderDailyHeatmap(dailyData);
  renderMonthlySummary(monthlyResp);
  renderAccounts(blockData);
}

// ── Account brand colors ──────────────────────────────────────────────
const _acctColors = {
  anthropic: '#e8956a',
  openai: '#74aa9c',
};
function acctColor(accountId) {
  if (!accountId) return 'var(--dim)';
  return accountId.startsWith('codex') ? _acctColors.openai : _acctColors.anthropic;
}
function acctLabel(accountId) {
  if (!accountId) return 'Unknown';
  const [provider, ...rest] = accountId.split('-');
  const alias = rest.join('-');
  const name = provider === 'codex' ? 'Codex' : 'Claude';
  return alias === 'default' ? name : `${name} · ${alias}`;
}

// ── Accounts card ─────────────────────────────────────────────────────
function renderAccounts(blockData) {
  const card = document.getElementById('cp-accounts');
  const el = document.getElementById('cp-accounts-content');
  if (!card || !el) return;

  const accounts = blockData.accounts || [];
  const configured = blockData.claudeStatuslineConfigured;

  if (accounts.length === 0 && configured !== false) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  let html = '';

  const brandColor = acct => acct.brandColor || 'var(--text)';
  const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  for (let idx = 0; idx < accounts.length; idx++) {
    const acct = accounts[idx];
    const nameStr = acct.label || (acct.provider === 'openai' ? 'Codex' : 'Claude');
    const freshDot = acct.fresh
      ? '<span style="color:var(--green)">●</span> live'
      : '<span style="color:var(--dim)">○</span> cached';
    const sep = idx > 0 ? 'border-top:1px solid var(--border);padding-top:12px;margin-top:4px;' : '';

    html += `<div style="${sep}">`;
    html += `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:8px">`;
    html += `<span style="font-weight:600;color:${brandColor(acct)}">${esc(nameStr)}${acct.planType ? ` <span style="font-weight:400;color:var(--dim);font-size:10px">${esc(acct.planType)}</span>` : ''}</span>`;
    html += `<span style="font-size:10px;color:var(--dim)">${freshDot}</span>`;
    html += `</div>`;

    html += `<div style="display:flex;gap:10px;margin-bottom:6px">`;
    if (acct.unlimited) {
      html += `<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px;font-size:13px;color:var(--green)">∞ Unlimited</div>`;
    } else {
      html += renderAccountCard('5-Hour', acct.fiveHour);
      if (acct.sevenDay) html += renderAccountCard('Weekly', acct.sevenDay);
    }
    html += `</div>`;

    html += `</div>`;
  }

  if (configured === false && !accounts.find(a => a.provider === 'anthropic')) {
    html += `<div style="font-size:11px;color:var(--dim);border-top:1px solid var(--border);padding-top:8px;margin-top:8px;display:flex;align-items:center;justify-content:space-between">
      <span>Track Claude rate limits</span>
      <span style="display:flex;align-items:center;gap:4px;font-size:10px"><code style="background:var(--surface);padding:1px 4px;border-radius:3px">ccxray setup-statusline</code>
      <button id="cp-copy-cmd" style="background:none;color:var(--dim);border:none;padding:0;cursor:pointer;line-height:1;display:flex" title="Copy command">${copyIcon}</button></span>
    </div>`;
  }

  el.innerHTML = html;
  // Move accounts card to end of fp-content (after daily/monthly)
  const fp = card.parentElement;
  if (fp) fp.appendChild(card);
  const copyBtn = document.getElementById('cp-copy-cmd');
  if (copyBtn) {
    const originalSvg = copyBtn.innerHTML;
    copyBtn.onclick = () => navigator.clipboard.writeText('ccxray setup-statusline').then(() => {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.innerHTML = originalSvg; }, 1500);
    });
  }
}

function renderAccountCard(label, win) {
  if (!win) return '';
  const leftPct = win.leftPct ?? (100 - win.usedPct);
  const barColor = leftPct > 30 ? 'var(--green)' : leftPct > 10 ? 'var(--yellow)' : 'var(--red)';
  const resetStr = win.resetLabel ? `Resets in ${esc(win.resetLabel)}` : '';
  return `<div style="flex:1;background:var(--surface);border-radius:6px;padding:10px 12px">
    <div style="font-size:10px;color:var(--dim);margin-bottom:4px">${label}</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:6px">${leftPct}% <span style="font-size:11px;font-weight:400;color:var(--dim)">left</span></div>
    <div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:6px">
      <div style="height:100%;width:${Math.min(leftPct,100)}%;background:${barColor};border-radius:3px"></div>
    </div>
    ${resetStr ? `<div style="font-size:10px;color:var(--dim)">${resetStr}</div>` : ''}
  </div>`;
}

// ── Filter bar ────────────────────────────────────────────────────────
function collectAccounts(dailyData) {
  const set = new Set();
  for (const d of dailyData) {
    if (d.byAccount) for (const k of Object.keys(d.byAccount)) set.add(k);
  }
  return [...set].sort();
}

function renderFilterBar(container, accounts) {
  if (!accounts.length) return;
  let html = '<div id="cp-filter-bar" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;max-width:400px">';
  html += `<button class="cp-filter-btn${_costActiveFilter === null ? ' active' : ''}" data-filter="" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:${_costActiveFilter === null ? 'var(--accent)' : 'var(--surface)'};color:${_costActiveFilter === null ? '#000' : 'var(--dim)'};cursor:pointer">All</button>`;
  for (const id of accounts) {
    const active = _costActiveFilter === id;
    const color = acctColor(id);
    html += `<button class="cp-filter-btn${active ? ' active' : ''}" data-filter="${esc(id)}" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid ${active ? color : 'var(--border)'};background:${active ? color : 'var(--surface)'};color:${active ? '#000' : color};cursor:pointer">${esc(acctLabel(id))}</button>`;
  }
  html += '</div>';
  container.insertAdjacentHTML('afterbegin', html);
  container.querySelector('#cp-filter-bar').addEventListener('click', e => {
    const btn = e.target.closest('.cp-filter-btn');
    if (!btn) return;
    _costActiveFilter = btn.dataset.filter || null;
    // ponytail: re-render from cache, don't re-fetch
    if (_costPageCache) {
      renderDailyHeatmap(_costPageCache.dailyData);
      renderMonthlySummary(_costPageCache.monthlyResp);
      renderAccounts(_costPageCache.blockData);
    } else {
      loadCostPage();
    }
  });
}

// ── Daily heatmap ─────────────────────────────────────────────────────
function renderDailyHeatmap(dailyData) {
  let container = document.getElementById('cp-daily');
  if (!container) {
    const fp = document.querySelector('#cost-page .fp-content');
    if (!fp) return;
    container = document.createElement('div');
    container.id = 'cp-daily';
    container.className = 'cost-card';
    fp.appendChild(container);
  }
  const accounts = collectAccounts(dailyData);

  // Filter to last 30 days with data (or all if filter active)
  const recent = dailyData.slice(-30);
  const maxCost = Math.max(...recent.map(d => {
    if (_costActiveFilter) return (d.byAccount?.[_costActiveFilter]?.costUSD || 0);
    return d.costUSD || 0;
  }), 0.01);

  let html = '<div class="cost-card-label">Daily Cost (last 30 days)</div>';
  html += '<div style="display:flex;flex-direction:column;gap:2px">';

  for (const day of recent) {
    const cost = _costActiveFilter
      ? (day.byAccount?.[_costActiveFilter]?.costUSD || 0)
      : (day.costUSD || 0);
    const pct = Math.min(100, (cost / maxCost) * 100);
    const weekday = new Date(day.date + 'T12:00:00').toLocaleDateString('en', { weekday: 'short' });
    const isWeekend = weekday === 'Sat' || weekday === 'Sun';

    html += `<div style="display:flex;align-items:center;gap:8px;font-size:10px;height:16px;opacity:${cost === 0 ? 0.3 : 1}">`;
    html += `<span style="width:56px;text-align:right;color:${isWeekend ? 'var(--dim)' : 'var(--text)'};flex-shrink:0">${day.date.slice(5)} ${weekday}</span>`;
    html += `<div style="flex:1;height:10px;background:var(--border);border-radius:3px;overflow:hidden;display:flex">`;

    if (_costActiveFilter || !day.byAccount || !Object.keys(day.byAccount).length) {
      const color = _costActiveFilter ? acctColor(_costActiveFilter) : 'var(--accent)';
      html += `<div style="height:100%;width:${pct}%;background:${color};border-radius:3px;min-width:${cost > 0 ? 2 : 0}px"></div>`;
    } else {
      // Stacked segments by account
      const sorted = Object.entries(day.byAccount).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [acctId, acctData] of sorted) {
        const aPct = Math.max(0, (acctData.costUSD / maxCost) * 100);
        if (aPct <= 0) continue;
        html += `<div style="height:100%;width:${aPct}%;background:${acctColor(acctId)};min-width:1px" title="${esc(acctLabel(acctId))}: $${acctData.costUSD.toFixed(2)}"></div>`;
      }
    }
    html += `</div>`;
    html += `<span style="width:48px;text-align:right;color:var(--dim);flex-shrink:0">$${cost.toFixed(2)}</span>`;
    html += `</div>`;
  }
  html += '</div>';

  // 30-day total
  const total30 = recent.reduce((s, d) => {
    return s + (_costActiveFilter ? (d.byAccount?.[_costActiveFilter]?.costUSD || 0) : (d.costUSD || 0));
  }, 0);
  const activeDays = recent.filter(d => (_costActiveFilter ? (d.byAccount?.[_costActiveFilter]?.costUSD || 0) : (d.costUSD || 0)) > 0).length;
  const avgPerDay = activeDays > 0 ? total30 / activeDays : 0;
  html += `<div style="display:flex;justify-content:space-between;font-size:11px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">`;
  html += `<span style="color:var(--dim)">30-day total: <span style="color:var(--text);font-weight:600">$${total30.toFixed(2)}</span></span>`;
  html += `<span style="color:var(--dim)">avg $${avgPerDay.toFixed(2)}/active day</span>`;
  html += `</div>`;

  container.innerHTML = html;

  // Re-render filter bar properly (with event handler)
  const fp = document.querySelector('#cost-page .fp-content');
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
    const fp = document.querySelector('#cost-page .fp-content');
    if (!fp) return;
    container = document.createElement('div');
    container.id = 'cp-monthly';
    container.className = 'cost-card';
    fp.appendChild(container);
  }

  const months = monthlyResp.monthly || [];
  if (!months.length) { container.innerHTML = ''; return; }

  let html = '<div class="cost-card-label">Monthly</div>';
  html += '<div style="display:flex;flex-direction:column;gap:4px">';

  const maxCost = Math.max(...months.map(m => {
    if (_costActiveFilter) return (m.byAccount?.[_costActiveFilter]?.costUSD || 0);
    return m.costUSD || 0;
  }), 0.01);

  for (const m of months) {
    const cost = _costActiveFilter
      ? (m.byAccount?.[_costActiveFilter]?.costUSD || 0)
      : (m.costUSD || 0);
    const pct = Math.min(100, (cost / maxCost) * 100);
    html += `<div style="display:flex;align-items:center;gap:8px;font-size:11px">`;
    html += `<span style="width:56px;text-align:right;color:var(--text);flex-shrink:0">${m.month}</span>`;
    html += `<div style="flex:1;height:14px;background:var(--border);border-radius:3px;overflow:hidden;display:flex">`;

    if (_costActiveFilter || !m.byAccount || !Object.keys(m.byAccount).length) {
      const color = _costActiveFilter ? acctColor(_costActiveFilter) : 'var(--accent)';
      html += `<div style="height:100%;width:${pct}%;background:${color};border-radius:3px;min-width:${cost > 0 ? 2 : 0}px"></div>`;
    } else {
      const sorted = Object.entries(m.byAccount).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [acctId, acctData] of sorted) {
        const aPct = Math.max(0, (acctData.costUSD / maxCost) * 100);
        if (aPct <= 0) continue;
        html += `<div style="height:100%;width:${aPct}%;background:${acctColor(acctId)};min-width:1px" title="${esc(acctLabel(acctId))}: $${acctData.costUSD.toFixed(2)}"></div>`;
      }
    }
    html += `</div>`;
    html += `<span style="width:56px;text-align:right;color:var(--dim);flex-shrink:0">$${cost.toFixed(2)}</span>`;
    html += `</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}
