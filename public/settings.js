// ── ccxray settings (plan config) ─────────────────────────────────────
// Loads once on startup from /_api/settings; exposed as window.ccxraySettings
// so other modules (quota-ticker, entry-rendering, cost-budget-ui) can read
// plan-aware constants instead of hardcoded ones.

window.ccxraySettings = {
  plan: 'api-key',
  label: 'API key',
  source: 'default',
  confidence: 'insufficient',
  cacheTtlMs: 300000,
  tokens5h: 0,
  monthlyUSD: 0,
  autoCompactPct: 0.835,
  loaded: false,
};

async function loadSettings() {
  try {
    const r = await fetch('/_api/settings');
    if (!r.ok) {
      console.warn('[ccxray] /_api/settings returned', r.status);
      return;
    }
    const s = await r.json();
    Object.assign(window.ccxraySettings, s, { loaded: true });
    renderTopbarPlan();
    document.dispatchEvent(new CustomEvent('ccxray:settings-loaded', { detail: s }));
  } catch (err) {
    console.warn('[ccxray] failed to load /_api/settings', err?.message || err);
  }
}

function renderTopbarPlan() {
  const el = document.getElementById('qt-plan');
  if (!el) return;
  const s = window.ccxraySettings;
  const ttlLabel = s.cacheTtlMs >= 3_600_000 ? '1h' : `${Math.round(s.cacheTtlMs / 60000)}m`;
  const sourceBadge = s.source === 'env' ? ' (env)'
    : s.source === 'auto' ? ' (auto)'
    : s.source === 'default' && s.confidence === 'insufficient' ? ' (detecting…)'
    : '';
  el.textContent = `Plan: ${s.label} · TTL ${ttlLabel}${sourceBadge}`;
  el.title = `Plan detected via ${s.source} (confidence: ${s.confidence})`;
  el.style.display = 'inline';
}

loadSettings();
