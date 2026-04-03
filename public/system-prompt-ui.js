// ── System Prompt Changelog ─────────────────────────────────────────────
let spVersions = [];      // all claude-code versions from API
let spSelectedIdx = 0;    // index into spVersions
let spMode = 'content';   // 'content' or 'diff'
let hideMinorEdit = false;
let currentHunkIdx = 0;

function updateSysPromptBadge() {
  const badge = document.getElementById('sysprompt-badge');
  if (!badge) return;
  fetch('/_api/sysprompt/versions').then(r => r.json()).then(data => {
    const versions = (data.versions || []).filter(v => v.agentKey === 'claude-code');
    if (!versions.length) return;
    const latest = versions[0].version;
    const lastSeen = localStorage.getItem('sysprompt_last_seen');
    badge.style.display = lastSeen !== latest ? 'block' : 'none';
  }).catch(() => {});
}

async function openSystemPromptPanel(forceDiff) {
  // If called from outside tab system, redirect to tab
  if (typeof activeTab !== 'undefined' && activeTab !== 'sysprompt') {
    switchTab('sysprompt', forceDiff);
    return;
  }
  const badge = document.getElementById('sysprompt-badge');
  const hasBadge = forceDiff || (badge && badge.style.display !== 'none');

  document.getElementById('diff-overlay').classList.add('open');
  const panel = document.getElementById('diff-text-panel');
  if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">Loading...</div>';

  const data = await fetch('/_api/sysprompt/versions').then(r => r.json());
  spVersions = (data.versions || []).filter(v => v.agentKey === 'claude-code');

  const latest = spVersions[0]?.version;
  if (latest) localStorage.setItem('sysprompt_last_seen', latest);
  if (badge) badge.style.display = 'none';

  if (!spVersions.length) {
    if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">No versions found.</div>';
    return;
  }

  spSelectedIdx = 0;
  spMode = hasBadge ? 'diff' : 'content';
  renderVersionList();
  loadSelectedVersion();

  // Update Row 2 context
  const row2 = document.getElementById('row2-sp-version');
  if (row2 && latest) {
    row2.textContent = 'v' + latest + ' (latest)  ·  ' + spVersions.length + ' versions  ·  ' + (spMode === 'diff' ? 'DIFF' : 'CONTENT') + ' mode';
  }
}

function closeDiffPanel() {
  const body = document.querySelector('.sp-changelog-body');
  if (body) body.classList.remove('sp-mobile-detail');
  updateBackButton(false);
  switchTab('dashboard');
}

// ── Version list ────────────────────────────────────────────────────────

