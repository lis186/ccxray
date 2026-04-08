
const allEntries = [];
let entryCount = 0;
const sessionsMap = new Map(); // sid → { id, firstTs, firstId, count, model, totalCost, cwd }
const projectsMap = new Map(); // projectName → { name, totalCost, sessionIds, firstId, lastId }
const sessionStatusMap = new Map(); // sid → { active: bool, lastSeenAt: number|null }

// ── Toast notifications ──
function showToast(message, duration) {
  duration = duration || 5000;
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  el.onclick = function() { el.classList.add('fade-out'); setTimeout(function() { el.remove(); }, 300); };
  container.appendChild(el);
  setTimeout(function() { if (el.parentNode) { el.classList.add('fade-out'); setTimeout(function() { el.remove(); }, 300); } }, duration);
}

// ── Skill invocation counting (covers all 3 paths) ──
const SKILL_BUILTINS = new Set(['clear','resume','compact','help','status','fast','init','doctor','login','logout','config','memory','permissions']);
const CMD_MSG_RE = /<command-message>([^<]+)<\/command-message>/g;
function countSkillInvocations(messages, loadedSkills) {
  // Build known-skill set: loadedSkills ∪ Skill tool_use history
  var known = new Set(loadedSkills || []);
  for (var mi = 0; mi < (messages || []).length; mi++) {
    var blks = messages[mi].content;
    if (!Array.isArray(blks)) blks = [{ type: 'text', text: String(blks || '') }];
    for (var bi = 0; bi < blks.length; bi++) {
      if (blks[bi].type === 'tool_use' && blks[bi].name === 'Skill' && blks[bi].input?.skill)
        known.add(blks[bi].input.skill);
    }
  }
  var hasAuthoritative = (loadedSkills || []).length > 0;
  var isSkill = hasAuthoritative
    ? function(n) { return known.has(n); }
    : function(n) { return !SKILL_BUILTINS.has(n); };

  // State machine: pending CMD counts + total invocations
  var pending = {}, total = {};
  for (var mi2 = 0; mi2 < (messages || []).length; mi2++) {
    var blks2 = messages[mi2].content;
    if (!Array.isArray(blks2)) blks2 = [{ type: 'text', text: String(blks2 || '') }];
    for (var bi2 = 0; bi2 < blks2.length; bi2++) {
      var b = blks2[bi2];
      // Path A/B: user-initiated <command-message>
      if (b.type === 'text' && b.text) {
        CMD_MSG_RE.lastIndex = 0;
        var m;
        while ((m = CMD_MSG_RE.exec(b.text)) !== null) {
          if (isSkill(m[1])) pending[m[1]] = (pending[m[1]] || 0) + 1;
        }
      }
      // Path A/C: Skill tool_use
      if (b.type === 'tool_use' && b.name === 'Skill' && b.input?.skill) {
        var s = b.input.skill;
        if (pending[s] > 0) pending[s]--;  // Path A: consume pending
        total[s] = (total[s] || 0) + 1;
      }
    }
  }
  // Path B: remaining pending CMDs (user /cmd without Skill tool_use)
  for (var sk in pending) {
    if (pending[sk] > 0) total[sk] = (total[sk] || 0) + pending[sk];
  }
  return total;
}

// ── System prompt block viewer ──
const SP_BLOCK_OWNERS = {
  billingHeader: 'anthropic', coreIdentity: 'anthropic', coreInstructions: 'anthropic',
  customSkills: 'user', pluginSkills: 'user', mcpServersList: 'user', settingsJson: 'user', envAndGit: 'user',
  autoMemory: 'user', customAgents: 'user',
};

