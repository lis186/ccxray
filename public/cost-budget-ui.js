// ── Cost Budget: Client-side ──────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

let _row2Block = null, _row2Monthly = null;
function updateRow2Usage(block, monthly) {
  if (block) _row2Block = block;
  if (monthly) _row2Monthly = monthly;
  const el = document.getElementById('row2-usage-summary');
  if (!el) return;
  const parts = [];
  if (_row2Block && _row2Block.active) {
    parts.push('Window: ' + (_row2Block.percentUsed || 0).toFixed(0) + '% used');
  }
  if (_row2Monthly && _row2Monthly.currentMonth) {
    parts.push('$' + (_row2Monthly.currentMonth.costUSD || 0).toFixed(2) + ' this month');
  }
  el.textContent = parts.join('  ·  ') || 'Loading…';
}

function showCostPage() {
  switchTab('usage');
}
function hideCostPage() {
  switchTab('dashboard');
}

async function loadCostPage() {
  const z3 = document.getElementById('cp-z3-content');
  const spinner = '<div style="color:var(--dim);padding:20px;text-align:center">Loading usage data…</div>';
  if (z3) z3.innerHTML = spinner;

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

  fetchWithRetry('/_api/costs/current-block', { active: false })
    .then(blockData => {
      renderAccounts(blockData);
      updateRow2Usage(blockData, null);
    });

  const dailyPromise = fetchWithRetry('/_api/costs/daily', []);
  const monthlyPromise = fetchWithRetry('/_api/costs/monthly', { monthly: [], currentMonth: { costUSD: 0 } });

  monthlyPromise.then(monthlyData => updateRow2Usage(null, monthlyData));
  dailyPromise.then(dailyData => renderZone3(dailyData));
}

let zone3Metric = 'sessions'; // 'sessions' | 'tokens'

