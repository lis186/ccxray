// ── Cost Budget: Client-side ──────────────────────────────────────────
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
  const z1 = document.getElementById('cp-z1-content');
  const z2 = document.getElementById('cp-z2-content');
  const z3 = document.getElementById('cp-z3-content');
  const spinner = '<div style="color:var(--dim);padding:20px;text-align:center">Loading usage data…</div>';
  z1.innerHTML = spinner;
  z2.innerHTML = spinner;
  z3.innerHTML = spinner;

  // Poll until data is ready (server returns 202 while computing)
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

  // Each zone fetches and renders independently — no Promise.all
  fetchWithRetry('/_api/costs/current-block', { active: false })
    .then(blockData => { renderZone1(blockData); updateRow2Usage(blockData, null); });

  const dailyPromise = fetchWithRetry('/_api/costs/daily', []);
  const monthlyPromise = fetchWithRetry('/_api/costs/monthly', { monthly: [], currentMonth: { costUSD: 0 } });

  // Zone 2 needs both monthly and daily data
  Promise.all([monthlyPromise, dailyPromise])
    .then(([monthlyData, dailyData]) => { renderZone2(monthlyData, dailyData); updateRow2Usage(null, monthlyData); });

  // Zone 3 only needs daily data
  dailyPromise.then(dailyData => renderZone3(dailyData));
}

function renderZone1(block) {
  const el = document.getElementById('cp-z1-content');
  if (!block.active) {
    const lb = block.lastBlock;
    if (lb) {
      const agoH = Math.floor(lb.minutesAgo / 60), agoM = lb.minutesAgo % 60;
      const agoStr = agoH > 0 ? agoH + 'h ' + agoM + 'min ago' : agoM + 'min ago';
      el.innerHTML = `
        <div style="color:var(--dim);font-size:12px;margin-bottom:6px">No active window · last ended ${agoStr}</div>
        <div style="font-size:11px;color:var(--dim)">
          ${lb.totalTokens.toLocaleString()} tokens · $${lb.costUSD} · ${lb.models.slice(0,2).map(m=>m.split('-')[1]).join('/')}
        </div>
      `;
    } else {
      el.innerHTML = '<div style="color:var(--dim);font-size:12px">No history data</div>';
    }
    return;
  }

  const pct = block.percentUsed || 0;
  const timePct = block.timePct || 0;
  const tokenColor = pct < 60 ? 'var(--green)' : pct < 85 ? 'var(--yellow)' : 'var(--red)';
  const paceRatio = timePct > 0 ? pct / timePct : 0;
  let statusDot, statusMsg, statusColor;
  if (paceRatio > 1.3) {
    statusDot = '🔴'; statusMsg = 'Burning faster than time'; statusColor = 'var(--red)';
  } else if (paceRatio > 1.1) {
    statusDot = '🟡'; statusMsg = 'Slightly fast, watch it'; statusColor = 'var(--yellow)';
  } else if (paceRatio < 0.7 && timePct > 20) {
    statusDot = '🟢'; statusMsg = 'Quota comfortable'; statusColor = 'var(--green)';
  } else {
    statusDot = '🟢'; statusMsg = 'Rate normal'; statusColor = 'var(--green)';
  }

  const minRemaining = block.minutesRemaining || 0;
  const remainH = Math.floor(minRemaining / 60), remainM = minRemaining % 60;
  const remainStr = remainH > 0 ? remainH + 'h ' + remainM + 'm' : remainM + 'm';
  const br = block.burnRate;
  const proj = block.projection;

  el.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:${statusColor};margin-bottom:10px">${statusDot} ${statusMsg}</div>
    <div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-bottom:2px">
        <span>TOKENS</span><span style="color:${tokenColor}">${pct.toFixed(1)}% · ${(block.totalTokens/1000).toFixed(0)}k / ${((block.tokenLimit||220000)/1000).toFixed(0)}k${pct>100?' ⚠️':''}</span>
      </div>
      <div style="height:7px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:6px">
        <div style="height:100%;width:${Math.min(pct,100)}%;background:${tokenColor};border-radius:3px;transition:width 0.5s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-bottom:2px">
        <span>TIME</span><span>${timePct.toFixed(1)}% · ${remainStr} left</span>
      </div>
      <div style="height:7px;background:var(--border);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${Math.min(timePct,100)}%;background:var(--dim);border-radius:3px;opacity:0.5;transition:width 0.5s"></div>
      </div>
    </div>
    ${br ? `<div style="font-size:10px;color:var(--dim);border-top:1px solid var(--border);padding-top:7px;display:flex;gap:12px;flex-wrap:wrap">
      <span>${br.tokensPerMinute.toLocaleString()} tok/min</span>
      <span>$${br.costPerHour}/hr</span>
      ${proj ? `<span>proj ${(proj.totalTokens/1000).toFixed(0)}k ($${proj.totalCost})</span>` : ''}
      <span style="margin-left:auto">$${block.costUSD} equiv.</span>
    </div>` : `<div style="font-size:10px;color:var(--dim)">$${block.costUSD} equiv. API cost</div>`}
  `;
}

const PLAN_OPTIONS = [
  { label: 'Pro $20/mo', price: 20 },
  { label: 'Max 5x $100/mo', price: 100 },
  { label: 'Max 20x $200/mo', price: 200 },
];

function getSelectedPlanPrice() {
  return parseInt(localStorage.getItem('planPrice')) || 200;
}

function renderZone2(monthlyData, dailyData) {
  const el = document.getElementById('cp-z2-content');
  const currentCost = monthlyData.currentMonth?.costUSD || 0;
  const planPrice = getSelectedPlanPrice();
  const roi = (currentCost / planPrice).toFixed(1);
  const saved = (currentCost - planPrice).toFixed(0);
  const roiColor = parseFloat(roi) >= 1 ? 'var(--green)' : 'var(--yellow)';

  const optionsHtml = PLAN_OPTIONS.map(p =>
    `<option value="${p.price}"${p.price === planPrice ? ' selected' : ''}>${p.label}</option>`
  ).join('');

  // Render plan selector in card label
  const labelEl = document.getElementById('cp-z2-label');
  if (labelEl) {
    labelEl.innerHTML = `ROI &amp; Plan Fit <select onchange="localStorage.setItem('planPrice',this.value);renderZone2(window._zone2Monthly,window._zone2Daily)" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:3px;font-size:10px;padding:1px 4px;cursor:pointer">${optionsHtml}</select>`;
  }

  el.innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;color:var(--dim);margin-bottom:2px">Equiv. API cost this month (not actual spend)</div>
        <div style="font-size:20px;font-weight:700;color:${roiColor}">$${currentCost.toFixed(2)}</div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--dim);margin-bottom:2px">Monthly ROI</div>
        <div style="font-size:20px;font-weight:700;color:${roiColor}">${roi}x</div>
      </div>
      ${parseFloat(saved) > 0 ? `<div>
        <div style="font-size:10px;color:var(--dim);margin-bottom:2px">Saved</div>
        <div style="font-size:20px;font-weight:700;color:var(--green)">$${saved}</div>
      </div>` : ''}
    </div>
  `;

  // Store data for re-render on plan change
  window._zone2Monthly = monthlyData;
  window._zone2Daily = dailyData;
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


// Escape handler moved to unified fullscreen-page listener in app.js