function splitB2IntoBlocks(b2) {
  const markerDefs = [
    { key: 'customSkills',   pattern: /# User'?s Current Configuration/ },
    { key: 'customAgents',   pattern: /\*\*Available custom agents/ },
    { key: 'mcpServersList', pattern: /\*\*Configured MCP servers/ },
    { key: 'pluginSkills',   pattern: /\*\*Available plugin skills/ },
    { key: 'settingsJson',   pattern: /\*\*User's settings\.json/ },
    { key: 'envAndGit',      pattern: /# Environment\n|<env>/ },
    { key: 'autoMemory',     pattern: /# auto memory\n|You have a persistent, file-based memory/ },
  ];
  var positions = [];
  for (var i = 0; i < markerDefs.length; i++) {
    var m = markerDefs[i];
    var match = m.pattern.exec(b2);
    if (match) positions.push({ key: m.key, index: match.index });
  }
  positions.sort(function(a, b) { return a.index - b.index; });
  var result = {};
  var firstPos = positions.length > 0 ? positions[0].index : b2.length;
  result['coreInstructions'] = b2.slice(0, firstPos);
  for (var j = 0; j < positions.length; j++) {
    var start = positions[j].index;
    var end = j + 1 < positions.length ? positions[j + 1].index : b2.length;
    result[positions[j].key] = b2.slice(start, end);
  }
  return result;
}

function renderSystemBlockViewer(system) {
  // Non-array system prompt → raw text fallback
  if (typeof system === 'string') {
    return '<pre style="margin:0;font-size:11px;font-family:monospace;line-height:1.5;white-space:pre-wrap;word-break:break-word">' + escapeHtml(system) + '</pre>';
  }
  if (!Array.isArray(system) || system.length < 3) {
    return '<pre style="margin:0;font-size:11px;font-family:monospace;line-height:1.5;white-space:pre-wrap;word-break:break-word">' + escapeHtml(JSON.stringify(system, null, 2)) + '</pre>';
  }

  var b2 = (system[2] && system[2].text) || '';
  var blocks = splitB2IntoBlocks(b2);
  var totalLen = b2.length;
  var html = '<div style="font-size:11px;color:var(--dim);margin-bottom:8px">System Prompt (this turn) &nbsp; <span style="color:var(--text)">' + (totalLen / 1000).toFixed(1) + 'k</span> chars</div>';

  var blockOrder = ['coreInstructions', 'customSkills', 'customAgents', 'pluginSkills', 'mcpServersList', 'settingsJson', 'envAndGit', 'autoMemory'];
  for (var i = 0; i < blockOrder.length; i++) {
    var key = blockOrder[i];
    var text = blocks[key];
    if (!text) continue;
    var owner = SP_BLOCK_OWNERS[key] || 'unknown';
    var size = (text.length / 1000).toFixed(1) + 'k';
    var ownerColor = owner === 'anthropic' ? 'var(--accent)' : 'var(--green)';
    var isOpen = key !== 'coreInstructions' && key !== 'billingHeader';
    html += '<details' + (isOpen ? ' open' : '') + ' style="margin-bottom:4px;border:1px solid var(--border);border-radius:4px">';
    html += '<summary style="padding:6px 10px;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:8px;background:var(--surface)">';
    html += '<span style="font-weight:600;color:var(--text)">' + escapeHtml(key) + '</span>';
    html += '<span style="color:var(--dim)">' + size + '</span>';
    html += '<span style="font-size:9px;padding:1px 5px;border:1px solid ' + ownerColor + ';color:' + ownerColor + ';border-radius:3px">' + owner + '</span>';
    html += '</summary>';
    html += '<pre style="margin:0;padding:8px 10px;font-size:10px;font-family:monospace;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto">' + escapeHtml(text) + '</pre>';
    html += '</details>';
  }
  return html;
}

// ── Pin storage ──
const pinnedProjects = new Set(JSON.parse(localStorage.getItem('xray-pinned-projects') || '[]'));
const pinnedSessions = new Map(); // sid → { sid, pinnedAt }
(JSON.parse(localStorage.getItem('xray-pinned-sessions') || '[]')).forEach(p => pinnedSessions.set(p.sid, p));

function savePinnedProjects() { localStorage.setItem('xray-pinned-projects', JSON.stringify([...pinnedProjects])); }
function savePinnedSessions() { localStorage.setItem('xray-pinned-sessions', JSON.stringify([...pinnedSessions.values()])); }
function togglePinProject(name) {
  if (pinnedProjects.has(name)) pinnedProjects.delete(name);
  else pinnedProjects.add(name);
  savePinnedProjects();
  renderProjectsCol();
}
function togglePinSession(sid) {
  if (pinnedSessions.has(sid)) pinnedSessions.delete(sid);
  else pinnedSessions.set(sid, { sid, pinnedAt: Date.now() });
  savePinnedSessions();
  const sessEl = document.getElementById('sess-' + sid.slice(0, 8));
  const sess = sessionsMap.get(sid);
  if (sessEl && sess) sessEl.innerHTML = renderSessionItem(sess, sid);
  applySessionFilter();
}

function expireSessionPins() {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let changed = false;
  for (const [sid, pin] of pinnedSessions) {
    const sess = sessionsMap.get(sid);
    // If session exists, check last activity; if not, use pinnedAt as fallback
    let lastActive = pin.pinnedAt;
    if (sess && sess.lastId && sess.lastId.length >= 19) {
      const ts = new Date(sess.lastId.slice(0, 10) + 'T' + sess.lastId.slice(11, 19).replace(/-/g, ':')).getTime();
      if (ts) lastActive = ts;
    }
    if (now - lastActive > SEVEN_DAYS) {
      pinnedSessions.delete(sid);
      changed = true;
    }
  }
  if (changed) savePinnedSessions();
}

// ── Project visibility filter ──
let projectFilterMode = sessionStorage.getItem('xray-project-filter') || 'active';

function setProjectFilter(mode) {
  projectFilterMode = mode;
  sessionStorage.setItem('xray-project-filter', mode);
  renderProjectsCol();
}

function isSystemProject(name) {
  return name === '(quota-check)' || name === '(unknown)';
}

// ── Session visibility filter ──
let sessionFilterMode = sessionStorage.getItem('xray-session-filter') || 'active+idle';

function setSessionFilter(mode) {
  sessionFilterMode = mode;
  sessionStorage.setItem('xray-session-filter', mode);
  applySessionFilter();
  // Update dropdown display
  const label = document.getElementById('sess-filter-label');
  if (label) label.textContent = mode === 'active' ? 'Active' : mode === 'active+idle' ? 'Active+Idle' : 'All';
}

function applySessionFilter() {
  colSessions.querySelectorAll('.session-item').forEach(el => {
    const sid = el.dataset.sessionId;
    // Pinned sessions are always visible
    if (pinnedSessions.has(sid)) { el.style.display = ''; return; }
    // Project filter still applies
    if (selectedProjectName) {
      const sess = sessionsMap.get(sid);
      const projName = getProjectName(sess ? sess.cwd : null);
      if (projName !== selectedProjectName) { el.style.display = 'none'; return; }
    }
    if (sessionFilterMode === 'all') { el.style.display = ''; return; }
    const status = getStatusClass(sid);
    if (sessionFilterMode === 'active') {
      el.style.display = status === 'sdot-stream' ? '' : 'none';
    } else { // active+idle
      el.style.display = status !== 'sdot-off' ? '' : 'none';
    }
  });
}

function getStatusClass(sid) {
  const s = sessionStatusMap.get(sid);
  if (!s) return 'sdot-off';
  if (s.active) return 'sdot-stream';
  if (s.lastSeenAt && Date.now() - s.lastSeenAt < 5 * 60 * 1000) return 'sdot-idle';
  return 'sdot-off';
}
function getProjectStatusClass(proj) {
  const classes = [...proj.sessionIds].map(getStatusClass);
  if (classes.includes('sdot-stream')) return 'sdot-stream';
  if (classes.includes('sdot-idle')) return 'sdot-idle';
  return 'sdot-off';
}
function getStatusPriority(statusClass) {
  if (statusClass === 'sdot-stream') return 0;
  if (statusClass === 'sdot-idle') return 1;
  return 2;
}
function updateTopbarStatus() {
  const streaming = [...sessionStatusMap.values()].filter(s => s.active).length;
  const idle = [...sessionStatusMap.values()].filter(s =>
    !s.active && s.lastSeenAt && Date.now() - s.lastSeenAt < 5 * 60 * 1000
  ).length;
  let txt = '';
  if (streaming) txt += '<span style="color:var(--green)">●' + streaming + ' streaming</span>  ';
  if (idle) txt += '<span style="color:var(--yellow)">◐' + idle + ' idle</span>';
  document.getElementById('topbar-status').innerHTML = txt;
}

// ── Intercept state ──
const interceptSessionIds = new Set();
let currentPending = null;    // { requestId, sessionId, body, receivedAt }
let interceptTimeoutSec = 120;
let countdownInterval = null;

// ── Follow live turn state ──
let followLiveTurn = true;
function toggleFollowLive() {
  followLiveTurn = !followLiveTurn;
  const btn = document.getElementById('scroll-toggle');
  if (btn) {
    btn.querySelector('.scroll-on').classList.toggle('active', followLiveTurn);
    btn.querySelector('.scroll-off').classList.toggle('active', !followLiveTurn);
  }
}
function scrollTurnsToBottom() {
  if (followLiveTurn) colTurns.scrollTop = colTurns.scrollHeight;
}

let selectedProjectName = null; // null = (all)
let selectedSessionId = null;
let selectedTurnIdx = -1;
let selectedSection = null;
let selectedMessageIdx = -1;
let focusedCol = 'projects'; // 'projects' | 'sessions' | 'turns' | 'sections' | 'messages'
let isFocusedMode = false;

function enterFocusedMode() {
  if (isFocusedMode) return;
  isFocusedMode = true;
  document.getElementById('columns').classList.add('focused');
  renderDetailCol();
}

function exitFocusedMode() {
  if (!isFocusedMode) return;
  isFocusedMode = false;
  document.getElementById('columns').classList.remove('focused');
  setFocus('sections');
  renderDetailCol();
}
const colProjects = document.getElementById('col-projects');
const colSessions = document.getElementById('col-sessions');
const colTurns = document.getElementById('col-turns');
const colSections = document.getElementById('col-sections');
const colDetail = document.getElementById('col-detail');

function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const tail = Math.ceil(max * 0.6);
  const head = max - tail - 1;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

function getProjectName(cwd) {
  if (!cwd) return '(unknown)';
  if (cwd.startsWith('(')) return cwd;
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function formatEntryDate(id) {
  // id format: "2026-03-08T17-47-13-000"
  if (!id || id.length < 16) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = parseInt(id.slice(5, 7)) - 1;
  const day = id.slice(8, 10);
  const hour = id.slice(11, 13);
  const min = id.slice(14, 16);
  if (month < 0 || month > 11) return '';
  return months[month] + ' ' + day + '  ' + hour + ':' + min;
}

function formatRelativeTime(id) {
  if (!id || id.length < 19) return formatEntryDate(id);
  const ts = new Date(id.slice(0, 10) + 'T' + id.slice(11, 19).replace(/-/g, ':')).getTime();
  if (!ts) return formatEntryDate(id);
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return formatEntryDate(id);
}

function formatEntryDateShort(id) {
  if (!id || id.length < 10) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = parseInt(id.slice(5, 7)) - 1;
  const day = id.slice(8, 10);
  if (month < 0 || month > 11) return '';
  return months[month] + ' ' + day;
}

function copyLaunchCmd(sid, btn) {
  const port = window.__PROXY_CONFIG__?.PORT || location.port || 5577;
  const cmd = 'ANTHROPIC_BASE_URL=http://localhost:' + port + ' claude --continue ' + sid;
  navigator.clipboard.writeText(cmd).then(() => {
    btn.textContent = '✓';
    btn.style.color = 'var(--green)';
    setTimeout(() => { btn.textContent = '⧉'; btn.style.color = ''; }, 1500);
  });
}

function copyCurrentUrl(btn) {
  navigator.clipboard.writeText(window.location.href).then(() => {
    btn.textContent = '✓';
    btn.style.color = 'var(--green)';
    setTimeout(() => { btn.textContent = '🔗'; btn.style.color = ''; }, 1500);
  });
}

function clearAll() { // kept for console use if needed
  colProjects.innerHTML = '<div class="col-title">Projects</div>';
  colSessions.innerHTML = '<div class="col-title">Sessions</div>';
  colTurns.innerHTML = '<div class="col-sticky-header"><div class="col-title" style="display:flex;align-items:center">Turns<span id="scroll-toggle" onclick="toggleFollowLive()" style="cursor:pointer;font-size:10px;margin-left:auto"><span class="scroll-on active">ON</span> <span class="scroll-off">OFF</span></span></div><div id="session-tool-bar" style="display:none"></div><div id="ctx-legend"><span><span class="ctx-legend-dot" style="background:var(--color-cache-read)"></span>cache read</span><span><span class="ctx-legend-dot" style="background:var(--color-cache-write)"></span>cache write</span><span><span class="ctx-legend-dot" style="background:var(--color-input)"></span>input</span></div><div id="session-sparkline"></div></div>';
  colSections.innerHTML = '<div class="col-empty">←</div>';
  colDetail.innerHTML = '<div class="col-empty">←</div>';
  allEntries.length = 0;
  sessionsMap.clear();
  projectsMap.clear();
  entryCount = 0;
  selectedProjectName = null;
  selectedSessionId = null;
  selectedTurnIdx = -1;
  selectedSection = null;
  selectedMessageIdx = -1;
  renderBreadcrumb();
}

function renderSessionItem(sess, sid) {
  const shortSid = sid === 'direct-api' ? 'direct API' : sid.slice(0, 8);
  const shortModel = (sess.model || '?').replace('claude-', '').replace(/-[0-9]{8}$/, '');
  const costStr = sess.totalCost > 0 ? '$' + sess.totalCost.toFixed(3) : '—';
  const dateStr = sess.lastId ? formatRelativeTime(sess.lastId) : (sess.firstId ? formatEntryDate(sess.firstId) : escapeHtml(sess.firstTs || ''));
  const totalCalls = Object.values(sess.toolCalls || {}).reduce((s, n) => s + n, 0);
  const topTools = Object.entries(sess.toolCalls || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, c]) => escapeHtml(n.replace(/^mcp__[^_]+__/, '')) + '·' + c)
    .join('  ');
  const toolRow = totalCalls > 0
    ? '<div class="si-tools">' + (topTools || totalCalls + ' calls') + '</div>'
    : '';
  const ctxPct = sess.latestMainCtxPct || 0;
  const ctxAlertHtml = ctxPct >= 90
    ? '<span class="ctx-alert ctx-alert-red">' + Math.round(ctxPct) + '%</span>'
    : ctxPct >= 80
    ? '<span class="ctx-alert ctx-alert-yellow">' + Math.round(ctxPct) + '%</span>'
    : '';
  const isOnline = getStatusClass(sid) !== 'sdot-off';
  const isArmed = interceptSessionIds.has(sid);
  const isHeld = currentPending && currentPending.sessionId === sid;
  const sdotClasses = 'sdot ' + getStatusClass(sid) + (isArmed ? ' sdot-armed' : '');
  const sdotTitle = !isOnline ? '' : isArmed ? 'Intercept armed · click to disable' : 'Click to arm intercept';
  const sdotOnclick = isOnline ? 'event.stopPropagation();toggleIntercept(&quot;' + escapeHtml(sid) + '&quot;)' : '';
  const heldHtml = isHeld ? '<span class="held-badge" onclick="event.stopPropagation();showInterceptOverlay()">HELD</span>' : '';
  const isPinned = pinnedSessions.has(sid);
  const pinBtn = '<button class="pin-btn' + (isPinned ? ' pinned' : '') + '" onclick="event.stopPropagation();togglePinSession(&quot;' + escapeHtml(sid) + '&quot;)" title="' + (isPinned ? 'Unpin' : 'Pin') + '">★</button>';
  return '<div class="si-row1">' +
    '<button class="' + sdotClasses + '"' + (sdotTitle ? ' title="' + sdotTitle + '"' : '') + (sdotOnclick ? ' onclick="' + sdotOnclick + '"' : '') + ' tabindex="-1"></button>' +
    '<span class="sid">' + escapeHtml(shortSid) + '</span>' +
    pinBtn +
    '<button class="launch-btn" onclick="event.stopPropagation();copyLaunchCmd(&quot;' + escapeHtml(sid) + '&quot;,this)" title="Copy launch cmd">&#8855;</button>' +
    heldHtml +
    '</div>' +
    '<div class="si-row2">' + escapeHtml(shortModel) + ' · ' + sess.count + 't · <span class="si-cost">' + escapeHtml(costStr) + '</span></div>' +
    toolRow +
    '<div class="si-row3"><span title="' + escapeHtml(sess.lastId ? formatEntryDate(sess.lastId) : '') + '">' + dateStr + '</span>' + ctxAlertHtml + '</div>' +
    renderPredictionRow(sid);
}

function renderProjectsCol() {
  let html = '<div class="col-title" style="display:flex;align-items:center;gap:6px">Projects' +
    '<select id="proj-filter-select" onchange="setProjectFilter(this.value)" style="background:var(--surface);color:var(--dim);border:1px solid var(--border);border-radius:3px;font-size:10px;padding:1px 4px;cursor:pointer">' +
    '<option value="active"' + (projectFilterMode === 'active' ? ' selected' : '') + '>Active</option>' +
    '<option value="all"' + (projectFilterMode === 'all' ? ' selected' : '') + '>All</option>' +
    '</select></div>';

  const sorted = [...projectsMap.values()].sort((a, b) => {
    // Sort by: pinned first, then status (streaming > idle > off), then last activity
    const pa = pinnedProjects.has(a.name) ? 0 : 1;
    const pb = pinnedProjects.has(b.name) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const sa = getStatusPriority(getProjectStatusClass(a));
    const sb = getStatusPriority(getProjectStatusClass(b));
    if (sa !== sb) return sa - sb;
    return (b.lastId || '').localeCompare(a.lastId || '');
  });
  for (const proj of sorted) {
    const isPinned = pinnedProjects.has(proj.name);
    const statusClass = getProjectStatusClass(proj);
    // Filter: in 'active' mode, hide system + inactive (unless pinned or selected)
    if (projectFilterMode === 'active') {
      const isSel = selectedProjectName === proj.name;
      if (!isPinned && !isSel && (isSystemProject(proj.name) || statusClass === 'sdot-off')) continue;
    }
    const isSel = selectedProjectName === proj.name;
    const firstDate = proj.firstId ? formatEntryDateShort(proj.firstId) : '';
    const lastDate = proj.lastId ? formatEntryDateShort(proj.lastId) : '';
    const rangeStr = firstDate === lastDate ? firstDate : firstDate + '—' + lastDate;
    const pinBtn = '<button class="pin-btn' + (isPinned ? ' pinned' : '') + '" onclick="event.stopPropagation();togglePinProject(' + JSON.stringify(proj.name).replace(/"/g, '&quot;') + ')" title="' + (isPinned ? 'Unpin' : 'Pin') + '">★</button>';
    html += '<div class="project-item' + (isSel ? ' selected' : '') + '" onclick="selectProject(' + JSON.stringify(proj.name).replace(/"/g, '&quot;') + ')">' +
      '<div class="pi-name"><span class="sdot ' + statusClass + '"></span>' + escapeHtml(truncateMiddle(proj.name, 20)) + pinBtn + '</div>' +
      '<div class="pi-meta">' + proj.sessionIds.size + ' sessions</div>' +
      '<div class="pi-meta pi-cost">$' + proj.totalCost.toFixed(3) + '</div>' +
      (rangeStr ? '<div class="pi-range">' + escapeHtml(rangeStr) + '</div>' : '') +
      '</div>';
  }
  colProjects.innerHTML = html;
}

function selectProject(name) {
  // Toggle: clicking already-selected project returns to (all)
  selectedProjectName = (name !== null && name === selectedProjectName) ? null : name;
  renderProjectsCol();
  applySessionFilter();

  // Clear downstream — Miller column rule: N+2 onwards must clear
  selectedSessionId = null;
  selectedTurnIdx = -1;
  selectedSection = null;
  selectedMessageIdx = -1;
  colTurns.querySelectorAll('.turn-item').forEach(el => { el.style.display = 'none'; });
  colSections.innerHTML = '';
  colDetail.innerHTML = '';
  renderBreadcrumb();
  setFocus('projects');
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = JSON.stringify(s, null, 2);
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmt(n) { return n != null ? n.toLocaleString() : '—'; }

// ── Miller Columns: Selection ──
let _hoverTimer = null;

function setFocus(col) {
  focusedCol = col;
  colProjects.classList.toggle('col-focused', col === 'projects');
  colSessions.classList.toggle('col-focused', col === 'sessions');
  colTurns.classList.toggle('col-focused', col === 'turns');
  colSections.classList.toggle('col-focused', col === 'sections');
}

function getVisibleTurnIndices() {
  return allEntries
    .map((e, i) => i)
    .filter(i => selectedSessionId && allEntries[i].sessionId === selectedSessionId);
}

function renderSessionToolBar(sid) {
  const bar = document.getElementById('session-tool-bar');
  if (!bar) return;
  const sess = sid ? sessionsMap.get(sid) : null;
  if (!sess || !sess.toolCalls) { bar.style.display = 'none'; return; }
  const total = Object.values(sess.toolCalls).reduce((s, n) => s + n, 0);
  if (!total) { bar.style.display = 'none'; return; }
  const sorted = Object.entries(sess.toolCalls).sort((a, b) => b[1] - a[1]);
  const chips = sorted.slice(0, 6).map(([n, c]) =>
    '<span class="tool-chip">' + escapeHtml(n.replace(/^mcp__[^_]+__/, '')) + '·' + c + '</span>'
  ).join('');
  bar.innerHTML = total + ' calls &nbsp;' + chips;
  bar.style.display = '';
}

function renderSessionSparkline(sid) {
  const el = document.getElementById('session-sparkline');
  if (!el) return;
  if (!sid) { el.style.display = 'none'; return; }

  const turns = allEntries.filter(e =>
    e.sessionId === sid &&
    !e.isSubagent &&
    e.usage && (e.usage.input_tokens || 0) > 0
  );
  if (turns.length < 1) { el.style.display = 'none'; return; }

  // Use stacked area chart for ≥ 3 turns, fallback to bar chart for < 3
  if (turns.length >= 3) {
    renderStackedAreaChart(el, turns);
  } else {
    renderBarChart(el, turns);
  }
  el.style.display = '';
}

function renderBarChart(el, turns) {
  const W = 400, H = 40, PAD = 4;
  const maxCtx = turns.reduce((m, e) => Math.max(m, e.maxContext || DEFAULT_MAX_CTX), 0) || DEFAULT_MAX_CTX;
  const barW = Math.max(2, (W - 2 * PAD) / turns.length);
  const gap = Math.min(1, barW * 0.15);

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
  const threshY = (H - PAD - (0.8 * (H - 2 * PAD))).toFixed(1);
  svg += '<line x1="' + PAD + '" y1="' + threshY + '" x2="' + (W - PAD) + '" y2="' + threshY + '" stroke="var(--dim)" stroke-width="0.5" stroke-dasharray="4 2"/>';

  turns.forEach((e, i) => {
    const ctx = e.ctxUsed || 0;
    const pct = Math.min(100, ctx / maxCtx * 100);
    const color = pct > 90 ? 'var(--red)' : pct > 80 ? 'var(--yellow)' : 'var(--accent)';
    const x = PAD + i * barW;
    const barH = pct / 100 * (H - 2 * PAD);
    const y = H - PAD - barH;
    svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (barW - gap).toFixed(1) + '" height="' + barH.toFixed(1) + '" fill="' + color + '"/>';
    if (e.isCompacted) {
      svg += '<rect x="' + x.toFixed(1) + '" y="' + PAD + '" width="' + (barW - gap).toFixed(1) + '" height="3" fill="var(--red)" opacity="0.9"/>';
    }
  });
  svg += '</svg>';
  el.innerHTML = svg;
}

function predictRemainingTurns(sid) {
  const turns = allEntries.filter(e =>
    e.sessionId === sid && !e.isSubagent &&
    e.usage && (e.usage.input_tokens || 0) > 0 &&
    e.tokens && e.tokens.messages > 0
  );
  if (turns.length < 3) return null;

  // Find last compaction and only use turns after it
  let startIdx = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].isCompacted) { startIdx = i; break; }
  }
  const recent = turns.slice(startIdx);
  if (recent.length < 2) return null;

  // Take last 5 turns, compute message token increments
  const window = recent.slice(-5);
  const deltas = [];
  for (let i = 1; i < window.length; i++) {
    deltas.push((window[i].tokens.messages || 0) - (window[i - 1].tokens.messages || 0));
  }
  if (!deltas.length) return null;
  const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  if (avgDelta <= 0) return null;

  const last = recent[recent.length - 1];
  const maxCtx = last.maxContext || DEFAULT_MAX_CTX;
  const currentTotal = (last.tokens.system || 0) + (last.tokens.tools || 0) + (last.tokens.messages || 0);
  const remaining = maxCtx - currentTotal;
  if (remaining <= 0) return 0;

  return Math.round(remaining / avgDelta);
}

function computeSessionScorecard(sid) {
  const turns = allEntries.filter(e =>
    e.sessionId === sid && !e.isSubagent && e.usage && (e.usage.input_tokens || 0) > 0
  );
  if (turns.length < 2) return null;

  // Cache hit rate
  let totalCacheRead = 0, totalCacheCreate = 0;
  for (const e of turns) {
    totalCacheRead += e.usage.cache_read_input_tokens || 0;
    totalCacheCreate += e.usage.cache_creation_input_tokens || 0;
  }
  const totalCache = totalCacheRead + totalCacheCreate;
  const cacheHitRate = totalCache > 0 ? (totalCacheRead / totalCache * 100) : 0;

  // Context efficiency: messages / total context (how much is "useful" conversation)
  const latest = turns[turns.length - 1];
  const tok = latest.tokens || {};
  const msgTokens = tok.messages || 0;
  const totalTok = (tok.system || 0) + (tok.tools || 0) + msgTokens;
  const contextEfficiency = totalTok > 0 ? (msgTokens / totalTok * 100) : 0;

  // Compression count
  const compressionCount = turns.filter(e => e.isCompacted).length;

  // Tool utilization
  const usedTools = new Set();
  let availableTools = 0;
  for (const e of turns) {
    for (const name of Object.keys(e.toolCalls || {})) usedTools.add(name);
    if (e.toolCount) availableTools = Math.max(availableTools, e.toolCount);
  }
  const toolUtilization = availableTools > 0 ? (usedTools.size / availableTools * 100) : 0;

  return { cacheHitRate, contextEfficiency, compressionCount, toolUtilization, turnCount: turns.length };
}

function renderPredictionRow(sid) {
  const remaining = predictRemainingTurns(sid);
  if (remaining === null) return '';
  const color = remaining <= 3 ? 'var(--red)' : remaining <= 8 ? 'var(--yellow)' : 'var(--dim)';
  return '<div style="font-size:10px;color:' + color + ';margin-top:2px">≈' + remaining + ' turns left</div>';
}

// ── Scorecard hover card ──
let scorecardTimer = null;
let scorecardEl = null;

function initScorecardHover() {
  colSessions.addEventListener('mouseenter', function(ev) {
    const sessItem = ev.target.closest('.session-item');
    if (!sessItem) return;
    clearTimeout(scorecardTimer);
    scorecardTimer = setTimeout(() => showScorecard(sessItem), 300);
  }, true);
  colSessions.addEventListener('mouseleave', function(ev) {
    const sessItem = ev.target.closest('.session-item');
    if (!sessItem) return;
    clearTimeout(scorecardTimer);
    hideScorecard();
  }, true);
}

function showScorecard(sessItem) {
  const sid = sessItem.dataset.sessionId;
  if (!sid) return;
  const sc = computeSessionScorecard(sid);
  if (!sc) return;

  hideScorecard();
  const el = document.createElement('div');
  el.className = 'scorecard-tooltip';

  function bar(pct, color) {
    return '<div class="sc-bar"><div class="sc-bar-fill" style="width:' + Math.min(100, pct).toFixed(0) + '%;background:' + color + '"></div></div>';
  }
  function row(label, value, pct, color) {
    return '<div class="sc-row"><span class="sc-label">' + label + '</span><span class="sc-value" style="color:' + color + '">' + value + '</span></div>' + bar(pct, color);
  }

  const chColor = sc.cacheHitRate >= 80 ? 'var(--green)' : sc.cacheHitRate >= 50 ? 'var(--yellow)' : 'var(--red)';
  const ceColor = sc.contextEfficiency >= 50 ? 'var(--accent)' : 'var(--yellow)';
  const tuColor = sc.toolUtilization >= 30 ? 'var(--green)' : 'var(--yellow)';
  const ccColor = sc.compressionCount === 0 ? 'var(--green)' : 'var(--yellow)';

  el.innerHTML = '<div style="font-weight:bold;margin-bottom:6px;font-size:11px">Session Scorecard</div>' +
    row('Context Efficiency', sc.contextEfficiency.toFixed(0) + '%', sc.contextEfficiency, ceColor) +
    row('Cache Hit Rate', sc.cacheHitRate.toFixed(0) + '%', sc.cacheHitRate, chColor) +
    '<div class="sc-row"><span class="sc-label">Compressions</span><span class="sc-value" style="color:' + ccColor + '">' + sc.compressionCount + '</span></div>' +
    row('Tool Utilization', sc.toolUtilization.toFixed(0) + '%', sc.toolUtilization, tuColor) +
    '<div style="margin-top:4px;color:var(--dim)">' + sc.turnCount + ' turns</div>';

  sessItem.style.position = 'relative';
  sessItem.appendChild(el);
  scorecardEl = el;
}

function hideScorecard() {
  if (scorecardEl) {
    scorecardEl.remove();
    scorecardEl = null;
  }
}

// Initialize scorecard hover when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScorecardHover);
} else {
  initScorecardHover();
}

function renderStackedAreaChart(el, turns) {
  const W = 400, H = 56, PAD = 4;
  const maxCtx = turns.reduce((m, e) => Math.max(m, e.maxContext || DEFAULT_MAX_CTX), 0) || DEFAULT_MAX_CTX;
  const drawW = W - 2 * PAD;
  const drawH = H - 2 * PAD;
  const n = turns.length;

  // Extract stacked values per turn: [system, tools, messages]
  const layers = [
    { key: 'system',   color: 'var(--color-system-deep)', label: 'System' },
    { key: 'tools',    color: 'var(--color-tools)', label: 'Tools' },
    { key: 'messages', color: 'var(--color-messages)', label: 'Messages' },
  ];

  // Build cumulative Y values for each turn
  const stacks = turns.map(e => {
    const tok = e.tokens || {};
    return [tok.system || 0, tok.tools || 0, tok.messages || 0];
  });

  function yPos(val) {
    return H - PAD - Math.min(1, val / maxCtx) * drawH;
  }
  function xPos(i) {
    return PAD + (i / (n - 1)) * drawW;
  }

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="cursor:crosshair">';

  // 80% threshold dashed line
  const threshY = yPos(maxCtx * 0.8).toFixed(1);
  svg += '<line x1="' + PAD + '" y1="' + threshY + '" x2="' + (W - PAD) + '" y2="' + threshY + '" stroke="var(--dim)" stroke-width="0.5" stroke-dasharray="4 2"/>';

  // Draw stacked areas (bottom to top: system, tools, messages)
  for (let layerIdx = layers.length - 1; layerIdx >= 0; layerIdx--) {
    // Cumulative top for this layer = sum of layers 0..layerIdx
    const topPoints = [];
    const botPoints = [];
    for (let i = 0; i < n; i++) {
      let cumTop = 0;
      for (let j = 0; j <= layerIdx; j++) cumTop += stacks[i][j];
      let cumBot = 0;
      for (let j = 0; j < layerIdx; j++) cumBot += stacks[i][j];
      topPoints.push(xPos(i).toFixed(1) + ',' + yPos(cumTop).toFixed(1));
      botPoints.push(xPos(i).toFixed(1) + ',' + yPos(cumBot).toFixed(1));
    }
    const d = 'M' + topPoints.join(' L') + ' L' + botPoints.reverse().join(' L') + ' Z';
    svg += '<path d="' + d + '" fill="' + layers[layerIdx].color + '" opacity="0.8"/>';
  }

  // Compression markers: red vertical dashed lines
  turns.forEach((e, i) => {
    if (e.isCompacted) {
      const x = xPos(i).toFixed(1);
      svg += '<line x1="' + x + '" y1="' + PAD + '" x2="' + x + '" y2="' + (H - PAD) + '" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.9"/>';
    }
  });

  // Prediction extension line: dashed line from last turn projecting to maxContext
  if (n >= 3) {
    const lastStk = stacks[n - 1];
    const lastTotal = lastStk[0] + lastStk[1] + lastStk[2];
    const lastPct = lastTotal / maxCtx;
    if (lastPct < 0.95) {
      // Compute avg messages delta from last 5 turns
      const windowSize = Math.min(5, n);
      let sumDelta = 0, count = 0;
      for (let i = n - windowSize; i < n - 1; i++) {
        const d = stacks[i + 1][2] - stacks[i][2]; // messages delta
        if (d > 0) { sumDelta += d; count++; }
      }
      if (count > 0) {
        const avgDelta = sumDelta / count;
        const turnsToFull = (maxCtx - lastTotal) / avgDelta;
        const projX = xPos(n - 1 + turnsToFull);
        // Clamp to chart width
        const clampX = Math.min(W - PAD, projX).toFixed(1);
        svg += '<line x1="' + xPos(n - 1).toFixed(1) + '" y1="' + yPos(lastTotal).toFixed(1) + '" x2="' + clampX + '" y2="' + yPos(maxCtx).toFixed(1) + '" stroke="var(--dim)" stroke-width="1" stroke-dasharray="4 2" opacity="0.6"/>';
      }
    }
  }

  // Invisible hover rects for tooltip interaction
  const sliceW = drawW / n;
  turns.forEach((e, i) => {
    const tok = e.tokens || {};
    const sys = tok.system || 0, tools = tok.tools || 0, msgs = tok.messages || 0;
    const total = sys + tools + msgs;
    const pctS = total ? (sys / total * 100).toFixed(0) : '0';
    const pctT = total ? (tools / total * 100).toFixed(0) : '0';
    const pctM = total ? (msgs / total * 100).toFixed(0) : '0';
    const num = e.displayNum || (i + 1);
    const compactNote = e.isCompacted ? ' ⚠ compressed' : '';
    const title = '#' + num + compactNote
      + '\\nSystem: ' + (sys).toLocaleString() + ' (' + pctS + '%)'
      + '\\nTools: ' + (tools).toLocaleString() + ' (' + pctT + '%)'
      + '\\nMsgs: ' + (msgs).toLocaleString() + ' (' + pctM + '%)'
      + '\\nTotal: ' + (total).toLocaleString() + ' / ' + maxCtx.toLocaleString();
    const rx = PAD + i * sliceW;
    svg += '<rect x="' + rx.toFixed(1) + '" y="0" width="' + sliceW.toFixed(1) + '" height="' + H + '" fill="transparent"><title>' + title + '</title></rect>';
  });

  svg += '</svg>';
  el.innerHTML = svg;
}

function selectSessionAndLatestTurn(sid) {
  selectedSessionId = sid;
  colSessions.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.sessionId === sid);
  });
  colTurns.querySelectorAll('.turn-item').forEach(el => {
    el.style.display = (sid && el.dataset.sessionId === sid) ? '' : 'none';
  });
  // Auto-select latest turn in this session
  const visible = getVisibleTurnIndices();
  if (visible.length) selectTurn(visible[visible.length - 1]);
  renderSessionToolBar(sid);
  renderSessionSparkline(sid);
  renderBreadcrumb();
}