function renderZone3(dailyData) {
  const container = document.getElementById('cp-z3-content');
  if (!dailyData || !dailyData.length) {
    container.innerHTML = '<div style="color:var(--dim);font-size:12px">No data</div>';
    return;
  }
  window._zone3Data = dailyData; // store for toggle

  // Summary totals
  const totalSessions = dailyData.reduce((s, d) => s + (d.sessionCount || 0), 0);
  const totalTokens = dailyData.reduce((s, d) => s + (d.totalTokens || 0), 0);
  const tokStr = totalTokens >= 1e9 ? (totalTokens/1e9).toFixed(1)+'B'
               : totalTokens >= 1e6 ? (totalTokens/1e6).toFixed(1)+'M'
               : totalTokens >= 1e3 ? (totalTokens/1e3).toFixed(0)+'k'
               : String(totalTokens);

  const isSessions = zone3Metric === 'sessions';
  const summaryHtml = `
    <div style="display:flex;gap:24px;margin-bottom:10px">
      <div style="cursor:pointer" onclick="zone3Metric='sessions';renderZone3(window._zone3Data)">
        <div style="font-size:15px;font-weight:700;color:${isSessions?'var(--text)':'var(--dim)'}">${totalSessions.toLocaleString()} sessions</div>
        <div style="height:2px;background:${isSessions?'var(--text)':'transparent'};border-radius:1px;margin-top:2px"></div>
      </div>
      <div style="cursor:pointer" onclick="zone3Metric='tokens';renderZone3(window._zone3Data)">
        <div style="font-size:15px;font-weight:700;color:${!isSessions?'var(--text)':'var(--dim)'}">${tokStr} tokens</div>
        <div style="height:2px;background:${!isSessions?'var(--text)':'transparent'};border-radius:1px;margin-top:2px"></div>
      </div>
      <div style="font-size:11px;color:var(--dim);align-self:flex-end;margin-bottom:3px">Last 3 months</div>
    </div>
  `;

  // Build a map of date → value
  const costByDate = {};
  for (const d of dailyData) costByDate[d.date] = isSessions ? (d.sessionCount || 0) : (d.totalTokens || 0);

  // 6 levels via p17/p33/p50/p67/p83 of non-zero days — thresholds follow current metric
  const metricValues = dailyData.map(d => isSessions ? (d.sessionCount || 0) : (d.totalTokens || 0));
  const nonZero = metricValues.filter(c => c > 0).sort((a,b)=>a-b);
  const p = (arr, pct) => arr[Math.max(0, Math.floor(arr.length * pct) - 1)] || 0;
  const [t1,t2,t3,t4,t5] = [0.17,0.33,0.50,0.67,0.83].map(q => p(nonZero, q));
  const cs = getComputedStyle(document.documentElement);
  const PALETTE = [0,1,2,3,4,5].map(i => cs.getPropertyValue('--heatmap-' + i).trim());
  const HEATMAP_EMPTY = cs.getPropertyValue('--heatmap-empty').trim();
  function cellColor(cost) {
    if (cost <= 0) return 'var(--border)';
    if (cost < t1) return PALETTE[0];
    if (cost < t2) return PALETTE[1];
    if (cost < t3) return PALETTE[2];
    if (cost < t4) return PALETTE[3];
    if (cost < t5) return PALETTE[4];
    return PALETTE[5];
  }

  // Grid aligned to Sunday (row 0 = Sun, row 6 = Sat)
  const today = new Date();
  const thisSunday = new Date(today);
  thisSunday.setDate(today.getDate() - today.getDay()); // getDay(): 0=Sun
  thisSunday.setHours(0,0,0,0);

  const WEEKS = 26; // ~6 months
  const gridStart = new Date(thisSunday);
  gridStart.setDate(thisSunday.getDate() - (WEEKS - 1) * 7);

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const CS = 11, GAP = 2, LW = 26; // cell size, gap, label width
  const cellStyle = `width:${CS}px;height:${CS}px;border-radius:3px;display:inline-block;flex-shrink:0;`;

  // Month labels: first week of each month
  const monthLabels = [];
  let lastMonth = -1;
  for (let w = 0; w < WEEKS; w++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + w * 7);
    if (d.getMonth() !== lastMonth) {
      monthLabels.push({ w, label: d.toLocaleString('en', { month: 'short' }) });
      lastMonth = d.getMonth();
    }
  }

  let html = summaryHtml + `<div style="overflow-x:auto;overflow-y:hidden">`;

  // Month header — GitHub style: label above first week of each month
  html += `<div style="position:relative;height:14px;margin-left:${LW}px;margin-bottom:3px">`;
  for (const { w, label } of monthLabels) {
    html += `<div style="position:absolute;left:${w*(CS+GAP)}px;font-size:10px;color:var(--text);opacity:0.7;white-space:nowrap">${label}</div>`;
  }
  html += '</div>';

  // Day rows: Sun(0) top → Sat(6) bottom; GitHub labels Mon/Wed/Fri only
  const SHOW_LABEL = new Set([1, 3, 5]); // Mon, Wed, Fri
  for (let dow = 0; dow < 7; dow++) {
    html += `<div style="display:flex;align-items:center;gap:${GAP}px;margin-bottom:${GAP}px">`;
    const rowLabel = SHOW_LABEL.has(dow) ? dayNames[dow] : '';
    html += `<div style="width:${LW}px;font-size:9px;color:var(--dim);text-align:right;padding-right:5px;flex-shrink:0">${rowLabel}</div>`;
    for (let w = 0; w < WEEKS; w++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + w * 7 + dow);
      const dateStr = d.toLocaleDateString('sv-SE');
      const cost = costByDate[dateStr] || 0;
      const isFuture = d > today;
      const bg = isFuture ? 'var(--border)' : (cost === 0 ? '${HEATMAP_EMPTY}' : cellColor(cost));
      const isWeekend = dow === 0 || dow === 6;
      const opacity = (isWeekend && cost === 0 && !isFuture) ? '0.4' : '1';
      const valStr = isSessions ? cost + ' sessions' : (cost >= 1000 ? (cost/1000).toFixed(1)+'k' : cost) + ' tokens';
      const title = isFuture ? dateStr : `${dateStr}  ${valStr}`;
      html += `<div style="${cellStyle}background:${bg};opacity:${opacity}" title="${title}"></div>`;
    }
    html += '</div>';
  }

  // Legend — GitHub style: Less ◻◻◻◻◻ More, right-aligned
  html += `<div style="display:flex;gap:4px;align-items:center;margin-top:8px;margin-left:${LW}px;font-size:10px;color:var(--dim);justify-content:flex-end">
    <span>Less</span>
    <div style="${cellStyle}background:${HEATMAP_EMPTY}"></div>
    ${PALETTE.map(c=>`<div style="${cellStyle}background:${c}"></div>`).join('')}
    <span>More</span>
  </div>`;
  html += '</div>';

  container.innerHTML = html;
}


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
    const planStr = acct.planType ? ` · ${acct.planType}` : '';
    const freshDot = acct.fresh
      ? '<span style="color:var(--green)">●</span> live'
      : '<span style="color:var(--dim)">○</span> cached';
    const sep = idx > 0 ? 'border-top:1px solid var(--border);padding-top:12px;margin-top:4px;' : '';

    html += `<div style="${sep}">`;
    html += `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:8px">`;
    html += `<span style="font-weight:600;color:${brandColor(acct)}">${esc(nameStr)}${esc(planStr)}</span>`;
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

// Escape handler moved to unified fullscreen-page listener in app.js
