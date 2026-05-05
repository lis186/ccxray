// ── Command Bar ──────────────────────────────────────────────────────────────
let _timelineExpanded = localStorage.getItem('kbar-timeline-expanded') !== 'false';

function getStarTargetFromSelection() {
  if (!window.xrayStars) return null;

  // In focused mode: use targetFromCurrentSelection() for step/turn context
  if (isFocusedMode) {
    const t = typeof targetFromCurrentSelection === 'function' ? targetFromCurrentSelection() : null;
    if (!t) return null;
    if (t.kind === 'step') {
      const suffix = t.sub == null ? '' : ':' + t.sub;
      const id = t.entryId + '::' + t.stepIdx + suffix;
      return { level: 'step', id, starred: window.xrayStars.steps.has(id) };
    }
    if (t.kind === 'turn')
      return { level: 'turn', id: t.entryId, starred: window.xrayStars.turns.has(t.entryId) };
    return null;
  }

  // In main mode: use focusedCol so horizontal navigation picks the right level
  if (focusedCol === 'projects') {
    if (!selectedProjectName) return null;
    if (selectedProjectName === '(unknown)' || selectedProjectName === '(quota-check)') return null;
    return { level: 'project', id: selectedProjectName, starred: window.xrayStars.projects.has(selectedProjectName) };
  }
  if (focusedCol === 'sessions') {
    if (!selectedSessionId) return null;
    if (selectedSessionId === 'direct-api') return null;
    return { level: 'session', id: selectedSessionId, starred: window.xrayStars.sessions.has(selectedSessionId) };
  }
  if (focusedCol === 'turns' || focusedCol === 'sections') {
    if (selectedTurnIdx < 0) return null;
    const entry = allEntries[selectedTurnIdx];
    if (!entry || !entry.id) return null;
    return { level: 'turn', id: entry.id, starred: window.xrayStars.turns.has(entry.id) };
  }
  return null;
}

function _fStarLabel() {
  const t = getStarTargetFromSelection();
  return t && t.starred ? '☆ unstar' : '★ star';
}

function isEnabled(keyId) {
  switch (keyId) {
    case '→-projects':     return projectsMap.size > 0;
    case '→-sessions':     return selectedSessionId != null || colSessions.querySelectorAll('.session-item').length > 0;
    case '→-turns':        return selectedTurnIdx >= 0;
    case '→-sections':     return selectedSection != null;
    case 'enter-sections': return selectedSection != null;
    case 'f-star':         return getStarTargetFromSelection() !== null;
    default:               return true;
  }
}

