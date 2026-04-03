// ── Messages column helpers ──
const INJECTED_TAG_RE = /^<(system-reminder|user-prompt-submit-hook|context|antml:function_calls)[^>]*>/;
function classifyUserMessage(msg) {
  if (msg.role !== 'user') return null;
  const blocks = Array.isArray(msg.content)
    ? msg.content
    : [{ type: 'text', text: String(msg.content || '') }];
  const hasToolResult = blocks.some(b => b.type === 'tool_result');
  const hasHuman = blocks.some(b => b.type === 'text' && b.text && !INJECTED_TAG_RE.test(b.text.trimStart()));
  const hasSystem = blocks.some(b => b.type === 'text' && b.text && INJECTED_TAG_RE.test(b.text.trimStart()));
  if (!hasToolResult && !hasHuman && !hasSystem) return null;
  return { hasHuman, hasSystem, hasToolResult };
}

function getUserBadgeHtml(cls) {
  let html = '';
  if (cls.hasHuman) html += '<span class="msg-badge msg-badge-human">YOU</span> ';
  if (cls.hasSystem) html += '<span class="msg-badge msg-badge-system">SYS</span> ';
  if (cls.hasToolResult) html += '<span class="msg-badge msg-badge-tool_results">TOOL</span> ';
  return html;
}

function getUserMessagePreview(msg, cls) {
  if (cls.hasToolResult && !cls.hasHuman) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const count = blocks.filter(b => b.type === 'tool_result').length;
    return count + ' result' + (count !== 1 ? 's' : '');
  }
  const blocks = Array.isArray(msg.content)
    ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
  const text = blocks
    .filter(b => b.type === 'text' && b.text && !INJECTED_TAG_RE.test(b.text.trimStart()))
    .map(b => b.text).join(' ').trim();
  return text.slice(0, 40) || getMessagePreview(msg);
}

function classifyAssistantMessage(msg) {
  if (msg.role !== 'assistant') return null;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const tools = blocks.filter(b => b.type === 'tool_use');
  const thinkingBlock = blocks.find(b => b.type === 'thinking');
  const hasThinking = !!thinkingBlock;
  const hasCall = tools.length > 0;
  if (!hasThinking && !hasCall) return null;
  const thinkingText = thinkingBlock ? (thinkingBlock.thinking || '') : '';
  return { hasThinking, hasCall, tools, thinkingText };
}

function getAssistantBadgeHtml(asmCls) {
  let html = '';
  if (asmCls.hasThinking) html += '<span class="msg-badge msg-badge-think">THINK</span> ';
  if (asmCls.hasCall) html += '<span class="msg-badge msg-badge-call">CALL</span> ';
  return html;
}

function getAssistantPreview(asmCls) {
  if (!asmCls.hasCall) return '';
  const first = asmCls.tools[0].name || '?';
  return asmCls.tools.length > 1 ? first + ' +' + (asmCls.tools.length - 1) : first;
}

function getMessagePreview(m) {
  if (typeof m.content === 'string') return m.content.slice(0, 40);
  if (!Array.isArray(m.content) || !m.content.length) return '';
  const first = m.content[0];
  if (first.type === 'text') return first.text.slice(0, 40);
  if (first.type === 'tool_use') return '[tool] ' + first.name;
  if (first.type === 'tool_result') return '[result]';
  if (first.type === 'image') return '[image]';
  return first.type || '';
}

