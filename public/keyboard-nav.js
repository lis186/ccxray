// ── Command Bar ──────────────────────────────────────────────────────────────
let _timelineExpanded = localStorage.getItem('kbar-timeline-expanded') !== 'false';

function isEnabled(keyId) {
  switch (keyId) {
    case '→-projects':     return projectsMap.size > 0;
    case '→-sessions':     return selectedSessionId != null || colSessions.querySelectorAll('.session-item').length > 0;
    case '→-turns':        return selectedTurnIdx >= 0;
    case '→-sections':     return selectedSection != null;
    case 'enter-sections': return selectedSection != null;
    default:               return true;
  }
}

function getCmdBarState() {
  if (_loading) return null;
  if (typeof activeTab !== 'undefined' && activeTab !== 'dashboard') return null;

  if (isFocusedMode) {
    if (tlFilterActive) {
      return { row1: [{ key: 'Esc', label: 'close filter' }], row2: null, row2Visible: false };
    }
    if (selectedSection === 'timeline') {
      const smallScreen = window.innerHeight <= 900;
      return {
        row1: [
          { key: '↑↓', label: 'steps' },
          { key: '/', label: 'filter' },
          { key: 'Esc/←', label: 'exit' },
          { type: 'toggle' },
        ],
        row2: [
          { key: 'e', label: 'next error' },
          { key: 'E', label: 'prev error' },
          { key: 't', label: 'thinking' },
          { key: 'h', label: 'human' },
          { key: ']', label: 'text' },
        ],
        row2Visible: !smallScreen && _timelineExpanded,
      };
    }
    return {
      row1: [
        { key: '↑↓', label: 'switch section' },
        { key: 'Esc/←', label: 'exit' },
      ],
      row2: null,
      row2Visible: false,
    };
  }

  const tabKeys = [
    { key: '1', label: 'Dashboard' },
    { key: '2', label: 'Usage' },
    { key: '3', label: 'Sys Prompt' },
  ];

  if (focusedCol === 'projects') {
    return {
      row1: [
        { key: '↑↓', label: 'select', id: '↑↓-projects' },
        { key: '→', label: 'open', id: '→-projects' },
        ...tabKeys,
      ],
      row2: null, row2Visible: false,
    };
  }
  if (focusedCol === 'sessions') {
    return {
      row1: [
        { key: '↑↓', label: 'select' },
        { key: '←', label: 'back' },
        { key: '→', label: 'open', id: '→-sessions' },
        ...tabKeys,
      ],
      row2: null, row2Visible: false,
    };
  }
  if (focusedCol === 'turns') {
    return {
      row1: [
        { key: '↑↓', label: 'select' },
        { key: '←', label: 'back' },
        { key: '→', label: 'sections', id: '→-turns' },
        { key: 'Enter', label: 'focus' },
        ...tabKeys,
      ],
      row2: null, row2Visible: false,
    };
  }
  if (focusedCol === 'sections') {
    return {
      row1: [
        { key: '↑↓', label: 'select' },
        { key: '←', label: 'back' },
        { key: 'Enter', label: 'focus detail', id: 'enter-sections' },
        ...tabKeys,
      ],
      row2: null, row2Visible: false,
    };
  }
  return null;
}

