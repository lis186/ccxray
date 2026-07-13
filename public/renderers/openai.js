// OpenAI response event parser for buildMergedSteps.
// Handles response.* events from HTTP SSE and WebSocket frames.
//
// Helper functions (getResponseEventPayload, getResponseEventItemId,
// getResponseFunctionCallName) are defined in messages.js and available
// as globals since this script loads before messages.js runs buildMergedSteps.

// Stream-timing contract (#195): mirrors the anthropic renderer, stamping the
// four provider-neutral fields computeStreamTiming() reads onto `state` from
// OpenAI/Codex event shapes (response.created / first output delta /
// response.completed / usage). Codex WS frames do not carry `_ts` today
// (ws-proxy.js pushes them verbatim, #204), so streamStartTs/streamStopTs stay
// null → metrics return null → UI structured-empty. When #204 stamps `_ts` on
// the WS transport, these anchors light up with no change to messages.js.
window.RENDERERS.openai = {
  processEvent(ev, state) {
    const payload = getResponseEventPayload(ev);
    if (ev.type === 'response.created') {
      if (ev._ts != null) state.streamStartTs = ev._ts;
    } else if (ev.type === 'response.completed' || ev.type === 'response.done') {
      if (ev._ts != null) state.streamStopTs = ev._ts;
      const usage = (payload.response && payload.response.usage) || (ev.response && ev.response.usage) || payload.usage;
      if (usage && usage.output_tokens != null) state.outputTokens = usage.output_tokens;
    }
    if (ev.type === 'response.output_text.delta') {
      state.curText += ev.delta || payload.delta || '';
      if (state.firstContentTs == null && ev._ts != null) state.firstContentTs = ev._ts;
    } else if (ev.type === 'response.output_text.done' && !state.curText) {
      state.curText += ev.text || payload.text || '';
    } else if (ev.type === 'response.reasoning_text.delta') {
      if (state.curThinking === null) {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      }
      state.curThinking += ev.delta || payload.delta || '';
      if (state.firstContentTs == null && ev._ts != null) state.firstContentTs = ev._ts;
    } else if (ev.type === 'response.reasoning_summary_part.added') {
      if (state.curThinking === null) {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      }
      const part = payload.part || ev.part || {};
      state.curThinking += part.text || payload.text || ev.text || '';
      if (state.firstContentTs == null && ev._ts != null) state.firstContentTs = ev._ts;
    } else if (ev.type === 'response.reasoning_summary_text.delta') {
      if (state.curThinking === null) {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      }
      state.curThinking += ev.delta || payload.delta || '';
      if (state.firstContentTs == null && ev._ts != null) state.firstContentTs = ev._ts;
    } else if (ev.type === 'response.output_item.added') {
      const item = payload.item || ev.item || {};
      if (item.type === 'function_call' || item.type === 'tool_call') {
        const id = getResponseEventItemId(payload, state.eventIndex);
        const toolUse = {
          index: payload.output_index ?? state.eventIndex,
          name: getResponseFunctionCallName(item),
          id,
          inputChunks: [],
        };
        if (item.arguments) toolUse.inputChunks.push(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments));
        state.openAIToolUseById.set(id, toolUse);
        state.curToolUses.push(toolUse);
      }
    } else if (ev.type === 'response.function_call_arguments.delta') {
      const id = getResponseEventItemId(payload, payload.output_index ?? state.eventIndex);
      const tu = state.openAIToolUseById.get(id) || state.curToolUses.find(t => t.index === payload.output_index);
      if (tu) tu.inputChunks.push(ev.delta || payload.delta || '');
    } else if (ev.type === 'response.output_item.done') {
      const item = payload.item || ev.item || {};
      if (item.type === 'function_call' || item.type === 'tool_call') {
        const id = getResponseEventItemId(payload, state.eventIndex);
        const tu = state.openAIToolUseById.get(id) || state.curToolUses.find(t => t.index === payload.output_index);
        if (tu && item.arguments && !tu.inputChunks.length) {
          tu.inputChunks.push(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments));
        }
      }
    } else if (ev.type === 'response.completed' || ev.type === 'response.done') {
      if (state.curThinkingStart && !state.curThinkingEnd) state.curThinkingEnd = ev._ts || null;
    }
  },
};