// ── Merged Steps: transform flat messages into logical steps ──
function getToolPreview(toolUse) {
  const inp = toolUse.input || {};
  switch (toolUse.name) {
    case 'Bash': return (inp.command || '').split('\n')[0].slice(0, 60);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
      return (inp.file_path || inp.notebook_path || '').split('/').pop() || '';
    case 'Grep': return (inp.pattern || '').slice(0, 40);
    case 'Glob': return (inp.pattern || '').slice(0, 40);
    case 'Agent': return (inp.description || inp.prompt || '').slice(0, 50);
    case 'Skill': return inp.skill || '';
    case 'TaskCreate': return (inp.subject || '').slice(0, 40);
    case 'TaskUpdate': return (inp.taskId || '') + (inp.status ? ' → ' + inp.status : '');
    case 'TaskStop': return inp.task_id || '';
    case 'TaskOutput': return inp.task_id || '';
    case 'WebSearch': return (inp.query || '').slice(0, 50);
    case 'WebFetch': return (inp.url || '').replace(/^https?:\/\//, '').slice(0, 50);
    default: {
      const firstKey = Object.keys(inp)[0];
      return firstKey ? String(inp[firstKey]).slice(0, 40) : '';
    }
  }
}

function buildMergedSteps(messages, resEvents) {
  if ((!messages || !messages.length) && (!resEvents || !resEvents.length)) return [];

  // Phase 1a: Build tool_use_id → tool_result map
  const resultMap = new Map();
  if (messages) {
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          resultMap.set(b.tool_use_id, b);
        }
      }
    }
  }

  // Phase 1b: Collect all tool_use_ids from assistant messages
  // After context compression, some tool_results may have no matching tool_use
  const knownToolUseIds = new Set();
  if (messages) {
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id) knownToolUseIds.add(b.id);
      }
    }
  }

  // Phase 2: Build history steps from messages
  const steps = [];
  if (messages) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];

      if (msg.role === 'user') {
        const humanTexts = blocks.filter(b => b.type === 'text' && b.text && !INJECTED_TAG_RE.test(b.text.trimStart()));
        const hasSys = blocks.some(b => b.type === 'text' && b.text && INJECTED_TAG_RE.test(b.text.trimStart()));
        const hasToolResult = blocks.some(b => b.type === 'tool_result');
        const hasOrphanedResult = blocks.some(b => b.type === 'tool_result' && b.tool_use_id && !knownToolUseIds.has(b.tool_use_id));
        if (humanTexts.length || (hasSys && !hasToolResult) || hasOrphanedResult) {
          steps.push({
            type: 'human',
            source: 'history',
            humanText: humanTexts.map(b => b.text).join('\n').slice(0, 200),
            hasSys,
            hasToolResult,
            msgIndices: [i],
          });
        }

      } else if (msg.role === 'assistant') {
        const thinkingBlock = blocks.find(b => b.type === 'thinking');
        const toolUses = blocks.filter(b => b.type === 'tool_use');
        const textBlocks = blocks.filter(b => b.type === 'text' && b.text && b.text.trim());

        if (textBlocks.length && !toolUses.length) {
          steps.push({
            type: 'assistant-text',
            source: 'history',
            text: textBlocks.map(b => b.text).join('\n'),
            msgIndices: [i],
          });
          continue;
        }

        if (toolUses.length) {
          const calls = toolUses.map(tu => {
            const result = resultMap.get(tu.id);
            const resultContent = result ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content)) : '';
            return {
              name: tu.name,
              preview: getToolPreview(tu),
              input: tu.input,
              result: result?.content,
              isError: !!(result?.is_error),
              errorSummary: result?.is_error ? resultContent.slice(0, 80) : '',
              toolUseId: tu.id,
              pending: !result,
            };
          });
          let resultMsgIdx = -1;
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === 'user') { resultMsgIdx = j; break; }
          }
          steps.push({
            type: 'tool-group',
            source: 'history',
            thinking: thinkingBlock ? (thinkingBlock.thinking || '') : null,
            calls,
            msgIndices: resultMsgIdx >= 0 ? [i, resultMsgIdx] : [i],
          });
          if (textBlocks.length) {
            steps.push({
              type: 'assistant-text',
              source: 'history',
              text: textBlocks.map(b => b.text).join('\n'),
              msgIndices: [i],
            });
          }
        } else if (thinkingBlock && !toolUses.length && !textBlocks.length) {
          steps.push({
            type: 'tool-group',
            source: 'history',
            thinking: thinkingBlock.thinking || '',
            calls: [],
            msgIndices: [i],
          });
        }
      }
    }
  }

  // Phase 3: Build current turn steps from resEvents
  if (resEvents && resEvents.length) {
    let curThinking = null;
    let curThinkingStart = null;
    let curThinkingEnd = null;
    const curToolUses = [];  // { index, name, id, inputChunks[] }
    let curText = '';

    for (const ev of resEvents) {
      if (ev.type === 'content_block_start') {
        if (ev.content_block?.type === 'thinking') {
          curThinking = '';
          curThinkingStart = ev._ts || null;
        } else if (ev.content_block?.type === 'tool_use') {
          curToolUses.push({
            index: ev.index,
            name: ev.content_block.name,
            id: ev.content_block.id,
            inputChunks: [],
          });
        }
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'thinking_delta') {
          if (curThinking !== null) curThinking += ev.delta.thinking || '';
        } else if (ev.delta?.type === 'input_json_delta') {
          const tu = curToolUses.find(t => t.index === ev.index);
          if (tu) tu.inputChunks.push(ev.delta.partial_json || '');
        } else if (ev.delta?.type === 'text_delta') {
          curText += ev.delta.text || '';
        }
      } else if (ev.type === 'content_block_stop') {
        if (curThinkingStart && !curThinkingEnd) curThinkingEnd = ev._ts || null;
      }
    }

    // Build current turn tool calls
    const currentCalls = curToolUses.map(tu => {
      let input = {};
      try { input = JSON.parse(tu.inputChunks.join('')); } catch {}
      return {
        name: tu.name,
        preview: getToolPreview({ name: tu.name, input }),
        input,
        result: null,
        isError: false,
        errorSummary: '',
        toolUseId: tu.id,
        pending: true,
      };
    });

    // Emit current turn thinking + tool group
    if (currentCalls.length || curThinking !== null) {
      const thinkingDuration = (curThinkingStart && curThinkingEnd)
        ? ((curThinkingEnd - curThinkingStart) / 1000) : null;
      steps.push({
        type: 'tool-group',
        source: 'current',
        thinking: curThinking,
        thinkingDuration,
        calls: currentCalls,
        msgIndices: [],
        resEventSource: true,
      });
    }

    // Emit current turn text
    if (curText.trim()) {
      steps.push({
        type: 'assistant-text',
        source: 'current',
        text: curText,
        msgIndices: [],
        resEventSource: true,
      });
    }
  }

  return steps;
}