function renderCmdBar() {
  const bar = document.getElementById('cmd-bar');
  const row1 = document.getElementById('cmd-bar-row1');
  const row2 = document.getElementById('cmd-bar-row2');
  if (!bar || !row1 || !row2) return;

  const state = getCmdBarState();
  if (!state) { bar.className = 'hidden'; return; }

  // Overlay check (use getComputedStyle to catch both inline and class-based display)
  const overlayActive = [...document.querySelectorAll('[data-hides-cmdbar]')].some(el =>
    window.getComputedStyle(el).display !== 'none'
  );
  bar.className = overlayActive ? 'overlay-active' : '';

  function buildRow(items) {
    if (!items) return '';
    return items.map(item => {
      if (item.type === 'toggle') {
        const label = _timelineExpanded ? 'less ∧' : 'more ∨';
        const ariaLabel = _timelineExpanded ? 'collapse timeline shortcuts' : 'expand timeline shortcuts';
        return `<button class="cmd-toggle" tabindex="-1" aria-label="${ariaLabel}" aria-expanded="${_timelineExpanded}" onclick="(function(){_timelineExpanded=!_timelineExpanded;localStorage.setItem('kbar-timeline-expanded',_timelineExpanded);renderCmdBar();})()">${label}</button>`;
      }
      const enabled = item.id ? isEnabled(item.id) : true;
      const cls = enabled ? 'cmd-key' : 'cmd-key disabled';
      return `<span class="${cls}"><kbd>${item.key}</kbd> ${item.label}</span>`;
    }).join('<span class="cmd-sep">·</span>');
  }

  row1.innerHTML = buildRow(state.row1);
  row2.innerHTML = buildRow(state.row2);
  row2.classList.toggle('visible', !!state.row2Visible);
}

// ── Keyboard shortcuts overlay ──
function toggleKbdOverlay() {
  const el = document.getElementById('kbd-overlay');
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'flex' : 'none';
  renderCmdBar();
}

