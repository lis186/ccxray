// ── System Prompt Changelog ─────────────────────────────────────────────
let spAllVersions = [];   // all versions from API (unfiltered)
let spAgents = [];        // sorted agent list [{key, label, count, latestDate}]
let spSelectedAgent = ''; // currently selected agent key
let spVersions = [];      // filtered versions for selected agent
let spSelectedIdx = 0;    // index into spVersions
let spMode = 'content';   // 'content' or 'diff'
let spFocusedCol = 'agents'; // 'agents' | 'versions'
let hideMinorEdit = false;
let currentHunkIdx = 0;

const AGENT_ORDER = ['orchestrator', 'general-purpose', 'plan', 'explore', 'web-search', 'codex-rescue', 'claude-code-guide', 'summarizer', 'title-generator', 'name-generator', 'translator', 'sdk-agent'];

function spRelativeTime(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return dateStr;
  const diff = Date.now() - then;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function buildAgentList(allVersions, apiAgents) {
  const agentMap = {};
  for (const v of allVersions) {
    const k = v.agentKey;
    if (!agentMap[k]) agentMap[k] = { key: k, label: v.agentLabel || k, count: 0, latestCoreHash: '', uniqueHashes: new Set() };
    agentMap[k].count++;
    if (v.coreHash) agentMap[k].uniqueHashes.add(v.coreHash);
    if (!agentMap[k].latestCoreHash) agentMap[k].latestCoreHash = v.coreHash || '';
  }
  // Also include agents from API that may have 0 versions in current data
  for (const a of (apiAgents || [])) {
    if (!agentMap[a.key]) agentMap[a.key] = { key: a.key, label: a.label, count: 0, latestCoreHash: '', uniqueHashes: new Set() };
  }
  const agents = Object.values(agentMap);
  agents.sort((a, b) => {
    const ia = AGENT_ORDER.indexOf(a.key), ib = AGENT_ORDER.indexOf(b.key);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return agents;
}

function renderAgentList() {
  const container = document.getElementById('sp-agent-list');
  if (!container) return;
  let html = '<div class="sp-version-list-title">Agents</div>';
  for (const a of spAgents) {
    const isActive = a.key === spSelectedAgent;
    html += '<div class="sp-agent-item' + (isActive ? ' active' : '') + '" onclick="selectAgent(\'' + a.key + '\')">';
    html += '<div class="sp-agent-label">' + escapeHtml(a.label) + '</div>';
    const changes = a.uniqueHashes ? a.uniqueHashes.size : 0;
    const changesStr = changes > 1 ? ' · ' + changes + ' changes' : '';
    html += '<div class="sp-agent-meta">' + a.count + ' ver' + (a.count !== 1 ? 's' : '') + changesStr + '</div>';
    html += '</div>';
  }
  container.innerHTML = html;
  container.classList.toggle('focused', spFocusedCol === 'agents');
}

function selectAgent(agentKey) {
  spSelectedAgent = agentKey;
  spVersions = spAllVersions.filter(v => v.agentKey === agentKey);
  spSelectedIdx = 0;
  renderAgentList();
  renderVersionList();
  if (spVersions.length) loadSelectedVersion();
  else {
    const panel = document.getElementById('diff-text-panel');
    if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">No versions for this agent.</div>';
  }
}

function updateSysPromptBadge() {
  const badge = document.getElementById('sysprompt-badge');
  if (!badge) return;
  fetch('/_api/sysprompt/versions').then(r => r.json()).then(data => {
    const versions = data.versions || [];
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
  spAllVersions = data.versions || [];
  spAgents = buildAgentList(spAllVersions, data.agents);

  if (!spAgents.length) {
    if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">No versions found.</div>';
    return;
  }

  // Select first agent (or keep current if still valid)
  if (!spSelectedAgent || !spAgents.find(a => a.key === spSelectedAgent)) {
    spSelectedAgent = spAgents[0].key;
  }
  spVersions = spAllVersions.filter(v => v.agentKey === spSelectedAgent);

  const latest = spVersions[0]?.version;
  if (latest) localStorage.setItem('sysprompt_last_seen', latest);
  if (badge) badge.style.display = 'none';

  spSelectedIdx = 0;
  spMode = hasBadge ? 'diff' : 'content';
  spFocusedCol = 'agents';
  renderAgentList();
  renderVersionList();
  if (spVersions.length) loadSelectedVersion();

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
    if (next && v.coreLen && next.coreLen && v.coreHash !== next.coreHash) {
      const diff = (v.coreLen - next.coreLen) / 1000;
      if (Math.abs(diff) >= 0.1) {
        const sign = diff > 0 ? '+' : '';
        const color = diff > 0 ? 'var(--green)' : 'var(--red)';
        delta = `<span style="color:${color}">${sign}${diff.toFixed(1)}k</span>`;
      }
    }
    const isActive = i === spSelectedIdx;
    // Detect if coreHash changed vs the next (older) version
    const coreChanged = !next || v.coreHash !== next.coreHash;
    let rowBg = '';
    if (coreChanged && next) {
      if (v.coreLen && next.coreLen) {
        rowBg = (v.coreLen - next.coreLen) > 0 ? 'background:rgba(46,160,67,0.08)' : 'background:rgba(248,81,73,0.08)';
      }
    }
    const dimClass = (!coreChanged && !isActive) ? ' sp-version-unchanged' : '';
    html += `<div class="sp-version-item${isActive ? ' active' : ''}${dimClass}" data-idx="${i}" onclick="selectVersion(${i})" style="${rowBg}">`;
    const date = (v.firstSeen || '').slice(5) || '';
    const hashShort = (v.coreHash || '').slice(0, 5);
    const hashColor = coreChanged ? 'var(--yellow)' : 'var(--dim)';
    html += `<span>${date}</span>`;
    html += `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="font-family:monospace;font-size:10px;color:${hashColor}">${hashShort}</span> ${escapeHtml(v.version)}</span>`;
    html += `<span class="sp-size-col" style="text-align:right">${size}</span>`;
    html += `<span class="sp-delta-col" style="min-width:38px;text-align:right">${delta}</span>`;
    html += '</div>';
  }
  container.innerHTML = html;
  container.classList.toggle('focused', spFocusedCol === 'versions');
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
    const data = await fetch(`/_api/sysprompt/diff?a=${encodeURIComponent(v.coreHash)}&b=${encodeURIComponent(v.coreHash)}&agent=${encodeURIComponent(spSelectedAgent)}`).then(r => r.json());
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
    const data = await fetch(`/_api/sysprompt/diff?a=${encodeURIComponent(prev.coreHash)}&b=${encodeURIComponent(v.coreHash)}&agent=${encodeURIComponent(spSelectedAgent)}`).then(r => r.json());
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
  const modeToggle = spMode === 'content' ? 'Space: DIFF' : 'Space: CONTENT';
  const hunks = document.querySelectorAll('.diff-hunk');
  const total = hunks.length;
  const hunkInfo = spMode === 'diff' && total > 0 ? `  j/k: hunk ${currentHunkIdx + 1}/${total}` : '';
  if (spFocusedCol === 'agents') {
    bar.textContent = `↑↓ agent   →: versions   ${modeToggle}`;
  } else {
    bar.textContent = `←: agents   ↑↓ version   ${modeToggle}${hunkInfo}`;
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

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (spFocusedCol === 'versions') {
      spFocusedCol = 'agents';
      renderAgentList();
      renderVersionList();
      updateStatusBar();
    }
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (spFocusedCol === 'agents') {
      spFocusedCol = 'versions';
      renderAgentList();
      renderVersionList();
      updateStatusBar();
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (spFocusedCol === 'agents') {
      const idx = spAgents.findIndex(a => a.key === spSelectedAgent);
      if (idx < spAgents.length - 1) selectAgent(spAgents[idx + 1].key);
    } else {
      if (spSelectedIdx < spVersions.length - 1) selectVersion(spSelectedIdx + 1);
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (spFocusedCol === 'agents') {
      const idx = spAgents.findIndex(a => a.key === spSelectedAgent);
      if (idx > 0) selectAgent(spAgents[idx - 1].key);
    } else {
      if (spSelectedIdx > 0) selectVersion(spSelectedIdx - 1);
    }
  } else if (e.key === ' ') {
    e.preventDefault();
    toggleMode();
  } else if (e.key === 'j') {
    nextHunk();
  } else if (e.key === 'k') {
    prevHunk();
  }
});