function getCmdBarState() {
  if (_loading) return null;
  if (typeof activeTab !== 'undefined' && activeTab !== 'dashboard') return null;

  if (isFocusedMode) {
    if (selectedSection === 'timeline') {
      const smallScreen = window.innerHeight <= 900;
      return {
        row1: [
          { key: '↑↓', label: 'steps' },
          { key: 'Esc/←', label: 'exit', clickKey: 'Escape' },
          { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
          { type: 'toggle' },
        ],
        row2: [
          { key: 'e', label: 'next error',    clickKey: 'e' },
          { key: 'E', label: 'prev error',    clickKey: 'E' },
          { key: 's', label: 'next skill',    clickKey: 's' },
          { key: 'S', label: 'prev skill',    clickKey: 'S' },
          { key: 'a', label: 'next subagent', clickKey: 'a' },
          { key: 'A', label: 'prev subagent', clickKey: 'A' },
          { key: 'm', label: 'next mcp',      clickKey: 'm' },
          { key: 'M', label: 'prev mcp',      clickKey: 'M' },
        ],
        row2Visible: !smallScreen && _timelineExpanded,
      };
    }
    return {
      row1: [
        { key: '↑↓', label: 'switch section' },
        { key: 'Esc/←', label: 'exit', clickKey: 'Escape' },
        { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
      ],
      row2: null,
      row2Visible: false,
    };
  }

  const tabKeys = [
    { key: '1', label: 'Dashboard',  clickKey: '1' },
    { key: '2', label: 'Usage',      clickKey: '2' },
    { key: '3', label: 'Sys Prompt', clickKey: '3' },
  ];

  if (focusedCol === 'projects') {
    return {
      row1: [
        { key: '↑↓', label: 'select', id: '↑↓-projects' },
        { key: '→', label: 'open', id: '→-projects', clickKey: 'ArrowRight' },
        { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
        ...tabKeys,
      ],
      row2: null, row2Visible: false,
    };
  }
  if (focusedCol === 'sessions') {
    return {
      row1: [
        { key: '↑↓', label: 'select' },
        { key: '←', label: 'back',  clickKey: 'ArrowLeft' },
        { key: '→', label: 'open',  id: '→-sessions', clickKey: 'ArrowRight' },
        { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
        ...tabKeys,
      ],
      row2: null, row2Visible: false,
    };
  }
  if (focusedCol === 'turns') {
    return {
      row1: [
        { key: '↑↓', label: 'select' },
        { key: '←', label: 'back',     clickKey: 'ArrowLeft' },
        { key: '→', label: 'sections', id: '→-turns', clickKey: 'ArrowRight' },
        { key: 'Enter', label: 'focus', clickKey: 'Enter' },
        { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
        ...tabKeys,
      ],
      row2: null, row2Visible: false,
    };
  }
  if (focusedCol === 'sections') {
    return {
      row1: [
        { key: '↑↓', label: 'select' },
        { key: '←', label: 'back',         clickKey: 'ArrowLeft' },
        { key: 'Enter', label: 'focus detail', id: 'enter-sections', clickKey: 'Enter' },
        { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
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
      if (item.clickKey && enabled) {
        const k = item.clickKey.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<button class="${cls} cmd-key-btn" tabindex="-1" onclick="document.dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',bubbles:true}))"><kbd>${item.key}</kbd> ${item.label}</button>`;
      }
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

  if (key === 'f') {
    const target = getStarTargetFromSelection();
    if (target) {
      e.preventDefault();
      const willStar = !target.starred;
      window.toggleStar(target.level, target.id, willStar);
      const label = { turn: 'Turn', session: 'Session', project: 'Project', step: 'Step' }[target.level] || '';
      if (typeof showToast === 'function')
        showToast((willStar ? '★' : '☆') + ' ' + label + ' ' + (willStar ? 'starred' : 'unstarred'), 2000);
    }
    return;
  }

  // Focused mode intercept — takes priority over column navigation
  if (isFocusedMode) {
    if (key === 'Escape' || key === 'ArrowLeft') {
      exitFocusedMode(); e.preventDefault(); return;
    }
    // T12: step-type jump shortcuts
    if (selectedSection === 'timeline') {
      const dir = { 'e': ['error','next'], 'E': ['error','prev'], 's': ['skill','next'], 'S': ['skill','prev'], 'a': ['subagent','next'], 'A': ['subagent','prev'], 'm': ['mcp','next'], 'M': ['mcp','prev'] }[key];
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
      renderCmdBar();
      return;
    }
    return; // swallow other keys in focused mode
  }

  // Enter on sections → enter focused mode
  if (key === 'Enter' && focusedCol === 'sections' && selectedSection) { enterFocusedMode(); e.preventDefault(); return; }
  // Escape in main mode → move left one column
  if (key === 'Escape') {
    const leftOf = { sessions: 'projects', turns: 'sessions', sections: 'turns' };
    if (leftOf[focusedCol]) { setFocus(leftOf[focusedCol]); e.preventDefault(); }
    return;
  }
  if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key)) return;
  e.preventDefault();

  if (focusedCol === 'projects') {
    if (key === 'ArrowRight') {
      setFocus('sessions');
      if (!selectedSessionId) {
        const firstSess = [...colSessions.querySelectorAll('.session-item')].find(el => el.style.display !== 'none');
        if (firstSess && firstSess.dataset.sessionId) selectSession(firstSess.dataset.sessionId);
      }
      return;
    }
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

// ── T12: Step-type jump shortcuts ─────────────────────────────────────────────
function jumpToStepType(type, dir) {
  const allStepEls = [...colDetail.querySelectorAll('.tl-step-summary')];
  if (!allStepEls.length) return;
  const curEl = colDetail.querySelector('.tl-step-summary.active');

  const candidates = allStepEls.filter(function(el) {
    if (type === 'error') return el.dataset.hasError === '1';
    if (type === 'skill') return el.dataset.tool === 'Skill';
    if (type === 'subagent') return el.dataset.tool === 'Agent' || el.dataset.tool === 'Task';
    if (type === 'mcp') return (el.dataset.tool || '').startsWith('mcp__');
    return false;
  });

  if (!candidates.length) return;
  const ci = candidates.indexOf(curEl);
  let next;
  if (ci !== -1) {
    // Currently on a matching step: move within candidates
    next = dir === 'next'
      ? (ci < candidates.length - 1 ? ci + 1 : 0)
      : (ci > 0 ? ci - 1 : candidates.length - 1);
  } else {
    // Not on a matching step: find the nearest candidate relative to current DOM position
    const curAllIdx = curEl ? allStepEls.indexOf(curEl) : -1;
    if (dir === 'next') {
      const after = candidates.findIndex(c => allStepEls.indexOf(c) > curAllIdx);
      next = after === -1 ? 0 : after;
    } else {
      let last = -1;
      for (let i = 0; i < candidates.length; i++) {
        if (allStepEls.indexOf(candidates[i]) < curAllIdx) last = i;
      }
      next = last === -1 ? candidates.length - 1 : last;
    }
  }
  const target = candidates[next];
  if (target) { target.click(); target.scrollIntoView({ block: 'nearest' }); }
}