let currentSteps = []; // cached merged steps for current turn
let _stepsCache = { msgs: null, res: null, steps: [] };

// Memoized buildMergedSteps — returns cached result if inputs unchanged (by reference)
function getCachedSteps(messages, resEvents) {
  if (messages === _stepsCache.msgs && resEvents === _stepsCache.res) {
    return _stepsCache.steps;
  }
  const steps = buildMergedSteps(messages, resEvents);
  _stepsCache = { msgs: messages, res: resEvents, steps };
  return steps;
}

// Build timeline steps and cache them
function prepareTimelineSteps(messages, resEvents) {
  if ((!messages || !messages.length) && (!resEvents || !resEvents.length)) {
    currentSteps = [];
    return;
  }
  currentSteps = getCachedSteps(messages, resEvents);
}

// Generate the step list HTML (used in both accordion and split-pane modes)
function renderStepListHtml(steps, activeStepKey) {
  let html = '';
  let lastSource = null;

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];

    // Insert history/current separator
    if (lastSource === 'history' && step.source === 'current') {
      html += '<div style="display:flex;align-items:center;margin:8px 8px 4px;gap:6px"><div style="flex:1;border-top:1px dashed var(--accent)"></div><span style="font-size:10px;color:var(--accent);white-space:nowrap">current turn</span><div style="flex:1;border-top:1px dashed var(--accent)"></div></div>';
    }
    lastSource = step.source;

    if (step.type === 'human') {
      html += '<div class="step-separator" style="height:2px;background:var(--accent);margin:8px 0 2px"></div>';
      const sel = (activeStepKey === si + ':') ? ' active' : '';
      html += '<div class="tl-step-summary' + sel + '" data-step="' + si + '" onclick="selectStep(' + si + ')">';
      html += '<div style="color:var(--accent);padding:6px 8px;font-size:12px;white-space:normal;line-height:1.5;background:rgba(88,166,255,0.08);border-radius:4px;border-left:2px solid var(--accent);margin:4px 0">';
      html += '<span style="font-size:13px">👤</span> ' + escapeHtml((step.humanText || '').slice(0, 300));
      html += '</div>';
      if (step.hasSys) html += '<div style="padding:0 8px 0 24px;font-size:10px;color:var(--dim)">📋 system-reminder</div>';
      html += '</div>';
      html += '<div style="height:2px;background:var(--accent);margin:2px 0 4px"></div>';

    } else if (step.type === 'tool-group') {
      // Thinking line — T8: history=indicator only, current=Ns+preview
      if (step.thinking != null) {
        const tSel = (activeStepKey === si + ':thinking') ? ' active' : '';
        html += '<div class="tl-step-summary' + tSel + '" data-step="' + si + '" data-sub="thinking" onclick="selectStep(' + si + ',&quot;thinking&quot;)" style="color:var(--dim);padding:2px 8px;font-size:11px">';
        if (step.source === 'history') {
          html += '🧠'; // indicator only — prior turn content not shown
        } else {
          const durLabel = step.thinkingDuration ? ' ' + step.thinkingDuration.toFixed(1) + 's' : '';
          const thinkPreview = (step.thinking || '').slice(0, 80).replace(/\n/g, ' ').trim();
          html += '🧠' + durLabel + (thinkPreview ? ' <span style="opacity:0.7">' + escapeHtml(thinkPreview) + '…</span>' : '');
        }
        html += '</div>';
      }
      // Tool calls
      const calls = step.calls;
      const isParallel = calls.length > 1;
      for (let ci = 0; ci < calls.length; ci++) {
        const c = calls[ci];
        const bracket = isParallel ? (ci === 0 ? '┌' : ci === calls.length - 1 ? '└' : '│') : ' ';
        const cSel = (activeStepKey === si + ':' + ci) ? ' active' : '';
        // T6: error highlighting — CSS class + data-has-error for filter/jump
        const errCls = c.isError ? ' tool-call-error' : '';
        const errAttr = c.isError ? ' data-has-error="1"' : '';
        html += '<div class="tl-step-summary' + cSel + errCls + '" data-step="' + si + '" data-call="' + ci + '"' + errAttr + ' onclick="selectStep(' + si + ',' + ci + ')">';
        html += '<div class="msg-list-row" style="gap:4px">';
        html += '<span style="color:var(--dim);width:8px;text-align:center;flex-shrink:0">' + bracket + '</span>';
        html += '<span style="color:var(--green);min-width:40px;flex-shrink:0;font-weight:600">' + escapeHtml(c.name) + '</span>';
        html += '<span style="color:var(--text);opacity:0.8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(c.preview) + '</span>';
        if (c.pending) {
          html += '<span style="color:var(--dim)">⏳</span>';
        } else {
          html += '<span style="color:' + (c.isError ? 'var(--red)' : 'var(--dim)') + ';flex-shrink:0">' + (c.isError ? '✗' : '✓') + '</span>';
        }
        html += '</div>';
        if (c.isError && c.errorSummary) {
          html += '<div style="padding:1px 8px 2px 52px;font-size:10px;color:var(--red)">' + escapeHtml(c.errorSummary.slice(0, 60)) + '</div>';
        }
        html += '</div>';
      }

    } else if (step.type === 'assistant-text') {
      const aSel = (activeStepKey === si + ':') ? ' active' : '';
      html += '<div class="tl-step-summary' + aSel + '" data-step="' + si + '" onclick="selectStep(' + si + ')">';
      html += '<div style="color:var(--text);padding:6px 8px;font-size:12px;white-space:normal;line-height:1.5;background:rgba(63,185,80,0.08);border-radius:4px;border-left:2px solid var(--green);margin:4px 0">';
      html += '<span style="font-size:13px">🤖</span> ' + escapeHtml((step.text || '').slice(0, 200));
      html += '</div>';
      html += '</div>';
    }
  }
  return html;
}

