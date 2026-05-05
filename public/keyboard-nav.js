// ── Command Bar ──────────────────────────────────────────────────────────────

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

function _starNavItems(id) {
  return [
    { key: 'n', label: 'next star', id: id || 'star-nav', clickKey: 'n' },
    { key: 'N', label: 'prev star', id: id || 'star-nav', clickKey: 'N' },
  ];
}

function _hasStarNavTargets() {
  return _getStarNavTargets().length > 0;
}

function _targetKey(target) {
  if (!target || !target.kind) return '';
  if (target.kind === 'project') return 'project:' + target.project;
  if (target.kind === 'session') return 'session:' + target.sessionId;
  if (target.kind === 'turn') return 'turn:' + target.entryId;
  if (target.kind === 'step') {
    const suffix = target.sub == null ? '' : ':' + target.sub;
    return 'step:' + target.entryId + '::' + target.stepIdx + suffix;
  }
  return '';
}

function _projectIndex(name) {
  if (!name) return 999999;
  const names = [...projectsMap.keys()];
  const idx = names.indexOf(name);
  return idx >= 0 ? idx : names.length + String(name).localeCompare('');
}

function _sessionIndex(sid) {
  if (!sid) return 999999;
  const ids = [...sessionsMap.keys()];
  const idx = ids.indexOf(sid);
  return idx >= 0 ? idx : ids.length + String(sid).localeCompare('');
}

function _entryProjectName(entry) {
  if (!entry) return '';
  if (typeof _projectNameForEntry === 'function') return _projectNameForEntry(entry);
  return typeof getProjectName === 'function' ? getProjectName(entry.cwd) : '';
}

function _starSortKey(target) {
  if (!target || !target.kind) return [999999, 999999, 999999, 999999, 999999, 999999];
  if (target.kind === 'project') {
    return [_projectIndex(target.project), -1, -1, -1, -1, 0];
  }
  if (target.kind === 'session') {
    const sess = sessionsMap.get(target.sessionId);
    const project = sess && typeof getProjectName === 'function' ? getProjectName(sess.cwd) : '';
    return [_projectIndex(project), _sessionIndex(target.sessionId), -1, -1, -1, 1];
  }
  const idx = typeof _findEntryIndexById === 'function' ? _findEntryIndexById(target.entryId) : -1;
  const entry = idx >= 0 ? allEntries[idx] : null;
  const base = [_projectIndex(_entryProjectName(entry)), _sessionIndex(entry && entry.sessionId), idx < 0 ? 999999 : idx];
  if (target.kind === 'turn') return base.concat([-1, -1, 2]);
  const subRank = target.sub === 'thinking' ? -0.5 : (typeof target.sub === 'number' ? target.sub : -1);
  return base.concat([target.stepIdx, subRank, 3]);
}

function _compareStarTargets(a, b) {
  const ak = _starSortKey(a);
  const bk = _starSortKey(b);
  for (let i = 0; i < Math.max(ak.length, bk.length); i++) {
    if ((ak[i] || 0) < (bk[i] || 0)) return -1;
    if ((ak[i] || 0) > (bk[i] || 0)) return 1;
  }
  return _targetKey(a).localeCompare(_targetKey(b));
}

function _canNavigateStarTarget(target) {
  if (!target) return false;
  if (target.kind === 'project') return projectsMap.has(target.project);
  if (target.kind === 'session') return typeof _resolveSessionId === 'function' && !!_resolveSessionId(target.sessionId);
  if (target.kind === 'turn' || target.kind === 'step') return typeof _findEntryIndexById === 'function' && _findEntryIndexById(target.entryId) >= 0;
  return false;
}