function renderBreadcrumb() {
  const segments = [];
  segments.push({ label: 'root', action: () => selectProject(null) });
  const projName = selectedProjectName || (selectedSessionId && sessionsMap.get(selectedSessionId) && getProjectName(sessionsMap.get(selectedSessionId).cwd));
  if (projName) segments.push({ label: projName, action: () => { selectProject(projName); } });
  if (selectedSessionId) segments.push({ label: 'session:' + selectedSessionId.slice(0, 8), action: () => { selectSessionAndLatestTurn(selectedSessionId); } });
  if (selectedTurnIdx >= 0) {
    const e = allEntries[selectedTurnIdx];
    const sessEl = e ? colTurns.querySelector('.turn-item[data-entry-idx="' + selectedTurnIdx + '"]') : null;
    const sessNum = sessEl ? sessEl.dataset.sessNum : (selectedTurnIdx + 1);
    const idx = selectedTurnIdx;
    segments.push({ label: '#' + sessNum, action: () => { selectTurn(idx); } });
  }
  if (selectedSection) {
    const sec = selectedSection;
    segments.push({ label: sec, action: () => { selectSection(sec); } });
  }
  if (selectedSection === 'timeline' && selectedMessageIdx >= 0)
    segments.push({ label: 'step[' + selectedMessageIdx + ']', action: null });

  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = '';
  segments.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'bc-sep';
      sep.textContent = ' › ';
      bc.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = 'bc-seg';
    span.textContent = seg.label;
    if (seg.action && i < segments.length - 1) {
      span.onclick = (e) => { e.stopPropagation(); seg.action(); };
    } else {
      span.style.cursor = 'default';
    }
    bc.appendChild(span);
  });
  syncUrlFromState();
}

