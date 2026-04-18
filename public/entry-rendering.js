// ── Entry rendering ──
let newTurnCount = 0;

function cleanTitle(raw) {
  if (!raw) return null;
  let t = raw
    .replace(/<[^>]+>/g, '')          // strip XML/HTML tags (<system-reminder>, etc.)
    .replace(/^\s*[*#\-—=~`]+\s*/g, '') // strip leading markdown symbols
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 4 ? t : null;
}

function formatGap(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60) return m + 'm' + (rem ? rem + 's' : '');
  return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}

function showNewTurnPill(count) {
  const existing = document.getElementById('new-turn-pill');
  if (existing) {
    existing.textContent = '↓ ' + count + ' new';
    return;
  }

  const pill = document.createElement('div');
  pill.id = 'new-turn-pill';
  pill.className = 'new-turn-pill';
  pill.textContent = '↓ ' + count + ' new';
  pill.onclick = function() {
    selectTurn(allEntries.length - 1);
    scrollTurnsToBottom();
  };
  colTurns.appendChild(pill);
}

function hideNewTurnPill() {
  const pill = document.getElementById('new-turn-pill');
  if (pill) pill.remove();
  newTurnCount = 0;
}

function renderMessages(messages, perMessage) {
  if (!messages || !messages.length) return '<pre>No messages</pre>';
  return messages.map((m, i) => {
    let body = '';
    if (typeof m.content === 'string') {
      body = escapeHtml(m.content);
    } else if (Array.isArray(m.content)) {
      body = m.content.map(block => {
        if (block.type === 'text') return escapeHtml(block.text);
        if (block.type === 'tool_use') return '<div class="content-block"><div class="type">tool_use: ' + escapeHtml(block.name) + '</div><pre>' + escapeHtml(JSON.stringify(block.input, null, 2)) + '</pre></div>';
        if (block.type === 'tool_result') return '<div class="content-block"><div class="type">tool_result (id: ' + escapeHtml(block.tool_use_id) + ')</div><pre>' + escapeHtml(typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2)) + '</pre></div>';
        return '<pre>' + escapeHtml(JSON.stringify(block, null, 2)) + '</pre>';
      }).join('');
    } else {
      body = escapeHtml(JSON.stringify(m.content, null, 2));
    }
    const tokLabel = perMessage && perMessage[i] ? ' <span class="badge">' + perMessage[i].tokens + ' tok</span>' : '';
    return '<div class="msg"><div class="msg-role ' + m.role + '">[' + i + '] ' + m.role + tokLabel + '</div><pre>' + body + '</pre></div>';
  }).join('');
}

function makeSection(id, title, badge, contentHtml, defaultOpen) {
  const openClass = defaultOpen ? ' open' : '';
  return '<div class="section">' +
    '<div class="section-header' + openClass + '" onclick="toggleSection(this)"><span class="arrow">▶</span> ' + title + (badge ? ' <span class="badge">' + badge + '</span>' : '') + '</div>' +
    '<div class="section-content' + openClass + '"><div>' + contentHtml + '</div></div></div>';
}
function toggleSection(el) { el.classList.toggle('open'); el.nextElementSibling.classList.toggle('open'); }