function _getStarNavTargets() {
  if (!window.xrayStars || typeof targetFromStar !== 'function') return [];
  const targets = [];
  for (const id of window.xrayStars.projects || []) targets.push(targetFromStar('project', id));
  for (const id of window.xrayStars.sessions || []) targets.push(targetFromStar('session', id));
  for (const id of window.xrayStars.turns || []) targets.push(targetFromStar('turn', id));
  for (const id of window.xrayStars.steps || []) targets.push(targetFromStar('step', id));

  const seen = new Set();
  return targets
    .filter(_canNavigateStarTarget)
    .sort(_compareStarTargets)
    .filter(target => {
      const key = _targetKey(target);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function _stepSubRank(sub) {
  if (sub === 'thinking') return -0.5;
  if (typeof sub === 'number') return sub;
  return -1;
}

function _compareStepTargets(a, b) {
  if (a.stepIdx !== b.stepIdx) return a.stepIdx - b.stepIdx;
  const subDiff = _stepSubRank(a.sub) - _stepSubRank(b.sub);
  if (subDiff !== 0) return subDiff;
  return _targetKey(a).localeCompare(_targetKey(b));
}

function _getTimelineStarNavTargets() {
  if (!window.xrayStars || typeof targetFromStar !== 'function' || selectedTurnIdx < 0) return [];
  const entry = allEntries[selectedTurnIdx];
  if (!entry || !entry.id) return [];

  return [...(window.xrayStars.steps || [])]
    .map(id => targetFromStar('step', id))
    .filter(target => target && target.entryId === entry.id && _canNavigateStarTarget(target))
    .sort(_compareStepTargets);
}

function _hasTimelineStarNavTargets() {
  return _getTimelineStarNavTargets().length > 0;
}

function jumpToTimelineStar(dir) {
  const targets = _getTimelineStarNavTargets();
  if (!targets.length) {
    if (typeof showToast === 'function') showToast('No starred steps in this timeline', 2000);
    return false;
  }

  const current = typeof targetFromCurrentSelection === 'function' ? targetFromCurrentSelection() : null;
  let idx = current && current.kind === 'step'
    ? targets.findIndex(t => _targetKey(t) === _targetKey(current))
    : -1;

  if (idx >= 0) {
    idx = dir === 'prev'
      ? (idx > 0 ? idx - 1 : targets.length - 1)
      : (idx < targets.length - 1 ? idx + 1 : 0);
  } else if (current && current.kind === 'step') {
    idx = dir === 'prev' ? targets.length - 1 : 0;
    for (let i = 0; i < targets.length; i++) {
      const cmp = _compareStepTargets(targets[i], current);
      if (dir === 'next' && cmp > 0) { idx = i; break; }
      if (dir === 'prev' && cmp < 0) idx = i;
    }
  } else {
    idx = dir === 'prev' ? targets.length - 1 : 0;
  }

  const target = targets[idx];
  if (!target || typeof navigateTarget !== 'function') return false;
  navigateTarget(target, { focus: true, scroll: true, smooth: false }).then(result => {
    if (result && result.ok === false && typeof showToast === 'function') {
      showToast('Star jump failed: ' + result.reason, 2500);
    }
  });
  return true;
}

function jumpToStar(dir) {
  const targets = _getStarNavTargets();
  if (!targets.length) {
    if (typeof showToast === 'function') showToast('No starred items', 2000);
    return false;
  }

  const current = typeof targetFromCurrentSelection === 'function' ? targetFromCurrentSelection() : null;
  const currentKey = _targetKey(current);
  let idx = targets.findIndex(t => _targetKey(t) === currentKey);
  if (idx >= 0) {
    idx = dir === 'prev'
      ? (idx > 0 ? idx - 1 : targets.length - 1)
      : (idx < targets.length - 1 ? idx + 1 : 0);
  } else if (current) {
    const curSort = _starSortKey(current);
    idx = dir === 'prev' ? targets.length - 1 : 0;
    for (let i = 0; i < targets.length; i++) {
      const cmp = _compareSortKeys(_starSortKey(targets[i]), curSort);
      if (dir === 'next' && cmp > 0) { idx = i; break; }
      if (dir === 'prev' && cmp < 0) idx = i;
    }
  } else {
    idx = dir === 'prev' ? targets.length - 1 : 0;
  }

  const target = targets[idx];
  if (!target || typeof navigateTarget !== 'function') return false;
  navigateTarget(target, { focus: true, scroll: true, smooth: false }).then(result => {
    if (result && result.ok === false && typeof showToast === 'function') {
      showToast('Star jump failed: ' + result.reason, 2500);
    }
  });
  return true;
}

function _compareSortKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) < (b[i] || 0)) return -1;
    if ((a[i] || 0) > (b[i] || 0)) return 1;
  }
  return 0;
}

function _timelineCallMatchesType(call, type) {
  if (!call) return false;
  if (type === 'error') return !!call.isError;
  if (type === 'skill') return call.name === 'Skill';
  if (type === 'subagent') return call.name === 'Agent' || call.name === 'Task';
  if (type === 'mcp') return String(call.name || '').startsWith('mcp__');
  return false;
}

