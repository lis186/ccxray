// ── System Prompt Changelog ─────────────────────────────────────────────
let spAllVersions = [];   // all versions from API (unfiltered)
let spAgents = [];        // sorted agent list [{key, label, count, latestDate}]
let spSelectedAgent = ''; // currently selected agent key
let spVersions = [];      // filtered versions for selected agent
let spSelectedIdx = 0;    // index into spVersions
let spMode = 'content';   // 'content' or 'diff'
let spFocusedCol = 'agents'; // 'agents' | 'versions'
let spPendingDeepLink = null; // {agent, hash} set by other views before switchTab('sysprompt') — survives the URL rewrite in syncUrlFromState
let hideMinorEdit = false;
let currentHunkIdx = 0;

const AGENT_ORDER = ['orchestrator', 'general-purpose', 'default', 'explorer', 'worker', 'plan', 'explore', 'web-search', 'codex-rescue', 'claude-code-guide', 'summarizer', 'title-generator', 'name-generator', 'translator', 'sdk-agent'];

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

// Grok (OPENAI_WIRE_CLIENTS) reuses wire provider=openai; product label is already "Grok"/"Grok Title".
// Display-only remap so the agent list does not put Grok under the Codex group. No server change.
function spDisplayProvider(provider, label) {
  if ((provider || 'anthropic') === 'openai' && /^Grok\b/i.test(label || '')) return 'grok';
  return provider || 'anthropic';
}

function buildAgentList(allVersions, apiAgents) {
  const agentMap = {};
  for (const v of allVersions) {
    const k = v.agentKey;
    if (!agentMap[k]) agentMap[k] = { key: k, label: v.agentLabel || k, count: 0, latestCoreHash: '', uniqueHashes: new Set(), provider: spDisplayProvider(v.provider, v.agentLabel) };
    agentMap[k].count++;
    if (v.coreHash) agentMap[k].uniqueHashes.add(v.coreHash);
    if (!agentMap[k].latestCoreHash) agentMap[k].latestCoreHash = v.coreHash || '';
  }
  for (const a of (apiAgents || [])) {
    if (!agentMap[a.key]) agentMap[a.key] = { key: a.key, label: a.label, count: 0, latestCoreHash: '', uniqueHashes: new Set(), provider: spDisplayProvider(a.provider, a.label) };
    else if (a.provider) agentMap[a.key].provider = spDisplayProvider(a.provider, a.label || agentMap[a.key].label);
  }
  const agents = Object.values(agentMap);
  // ponytail: sort by provider group (anthropic first), then version count desc, then alpha
  const providerOrder = { anthropic: 0, openai: 1, grok: 2 };
  agents.sort((a, b) => {
    const pa = providerOrder[a.provider] ?? 3, pb = providerOrder[b.provider] ?? 3;
    if (pa !== pb) return pa - pb;
    if (b.count !== a.count) return b.count - a.count;
    return a.key.localeCompare(b.key);
  });
  return agents;
}

