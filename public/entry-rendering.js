// ── Entry rendering ──
let newTurnCount = 0;
// AGENT_KEY_UNRELIABLE and WF_MAIN_AGENT_KEYS live in agent-classification.js
// (loaded before this file) so all classification sites agree (#381).

function cleanTitle(raw) {
  if (!raw) return null;
  let t = raw
    .replace(/<[^>]+>/g, '')          // strip XML/HTML tags (<system-reminder>, etc.)
    .replace(/^\s*[*#\-—=~`]+\s*/g, '') // strip leading markdown symbols
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 4 ? t : null;
}

function showNewTurnPill(count) {
  const existing = document.getElementById('new-turn-pill');
  if (existing) {
    existing.textContent = '+' + count + ' main';
    return;
  }

  const pill = document.createElement('div');
  pill.id = 'new-turn-pill';
  pill.className = 'new-turn-pill';
  pill.textContent = '+' + count + ' main';
  pill.onclick = function() {
    // Go to the latest MAIN turn, not literally the last entry — a subagent
    // turn can append after the last main turn while off-edge (codex review:
    // allEntries.length - 1 would silently select that subagent turn instead
    // of what this "+N main" pill advertises).
    const s = sessionsMap.get(selectedSessionId);
    const targetIdx = (s && s.latestMainTurnIdx != null) ? s.latestMainTurnIdx : allEntries.length - 1;
    selectTurn(targetIdx);
    scrollTurnsToBottom();
  };
}

function hideNewTurnPill() {
  const pill = document.getElementById('new-turn-pill');
  if (pill) pill.remove();
  newTurnCount = 0;
}

// Peek-only pill for subagent turns arriving while the user is on the main
// live edge (docs/designs/follow-live-turn-subagent.md Problem 1). Never
// calls selectTurn — clicking it only scrolls to reveal the subagent cards.
function showSubagentPill(count, errCount, sinceNum) {
  const hasErrors = errCount > 0;
  const text = '+' + count + ' sub' + (hasErrors ? ' · ' + errCount + ' err' : '');
  const title = count + ' subagent turns (' + errCount + ' errors)' + (sinceNum != null ? ' since main #' + sinceNum : '');
  const existing = document.getElementById('sub-turn-pill');
  if (existing) {
    existing.textContent = text;
    existing.title = title;
    existing.classList.toggle('has-errors', hasErrors);
    return;
  }

  const pill = document.createElement('div');
  pill.id = 'sub-turn-pill';
  pill.className = 'sub-pill' + (hasErrors ? ' has-errors' : '');
  pill.textContent = text;
  pill.title = title;
  pill.onclick = function() {
    scrollTurnsToBottom();
    hideSubagentPill();
  };
}

// sid defaults to selectedSessionId, but callers leaving a session (e.g.
// selectSession switching to a different one) must pass the OLD id
// explicitly — by the time they call this, selectedSessionId may already
// point at the new session. Without resetting the counters (not just
// removing the DOM node), the next qualifying subagent arrival on the
// abandoned session recreates the pill with the stale prior count/errors
// (codex review round 3).
function hideSubagentPill(sid) {
  const pill = document.getElementById('sub-turn-pill');
  if (pill) pill.remove();
  const s = sessionsMap.get(sid || selectedSessionId);
  if (s) { s.subPillCount = 0; s.subPillErrCount = 0; }
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
  const apiTotal = computeCtxUsed(usage);
  const total = apiTotal > estimatedTotal ? apiTotal : estimatedTotal;
  // Scale category segments proportionally if API total is larger
  const scale = estimatedTotal > 0 && total > estimatedTotal ? total / estimatedTotal : 1;
  const windowSize = maxContext || DEFAULT_MAX_CTX;
  const rawPct = total / windowSize * 100;
  const pct = Math.min(100, rawPct).toFixed(0);
  const usedPct = Math.min(100, rawPct);
  const barColor = ctxZone(usedPct).cssVar;

  const barDenom = Math.max(total, windowSize);
  let bar = '<div class="ctx-big-bar" style="display:flex;height:8px;border-radius:2px;overflow:visible;margin:4px 0 2px;background:var(--border)">';
  for (const c of cats) {
    if (!c.tokens) continue;
    const scaled = c.tokens * scale;
    const w = (scaled / barDenom * 100).toFixed(3);
    bar += '<div style="width:' + w + '%;background:' + (barColor || c.color) + ';min-width:1px" title="' + escapeHtml(c.label) + ': ' + Math.round(scaled).toLocaleString() + '"></div>';
  }
  bar += '</div>';

  const pctColor = ctxZone(usedPct).cssVar || 'var(--dim)';
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
  const apiTotal = computeCtxUsed(usage);
  const total = apiTotal > estimatedTotal ? apiTotal : estimatedTotal;
  const scale = estimatedTotal > 0 && total > estimatedTotal ? total / estimatedTotal : 1;
  const windowSize = maxContext || DEFAULT_MAX_CTX;
  const usedPct = Math.min(100, total / windowSize * 100);
  const barColor = ctxZone(usedPct).cssVar;

  // Each segment is a fraction of windowSize; bar total = usedPct% of full width
  const stickyDenom = Math.max(total, windowSize);
  let bar = '<div class="ctx-big-bar" style="display:flex;height:12px;border-radius:3px;overflow:visible;margin-bottom:6px;background:var(--border)">';
  for (const c of cats) {
    if (!c.tokens) continue;
    const scaled = c.tokens * scale;
    const pct = (scaled / stickyDenom * 100).toFixed(3);
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
  return !!stopReason && !['end_turn', 'tool_use', 'completed'].includes(stopReason);
}

function isProxyLifecycleShutdown(entry) {
  return entry.status === 499 && typeof entry.stopReason === 'string'
    && entry.stopReason.includes('ccxray shutdown');
}

function classifySeverity(entry, ctxPct, dupesMax) {
  if (ctxPct > 95) return 'critical';
  if (isProxyLifecycleShutdown(entry)) return 'warning';
  if (entry.status != null && !isHttpStatusOk(entry.status)) return 'critical';
  if (isAbnormalStop(entry.stopReason)) return 'critical';
  if (ctxPct > 85) return 'warning';
  if (entry.hasCredential) return 'warning';
  if (entry.toolFail) return 'warning';
  if (dupesMax >= 2) return 'notice';
  return null;
}

function getCriticalMarker(stopReason, httpStatus, ctxPct) {
  // ctx > 95%: no inline marker (left bar only)
  if (httpStatus === 499 && typeof stopReason === 'string' && stopReason.includes('ccxray shutdown')) return '!stop';
  if (httpStatus != null && !isHttpStatusOk(httpStatus)) return '!http';
  if (stopReason === 'max_tokens') return '!max';
  if (stopReason === 'length') return '!len';
  if (stopReason && stopReason !== 'end_turn' && stopReason !== 'tool_use'
      && stopReason !== 'completed'
      && stopReason !== 'max_tokens' && stopReason !== 'length'
      && stopReason !== 'content_filter') return '!stop';
  if (stopReason === 'content_filter') return '!filter';
  return null;
}


// #230 seq-layer flip machinery. _seqApplyFlips is the shared core: apply
// flips (main→sub) and unflips (sub→main, round-6 overturns) caused by the
// SEQ layer only — `_seqFlipped` marks them; agentKey/overlap/raw
// classifications are never touched — then renumber the whole session
// (numbering is arrival-ordered, so every displayNum after a flip point
// shifts). DOM cards are patched in place (class + number); the swimlane
// does its own retro (_wfSeqRetroMove / _wfSeqRebuild).
// sess._recentMainSpans may retain a flipped turn's span for up to 5 turns —
// accepted transient (spans only feed the overlap check).
function _seqApplyFlips(sid, sess, flipIds, unflipIds) {
  let mainN = 0, subN = 0, retryN = 0;
  for (let i = 0; i < allEntries.length; i++) {
    const en = allEntries[i];
    if (en.sessionId !== sid) continue;
    // GUARD (_seqFlipped ownership): every seq-layer isSubagent flip is
    // written HERE (or at the allEntries push for the arriving entry) and
    // must set _seqFlipped alongside it; non-seq flips (agentKey/overlap/
    // raw) must never set it — _seqRecomputeSession derives base
    // classification from `isSubagent && !_seqFlipped`.
    if (flipIds && flipIds.has(en.id)) { en.isSubagent = true; en._seqFlipped = true; }
    else if (unflipIds && unflipIds.has(en.id)) { en.isSubagent = false; en._seqFlipped = false; }
    const num = en.isRetry ? 'r' + (++retryN) : en.isSubagent ? 's' + (++subN) : String(++mainN);
    if (en.displayNum === num) continue;
    en.displayNum = num;
    if (window.entryById && window.entryById.has(en.id)) window.entryById.get(en.id).displayNum = num;
  }
  sess.mainCount = mainN; sess.subCount = subN; sess.retryCount = retryN;
}

// #230 R1 retro: a closed bracket means turns previously numbered as main
// were actually a sequential excursion (teammate/fan-out).
function _seqRetroFlip(sid, sess, closedTurns) {
  _seqApplyFlips(sid, sess, new Set(closedTurns.map(t => t.id)), null);
}

// #230 codex P2 round 6: full seq-layer recompute for one session, mirroring
// the swimlane's _wfSeqRebuild. An earlier-starting turn arriving late can
// overturn seq flips this file already applied — including flipping a
// closed excursion BACK to main. Replay the session against a fresh tracker
// in (receivedAt, id) order: base-classified subagents (agentKey/overlap —
// isSubagent && !_seqFlipped) feed as split evidence, main candidates feed
// as candidates; diff the resulting seq-flip set against the current one
// and apply both directions. Overlap spans stay forward-only (pre-existing
// ADR 0008 boundary, ADR 0009). Returns the current arrival's placement.
function _seqRecomputeSession(sid, sess, currentSeqTurn) {
  const tracker = wfCreateSeqTracker();
  sess._seqTracker = tracker;
  const replay = [];
  for (let i = 0; i < allEntries.length; i++) {
    const en = allEntries[i];
    if (en.sessionId !== sid || en.isRetry) continue; // retries: neither evidence nor candidates
    // GUARD (_seqFlipped ownership): baseSub strips ONLY seq-layer flips —
    // it must stay `isSubagent && !_seqFlipped`; using raw isSubagent here
    // would feed seq excursions as split evidence and lock them in.
    replay.push({ id: en.id, convId: en.convId || null, msgCount: en.msgCount, receivedAt: en.receivedAt,
                  elapsed: en.elapsed, baseSub: !!(en.isSubagent && !en._seqFlipped), en });
  }
  // the current arrival is not in allEntries yet; it reached here as a
  // main candidate (already past the agentKey + overlap checks)
  replay.push(Object.assign({}, currentSeqTurn, { baseSub: false, en: null }));
  replay.sort((a, b) => {
    const ta = Number(a.receivedAt) || 0, tb = Number(b.receivedAt) || 0;
    return (ta - tb) || (String(a.id) < String(b.id) ? -1 : 1);
  });
  const newFlipped = new Set();
  let currentPlace = 'main';
  for (const r of replay) {
    if (r.baseSub) { wfSeqFeedSplit(tracker, r); continue; }
    const v = wfSeqFeedMain(tracker, r);
    if (v.place === 'excursion') { if (r.en) newFlipped.add(r.id); else currentPlace = 'excursion'; }
    if (v.closed) for (const t of v.closed) {
      if (t.id === currentSeqTurn.id) currentPlace = 'excursion';
      else newFlipped.add(t.id);
    }
  }
  const flipIds = new Set(), unflipIds = new Set();
  for (const r of replay) {
    if (!r.en) continue;
    const cur = !!r.en._seqFlipped;
    const next = newFlipped.has(r.id);
    if (!cur && next) flipIds.add(r.id);
    else if (cur && !next) unflipIds.add(r.id);
  }
  if (flipIds.size || unflipIds.size) _seqApplyFlips(sid, sess, flipIds, unflipIds);
  return currentPlace;
}

// ponytail: hover-prefetch cold session entries (#332)
var _coldPrefetchTimer = null;
function _attachColdPrefetch(el, sid) {
  el.onmouseenter = function() {
    clearTimeout(_coldPrefetchTimer);
    _coldPrefetchTimer = setTimeout(function() {
      var sess = sessionsMap.get(sid);
      if (!sess || !sess._cold || sess._prefetching || sess._prefetchedEntries) return;
      sess._prefetching = true;
      fetch(_apiQ('/_api/session/' + encodeURIComponent(sid) + '/entries'))
        .then(function(r) { return r.json(); })
        .then(function(data) { sess._prefetchedEntries = data; sess._prefetching = false; })
        .catch(function() { sess._prefetching = false; });
    }, 150);
  };
  el.onmouseleave = function() { clearTimeout(_coldPrefetchTimer); };
}

function _foldSessionCost(sess, turnCost, costConfidence) {
  // INVARIANT(#420/ADR 0017): session confidence fields must mirror every
  // totalCost mutation, including cold entries and rebuilds.
  if (turnCost != null && costConfidence === 'fallback') {
    sess.fallbackCost = (sess.fallbackCost || 0) + turnCost;
    sess.fallbackCount = (sess.fallbackCount || 0) + 1;
  }
  if (turnCost == null && costConfidence === 'unknown') {
    sess.unknownCount = (sess.unknownCount || 0) + 1;
  }
}

function addEntry(e) {
  // Dedup: SSE + on-demand fetch race can deliver the same entry twice
  if (e.id && window.entryById && window.entryById.has(e.id)) return;
  if (e.imported && window.ccxraySettings?.hideImported) return;
  const idx = entryCount++;

  const sid = e.sessionId || 'unknown';
  const model = e.model || e.req?.model || '?';
  const msgCount = e.msgCount != null ? e.msgCount : (e.req?.messages?.length || 0);
  const toolCount = e.toolCount != null ? e.toolCount : (e.req?.tools?.length || 0);
  const stopReason = e.stopReason != null ? e.stopReason : '';
  const tok = e.tokens || {};
  const usage = e.usage || null;
  const turnCost = e.cost?.cost != null ? e.cost.cost : (typeof e.cost === 'number' ? e.cost : null);
  const costConfidence = e.cost?.confidence || null;

  // Session tracking — properly deduplicated by ID
  const entryId = e.id || '';
  const entryCwd = e.cwd || null;
  if (!sessionsMap.has(sid)) {
    const shortSid = sid.slice(0, 8);
    sessionsMap.set(sid, { id: sid, firstTs: e.ts, firstId: entryId, lastId: entryId, count: 0, mainCount: 0, subCount: 0, retryCount: 0, model, totalCost: 0, fallbackCost: 0, fallbackCount: 0, unknownCount: 0, cwd: entryCwd, title: null, titleReqTs: 0, lastAssistantText: null, agent: e.agent || 'claude', provider: e.provider || 'anthropic', latestCacheHitRatio: 0, latestCacheReadTokens: 0, resumeCommand: null, parentSessionId: e.parentSessionId || null, firstReceivedAt: 0 });
    // Live-update visibleProviders when a new provider appears
    const settings = window.ccxraySettings;
    if (!Array.isArray(settings.visibleProviders)) settings.visibleProviders = [];
    const entryProvider = e.provider || 'anthropic';
    if (!settings.visibleProviders.includes(entryProvider)) {
      settings.visibleProviders.push(entryProvider);
      if (typeof renderNotifyButton === 'function') renderNotifyButton();
    }
    const sessEl = document.createElement('div');
    sessEl.className = 'session-item';
    sessEl.dataset.sessionId = sid;
    sessEl.id = 'sess-' + shortSid;
    sessEl.onclick = () => selectSession(sid);
    _attachColdPrefetch(sessEl, sid);
    if (_loading) {
      // ponytail: defer rendering to post-batch pass (#332) — just create the
      // DOM node so getElementById finds it; post-batch overwrites innerHTML
      sessEl.style.display = 'none';
      colSessions.appendChild(sessEl);
    } else {
      sessEl.innerHTML = renderSessionItem(sessionsMap.get(sid), sid, sessEl);
      const firstSession = colSessions.querySelector('.session-item');
      if (firstSession) colSessions.insertBefore(sessEl, firstSession);
      else colSessions.appendChild(sessEl);
      applySessionFilter();
    }
  }
  const sess = sessionsMap.get(sid);
  // #330: a mergeColdSessions race (the sessions API resolving before the
  // entries batch) can mark a hot session `_cold` while `_loading`, before its
  // own batch entries reach addEntry. Those entries then arrive here, find the
  // session already in sessionsMap, skip the creation block above, and leave
  // `_cold` set — so the session shows a permanent "Loading N turns" spinner and
  // the post-batch recompute (which skips `_cold` sessions) keeps its stub stats.
  // Promote it: reaching this addEntry during the batch means the session's full
  // history is flowing into allEntries, so clearing `_cold` lets the post-batch
  // recompute rebuild real stats from allEntries. Scoped to `_batchRestoring`
  // (not `_loading` — SSE live entries also arrive during `_loading`; promoting
  // on those would break a genuine cold session that happens to receive a live
  // turn during startup). See issue #330 (G1 + G2).
  if (_batchRestoring && sess._cold) {
    sess._cold = false;
    if (sess.firstTs == null) sess.firstTs = e.ts;
  }
  if (e.truncated) { sess.truncated = true; sess.totalEntryCount = e.totalEntryCount; }
  // Resume command is computed server-side (single source of truth). Sticky:
  // once any turn reports a command, keep it even if later turns lack usage.
  if (e.resumeCommand) sess.resumeCommand = e.resumeCommand;
  // Update cwd if not yet known or was only a quota-check
  const prevProjectName = getProjectName(sess.cwd);
  if (entryCwd && (!sess.cwd || sess.cwd === '(quota-check)') && sess.cwd !== entryCwd) {
    sess.cwd = entryCwd;
  }
  if (model && model !== '?') sess.model = model;
  if (e.firstPrompt && !sess.firstPrompt) sess.firstPrompt = e.firstPrompt;
  sess.lastId = entryId;
  // #426: min-fold for duration (finite-positive guard — receivedAt can be null/0)
  if (e.receivedAt) {
    var ra = Number(e.receivedAt);
    if (ra > 0 && (!sess.firstReceivedAt || ra < sess.firstReceivedAt)) sess.firstReceivedAt = ra;
    sess.lastReceivedAt = ra;
  }
  // Prefer the server-detected agent identity (from system-prompt content,
  // via agentKey) over the raw isSubagent flag when available — codex review:
  // isAnthropicSubagent() in store.js classifies by !cwd && !session_id, but
  // current Claude Code Task-tool subagents carry the parent's session_id, so
  // isSubagent is false for exactly the common subagent case. agentKey isn't
  // fooled by that (same authoritative signal wfInferLanes already uses in
  // workflow-timeline.js, loaded before this file — WF_MAIN_AGENT_KEYS).
  //
  // Only trust agentKey to force isSubagent=true for keys we're actually
  // confident are non-main — never for AGENT_KEY_UNRELIABLE ('unknown', the
  // extractAgentType() catch-all default; 'agent', its regex-fallback default
  // when role extraction fails). Those come from the SAME regex fallback that
  // handles genuinely new/unrecognized prompts (server/system-prompt.js) —
  // a future main-agent variant could hit it too, and forcing it to subagent
  // would silently break auto-follow for legitimate main content (codex
  // review round 3). For those, fall back to the raw flag as before.
  // INVARIANT: gate on AGENT_KEY_UNRELIABLE — see docs/decisions/0005-agent-key-unreliable-shared-contract.md
  let isSubagent = e.agentKey && !AGENT_KEY_UNRELIABLE[e.agentKey]
    ? (typeof WF_MAIN_AGENT_KEYS !== 'undefined' ? !WF_MAIN_AGENT_KEYS[e.agentKey] : !!e.isSubagent)
    : (e.isSubagent || false);
  // INVARIANT: coreHash identity routing — teammate with a main-agent key
  // (e.g. 'orchestrator') but a different coreHash. Must agree with
  // workflow-timeline.js (ADR 0005/0010). Gated on wfState.sessionId === sid:
  // wfState is the swimlane's CURRENTLY VIEWED session, which is not
  // necessarily this entry's session while other sessions stream live —
  // trusting a foreign session's mainCoreHash/mainConvIds here would
  // misclassify that session's own main turns.
  if (!isSubagent && e.agentKey && typeof WF_MAIN_AGENT_KEYS !== 'undefined' && WF_MAIN_AGENT_KEYS[e.agentKey] &&
      typeof wfState !== 'undefined' && wfState && wfState.sessionId === sid && wfState.mainCoreHash &&
      e.coreHash && e.coreHash !== wfState.mainCoreHash &&
      e.convId && wfState.mainConvIds && !wfState.mainConvIds.has(e.convId)) {
    isSubagent = true;
  }
  const isRetry = !isSubagent && !isHttpStatusOk(e.status) && !(usage && usage.output_tokens > 0);
  // #222: temporal overlap — mirrors wfAddEntry's parallel-fork detection so
  // the turn list and swimlane agree on classification (ADR 0005 contract).
  // Runs after isRetry so retries are never reclassified. Only flags overlap
  // when start is strictly between another turn's [start, end) — same
  // receivedAt means sequential, not parallel.
  if (!isSubagent && !isRetry) {
    const entryStart = Number(e.receivedAt) || 0;
    const spans = sess._recentMainSpans || [];
    for (let ri = spans.length - 1; ri >= 0; ri--) {
      if (entryStart > 0 && entryStart > spans[ri][0] && entryStart < spans[ri][1]) {
        isSubagent = true; break;
      }
    }
  }
  // #230 sequential interleave: agentKey and overlap can't see a sequential
  // teammate/fork. The shared tracker (workflow-timeline.js, loaded first)
  // classifies: R2 same-conv msgCount dips that continue a split-out
  // frontier flip to subagent HERE, before numbering; R1 foreign-conv runs
  // stay provisionally main and are retro-flipped by _seqRetroFlip when the
  // trunk conv returns. Retries carry the original request's msgCount —
  // they are neither frontier evidence nor main candidates.
  // INVARIANT: same tracker semantics as wfInferLanes/wfAddEntry — see
  // docs/decisions/0009-sequential-interleave-conv-bracketing.md
  let seqVerdict = null, seqFlipped = false;
  if (typeof wfCreateSeqTracker === 'function' && !isRetry) {
    if (!sess._seqTracker) sess._seqTracker = wfCreateSeqTracker();
    const seqTurn = { id: entryId, convId: e.convId || null, msgCount, receivedAt: e.receivedAt, elapsed: e.elapsed };
    if (isSubagent) {
      wfSeqFeedSplit(sess._seqTracker, seqTurn);
    } else {
      seqVerdict = wfSeqFeedMain(sess._seqTracker, seqTurn);
      // codex P2 round 6 (mirrors wfAddEntry's round-5 rebuild): an
      // earlier-starting turn arriving late can overturn seq flips this
      // file already applied — including flipping a closed excursion BACK
      // to main. Recompute the session's seq layer from scratch so the
      // turn list converges with the rebuilt swimlane.
      // INVARIANT: reordered convergence is two-sided — this recompute and
      // wfAddEntry's _wfSeqRebuild fire on the same flag; removing either
      // side recreates the ADR 0005 round-4 divergence shape — see
      // docs/decisions/0009-sequential-interleave-conv-bracketing.md
      if (seqVerdict.reordered) {
        if (_seqRecomputeSession(sid, sess, seqTurn) === 'excursion') { isSubagent = true; seqFlipped = true; }
        seqVerdict = null; // closed brackets were handled inside the recompute
      } else if (seqVerdict.place === 'excursion') { isSubagent = true; seqFlipped = true; }
    }
    if (seqVerdict && seqVerdict.closed) _seqRetroFlip(sid, sess, seqVerdict.closed);
  }
  // Track recent main turn [start, end] spans for temporal overlap detection (#222)
  if (!isSubagent && !isRetry) {
    const startMs = Number(e.receivedAt) || 0;
    const endMs = startMs + (parseFloat(e.elapsed) || 0) * 1000;
    if (startMs > 0 && endMs > startMs) {
      if (!sess._recentMainSpans) sess._recentMainSpans = [];
      sess._recentMainSpans.push([startMs, endMs]);
      if (sess._recentMainSpans.length > 5) sess._recentMainSpans.shift();
    }
  }
  if (!isSubagent && e.title) {
    const t = cleanTitle(e.title);
    if (t) {
      sess.lastAssistantText = t;
      if (e.provider === 'openai' && !sess.title) {
        sess.title = t;
        sess.titleReqTs = e.receivedAt || 0;
      }
    }
  }
  // Project tracking
  const projName = getProjectName(sess.cwd);
  // sess.cwd only changes in the migration block above and getProjectName is
  // pure, so a differing project name is exactly "the cwd was migrated".
  if (prevProjectName && prevProjectName !== projName) {
    const prevProj = projectsMap.get(prevProjectName);
    if (prevProj) {
      prevProj.sessionIds.delete(sid);
      if (prevProj.sessionIds.size === 0 && prevProjectName !== selectedProjectName) projectsMap.delete(prevProjectName);
    }
  }
  if (!projectsMap.has(projName)) {
    projectsMap.set(projName, { name: projName, totalCost: 0, fallbackCost: 0, fallbackCount: 0, unknownCount: 0, count: 0, sessionIds: new Set(), firstId: entryId, lastId: entryId, lastSeenAt: Date.now() });
  }
  const proj = projectsMap.get(projName);
  proj.sessionIds.add(sid);
  proj.lastId = entryId;
  proj.lastSeenAt = Date.now();
  if (!_loading && !window._coldActivating) renderProjectsCol();

  const statusClass = isHttpStatusOk(e.status) ? 'status-ok' : 'status-err';
  const displayModel = (model && model !== '?') ? model : (sess.model || '?');
  const shortModelStr = shortModel(displayModel);

  const ctxCacheCreate = usage ? (usage.cache_creation_input_tokens || 0) : 0;
  const ctxCacheRead   = usage ? (usage.cache_read_input_tokens || 0) : 0;
  const ctxInput       = usage ? (usage.input_tokens || 0) : 0;
  const ctxUsed = computeCtxUsed(usage);

  // Update session context alert badge + cache stats for main turns
  if (!isSubagent && ctxUsed > 0) {
    // #339: store the RAW numerator (ctxUsed) only. The per-session context% denominator
    // (sessionCtxWindow) is folded at RENDER time in renderSessionItem, never baked here —
    // so it cannot go stale when a later turn's beta1m grows the session window (the
    // reverted sess.maxWindow staleness, 8b6789f). Classification/severity keeps raw
    // per-turn maxContext (below), unchanged.
    sess.latestMainCtxUsed = ctxUsed;
    sess.latestCacheReadTokens = ctxCacheRead;
    const ctxInputTotal = ctxCacheRead + ctxCacheCreate + (usage ? (usage.input_tokens || 0) : 0);
    sess.latestCacheHitRatio = ctxInputTotal > 0 ? ctxCacheRead / ctxInputTotal : 0;
    if (!window._coldActivating) {
      const sessElCtx = document.getElementById('sess-' + sid.slice(0, 8));
      if (sessElCtx) sessElCtx.innerHTML = renderSessionItem(sess, sid, sessElCtx);
    }
  }

  // Gap timing: idle time from end of previous turn to start of this turn
  let prevInSession = null;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    if (allEntries[i].sessionId === sid && !allEntries[i].isRetry && allEntries[i].receivedAt) { prevInSession = allEntries[i]; break; }
  }
  let gapMs = null, gapColor = '', gapTitle = '';
  if (prevInSession && e.receivedAt) {
    const prevEnd = Number(prevInSession.receivedAt) + parseFloat(prevInSession.elapsed || 0) * 1000;
    const rawGap = Number(e.receivedAt) - prevEnd;
    gapMs = Number.isFinite(rawGap) ? Math.max(0, rawGap) : null;
    if (gapMs !== null) {
      gapColor = gapMs < 5 * 60000 ? 'var(--green)' : gapMs < 60 * 60000 ? 'var(--yellow)' : 'var(--red)';
      const cacheMode = typeof getCacheMode === 'function' ? getCacheMode(e.provider || 'anthropic') : 'ephemeral-ttl';
      gapTitle = cacheMode === 'ephemeral-ttl'
        ? (gapMs < 5 * 60000 ? 'Cache likely warm (< 5m)' : gapMs < 60 * 60000 ? 'Default cache expired (5m–1h)' : 'All cache expired (> 1h)')
        : 'Cached automatically';
    }
  }

  const cacheTtlMs = window.ccxraySettings?.cacheTtlMs;
  if (gapMs !== null && cacheTtlMs && gapMs > cacheTtlMs) {
    sess.cacheBreaks = (sess.cacheBreaks || 0) + 1;
    sess.idleMs = (sess.idleMs || 0) + gapMs;
  }

  // Compression detection: compare message count AND context tokens vs previous main turn.
  // True compaction = msgCount drops significantly (messages got summarized/removed).
  // Token-only drops can happen from cache eviction or normal conversation flow.
  let isCompacted = false;
  if (!isSubagent && ctxUsed > 0 && msgCount > 0) {
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const prev = allEntries[i];
      if (prev.sessionId === sid && !prev.isSubagent && !prev.isRetry && prev.ctxUsed > 0) {
        const msgDrop = (prev.msgCount || 0) - msgCount;
        const tokenDrop = prev.ctxUsed - ctxUsed;
        // Require both: msgCount dropped by 5+ AND tokens dropped by >15% of window
        if (msgDrop >= 5 && tokenDrop / (prev.maxContext || DEFAULT_MAX_CTX) > 0.15) isCompacted = true;
        break;
      }
    }
  }
  if (isCompacted) sess.compactCount = (sess.compactCount || 0) + 1;

  // Per-turn severity (context / HTTP status / abnormal stop). #332 removed the
  // turn-column DOM that used to carry `.risk-*`, so severity now lives on the
  // entry (data-layer single source) and is surfaced on the swimlane turn bar
  // (data-severity + wf-b-<sev>) — critical turns stay visible without the column.
  const _dupes = e.duplicateToolCalls || null;
  const _dupesMax = _dupes ? Math.max(...Object.values(_dupes)) : 0;
  const _ctxPct = ctxUsed > 0 ? Math.min(100, ctxUsed / (e.maxContext || DEFAULT_MAX_CTX) * 100) : 0;
  // INVARIANT: severity field consumed by workflow-timeline.js wfRenderLaneSvg
  const severity = classifySeverity({ ...e, stopReason }, _ctxPct, _dupesMax);

  allEntries.push({
    // #339: beta1m rides the client entry so sessionCtxWindow() + the swimlane lane fold
    // can derive a per-session 1M denominator. Only true carries meaning (monotone OR).
    beta1m: e.beta1m === true,
    tokens: tok, usage, ts: e.ts, model, maxContext: e.maxContext, cost: turnCost, costConfidence, sessionId: sid,
    severity,
    req: e.req || null, res: e.res || null, reqLoaded: !!(e.req || e.res),
    msgCount, toolCount, toolCalls: e.toolCalls || {}, turnToolCalls: e.turnToolCalls || null, stopReason,
    status: e.status, elapsed: e.elapsed, method: e.method, id: e.id,
    // GUARD (_seqFlipped ownership): true iff the seq layer flipped THIS
    // arrival (R2 stitch / reordered recompute) — see _seqApplyFlips guard
    isSubagent, isRetry, _seqFlipped: seqFlipped, sessionInferred: e.sessionInferred || false, displayNum: null, ctxUsed, isCompacted, receivedAt: e.receivedAt || null,
    thinkingDuration: e.thinkingDuration || null,
    duplicateToolCalls: e.duplicateToolCalls || null,
    hasCredential: e.hasCredential || false,
    toolFail: e.toolFail || false, turnToolFail: e.turnToolFail || undefined,
    toolSources: e.toolSources || null,
    title: e.title || null,
    coreHash: e.coreHash || null,
    agentKey: e.agentKey || null,
    agentLabel: e.agentLabel || null,
    convId: e.convId || null,
    toolsHash: e.toolsHash || null,
    thinkingStripped: e.thinkingStripped || false,
    provider: e.provider || 'anthropic',
    agent: e.agent || null,
    cwd: e.cwd || null,
  });

  // #308: derive session/project stats from entries
  // #308: three stat-update paths, all producing correct displayNum counts.
  // Live (hot): full recompute from allEntries (idempotent, O(n) per entry).
  // Batch: increment counts for displayNum; defer full recompute to post-batch.
  // Cold: increment all stats (entries not in allEntries; full recompute on activation).
  if (!_loading && !sess._cold && !window._coldActivating) {
    recomputeSessionStats(sid);
    recomputeProjectCost(projName);
    if (prevProjectName && prevProjectName !== projName) recomputeProjectCost(prevProjectName);
  } else {
    // Incremental counts — needed for displayNum during batch/cold
    sess.count++;
    if (isRetry) sess.retryCount = (sess.retryCount || 0) + 1;
    else if (isSubagent) sess.subCount++;
    else sess.mainCount++;
    if (sess._cold) {
      // ponytail: cold session — full stats increment; recompute on activation
      if (turnCost != null) sess.totalCost += turnCost;
      _foldSessionCost(sess, turnCost, costConfidence);
      if (usage) {
        sess.inputTokens = (sess.inputTokens || 0) + (usage.input_tokens || 0);
        sess.outputTokens = (sess.outputTokens || 0) + (usage.output_tokens || 0);
      }
      // #427: prefer turnToolCalls (per-turn delta, exact) over toolCalls
      // (cumulative from request history — sum inflates quadratically).
      // Legacy fallback: per-tool max (~26% undercount, documented).
      // INVARIANT (ADR 0018): null/undefined means legacy or missing response
      // data; {} means parsed zero-call response and is truthy, so only the
      // nullish case may fall back to cumulative toolCalls.
      {
        const tc = e.turnToolCalls || null;
        const legacy = !tc && e.toolCalls && Object.keys(e.toolCalls).length > 0;
        const src = tc || (legacy ? e.toolCalls : null);
        if (src && Object.keys(src).length > 0) {
          if (!sess.toolCalls) sess.toolCalls = {};
          for (const [name, cnt] of Object.entries(src)) {
            sess.toolCalls[name] = tc
              ? (sess.toolCalls[name] || 0) + cnt
              : Math.max(sess.toolCalls[name] || 0, cnt);
          }
          sess.toolCallTurns = (sess.toolCallTurns || 0) + 1;
          // #438: prefer turnToolFail (per-turn) over toolFail (cumulative)
          if (e.turnToolFail !== undefined ? e.turnToolFail : e.toolFail) sess.toolFailTurns = (sess.toolFailTurns || 0) + 1;
        }
      }
      if (!_loading && !window._coldActivating) {
        recomputeProjectCost(projName);
        if (prevProjectName && prevProjectName !== projName) recomputeProjectCost(prevProjectName);
      }
    }
    if (_loading) {
      if (!_dirtySessions) _dirtySessions = new Set();
      _dirtySessions.add(sid);
    }
  }
  const displayNum = isRetry ? ('r' + sess.retryCount) : isSubagent ? ('s' + sess.subCount) : String(sess.mainCount);
  allEntries[allEntries.length - 1].displayNum = displayNum;
  if (entryId && window.entryById) {
    window.entryById.set(entryId, { id: entryId, sessionId: sid, cwd: entryCwd, receivedAt: e.receivedAt || null, displayNum });
  }
  // Re-render session card after stats are fresh (suppressed during batch)
  if (!_loading && !window._coldActivating) {
    const sessEl = document.getElementById('sess-' + sid.slice(0, 8));
    if (sessEl) {
      sessEl.innerHTML = renderSessionItem(sess, sid, sessEl);
      const firstSession = colSessions.querySelector('.session-item');
      if (firstSession && firstSession !== sessEl) colSessions.insertBefore(sessEl, firstSession);
    }
  }

  // Workflow timeline: incremental update for live entries (direct or child session).
  // Retries reach wfAddEntry too (no !isRetry gate here): its eligibility gate
  // (#236) fault-marks them, matching the batch wfInferLanes path — otherwise a
  // live retry would never get a fault marker while a refresh would (parity break).
  // NOTE: the SEPARATE seq-tracker feed above stays gated on !isRetry — retries
  // must never feed the tracker; only this render dispatch admits them.
  if (typeof wfState !== 'undefined' && wfState) {
    var isDirectSession = sid === selectedSessionId;
    var isChildSession = !isDirectSession && sessionsMap.get(sid)?.parentSessionId === selectedSessionId;
    if (isDirectSession || isChildSession) {
      // wfAddEntry caller contract: the entry is already in allEntries
      // (pushed above) — its reordered-rebuild path recomputes from there.
      var lastEntry = allEntries[allEntries.length - 1];
      var wfResult = wfAddEntry(lastEntry);
      if (wfResult.lanesChanged) wfRenderTimeline();
      else wfDeferRender();
    }
  }

  if (isRetry) return;

  if (selectedSessionId === sid) renderSessionSparkline(sid);
  // Track unconditionally (not gated by !_loading) — codex review: this was
  // previously only set while live, so a session restored from history had
  // it unset until the first live main turn, meaning that very first live
  // turn was never recognized as "on the live edge" even though a user
  // viewing the just-loaded latest turn genuinely is on it.
  const prevMainIdx = sess.latestMainTurnIdx;
  if (!isSubagent) sess.latestMainTurnIdx = idx;
  if (!_loading && !window._coldActivating && selectedSessionId === sid) {
    // Only auto-follow if toggle is on AND user is currently on the live edge
    // Never interrupt focused mode (drill-down); workflow split view is the default
    // state and must keep following live turns.
    // Subagent turns never auto-select (docs/designs/follow-live-turn-subagent.md
    // Problem 1) — heavy subagent activity would otherwise yank the detail panel
    // away from the main thread on every turn. They bump a peek-only "+N sub"
    // pill instead, tracked on sess so switching sessions needs no manual reset.
    if (isSubagent) {
      const wasOnMainLiveEdge = followLiveTurn && !isFocusedMode &&
        (selectedTurnIdx === -1 || selectedTurnIdx === sess.latestMainTurnIdx);
      if (wasOnMainLiveEdge) {
        sess.subPillCount = (sess.subPillCount || 0) + 1;
        if (!isHttpStatusOk(e.status)) sess.subPillErrCount = (sess.subPillErrCount || 0) + 1;
        showSubagentPill(sess.subPillCount, sess.subPillErrCount || 0, allEntries[sess.latestMainTurnIdx]?.displayNum);
      }
      // Off the main live edge: subagent turns append silently, no pill bump.
    } else {
      const wasOnLiveEdge = followLiveTurn && !isFocusedMode &&
        (selectedTurnIdx === -1 || selectedTurnIdx === prevMainIdx);
      if (wasOnLiveEdge) {
        // In workflow L1 mode, use the suppressed-highlight path so all
        // selectTurn side-effects fire (prefetch, breadcrumb, step clear)
        // but wfHighlightTurn is suppressed — L1 is preserved.
        if (typeof wfState !== 'undefined' && wfState && wfState.selectionLevel === 'L1') {
          if (typeof _wfShowTurnDetail === 'function') _wfShowTurnDetail(allEntries[idx]);
          if (typeof wfDeferRender === 'function') wfDeferRender();
        } else {
          selectTurn(idx);
        }
        scrollTurnsToBottom();
        sess.subPillCount = 0;
        sess.subPillErrCount = 0;
        hideSubagentPill();
      } else if (followLiveTurn) {
        newTurnCount++;
        showNewTurnPill(newTurnCount);
      }
    }
  }
}

// ── Recompute session/project stats from entries (pure function) ──
// Called after cold session activation to rebuild accumulators from entries
// instead of accumulating on top of sessions.json seed values.
function recomputeSessionStats(sid) {
  const sess = sessionsMap.get(sid);
  if (!sess) return;
  zeroSessionStats(sess);
  for (var i = 0; i < allEntries.length; i++) {
    var en = allEntries[i];
    if (en.sessionId !== sid) continue;
    sess.count++;
    var cost = typeof en.cost === 'number' ? en.cost : (en.cost?.cost != null ? en.cost.cost : null);
    if (en.isRetry) sess.retryCount++;
    else if (en.isSubagent) sess.subCount++;
    else sess.mainCount++;
    if (cost != null) sess.totalCost += cost;
    _foldSessionCost(sess, cost, en.costConfidence);
    if (en.usage) {
      sess.inputTokens += en.usage.input_tokens || 0;
      sess.outputTokens += en.usage.output_tokens || 0;
    }
    // #427: same turnToolCalls preference as the hot path above
    // INVARIANT (ADR 0018): null/undefined means legacy or missing response
    // data; {} means parsed zero-call response and is truthy, so only the
    // nullish case may fall back to cumulative toolCalls.
    {
      var tc = en.turnToolCalls || null;
      var legacy = !tc && en.toolCalls && Object.keys(en.toolCalls).length > 0;
      var src = tc || (legacy ? en.toolCalls : null);
      if (src && Object.keys(src).length > 0) {
        sess.toolCallTurns++;
        Object.entries(src).forEach(function(kv) {
          sess.toolCalls[kv[0]] = tc
            ? (sess.toolCalls[kv[0]] || 0) + kv[1]
            : Math.max(sess.toolCalls[kv[0]] || 0, kv[1]);
        });
        // #438: prefer turnToolFail (per-turn) over toolFail (cumulative)
        if (en.turnToolFail !== undefined ? en.turnToolFail : en.toolFail) sess.toolFailTurns++;
      }
    }
  }
  if (typeof assessWeather === 'function') {
    var weatherTurns = [];
    for (var wi = 0; wi < allEntries.length; wi++) {
      if (allEntries[wi].sessionId === sid && !allEntries[wi].isSubagent && !allEntries[wi].isRetry) weatherTurns.push(allEntries[wi]);
    }
    sess.weather = assessWeather(weatherTurns, { sessionWindow: sessionCtxWindow(sid) });
  }
}

function recomputeProjectCost(projName) {
  var proj = projectsMap.get(projName);
  if (!proj) return;
  // INVARIANT(#420/ADR 0017): project cost is the complete fold of member
  // sessions, including unknown turns in the count denominator.
  proj.totalCost = 0;
  proj.fallbackCost = 0;
  proj.fallbackCount = 0;
  proj.unknownCount = 0;
  proj.count = 0;
  proj.sessionIds.forEach(function(sid) {
    var s = sessionsMap.get(sid);
    if (s) {
      proj.totalCost += s.totalCost || 0;
      proj.fallbackCost += s.fallbackCost || 0;
      proj.fallbackCount += s.fallbackCount || 0;
      proj.unknownCount += s.unknownCount || 0;
      proj.count += s.count || 0;
    }
  });
}
window.recomputeSessionStats = recomputeSessionStats;
window.recomputeProjectCost = recomputeProjectCost;

// ── Merge cold sessions from session index into sessionsMap + DOM + projectsMap ──
function mergeColdSessions(sessions) {
  const widenedSessionIds = new Set();
  for (const s of sessions) {
    if (!s || !s.sid) continue;
    if (s.importedOnly && window.ccxraySettings?.hideImported) continue;
    if (sessionsMap.has(s.sid)) {
      var existing = sessionsMap.get(s.sid);
      if (!existing.title && s.title) existing.title = s.title;
      if (!existing.firstPrompt && s.firstPrompt) existing.firstPrompt = s.firstPrompt;
      if (s.weather && !existing.weather) existing.weather = s.weather;
      // #377: beta1m/maxContext are exempt from the #367 rule below. That rule guards
      // against cold *approximations* (e.g. latestCtxPct-derived values) overwriting
      // accurate hot computations. These two are facts folded server-side across the
      // whole session (gated on !isSubagent), and the merge is monotone max/OR — it can
      // only widen the window, never narrow it, so it cannot degrade a hot value. A hot
      // session truncated by RESTORE_DAYS / SESSION_ENTRY_CAP has strictly less evidence
      // than the server fold. See ADR 0013 + #377.
      var windowWidened = false;
      if (s.beta1m === true && existing.beta1m !== true) {
        existing.beta1m = true;
        windowWidened = true;
      }
      if ((s.maxContext || 0) > (existing.maxContext || 0)) {
        existing.maxContext = s.maxContext;
        windowWidened = true;
      }
      // #426: firstReceivedAt is a monotone min-fold (can only move earlier).
      // Same exemption as beta1m/maxContext: the server fold covers the whole
      // session; a hot session truncated by RESTORE_DAYS may lack early entries.
      if (s.firstReceivedAt > 0 && (!existing.firstReceivedAt || s.firstReceivedAt < existing.firstReceivedAt)) {
        existing.firstReceivedAt = s.firstReceivedAt;
      }
      if (windowWidened) widenedSessionIds.add(s.sid);
      // #367: merge cold derived fields ONLY when the hot session truly lacks them.
      // Hot sessions compute these from entries — never overwrite with cold fallbacks.
      if (!existing._cold) continue;
      continue;
    }
    sessionsMap.set(s.sid, {
      id: s.sid, firstTs: null, firstId: s.firstId || '', lastId: s.lastId || '',
      count: s.count || 0, mainCount: s.count || 0, subCount: 0, retryCount: 0,
      model: s.model || '?', totalCost: s.totalCost || 0,
      fallbackCost: s.fallbackCost || 0, fallbackCount: s.fallbackCount || 0, unknownCount: s.unknownCount || 0,
      cwd: s.cwd || null,
      title: s.title || null, firstPrompt: s.firstPrompt || null, titleReqTs: 0, lastAssistantText: null,
      maxContext: s.maxContext || 0, beta1m: s.beta1m || false,
      agent: s.agent || 'claude', provider: s.provider || 'anthropic',
      // #367: derived fields from session index for cold card rendering
      latestMainCtxUsed: s.latestCtxPct != null ? Math.round(s.latestCtxPct / 100 * (s.maxContext || 200000)) : 0,
      maxWindow: s.maxContext || 200000,
      latestCacheHitRatio: s.latestCacheHitRatio || 0,
      latestCacheReadTokens: s.latestCacheReadTokens || 0,
      cacheBreaks: s.cacheBreaks || 0,
      resumeCommand: null, parentSessionId: null,
      firstReceivedAt: s.firstReceivedAt || 0,
      lastReceivedAt: s.lastReceivedAt || 0, _cold: true,
      weather: s.weather || null,
    });
    var shortSid = s.sid.slice(0, 8);
    var sessEl = document.createElement('div');
    sessEl.className = 'session-item';
    sessEl.dataset.sessionId = s.sid;
    sessEl.id = 'sess-' + shortSid;
    sessEl.onclick = (function(sid) { return function() { selectSession(sid); }; })(s.sid);
    _attachColdPrefetch(sessEl, s.sid);
    sessEl.innerHTML = renderSessionItem(sessionsMap.get(s.sid), s.sid, sessEl);
    colSessions.appendChild(sessEl);
    var projName = getProjectName(s.cwd);
    if (!projectsMap.has(projName)) {
      projectsMap.set(projName, { name: projName, totalCost: 0, fallbackCost: 0, fallbackCount: 0, unknownCount: 0, count: 0, sessionIds: new Set(), firstId: s.firstId || '', lastId: s.lastId || '', lastSeenAt: 0 });
    }
    var proj = projectsMap.get(projName);
    proj.sessionIds.add(s.sid);
    if (s.lastId && s.lastId > (proj.lastId || '')) proj.lastId = s.lastId;
    if (s.lastReceivedAt && s.lastReceivedAt > (proj.lastSeenAt || 0)) proj.lastSeenAt = s.lastReceivedAt;
  }
  // #377 / ADR 0013: widening a stored hot-session window changes weather's
  // denominator, so rebuild dependent stats in the same merge. Cold sessions
  // have no entries in allEntries; recomputing them would erase server stats.
  for (const sid of widenedSessionIds) {
    const s = sessionsMap.get(sid);
    if (!s || s._cold) continue;
    recomputeSessionStats(sid);
  }
  // #308: derive project costs from session costs (idempotent)
  for (const [name] of projectsMap) recomputeProjectCost(name);
}

// Initialize badge on load
setTimeout(() => updateSysPromptBadge('orchestrator'), 500);
startQuotaTicker();
// Tab restoration happens after deep-link resolution (see _loading=false path)

// SSE live connection
// #333: a live cross-process merge folded a duplicate into an already-known
// canonical entry. Patch the entry's data in place so the corrected (richest)
// metadata is what any subsequent render reads, then rebuild the workflow view
// if that session is on screen — wfBuildState → wfInferLanes is the authoritative
// batch pass, so lane placement is correct (not ad-hoc surgery). A turn we have
// never seen is rendered fresh. See docs/decisions/0012-response-id-read-time-merge.md.
function _patchEntryInPlace(u) {
  if (!u || !u.id) return;
  if (!window.entryById || !window.entryById.has(u.id)) { addEntry(u); return; }
  const full = allEntries.find(e => e.id === u.id);
  if (full) {
    // Enriched fields only — never touch id/ts/receivedAt/displayNum. sessionId is
    // deliberately NOT patched in place: a session change needs a cross-session
    // re-bucket (DOM + aggregates) that converges on the next load, not an edit
    // that would split allEntries from the rendered column (codex round-1 M4).
    // isSubagent/agentKey/convId ARE patched — they only move the turn between
    // LANES within this session, which the wfBuildState rebuild below recomputes.
    // Each field carries the server's already-merged canonical value, so a plain
    // copy is correct. hasCredential/toolFail arrive as `|| undefined`/`|| false`
    // from summarizeEntry, so the != null guard patches them when truthy and never
    // downgrades a real true to a stale false (codex round-3 M4).
    // NB: isSubagent is deliberately NOT patched — allEntries stores the CLIENT's
    // DERIVED classification (agentKey gate + overlap split + seq tracker), not the
    // raw wire flag summarizeEntry sends. Overwriting it with the raw flag desyncs
    // the seq tracker / ctx-chain from the swimlane (ADR 0005 divergence, fable
    // round-4 M2). The wfBuildState rebuild below re-derives lanes from the patched
    // agentKey; the turn-list row's classification converges on reload.
    for (const k of ['agentKey', 'agentLabel', 'coreHash', 'convId', 'cwd', 'usage',
      'maxContext', 'model', 'title', 'stopReason', 'toolFail', 'msgCount',
      'toolCount', 'thinkingDuration', 'thinkingStripped',
      // #339: beta1m — summarizeEntry sends it as `true || undefined` (never false), so the
      // != null guard is monotone (only ever sets true). The wfBuildState rebuild below
      // re-derives the swimlane fold from it; the session card converges on next render.
      'beta1m',
      'duplicateToolCalls', 'toolsHash', 'hasCredential']) {
      if (u[k] != null) full[k] = u[k];
    }
    // cost arrives as {cost, confidence} from summarizeEntry; allEntries stores
    // bare number + separate costConfidence (codex round-1 M3, #420 Phase 2).
    // cost and confidence are taken as a unit: confidence only updates when the
    // cost value is accepted (fable review MINOR-1, ADR 0012 as-a-unit rule).
    let costChanged = false;
    const prevPatchCost = full.cost != null ? full.cost : null;
    const prevPatchConf = full.costConfidence || null;
    if (u.cost != null) {
      if (u.cost && u.cost.cost != null) {
        const nextConfidence = u.cost.confidence || full.costConfidence;
        costChanged = full.cost !== u.cost.cost || full.costConfidence !== nextConfidence;
        full.cost = u.cost.cost;
        if (u.cost.confidence) full.costConfidence = u.cost.confidence;
      } else if (u.cost && Object.prototype.hasOwnProperty.call(u.cost, 'cost') && full.cost == null && u.cost.confidence) {
        // Unknown is accepted only for an entry that has no priced canonical
        // value; a later partial must not downgrade an existing priced copy.
        costChanged = full.costConfidence !== u.cost.confidence;
        full.costConfidence = u.cost.confidence;
      } else if (typeof u.cost === 'number') {
        costChanged = full.cost !== u.cost;
        full.cost = u.cost;
      }
    }
    if (costChanged) {
      // INVARIANT(#420/ADR 0017): an entry_update cost upgrade must rebuild the
      // session/project fold so the marker follows the canonical entry.
      const patchedSess = sessionsMap.get(full.sessionId);
      if (patchedSess) {
        if (patchedSess._cold) {
          // Cold session: allEntries holds only its live-arrived entries, so a
          // recompute would wipe the seeded history — apply the upgrade as an
          // incremental delta instead (codex R1 M3). Downgrade priced→unknown
          // can't occur (unknown is only accepted when full.cost was null).
          patchedSess.totalCost = (patchedSess.totalCost || 0) + (full.cost || 0) - (prevPatchCost || 0);
          if (prevPatchConf === 'fallback' && prevPatchCost != null) {
            patchedSess.fallbackCost = (patchedSess.fallbackCost || 0) - prevPatchCost;
            patchedSess.fallbackCount = Math.max(0, (patchedSess.fallbackCount || 0) - 1);
          }
          if (full.costConfidence === 'fallback' && full.cost != null) {
            patchedSess.fallbackCost = (patchedSess.fallbackCost || 0) + full.cost;
            patchedSess.fallbackCount = (patchedSess.fallbackCount || 0) + 1;
          }
          if (prevPatchConf === 'unknown' && prevPatchCost == null && full.cost != null) {
            patchedSess.unknownCount = Math.max(0, (patchedSess.unknownCount || 0) - 1);
          }
        } else {
          recomputeSessionStats(full.sessionId);
        }
        recomputeProjectCost(getProjectName(patchedSess.cwd));
        const patchedEl = document.getElementById('sess-' + full.sessionId.slice(0, 8));
        if (patchedEl) patchedEl.innerHTML = renderSessionItem(patchedSess, full.sessionId, patchedEl);
        renderProjectsCol();
      }
    }
    // ctxUsed is derived from usage at add time; recompute it when usage is
    // enriched or the context bar keeps rendering the poor copy's value (codex
    // round-2 M5 — this is the sawtooth symptom the merge exists to fix).
    if (u.usage != null && typeof computeCtxUsed === 'function') full.ctxUsed = computeCtxUsed(full.usage);
    // toolCalls: patch only a non-empty map/array so summarizeEntry's empty default
    // never clobbers a good map (codex round-2 M5).
    if (u.toolCalls != null && (Array.isArray(u.toolCalls) ? u.toolCalls.length : Object.keys(u.toolCalls).length)) {
      full.toolCalls = u.toolCalls;
    }
    // #427: turnToolCalls — always patch (including {} which means "zero calls")
    if (u.turnToolCalls !== undefined) full.turnToolCalls = u.turnToolCalls;
    // #438: turnToolFail — patch when present
    if (u.turnToolFail !== undefined) full.turnToolFail = u.turnToolFail;
    // Keep the lightweight entryById record consistent for the mutable field it
    // holds (codex round-1 M4).
    const rec = window.entryById.get(u.id);
    if (rec && u.cwd != null) rec.cwd = u.cwd;
  }
  // Rebuild the workflow view from the patched allEntries when this session is on
  // screen — wfBuildState → wfInferLanes is the authoritative batch pass, and the
  // shared migration preserves the user's zoom/selection/focus (m4).
  if (selectedSessionId === u.sessionId && typeof wfBuildState === 'function') {
    const rebuilt = wfBuildState(u.sessionId);
    if (rebuilt) {
      if (typeof _wfMigrateViewState === 'function') _wfMigrateViewState(wfState, rebuilt);
      wfState = rebuilt;
      if (typeof wfRenderTimeline === 'function') wfRenderTimeline();
    }
  }
}

const evtSource = new EventSource('/_events');
evtSource.onmessage = (ev) => {
  try {
    const data = JSON.parse(ev.data);
    if (data._type === 'stale') {
      // Server ring buffer evicted or hub restarted — full re-fetch
      console.log('[ccxray] SSE stale — re-fetching entries + sessions');
      Promise.all([
        fetch(_apiQ('/_api/entries'), { cache: 'no-store' }).then(r => r.json()).catch(() => ({ entries: [] })),
        fetch('/_api/sessions', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ sessions: [] })),
      ]).then(([entriesData, sessionsData]) => {
        for (const e of (entriesData.entries || [])) addEntry(e);
        mergeColdSessions(sessionsData.sessions || []);
        renderProjectsCol();
      });
    } else if (data._type === 'session_status') {
      sessionStatusMap.set(data.sessionId, { active: data.active, lastSeenAt: data.lastSeenAt });
      const sid = data.sessionId;
      const sessEl = document.getElementById('sess-' + sid.slice(0, 8));
      const sess = sessionsMap.get(sid);
      if (sessEl && sess) sessEl.innerHTML = renderSessionItem(sess, sid, sessEl);
      renderProjectsCol();
      applySessionFilter();
      updateTopbarStatus();
    } else if (data._type === 'sessions_updated') {
      // Importer finished — re-fetch session index to pick up new cold sessions
      fetch('/_api/sessions', { cache: 'no-store' }).then(r => r.json()).then(sd => {
        mergeColdSessions((sd && sd.sessions) || []);
        renderProjectsCol();
        applySessionFilter();
      }).catch(() => {});
    } else if (data._type === 'session_title_update') {
      const sid = data.sessionId;
      const sess = sessionsMap.get(sid);
      if (sess) {
        const nextTs = data.titleReqTs || 0;
        let changed = false;
        if (data.title && nextTs >= (sess.titleReqTs || 0)) {
          sess.title = data.title;
          sess.titleReqTs = nextTs;
          changed = true;
        }
        if (data.firstPrompt && !sess.firstPrompt) {
          sess.firstPrompt = data.firstPrompt;
          changed = true;
        }
        if (changed) {
          const sessEl = document.getElementById('sess-' + sid.slice(0, 8));
          if (sessEl) sessEl.innerHTML = renderSessionItem(sess, sid, sessEl);
          if (typeof renderBreadcrumb === 'function') renderBreadcrumb();
        }
      }
    } else if (data._type === 'entry_update') {
      _patchEntryInPlace(data);
    } else {
      addEntry(data);
      if (typeof onCostRelevantEntry === 'function') onCostRelevantEntry(data);
    }
  } catch(err) { console.error(err); }
};