function syncUrlFromState() {
  if (_loading) return; // Don't update URL during initial load
  const params = new URLSearchParams();
  // Preserve view param from tab system
  if (typeof activeTab !== 'undefined' && activeTab !== 'dashboard') params.set('view', activeTab);
  const projName = selectedProjectName || (selectedSessionId && sessionsMap.get(selectedSessionId) && getProjectName(sessionsMap.get(selectedSessionId).cwd));
  if (projName) params.set('p', projName);
  if (selectedSessionId) params.set('s', selectedSessionId.slice(0, 8));
  if (selectedTurnIdx >= 0) {
    const e = allEntries[selectedTurnIdx];
    const turnEl = e ? colTurns.querySelector('.turn-item[data-entry-idx="' + selectedTurnIdx + '"]') : null;
    const num = turnEl ? turnEl.dataset.sessNum : String(selectedTurnIdx + 1);
    params.set('t', num);
  }
  if (selectedSection) params.set('sec', selectedSection);
  if (selectedMessageIdx >= 0) params.set('msg', String(selectedMessageIdx));
  const qs = params.toString();
  const newUrl = qs ? '?' + qs : location.pathname;
  history.replaceState(null, '', newUrl);
}

function selectSession(id) {
  setFocus('sessions');
  if (id === selectedSessionId) return;
  selectedSessionId = id;
  selectedTurnIdx = -1;
  selectedSection = null;
  selectedMessageIdx = -1;

  // Highlight selected session
  colSessions.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.sessionId === id);
  });
  // Show turns for this session
  colTurns.querySelectorAll('.turn-item').forEach(el => {
    el.style.display = (id && el.dataset.sessionId === id) ? '' : 'none';
  });
  // Clear downstream — Miller column rule: N+2 onwards must clear
  colSections.innerHTML = '';
  colDetail.innerHTML = '';

  renderSessionToolBar(id);
  renderSessionSparkline(id);
  renderBreadcrumb();
}

