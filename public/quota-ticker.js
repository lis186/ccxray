// ── Topbar Quota Ticker ───────────────────────────────────────────────
let quotaTickerInterval = null;

async function updateQuotaTicker() {
  try {
    const [block, monthly] = await Promise.all([
      fetch('/_api/costs/current-block').then(r => r.json()).catch(() => ({ active: false })),
      fetch('/_api/costs/monthly').then(r => r.json()).catch(() => ({ currentMonth: { costUSD: 0 } })),
    ]);

    // Progress bar
    const barWrap = document.getElementById('qt-bar-wrap');
    const barFill = document.getElementById('qt-bar-fill');
    const barPct = document.getElementById('qt-bar-pct');
    const barTime = document.getElementById('qt-bar-time');
    if (block.active) {
      const pct = block.percentUsed || 0;
      const timePct = block.timePct || 0;
      const color = pct < 60 ? 'var(--green)' : pct < 85 ? 'var(--yellow)' : 'var(--red)';
      barFill.style.width = Math.min(pct, 100) + '%';
      barFill.style.background = color;
      const minR = block.minutesRemaining || 0;
      const timeStr = minR > 60 ? Math.floor(minR/60) + 'h' + (minR%60) + 'm' : minR + 'min';
      // Show pace warning if token% significantly exceeds time%
      const paceRatio = timePct > 0 ? pct / timePct : 0;
      const paceWarn = paceRatio > 1.3 ? ' ⚡' : '';
      barPct.textContent = pct.toFixed(1) + '%' + paceWarn;
      barTime.textContent = timeStr + ' left';
      barWrap.style.display = 'flex';
    } else {
      barWrap.style.display = 'none';
    }

    // ROI badge — divisor from plan config (was hardcoded 200 = Max 20x)
    const roiEl = document.getElementById('qt-roi');
    const currentCost = monthly.currentMonth?.costUSD || 0;
    const settings = window.ccxraySettings || {};
    const monthlyUSD = settings.monthlyUSD || 0;
    if (monthlyUSD > 0) {
      const roi = (currentCost / monthlyUSD).toFixed(1);
      roiEl.textContent = 'ROI ' + roi + 'x';
      roiEl.title = `Return on investment: $${currentCost.toFixed(2)} / $${monthlyUSD} plan price (${settings.label || 'plan'})`;
      roiEl.style.display = 'inline';
    } else {
      // api-key users: no subscription divisor → hide badge
      roiEl.style.display = 'none';
    }

    // Recommendation chip
    const chipEl = document.getElementById('qt-chip');
    if (block.active && block.burnRate) {
      const br = block.burnRate.tokensPerMinute || 0;
      // Capacity from plan's 5h tokens budget; fall back to legacy constant when settings absent
      const tokens5h = settings.tokens5h || 220000;
      const capacity = tokens5h / 300; // tokens per min at full speed
      const ratio = br / capacity;
      if (ratio < 0.3) {
        chipEl.textContent = '💡 Can parallelize';
        chipEl.style.display = 'inline';
      } else if (block.projection && block.projection.totalTokens > tokens5h * 0.9) {
        chipEl.textContent = '⚠️ Slow down';
        chipEl.style.display = 'inline';
      } else {
        chipEl.style.display = 'none';
      }
    } else {
      chipEl.style.display = 'none';
    }
  } catch (e) {
    // silent fail — ticker is ambient, not critical
  }
}

function startQuotaTicker() {
  updateQuotaTicker();
  quotaTickerInterval = setInterval(updateQuotaTicker, 30000);
}