function renderAgentList() {
  const container = document.getElementById('sp-agent-list');
  if (!container) return;
  let html = '<div class="sp-version-list-title">Agents</div>';
  const providerLabels = { anthropic: 'Claude Code', openai: 'Codex', grok: 'Grok' };
  const providerDots = {
    anthropic: '<span class="provider-dot provider-anthropic">●</span>',
    openai: '<span class="provider-dot provider-openai">◆</span>',
    grok: '<span class="provider-dot provider-grok">◆</span>',
  };
  let lastProvider = null;
  for (const a of spAgents) {
    const p = a.provider || 'anthropic';
    if (p !== lastProvider) {
      const groupLabel = providerLabels[p] || 'Other';
      html += '<div class="agent-group-header">── ' + escapeHtml(groupLabel) + ' ──</div>';
      lastProvider = p;
    }
    const isActive = a.key === spSelectedAgent;
    html += '<div class="sp-agent-item' + (isActive ? ' active' : '') + '" onclick="selectAgent(\'' + a.key + '\')">';
    const dot = providerDots[p] || '<span class="provider-dot provider-unknown">○</span>';
    html += '<div class="sp-agent-label">' + dot + ' ' + escapeHtml(a.label) + '</div>';
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

// INVARIANT: skeleton IDs must match render function lookups — see docs/decisions/0004-skeleton-lifecycle.md
function renderSyspromptSkeletons() {
  // Agent list skeleton
  const agentList = document.getElementById('sp-agent-list');
  if (agentList) {
    let html = '<div class="sp-version-list-title">Agents</div>';
    html += '<div class="agent-group-header">── Claude Code ──</div>';
    for (let i = 0; i < 5; i++) {
      const w = [90, 70, 110, 60, 80][i];
      html += '<div class="sp-agent-item" style="pointer-events:none">' +
        '<div class="sp-agent-label"><span class="skeleton skeleton-text" style="width:' + w + 'px"></span></div>' +
        '<div class="sp-agent-meta"><span class="skeleton skeleton-text" style="width:50px;height:9px"></span></div>' +
      '</div>';
    }
    agentList.innerHTML = html;
  }

  // Version list skeleton
  const versionList = document.getElementById('sp-version-list');
  if (versionList) {
    let html = '<div class="sp-version-list-title">Versions</div>';
    for (let i = 0; i < 8; i++) {
      html += '<div class="sp-version-item" style="pointer-events:none">' +
        '<span class="skeleton skeleton-text" style="width:32px;height:11px"></span>' +
        '<span class="skeleton skeleton-text" style="width:' + (80 + (i % 3) * 20) + 'px;height:11px"></span>' +
        '<span class="skeleton skeleton-text sp-size-col" style="width:28px;height:11px"></span>' +
        '<span class="skeleton skeleton-text sp-delta-col" style="width:32px;height:11px"></span>' +
      '</div>';
    }
    versionList.innerHTML = html;
  }

  // Content area skeleton
  const panel = document.getElementById('diff-text-panel');
  if (panel) {
    let html = '<div style="padding:4px 0">';
    for (let i = 0; i < 12; i++) {
      const w = [100, 85, 95, 60, 90, 75, 100, 80, 70, 95, 55, 88][i];
      html += '<div class="skeleton skeleton-block" style="width:' + w + '%;height:12px;margin-bottom:6px"></div>';
    }
    html += '</div>';
    panel.innerHTML = html;
  }
}

function _spContentSkeleton() {
  const widths = [100, 85, 95, 60, 90, 75, 100, 80];
  let html = '<div style="padding:4px 0">';
  for (let i = 0; i < widths.length; i++) {
    html += '<div class="skeleton skeleton-block" style="width:' + widths[i] + '%;height:12px;margin-bottom:6px"></div>';
  }
  html += '</div>';
  return html;
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
  renderSyspromptSkeletons();

  const data = await fetch('/_api/sysprompt/versions').then(r => r.json());
  spAllVersions = data.versions || [];
  spAgents = buildAgentList(spAllVersions, data.agents);
  // Keep badge agent map in sync. messages.js seeds _hashAgentMap = null; typeof null
  // is "object", so a bare typeof-check still crashes here when System Prompt is
  // opened before any turn has called _seedHashAgentMap().
  if (typeof _hashAgentMap !== 'undefined') {
    if (!_hashAgentMap) _hashAgentMap = {};
    (data.versions || []).forEach(v => { if (v.coreHash) _hashAgentMap[v.coreHash] = { label: v.agentLabel || v.agentKey, key: v.agentKey }; });
  }

  // INVARIANT: no-data branch must clear skeleton content — see docs/decisions/0004-skeleton-lifecycle.md
  if (!spAgents.length) {
    const panel = document.getElementById('diff-text-panel');
    if (panel) panel.innerHTML = '<div style="color:var(--dim);font-size:11px">No versions found.</div>';
    const agentList = document.getElementById('sp-agent-list');
    if (agentList) agentList.innerHTML = '<div class="sp-version-list-title">Agents</div>';
    const versionList = document.getElementById('sp-version-list');
    if (versionList) versionList.innerHTML = '<div class="sp-version-list-title">Versions</div>';
    return;
  }

  // Deep-link: spPendingDeepLink (state handoff) beats ?agent=X&hash=Y (URL —
  // may already be rewritten by syncUrlFromState by the time the fetch resolves)
  const urlParams = new URLSearchParams(window.location.search);
  const deepAgent = (spPendingDeepLink && spPendingDeepLink.agent) || urlParams.get('agent');
  const deepHash = (spPendingDeepLink && spPendingDeepLink.hash) || urlParams.get('hash');
  spPendingDeepLink = null;

  if (deepAgent && spAgents.find(a => a.key === deepAgent)) {
    spSelectedAgent = deepAgent;
  } else if (!spSelectedAgent || !spAgents.find(a => a.key === spSelectedAgent)) {
    spSelectedAgent = spAgents[0].key;
  }
  spVersions = spAllVersions.filter(v => v.agentKey === spSelectedAgent);

  const latest = spVersions[0]?.version;
  if (latest) localStorage.setItem('sysprompt_last_seen', latest);
  if (badge) badge.style.display = 'none';

  // Deep-link to specific version by coreHash
  let deepIdx = 0;
  if (deepHash) {
    const found = spVersions.findIndex(v => v.coreHash === deepHash);
    if (found >= 0) deepIdx = found;
  }
  spSelectedIdx = deepIdx;
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
    if (v.sessionCount > 0) {
      html += `<div class="version-sessions" data-hash="${v.coreHash}" onclick="toggleVersionSessions(this, '${v.coreHash}')">${v.sessionCount} session${v.sessionCount > 1 ? 's' : ''} ▸</div>`;
    }
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
  if (panel) panel.innerHTML = _spContentSkeleton();
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
  if (panel) panel.innerHTML = _spContentSkeleton();
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

function spGoToVersions() {
  if (spFocusedCol !== 'agents') return;
  spFocusedCol = 'versions';
  renderAgentList();
  renderVersionList();
  updateStatusBar();
}

function spGoToAgents() {
  if (spFocusedCol !== 'versions') return;
  spFocusedCol = 'agents';
  renderAgentList();
  renderVersionList();
  updateStatusBar();
}

function updateStatusBar() {
  const bar = document.getElementById('sp-status-bar');
  if (!bar) return;
  const hunks = document.querySelectorAll('.diff-hunk');
  const total = hunks.length;
  const modeLabel = spMode === 'content' ? 'DIFF' : 'CONTENT';
  const sep = '<span class="cmd-sep">·</span>';
  let items;
  if (spFocusedCol === 'agents') {
    items = [
      '<span class="cmd-key"><kbd>↑↓</kbd> agent</span>',
      '<button class="cmd-key-btn" onclick="spGoToVersions()"><kbd>→</kbd> versions</button>',
      '<button class="cmd-key-btn" onclick="toggleMode()"><kbd>Space</kbd> ' + modeLabel + '</button>',
    ];
  } else {
    items = [
      '<button class="cmd-key-btn" onclick="spGoToAgents()"><kbd>←</kbd> agents</button>',
      '<span class="cmd-key"><kbd>↑↓</kbd> version</span>',
      '<button class="cmd-key-btn" onclick="toggleMode()"><kbd>Space</kbd> ' + modeLabel + '</button>',
    ];
    if (spMode === 'diff' && total > 0) {
      items.push('<button class="cmd-key-btn" onclick="nextHunk()"><kbd>j</kbd> next hunk</button>');
      items.push('<button class="cmd-key-btn" onclick="prevHunk()"><kbd>k</kbd> prev hunk</button>');
      items.push('<span class="cmd-key" style="color:var(--accent)">' + (currentHunkIdx + 1) + '/' + total + '</span>');
    }
  }
  bar.innerHTML = items.join(sep);
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

function toggleVersionSessions(el, coreHash) {
  const existing = el.nextElementSibling;
  if (existing && existing.classList.contains('session-list')) {
    existing.remove();
    el.textContent = el.textContent.replace('▾', '▸');
    return;
  }
  el.textContent = el.textContent.replace('▸', '▾');
  // Build session list from client-side allEntries
  const sessions = {};
  if (typeof allEntries !== 'undefined') {
    for (const e of allEntries) {
      if (e.coreHash === coreHash && e.sessionId) {
        if (!sessions[e.sessionId]) sessions[e.sessionId] = { count: 0, cwd: e.cwd || '', ts: e.ts || '' };
        sessions[e.sessionId].count++;
      }
    }
  }
  const entries = Object.entries(sessions);
  if (!entries.length) return;
  const listEl = document.createElement('div');
  listEl.className = 'session-list';
  for (const [sid, info] of entries) {
    const project = (info.cwd || '').split('/').pop() || '?';
    const a = document.createElement('a');
    a.textContent = '├ ' + project + ' / ' + info.ts + '  ' + info.count + ' turns';
    a.onclick = () => { if (typeof switchTab === 'function') switchTab('dashboard'); };
    listEl.appendChild(a);
  }
  el.after(listEl);
}