// Coalesced render scheduler — merges multiple async render requests into one rAF
let _renderDirty = false;
let _renderCallback = null;
function scheduleRender(afterRender) {
  if (afterRender) _renderCallback = afterRender;
  if (_renderDirty) return;
  _renderDirty = true;
  requestAnimationFrame(() => {
    _renderDirty = false;
    if (selectedTurnIdx >= 0) {
      renderSectionsCol(selectedTurnIdx);
      renderDetailCol();
    }
    if (_renderCallback) { _renderCallback(); _renderCallback = null; }
  });
}

function prefetchEntry(idx) {
  const e = allEntries[idx];
  if (!e || e.reqLoaded || e._prefetching) return;
  e._prefetching = true;
  fetch('/_api/entry/' + encodeURIComponent(e.id))
    .then(r => r.json())
    .then(data => {
      if (!data) return;
      allEntries[idx].req = data.req;
      allEntries[idx].res = data.res;
      allEntries[idx].reqLoaded = true;
      if (data.receivedAt) allEntries[idx].receivedAt = data.receivedAt;
      if (selectedTurnIdx === idx) {
        scheduleRender(() => {
          // Apply deferred deep link sec/msg after lazy-load completes
          if (typeof _deferredDeepLink !== 'undefined' && _deferredDeepLink) {
            _applyDeferredDeepLink();
          }
        });
      }
    }).catch(() => { allEntries[idx]._prefetching = false; });
}

function selectTurn(idx) {
  if (idx < 0 || idx >= allEntries.length) return;
  if (typeof hideNewTurnPill === 'function') hideNewTurnPill();
  // Exit focused mode when switching turns — user is browsing, not drilling into timeline
  if (isFocusedMode) {
    isFocusedMode = false;
    document.getElementById('columns').classList.remove('focused');
  }
  selectedTurnIdx = idx;
  selectedMessageIdx = -1;
  colTurns.querySelectorAll('.turn-item').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.entryIdx) === idx);
  });
  const selEl = colTurns.querySelector('.turn-item[data-entry-idx="' + idx + '"]');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  // Auto-highlight the session this turn belongs to (read-only indicator, not a gate)
  const sid = allEntries[idx]?.sessionId;
  colSessions.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.sessionId === sid);
  });
  prefetchEntry(idx);
  if (!selectedSection) selectedSection = 'timeline';
  renderSectionsCol(idx);
  renderDetailCol();
  // Fetch tokens if needed
  const e = allEntries[idx];
  if (e && (!e.tokens || !e.tokens.total)) {
    fetch('/_api/tokens/' + encodeURIComponent(e.id))
      .then(r => r.json())
      .then(tok => {
        if (!tok) return;
        allEntries[idx].tokens = tok;
        if (selectedTurnIdx === idx) { scheduleRender(); }
      }).catch(() => {});
  }
  renderBreadcrumb();
}

function selectSection(name) {
  setFocus('sections');
  selectedSection = name;
  selectedMessageIdx = -1;
  colSections.querySelectorAll('.section-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.section === name);
  });
  renderDetailCol();
  renderBreadcrumb();
}

function renderSectionsCol(idx) {
  const e = allEntries[idx];
  if (!e) { colSections.innerHTML = '<div class="col-empty">No data</div>'; return; }
  const tok = e.tokens || {};
  const req = e.req || {};
  const usage = e.usage || {};
  const inTok = usage.input_tokens || '?';
  const outTok = usage.output_tokens || '?';
  const statusClass = e.status >= 200 && e.status < 300 ? 'status-ok' : 'status-err';
  const resEvents = Array.isArray(e.res) ? e.res : [];
  const stopReason = e.stopReason || (Array.isArray(resEvents) ? (resEvents.find(ev => ev.type === 'message_delta')?.delta?.stop_reason || '') : '');
  const turnCost = e.cost;
  const shortModel = (e.model || '?').replace('claude-', '').replace(/-[0-9]{8}$/, '');
  const isSubagent = e.isSubagent || false;
  const displayNum = e.displayNum || String(idx + 1);
  const subBadge = isSubagent
    ? ' <span style="font-size:10px;background:var(--orange);color:#000;border-radius:3px;padding:0 4px;margin-left:4px">sub</span>'
    : '';
  const inferBadge = e.sessionInferred
    ? ' <span style="font-size:10px;border:1px dashed var(--yellow);color:var(--yellow);border-radius:3px;padding:0 4px;margin-left:4px" title="Session attributed by inference">inferred</span>'
    : '';

  let html = '<div class="col-header">';
  html += '<div class="ch-line1"><span style="color:var(--dim)">' + (isSubagent ? '' : '#') + escapeHtml(displayNum) + '</span> <span style="color:var(--purple)">' + escapeHtml(shortModel) + '</span>' + subBadge + inferBadge + '</div>';
  html += '<div class="ch-line2"><span class="' + statusClass + '">' + e.status + '</span> · 🤖 ' + (e.elapsed || '?') + 's';
  if (stopReason) html += ' · ' + escapeHtml(stopReason);
  if (e.thinkingDuration) html += ' · <span style="color:var(--purple)">🧠 ' + e.thinkingDuration.toFixed(1) + 's</span>';
  if (turnCost != null) html += ' · <span style="color:var(--yellow)">$' + turnCost.toFixed(4) + '</span>';
  html += '</div>';
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  html += '<div class="ch-line2" style="margin-top:2px">' + fmt(inTok) + ' in / ' + fmt(outTok) + ' out';
  if (cacheRead || cacheCreate) {
    html += ' <span style="color:var(--dim);font-size:10px">(';
    const parts = [];
    if (cacheRead) parts.push('cache ' + fmt(cacheRead));
    if (cacheCreate) parts.push('new ' + fmt(cacheCreate));
    html += parts.join(' · ') + ')</span>';
  }
  html += '</div>';
  html += '</div>';

  if (tok?.contextBreakdown) {
    html += renderContextBreakdownBar(tok, e.maxContext, e.usage);
  } else if (!e.reqLoaded) {
    html += '<div style="padding:4px 12px 6px;border-bottom:1px solid var(--border)"><div style="height:8px;border-radius:2px;background:var(--border);margin:4px 0 2px"></div><div style="height:12px;width:80px;border-radius:2px;background:var(--border)"></div></div>';
  }

  const coreTools = req.tools ? req.tools.filter(t => !t.name.startsWith('mcp__')) : null;
  const mcpTools  = req.tools ? req.tools.filter(t =>  t.name.startsWith('mcp__')) : null;
  const tc = allEntries[idx]?.toolCalls || {};
  const coreCalls = Object.entries(tc).filter(([n]) => !n.startsWith('mcp__')).reduce((s, [, c]) => s + c, 0);
  const mcpCalls  = Object.entries(tc).filter(([n]) =>  n.startsWith('mcp__')).reduce((s, [, c]) => s + c, 0);

  // Extract skill usage from messages (all 3 paths: user /cmd, model Skill tool, hybrid)
  const skillCalls = e.reqLoaded ? countSkillInvocations(req.messages, tok.contextBreakdown?.loadedSkills) : {};
  const skillCount = Object.keys(skillCalls).length;
  const skillTotal = Object.values(skillCalls).reduce((s, n) => s + n, 0);
  // Extract cc_version for system badge
  const ccVer = req.system && Array.isArray(req.system) && req.system[0]
    ? (req.system[0].text || '').match(/cc_version=(S+?)[; ]/)?.[1] : null;
  const sysVerBadge = ccVer
    ? `<div class="sysprompt-badge" onclick="event.stopPropagation();openSystemPromptPanel()">⚡ cc ${escapeHtml(ccVer)}</div>`
    : '';

  // Compute step stats for Timeline badge
  const previewSteps = e.reqLoaded ? getCachedSteps(req.messages, resEvents) : [];
  const stepCount = previewSteps.length;
  const stepErrorCount = previewSteps.filter(s => s.type === 'tool-group' && s.calls.some(c => c.isError)).length;

  function renderSectionItem(s) {
    const sel = selectedSection === s.name ? ' selected' : '';
    let h = '<div class="section-item' + sel + '" data-section="' + s.name + '" onclick="selectSection(&quot;' + s.name + '&quot;)">';
    const dot = s.color ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + s.color + ';margin-right:5px;flex-shrink:0"></span>' : '<span style="display:inline-block;width:7px;margin-right:5px"></span>';
    h += '<span class="si-name">' + dot + s.label + '</span>';
    if (s.badge) h += '<span class="si-badge">' + escapeHtml(s.badge) + '</span>';
    if (s.extra) h += s.extra;
    h += '<span class="si-arrow">›</span></div>';
    return h;
  }

  // Timeline — independent top-level, not in any group
  const timelineBadge = stepCount ? stepCount + ' steps' + (stepErrorCount ? ' · ' + stepErrorCount + '✗' : '') : (e.reqLoaded ? '' : '…');
  html += renderSectionItem({ name: 'timeline', label: 'Timeline', color: 'var(--color-messages)', badge: timelineBadge, extra: '' });

  // CONTEXT group (replaces REQUEST)
  html += '<div class="section-group-title">CONTEXT</div>';
  const contextSections = [
    { name: 'system',     label: 'System',     color: 'var(--color-system)', badge: tok.system ? fmt(tok.system) + ' tok' : (req.system ? '' : (e.reqLoaded ? '' : '…')), extra: sysVerBadge },
    { name: 'core-tools', label: 'Core',        color: 'var(--color-tools)', badge: coreTools ? coreTools.length + ' tools' + (coreCalls ? ' · ' + coreCalls + '×' : '') : (e.reqLoaded ? '' : '…'), extra: '' },
    { name: 'mcp-tools',  label: 'MCP',         color: 'var(--color-mcp-tools)', badge: mcpTools  ? mcpTools.length  + ' tools' + (mcpCalls  ? ' · ' + mcpCalls  + '×' : '') : (e.reqLoaded ? '' : '…'), extra: '' },
  ];
  for (const s of contextSections) { html += renderSectionItem(s); }
  // Skills section — shown when Skill tool is available or skills were invoked
  const sb = tok.contextBreakdown?.systemBreakdown;
  const loadedSkills = tok.contextBreakdown?.loadedSkills || [];
  const hasSkillTool = e.reqLoaded ? !!(req.tools?.some(t => t.name === 'Skill')) : false;
  const hasSkillsInContext = hasSkillTool
    || (sb?.pluginSkills > 0 || sb?.customSkills > 0)
    || loadedSkills.length > 0
    || tc['Skill'] > 0;
  if (hasSkillsInContext) {
    const skillsLoaded = (sb?.pluginSkills > 0 || sb?.customSkills > 0)
      ? ((sb.pluginSkills > 0 ? 1 : 0) + (sb.customSkills > 0 ? 1 : 0))
      : loadedSkills.length;
    let skillBadge;
    if (!e.reqLoaded && tc['Skill'] > 0) {
      skillBadge = '…';
    } else if (skillsLoaded > 0) {
      skillBadge = skillsLoaded + ' skills' + (skillTotal > 0 ? ' · ' + skillTotal + '×' : '');
    } else if (skillTotal > 0) {
      skillBadge = skillTotal + '×';
    } else {
      skillBadge = '';
    }
    html += renderSectionItem({ name: 'skills', label: 'Skills', color: 'var(--purple)', badge: skillBadge, extra: '' });
  }

  // ANALYSIS group
  html += '<div class="section-group-title">ANALYSIS</div>';
  html += renderSectionItem({ name: 'cost-efficiency', label: '💰 Cost Efficiency', color: null, badge: '', extra: '' });

  // RAW group (simplified to 2 items)
  html += '<div class="section-group-title">RAW</div>';
  html += renderSectionItem({ name: 'raw-req', label: 'Request', color: null, badge: '', extra: '' });
  html += renderSectionItem({ name: 'raw-res', label: 'Events', color: null, badge: resEvents.length ? resEvents.length + ' events' : '', extra: '' });
  if (!e.reqLoaded) html += '<div style="padding:8px 12px;font-size:11px;color:var(--dim)">⏳ Loading…</div>';
  colSections.innerHTML = html;
}