// Get the active step key string for highlighting
function getActiveStepKey() {
  if (selectedMessageIdx < 0) return null;
  const stepIdx = Math.floor(selectedMessageIdx / 1000);
  const subIdx = selectedMessageIdx % 1000;
  if (subIdx === 999) return stepIdx + ':thinking';
  return stepIdx + ':' + (subIdx || '');
}

// Render step detail content as HTML
function renderStepDetailHtml(req, tok) {
  if (selectedMessageIdx < 0) return '';
  const stepIdx = Math.floor(selectedMessageIdx / 1000);
  const subIdx = selectedMessageIdx % 1000;
  const step = currentSteps[stepIdx];
  if (!step) return '<div class="col-empty">No step data</div>';

  if (step.type === 'human') {
    const msgIdx = step.msgIndices[0];
    const msg = req?.messages?.[msgIdx];
    return msg ? '<div class="detail-content">' + renderSingleMessage(msg, tok?.perMessage?.[msgIdx], msgIdx) + '</div>' : '<div class="col-empty">No message</div>';
  } else if (step.type === 'assistant-text') {
    return '<div class="detail-content"><pre>' + escapeHtml(step.text || '') + '</pre></div>';
  } else if (step.type === 'tool-group') {
    if (subIdx === 999) {
      const durLabel = step.thinkingDuration ? ' · ' + step.thinkingDuration.toFixed(1) + 's' : '';
      return '<div class="detail-content">' + renderThinkingDetail(step.thinking, durLabel) + '</div>';
    } else if (subIdx < step.calls.length) {
      return '<div class="detail-content">' + renderToolDetail(step.calls[subIdx]) + '</div>';
    } else {
      const c = step.calls[0];
      return c ? '<div class="detail-content">' + renderToolDetail(c) + '</div>' : '<div class="col-empty">Empty tool group</div>';
    }
  }
  return '<div class="col-empty">Unknown step type</div>';
}

