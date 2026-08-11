'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_FIELDS, buildIndexLine, deploymentFields } = require('../server/entry');
const { extractDuplicateToolCalls } = require('../server/helpers');

const EXCLUDED = ['req','res','tokens','method','url','_loaded','_writePromise','_loadingPromise'];
const LEGACY_INDEX_FIELDS = [
  'id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','skillCalls',
  'isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata',
  'stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt',
  'sysHash','toolsHash','coreHash','agentKey','agentLabel','convId','thinkingStripped','hasCredential','toolSources',
  'edited','editSummary','imported','importSource','responseId','turnToolCalls','turnToolFail',
  'turnToolCallIds','turnToolResults','beta1m',
];
const G2_LEGACY_ENTRY = {
  id:'G2', ts:'12:34:56', sessionId:'s', provider:'openai', agent:'codex', model:'gpt-5.5',
  msgCount:1, toolCount:0, toolCalls:{}, skillCalls:{}, isSubagent:false, sessionInferred:false,
  cwd:'/p', isSSE:true, usage:{input_tokens:1}, cost:null, maxContext:400000,
  responseMetadata:null, stopReason:'completed', title:null, thinkingDuration:null, toolFail:false,
  elapsed:'0.1', status:200, receivedAt:1786440000000, sysHash:null, toolsHash:null, coreHash:null,
  agentKey:null, agentLabel:null, convId:null, duplicateToolCalls:null,
};
const G2_LEGACY_LINE = '{"id":"G2","ts":"12:34:56","sessionId":"s","provider":"openai","agent":"codex","model":"gpt-5.5","msgCount":1,"toolCount":0,"toolCalls":{},"skillCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":"/p","isSSE":true,"usage":{"input_tokens":1},"cost":null,"maxContext":400000,"responseMetadata":null,"stopReason":"completed","title":null,"thinkingDuration":null,"toolFail":false,"elapsed":"0.1","status":200,"receivedAt":1786440000000,"sysHash":null,"toolsHash":null,"coreHash":null,"agentKey":null,"agentLabel":null,"convId":null}';

test('G1: INDEX_FIELDS preserves every legacy field name and order, then appends #504 fields', () => {
  assert.deepEqual(INDEX_FIELDS.slice(0, LEGACY_INDEX_FIELDS.length), LEGACY_INDEX_FIELDS);
  assert.deepEqual(INDEX_FIELDS.slice(LEGACY_INDEX_FIELDS.length), [
    'agentId','userEmail','team','agentType','localDate','tz','duplicateToolCalls',
  ]);
});

test('duplicateToolCalls omits null and persists a count object', () => {
  const withoutDuplicates = JSON.parse(buildIndexLine({ id: 'none', duplicateToolCalls: null }));
  assert.ok(!('duplicateToolCalls' in withoutDuplicates));

  const withDuplicates = JSON.parse(buildIndexLine({ id: 'dupes', duplicateToolCalls: { Bash: 2 } }));
  assert.deepEqual(withDuplicates.duplicateToolCalls, { Bash: 2 });
});

test('duplicate tool-call fixtures produce counts only when duplicates exist', () => {
  const duplicateFixture = [{ role: 'assistant', content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
  ] }];
  const duplicateEntry = JSON.parse(buildIndexLine({
    id: 'dupe-fixture',
    duplicateToolCalls: extractDuplicateToolCalls(duplicateFixture),
  }));
  assert.deepEqual(duplicateEntry.duplicateToolCalls, { Bash: 2 });

  const uniqueFixture = [{ role: 'assistant', content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
  ] }];
  const uniqueEntry = JSON.parse(buildIndexLine({
    id: 'unique-fixture',
    duplicateToolCalls: extractDuplicateToolCalls(uniqueFixture),
  }));
  assert.ok(!('duplicateToolCalls' in uniqueEntry));
});