let cachedPricing = null;
function fetchPricingData() {
  if (cachedPricing) return Promise.resolve(cachedPricing);
  return fetch('/_api/pricing').then(r => r.json()).then(d => { cachedPricing = d; return d; });
}

function renderCostEfficiencyPanel(currentEntry) {
  const sid = currentEntry.sessionId;
  const sessionTurns = allEntries.filter(e => e.sessionId === sid && !e.isSubagent && e.usage);

  // --- Cache efficiency ---
  let totalCacheRead = 0, totalCacheCreate = 0;
  for (const e of sessionTurns) {
    totalCacheRead += e.usage.cache_read_input_tokens || 0;
    totalCacheCreate += e.usage.cache_creation_input_tokens || 0;
  }
  const totalCache = totalCacheRead + totalCacheCreate;
  const hitRate = totalCache > 0 ? (totalCacheRead / totalCache * 100) : 0;
  const hitColor = hitRate >= 80 ? 'var(--green)' : hitRate >= 50 ? 'var(--yellow)' : 'var(--red)';

  let html = '<div class="detail-content" style="padding:12px">';
  html += '<div style="font-size:13px;font-weight:bold;margin-bottom:12px">Cost Efficiency</div>';

  // Cache hit rate bar
  html += '<div style="margin-bottom:12px">';
  html += '<div style="font-size:11px;color:var(--dim);margin-bottom:4px">Cache Hit Rate</div>';
  if (totalCache > 0) {
    html += '<div style="display:flex;height:10px;border-radius:3px;overflow:hidden;background:var(--border);margin-bottom:4px">';
    html += '<div style="width:' + hitRate.toFixed(1) + '%;background:' + hitColor + '"></div>';
    html += '</div>';
    html += '<div style="font-size:11px;color:' + hitColor + '">' + hitRate.toFixed(1) + '% · ↩ ' + fmt(totalCacheRead) + ' read · ↗ ' + fmt(totalCacheCreate) + ' write</div>';
  } else {
    html += '<div style="font-size:11px;color:var(--dim)">No cache data for this session</div>';
  }
  html += '</div>';

  // Fetch pricing and compute savings async, show placeholder
  const savingsId = 'ce-savings-' + Date.now();
  html += '<div id="' + savingsId + '" style="font-size:11px;color:var(--dim);margin-bottom:16px">Calculating savings…</div>';

  // --- System section token ranking ---
  const tok = currentEntry.tokens || {};
  const cb = tok.contextBreakdown;
  if (cb) {
    html += '<div style="font-size:11px;color:var(--dim);margin-bottom:4px">Fixed Cost per Turn (System + Tools)</div>';
    const sb = cb.systemBreakdown || {};
    const cm = cb.claudeMd || {};
    const systemSections = [
      { label: 'Core instructions', tokens: sb.coreInstructions || 0 },
      { label: 'Plugin skills', tokens: sb.pluginSkills || 0 },
      { label: 'Custom skills', tokens: sb.customSkills || 0 },
      { label: 'Custom agents', tokens: sb.customAgents || 0 },
      { label: 'MCP instructions', tokens: (sb.mcpServersList || 0) },
      { label: 'Settings/Env/Git', tokens: (sb.settingsJson || 0) + (sb.envAndGit || 0) },
      { label: 'Global CLAUDE.md', tokens: cm.globalClaudeMd || 0 },
      { label: 'Project CLAUDE.md', tokens: cm.projectClaudeMd || 0 },
      { label: 'Auto memory', tokens: sb.autoMemory || 0 },
      { label: 'Core identity', tokens: (sb.coreIdentity || 0) + (sb.billingHeader || 0) },
    ].filter(s => s.tokens > 0).sort((a, b) => b.tokens - a.tokens);

    // --- MCP plugin token ranking ---
    const mcpPlugins = cb.toolsBreakdown?.mcpPlugins || [];
    const ttok = cb.toolsBreakdown?.toolTokens || {};
    const coreToolTokens = (ttok.core || 0) + (ttok.agent || 0) + (ttok.task || 0) + (ttok.team || 0) + (ttok.cron || 0) + (ttok.other || 0);

    const toolSections = [
      { label: 'Core tools', tokens: coreToolTokens, count: cb.toolsBreakdown?.counts ? Object.entries(cb.toolsBreakdown.counts).filter(([k]) => k !== 'mcp').reduce((s, [, v]) => s + v, 0) : 0, color: 'var(--color-tools)' },
      ...mcpPlugins.map(p => ({ label: 'MCP: ' + p.plugin, tokens: p.tokens, count: p.count, color: 'var(--color-mcp-tools)', isMcp: true, plugin: p.plugin }))
    ].filter(s => s.tokens > 0).sort((a, b) => b.tokens - a.tokens);

    // Combine system + tools into one aligned chart
    const allBars = [
      ...systemSections.map(s => ({ label: s.label, tokens: s.tokens, color: 'var(--color-system)' })),
      null, // separator
      ...toolSections.map(s => ({ label: s.label + ' (' + s.count + ')', tokens: s.tokens, color: s.color })),
    ];
    const maxTok = Math.max(...allBars.filter(Boolean).map(s => s.tokens), 1);
    const maxLabelLen = Math.max(...allBars.filter(Boolean).map(s => s.label.length), 1);
    const labelW = Math.max(120, Math.min(220, maxLabelLen * 7));

    html += '<div style="margin-bottom:12px">';
    for (const s of allBars) {
      if (!s) { html += '<div style="height:8px"></div>'; continue; }
      const barW = (s.tokens / maxTok * 100).toFixed(1);
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:10px">';
      html += '<span style="width:' + labelW + 'px;flex-shrink:0;color:var(--text)">' + escapeHtml(s.label) + '</span>';
      html += '<div style="flex:1;height:6px;border-radius:2px;background:var(--border)"><div style="width:' + barW + '%;height:100%;border-radius:2px;background:' + s.color + '"></div></div>';
      html += '<span style="width:50px;text-align:right;flex-shrink:0;color:var(--dim)">' + s.tokens.toLocaleString() + '</span>';
      html += '</div>';
    }
    html += '</div>';

    // --- Fixed tax summary ---
    const sysTok = tok.system || 0;
    const toolsTok = tok.tools || 0;
    const fixedTax = sysTok + toolsTok;
    const maxCtx = currentEntry.maxContext || 200000;
    const fixedPct = (fixedTax / maxCtx * 100).toFixed(1);
    html += '<div style="background:var(--border);border-radius:4px;padding:8px;font-size:11px;margin-bottom:12px">';
    html += 'Fixed tax per turn: <strong>' + fmt(fixedTax) + ' tokens</strong> = ' + fixedPct + '% of ' + fmt(maxCtx) + ' context window';
    html += '</div>';

    // --- Unused MCP plugins warning ---
    if (mcpPlugins.length) {
      const sessionToolCalls = {};
      for (const e of sessionTurns) {
        for (const [name, count] of Object.entries(e.toolCalls || {})) {
          sessionToolCalls[name] = (sessionToolCalls[name] || 0) + count;
        }
      }
      const unusedPlugins = mcpPlugins.filter(p => {
        // Check if any tool from this plugin was used
        return !Object.keys(sessionToolCalls).some(name => name.startsWith('mcp__' + p.plugin + '__'));
      });
      for (const p of unusedPlugins) {
        html += '<div style="padding:2px 0;font-size:11px;color:var(--yellow)">';
        html += '⚠ ' + escapeHtml(p.plugin) + ' has ' + p.count + ' tools but 0 uses this session (' + p.tokens.toLocaleString() + ' tok)';
        html += '</div>';
      }
    }
  } else {
    html += '<div style="font-size:11px;color:var(--dim)">Load request data to see full analysis</div>';
  }

  html += '</div>';

  // Async: compute savings from pricing
  fetchPricingData().then(pricing => {
    const el = document.getElementById(savingsId);
    if (!el) return;
    const model = currentEntry.model;
    const rates = pricing[model];
    if (!rates || totalCache === 0) {
      el.textContent = totalCache === 0 ? '' : 'Unable to fetch pricing data';
      return;
    }
    const normalCost = totalCacheRead / 1_000_000 * rates.input_cost_per_mtok;
    const cacheCost = totalCacheRead / 1_000_000 * rates.cache_read_cost_per_mtok;
    const saved = normalCost - cacheCost;
    el.innerHTML = 'Cache savings this session: <strong style="color:var(--green)">$' + saved.toFixed(3) + '</strong>';
  }).catch(() => {
    const el = document.getElementById(savingsId);
    if (el) el.textContent = '';
  });

  return html;
}

