// ══════════════════════════════════════════════════════════════════════
// ── Intercept Feature ──
// ══════════════════════════════════════════════════════════════════════

function toggleIntercept(sid) {
  fetch('/_api/intercept/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
}

function approveIntercept() {
  if (!currentPending) return;
  const id = currentPending.requestId;
  fetch('/_api/intercept/' + encodeURIComponent(id) + '/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: currentPending.body }),
  });
}

function rejectIntercept() {
  if (!currentPending) return;
  const id = currentPending.requestId;
  fetch('/_api/intercept/' + encodeURIComponent(id) + '/reject', { method: 'POST' });
}

// ── Intercept overlay rendering ──
let interceptTab = 'messages';

function showInterceptOverlay() {
  if (!currentPending) return;
  const body = currentPending.body;
  const msgs = body.messages || [];
  const tools = body.tools || [];
  const model = body.model || '?';
  const sid = currentPending.sessionId;
  const shortSid = sid ? sid.slice(0, 8) : '?';

  let msgCount = msgs.length;
  let toolCount = tools.length;
  // rough token estimate
  let roughTokens = JSON.stringify(body).length / 4;

  let html = '<div class="intercept-overlay" id="intercept-overlay">';

  // Header
  html += '<div class="intercept-header">';
  html += '<span class="ih-title">⏸ Request Intercepted</span>';
  html += '<span class="ih-session">session:' + escapeHtml(shortSid) + ' · ' + escapeHtml(model.replace('claude-', '')) + '</span>';
  html += '</div>';

  // Tabs
  const tabs = [
    { id: 'messages', label: 'Messages (' + msgCount + ')' },
    { id: 'system', label: 'System' },
    { id: 'tools', label: 'Tools (' + toolCount + ')' },
    { id: 'model', label: 'Model' },
    { id: 'raw', label: 'Raw JSON' },
  ];
  html += '<div class="intercept-tabs">';
  for (const t of tabs) {
    html += '<div class="intercept-tab' + (interceptTab === t.id ? ' active' : '') + '" onclick="switchInterceptTab(&quot;' + t.id + '&quot;)">' + t.label + '</div>';
  }
  html += '</div>';

  // Editor area
  html += '<div class="intercept-editor" id="intercept-editor">';
  html += renderInterceptTabContent(interceptTab);
  html += '</div>';

  // Summary
  html += '<div class="intercept-summary">' + msgCount + ' messages · ' + toolCount + ' tools · ~' + Math.round(roughTokens).toLocaleString() + ' tokens</div>';

  // Countdown bar
  html += '<div class="intercept-countdown"><div class="intercept-countdown-bar" id="intercept-countdown-bar"></div></div>';

  // Actions
  html += '<div class="intercept-actions">';
  html += '<button class="btn-reject" onclick="rejectIntercept()">✕ Reject</button>';
  html += '<button class="btn-approve" onclick="approveIntercept()">✓ Approve & Send</button>';
  html += '</div>';

  html += '</div>';
  colDetail.innerHTML = html;
  startCountdown();
}

