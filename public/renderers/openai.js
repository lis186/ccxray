// OpenAI response event parser for buildMergedSteps.
// Handles response.* events from HTTP SSE and WebSocket frames.
//
// Helper functions (getResponseEventPayload, getResponseEventItemId,
// getResponseFunctionCallName) are defined in messages.js and available
// as globals since this script loads before messages.js runs buildMergedSteps.

window.RENDERERS.openai = {
  processEvent(ev, state) {
    const payload = getResponseEventPayload(ev);
    if (ev.type === 'response.output_text.delta') {
      state.curText += ev.delta || payload.delta || '';
    } else if (ev.type === 'response.output_text.done' && !state.curText) {
      state.curText += ev.text || payload.text || '';
    } else if (ev.type === 'response.reasoning_text.delta') {
      if (state.curThinking === null) {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      }
      state.curThinking += ev.delta || payload.delta || '';
    } else if (ev.type === 'response.reasoning_summary_part.added') {
      if (state.curThinking === null) {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      }
      const part = payload.part || ev.part || {};
      state.curThinking += part.text || payload.text || ev.text || '';
    } else if (ev.type === 'response.reasoning_summary_text.delta') {
      if (state.curThinking === null) {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      }
      state.curThinking += ev.delta || payload.delta || '';
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
