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
  visibleProviders: [],
  providerProfiles: {},
  loaded: false,
};

function getCacheMode(provider) {
  return window.ccxraySettings?.providerProfiles?.[provider]?.cache
      || window.ccxraySettings?.providerProfiles?.anthropic?.cache
      || 'ephemeral-ttl';
}

async function loadSettings() {
  try {
    const r = await fetch('/_api/settings');
    if (!r.ok) {
      console.warn('[ccxray] /_api/settings returned', r.status);
      return;
    }
    const s = await r.json();
    Object.assign(window.ccxraySettings, s, { loaded: true });
    // Propagate auto-compact threshold to CSS so every ctx bar / minimap /
    // turn card tick reads `var(--compact-threshold)` — single source of truth.
    if (Number.isFinite(s.autoCompactPct)) {
      document.documentElement.style.setProperty(
        '--compact-threshold',
        (s.autoCompactPct * 100).toFixed(2) + '%'
      );
    }
    document.dispatchEvent(new CustomEvent('ccxray:settings-loaded', { detail: s }));
  } catch (err) {
    console.warn('[ccxray] failed to load /_api/settings', err?.message || err);
  }
}

loadSettings();
