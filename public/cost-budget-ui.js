// ── Cost Budget: Client-side ──────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }


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

  fetchWithRetry('/_api/costs/current-block', { active: false })
    .then(blockData => renderAccounts(blockData));
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