function renderVersionList() {
  const container = document.getElementById('sp-version-list');
  if (!container) return;
  let html = '<div class="sp-version-list-title">Versions</div>';
  for (let i = 0; i < spVersions.length; i++) {
    const v = spVersions[i];
    const size = v.coreLen ? (v.coreLen / 1000).toFixed(1) + 'k' : '';
    const next = spVersions[i + 1];
    let delta = '';
    if (v.coreLen && next?.coreLen && v.coreLen !== next.coreLen) {
      const diff = (v.coreLen - next.coreLen) / 1000;
      const sign = diff > 0 ? '+' : '';
      const color = diff > 0 ? 'var(--green)' : 'var(--red)';
      delta = `<span style="color:${color}">${sign}${diff.toFixed(1)}k</span>`;
    }
    const isActive = i === spSelectedIdx;
    let rowBg = '';
    if (v.coreLen && next?.coreLen && v.coreLen !== next.coreLen) {
      rowBg = (v.coreLen - next.coreLen) > 0 ? 'background:rgba(46,160,67,0.08)' : 'background:rgba(248,81,73,0.08)';
    }
    html += `<div class="sp-version-item${isActive ? ' active' : ''}" data-idx="${i}" onclick="selectVersion(${i})" style="${rowBg}">`;
    const date = (v.firstSeen || '').slice(5);
    html += `<span>${date}</span>`;
    html += `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.version).slice(0, 12)}</span>`;
    html += `<span class="sp-size-col" style="text-align:right">${size}</span>`;
    html += `<span class="sp-delta-col" style="min-width:38px;text-align:right">${delta}</span>`;
    html += '</div>';
  }
  container.innerHTML = html;
  // Scroll active item into view
  const activeEl = container.querySelector('.sp-version-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function isMobileLayout() {
  return window.innerWidth < 768;
}

function selectVersion(idx) {
  if (idx < 0 || idx >= spVersions.length) return;
  spSelectedIdx = idx;
  renderVersionList();
  loadSelectedVersion();
  if (isMobileLayout()) {
    const body = document.querySelector('.sp-changelog-body');
    if (body) body.classList.add('sp-mobile-detail');
    updateBackButton(true);
  }
}

function backToVersionList() {
  const body = document.querySelector('.sp-changelog-body');
  if (body) body.classList.remove('sp-mobile-detail');
  updateBackButton(false);
}

function spHandleBack() {
  if (isMobileLayout()) {
    const body = document.querySelector('.sp-changelog-body');
    if (body && body.classList.contains('sp-mobile-detail')) {
      backToVersionList();
      return;
    }
  }
  closeDiffPanel();
}

function updateBackButton(showVersions) {
  const header = document.querySelector('#diff-overlay .fp-header .fp-back');
  if (!header) return;
  header.textContent = showVersions ? '← Versions' : '←';
}

// ── Content / Diff loading ──────────────────────────────────────────────

async function loadSelectedVersion() {
  const v = spVersions[spSelectedIdx];
  if (!v) return;
  if (spMode === 'content') {
    await loadContentForVersion(v);
  } else {
    await loadDiffForVersion(v);
  }
}

async function loadContentForVersion(v) {
  const panel = document.getElementById('diff-text-panel');
  const summary = document.getElementById('diff-summary');
  if (summary) summary.textContent = v.version;
  updateModeIndicator();
  if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">Loading...</div>';
  try {
    const data = await fetch(`/_api/sysprompt/diff?a=${encodeURIComponent(v.version)}&b=${encodeURIComponent(v.version)}&agent=claude-code`).then(r => r.json());
    const block = (data.blockDiff || []).find(b => b.block === 'coreInstructions');
    if (block && block.textB) {
      panel.innerHTML = `<pre style="margin:0;font-size:11px;font-family:monospace;line-height:1.5;white-space:pre-wrap;word-break:break-word">${escapeHtml(block.textB)}</pre>`;
    } else {
      panel.innerHTML = '<div style="color:var(--dim);font-size:11px">No content available</div>';
    }
  } catch (e) {
    if (panel) panel.innerHTML = `<div style="color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
  }
  updateStatusBar();
}

async function loadDiffForVersion(v) {
  const panel = document.getElementById('diff-text-panel');
  const summary = document.getElementById('diff-summary');
  const prevIdx = spSelectedIdx + 1;
  updateModeIndicator();
  if (prevIdx >= spVersions.length) {
    if (summary) summary.textContent = v.version;
    if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">No previous version to compare</div>';
    updateStatusBar();
    return;
  }
  const prev = spVersions[prevIdx];
  if (summary) summary.textContent = `${prev.version} → ${v.version}`;
  if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">Loading...</div>';
  try {
    const data = await fetch(`/_api/sysprompt/diff?a=${encodeURIComponent(prev.version)}&b=${encodeURIComponent(v.version)}&agent=claude-code`).then(r => r.json());
    const block = (data.blockDiff || []).find(b => b.block === 'coreInstructions');
    if (!block) {
      panel.innerHTML = '<div style="color:var(--dim);font-size:11px">coreInstructions block not found.</div>';
    } else if (block.status === 'same') {
      panel.innerHTML = '<div style="color:var(--dim);font-size:11px">coreInstructions: unchanged</div>';
    } else {
      currentHunkIdx = 0;
      const hunks = parseHunks(block.blockDiff || '');
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:10px;color:var(--dim)">
          <button onclick="prevHunk()" style="background:none;border:1px solid var(--border);color:var(--dim);padding:1px 5px;cursor:pointer">▲ k</button>
          <button onclick="nextHunk()" style="background:none;border:1px solid var(--border);color:var(--dim);padding:1px 5px;cursor:pointer">▼ j</button>
          <span id="hunk-counter">${hunks.length} hunks</span>
          <button onclick="toggleMinorEdit()" id="minor-edit-btn" style="background:none;border:1px solid var(--border);color:var(--dim);padding:1px 5px;cursor:pointer">${hideMinorEdit ? 'show MINOR EDIT' : 'hide MINOR EDIT'}</button>
        </div>
        <div id="diff-content">${renderHunks(hunks)}</div>`;
    }
  } catch (e) {
    if (panel) panel.innerHTML = `<div style="color:var(--red)">Error loading diff: ${escapeHtml(e.message)}</div>`;
  }
  updateStatusBar();
}