// ── Keyboard navigation ──
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const key = e.key;

  // kbd overlay: ? to open, Escape to close (highest priority after input guard)
  const kbdOverlay = document.getElementById('kbd-overlay');
  if (kbdOverlay && kbdOverlay.style.display !== 'none') {
    if (key === 'Escape' || key === '?') { toggleKbdOverlay(); e.preventDefault(); return; }
    return; // swallow all keys while overlay is open
  }
  if (key === '?') { toggleKbdOverlay(); e.preventDefault(); return; }

  // Tab switching: 1=Dashboard, 2=Usage, 3=System Prompt
  const tabMap = { '1': 'dashboard', '2': 'usage', '3': 'sysprompt' };
  if (tabMap[key]) { switchTab(tabMap[key]); e.preventDefault(); return; }

  // Focused mode intercept — takes priority over column navigation
  if (isFocusedMode) {
    if (key === 'Escape' || key === 'ArrowLeft') {
      if (tlFilterActive) { closeTlFilter(); e.preventDefault(); return; }
      exitFocusedMode(); e.preventDefault(); return;
    }
    // T11: open filter with /
    if (key === '/' && selectedSection === 'timeline') { openTlFilter(); e.preventDefault(); return; }
    // T12: step-type jump shortcuts
    if (selectedSection === 'timeline' && !tlFilterActive) {
      const dir = { 'e': ['error','next'], 'E': ['error','prev'], 't': ['thinking','next'], 'h': ['human','next'], ']': ['text','next'] }[key];
      if (dir) { e.preventDefault(); jumpToStepType(dir[0], dir[1]); return; }
    }
    if ((key === 'ArrowUp' || key === 'ArrowDown') && selectedSection === 'timeline') {
      e.preventDefault();
      // Navigate between top-level steps (not sub-items within a step)
      const all = [...colDetail.querySelectorAll('.tl-step-summary')];
      if (!all.length) return;
      // Build ordered list of unique step indices, preserving DOM order
      const seen = new Set();
      const steps = [];
      for (const el of all) {
        const s = el.dataset.step;
        if (!seen.has(s)) { seen.add(s); steps.push(s); }
      }
      // Find current step
      const curEl = colDetail.querySelector('.tl-step-summary.active');
      const curStep = curEl ? curEl.dataset.step : null;
      const curPos = curStep != null ? steps.indexOf(curStep) : -1;
      const nextPos = Math.max(0, Math.min(steps.length - 1, curPos + (key === 'ArrowDown' ? 1 : -1)));
      const nextStep = steps[nextPos];
      // Click the first element of the target step
      const target = colDetail.querySelector('.tl-step-summary[data-step="' + nextStep + '"]');
      target?.click();
      target?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Navigate between sections while staying in focused mode
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      const sectionNames = [...colSections.querySelectorAll('.section-item')].map(el => el.dataset.section);
      if (!sectionNames.length) return;
      const cur = sectionNames.indexOf(selectedSection);
      const next = Math.max(0, Math.min(sectionNames.length - 1, cur + (key === 'ArrowDown' ? 1 : -1)));
      if (next === cur) return;
      // Update section without exiting focused mode
      selectedSection = sectionNames[next];
      if (typeof clearSelectedStepSelection === 'function') clearSelectedStepSelection();
      else selectedMessageIdx = -1;
      colSections.querySelectorAll('.section-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.section === selectedSection);
      });
      renderDetailCol();
      renderBreadcrumb();
      return;
    }
    return; // swallow other keys in focused mode
  }

  // Enter on sections → enter focused mode
  if (key === 'Enter' && focusedCol === 'sections' && selectedSection) { enterFocusedMode(); e.preventDefault(); return; }
  // T11: open filter in non-focused timeline view
  if (key === '/' && selectedSection === 'timeline') { openTlFilter(); e.preventDefault(); return; }
  // Escape in main mode → move left one column
  if (key === 'Escape') {
    const leftOf = { sessions: 'projects', turns: 'sessions', sections: 'turns' };
    if (leftOf[focusedCol]) { setFocus(leftOf[focusedCol]); e.preventDefault(); }
    return;
  }
  if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key)) return;
  e.preventDefault();

  if (focusedCol === 'projects') {
    if (key === 'ArrowRight') { setFocus('sessions'); return; }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const projItems = [...colProjects.querySelectorAll('.project-item')].map(el => {
        const m = el.getAttribute('onclick')?.match(/selectProject\((.+)\)/);
        if (m) try { return JSON.parse(m[1].replace(/&quot;/g, '"')); } catch(e) {}
        return null;
      }).filter(n => n !== null);
      if (!projItems.length) return;
      const cur = projItems.indexOf(selectedProjectName);
      const effectiveCur = cur === -1 ? (key === 'ArrowDown' ? -1 : 0) : cur;
      const next = Math.max(0, Math.min(projItems.length - 1, effectiveCur + (key === 'ArrowDown' ? 1 : -1)));
      if (next === cur) return;
      selectProject(projItems[next]);
    }
  } else if (focusedCol === 'sessions') {
    if (key === 'ArrowLeft') { setFocus('projects'); return; }
    if (key === 'ArrowRight') { setFocus('turns'); return; }
    const visibleSessEls = [...colSessions.querySelectorAll('.session-item')].filter(el => el.style.display !== 'none');
    const sessIds = visibleSessEls.map(el => el.dataset.sessionId);
    if (!sessIds.length) return;
    const cur = selectedSessionId ? sessIds.indexOf(selectedSessionId) : sessIds.length - 1;
    const next = Math.max(0, Math.min(sessIds.length - 1, cur + (key === 'ArrowDown' ? 1 : -1)));
    selectSession(sessIds[next]);
  } else if (focusedCol === 'turns') {
    if (key === 'ArrowLeft') { setFocus('sessions'); return; }
    if (key === 'ArrowRight' && selectedTurnIdx >= 0) { setFocus('sections'); return; }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const visible = getVisibleTurnIndices();
      if (!visible.length) return;
      const cur = visible.indexOf(selectedTurnIdx);
      const next = Math.max(0, Math.min(visible.length - 1, cur + (key === 'ArrowDown' ? 1 : -1)));
      selectTurn(visible[next]);
    }
  } else if (focusedCol === 'sections') {
    if (key === 'ArrowLeft') { setFocus('turns'); return; }
    if (key === 'ArrowRight' && selectedSection) { enterFocusedMode(); return; }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const sectionNames = [...colSections.querySelectorAll('.section-item')].map(el => el.dataset.section);
      if (!sectionNames.length) return;
      const cur = sectionNames.indexOf(selectedSection);
      const next = Math.max(0, Math.min(sectionNames.length - 1, cur + (key === 'ArrowDown' ? 1 : -1)));
      selectSection(sectionNames[next]);
    }
  }
  renderCmdBar();
});

// ── T11: Timeline Filter Bar ──────────────────────────────────────────────────
let tlFilterActive = false;
let tlFilterQuery = '';

