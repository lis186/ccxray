// Anthropic SSE event parser for buildMergedSteps.
// Handles content_block_start/delta/stop events → shared step state.
//
// Stream-timing contract (#195): also stamps the four provider-neutral timing
// fields computeStreamTiming() reads — streamStartTs (message_start),
// firstContentTs (first text/thinking content delta), streamStopTs
// (message_stop), outputTokens (message_delta.usage). The OpenAI renderer
// fills the same fields from its own event shapes, so the derivation in
// messages.js never branches on provider. See docs/decisions if promoted.
window.RENDERERS.anthropic = {
  processEvent(ev, state) {
    if (ev.type === 'message_start') {
      if (ev._ts != null) state.streamStartTs = ev._ts;
    } else if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'thinking') {
        state.curThinking = '';
        state.curThinkingStart = ev._ts || null;
      } else if (ev.content_block?.type === 'tool_use') {
        state.curToolUses.push({
          index: ev.index,
          name: ev.content_block.name,
          id: ev.content_block.id,
          inputChunks: [],
        });
      }
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'thinking_delta') {
        if (state.curThinking !== null) state.curThinking += ev.delta.thinking || '';
        if (state.firstContentTs == null && ev._ts != null) state.firstContentTs = ev._ts;
      } else if (ev.delta?.type === 'input_json_delta') {
        const tu = state.curToolUses.find(t => t.index === ev.index);
        if (tu) tu.inputChunks.push(ev.delta.partial_json || '');
      } else if (ev.delta?.type === 'text_delta') {
        state.curText += ev.delta.text || '';
        if (state.firstContentTs == null && ev._ts != null) state.firstContentTs = ev._ts;
      }
    } else if (ev.type === 'content_block_stop') {
      if (state.curThinkingStart && !state.curThinkingEnd) state.curThinkingEnd = ev._ts || null;
    } else if (ev.type === 'message_delta') {
      if (ev.usage && ev.usage.output_tokens != null) state.outputTokens = ev.usage.output_tokens;
    } else if (ev.type === 'message_stop') {
      if (ev._ts != null) state.streamStopTs = ev._ts;
    }
  },
};