function renderDetailCol() {
  const renderToken = ++renderDetailRenderToken;
  colDetail.style.opacity = '0';
  const e = selectedTurnIdx >= 0 ? allEntries[selectedTurnIdx] : null;
  const tok = e?.tokens || {};
  const commitDetailHtml = function(html, afterRender) {
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (renderToken !== renderDetailRenderToken) return;
        colDetail.innerHTML = html;
        requestAnimationFrame(() => {
          if (renderToken !== renderDetailRenderToken) return;
          colDetail.style.opacity = '1';
          if (afterRender) afterRender();
        });
      }, DETAIL_RENDER_FADE_MS);
    });
  };

  if (!selectedSection) {
    commitDetailHtml('<div class="detail-scroll"><div class="col-empty"><div class="col-empty-hint">← Select a section</div></div></div>'); return;
  }
  if (!e) { commitDetailHtml('<div class="detail-scroll"><div class="col-empty">No data</div></div>'); return; }

  const req = e.req || {};
  const resEvents = Array.isArray(e.res) ? e.res : [];
  const loading = '<div class="col-empty">⏳ Loading…</div>';
  let inner = '';

  // Detail header — timeline always uses focused-style header
  const sectionLabel = selectedSection.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  let headerHtml;
  if (selectedSection === 'timeline' || isFocusedMode) {
    headerHtml = '<div class="fp-header">'
      + '<button class="fp-back" onclick="exitFocusedMode()">←</button>'
      + '<span class="fp-title">' + escapeHtml(sectionLabel) + '</span>'
      + '</div>';
  } else {
    headerHtml = '<div class="col-header" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border)">'
      + '<span style="font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:0.08em">' + escapeHtml(sectionLabel) + '</span>'
      + '<span class="expand-btn" onclick="enterFocusedMode()" title="Expand (Enter)">⛶</span>'
      + '</div>';
  }

  switch (selectedSection) {
    case 'system':
      if (req.system) {
        inner = '<div class="detail-content">' + renderSystemBlockViewer(req.system) + '</div>';
      } else { inner = e.reqLoaded ? '<div class="col-empty">No system prompt</div>' : loading; }
      break;
    case 'timeline': {
      if (!isFocusedMode) {
        // Non-focused: show step summary list with minimap (no detail pane)
        // User clicks a step or presses Enter to enter split-pane
        prepareTimelineSteps(req.messages, resEvents);
        if (!currentSteps.length) {
          inner = e.reqLoaded ? '<div class="col-empty">No messages</div>' : loading;
          break;
        }
        const toolFreqPreview = {};
        currentSteps.forEach(s => { if (s.type === 'tool-group') s.calls.forEach(c => { toolFreqPreview[c.name] = (toolFreqPreview[c.name] || 0) + 1; }); });
        const totalPreview = currentSteps.filter(s => s.type === 'tool-group').length;
        const errorPreview = currentSteps.filter(s => s.type === 'tool-group' && s.calls.some(c => c.isError)).length;
        const summaryPreview = '<div style="padding:4px 8px 6px;border-bottom:1px solid var(--border);font-size:11px;color:var(--dim)">'
          + totalPreview + ' steps · ' + (totalPreview - errorPreview) + '✓'
          + (errorPreview ? ' <span style="color:var(--red)">' + errorPreview + '✗</span>' : '')
          + '</div>';
        const previewStepsHtml = renderStepListHtml(currentSteps, getActiveStepKey());
        const previewMinimapHtml = (typeof renderMinimapHtml === 'function')
          ? renderMinimapHtml(currentSteps, tok?.perMessage || null, -1, e.maxContext, e.usage)
          : '';
        inner = summaryPreview
          + '<div class="tl-with-minimap" style="flex:1;overflow:hidden">'
          + '<div class="minimap">' + previewMinimapHtml + '</div>'
          + '<div class="tl-scroll-area">' + previewStepsHtml + '</div>'
          + '</div>';
        break;
      }

      // Prepare steps if needed
      prepareTimelineSteps(req.messages, resEvents);
      if (!currentSteps.length) {
        inner = e.reqLoaded ? '<div class="col-empty">No messages</div>' : loading;
        break;
      }

      // Tool frequency summary
      const toolFreq = {};
      currentSteps.forEach(s => { if (s.type === 'tool-group') s.calls.forEach(c => { toolFreq[c.name] = (toolFreq[c.name] || 0) + 1; }); });
      const totalSteps = currentSteps.filter(s => s.type === 'tool-group').length;
      const errorCount = currentSteps.filter(s => s.type === 'tool-group' && s.calls.some(c => c.isError)).length;
      const summaryHtml = '<div style="padding:4px 8px 6px;border-bottom:1px solid var(--border);font-size:11px;color:var(--dim)">'
        + totalSteps + ' steps · ' + (totalSteps - errorCount) + '✓'
        + (errorCount ? ' <span style="color:var(--red)">' + errorCount + '✗</span>' : '')
        + '</div>';

      const activeKey = getActiveStepKey();
      const stepsHtml = renderStepListHtml(currentSteps, activeKey);

      const minimapHtml = (typeof renderMinimapHtml === 'function')
        ? renderMinimapHtml(currentSteps, tok?.perMessage || null, -1, e.maxContext, e.usage)
        : '';

      // Split pane: left minimap + list + right detail
      const detailHtml = selectedMessageIdx >= 0
        ? renderStepDetailHtml(req, tok)
        : '<div class="col-empty" style="padding:20px">← Select a step</div>';
      const focusedHtml = headerHtml + summaryHtml
        + '<div class="tl-split">'
        + '<div class="tl-with-minimap" style="width:280px;min-width:200px;max-width:400px;flex-shrink:0;border-right:1px solid var(--border)">'
        + '<div class="minimap">' + minimapHtml + '</div>'
        + '<div class="tl-scroll-area">' + stepsHtml + '</div>'
        + '</div>'
        + '<div class="tl-split-detail">' + detailHtml + '</div>'
        + '</div>';
      commitDetailHtml(focusedHtml, function() {
        requestAnimationFrame(() => {
          const mm = colDetail.querySelector('.minimap');
          const sa = colDetail.querySelector('.tl-scroll-area');
          if (mm && sa) { layoutMinimapBlocks(mm); initMinimapInteractions(mm, sa); }
        });
        if (currentSteps.length && selectedMessageIdx < 0) {
          selectStep(currentSteps.length - 1);
        }
      });
      return; // early return — we set innerHTML directly
      break;
    }
    case 'core-tools':
    case 'mcp-tools': {
      const isMcp = selectedSection === 'mcp-tools';
      const filtered = req.tools ? req.tools.filter(t => isMcp ? t.name.startsWith('mcp__') : !t.name.startsWith('mcp__')) : null;
      if (filtered?.length) {
        const usageCount = allEntries[selectedTurnIdx]?.toolCalls || {};
        const sorted = [...filtered].sort((a, b) => (usageCount[b.name] || 0) - (usageCount[a.name] || 0));
        const tags = sorted.map(t => {
          const cnt = usageCount[t.name] || 0;
          const badge = cnt > 0 ? ' <span style="font-size:9px;background:var(--accent);color:#fff;border-radius:3px;padding:0 3px;margin-left:3px">' + cnt + 'x</span>' : '';
          return '<span class="tool-tag">' + escapeHtml(t.name) + badge + '</span>';
        }).join('');
        inner = '<div class="detail-content"><div class="tool-grid">' + tags + '</div>' +
          '<details style="margin-top:8px"><summary style="color:var(--dim);cursor:pointer;font-size:11px">Full definitions</summary><pre>' + escapeHtml(JSON.stringify(filtered, null, 2)) + '</pre></details></div>';
      } else { inner = e.reqLoaded ? '<div class="col-empty">No ' + (isMcp ? 'MCP' : 'core') + ' tools</div>' : loading; }
      break;
    }
    case 'skills': {
      if (!e.reqLoaded) { inner = loading; break; }
      // Invoked skills (all 3 paths: user /cmd, model Skill tool, hybrid)
      const sc = countSkillInvocations(req.messages, tok.contextBreakdown?.loadedSkills);
      const sortedInvoked = Object.entries(sc).sort((a, b) => b[1] - a[1]);
      // Loaded skills (from system-reminder in messages)
      const detailLoadedSkills = tok.contextBreakdown?.loadedSkills || [];
      let html2 = '';
      if (detailLoadedSkills.length) {
        const loadedTags = detailLoadedSkills.map(name => {
          const cnt = sc[name] || 0;
          return '<span class="tool-tag" style="border-color:var(--purple);opacity:' + (cnt > 0 ? '1' : '0.45') + '">'
            + escapeHtml(name)
            + (cnt > 1 ? ' <span style="font-size:9px;background:var(--purple);color:#fff;border-radius:3px;padding:0 3px;margin-left:3px">' + cnt + 'x</span>' : '')
            + '</span>';
        }).join('');
        html2 += '<div class="detail-content"><div class="tool-grid">' + loadedTags + '</div></div>';
      } else if (sortedInvoked.length) {
        const tags = sortedInvoked.map(([name, cnt]) =>
          '<span class="tool-tag" style="border-color:var(--purple)">' + escapeHtml(name) +
          (cnt > 1 ? ' <span style="font-size:9px;background:var(--purple);color:#fff;border-radius:3px;padding:0 3px;margin-left:3px">' + cnt + 'x</span>' : '') +
          '</span>'
        ).join('');
        html2 += '<div class="detail-content"><div class="tool-grid">' + tags + '</div></div>';
      } else {
        html2 += '<div class="col-empty">0 invocations</div>';
      }
      inner = html2;
      break;
    }
    case 'cost-efficiency':
      inner = renderCostEfficiencyPanel(e);
      break;
    case 'raw-req':
      inner = req && Object.keys(req).length
        ? '<div class="detail-content"><pre>' + escapeHtml(JSON.stringify(req, null, 2)) + '</pre></div>'
        : (e.reqLoaded ? '<div class="col-empty">No request data</div>' : loading);
      break;
    case 'raw-res':
      inner = resEvents.length
        ? '<div class="detail-content"><pre>' + escapeHtml(JSON.stringify(resEvents, null, 2)) + '</pre></div>'
        : (e.reqLoaded ? '<div class="col-empty">No response data</div>' : loading);
      break;
    default: inner = '<div class="col-empty">Unknown section</div>';
  }

  const scrollStyle = selectedSection === 'timeline' ? ' style="display:flex;flex-direction:column"' : '';
  commitDetailHtml(headerHtml + '<div class="detail-scroll"' + scrollStyle + '>' + inner + '</div>', function() {
    if (selectedSection === 'timeline') {
      requestAnimationFrame(() => {
        const mm = colDetail.querySelector('.minimap');
        const sa = colDetail.querySelector('.tl-scroll-area');
        if (mm && sa) { layoutMinimapBlocks(mm); initMinimapInteractions(mm, sa); }
      });
    }
  });
}

