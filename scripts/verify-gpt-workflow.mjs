/** Existing tool dispatcher + wire schemas, mocked gateway, isolated home, no API. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'gmm-gpt-workflow-'));
process.env.DSH_HOME = home;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Network is forbidden in workflow tool verification'); };
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`✓ ${name}`); };
try {
  const { registerStudioTools, moduleOfMethod } = await import('../lib/tools.js');
  const { METHODS, TOOL_METHODS, WORKFLOW_TOOL_METHODS } = await import('../lib/wire.js');
  const config = await import('../lib/config.js');
  await config.saveConfig({ hiddenModules: [] });
  const allowed = [
    'getWorkflowConversation', 'reuseWorkflowRound', 'submitWorkflowRound', 'runWorkflowRoundStep',
    'getMotionVideoTimeline', 'getMotionTemplatePreview', 'previewMotionReference', 'previewMotionPrompt'
  ];
  const exposed = new Set(TOOL_METHODS.map(entry => entry.method));
  check('only the explicit workflow bridge is newly public', () => {
    assert.deepEqual([...WORKFLOW_TOOL_METHODS].sort(), [...allowed].sort());
    for (const method of allowed) assert(exposed.has(method), method);
    for (const method of ['revealConfigKey', 'motionSettings', 'optimizeMotionPrompt', 'deleteWorkflowVersion', 'transferAsset']) assert(!exposed.has(method), method);
    for (const spec of METHODS.filter(entry => entry.clientOnly)) assert(!exposed.has(spec.method), spec.method);
  });
  const calls = [], definitions = [], sections = [], requests = new Map();
  let mutationCount = 0;
  const gateway = new Proxy({}, { get: (_target, method) => async payload => {
    calls.push({ method, payload: structuredClone(payload) });
    if (method === 'submitWorkflowRound') {
      if (!payload.localOnly && payload.confirmed !== true) throw new Error('mock: current confirmation required');
      if (!requests.has(payload.requestId)) requests.set(payload.requestId, { roundId: 'round-1', childId: 'wchild0000' });
      return requests.get(payload.requestId);
    }
    if (method === 'runWorkflowRoundStep') {
      if (payload.planOnly) return { kind: 'local-processing', steps: ['keyed'], requestCount: 0 };
      if (payload.step === 'redraw' && payload.confirmed !== true) throw new Error('mock: redraw confirmation required');
      mutationCount++; return { ok: true };
    }
    if (method === 'getMotionJob') return { id: payload.jobId, workflowParent: 'wparent000' };
    if (method === 'getWorkflowConversation') return { module: payload.module, jobId: payload.jobId, rounds: [{ id: 'round-1', childId: 'wchild0000' }] };
    return { ok: true };
  } });
  const disposers = registerStudioTools({
    tools: { register: definition => { definitions.push(definition); return () => {}; } },
    systemPrompt: { section: section => { sections.push(section); return () => {}; } }
  }, gateway);
  assert.equal(definitions.length, 1); assert.equal(definitions[0].name, 'game_material');
  const tool = definitions[0];
  check('approved character and eight-direction slots are representable in the one tool schema', () => {
    assert(tool.parameters.properties.kind.enum.includes('character'));
    assert(tool.parameters.properties.kind.enum.includes('directions'));
  });
  const call = (method, payload) => tool.execute({ action: 'call', method, payload });
  check('the single always-on tool stays within its context budget', () => {
    const bytes = Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })) + Buffer.byteLength(sections[0]?.text || '');
    assert(bytes <= 6000, String(bytes));
  });
  for (const method of ['revealConfigKey', 'motionSettings', 'optimizeMotionPrompt', 'deleteWorkflowVersion']) {
    const before = calls.length;
    await assert.rejects(call(method, { key: 'minimaxApiKey' }), /未知方法/);
    assert.equal(calls.length, before); checks++;
  }
  for (const [method, payload] of [
    ['submitWorkflowRound', { module: 'sprite', jobId: 'wparent000', automatic: false }],
    ['submitWorkflowRound', { module: 'sprite', jobId: 'wparent000', requestId: '', automatic: false }],
    ['submitWorkflowRound', { module: 'sprite', jobId: 'wparent000', requestId: 'intent-1', automatic: false, confirmed: 'true' }],
    ['getWorkflowConversation', { module: 'rig', jobId: 'wparent000' }],
    ['getMotionVideoTimeline', { jobId: 'wparent000', page: -1 }],
    ['getMotionTemplatePreview', { action: 'Run1', direction: 'invented' }],
    ['previewMotionReference', { jobId: 'wparent000', segments: [], keyColor: '#FF00FF' }]
  ]) {
    const before = calls.length; await assert.rejects(call(method, payload)); assert.equal(calls.length, before); checks++;
  }
  await assert.rejects(call('submitWorkflowRound', { module: 'sprite', jobId: 'wparent000', requestId: 'intent-1', automatic: false, confirmed: false }), /confirmation required/);
  check('the bridge never invents paid confirmation', () => assert.equal(calls.at(-1).payload.confirmed, false));
  const submitted = { module: 'sprite', jobId: 'wparent000', requestId: 'intent-stable', automatic: false, confirmed: true, expectedVideoModel: 'MiniMax-H3-Lite' };
  const first = await call('submitWorkflowRound', submitted), second = await call('submitWorkflowRound', submitted);
  check('request ID, confirmation and selected model reach the same existing gateway unchanged', () => {
    assert.deepEqual(first.value, second.value); assert.equal(requests.size, 1);
    assert.deepEqual(calls.at(-1).payload, submitted);
    assert.equal(new URL(first.openUrl).searchParams.get('job'), 'wparent000');
    assert.equal(new URL(first.openUrl).searchParams.get('module'), 'sprite');
  });
  const imported = await call('submitWorkflowRound', { module: 'sprite', jobId: 'wparent000', requestId: 'local-intent', automatic: false, localOnly: true });
  check('local-only import remains local and parent-linked', () => {
    assert.equal(calls.at(-1).payload.localOnly, true); assert.equal(calls.at(-1).payload.confirmed, undefined);
    assert.equal(new URL(imported.openUrl).searchParams.get('job'), 'wparent000');
  });
  const planPayload = { module: 'sprite', jobId: 'wparent000', roundId: 'round-1', step: 'process', planOnly: true,
    ranges: [{ action: 'Run1', start: .1, end: 1.9, frameCount: 43, targetFps: 24 }], forceLocal: 'keyed' };
  const planned = await call('runWorkflowRoundStep', planPayload);
  check('a read-only processing plan retains range/FPS/force fields and runs no mutation', () => {
    assert.deepEqual(calls.at(-1).payload, planPayload); assert.equal(planned.value.requestCount, 0); assert.equal(mutationCount, 0);
  });
  const redraw = { module: 'sprite', jobId: 'wparent000', roundId: 'round-1', step: 'redraw', targets: ['a', 'b'], scheme: 'sheet8', planOnly: true, regenerate: false, confirmed: false };
  await call('runWorkflowRoundStep', redraw);
  check('HD planning retains scheme, targets and explicit retry/confirmation flags', () => {
    assert.deepEqual(calls.at(-1).payload, redraw); assert.equal(mutationCount, 0);
  });
  await assert.rejects(call('runWorkflowRoundStep', { ...redraw, planOnly: false }), /redraw confirmation required/); checks++;
  const child = await call('getMotionJob', { jobId: 'wchild0000' });
  check('a child inspection links to the visible parent, not its hidden round job', () => assert.equal(new URL(child.openUrl).searchParams.get('job'), 'wparent000'));
  await call('getMotionTemplatePreview', { action: 'Run1', direction: 'right', secret: 'must-be-stripped' });
  check('preview payload uses the real wire schema and drops undeclared fields', () => assert.deepEqual(calls.at(-1).payload, { action: 'Run1', direction: 'right' }));
  await call('previewMotionPrompt', { jobId: 'wparent000', prompt: 'Use existing reference.' }); checks++;
  const guide = await tool.execute({ action: 'guide', topic: 'motion' });
  check('motion guide explains visible rounds, fingerprint reuse and unknown-result handling', () => {
    for (const word of ['getWorkflowConversation', 'prepared.signature', 'requestId', 'unknown', 'planOnly']) assert(guide.text.includes(word), word);
  });
  for (const hidden of [['sequence'], ['sprite'], ['sprite', 'sequence']]) {
    await config.saveConfig({ hiddenModules: hidden });
    for (const module of hidden) {
      const jobId = module === 'sprite' ? 'wparent000' : 'sparent';
      const beforeSpoof = calls.length;
      await assert.rejects(tool.execute({ action: 'call', module: module === 'sprite' ? 'sequence' : 'sprite',
        method: 'getWorkflowConversation', payload: { module, jobId } }), /隐藏/);
      assert.equal(calls.length, beforeSpoof); checks++;
      for (const method of ['getWorkflowConversation', 'reuseWorkflowRound', 'submitWorkflowRound', 'runWorkflowRoundStep']) {
        const before = calls.length;
        await assert.rejects(call(method, { module, jobId, roundId: 'round-1', requestId: 'hidden-intent', automatic: false, localOnly: true, step: 'process', planOnly: true }), /隐藏/);
        assert.equal(calls.length, before); checks++;
      }
    }
    if (hidden.includes('sprite')) {
      await assert.rejects(tool.execute({ action: 'guide', topic: 'motion' }), /隐藏/);
      for (const [method, payload] of [
        ['getMotionVideoTimeline', { jobId: 'wparent000' }], ['getMotionTemplatePreview', { action: 'Run1', direction: 'right' }],
        ['previewMotionPrompt', { jobId: 'wparent000', prompt: 'test' }],
        ['previewMotionReference', { jobId: 'wparent000', keyColor: '#FF00FF', segments: [{ action: 'WalkFoward', start: 0, end: 2, frameCount: 48 }, { action: 'Run1', start: 2, end: 4, frameCount: 48 }] }]
      ]) { const before = calls.length; await assert.rejects(call(method, payload), /隐藏/); assert.equal(calls.length, before); checks++; }
    }
    if (hidden.length === 2) {
      const directory = await tool.execute({ action: 'guide', topic: 'methods' });
      for (const method of allowed) assert(!directory.text.includes(method), method);
      checks++;
    } else {
      const module = hidden[0] === 'sprite' ? 'sequence' : 'sprite', jobId = module === 'sprite' ? 'wparent000' : 'sparent';
      const result = await call('getWorkflowConversation', { module, jobId });
      assert.equal(new URL(result.openUrl).searchParams.get('module'), module);
      const directory = await tool.execute({ action: 'guide', topic: 'methods', module });
      assert(directory.text.includes('runWorkflowRoundStep')); checks++;
    }
  }
  await config.saveConfig({ hiddenModules: [] });
  for (const payload of [{ module: 'sprite', jobId: 'sparent' }, { module: 'sequence', jobId: 'wparent000' }]) {
    const before = calls.length; await assert.rejects(call('getWorkflowConversation', payload), /module.*jobId/); assert.equal(calls.length, before); checks++;
  }
  check('dynamic method ownership remains separate for both modules', () => {
    assert.equal(moduleOfMethod('getWorkflowConversation', { module: 'sprite', jobId: 'wparent000' }), 'sprite');
    assert.equal(moduleOfMethod('getWorkflowConversation', { module: 'sequence', jobId: 'sparent' }), 'sequence');
  });
  for (const dispose of disposers.reverse()) dispose();
  console.log(`\nGPT workflow bridge: ${checks} checks passed; mock gateway only, no generation or external requests.`);
} finally {
  globalThis.fetch = originalFetch;
  const safe = resolve(home);
  assert.equal(dirname(safe), resolve(tmpdir()));
  assert(safe.split(/[\\/]/).at(-1).startsWith('gmm-gpt-workflow-'));
  await rm(safe, { recursive: true, force: true });
}
