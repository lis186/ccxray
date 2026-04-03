// ── Global Config ────────────────────────────────────────────────────
const DEFAULT_MAX_CTX = window.__PROXY_CONFIG__?.DEFAULT_CONTEXT || 200000;

// ── Active Tab State ─────────────────────────────────────────────────
let activeTab = 'dashboard';

function switchTab(tab, forceDiff) {
  if (activeTab === tab) return;
  activeTab = tab;

  // Update tab buttons
  document.querySelectorAll('.topbar-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Show/hide content areas
  document.getElementById('columns').style.display = tab === 'dashboard' ? '' : 'none';
  const costPage = document.getElementById('cost-page');
  const diffOverlay = document.getElementById('diff-overlay');
  if (tab === 'usage') {
    costPage.classList.add('open');
    diffOverlay.classList.remove('open');
    loadCostPage();
  } else {
    costPage.classList.remove('open');
  }
  if (tab === 'sysprompt') {
    diffOverlay.classList.add('open');
    costPage.classList.remove('open');
    openSystemPromptPanel(forceDiff);
  } else if (tab !== 'sysprompt') {
    diffOverlay.classList.remove('open');
  }

  // Update Row 2 contextual content
  document.getElementById('row2-dashboard').style.display = tab === 'dashboard' ? '' : 'none';
  document.getElementById('row2-usage').style.display = tab === 'usage' ? '' : 'none';
  document.getElementById('row2-sysprompt').style.display = tab === 'sysprompt' ? '' : 'none';

  // Sync URL
  syncViewParam();
}

function syncViewParam() {
  // Use syncUrlFromState if available (miller-columns.js loaded), otherwise fallback
  if (typeof syncUrlFromState === 'function') {
    syncUrlFromState();
  } else {
    const params = new URLSearchParams(window.location.search);
    if (activeTab === 'dashboard') params.delete('view');
    else params.set('view', activeTab);
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }
}

// Capture view param early before deep-link resolution rewrites URL
const _savedViewParam = new URLSearchParams(window.location.search).get('view');

function restoreTabFromUrl() {
  const view = _savedViewParam;
  if (view === 'usage' || view === 'sysprompt') {
    switchTab(view);
  }
}

// ── Theme Toggle ─────────────────────────────────────────────────────
function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon();
}
function updateThemeIcon() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '🌙' : '☀️';
}
updateThemeIcon();

// ── Unified Escape + tab switching handler ──────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  // Don't intercept when miller-columns focused mode is active
  if (typeof isFocusedMode !== 'undefined' && isFocusedMode) return;

  // Escape → switch to dashboard
  if (e.key === 'Escape' && activeTab !== 'dashboard') {
    switchTab('dashboard');
    e.preventDefault();
    return;
  }

  // Tab switching: 1/2/3
  if (e.key === '1') { switchTab('dashboard'); e.preventDefault(); return; }
  if (e.key === '2') { switchTab('usage'); e.preventDefault(); return; }
  if (e.key === '3') { switchTab('sysprompt'); e.preventDefault(); return; }
});