function renderInterceptTabContent(tab) {
  if (!currentPending) return '';
  const body = currentPending.body;

  switch (tab) {
    case 'messages': {
      const msgs = body.messages || [];
      if (!msgs.length) return '<div style="color:var(--dim)">No messages</div>';
      // Show in reverse order (newest first)
      let html = '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        const preview = getMessagePreview(m).slice(0, 60);
        html += '<div class="ie-msg" data-msg-idx="' + i + '" onclick="toggleInterceptMsg(this,' + i + ',event)">';
        html += '<div class="ie-msg-role ' + m.role + '">[' + i + '] ' + m.role + '</div>';
        html += '<div class="ie-msg-preview">' + escapeHtml(preview) + '</div>';
        html += '</div>';
      }
      return html;
    }
    case 'system': {
      const sys = body.system;
      const text = !sys ? '' : (typeof sys === 'string' ? sys : JSON.stringify(sys, null, 2));
      return '<textarea id="ie-system-ta" oninput="onInterceptSystemEdit(this)" style="min-height:300px">' + escapeHtml(text) + '</textarea>';
    }
    case 'tools': {
      const tools = body.tools || [];
      if (!tools.length) return '<div style="color:var(--dim)">No tools</div>';
      let html = '';
      for (let i = 0; i < tools.length; i++) {
        const t = tools[i];
        const checked = t._enabled !== false ? ' checked' : '';
        html += '<div class="ie-tool-item">';
        html += '<input type="checkbox" id="ie-tool-' + i + '"' + checked + ' onchange="onInterceptToolToggle(' + i + ',this.checked)">';
        html += '<label for="ie-tool-' + i + '">' + escapeHtml(t.name) + '</label>';
        html += '</div>';
      }
      return html;
    }
    case 'model': {
      const models = ['claude-opus-4-6','claude-sonnet-4-6','claude-haiku-4-5','claude-opus-4-5','claude-sonnet-4','claude-haiku-4'];
      let html = '<div style="margin-bottom:8px;color:var(--dim);font-size:11px">Current model:</div>';
      html += '<select id="ie-model-select" onchange="onInterceptModelChange(this.value)" style="min-width:200px">';
      for (const m of models) {
        const sel = body.model === m ? ' selected' : '';
        html += '<option value="' + m + '"' + sel + '>' + m + '</option>';
      }
      // If current model not in list, add it
      if (!models.includes(body.model)) {
        html += '<option value="' + escapeHtml(body.model) + '" selected>' + escapeHtml(body.model) + '</option>';
      }
      html += '</select>';
      return html;
    }
    case 'raw': {
      const json = JSON.stringify(body, null, 2);
      return '<textarea id="ie-raw-ta" oninput="onInterceptRawEdit(this)" style="min-height:400px;font-size:11px">' + escapeHtml(json) + '</textarea>';
    }
    default: return '';
  }
}

function switchInterceptTab(tab) {
  interceptTab = tab;
  document.querySelectorAll('.intercept-tab').forEach(el => {
    el.classList.toggle('active', el.textContent.toLowerCase().startsWith(tab));
  });
  const editor = document.getElementById('intercept-editor');
  if (editor) editor.innerHTML = renderInterceptTabContent(tab);
}

function toggleInterceptMsg(el, idx, evt) {
  // Don't collapse if user clicked inside the textarea (event bubbling)
  if (evt && (evt.target.tagName === 'TEXTAREA' || evt.target.closest('textarea'))) return;
  if (el.querySelector('textarea')) {
    // Collapse
    el.innerHTML = '<div class="ie-msg-role ' + currentPending.body.messages[idx].role + '">[' + idx + '] ' + currentPending.body.messages[idx].role + '</div>' +
      '<div class="ie-msg-preview">' + escapeHtml(getMessagePreview(currentPending.body.messages[idx]).slice(0, 60)) + '</div>';
    el.classList.remove('expanded');
    return;
  }
  const m = currentPending.body.messages[idx];
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
  el.classList.add('expanded');
  el.innerHTML = '<div class="ie-msg-role ' + m.role + '">[' + idx + '] ' + m.role + '</div>' +
    '<textarea oninput="onInterceptMsgEdit(' + idx + ',this)" style="min-height:150px">' + escapeHtml(content) + '</textarea>';
}

function onInterceptMsgEdit(idx, ta) {
  if (!currentPending) return;
  try {
    currentPending.body.messages[idx].content = JSON.parse(ta.value);
  } catch {
    currentPending.body.messages[idx].content = ta.value;
  }
}

function onInterceptSystemEdit(ta) {
  if (!currentPending) return;
  try {
    currentPending.body.system = JSON.parse(ta.value);
  } catch {
    currentPending.body.system = ta.value;
  }
}

function onInterceptToolToggle(idx, enabled) {
  if (!currentPending) return;
  if (enabled) {
    delete currentPending.body.tools[idx]._enabled;
  } else {
    currentPending.body.tools[idx]._enabled = false;
  }
  // Remove disabled tools before sending
}

function onInterceptModelChange(model) {
  if (!currentPending) return;
  currentPending.body.model = model;
}

function onInterceptRawEdit(ta) {
  if (!currentPending) return;
  try {
    currentPending.body = JSON.parse(ta.value);
  } catch {
    // invalid JSON, ignore
  }
}

