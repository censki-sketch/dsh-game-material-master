/** Real motion gateway/wire and DSH attachment protocol, synthetic LLM only. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
const home = await mkdtemp(join(tmpdir(), 'gmm-motion-optimizer-'));
process.env.DSH_HOME = home;
globalThis.fetch = async () => { throw Error('No network allowed'); };
const { Context } = await import('@deepseek-ai/cordis');
const plugin = await import('../lib/index.js'), wire = await import('../lib/wire.js');
const motion = await import('../lib/motiongen.js');
const { dataRoot } = await import('../lib/config.js');
const { encodePng } = await import('../lib/png.js');
const ctx = new Context();
for (const name of ['typert', 'webServer', 'tools']) ctx.provide(name, { register: () => () => {} });
ctx.provide('systemPrompt', { section: () => () => {} });
plugin.apply(ctx);
const gateway = ctx.get('gameStudio'), calls = [], admissions = [];
let checks = 0, mode = 'success', release, selection = { provider: 'dsh', model: 'vision-default', reasoningEffort: 'high' };
const check = (name, value) => { assert.ok(value, name); console.log('✓ ' + name); checks++; };
const invoke = async (method, payload) => {
  const spec = wire.METHODS.find(item => item.method === method), parsed = spec.payload.parse(payload);
  assert.deepEqual(parsed, payload, method + ' lost wire fields');
  return spec.result.parse(await gateway[method](parsed));
};
ctx.provide('agentDefaultModel', { currentSelection: () => structuredClone(selection) });
const llm = {
  listProviders: () => [{ id: 'dsh', name: 'DSH' }, { id: 'other', name: 'Other' }],
  listModels: async provider => [{ id: provider === 'dsh' ? 'vision-default' : 'vision-choice', name: 'Synthetic vision', inputModalities: ['text', 'image'] }],
  prepareCall: async config => ({ config, inputModalities: ['text', 'image'], stream: options => llm.stream(options) }),
  async *stream(options) {
    calls.push(options);
    const rows = await Promise.all((await readdir(join(dataRoot(), 'prompt-optimization-attempts'))).map(async name => JSON.parse(await readFile(join(dataRoot(), 'prompt-optimization-attempts', name), 'utf8'))));
    assert.ok(rows.some(row => row.status === 'running' && row.model === options.model), 'attempt missing before dispatch');
    if (mode === 'hold') await new Promise(resolve => release = resolve);
    if (mode === 'throw') throw Error('synthetic-secret');
    const request = JSON.parse(options.messages[0].content[0].text);
    const reply = { prompt: mode === 'clarify' ? '' : request.references.map(ref => ref.label).join('、') + '，动作衔接自然，固定相机。',
      summary: { goal: '自然衔接', changes: ['动作衔接'], preserve: ['固定相机'], references: request.references.map(ref => ({ label: ref.label, usage: ref.name })), clarifications: mode === 'clarify' ? ['是否保留已选动作？'] : [] } };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(reply) } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
};
ctx.provide('llm', llm);
ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024 * 1024, maxMessageImageBytes: 2 * 1024 * 1024 },
  admitPromptContent: async parts => { admissions.push(parts); return parts.map(part => part.type === 'text' ? part : { type: 'image', attachment: { attachmentId: part.name, mediaType: part.mediaType } }); } });
try {
  const { jobId } = await invoke('createMotionJob', { name: 'motion optimization' });
  const original = await motion.readMotion(jobId), segments = [{ action: 'walkfoward', start: 0, end: 2, frameCount: 8 }, { action: 'runforward', start: 2, end: 4, frameCount: 8 }];
  const draft = { jobId, prompt: '动作衔接自然', composerVersion: 1, description: '蓝色披风', segments,
    processing: { ...original.processing, keyColor: '#00FF00' }, promptTemplate: { id: 'test-video', lang: 'zh', content: '模板标记 / {{timeline}} / {{description}} / {{keyColor}}' } };
  const diskPath = join(dataRoot(), 'motion-jobs', jobId, 'job.json');
  const before = await readFile(diskPath, 'utf8');
  const preview = await invoke('previewMotionPrompt', draft);
  const expected = await motion.composeMotionPrompt({ ...original, ...draft });
  check('preview matches actual assembly using unsaved actions, appearance, template and background', preview.prompt === expected && preview.prompt.includes('蓝色披风') && preview.prompt.includes('#00FF00') && !preview.prompt.includes('{{'));
  check('preview leaves the task and media untouched without dispatching', await readFile(diskPath, 'utf8') === before && calls.length === 0 && !(await motion.readMotion(jobId)).prepared);
  const emptyPreview = await invoke('previewMotionPrompt', { ...draft, prompt: '' });
  check('an empty supplement still previews the chosen template', emptyPreview.prompt.startsWith('模板标记') && calls.length === 0);
  const input = { ...draft, confirmed: true, referenceFiles: [] };
  await assert.rejects(invoke('optimizeMotionPrompt', { ...input, confirmed: false }), /确认/);
  await assert.rejects(invoke('optimizeMotionPrompt', { ...input, jobId: 'wnotfound' }), /not found/);
  await assert.rejects(invoke('optimizeMotionPrompt', { ...input, prompt: '' }));
  await assert.rejects(invoke('optimizeMotionPrompt', { ...input, prompt: 'x'.repeat(12001) }));
  await assert.rejects(invoke('optimizeMotionPrompt', { ...input, referenceFiles: ['../foreign.png'] }), /不一致/);
  await assert.rejects(invoke('optimizeMotionPrompt', { ...input, prompt: '参考@图片1' }), /不存在/);
  check('invalid confirmation, task, bounds and references never call the model', calls.length === 0);
  const result = await invoke('optimizeMotionPrompt', input), options = calls.at(-1), sent = JSON.parse(options.messages[0].content[0].text);
  check('explicit optimization uses the DSH default and no generation tools', calls.length === 1 && result.model === selection.model && options.reasoningEffort === 'high' && options.tools.length === 0 && options.signal instanceof AbortSignal);
  check('only the supplement is editable; actual workflow constraints reach the model', sent.prompt === draft.prompt && sent.suffix === emptyPreview.prompt && sent.context.duration === 4 && sent.context.keyColor === '#00FF00' && sent.context.description === draft.description && JSON.stringify(sent.context.segments) === JSON.stringify(segments));
  check('system protects actions, timeline and layout and does not pretend to see a video', options.system.includes('只优化本轮补充要求') && options.system.includes('不推断空动作') && options.system.includes('不能假称已观看') && options.system.includes('冲突时返回澄清问题'));
  check('optimizer does not save text, actions or prepared media', await readFile(diskPath, 'utf8') === before);
  const pngs = [[20, 90, 220, 255], [220, 90, 20, 255]].map(pixel => encodePng(Buffer.from(pixel), 1, 1).toString('base64'));
  for (const [index, kind] of ['character', 'directions'].entries()) await invoke('uploadMotionAsset', { jobId, kind, data: pngs[index] });
  const uploaded = await motion.readMotion(jobId), referenceFiles = [uploaded.character, uploaded.directions];
  const imageInput = { ...input, prompt: '参考@图片1和@图片2，动作自然', referenceFiles };
  const uploadBefore = await readFile(diskPath, 'utf8'), callCount = calls.length;
  for (const refs of [[], referenceFiles.toReversed(), [referenceFiles[0], referenceFiles[0]], ['refs/foreign.png', referenceFiles[1]]]) await assert.rejects(invoke('optimizeMotionPrompt', { ...imageInput, referenceFiles: refs }), /不一致/);
  check('both actual role images are required in the displayed order', calls.length === callCount);
  const visual = await invoke('optimizeMotionPrompt', imageInput), admitted = admissions.at(-1), visualSent = JSON.parse(calls.at(-1).messages[0].content[0].text);
  check('real motion-owned PNG bytes reach the DSH attachment service in role order', admitted[1].data === pngs[0] && admitted[3].data === pngs[1] && admitted[0].text === '@图片1' && admitted[2].text === '@图片2');
  check('optimizer describes the same reference roles as the composer', visualSent.references[0].name === '角色细节参考图' && visualSent.references[1].name === '八方向外观图（四列两行）' && visual.prompt.includes('@图片1') && visual.prompt.includes('@图片2'));
  const choice = await invoke('optimizeMotionPrompt', { ...imageInput, modelSelection: { provider: 'other', model: 'vision-choice' } });
  check('an explicit model is used without changing the DSH default', choice.provider === 'other' && choice.model === 'vision-choice' && selection.model === 'vision-default');
  mode = 'clarify';
  const clarification = await invoke('optimizeMotionPrompt', imageInput);
  check('a conflict can return a question without an adoptable prompt', !clarification.prompt && clarification.summary.clarifications.length === 1);
  mode = 'hold';
  const inflight = invoke('optimizeMotionPrompt', imageInput);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const inFlightCount = calls.length;
  await assert.rejects(invoke('optimizeMotionPrompt', imageInput), /正在优化/);
  check('duplicate optimization cannot dispatch twice', calls.length === inFlightCount);
  release(); await inflight;
  mode = 'throw'; const failureCount = calls.length;
  await assert.rejects(invoke('optimizeMotionPrompt', imageInput), error => /未自动重试/.test(error.message) && !error.message.includes('synthetic-secret'));
  check('failed optimization is not retried and leaves the task unchanged', calls.length === failureCount + 1 && await readFile(diskPath, 'utf8') === uploadBefore);
  const attempt = JSON.parse(await readFile(join(dataRoot(), 'prompt-optimization-attempts', visual.attemptId + '.json'), 'utf8'));
  check('successful attempt is recorded without prompt content or credentials', attempt.status === 'ready' && !('prompt' in attempt) && !('apiKey' in attempt));
  await invoke('saveMotionJob', { ...draft, prompt: visual.prompt });
  const saved = await motion.readMotion(jobId), final = await motion.composeMotionPrompt(saved);
  check('saving an adopted supplement appends exactly one template', final.split('模板标记').length === 2 && final.endsWith(visual.prompt));
  check('adoption preserves chosen actions, processing and reference assets', JSON.stringify(saved.segments) === JSON.stringify(segments) && saved.processing.keyColor === '#00FF00' && saved.character === referenceFiles[0] && saved.directions === referenceFiles[1] && !saved.video);
  check('preview and optimization remain absent from the agent tool surface', !wire.TOOL_METHODS.some(item => ['previewMotionPrompt', 'optimizeMotionPrompt'].includes(item.method)));
  console.log(`Passed ${checks} motion optimizer checks. No network or real model calls.`);
} finally {
  const target = resolve(home);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('gmm-motion-optimizer-'));
  await rm(target, { recursive: true, force: true });
}
