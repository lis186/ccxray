'use strict';

// Fake Anthropic / OpenAI upstream for the agentflow fixture generator. Ids are
// a counter, usage is fixed, so a run is reproducible apart from wall time.
const http = require('node:http');

let n = 0;
const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    n++;
    const reply = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (pathname.endsWith('/messages')) {
      return reply({ id: `msg_gen${String(n).padStart(4, '0')}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 8, cache_creation_input_tokens: 0 } });
    }
    if (pathname.endsWith('/responses')) {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
      return reply({ id: `resp_gen${String(n).padStart(4, '0')}`, object: 'response', model: body.model || 'gpt-5.5', status: 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 40 } } });
    }
    res.writeHead(404).end('not found');
  });
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('disconnect', () => process.exit(0));