// ── Mode indicator & Status bar ──────────────────────────────────────────

function updateModeIndicator() {
  const badge = document.getElementById('sp-mode-badge');
  if (!badge) return;
  const isContent = spMode === 'content';
  badge.textContent = isContent ? 'CONTENT' : 'DIFF';
  badge.style.background = isContent ? 'var(--accent)' : 'var(--yellow)';
  badge.style.color = '#000';
}

function updateStatusBar() {
  const bar = document.getElementById('sp-status-bar');
  if (!bar) return;
  if (spMode === 'content') {
    bar.textContent = '↑↓ navigate   Space: switch to DIFF';
  } else {
    const hunks = document.querySelectorAll('.diff-hunk');
    const total = hunks.length;
    const hunkInfo = total > 0 ? `  j/k: hunk ${currentHunkIdx + 1}/${total}` : '';
    bar.textContent = `↑↓ navigate   Space: switch to CONTENT${hunkInfo}`;
  }
}

// ── Mode toggle ─────────────────────────────────────────────────────────

function toggleMode() {
  spMode = spMode === 'content' ? 'diff' : 'content';
  loadSelectedVersion();
}

// ── Diff rendering helpers ──────────────────────────────────────────────

function parseHunks(unifiedDiff) {
  const lines = unifiedDiff.split('\n');
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (current) hunks.push(current);
      current = { header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function classifyHunk(hunk) {
  const adds = hunk.lines.filter(l => l.startsWith('+')).length;
  const dels = hunk.lines.filter(l => l.startsWith('-')).length;
  if (adds >= 5 && dels === 0) return 'NEW SECTION';
  if (adds > 0 && dels > 0 && adds > dels) return 'EXPANSION';
  if (adds > 0 && dels > 0 && dels >= adds) return 'REVISION';
  if (adds + dels <= 2) return 'MINOR EDIT';
  return 'EXPANSION';
}

function renderHunks(hunks) {
  let html = '';
  for (const h of hunks) {
    const cls = classifyHunk(h);
    const clsColor = cls === 'NEW SECTION' ? 'var(--green)' : cls === 'MINOR EDIT' ? 'var(--dim)' : 'var(--yellow)';
    if (hideMinorEdit && cls === 'MINOR EDIT') continue;
    html += `<div class="diff-hunk" data-cls="${cls}">`;
    html += `<div style="color:var(--dim);font-size:10px;margin:6px 0 2px">${escapeHtml(h.header)} <span style="color:${clsColor}">[${cls}]</span></div>`;
    html += '<pre style="margin:0;font-size:11px;font-family:monospace;line-height:1.5">';
    for (const line of h.lines) {
      const bg = line.startsWith('+') ? 'rgba(46,160,67,0.15)' : line.startsWith('-') ? 'rgba(248,81,73,0.15)' : 'transparent';
      const color = line.startsWith('+') ? 'var(--color-diff-add)' : line.startsWith('-') ? 'var(--color-diff-del)' : 'var(--dim)';
      html += `<span style="display:block;background:${bg};color:${color}">${escapeHtml(line)}</span>`;
    }
    html += '</pre></div>';
  }
  return html || '<div style="color:var(--dim);font-size:11px">No diff content</div>';
}

function toggleMinorEdit() {
  hideMinorEdit = !hideMinorEdit;
  const v = spVersions[spSelectedIdx];
  if (v && spMode === 'diff') loadDiffForVersion(v);
}

function nextHunk() {
  const hunks = document.querySelectorAll('.diff-hunk');
  if (currentHunkIdx < hunks.length - 1) currentHunkIdx++;
  hunks[currentHunkIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateStatusBar();
}
function prevHunk() {
  const hunks = document.querySelectorAll('.diff-hunk');
  if (currentHunkIdx > 0) currentHunkIdx--;
  hunks[currentHunkIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateStatusBar();
}

// ── Keyboard handler ────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('diff-overlay');
  if (!overlay || !overlay.classList.contains('open')) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (spSelectedIdx < spVersions.length - 1) selectVersion(spSelectedIdx + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (spSelectedIdx > 0) selectVersion(spSelectedIdx - 1);
  } else if (e.key === ' ') {
    e.preventDefault();
    toggleMode();
  } else if (e.key === 'j') {
    nextHunk();
  } else if (e.key === 'k') {
    prevHunk();
  }
});