test('deployment fields read env per call and derive reproducible local date/time zone', () => {
  const envNames = [
    'CCXRAY_AGENT_ID','CCXRAY_USER_EMAIL','CCXRAY_TEAM','CCXRAY_AGENT_TYPE',
    'CCXRAY_INDEX_LOCALE','TZ',
  ];
  const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  try {
    delete process.env.CCXRAY_AGENT_ID;
    delete process.env.CCXRAY_USER_EMAIL;
    delete process.env.CCXRAY_TEAM;
    process.env.CCXRAY_AGENT_TYPE = '';
    delete process.env.CCXRAY_INDEX_LOCALE;
    process.env.TZ = 'America/Los_Angeles';
    const ts = Date.parse('2026-01-15T07:30:00.000Z');

    const unsetFields = deploymentFields(ts);
    for (const key of ['agentId','userEmail','team','agentType']) assert.ok(!(key in unsetFields));
    assert.equal('localDate' in unsetFields, false);
    assert.equal('tz' in unsetFields, false);

    process.env.CCXRAY_AGENT_ID = 'machine-7';
    process.env.CCXRAY_USER_EMAIL = 'dev@example.com';
    process.env.CCXRAY_TEAM = 'platform';
    process.env.CCXRAY_AGENT_TYPE = 'claude-code';
    const withEnv = deploymentFields(ts);
    assert.deepEqual(
      { agentId: withEnv.agentId, userEmail: withEnv.userEmail, team: withEnv.team, agentType: withEnv.agentType },
      { agentId: 'machine-7', userEmail: 'dev@example.com', team: 'platform', agentType: 'claude-code' },
    );
    assert.equal('localDate' in withEnv, false);
    assert.equal('tz' in withEnv, false);

    process.env.CCXRAY_INDEX_LOCALE = '1';
    const losAngelesFields = deploymentFields(ts);
    assert.equal(losAngelesFields.localDate, '2026-01-14');
    assert.equal(losAngelesFields.tz, 'America/Los_Angeles');

    process.env.TZ = 'Asia/Tokyo';
    const tokyoFields = deploymentFields(ts);
    assert.equal(tokyoFields.localDate, '2026-01-15');
    assert.equal(tokyoFields.tz, 'Asia/Tokyo');
  } finally {
    for (const name of envNames) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('G2: a legacy-shaped entry without duplicates remains byte-identical', () => {
  const envNames = [
    'CCXRAY_AGENT_ID','CCXRAY_USER_EMAIL','CCXRAY_TEAM','CCXRAY_AGENT_TYPE','CCXRAY_INDEX_LOCALE',
  ];
  const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  try {
    for (const name of envNames) delete process.env[name];
    const line = buildIndexLine({
      ...G2_LEGACY_ENTRY,
      ...deploymentFields(G2_LEGACY_ENTRY.receivedAt),
    });
    const expectedKeys = LEGACY_INDEX_FIELDS.filter(key => G2_LEGACY_ENTRY[key] !== undefined);
    assert.deepEqual(Object.keys(JSON.parse(line)), expectedKeys);
    assert.equal(line, G2_LEGACY_LINE);
  } finally {
    for (const name of envNames) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('G2 negative control: locale opt-in adds localDate and tz', () => {
  const envNames = [
    'CCXRAY_AGENT_ID','CCXRAY_USER_EMAIL','CCXRAY_TEAM','CCXRAY_AGENT_TYPE',
    'CCXRAY_INDEX_LOCALE','TZ',
  ];
  const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  try {
    for (const name of envNames) delete process.env[name];
    process.env.CCXRAY_INDEX_LOCALE = '1';
    process.env.TZ = 'Asia/Taipei';
    const indexed = JSON.parse(buildIndexLine({
      ...G2_LEGACY_ENTRY,
      ...deploymentFields(G2_LEGACY_ENTRY.receivedAt),
    }));
    const expectedKeys = [
      ...LEGACY_INDEX_FIELDS.filter(key => G2_LEGACY_ENTRY[key] !== undefined),
      'localDate','tz',
    ];
    assert.deepEqual(Object.keys(indexed), expectedKeys);
    assert.equal(indexed.localDate, '2026-08-11');
    assert.equal(indexed.tz, 'Asia/Taipei');
  } finally {
    for (const name of envNames) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('buildIndexLine projects only INDEX_FIELDS, drops excluded + undefined', () => {
  const entry = {
    id: 'X', ts: '00:00:00', sessionId: 's', provider: 'openai', agent: 'codex',
    model: 'gpt-5.5', msgCount: 3, toolCount: 1, toolCalls: { Bash: 1 },
    isSubagent: false, sessionInferred: false, cwd: '/p', isSSE: true,
    usage: { input_tokens: 10 }, cost: { cost: 0.09 }, maxContext: 400000,
    responseMetadata: { transport: 'http' }, stopReason: 'completed', title: 't',
    thinkingDuration: null, toolFail: false, elapsed: '1.0', status: 200,
    receivedAt: 1, sysHash: null, toolsHash: null, coreHash: null,
    thinkingStripped: undefined, hasCredential: undefined, toolSources: undefined,
    // excluded / extra:
    req: { big: 1 }, res: [1,2,3], tokens: { total: 99 }, duplicateToolCalls: null,
    method: 'POST', url: '/v1/responses', _loaded: true, _writePromise: Promise.resolve(),
  };
  const obj = JSON.parse(buildIndexLine(entry));
  for (const k of EXCLUDED) assert.ok(!(k in obj), `excluded key leaked: ${k}`);
  assert.equal(obj.cost.cost, 0.09);
  assert.equal(obj.maxContext, 400000);
  for (const k of Object.keys(obj)) assert.ok(INDEX_FIELDS.includes(k), `non-INDEX key: ${k}`);
});

test('buildIndexLine persists responseId when set, omits it when undefined (#333)', () => {
  assert.ok(INDEX_FIELDS.includes('responseId'), 'responseId must be an index field');
  const withId = JSON.parse(buildIndexLine({ id: 'X', responseId: 'msg_01A' }));
  assert.equal(withId.responseId, 'msg_01A');
  const withoutId = JSON.parse(buildIndexLine({ id: 'X' }));
  assert.ok(!('responseId' in withoutId), 'undefined responseId must not be emitted');
});

// T1 legacy-parity: for each site, compare buildIndexLine(entry) against the GOLDEN
// legacy line that the old hand-rolled code emitted. Four rules:
//   (1) every legacy key present  (2) excluded keys absent
//   (3) any new key ∈ the site's explicit allowlist
//   (4) legacy key values deepEqual — except the allowlisted deliberate fixes.
function assertParity(entry, legacy, allowlist) {
  const got = JSON.parse(buildIndexLine(entry));
  for (const k of EXCLUDED) assert.ok(!(k in got), `excluded key leaked: ${k}`);
  for (const k of Object.keys(legacy)) assert.ok(k in got, `legacy key dropped: ${k}`);
  for (const k of Object.keys(got)) {
    assert.ok(INDEX_FIELDS.includes(k), `non-INDEX key: ${k}`);
    if (!(k in legacy)) assert.ok(allowlist.includes(k), `unexpected new key: ${k}`);
    else if (!allowlist.includes(k)) assert.deepStrictEqual(got[k], legacy[k], `legacy value changed: ${k}`);
  }
  for (const k of allowlist) assert.deepStrictEqual(got[k], entry[k], `allowlist fix not applied: ${k}`);
}

test('T1 Anthropic SSE index parity: all legacy keys/values preserved', () => {
  const entry = {
    id:'A1', ts:'t', sessionId:'s', provider:'anthropic', agent:'claude', model:'claude-sonnet-4-20250514',
    msgCount:5, toolCount:2, toolCalls:{Bash:1,Read:1}, isSubagent:false, sessionInferred:false, cwd:'/p',
    isSSE:true, usage:{input_tokens:100,output_tokens:50}, cost:{cost:0.01}, maxContext:200000,
    stopReason:'end_turn', title:'Test turn', thinkingDuration:1.2, toolFail:false,
    elapsed:'2.5', status:200, receivedAt:1000,
    sysHash:'sh1', toolsHash:'th1', coreHash:'ch1',
    thinkingStripped:true, hasCredential:true, toolSources:{mcp:1},
    // excluded:
    req:{}, res:[], tokens:{total:150}, duplicateToolCalls:null, method:'POST', url:'/v1/messages',
  };
  const legacy = {
    id:'A1', ts:'t', sessionId:'s', provider:'anthropic', agent:'claude', model:'claude-sonnet-4-20250514',
    msgCount:5, toolCount:2, toolCalls:{Bash:1,Read:1}, isSubagent:false, sessionInferred:false,
    cwd:'/p', isSSE:true, usage:{input_tokens:100,output_tokens:50}, cost:{cost:0.01}, maxContext:200000,
    stopReason:'end_turn', title:'Test turn', thinkingDuration:1.2, toolFail:false,
    elapsed:'2.5', status:200, receivedAt:1000,
    sysHash:'sh1', toolsHash:'th1', coreHash:'ch1',
    thinkingStripped:true, hasCredential:true, toolSources:{mcp:1},
  };
  assertParity(entry, legacy, []);
});

test('T1 OpenAI SSE index parity: legacy keys preserved, cost/maxContext fixed', () => {
  const entry = {
    id:'O1', ts:'t', sessionId:'s', provider:'openai', agent:'codex', model:'gpt-5.5',
    msgCount:1, toolCount:0, toolCalls:{}, isSubagent:false, sessionInferred:false, cwd:'/p',
    isSSE:true, usage:{input_tokens:10}, cost:{cost:0.09}, maxContext:400000,
    responseMetadata:{transport:'http',streaming:true}, stopReason:'completed', title:'t',
    thinkingDuration:null, toolFail:false, elapsed:'1.0', status:200, receivedAt:1,
    sysHash:null, toolsHash:null, coreHash:null, hasCredential:true,
    // excluded:
    req:{}, res:[], tokens:{total:9}, method:'POST', url:'/v1/responses',
  };
  const legacy = {
    id:'O1', ts:'t', sessionId:'s', provider:'openai', agent:'codex', model:'gpt-5.5',
    msgCount:1, toolCount:0, toolCalls:{}, isSubagent:false, sessionInferred:false, cwd:'/p',
    isSSE:true, usage:{input_tokens:10}, cost:null, maxContext:null,
    responseMetadata:{transport:'http',streaming:true}, stopReason:'completed', title:'t',
    thinkingDuration:null, toolFail:false, elapsed:'1.0', status:200, receivedAt:1,
    sysHash:null, toolsHash:null, coreHash:null, hasCredential:true,
  };
  assertParity(entry, legacy, ['cost','maxContext']);
});

test('T1 non-SSE index parity: legacy keys preserved', () => {
  const entry = {
    id:'N1', ts:'t', sessionId:'s', provider:'anthropic', agent:'claude', model:'claude-sonnet-4-20250514',
    msgCount:2, toolCount:1, toolCalls:{Bash:1}, isSubagent:false, sessionInferred:false, cwd:'/p',
    isSSE:false, usage:{input_tokens:50,output_tokens:20}, cost:null, maxContext:200000,
    responseMetadata:undefined, stopReason:'end_turn', title:'Non-SSE',
    thinkingDuration:null, toolFail:false, elapsed:'0.5', status:200, receivedAt:2,
    sysHash:null, toolsHash:null, coreHash:null,
    thinkingStripped:true, hasCredential:undefined, toolSources:undefined,
    // excluded:
    req:{}, res:{}, tokens:{total:70}, method:'POST', url:'/v1/messages',
  };
  const legacy = {
    id:'N1', ts:'t', sessionId:'s', provider:'anthropic', agent:'claude', model:'claude-sonnet-4-20250514',
    msgCount:2, toolCount:1, toolCalls:{Bash:1}, isSubagent:false, sessionInferred:false, cwd:'/p',
    isSSE:false, usage:{input_tokens:50,output_tokens:20}, cost:null, maxContext:200000,
    stopReason:'end_turn', title:'Non-SSE',
    thinkingDuration:null, toolFail:false, elapsed:'0.5', status:200, receivedAt:2,
    sysHash:null, toolsHash:null, coreHash:null,
    thinkingStripped:true,
  };
  assertParity(entry, legacy, []);
});

test('T1 OpenAI non-SSE index parity: cost/maxContext fixed, responseMetadata preserved', () => {
  const entry = {
    id:'ON1', ts:'t', sessionId:'s', provider:'openai', agent:'codex', model:'gpt-5.5',
    msgCount:1, toolCount:0, toolCalls:{}, isSubagent:false, sessionInferred:false, cwd:'/p',
    isSSE:false, usage:{input_tokens:20,output_tokens:5}, cost:{cost:0.07}, maxContext:400000,
    responseMetadata:{transport:'http',provider:'openai',id:'resp_02',object:'response',model:'gpt-5.5',status:200,responseStatus:'completed'},
    stopReason:'completed', title:'Non-SSE OpenAI',
    thinkingDuration:null, toolFail:false, elapsed:'0.3', status:200, receivedAt:3,
    sysHash:null, toolsHash:null, coreHash:null,
    hasCredential:undefined, toolSources:undefined,
    // excluded:
    req:{}, res:{}, tokens:{total:25}, method:'POST', url:'/v1/responses',
  };
  const legacy = {
    id:'ON1', ts:'t', sessionId:'s', provider:'openai', agent:'codex', model:'gpt-5.5',
    msgCount:1, toolCount:0, toolCalls:{}, isSubagent:false, sessionInferred:false, cwd:'/p',
    isSSE:false, usage:{input_tokens:20,output_tokens:5}, cost:null, maxContext:null,
    responseMetadata:{transport:'http',provider:'openai',id:'resp_02',object:'response',model:'gpt-5.5',status:200,responseStatus:'completed'},
    stopReason:'completed', title:'Non-SSE OpenAI',
    thinkingDuration:null, toolFail:false, elapsed:'0.3', status:200, receivedAt:3,
    sysHash:null, toolsHash:null, coreHash:null,
  };
  assertParity(entry, legacy, ['cost','maxContext']);
});

test('T1 WS index parity: legacy keys preserved', () => {
  const entry = {
    id:'W1', ts:'t', sessionId:'s', provider:'openai', agent:'codex', model:'gpt-5.5',
    msgCount:3, toolCount:1, toolCalls:{shell:1}, isSubagent:false, sessionInferred:false, cwd:'/w',
    isSSE:false, usage:{input_tokens:20,output_tokens:10}, cost:{cost:0.05}, maxContext:400000,
    responseMetadata:{transport:'websocket',capture:'transport-only'}, stopReason:'completed',
    title:'Codex WebSocket session', thinkingDuration:null, toolFail:false,
    elapsed:'5.0', status:200, receivedAt:3,
    sysHash:null, toolsHash:null, coreHash:null,
    thinkingStripped:undefined, hasCredential:true, toolSources:{shell:1},
    // excluded:
    req:{}, res:[], tokens:{total:30}, method:'GET', url:'/v1/responses',
  };
  const legacy = {
    id:'W1', ts:'t', sessionId:'s', provider:'openai', agent:'codex', model:'gpt-5.5',
    msgCount:3, toolCount:1, toolCalls:{shell:1}, isSubagent:false, sessionInferred:false, cwd:'/w',
    isSSE:false, usage:{input_tokens:20,output_tokens:10}, cost:{cost:0.05}, maxContext:400000,
    responseMetadata:{transport:'websocket',capture:'transport-only'}, stopReason:'completed',
    title:'Codex WebSocket session', thinkingDuration:null, toolFail:false,
    elapsed:'5.0', status:200, receivedAt:3,
    sysHash:null, toolsHash:null, coreHash:null,
    hasCredential:true, toolSources:{shell:1},
  };
  assertParity(entry, legacy, []);
});