function selectStep(stepIdx, sub) {
  if (!currentSteps[stepIdx]) return; // guard: invalid step index
  // If not in focused mode, enter it first (click on step = drill into timeline)
  if (!isFocusedMode && typeof enterFocusedMode === 'function') {
    selectedMessageIdx = stepIdx * 1000 + (sub === 'thinking' ? 999 : (typeof sub === 'number' ? sub : 0));
    enterFocusedMode();
    return;
  }
  if (sub === 'thinking') {
    selectedMessageIdx = stepIdx * 1000 + 999;
  } else if (typeof sub === 'number') {
    selectedMessageIdx = stepIdx * 1000 + sub;
  } else {
    selectedMessageIdx = stepIdx * 1000;
  }

  // Split pane: update list highlights + detail pane
  const listEl = colDetail.querySelector('.tl-scroll-area');
  const detailEl = colDetail.querySelector('.tl-split-detail');
  if (listEl) {
    listEl.querySelectorAll('.tl-step-summary').forEach(el => {
      el.classList.remove('active');
      const elStep = parseInt(el.dataset.step);
      const elCall = el.dataset.call != null ? parseInt(el.dataset.call) : -1;
      const elSub = el.dataset.sub;
      if (elStep === stepIdx) {
        if (sub === 'thinking' && elSub === 'thinking') el.classList.add('active');
        else if (typeof sub === 'number' && elCall === sub) el.classList.add('active');
        else if (sub == null && (elCall < 0 || elCall === 0) && !elSub) el.classList.add('active');
      }
    });
  }
  if (detailEl) {
    const e = selectedTurnIdx >= 0 ? allEntries[selectedTurnIdx] : null;
    detailEl.innerHTML = renderStepDetailHtml(e?.req, e?.tokens);
  }

  // Minimap active state — shared by both modes (step-level, not sub-item)
  const mm = colDetail.querySelector('.minimap');
  if (mm) {
    mm.querySelectorAll('.minimap-block').forEach(b =>
      b.classList.toggle('mm-active', b.dataset.step === String(stepIdx)));
  }
  renderBreadcrumb();
}

function selectMessage(idx) {
  selectedMessageIdx = idx;
  renderDetailCol();
  renderBreadcrumb();
}