function buildContextCategories(tok) {
  if (!tok?.contextBreakdown) return null;
  const cb = tok.contextBreakdown;
  const sb = cb.systemBreakdown || {};
  const cm = cb.claudeMd || {};
  const ttok = cb.toolsBreakdown?.toolTokens || {};
  // Order matches section items: System → Messages → Tools
  const cats = [
    // System (blues)
    { label: 'Core instructions',  color: 'var(--color-system-deep)', tokens: sb.coreInstructions || 0 },
    { label: 'Plugin instructions', color: 'var(--color-system)', tokens: (sb.mcpServersList || 0) + (sb.coreIdentity || 0) + (sb.billingHeader || 0) },
    { label: 'Custom skills',       color: 'var(--color-system-mid)', tokens: sb.customSkills || 0 },
    { label: 'Plugin skills',       color: 'var(--color-system-light)', tokens: sb.pluginSkills || 0 },
    { label: 'Custom agents',       color: 'var(--color-system-pale)', tokens: sb.customAgents || 0 },
    { label: 'Settings/Env/Git',    color: 'var(--color-system-muted)', tokens: (sb.settingsJson || 0) + (sb.envAndGit || 0) },
    { label: 'Global CLAUDE.md',    color: 'var(--color-system-soft)', tokens: cm.globalClaudeMd || 0 },
    { label: 'Project CLAUDE.md',   color: 'var(--color-system-faint)', tokens: cm.projectClaudeMd || 0 },
    // Messages (amber)
    { label: 'Messages',            color: 'var(--color-messages)', tokens: cb.messageTokens || 0 },
    // Tools (greens)
    { label: 'Core tools',          color: 'var(--color-tools)', tokens: (ttok.core || 0) + (ttok.agent || 0) + (ttok.task || 0) + (ttok.team || 0) + (ttok.cron || 0) + (ttok.other || 0) },
    { label: 'MCP tools',           color: 'var(--color-mcp-tools)', tokens: ttok.mcp || 0 },
  ];
  const total = cats.reduce((s, c) => s + c.tokens, 0);
  return total ? { cats, total, mcpPlugins: cb.toolsBreakdown?.mcpPlugins || [] } : null;
}

function renderContextBreakdownBar(tok, maxContext, usage) {
  const data = buildContextCategories(tok);
  if (!data) return '';
  const { cats, total: estimatedTotal } = data;
  // Use API usage as authoritative total when available (tokenizeRequest underestimates by 20-40%)
  const apiTotal = usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0;
  const total = apiTotal > estimatedTotal ? apiTotal : estimatedTotal;
  // Scale category segments proportionally if API total is larger
  const scale = estimatedTotal > 0 && total > estimatedTotal ? total / estimatedTotal : 1;
  const windowSize = maxContext || DEFAULT_MAX_CTX;
  const pct = (total / windowSize * 100).toFixed(0);
  const usedPct = Math.min(100, total / windowSize * 100);
  const barColor = usedPct > 90 ? 'var(--red)' : usedPct > 70 ? 'var(--yellow)' : null;

  let bar = '<div style="display:flex;height:8px;border-radius:2px;overflow:hidden;margin:4px 0 2px;background:var(--border)">';
  for (const c of cats) {
    if (!c.tokens) continue;
    const scaled = c.tokens * scale;
    const w = (scaled / windowSize * 100).toFixed(3);
    bar += '<div style="width:' + w + '%;background:' + (barColor || c.color) + ';min-width:1px" title="' + escapeHtml(c.label) + ': ' + Math.round(scaled).toLocaleString() + '"></div>';
  }
  bar += '</div>';

  const pctColor = usedPct > 90 ? 'var(--red)' : usedPct > 70 ? 'var(--yellow)' : 'var(--dim)';
  const label = '<div style="font-size:10px;color:var(--dim)">' +
    fmt(total) + ' / ' + fmt(windowSize) + ' <span style="color:' + pctColor + '">(' + pct + '%)</span></div>';

  return '<div style="padding:4px 12px 6px;border-bottom:1px solid var(--border)">' + bar + label + '</div>';
}

