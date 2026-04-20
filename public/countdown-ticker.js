// ── Cache TTL countdown ticker ───────────────────────────────────────
// Single app-level setInterval(1s) drives every `.si-cache[data-active="1"]`
// on session cards. Throttles DOM writes by comparing desired textContent
// before assigning.
//
// Format tiers (based on remaining seconds):
//   > 300s → "cache Nm"        .cache-far    (updates when minute rolls)
//   60-300 → "cache M:SS"      .cache-near
//   <   60 → "cache 0:SS"      .cache-close  (red + pulse)
//   expired → "cache expired"  .cache-expired (ticker stops touching it)

const TICK_MS = 1000;
let _countdownInterval = null;

function _formatCountdown(lastAt, ttlMs) {
  const remaining = lastAt + ttlMs - Date.now();
  if (remaining <= 0) {
    return { text: 'cache expired', cls: 'si-cache cache-expired', active: false };
  }
  const s = Math.ceil(remaining / 1000);
  if (s > 300) {
    const m = Math.ceil(s / 60);
    return { text: `cache ${m}m ⏱`, cls: 'si-cache cache-far', active: true };
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return { text: `cache ${m}:${String(sec).padStart(2, '0')} ⏱`, cls: 'si-cache cache-near', active: true };
  }
  return { text: `cache 0:${String(s).padStart(2, '0')} ⏱`, cls: 'si-cache cache-close', active: true };
}

function _updateAllCountdowns() {
  const els = document.querySelectorAll('.si-cache[data-active="1"]');
  for (const el of els) {
    const lastAt = Number(el.dataset.lastAt);
    const ttlMs = Number(el.dataset.cacheTtlMs);
    if (!Number.isFinite(lastAt) || !Number.isFinite(ttlMs)) continue;
    const info = _formatCountdown(lastAt, ttlMs);
    if (el.textContent !== info.text) el.textContent = info.text;
    if (el.className !== info.cls) el.className = info.cls;
    if (!info.active) el.setAttribute('data-active', '0');
  }
}

function startCountdownTicker() {
  if (_countdownInterval) return;
  _countdownInterval = setInterval(_updateAllCountdowns, TICK_MS);
}

// Exposed for renderSessionItem to use the same formatter on initial render.
window.ccxrayFormatCacheCountdown = _formatCountdown;

startCountdownTicker();