function renderSingleMessage(msg, perMsg, msgIdx) {
  const tokLabel = perMsg ? ' <span class="badge">' + perMsg.tokens + ' tok</span>' : '';
  let body = '';
  if (typeof msg.content === 'string') {
    body = '<pre>' + escapeHtml(msg.content) + '</pre>';
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        body += '<div class="content-block"><div class="type">text</div><pre>' + escapeHtml(block.text) + '</pre></div>';
      } else if (block.type === 'tool_use') {
        body += '<div class="content-block"><div class="type">tool_use: ' + escapeHtml(block.name) +
          ' <span style="color:var(--dim);font-size:10px">' + escapeHtml(block.id || '') + '</span></div>' +
          '<pre>' + escapeHtml(JSON.stringify(block.input, null, 2)) + '</pre></div>';
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content : JSON.stringify(block.content, null, 2);
        body += '<div class="content-block"><div class="type">tool_result &larr; ' +
          escapeHtml(block.tool_use_id || '') + '</div>' +
          '<pre>' + escapeHtml(content) + '</pre></div>';
      } else if (block.type === 'image') {
        body += '<div class="content-block"><div class="type">image (' +
          escapeHtml(block.source?.media_type || '') + ')</div>' +
          '<div style="color:var(--dim);font-size:11px">[image data]</div></div>';
      } else {
        body += '<div class="content-block"><pre>' + escapeHtml(JSON.stringify(block, null, 2)) + '</pre></div>';
      }
    }
  }
  const cls = msg.role === 'user' ? classifyUserMessage(msg) : null;
  const asmCls = msg.role === 'assistant' ? classifyAssistantMessage(msg) : null;
  const clsHtml = cls
    ? ' ' + getUserBadgeHtml(cls).trimEnd()
    : asmCls
      ? ' ' + getAssistantBadgeHtml(asmCls).trimEnd()
      : '';
  return '<div class="msg"><div class="msg-role ' + msg.role + '">[' + msgIdx + '] ' + msg.role + clsHtml + tokLabel + '</div>' + body + '</div>';
}

// ── Token Minimap ──
// Color mapping for minimap blocks by content type
function mmBlockColor(stepType, blockType) {
  if (blockType === 'thinking') return 'var(--color-thinking)';
  if (blockType === 'tool_use') return 'var(--color-tool-use)';
  if (blockType === 'tool_result') return 'var(--color-tool-result)';
  if (stepType === 'human') return 'var(--accent)';
  if (stepType === 'text') return 'var(--green)';
  if (stepType === 'thinking') return 'var(--color-thinking)';
  if (stepType === 'tool-group') return 'var(--color-tool-use)';
  return 'var(--dim)';
}

// Build minimap block data from currentSteps + tok.perMessage
// Returns array of { stepIdx, color, tokens, label, isError }
function buildMinimapBlocks(steps, perMessage) {
  const blocks = [];
  if (!steps || !steps.length) return blocks;

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    const indices = step.msgIndices || [];
    const hasError = step.type === 'tool-group' && step.calls && step.calls.some(c => c.isError);

    if (step.type === 'human') {
      let totalTokens = 0;
      if (perMessage && indices.length) {
        for (const mi of indices) { totalTokens += (perMessage[mi]?.tokens || 0); }
      }
      blocks.push({ stepIdx: si, color: mmBlockColor('human'), tokens: totalTokens || 1, label: 'human', isError: false });
      continue;
    }

    if (perMessage && indices.length) {
      for (const mi of indices) {
        const pm = perMessage[mi];
        if (!pm) continue;
        if (pm.blocks && pm.blocks.length > 1) {
          for (const b of pm.blocks) {
            blocks.push({ stepIdx: si, color: mmBlockColor(step.type, b.type), tokens: b.tokens || 0, label: b.type + (b.name ? ':' + b.name : ''), isError: hasError });
          }
        } else {
          blocks.push({ stepIdx: si, color: mmBlockColor(step.type), tokens: pm.tokens || 1, label: step.type, isError: hasError });
        }
      }
    } else {
      blocks.push({ stepIdx: si, color: mmBlockColor(step.type), tokens: 1, label: step.type, isError: hasError });
    }
  }
  return blocks;
}