// Sticky bar shown at top of detail col — always visible
function renderContextBreakdownSticky(tok, maxContext, usage) {
  const data = buildContextCategories(tok);
  if (!data) return '';
  const { cats, total: estimatedTotal, mcpPlugins } = data;
  // Use API usage as authoritative total when available
  const apiTotal = usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0;
  const total = apiTotal > estimatedTotal ? apiTotal : estimatedTotal;
  const scale = estimatedTotal > 0 && total > estimatedTotal ? total / estimatedTotal : 1;
  const windowSize = maxContext || DEFAULT_MAX_CTX;
  const usedPct = Math.min(100, total / windowSize * 100);
  const barColor = usedPct > 90 ? 'var(--red)' : usedPct > 70 ? 'var(--yellow)' : null;

  // Each segment is a fraction of windowSize; bar total = usedPct% of full width
  let bar = '<div style="display:flex;height:12px;border-radius:3px;overflow:hidden;margin-bottom:6px;background:var(--border)">';
  for (const c of cats) {
    if (!c.tokens) continue;
    const scaled = c.tokens * scale;
    const pct = (scaled / windowSize * 100).toFixed(3);
    const bg = barColor || c.color;
    bar += '<div style="width:' + pct + '%;background:' + bg + ';min-width:1px" title="' + escapeHtml(c.label) + ': ' + Math.round(scaled).toLocaleString() + ' (' + (c.tokens / estimatedTotal * 100).toFixed(1) + '% of used)"></div>';
  }
  bar += '</div>';

  let table = '<table style="width:100%;border-collapse:collapse;font-size:10px">';
  for (const c of cats) {
    if (!c.tokens) continue;
    const scaled = Math.round(c.tokens * scale);
    const pct = (c.tokens / estimatedTotal * 100).toFixed(1);
    table += '<tr><td style="padding:1px 3px"><span style="display:inline-block;width:7px;height:7px;background:' + c.color + ';border-radius:2px;margin-right:3px"></span>' + escapeHtml(c.label) + '</td>' +
      '<td style="padding:1px 3px;text-align:right">' + scaled.toLocaleString() + '</td>' +
      '<td style="padding:1px 3px;text-align:right;color:var(--dim)">' + pct + '%</td></tr>';
  }
  const pctOfWindow = (total / windowSize * 100).toFixed(0);
  table += '<tr style="border-top:1px solid var(--border)"><td style="padding:3px;color:var(--dim)">Used</td><td style="padding:3px;text-align:right">' + fmt(total) + '</td><td style="padding:3px;text-align:right;color:var(--dim)">' + pctOfWindow + '%</td></tr>';
  table += '<tr><td style="padding:1px 3px;color:var(--dim)">Window</td><td style="padding:1px 3px;text-align:right;color:var(--dim)">' + fmt(windowSize) + '</td><td></td></tr>';
  table += '</table>';

  let mcp = '';
  if (mcpPlugins.length) {
    mcp = '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:10px;color:var(--dim)">MCP plugins (' + mcpPlugins.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:3px">';
    for (const p of mcpPlugins.slice().sort((a, b) => b.tokens - a.tokens)) {
      mcp += '<tr><td style="padding:1px 3px;color:var(--dim)">' + escapeHtml(p.plugin) + '</td><td style="padding:1px 3px;text-align:right">' + p.count + ' tools</td><td style="padding:1px 3px;text-align:right">' + p.tokens.toLocaleString() + ' tok</td></tr>';
    }
    mcp += '</table></details>';
  }

  const title = 'Context Breakdown · ' + fmt(total) + ' / ' + fmt(windowSize) + ' tokens (' + pctOfWindow + '%)';
  return '<div class="ctx-sticky"><div class="ctx-sticky-title">' + title + '</div>' + bar + table + mcp + '</div>';
}

function isAbnormalStop(stopReason) {
  return !!stopReason && stopReason !== 'end_turn' && stopReason !== 'tool_use';
}

function classifySeverity(entry, ctxPct, dupesMax) {
  if (ctxPct > 95) return 'critical';
  if (entry.status != null && (entry.status < 200 || entry.status >= 300)) return 'critical';
  if (isAbnormalStop(entry.stopReason)) return 'critical';
  if (ctxPct > 85) return 'warning';
  if (entry.hasCredential) return 'warning';
  if (entry.toolFail) return 'warning';
  if (dupesMax >= 2) return 'notice';
  return null;
}

function getCriticalMarker(stopReason, httpStatus, ctxPct) {
  // ctx > 95%: no inline marker (left bar only)
  if (httpStatus != null && (httpStatus < 200 || httpStatus >= 300)) return '!http';
  if (stopReason === 'max_tokens') return '!max';
  if (stopReason === 'length') return '!len';
  if (stopReason && stopReason !== 'end_turn' && stopReason !== 'tool_use'
      && stopReason !== 'max_tokens' && stopReason !== 'length'
      && stopReason !== 'content_filter') return '!stop';
  if (stopReason === 'content_filter') return '!filter';
  return null;
}