// Refresh status dots every 60s (to transition idle → offline)
setInterval(() => {
  colSessions.querySelectorAll('.session-item').forEach(el => {
    const sid = el.dataset.sessionId;
    const sess = sessionsMap.get(sid);
    if (sess) el.innerHTML = renderSessionItem(sess, sid, el);
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
  target: _deepLinkParams.get('target'),
  e: _deepLinkParams.get('e'),
  step: _deepLinkParams.get('step'),
};
const _hasDeepLink = _pendingDeepLink.p || _pendingDeepLink.s || _pendingDeepLink.target || _pendingDeepLink.e;
let _deepLinkLoadingActive = !!_hasDeepLink;
let _deepLinkApplied = false;
const _debugLoadTimings = location.search.includes('debugLoad=1');

function _markLoad(name) {
  if (!_debugLoadTimings || !performance?.mark) return;
  performance.mark('ccxray:' + name);
}

function _measureLoad(name, start, end) {
  if (!_debugLoadTimings || !performance?.measure) return;
  try { performance.measure('ccxray:' + name, 'ccxray:' + start, 'ccxray:' + end); } catch {}
}

function _flushLoadTimings(label) {
  if (!_debugLoadTimings || !performance?.getEntriesByType) return;
  const rows = performance.getEntriesByType('measure')
    .filter(e => e.name.startsWith('ccxray:'))
    .map(e => ({ phase: e.name.replace('ccxray:', ''), ms: Math.round(e.duration) }));
  if (rows.length) {
    console.table(rows);
    console.log('[ccxray-load' + (label ? ':' + label : '') + '] ' + JSON.stringify(rows));
  }
}

// Deferred deep link state for sec/msg (applied after lazy-load)
var _deferredDeepLink = null;

function applyDeepLink() {
  _setDeepLinkProgress('Opening target…');
  if (allEntries.length === 0 && (_pendingDeepLink.s || _pendingDeepLink.p || _pendingDeepLink.e)) {
    _clearDeepLinkProgress();
    _showDeepLinkFailures(['No log data available']);
    return Promise.resolve({ ok: false, reason: 'missing-entry' });
  }
  if (typeof targetFromDeepLinkParams !== 'function' || typeof navigateTarget !== 'function') {
    _clearDeepLinkProgress();
    _showDeepLinkFailures(['Navigation target helpers are unavailable']);
    return Promise.resolve({ ok: false, reason: 'invalid-target' });
  }
  const parsed = targetFromDeepLinkParams(_deepLinkParams);
  if (window.__ccxrayDebugTargets || location.search.includes('debugTargets=1')) console.log('[target] parsed ' + JSON.stringify(parsed));
  const failures = parsed.failures || [];
  if (!parsed.target) {
    _clearDeepLinkProgress();
    if (failures.length) _showDeepLinkFailures(failures);
    return Promise.resolve({ ok: false, reason: 'invalid-target' });
  }
  return navigateTarget(parsed.target, { focus: true, scroll: true, smooth: false }).then(result => {
    if (!result || result.ok) {
      _deepLinkApplied = true;
      _clearDeepLinkProgress();
      syncUrlFromState();
      if (failures.length) _showDeepLinkFailures(failures);
      return result || { ok: true };
    }
    _clearDeepLinkProgress();
    failures.push(_formatDeepLinkFailure(result.reason));
    _showDeepLinkFailures(failures, { immediate: true });
    return result;
  });
}

function _applyDeferredDeepLink() {
  if (!_deferredDeepLink) return;
  const deferred = _deferredDeepLink;
  _deferredDeepLink = null;
  if (deferred.sec) selectSection(deferred.sec);
  if (deferred.msg != null && typeof selectMessage === 'function') selectMessage(deferred.msg);
}

function _showDeepLinkFailures(failures, opts) {
  opts = opts || {};
  const notify = function() {
    showToast('Deep link: ' + failures.join('; '));
  };
  if (opts.immediate) notify();
  else setTimeout(notify, 500);
}

function _formatDeepLinkFailure(reason) {
  const labels = {
    'invalid-target': 'link target is invalid',
    'missing-project': 'project was not found',
    'missing-session': 'session was not found',
    'missing-entry': 'turn entry was not found',
    'missing-step': 'turn loaded, but that step no longer exists',
    'missing-step-part': 'turn loaded, but that step item no longer exists',
    'load-failed': 'turn data could not be loaded',
    'load-timeout': 'turn data is still loading',
    'render-timeout': 'timeline rendered too slowly; try reloading',
  };
  return labels[reason] || reason || 'unknown failure';
}

// Load existing entries (suppress auto-scroll during batch load).
// Stars load in parallel with entries; rerender after both resolve so the
// initial column paint already shows the correct star/derived badges.
var _loading = true;
var _batchRestoring = false; // #330: true only during _restoreEntryBatch
var _dirtySessions = null; // #308: batch-deferred recompute
window._entriesLoading = true;
window._entriesLoadingProjectName = _pendingDeepLink.p || null;
window._entriesLoadingSessionPrefix = _pendingDeepLink.s || null;
window._entriesLoadingText = _hasDeepLink ? 'Resolving link…' : 'Loading…';
if (typeof renderProjectsCol === 'function') renderProjectsCol();
const _starsReady = (typeof loadStars === 'function') ? loadStars() : Promise.resolve();
const _sessionsReady = (async function _fetchSessionsWhenReady() {
  for (;;) {
    const r = await fetch('/_api/sessions', { cache: 'no-store' }).catch(() => null);
    if (!r) return { sessions: [] };
    const d = await r.json();
    // Wait until restore is fully complete — not just !restoring (initial
    // state is restoring:false,complete:false before setRestoreState runs)
    if (d.restore && d.restore.complete) return d;
    if (!d.restore) return d;
    await new Promise(r => setTimeout(r, 500));
  }
})();
_markLoad('entries-start');
const _entriesReady = _fetchEntriesWhenReady();

async function _fetchEntriesWhenReady() {
  let firstResponse = true;
  // Scoped initial load: deep links narrow the batch to the target session;
  // otherwise the server returns the N most recently active sessions and
  // everything else arrives cold via /_api/sessions (#303 Phase 2).
  let qs = '';
  if (_pendingDeepLink.s) qs = '?sid=' + encodeURIComponent(_pendingDeepLink.s);
  else if (_pendingDeepLink.e) qs = '?e=' + encodeURIComponent(_pendingDeepLink.e);
  for (;;) {
    const r = await fetch(_apiQ('/_api/entries' + qs), { cache: 'no-store' });
    if (firstResponse) {
      _markLoad('entries-response');
      _measureLoad('entries-fetch', 'entries-start', 'entries-response');
    }
    const data = await r.json();
    const restore = data.restore || {};
    if (!restore.restoring) {
      _markLoad('entries-json');
      _measureLoad('entries-json-parse', 'entries-response', 'entries-json');
      return data;
    }
    const count = restore.entryCount ? ' · ' + restore.entryCount + ' entries' : '';
    _setLoadingStatus('Restoring logs' + count + '…');
    firstResponse = false;
    await new Promise(r => setTimeout(r, 500));
  }
}

function _setLoadingStatus(text) {
  window._entriesLoadingText = text;
  const breadcrumb = document.getElementById('breadcrumb');
  if (breadcrumb && _loading) breadcrumb.textContent = text;
  if (_deepLinkLoadingActive) _renderDeepLinkLoading(text);
  if (typeof renderProjectsCol === 'function') renderProjectsCol();
}

function _setDeepLinkProgress(text) {
  if (!_hasDeepLink || !_deepLinkLoadingActive) return;
  _setLoadingStatus(text);
}

function _renderDeepLinkLoading(text) {
  // ponytail: restore progress shown in breadcrumb only (#332) — no column spinners
  const breadcrumb = document.getElementById('breadcrumb');
  if (breadcrumb && _loading) breadcrumb.textContent = 'Loading link · ' + text;
}

function _clearDeepLinkProgress() {
  _deepLinkLoadingActive = false;
  if (!window._entriesLoading) window._entriesLoadingText = '';
}

function _getDeepLinkPriorityPlan(entries) {
  if (!_hasDeepLink || !_pendingDeepLink.e || !Array.isArray(entries)) return null;
  const targetIdx = entries.findIndex(e => e && e.id === _pendingDeepLink.e);
  if (targetIdx < 0) return null;
  const sid = entries[targetIdx] && entries[targetIdx].sessionId;
  if (!sid) return null;
  const priorityIdxs = new Set();
  for (let i = 0; i <= targetIdx; i++) {
    if (entries[i] && entries[i].sessionId === sid) priorityIdxs.add(i);
  }
  if (!priorityIdxs.size) return null;
  return {
    priorityEntries: entries.filter((_, i) => priorityIdxs.has(i)),
    backgroundEntries: entries.filter((_, i) => !priorityIdxs.has(i)),
  };
}

async function _restoreEntryBatch(entries, opts) {
  opts = opts || {};
  const chunk = opts.chunk || 60;
  const total = opts.total || entries.length;
  const base = opts.base || 0;
  const label = opts.label || 'Restoring';
  for (let i = 0; i < entries.length; i += chunk) {
    _batchRestoring = true; // #330: only promote cold→hot during synchronous batch chunk
    entries.slice(i, i + chunk).forEach(addEntry);
    _batchRestoring = false;
    if (i + chunk < entries.length) {
      _setLoadingStatus(label + '… ' + (base + i + chunk) + ' / ' + total);
      await new Promise(r => requestAnimationFrame(r));
    }
  }
}

Promise.all([_entriesReady, _starsReady, _sessionsReady]).then(async ([data, , sessionsData]) => {
  const { entries = [], sessionTitles = {} } = data;

  if (entries.length) {
    // Show count immediately — yield one frame so the browser repaints before the sync loop.
    const targetHint = _pendingDeepLink.e
      ? (() => { const m = _pendingDeepLink.e.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/); return m ? ' · ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2]-1] + ' ' + +m[3] + ' ' + m[4] + ':' + m[5] : ''; })()
      : '';
    _setLoadingStatus('Restoring ' + entries.length + ' entries' + targetHint + '…');
    await new Promise(r => requestAnimationFrame(r));

    const priorityPlan = _getDeepLinkPriorityPlan(entries);
    if (priorityPlan) {
      _setLoadingStatus('Restoring target session…');
      await _restoreEntryBatch(priorityPlan.priorityEntries, {
        label: 'Restoring target session',
        total: priorityPlan.priorityEntries.length,
      });
      for (const [sid, title] of Object.entries(sessionTitles)) {
        const sess = sessionsMap.get(sid);
        if (sess) sess.title = title;
      }
      if (typeof renderProjectsCol === 'function') renderProjectsCol();
      await applyDeepLink();
      _markLoad('target-open');
      _measureLoad('target-first-open', 'entries-json', 'target-open');
      _flushLoadTimings('target-open');
      if (priorityPlan.backgroundEntries.length) {
        _setLoadingStatus('Restoring background entries… ' + priorityPlan.priorityEntries.length + ' / ' + entries.length);
        await new Promise(r => requestAnimationFrame(r));
        await _restoreEntryBatch(priorityPlan.backgroundEntries, {
          label: 'Restoring background entries',
          total: entries.length,
          base: priorityPlan.priorityEntries.length,
        });
      }
    } else {
      // Process in chunks so the browser can repaint progress between frames.
      await _restoreEntryBatch(entries, { label: 'Restoring', total: entries.length });
    }
  }

  // Merge session titles into sessionsMap before the final render pass.
  for (const [sid, title] of Object.entries(sessionTitles)) {
    const sess = sessionsMap.get(sid);
    if (sess) sess.title = title;
  }

  // Merge cold sessions from the full session index (#303).
  mergeColdSessions((sessionsData && sessionsData.sessions) || []);

  // Post-batch: one final render pass — sort sessions by most-recently-active then
  // rerender each item with accumulated data. colSessions + renderSessionItem are
  // globals from miller-columns.js (loaded before this file).
  window._entriesLoading = false;
  window._entriesLoadingProjectName = null;
  window._entriesLoadingSessionPrefix = null;
  window._entriesLoadingText = '';
  // #308: batch-deferred recompute — one pass per dirty session, O(n) total
  if (_dirtySessions) {
    for (const sid of _dirtySessions) {
      const s = sessionsMap.get(sid);
      if (s && s._cold) continue; // entries not in allEntries — keep sessions.json values
      recomputeSessionStats(sid);
    }
    _dirtySessions = null;
    for (const [name] of projectsMap) recomputeProjectCost(name);
  }
  const colSessEl = document.getElementById('col-sessions');
  if (colSessEl) {
    const sortedSids = [...sessionsMap.entries()]
      .sort(([, a], [, b]) => (b.lastReceivedAt || 0) - (a.lastReceivedAt || 0))
      .map(([sid]) => sid);
    for (const sid of sortedSids) {
      const el = document.getElementById('sess-' + sid.slice(0, 8));
      if (!el) continue;
      el.innerHTML = renderSessionItem(sessionsMap.get(sid), sid, el);
      el.style.display = '';
      _attachColdPrefetch(el, sid);
      colSessEl.appendChild(el); // appendChild in desc order → most-recent rises to top
    }
  }
  if (typeof renderProjectsCol === 'function') renderProjectsCol();
  _markLoad('entries-restored');
  _measureLoad('entries-hydrate', 'entries-json', 'entries-restored');

  _loading = false;

  // #308 dev-mode idempotency check: recompute twice, assert identical stats
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    for (const [sid, sess] of sessionsMap) {
      if (sess._cold) continue;
      recomputeSessionStats(sid);
      const snap = { count: sess.count, mainCount: sess.mainCount, subCount: sess.subCount, retryCount: sess.retryCount, totalCost: sess.totalCost, fallbackCost: sess.fallbackCost, fallbackCount: sess.fallbackCount, unknownCount: sess.unknownCount, inputTokens: sess.inputTokens, outputTokens: sess.outputTokens, toolCallTurns: sess.toolCallTurns };
      recomputeSessionStats(sid);
      for (const k of Object.keys(snap)) {
        if (snap[k] !== sess[k]) console.warn('[#308 drift]', sid, k, 'snap:', snap[k], 'recomputed:', sess[k]);
      }
    }
  }

  if (_hasDeepLink) {
    if (!_deepLinkApplied) await applyDeepLink();
  } else if (sessionsMap.size) {
    initAutoSelect();
  }
  // #308: re-render selected session card after recompute (deep link may have
  // selected a session whose stats were recomputed but card not yet refreshed)
  if (selectedSessionId) {
    const sessEl = document.getElementById('sess-' + selectedSessionId.slice(0, 8));
    const sess = sessionsMap.get(selectedSessionId);
    if (sessEl && sess) sessEl.innerHTML = renderSessionItem(sess, selectedSessionId, sessEl);
  }
  applySessionFilter();
  setFocus(focusedCol);
  if (typeof restoreTabFromUrl === 'function') restoreTabFromUrl();
  // #358: nothing ended up selected → auto-expand a collapsed sidebar so the
  // dashboard isn't a blank page with no expand affordance. Runs after
  // restoreTabFromUrl so a ?view=usage/sysprompt boot is gated off (codex r1);
  // switchTab back to dashboard re-runs the check.
  if (typeof maybeAutoExpandSidebar === 'function') maybeAutoExpandSidebar();
  _flushLoadTimings();
});

// Safety notice: keep showing progress if restoring takes longer than expected.
if (_hasDeepLink) {
  setTimeout(() => {
    if (_loading) {
      _setDeepLinkProgress('Still restoring entries…');
      if (typeof renderProjectsCol === 'function') renderProjectsCol();
      applySessionFilter();
    }
  }, 5000);
}