// Render minimap HTML — cache bar + blocks + viewport + usage label
function renderMinimapHtml(steps, perMessage, activeStepIdx, maxContext, usage) {
  const blocks = buildMinimapBlocks(steps, perMessage);
  if (!blocks.length) return '';

  const estimatedTotal = blocks.reduce((s, b) => s + b.tokens, 0) || 1;
  // Use API usage as authoritative total when available (same logic as progress bar)
  const apiTotal = usage
    ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
    : 0;
  const totalTokens = apiTotal > estimatedTotal ? apiTotal : estimatedTotal;
  const ctxWindow = maxContext || 200000;
  const usedPct = Math.min(100, totalTokens / ctxWindow * 100).toFixed(0);
  const remaining = Math.max(0, ctxWindow - totalTokens);

  let html = '';

  // Cache breakdown bar (D7) — 4px tall at top
  if (usage) {
    const cr = usage.cache_read_input_tokens || 0;
    const cw = usage.cache_creation_input_tokens || 0;
    const inp = usage.input_tokens || 0;
    const cacheTotal = cr + cw + inp;
    if (cacheTotal > 0) {
      html += '<div class="minimap-cache-bar">';
      if (cr) html += '<div style="width:' + (cr / cacheTotal * 100).toFixed(1) + '%;background:var(--color-cache-read)" title="cache_read: ' + cr.toLocaleString() + ' tok (' + (cr / cacheTotal * 100).toFixed(0) + '%)"></div>';
      if (cw) html += '<div style="width:' + (cw / cacheTotal * 100).toFixed(1) + '%;background:var(--color-cache-write)" title="cache_write: ' + cw.toLocaleString() + ' tok (' + (cw / cacheTotal * 100).toFixed(0) + '%)"></div>';
      if (inp) html += '<div style="width:' + (inp / cacheTotal * 100).toFixed(1) + '%;background:var(--color-input)" title="input: ' + inp.toLocaleString() + ' tok (' + (inp / cacheTotal * 100).toFixed(0) + '%)"></div>';
      html += '</div>';
    }
  }

  // Blocks container
  html += '<div class="minimap-blocks" data-total-tokens="' + totalTokens + '" data-max-context="' + ctxWindow + '">';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const isActive = activeStepIdx >= 0 && b.stepIdx === activeStepIdx;
    const errStyle = b.isError ? ';border-left:2px solid var(--red)' : '';
    const cls = 'minimap-block' + (b.isError ? ' mm-error' : '') + (isActive ? ' mm-active' : '');
    html += '<div class="' + cls + '" data-step="' + b.stepIdx + '" data-block="' + i + '" data-tokens="' + b.tokens + '" '
      + 'style="background:' + b.color + errStyle + '" '
      + 'title="' + b.label + ' · ' + b.tokens.toLocaleString() + ' tok"></div>';
  }
  html += '</div>';

  // Empty context area with tooltip
  html += '<div class="minimap-empty" title="' + remaining.toLocaleString() + ' remaining"></div>';

  // Usage label (hover only)
  html += '<div class="minimap-usage">' + usedPct + '%</div>';

  return html;
}

// Compute block heights — blocks region = (totalTokens / maxContext) * containerH
function layoutMinimapBlocks(minimapEl) {
  if (!minimapEl) return;
  const blocksContainer = minimapEl.querySelector('.minimap-blocks');
  const emptyEl = minimapEl.querySelector('.minimap-empty');
  if (!blocksContainer) return;

  const containerH = minimapEl.clientHeight;
  if (containerH <= 0) return;

  const blockEls = blocksContainer.querySelectorAll('.minimap-block');
  if (!blockEls.length) return;

  const maxContext = parseInt(blocksContainer.dataset.maxContext) || 200000;
  const totalTokens = parseInt(blocksContainer.dataset.totalTokens) || 1;

  // Blocks region height = proportion of context used
  const usedRatio = Math.min(1, totalTokens / maxContext);
  // Subtract cache bar (4px) from available height
  const cacheBar = minimapEl.querySelector('.minimap-cache-bar');
  const cacheBarH = cacheBar ? cacheBar.offsetHeight : 0;
  const availH = containerH - cacheBarH;
  const blocksH = Math.max(blockEls.length, usedRatio * availH);

  // Scale factor — fit all blocks within the proportional region
  // Use actual sum of block tokens (not apiTotal) so blocks fill the region completely
  let blockTokenSum = 0;
  for (const el of blockEls) blockTokenSum += parseInt(el.dataset.tokens) || 1;
  const scale = blocksH / (blockTokenSum || 1);

  for (const el of blockEls) {
    const tokens = parseInt(el.dataset.tokens) || 1;
    el.style.height = Math.max(0.5, tokens * scale) + 'px';
  }

  blocksContainer.style.height = blocksH + 'px';

  // Empty area fills the rest
  if (emptyEl) {
    const emptyH = Math.max(0, availH - blocksH);
    emptyEl.style.height = emptyH + 'px';
  }
}