// Override approveIntercept to filter disabled tools
const _origApprove = approveIntercept;
approveIntercept = function() {
  if (currentPending && currentPending.body.tools) {
    currentPending.body.tools = currentPending.body.tools.filter(t => t._enabled !== false);
    // Clean up _enabled markers
    currentPending.body.tools.forEach(t => delete t._enabled);
  }
  _origApprove();
};

// ── Countdown ──
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdown, 1000);
  updateCountdown();
}

function updateCountdown() {
  if (!currentPending) {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    return;
  }
  const elapsed = (Date.now() - currentPending.receivedAt) / 1000;
  const remaining = Math.max(0, interceptTimeoutSec - elapsed);
  const pct = remaining / interceptTimeoutSec * 100;
  const bar = document.getElementById('intercept-countdown-bar');
  if (bar) {
    bar.style.width = pct + '%';
    bar.style.backgroundColor = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
  }
  // Update topbar held indicator
  updateTopbarHeld(Math.ceil(remaining));
}

function updateTopbarHeld(remaining) {
  const el = document.getElementById('topbar-held');
  if (!el) return;
  if (!currentPending) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'inline';
  el.textContent = 'HELD (' + (remaining != null ? remaining + 's' : '?') + ')';
  el.onclick = () => showInterceptOverlay();
}

function hideInterceptOverlay() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  currentPending = null;
  const el = document.getElementById('intercept-overlay');
  if (el) el.remove();
  const held = document.getElementById('topbar-held');
  if (held) held.style.display = 'none';
  // Re-render detail
  renderDetailCol();
}

// ── SSE handlers for intercept events ──
const _origOnMessage = evtSource.onmessage;
evtSource.onmessage = (ev) => {
  try {
    const data = JSON.parse(ev.data);
    if (data._type === 'intercept_toggled') {
      if (data.enabled) interceptSessionIds.add(data.sessionId);
      else interceptSessionIds.delete(data.sessionId);
      // Re-render affected session item
      const sid = data.sessionId;
      const sessEl = document.getElementById('sess-' + sid.slice(0, 8));
      const sess = sessionsMap.get(sid);
      if (sessEl && sess) {
        const hadFocus = sessEl.contains(document.activeElement) && document.activeElement.classList.contains('sdot');
        sessEl.innerHTML = renderSessionItem(sess, sid);
        if (hadFocus) { const btn = sessEl.querySelector('.sdot'); if (btn) btn.focus(); }
      }
      return;
    }
    if (data._type === 'pending_request') {
      currentPending = {
        requestId: data.requestId,
        sessionId: data.sessionId,
        body: data.body,
        receivedAt: Date.now(),
      };
      interceptTab = 'messages';
      showInterceptOverlay();
      const hSessEl = document.getElementById('sess-' + data.sessionId.slice(0, 8));
      const hSess = sessionsMap.get(data.sessionId);
      if (hSessEl && hSess) hSessEl.innerHTML = renderSessionItem(hSess, data.sessionId);
      return;
    }
    if (data._type === 'intercept_removed') {
      const prevSid = currentPending && currentPending.sessionId;
      if (currentPending && currentPending.requestId === data.requestId) {
        hideInterceptOverlay();
      }
      if (prevSid) {
        const rSessEl = document.getElementById('sess-' + prevSid.slice(0, 8));
        const rSess = sessionsMap.get(prevSid);
        if (rSessEl && rSess) rSessEl.innerHTML = renderSessionItem(rSess, prevSid);
      }
      return;
    }
    if (data._type === 'intercept_timeout') {
      interceptTimeoutSec = data.timeout;
      return;
    }
    if (data._type === 'version_detected') {
      updateSysPromptBadge(data.agentKey || 'orchestrator');
      const banner = document.getElementById('version-banner');
      if (banner) {
        banner.style.display = 'flex';
        banner.className = 'version-banner';
        banner.innerHTML = `<span class="vb-dot">●</span> New cc_version: <span class="vb-ver">${escapeHtml(data.version)}</span> <span class="vb-delta">(+${(data.b2Len/4).toFixed(0)} tok)</span> <span class="vb-view" onclick="openSystemPromptPanel(true)">view</span> <span class="vb-close" onclick="this.parentElement.style.display='none'">×</span>`;
      }
      return;
    }
  } catch {}
  // Fall through to original handler
  _origOnMessage(ev);
};
