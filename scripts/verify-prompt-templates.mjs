/** Typed prompt catalog migration and real gateway round trips. No network or model calls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { IMAGE_PROMPT_TEMPLATES } from '../lib/imageprompts.js';
import { MOTION_PROMPT_TEMPLATES } from '../lib/motionprompts.js';
import { validatePromptTemplates, mergePromptTemplates } from '../lib/prompttemplates.js';
const home = await mkdtemp(join(tmpdir(), 'gmm-prompt-types-'));
let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log('✓ ' + name); checks++; };
const custom = (id, text) => ({ id, name: { zh: text, en: text }, prompt: { zh: text, en: text } });
try {
  const legacyImages = [...structuredClone(IMAGE_PROMPT_TEMPLATES), custom('shared-custom', 'image custom')];
  const legacyVideos = [...structuredClone(MOTION_PROMPT_TEMPLATES), custom('shared-custom', 'video custom')];
  legacyVideos[0].prompt.zh = 'Edited video {{description}} {{timeline}} {{keyColor}}';
  const merged = mergePromptTemplates(legacyImages, legacyVideos);
  check('legacy ID collisions retain both authored templates with distinct IDs', new Set(merged.map(t => t.id)).size === 6 && merged.filter(t => t.name.zh.endsWith('custom')).length === 2);
  check('all merged entries have a valid type', validatePromptTemplates(merged).length === 6);
  for (const builtin of merged.filter(t => !t.id.includes('custom'))) {
    assert.throws(() => validatePromptTemplates(merged.map(t => t.id === builtin.id ? { ...t, type: t.type === 'image' ? 'video' : 'image' } : t)), /内置/);
    checks++;
  }
  assert.throws(() => validatePromptTemplates(merged.map(t => t.id === 'motion-video' ? { ...t, prompt: { zh: '{{unknown}}', en: '{{unknown}}' } } : t)), /模板仅支持/); checks++;
  const dir = join(home, 'game-material-master'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ imagePromptTemplates: legacyImages }));
  await writeFile(join(dir, 'motion-settings.json'), JSON.stringify({ templates: legacyVideos, model: 'offline-only', apiKey: 'dummy-key' }));
  const run = source => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr.slice(0, 2000));
    return JSON.parse(result.stdout.trim());
  };
  const boot = `
    globalThis.fetch = async () => { throw Error('No network allowed'); };
    const { Context } = await import('@deepseek-ai/cordis');
    const plugin = await import('./lib/index.js'), wire = await import('./lib/wire.js');
    const ctx = new Context(); ctx.provide('typert', { register: () => () => {} }); ctx.provide('webServer', { register: () => () => {} });
    plugin.apply(ctx); const api = ctx.get('gameStudio');
    const invoke = (name, payload) => { const spec = wire.METHODS.find(m => m.method === name); const parsed = spec.payload?.parse(payload); return api[name](parsed); };
  `;
  const result = run(boot + `
    const first = await invoke('getConfig');
    const video = await invoke('motionSettings', {});
    const customImage = first.promptTemplates.find(t => t.name.zh === 'image custom');
    const changed = first.promptTemplates.map(t => t.id === customImage.id ? { ...t, type: 'video' } : t);
    const saved = await invoke('saveConfig', { promptTemplates: changed });
    const imageJob = await invoke('createImageJob', { name: 'filter test' });
    const view = await invoke('getImageJob', { jobId: imageJob.jobId });
    let blocked = false;
    try { await invoke('createImageJob', { promptTemplate: customImage.id }); } catch { blocked = true; }
    await invoke('saveConfig', { imagePromptTemplates: saved.imagePromptTemplates });
    const afterLegacyImage = await invoke('getConfig');
    await invoke('motionSettings', { save: true, templates: video.templates });
    const afterLegacyVideo = await invoke('getConfig');
    const deleted = afterLegacyVideo.promptTemplates.filter(t => t.name.zh !== 'video custom');
    const final = await invoke('saveConfig', { promptTemplates: deleted });
    const compact = ({ promptTemplates, imagePromptTemplates, promptTemplateDefaults }) => ({ promptTemplates, imagePromptTemplates, promptTemplateDefaults });
    process.stdout.write(JSON.stringify({ first: compact(first), video, saved: compact(saved), view, blocked, afterLegacyImage: compact(afterLegacyImage), afterLegacyVideo: compact(afterLegacyVideo), final: compact(final) }), () => process.exit(0));
  `);
  check('first boot migrates old image and motion catalogs into one typed catalog', result.first.promptTemplates.length === 6 && result.first.promptTemplateDefaults.length === 4);
  check('migration retains edited built-in video text and masks credentials', result.video.templates[0].prompt.zh === legacyVideos[0].prompt.zh && result.video.apiKey === undefined);
  check('editing a custom type persists through saveConfig and updates both views', result.saved.promptTemplates.filter(t => t.type === 'video').length === 3 && result.saved.imagePromptTemplates.length === 3);
  check('image creation and selection exclude video templates', result.blocked && result.view.promptTemplates.length === 3 && result.view.promptTemplates.every(t => !t.id.includes('custom')));
  check('legacy image saves retain the video slice', result.afterLegacyImage.promptTemplates.filter(t => t.type === 'video').length === 3);
  check('legacy video saves retain the image slice', result.afterLegacyVideo.imagePromptTemplates.length === 3 && result.afterLegacyVideo.promptTemplates.filter(t => t.type === 'video').length === 2);
  const disk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  check('canonical types are written to disk', JSON.stringify(disk.promptTemplates) === JSON.stringify(result.final.promptTemplates));
  const restart = run(boot + `const cfg = await invoke('getConfig'); process.stdout.write(JSON.stringify({ promptTemplates: cfg.promptTemplates }), () => process.exit(0));`);
  check('restart preserves types and does not resurrect deleted legacy video templates', JSON.stringify(restart.promptTemplates) === JSON.stringify(result.final.promptTemplates) && !restart.promptTemplates.some(t => t.name.zh === 'video custom'));
  check('model settings no longer store a second prompt catalog', !('templates' in JSON.parse(await readFile(join(dir, 'motion-settings.json'), 'utf8'))));
  console.log(`Passed ${checks} prompt template checks. Temporary home only; no network.`);
} finally { await rm(home, { recursive: true, force: true }); }