// Wire up minimap interactions: click, hover
let _minimapCleanup = null;
function initMinimapInteractions(minimapEl, scrollAreaEl) {
  if (_minimapCleanup) { _minimapCleanup(); _minimapCleanup = null; }
  if (!minimapEl || !scrollAreaEl) return;

  const blocksContainer = minimapEl.querySelector('.minimap-blocks');
  if (!blocksContainer) return;

  // Find which block is at a given Y position (relative to minimap top)
  function blockAtY(y) {
    const blockEls = blocksContainer.querySelectorAll('.minimap-block');
    const mmRect = minimapEl.getBoundingClientRect();
    for (const b of blockEls) {
      const bRect = b.getBoundingClientRect();
      const bTop = bRect.top - mmRect.top;
      if (y >= bTop && y < bTop + bRect.height) return b;
    }
    // Between sub-pixel blocks — find closest
    let closest = null, closestDist = Infinity;
    for (const b of blockEls) {
      const bRect = b.getBoundingClientRect();
      const bMid = (bRect.top - mmRect.top) + bRect.height / 2;
      const dist = Math.abs(y - bMid);
      if (dist < closestDist) { closestDist = dist; closest = b; }
    }
    return closest;
  }

  // Click to navigate
  minimapEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('minimap-empty')) return;
    const mmRect = minimapEl.getBoundingClientRect();
    const block = blockAtY(e.clientY - mmRect.top);
    if (block) {
      const targetStep = parseInt(block.dataset.step);
      if (targetStep >= 0 && typeof selectStep === 'function') {
        selectStep(targetStep);
        const stepEl = scrollAreaEl.querySelector('[data-step="' + targetStep + '"]');
        if (stepEl) stepEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  });

  // Minimap → Timeline hover
  minimapEl.addEventListener('mousemove', (e) => {
    if (e.target.classList.contains('minimap-empty')) {
      minimapEl.querySelectorAll('.mm-highlight').forEach(b => b.classList.remove('mm-highlight'));
      scrollAreaEl.querySelectorAll('.mm-hover').forEach(el => el.classList.remove('mm-hover'));
      return;
    }
    const mmRect = minimapEl.getBoundingClientRect();
    const block = blockAtY(e.clientY - mmRect.top);
    if (block) {
      const stepIdx = block.dataset.step;
      minimapEl.querySelectorAll('.minimap-block').forEach(b => b.classList.toggle('mm-highlight', b.dataset.step === stepIdx));
      scrollAreaEl.querySelectorAll('.tl-step-summary').forEach(el => el.classList.toggle('mm-hover', el.dataset.step === stepIdx));
    }
  });
  minimapEl.addEventListener('mouseleave', () => {
    minimapEl.querySelectorAll('.mm-highlight').forEach(b => b.classList.remove('mm-highlight'));
    scrollAreaEl.querySelectorAll('.mm-hover').forEach(el => el.classList.remove('mm-hover'));
  });

  // Timeline → minimap hover
  scrollAreaEl.addEventListener('mouseover', (e) => {
    const stepEl = e.target.closest('.tl-step-summary');
    if (!stepEl) return;
    const stepIdx = stepEl.dataset.step;
    minimapEl.querySelectorAll('.minimap-block').forEach(b => b.classList.toggle('mm-highlight', b.dataset.step === stepIdx));
  });
  scrollAreaEl.addEventListener('mouseleave', () => {
    minimapEl.querySelectorAll('.mm-highlight').forEach(b => b.classList.remove('mm-highlight'));
  });

  // Recompute on resize
  const ro = new ResizeObserver(() => { layoutMinimapBlocks(minimapEl); });
  ro.observe(minimapEl);

  _minimapCleanup = () => { ro.disconnect(); };
}