function _hasTimelineStepType(type) {
  if (!isFocusedMode || selectedSection !== 'timeline' || !Array.isArray(currentSteps)) return false;
  return currentSteps.some(step => step && step.type === 'tool-group' && step.calls.some(call => _timelineCallMatchesType(call, type)));
}

function _timelineStepElementMatchesType(el, type) {
  if (!el) return false;
  if (type === 'error') return el.dataset.hasError === '1';
  if (type === 'skill') return el.dataset.tool === 'Skill';
  if (type === 'subagent') return el.dataset.tool === 'Agent' || el.dataset.tool === 'Task';
  if (type === 'mcp') return (el.dataset.tool || '').startsWith('mcp__');
  return false;
}

function isEnabled(keyId) {
  switch (keyId) {
    case '→-projects':     return projectsMap.size > 0;
    case '→-sessions':     return selectedSessionId != null || colSessions.querySelectorAll('.session-item').length > 0;
    case '→-turns':        return selectedTurnIdx >= 0;
    case '→-sections':     return selectedSection != null;
    case 'enter-sections': return selectedSection != null;
    case 'f-star':         return getStarTargetFromSelection() !== null;
    case 'star-nav':       return _hasStarNavTargets();
    case 'timeline-star-nav': return _hasTimelineStarNavTargets();
    case 'timeline-jump-error': return _hasTimelineStepType('error');
    case 'timeline-jump-skill': return _hasTimelineStepType('skill');
    case 'timeline-jump-subagent': return _hasTimelineStepType('subagent');
    case 'timeline-jump-mcp': return _hasTimelineStepType('mcp');
    default:               return true;
  }
}

function getCmdBarState() {
  if (_loading) return null;
  if (typeof activeTab !== 'undefined' && activeTab !== 'dashboard') return null;

  if (isFocusedMode) {
    if (selectedSection === 'timeline') {
      return {
        row1: [
          { key: '↑↓', label: 'steps' },
          { key: 'Esc/←', label: 'exit', clickKey: 'Escape' },
          { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
          ..._starNavItems('timeline-star-nav'),
        ],
        row2: [
          { key: 'e', label: 'next error',    id: 'timeline-jump-error', clickKey: 'e' },
          { key: 'E', label: 'prev error',    id: 'timeline-jump-error', clickKey: 'E' },
          { key: 's', label: 'next skill',    id: 'timeline-jump-skill', clickKey: 's' },
          { key: 'S', label: 'prev skill',    id: 'timeline-jump-skill', clickKey: 'S' },
          { key: 'a', label: 'next subagent', id: 'timeline-jump-subagent', clickKey: 'a' },
          { key: 'A', label: 'prev subagent', id: 'timeline-jump-subagent', clickKey: 'A' },
          { key: 'm', label: 'next mcp',      id: 'timeline-jump-mcp', clickKey: 'm' },
          { key: 'M', label: 'prev mcp',      id: 'timeline-jump-mcp', clickKey: 'M' },
        ],
        row2Visible: false,
      };
    }
    return {
      row1: [
        { key: '↑↓', label: 'switch section' },
        { key: 'Esc/←', label: 'exit', clickKey: 'Escape' },
        { key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' },
        ..._starNavItems(),
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
        ..._starNavItems(),
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
        ..._starNavItems(),
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
        ..._starNavItems(),
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
        ..._starNavItems(),
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
      const enabled = item.id ? isEnabled(item.id) : true;
      const cls = enabled ? 'cmd-key' : 'cmd-key disabled';
      if (item.clickKey && enabled) {
        const k = item.clickKey.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<button class="${cls} cmd-key-btn" tabindex="-1" onclick="document.dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',bubbles:true}))"><kbd>${item.key}</kbd> ${item.label}</button>`;
      }
      return `<span class="${cls}"><kbd>${item.key}</kbd> ${item.label}</span>`;
    }).join('<span class="cmd-sep">·</span>');
  }

  const items = (state.row1 || []).concat(state.row2 || []);
  row1.innerHTML = buildRow(items);
  row2.innerHTML = '';
  row2.classList.remove('visible');
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

  if (key === 'n' || key === 'N') {
    const dir = key === 'N' ? 'prev' : 'next';
    const jumped = isFocusedMode && selectedSection === 'timeline'
      ? jumpToTimelineStar(dir)
      : jumpToStar(dir);
    if (jumped) e.preventDefault();
    return;
  }

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

  const candidates = allStepEls.filter(el => _timelineStepElementMatchesType(el, type));

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