function addEntry(e) {
  if (entryCount === 0) colTurns.innerHTML = '<div class="col-sticky-header"><div class="col-title" style="display:flex;align-items:center">Turns<span id="scroll-toggle" onclick="toggleFollowLive()" style="cursor:pointer;font-size:10px;margin-left:auto"><span class="scroll-on active">ON</span> <span class="scroll-off">OFF</span></span></div><div id="session-tool-bar" style="display:none"></div><div id="ctx-legend"><span><span class="ctx-legend-dot" style="background:var(--color-cache-read)"></span>cache read</span><span><span class="ctx-legend-dot" style="background:var(--color-cache-write)"></span>cache write</span><span><span class="ctx-legend-dot" style="background:var(--color-input)"></span>input</span></div><div id="session-sparkline"></div></div>';
  const idx = entryCount++;

  const sid = e.sessionId || 'unknown';
  const model = e.model || e.req?.model || '?';
  const msgCount = e.msgCount != null ? e.msgCount : (e.req?.messages?.length || 0);
  const toolCount = e.toolCount != null ? e.toolCount : (e.req?.tools?.length || 0);
  const stopReason = e.stopReason != null ? e.stopReason : '';
  const tok = e.tokens || {};
  const usage = e.usage || null;
  const turnCost = e.cost?.cost != null ? e.cost.cost : (typeof e.cost === 'number' ? e.cost : null);

  // Session tracking — properly deduplicated by ID
  const entryId = e.id || '';
  const entryCwd = e.cwd || null;
  if (!sessionsMap.has(sid)) {
    const shortSid = sid.slice(0, 8);
    sessionsMap.set(sid, { id: sid, firstTs: e.ts, firstId: entryId, lastId: entryId, count: 0, mainCount: 0, subCount: 0, model, totalCost: 0, cwd: entryCwd });
    const sessEl = document.createElement('div');
    sessEl.className = 'session-item';
    sessEl.dataset.sessionId = sid;
    sessEl.id = 'sess-' + shortSid;
    sessEl.onclick = () => selectSession(sid);
    sessEl.innerHTML = renderSessionItem(sessionsMap.get(sid), sid);
    // Insert at top (after col-title) — newest sessions first
    const firstSession = colSessions.querySelector('.session-item');
    if (firstSession) colSessions.insertBefore(sessEl, firstSession);
    else colSessions.appendChild(sessEl);
  }
  const sess = sessionsMap.get(sid);
  // Update cwd if not yet known or was only a quota-check
  if (entryCwd && (!sess.cwd || sess.cwd === '(quota-check)')) sess.cwd = entryCwd;
  sess.lastId = entryId;
  const isSubagent = e.isSubagent || false;
  sess.count++; // total (shown in session item as "Nt")
  if (isSubagent) sess.subCount++;
  else sess.mainCount++;
  const displayNum = isSubagent ? ('s' + sess.subCount) : String(sess.mainCount);
  if (turnCost != null) sess.totalCost += turnCost;
  if (!sess.toolCalls) sess.toolCalls = {};
  Object.entries(e.toolCalls || {}).forEach(([name, cnt]) => {
    sess.toolCalls[name] = (sess.toolCalls[name] || 0) + cnt;
  });
  const sessEl = document.getElementById('sess-' + sid.slice(0, 8));
  if (sessEl) {
    sessEl.innerHTML = renderSessionItem(sess, sid);
    // Move to top if not already first — this session just got the newest activity
    const firstSession = colSessions.querySelector('.session-item');
    if (firstSession && firstSession !== sessEl) {
      colSessions.insertBefore(sessEl, firstSession);
    }
  }

  // Project tracking
  const projName = getProjectName(sess.cwd);
  if (!projectsMap.has(projName)) {
    projectsMap.set(projName, { name: projName, totalCost: 0, sessionIds: new Set(), firstId: entryId, lastId: entryId });
  }
  const proj = projectsMap.get(projName);
  proj.sessionIds.add(sid);
  proj.lastId = entryId;
  if (turnCost != null) proj.totalCost += turnCost;
  renderProjectsCol();

  const statusClass = e.status >= 200 && e.status < 300 ? 'status-ok' : 'status-err';
  const shortModel = model.replace('claude-', '').replace(/-[0-9]{8}$/, '');

  const ctxCacheCreate = usage ? (usage.cache_creation_input_tokens || 0) : 0;
  const ctxCacheRead   = usage ? (usage.cache_read_input_tokens || 0) : 0;
  const ctxInput       = usage ? (usage.input_tokens || 0) : 0;
  const ctxUsed = ctxCacheCreate + ctxCacheRead + ctxInput;

  // Update session context alert badge for main turns
  if (!isSubagent && ctxUsed > 0) {
    sess.latestMainCtxPct = Math.min(100, ctxUsed / (e.maxContext || DEFAULT_MAX_CTX) * 100);
    const sessElCtx = document.getElementById('sess-' + sid.slice(0, 8));
    if (sessElCtx) sessElCtx.innerHTML = renderSessionItem(sess, sid);
  }

  // Gap timing: idle time from end of previous turn to start of this turn
  let prevInSession = null;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    if (allEntries[i].sessionId === sid && allEntries[i].receivedAt) { prevInSession = allEntries[i]; break; }
  }
  let gapMs = null, gapColor = '', gapTitle = '';
  if (prevInSession && e.receivedAt) {
    const prevEnd = Number(prevInSession.receivedAt) + parseFloat(prevInSession.elapsed || 0) * 1000;
    const rawGap = Number(e.receivedAt) - prevEnd;
    gapMs = Number.isFinite(rawGap) ? Math.max(0, rawGap) : null;
    if (gapMs !== null) {
      gapColor = gapMs < 5 * 60000 ? 'var(--green)' : gapMs < 60 * 60000 ? 'var(--yellow)' : 'var(--red)';
      gapTitle = gapMs < 5 * 60000 ? 'Cache likely warm (< 5m)' : gapMs < 60 * 60000 ? 'Default cache expired (5m–1h)' : 'All cache expired (> 1h)';
    }
  }

  // Compression detection: compare message count AND context tokens vs previous main turn.
  // True compaction = msgCount drops significantly (messages got summarized/removed).
  // Token-only drops can happen from cache eviction or normal conversation flow.
  let isCompacted = false;
  if (!isSubagent && ctxUsed > 0 && msgCount > 0) {
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const prev = allEntries[i];
      if (prev.sessionId === sid && !prev.isSubagent && prev.ctxUsed > 0) {
        const msgDrop = (prev.msgCount || 0) - msgCount;
        const tokenDrop = prev.ctxUsed - ctxUsed;
        // Require both: msgCount dropped by 5+ AND tokens dropped by >15% of window
        if (msgDrop >= 5 && tokenDrop / (prev.maxContext || DEFAULT_MAX_CTX) > 0.15) isCompacted = true;
        break;
      }
    }
  }

  allEntries.push({
    tokens: tok, usage, ts: e.ts, model, maxContext: e.maxContext, cost: turnCost, sessionId: sid,
    req: e.req || null, res: e.res || null, reqLoaded: !!(e.req || e.res),
    msgCount, toolCount, toolCalls: e.toolCalls || {}, stopReason,
    status: e.status, elapsed: e.elapsed, method: e.method, id: e.id,
    isSubagent, sessionInferred: e.sessionInferred || false, displayNum, ctxUsed, isCompacted, receivedAt: e.receivedAt || null,
    thinkingDuration: e.thinkingDuration || null,
    duplicateToolCalls: e.duplicateToolCalls || null,
    hasCredential: e.hasCredential || false,
    toolFail: e.toolFail || false,
    toolSources: e.toolSources || null,
    title: e.title || null,
  });

  // ── V3 turn card: five-line layout ──
  const toolFail = e.toolFail || false;
  const hasCred = e.hasCredential || false;
  const dupes = e.duplicateToolCalls || null;
  const dupesMax = dupes ? Math.max(...Object.values(dupes)) : 0;

  const ctxMax = e.maxContext || DEFAULT_MAX_CTX;
  const ctxPct = ctxUsed > 0 ? Math.min(100, ctxUsed / ctxMax * 100) : 0;
  const severity = classifySeverity({ status: e.status, stopReason, hasCredential: hasCred, toolFail }, ctxPct, dupesMax);

  const el = document.createElement('div');
  el.className = 'turn-item' + (isSubagent ? ' turn-sub' : '') + (severity ? ' risk-' + severity : '');
  el.dataset.entryIdx = idx;
  el.dataset.sessionId = sid;
  el.dataset.sessNum = displayNum;
  el.onclick = () => { setFocus('turns'); selectTurn(idx); };
  el.onmouseenter = () => { clearTimeout(_hoverTimer); _hoverTimer = setTimeout(() => prefetchEntry(idx), 150); };
  el.onmouseleave = () => clearTimeout(_hoverTimer);

  // Line 1: identity + critical marker + cost
  const prefix = isSubagent ? '↳s' + sess.subCount : '#' + displayNum;
  const modelHtml = '<span class="turn-model">' + escapeHtml(shortModel) + '</span>';
  const dotClass = e.status >= 200 && e.status < 300 ? 'status-dot status-dot-ok' : 'status-dot status-dot-err';
  const waitMark = stopReason === 'end_turn' ? '<span class="turn-wait" title="Waiting for user">↵</span>' : '';
  const critMarker = getCriticalMarker(stopReason, e.status, ctxPct);
  const critMarkerHtml = critMarker ? '<span class="turn-critical-marker">' + critMarker + '</span>' : '';
  const costHtml = turnCost != null ? '<span class="turn-cost">$' + turnCost.toFixed(4) + '</span>' : '';
  const identityTooltip = [
    isCompacted ? 'Context compacted' : null,
    e.sessionInferred ? 'Session inferred (no explicit session ID)' : null,
  ].filter(Boolean).join(' · ');
  const identityAttr = identityTooltip ? ' title="' + escapeHtml(identityTooltip) + '"' : '';
  const identityLine =
    '<div class="turn-identity"' + identityAttr + '>' +
      '<span class="turn-num">' + prefix + '</span>' +
      modelHtml +
      '<span class="' + dotClass + '" title="HTTP ' + e.status + '">●</span>' +
      waitMark +
      critMarkerHtml +
      costHtml +
    '</div>';

  // Line 2: title (omit if null or noise)
  const cleanedTitle = cleanTitle(e.title);
  const titleLine = cleanedTitle ? '<div class="turn-title">' + escapeHtml(cleanedTitle) + '</div>' : '';

  // Line 3: ctx bar (original segment proportions) + ctx:/hit: labels
  const seg = (tokens, color) => tokens > 0
    ? '<div style="width:' + (tokens / ctxMax * 100).toFixed(2) + '%;background:' + color + ';min-width:1px"></div>'
    : '';
  const totalUsed = ctxCacheRead + ctxCacheCreate + ctxInput;
  const ctxPctClass = ctxPct > 95 ? 'ctx-critical' : ctxPct > 85 ? 'ctx-warning' : '';
  const ctxPctLabel = '<span class="turn-ctx-pct' + (ctxPctClass ? ' ' + ctxPctClass : '') + '">ctx:' + ctxPct.toFixed(0) + '%</span>';
  const hitPct = totalUsed > 0 ? Math.round(ctxCacheRead / totalUsed * 100) : null;
  const hitPctClass = hitPct !== null && hitPct < 10 ? ' hit-cold' : '';
  const hitLabel = hitPct !== null ? '<span class="turn-hit-pct' + hitPctClass + '">hit:' + hitPct + '%</span>' : '';
  const ctxBarHtml = ctxUsed > 0
    ? '<div class="turn-ctx turn-ctx-bar">' +
        '<div class="turn-ctx-bar-bg">' +
          seg(ctxCacheRead,   'var(--color-cache-read)') +
          seg(ctxCacheCreate, 'var(--color-cache-write)') +
          seg(ctxInput,       'var(--color-input)') +
        '</div>' +
        '<div class="turn-ctx-labels">' + hitLabel + ctxPctLabel + '</div>' +
      '</div>'
    : '';

  // Line 4: [time-info] [tools]
  // time-info: elapsed [wait:gap] [think:N] — flex:1, can clip; tools: flex-shrink:0, always visible
  const elapsedMs = parseFloat(e.elapsed || 0) * 1000;
  const thinkSuffix = (e.thinkingDuration && e.thinkingDuration >= 0.05)
    ? '<span class="turn-think"> (think:' + e.thinkingDuration.toFixed(1) + 's)</span>'
    : '';
  let timeHtml = '';
  if (gapMs != null && gapMs >= 500) {
    timeHtml += '<span class="turn-wait-gap" style="color:' + gapColor + '" title="' + escapeHtml(gapTitle) + '">wait:' + formatGap(gapMs) + '</span>';
  }
  timeHtml += '<span class="turn-elapsed">dur:' + formatGap(elapsedMs) + thinkSuffix + '</span>';
  let chipsHtml = '';
  for (const n of Object.keys(e.toolCalls || {})) {
    chipsHtml += '<span class="tool-chip">' + escapeHtml(n.replace(/^mcp__[^_]+__/, '')) + '</span>';
  }
  const secondaryLine = '<div class="turn-secondary">' +
    (chipsHtml ? '<div class="turn-tools-row">' + chipsHtml + '</div>' : '') +
    '<div class="turn-time-row">' + timeHtml + '</div>' +
    '</div>';

  // Line 5: warning/notice risk (no emoji, plain text)
  const riskMarkers = [];
  if (hasCred) riskMarkers.push('cred');
  if (toolFail) riskMarkers.push('tool-fail');
  if (dupesMax >= 2) riskMarkers.push('dupes\xD7' + dupesMax);
  const riskLine = riskMarkers.length ? '<div class="turn-risk-line">' + riskMarkers.join(' ') + '</div>' : '';

  el.innerHTML = identityLine + titleLine + ctxBarHtml + secondaryLine + riskLine;

  // Hide turn if no session selected, or if it belongs to a different session
  if (!selectedSessionId || selectedSessionId !== sid) el.style.display = 'none';
  // Append: chronological order — oldest at top, newest at bottom
  colTurns.appendChild(el);

  if (selectedSessionId === sid) renderSessionSparkline(sid);
  if (!_loading && selectedSessionId === sid) {
    // Only auto-follow if toggle is on AND user is currently on the live edge
    // Never interrupt focused mode — user is drilling into a turn's detail
    const wasOnLiveEdge = followLiveTurn && !isFocusedMode &&
      (selectedTurnIdx === -1 || selectedTurnIdx === idx - 1);
    if (wasOnLiveEdge) {
      selectTurn(idx);
      scrollTurnsToBottom();
    } else if (followLiveTurn) {
      newTurnCount++;
      showNewTurnPill(newTurnCount);
    }
  }
}