const DETAIL_RENDER_FADE_MS = 150;
let renderDetailRenderToken = 0;

// ── Detail Panel: Tool-Specific Rendering ──

const COLLAPSE_THRESHOLD = 50;
const HEAD_LINES = 30;
const TAIL_LINES = 10;

function renderToolDetail(c) {
  const statusBadge = c.pending ? '⏳' : c.isError
    ? '<span style="color:var(--red)">✗ ERROR</span>'
    : '<span style="color:var(--green)">✓</span>';

  let html = '<div class="detail-tool-header">';
  html += '<div class="detail-tool-title">' + escapeHtml(c.name) + ' ' + statusBadge + '</div>';
  html += '<button class="detail-copy-btn" onclick="copyDetailContent(this)" title="Copy output">Copy</button>';
  html += '</div>';
  html += renderToolMeta(c);
  html += renderToolInput(c);
  html += renderToolOutput(c);
  return html;
}

function renderToolMeta(c) {
  const inp = c.input || {};
  switch (c.name) {
    case 'Bash': {
      const cmd = (inp.command || '');
      const desc = inp.description ? '<div class="detail-meta-line">' + escapeHtml(inp.description) + '</div>' : '';
      return '<div class="detail-meta"><code class="detail-cmd-block">$ ' + escapeHtml(cmd.split('\n')[0]) + (cmd.includes('\n') ? ' ...' : '') + '</code>' + desc + '</div>';
    }
    case 'Read':
      return '<div class="detail-meta"><code>' + escapeHtml(inp.file_path || '') + '</code>'
        + (inp.offset ? ' <span class="detail-tag">L' + inp.offset + (inp.limit ? '-' + (inp.offset + inp.limit) : '+') + '</span>' : '')
        + '</div>';
    case 'Write':
      return '<div class="detail-meta"><code>' + escapeHtml(inp.file_path || '') + '</code></div>';
    case 'Edit':
      return '<div class="detail-meta"><code>' + escapeHtml(inp.file_path || '') + '</code>'
        + (inp.replace_all ? ' <span class="detail-tag">replace_all</span>' : '') + '</div>';
    case 'Grep':
      return '<div class="detail-meta"><code>/' + escapeHtml(inp.pattern || '') + '/</code>'
        + (inp.glob ? ' <span class="detail-tag">' + escapeHtml(inp.glob) + '</span>' : '')
        + (inp.path ? ' in <code>' + escapeHtml(inp.path.split('/').slice(-2).join('/')) + '</code>' : '') + '</div>';
    case 'Glob':
      return '<div class="detail-meta"><code>' + escapeHtml(inp.pattern || '') + '</code>'
        + (inp.path ? ' in <code>' + escapeHtml(inp.path.split('/').slice(-2).join('/')) + '</code>' : '') + '</div>';
    case 'Agent':
      return '<div class="detail-meta">' + escapeHtml(inp.description || (inp.prompt || '').slice(0, 80))
        + (inp.subagent_type ? ' <span class="detail-tag">' + escapeHtml(inp.subagent_type) + '</span>' : '') + '</div>';
    case 'WebSearch':
      return '<div class="detail-meta"><code>' + escapeHtml(inp.query || '') + '</code></div>';
    case 'WebFetch':
      return '<div class="detail-meta"><code>' + escapeHtml((inp.url || '').replace(/^https?:\/\//, '').slice(0, 60)) + '</code></div>';
    case 'TaskCreate':
      return '<div class="detail-meta">' + escapeHtml(inp.subject || '') + '</div>';
    case 'TaskUpdate':
      return '<div class="detail-meta">Task #' + escapeHtml(inp.taskId || '') + (inp.status ? ' → <span class="detail-tag">' + escapeHtml(inp.status) + '</span>' : '') + '</div>';
    default:
      return '';
  }
}

function renderToolInput(c) {
  const inp = c.input || {};

  if (c.name === 'Edit' && inp.old_string != null) {
    return renderEditDiff(inp.old_string, inp.new_string || '');
  }

  if (c.name === 'Bash') {
    const cmd = inp.command || '';
    const lines = cmd.split('\n');
    let html = '<div class="content-block"><div class="type">COMMAND</div>';
    if (lines.length > COLLAPSE_THRESHOLD) {
      html += renderCollapsedContent(lines);
    } else {
      html += '<pre class="detail-cmd-block">' + escapeHtml(cmd) + '</pre>';
    }
    if (inp.timeout && inp.timeout !== 120000) html += '<div class="detail-meta-line">timeout: ' + inp.timeout + 'ms</div>';
    html += '</div>';
    return html;
  }

  // For tools where meta already shows the key info, collapse JSON by default
  const metaTools = ['Read', 'Write', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent', 'TaskCreate', 'TaskUpdate'];
  const json = JSON.stringify(inp, null, 2);
  if (metaTools.includes(c.name)) {
    return '<details class="detail-input-details"><summary>INPUT JSON</summary><pre>' + escapeHtml(json) + '</pre></details>';
  }

  return '<div class="content-block"><div class="type">INPUT</div><pre>' + escapeHtml(json) + '</pre></div>';
}

function renderToolOutput(c) {
  if (c.result == null) {
    if (c.pending) {
      return '<div class="content-block"><div class="type" style="color:var(--dim)">OUTPUT</div><div style="color:var(--dim);padding:8px">⏳ Waiting...</div></div>';
    }
    return '';
  }

  // Handle array results with image blocks
  if (Array.isArray(c.result)) {
    const hasImage = c.result.some(b => b.type === 'image');
    if (hasImage) {
      let html = '';
      for (const block of c.result) {
        if (block.type === 'image' && block.source?.data) {
          const mediaType = block.source.media_type || 'image/png';
          html += '<div class="content-block"><div class="type">IMAGE</div>'
            + '<img src="data:' + escapeHtml(mediaType) + ';base64,' + block.source.data + '" '
            + 'style="max-width:100%;border-radius:4px;margin-top:4px;background:var(--bg);cursor:pointer" '
            + 'onclick="showImageOverlay(this.src)" title="Click to enlarge">'
            + '</div>';
        } else if (block.type === 'text' && block.text) {
          html += '<div class="content-block"><div class="type">TEXT</div><pre>' + escapeHtml(block.text) + '</pre></div>';
        }
      }
      return html;
    }
  }

  const resultStr = typeof c.result === 'string' ? c.result : JSON.stringify(c.result, null, 2);
  const lines = resultStr.split('\n');
  const errStyle = c.isError ? ' style="color:var(--red)"' : '';
  const label = c.isError ? 'OUTPUT (error)' : 'OUTPUT';

  let html = '<div class="content-block"><div class="type"' + errStyle + '>' + label
    + ' <span style="color:var(--dim);font-weight:normal">' + lines.length + ' lines</span></div>';

  if (c.isError) {
    html += renderErrorOutput(resultStr);
  } else if (lines.length > COLLAPSE_THRESHOLD) {
    html += renderCollapsedContent(lines);
  } else {
    html += '<pre>' + escapeHtml(resultStr) + '</pre>';
  }

  html += '</div>';
  return html;
}

function renderCollapsedContent(lines) {
  const head = lines.slice(0, HEAD_LINES).join('\n');
  const tail = lines.slice(-TAIL_LINES).join('\n');
  const hiddenCount = lines.length - HEAD_LINES - TAIL_LINES;
  const id = 'collapse-' + Math.random().toString(36).slice(2, 8);

  return '<pre>' + escapeHtml(head) + '</pre>'
    + '<div class="detail-collapse-bar" onclick="document.getElementById(\'' + id + '\').style.display=\'block\';this.style.display=\'none\'">⋯ '
    + hiddenCount + ' lines hidden — click to expand</div>'
    + '<div id="' + id + '" style="display:none"><pre>' + escapeHtml(lines.slice(HEAD_LINES, -TAIL_LINES).join('\n')) + '</pre></div>'
    + '<pre>' + escapeHtml(tail) + '</pre>';
}

function renderEditDiff(oldStr, newStr) {
  let html = '<div class="detail-diff">';
  html += '<div class="detail-diff-section detail-diff-old">';
  html += '<div class="detail-diff-label">OLD</div><pre>';
  for (const line of (oldStr || '').split('\n')) {
    html += '<span class="diff-line-del">- ' + escapeHtml(line) + '</span>\n';
  }
  html += '</pre></div>';
  html += '<div class="detail-diff-section detail-diff-new">';
  html += '<div class="detail-diff-label">NEW</div><pre>';
  for (const line of (newStr || '').split('\n')) {
    html += '<span class="diff-line-add">+ ' + escapeHtml(line) + '</span>\n';
  }
  html += '</pre></div></div>';
  return html;
}

function renderErrorOutput(text) {
  const lines = text.split('\n');
  const stackStart = lines.findIndex(l => /^\s+at\s/.test(l));
  if (stackStart > 0) {
    const msg = lines.slice(0, stackStart).join('\n');
    const stack = lines.slice(stackStart).join('\n');
    return '<pre style="color:var(--red)">' + escapeHtml(msg) + '</pre>'
      + '<details><summary style="color:var(--dim);font-size:11px;cursor:pointer">Stack trace ('
      + (lines.length - stackStart) + ' lines)</summary>'
      + '<pre style="color:var(--red);opacity:0.7">' + escapeHtml(stack) + '</pre></details>';
  }
  return '<pre style="color:var(--red)">' + escapeHtml(text) + '</pre>';
}

function renderThinkingDetail(thinking, durLabel) {
  const charCount = (thinking || '').length;
  const paras = (thinking || '').split(/\n{2,}/);
  const formatted = paras.map(p => '<p class="think-para">' + escapeHtml(p) + '</p>').join('');
  return '<div class="detail-tool-header">'
    + '<div class="detail-tool-title">🧠 Thinking' + durLabel + '</div>'
    + '<span style="color:var(--dim);font-size:11px">' + charCount.toLocaleString() + ' chars</span>'
    + '</div>'
    + '<div class="detail-thinking">' + formatted + '</div>';
}

function showImageOverlay(src) {
  let overlay = document.getElementById('img-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'img-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:300;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    overlay.addEventListener('click', () => overlay.style.display = 'none');
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '<img src="' + src + '" style="max-width:90vw;max-height:90vh;border-radius:6px;box-shadow:0 4px 30px rgba(0,0,0,0.5)">';
  overlay.style.display = 'flex';
}

function copyDetailContent(btn) {
  const content = btn.closest('.detail-content');
  if (!content) return;
  const pres = content.querySelectorAll('pre');
  const text = Array.from(pres).map(p => p.textContent).join('\n\n');
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}
