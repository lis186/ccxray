// ── Cache expiration notification (Phase 5.5) ────────────────────────
// Two layers:
//   Layer 1 (passive, always on): tab-title flash when any active session
//           has cache < 60s. Zero permission, zero config.
//   Layer 2 (active, opt-in): browser Notification API; fires once per
//           cache cycle when remaining time hits `leadTimeMs`.
//           Max plan default-on (lead 5min); Pro/api-key default-off
//           (opt-in, lead 60s). User toggles via topbar 🔔 button.
//
// Both layers share a single 1s tick loop that piggybacks on the countdown
// ticker, observing `.si-cache[data-active="1"]` state.

// Layer 1 config
const TAB_TITLE_BASE = 'ccxray';
const TAB_TITLE_FLASH = '⚠ ccxray';
const LAYER1_CRITICAL_MS = 60_000;      // trigger tab flash when cache < 60s
const FLASH_MIN_INTERVAL_MS = 900;       // min ms between title toggles
let _flashPhase = 0;
let _lastTitleUpdate = 0;

// Layer 2 config
const NOTIFY_STORAGE_KEY = 'ccxray.cacheNotify';
const NOTIFICATION_AUTO_CLOSE_MS = 10_000;
const LEAD_TIME_BY_PLAN = {
  'max5x':    5 * 60 * 1000,  // 5 minutes — Max has 1h TTL, plenty of react time
  'max20x':   5 * 60 * 1000,
  'pro':          60 * 1000,  // 1 minute — Pro has 5m TTL, short fuse
  'api-key':      60 * 1000,
};
const _notifiedCycles = new Map();  // sessionId → lastReceivedAt we've already notified for

function getNotifySetting() {
  // localStorage: 'on' | 'off' | null (use default)
  const stored = localStorage.getItem(NOTIFY_STORAGE_KEY);
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  // Default by plan: Max → on, others → off
  const plan = window.ccxraySettings?.plan || 'api-key';
  return plan === 'max5x' || plan === 'max20x';
}

function setNotifySetting(value) {
  localStorage.setItem(NOTIFY_STORAGE_KEY, value ? 'on' : 'off');
  renderNotifyButton();
}

function getLeadTimeMs() {
  const plan = window.ccxraySettings?.plan || 'api-key';
  return LEAD_TIME_BY_PLAN[plan] || 60 * 1000;
}

// Main tick — called every second from countdown-ticker (or self-scheduled)
function tickNotifications() {
  const activeCards = document.querySelectorAll('.si-cache[data-active="1"]');
  const now = Date.now();

  // Layer 1: find any card with < 60s remaining → flash tab title
  let anyCritical = false;
  for (const el of activeCards) {
    const lastAt = Number(el.dataset.lastAt);
    const ttlMs = Number(el.dataset.cacheTtlMs);
    if (!Number.isFinite(lastAt) || !Number.isFinite(ttlMs)) continue;
    const remaining = lastAt + ttlMs - now;
    if (remaining > 0 && remaining < LAYER1_CRITICAL_MS) anyCritical = true;
  }
  updateTabTitle(anyCritical);

  // Layer 2: fire browser notification if enabled + permission + lead time hit
  if (!getNotifySetting()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const leadMs = getLeadTimeMs();
  for (const el of activeCards) {
    const lastAt = Number(el.dataset.lastAt);
    const ttlMs = Number(el.dataset.cacheTtlMs);
    if (!Number.isFinite(lastAt) || !Number.isFinite(ttlMs)) continue;
    const remaining = lastAt + ttlMs - now;
    if (remaining <= 0 || remaining > leadMs) continue;

    // Dedupe: one notification per (session, cache cycle)
    const card = el.closest('.session-item');
    const sid = card?.id?.replace(/^sess-/, '') || 'unknown';
    if (_notifiedCycles.get(sid) === lastAt) continue;
    _notifiedCycles.set(sid, lastAt);

    const minsLeft = Math.max(1, Math.round(remaining / 60000));
    fireNotification(sid, minsLeft);
  }
}

function updateTabTitle(flash) {
  const now = Date.now();
  if (!flash) {
    if (document.title !== TAB_TITLE_BASE) document.title = TAB_TITLE_BASE;
    _flashPhase = 0;
    return;
  }
  // Flash every ~1s between base and ⚠-prefixed title
  if (now - _lastTitleUpdate < FLASH_MIN_INTERVAL_MS) return;
  _lastTitleUpdate = now;
  _flashPhase = 1 - _flashPhase;
  document.title = _flashPhase ? TAB_TITLE_FLASH : TAB_TITLE_BASE;
}

function fireNotification(sid, minsLeft) {
  const plan = window.ccxraySettings?.label || 'plan';
  try {
    const n = new Notification('ccxray · cache expiring', {
      body: `Session ${sid.slice(0, 8)} · ${plan} · ~${minsLeft} min left\nSend a prompt to refresh, or let it expire.`,
      tag: 'ccxray-cache-' + sid,
      silent: false,
    });
    setTimeout(() => { try { n.close(); } catch {} }, NOTIFICATION_AUTO_CLOSE_MS);
    // Click → focus this window
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
    // Browser may reject notification creation; silently degrade to Layer 1 only
  }
}

// ── Layer 2 opt-in UI ──
function renderNotifyButton() {
  const el = document.getElementById('qt-notify');
  if (!el) return;
  const enabled = getNotifySetting();
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const denied = permission === 'denied';
  const plan = window.ccxraySettings?.label || 'plan';

  el.textContent = enabled ? '🔔' : '🔕';
  el.className = 'qt-notify' + (enabled ? ' enabled' : '') + (denied ? ' denied' : '');
  el.title = denied
    ? 'Browser denied notifications — allow in site settings'
    : enabled
      ? `Cache expiration alerts on (${plan} default)`
      : `Cache expiration alerts off — click to enable`;
  el.style.display = 'inline';
}

async function toggleNotify() {
  if (typeof Notification === 'undefined') return;
  const current = getNotifySetting();
  if (current) {
    setNotifySetting(false);
    return;
  }
  // Enabling → request permission if not yet granted
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      setNotifySetting(false);
      renderNotifyButton();
      return;
    }
  }
  if (Notification.permission !== 'granted') {
    renderNotifyButton();
    return;
  }
  setNotifySetting(true);
}
window.toggleCacheNotify = toggleNotify;

// Re-render button when settings load (plan label may determine default state/label)
document.addEventListener('ccxray:settings-loaded', () => renderNotifyButton());

// Start tick — piggyback on the same 1s cadence used by countdown-ticker
setInterval(tickNotifications, 1000);
renderNotifyButton();