// Initialize badge on load
setTimeout(() => updateSysPromptBadge('orchestrator'), 500);
startQuotaTicker();
// Tab restoration happens after deep-link resolution (see _loading=false path)

// SSE live connection
const evtSource = new EventSource('/_events');
evtSource.onmessage = (ev) => {
  try {
    const data = JSON.parse(ev.data);
    if (data._type === 'session_status') {
      sessionStatusMap.set(data.sessionId, { active: data.active, lastSeenAt: data.lastSeenAt });
      const sid = data.sessionId;
      const sessEl = document.getElementById('sess-' + sid.slice(0, 8));
      const sess = sessionsMap.get(sid);
      if (sessEl && sess) sessEl.innerHTML = renderSessionItem(sess, sid);
      renderProjectsCol();
      applySessionFilter();
      updateTopbarStatus();
    } else {
      addEntry(data);
    }
  } catch(err) { console.error(err); }
};

// Refresh status dots every 60s (to transition idle → offline)
setInterval(() => {
  colSessions.querySelectorAll('.session-item').forEach(el => {
    const sid = el.dataset.sessionId;
    const sess = sessionsMap.get(sid);
    if (sess) el.innerHTML = renderSessionItem(sess, sid);
  });
  renderProjectsCol();
  updateTopbarStatus();
}, 60000);