function openTlFilter() {
  tlFilterActive = true;
  const host = isFocusedMode ? colDetail : colDetail;
  let bar = document.getElementById('tl-filter-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'tl-filter-bar';
    bar.style.cssText = 'position:sticky;top:0;z-index:10;background:var(--surface);border-bottom:1px solid var(--accent);padding:4px 8px;display:flex;align-items:center;gap:6px';
    bar.innerHTML = '<span style="font-size:11px;color:var(--dim)">Filter:</span>'
      + '<input id="tl-filter-input" type="text" placeholder="tool:Bash  status:fail"'
      + ' style="flex:1;background:transparent;border:none;outline:none;color:var(--text);font-size:12px;font-family:monospace">'
      + '<span id="tl-filter-count" style="font-size:10px;color:var(--dim)"></span>'
      + '<button onclick="closeTlFilter()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:12px;padding:0 2px">✕</button>';
    host.prepend(bar);
  }
  bar.style.display = 'flex';
  const inp = document.getElementById('tl-filter-input');
  inp.value = tlFilterQuery;
  inp.focus();
  inp.oninput = function() { tlFilterQuery = inp.value; applyTlFilter(); };
  inp.onkeydown = function(ev) {
    if (ev.key === 'Escape') { closeTlFilter(); ev.preventDefault(); }
    ev.stopPropagation();
  };
  applyTlFilter();
  renderCmdBar();
}

function closeTlFilter() {
  tlFilterActive = false;
  tlFilterQuery = '';
  const bar = document.getElementById('tl-filter-bar');
  if (bar) bar.style.display = 'none';
  applyTlFilter();
  renderCmdBar();
}

function applyTlFilter() {
  const q = tlFilterQuery.trim().toLowerCase();
  const allStepEls = [...colDetail.querySelectorAll('.tl-step-summary')];
  if (!q) {
    allStepEls.forEach(function(el) { el.style.display = ''; });
    const cnt = document.getElementById('tl-filter-count');
    if (cnt) cnt.textContent = '';
    return;
  }
  const toolMatch = (q.match(/\btool:(\S+)/) || [])[1];
  const statusFail = /\bstatus:fail\b/.test(q);
  let shown = 0;
  allStepEls.forEach(function(el) {
    let visible = true;
    if (toolMatch) {
      const nameEl = el.querySelector('.msg-list-row span:nth-child(2)');
      visible = (nameEl ? nameEl.textContent.toLowerCase() : '').includes(toolMatch);
    }
    if (statusFail && visible) visible = el.dataset.hasError === '1';
    el.style.display = visible ? '' : 'none';
    if (visible) shown++;
  });
  const cnt = document.getElementById('tl-filter-count');
  if (cnt) cnt.textContent = 'Showing ' + shown + ' of ' + allStepEls.length;
}

// ── T12: Step-type jump shortcuts ─────────────────────────────────────────────
function jumpToStepType(type, dir) {
  const allStepEls = [...colDetail.querySelectorAll('.tl-step-summary')];
  if (!allStepEls.length) return;
  const curEl = colDetail.querySelector('.tl-step-summary.active');
  const curIdx = curEl ? allStepEls.indexOf(curEl) : -1;

  const candidates = allStepEls.filter(function(el) {
    if (type === 'error') return el.dataset.hasError === '1';
    if (type === 'thinking') return el.textContent.trim().startsWith('🧠');
    if (type === 'human') return el.querySelector('[style*="var(--accent)"]') !== null && el.querySelector('.msg-list-row') === null;
    if (type === 'text') return el.querySelector('[style*="var(--green)"]') !== null && el.querySelector('.msg-list-row') === null;
    return false;
  });

  if (!candidates.length) return;
  const ci = candidates.indexOf(curEl);
  const next = dir === 'next'
    ? (ci < candidates.length - 1 ? ci + 1 : 0)
    : (ci > 0 ? ci - 1 : candidates.length - 1);
  const target = candidates[next];
  if (target) { target.click(); target.scrollIntoView({ block: 'nearest' }); }
}