// Initialize session filter dropdown from stored value
const _sessFilterSel = document.getElementById('sess-filter-select');
if (_sessFilterSel) _sessFilterSel.value = sessionFilterMode;

// ── Deep link parsing ──
const _deepLinkParams = new URLSearchParams(location.search);
const _pendingDeepLink = {
  p: _deepLinkParams.get('p'),
  s: _deepLinkParams.get('s'),
  t: _deepLinkParams.get('t'),
  sec: _deepLinkParams.get('sec'),
  msg: _deepLinkParams.get('msg') != null ? parseInt(_deepLinkParams.get('msg')) : null,
};
const _hasDeepLink = _pendingDeepLink.p || _pendingDeepLink.s;

// Deferred deep link state for sec/msg (applied after lazy-load)
var _deferredDeepLink = null;

function applyDeepLink() {
  const dl = _pendingDeepLink;
  const failures = [];

  // Check if any entries were restored
  if (allEntries.length === 0 && (dl.s || dl.p)) {
    failures.push('No log data available');
    _showDeepLinkFailures(failures);
    return;
  }

  // Layer 1: Resolve session
  let fullSid = null;
  if (dl.s) {
    for (const [sid] of sessionsMap) {
      if (sid.startsWith(dl.s)) { fullSid = sid; break; }
    }
    if (!fullSid) {
      failures.push('Session "' + dl.s + '" not found');
    }
  }

  // Force filter to 'all' if needed
  if (fullSid) {
    const status = getStatusClass(fullSid);
    if (status === 'sdot-off' && sessionFilterMode !== 'all') {
      setSessionFilter('all');
    }
  }

  // Layer 2: Resolve project (from param or from session)
  let projName = dl.p;
  if (!projName && fullSid) {
    const sess = sessionsMap.get(fullSid);
    if (sess) projName = getProjectName(sess.cwd);
  }
  if (projName && !projectsMap.has(projName)) {
    failures.push('Project "' + projName + '" not found');
    projName = null;
  }

  if (projName) selectProject(projName);

  // Layer 3: Resolve turn (only if session resolved)
  let turnResolved = false;
  if (fullSid) {
    selectSessionAndLatestTurn(fullSid);

    if (dl.t) {
      for (let i = 0; i < allEntries.length; i++) {
        if (allEntries[i].sessionId === fullSid && allEntries[i].displayNum === dl.t) {
          selectTurn(i);
          turnResolved = true;
          break;
        }
      }
      if (!turnResolved) {
        failures.push('Turn #' + dl.t + ' not found in this session');
      }
    } else {
      turnResolved = true; // no specific turn requested
    }
  }

  // Layer 4+5: Defer section/message until lazy-load completes
  if (fullSid && (dl.sec || dl.msg != null)) {
    _deferredDeepLink = { sec: dl.sec, msg: dl.msg };
    // If turn data is already loaded, apply immediately
    if (selectedTurnIdx >= 0 && allEntries[selectedTurnIdx]?.reqLoaded) {
      _applyDeferredDeepLink();
    } else {
      // Set timeout for deferred resolution
      setTimeout(function() {
        if (_deferredDeepLink) {
          showToast('Deep link: section/message data did not load in time');
          _deferredDeepLink = null;
        }
      }, 5000);
    }
  }

  // Set focus to deepest resolved layer
  if (fullSid && turnResolved) setFocus('turns');
  else if (fullSid) setFocus('sessions');
  else if (projName) setFocus('projects');

  // URL cleanup: sync URL to reflect only resolved state
  syncUrlFromState();

  // Show coalesced failures after 500ms delay
  if (failures.length) _showDeepLinkFailures(failures);
}

function _applyDeferredDeepLink() {
  if (!_deferredDeepLink) return;
  const deferred = _deferredDeepLink;
  _deferredDeepLink = null;
  if (deferred.sec) selectSection(deferred.sec);
  if (deferred.msg != null && typeof selectMessage === 'function') selectMessage(deferred.msg);
}

function _showDeepLinkFailures(failures) {
  setTimeout(function() {
    showToast('Deep link: ' + failures.join('; '));
  }, 500);
}

// Load existing entries (suppress auto-scroll during batch load)
var _loading = true;
fetch('/_api/entries').then(r => r.json()).then(data => {
  data.forEach(addEntry);
  _loading = false;
  expireSessionPins();

  if (_hasDeepLink) {
    applyDeepLink();
  } else if (sessionsMap.size) {
    initAutoSelect();
  }
  applySessionFilter();
  setFocus(focusedCol);
  // Restore tab from URL param after deep-link resolution
  if (typeof restoreTabFromUrl === 'function') restoreTabFromUrl();
});

// Safety timeout: apply deep link after 5 seconds even if entries are still loading
if (_hasDeepLink) {
  setTimeout(() => {
    if (_loading) {
      _loading = false;
      applyDeepLink();
      applySessionFilter();
    }
  }, 5000);
}
