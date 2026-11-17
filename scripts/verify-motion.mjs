/** White-model workflow: real gateway, local ffmpeg, loopback-only mock APIs. No paid calls. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const home = await mkdtemp(join(tmpdir(), 'dsh-motion-'));
process.env.DSH_HOME = home;
const config = await import('../lib/config.js');
const motion = await import('../lib/motiongen.js');
const { encodePng } = await import('../lib/png.js');
const media = await import('../lib/media.js');
const wire = await import('../lib/wire.js');
const { moduleForId } = await import('../lib/tools.js');
const { Context } = await import('@deepseek-ai/cordis');
const plugin = await import('../lib/index.js');
const ctx = new Context(), captured = { routes: [], tools: [] };
ctx.provide('typert', { register: () => () => {} });
ctx.provide('webServer', { register: route => { captured.routes.push(route); return () => {}; } });
ctx.provide('tools', { register: tool => { captured.tools.push(tool); return () => {}; } });
ctx.provide('systemPrompt', { section: () => () => {} });
plugin.apply(ctx);
const gateway = ctx.get('gameStudio');
let checks = 0, videoPosts = 0, imagePosts = 0, videoQueries = 0;
let videoBytes, postedVideo, postedImage, failVideo = false, failImage = false, blankImage = false;
const png = (width, height, color = [80, 180, 100]) => {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const body = x > width * .35 && x < width * .65 && y > height * .15 && y < height * .9;
    rgba[p] = body ? color[0] : 255; rgba[p+1] = body ? color[1] : 0; rgba[p+2] = body ? color[2] : 255; rgba[p+3] = 255;
  }
  return encodePng(rgba, width, height);
};
const fixture = png(1024, 1024);
const server = createServer(async (req, res) => {
  const parts = []; for await (const c of req) parts.push(c);
  const raw = Buffer.concat(parts);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/v2/video_generation') {
    videoPosts++; postedVideo = JSON.parse(raw);
    if (failVideo) { res.writeHead(502); res.end('{"error":"dummy-video-key interrupted"}'); return; }
    res.end(JSON.stringify({ task_id: 'test-motion-task' }));
  } else if (req.url?.startsWith('/v2/query/video_generation/')) {
    videoQueries++; res.end(JSON.stringify({ status: 'succeeded', content: { url: base + '/movie.mp4' } }));
  } else if (req.url === '/movie.mp4') {
    res.setHeader('Content-Type', 'video/mp4'); res.end(videoBytes);
  } else if (req.url === '/v1/chat/completions') {
    res.end(JSON.stringify({ choices: [{ message: { content: '保持深蓝长袍与白发。' } }] }));
  } else if (req.url === '/v1/images/edits') {
    imagePosts++; postedImage = raw.toString('latin1');
    if (failImage) { res.writeHead(404); res.end('{"error":"dummy-image-key unsupported"}'); return; }
    res.end(JSON.stringify({ data: [{ b64_json: (blankImage ? png(1024,1024,[255,0,255]) : fixture).toString('base64') }] }));
  } else { res.writeHead(404); res.end('{"error":"unexpected endpoint"}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  assert.equal(new URL(String(url)).origin, base, 'test attempted non-mock network request');
  return originalFetch(url, ...args);
};
function check(name, value) { assert.ok(value, name); checks++; console.log(`✓ ${name}`); }
async function gw(method, payload) {
  const spec = wire.METHODS.find(s => s.method === method);
  assert.ok(spec, method);
  const parsed = spec.payload ? spec.payload.parse(payload) : undefined;
  if (payload) assert.deepEqual(parsed, payload, `${method}: schema stripped a field`);
  return parsed === undefined ? gateway[method]() : gateway[method](parsed);
}
async function settled(id) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const view = await motion.motionView(id);
    if (!view.active) return view;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('motion operation timed out');
}
async function step(id, name, extra = {}, errorPattern) {
  await gw('runMotionStep', { jobId: id, step: name, ...extra });
  const view = await settled(id);
  if (errorPattern) assert.match(view.error ?? '', errorPattern);
  else assert.equal(view.error, undefined, `${name}: ${view.error}`);
  return view;
}
function unzip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), size = bytes.readUInt32LE(offset + 18);
    const n = bytes.readUInt16LE(offset+26), e = bytes.readUInt16LE(offset+28);
    const name = bytes.toString('utf8', offset+30, offset+30+n), start = offset+30+n+e;
    const value = bytes.subarray(start, start+size);
    files.set(name, method === 8 ? inflateRawSync(value) : value);
    offset = start+size;
  }
  return files;
}
async function request(url, headers = {}) {
  const req = new Readable({ read() {} }); req.url = url; req.method = 'GET'; req.headers = headers; req.push(null);
  const parts = [], responseHeaders = {}; let status;
  const res = new Writable({ write(c, _enc, cb) { parts.push(Buffer.from(c)); cb(); } });
  res.setHeader = (name, value) => responseHeaders[name.toLowerCase()] = value;
  res.writeHead = (code, extra = {}) => { status = code; Object.entries(extra).forEach(([k,v]) => res.setHeader(k,v)); return res; };
  const ended = once(res, 'finish'); await captured.routes[0].handler(req, res); await ended;
  return { status: status ?? res.statusCode, bytes: Buffer.concat(parts), headers: responseHeaders };
}
try {
  await config.saveConfig({ comfyVideo: false, toapisVideo: false, minimaxBaseUrl: base, minimaxModel: 'MiniMax-H3-Lite', minimaxApiKey: 'dummy-video-key', imageProvider: 'custom', customProtocol: 'openai', customBaseUrl: base + '/v1', customModel: 'mock-image', customApiKey: 'dummy-image-key' });
  const catalog = await motion.motionCatalog();
  check('bundled 40 CC0 action templates', catalog.actions.length === 40 && catalog.license === 'CC0-1.0');
  for (const action of catalog.actions) {
    const raw = gunzipSync(await readFile(new URL(`../assets/motion-templates/${action.key}.rgba.gz`, import.meta.url)));
    assert.equal(raw.length, 126*132*4*8*action.frames);
  }
  check('all template frame payloads have eight directions', true);
  const { jobId: id } = await gw('createMotionJob', { name: 'Local mock workflow' });
  check('motion ID has independent namespace', id.startsWith('w') && moduleForId(id) === 'sprite' && moduleForId('m123456789') === 'map');
  let job = await gw('getMotionJob', { jobId: id });
  check('new task defaults to two 2-second actions', job.segments.length === 2 && job.segments[0].end === 2 && job.segments[1].end === 4);
  await assert.rejects(() => gw('saveMotionJob', { jobId:id, segments:[...job.segments,...job.segments] }), /2或3/);
  const defaults = job.segments.map(s => ({ ...s, frameCount:4 }));
  await assert.rejects(() => gw('saveMotionJob', { jobId:id, segments:[defaults[0],{ ...defaults[1],start:1 }] }), /overlap/);
  const three = [{ ...defaults[0],end:1 },{ ...defaults[1],start:1,end:2 },{ action:'rightjab',start:2,end:4,frameCount:4 }];
  await gw('saveMotionJob', { jobId:id, segments:three });
  check('third action supported within 4 seconds', (await motion.readMotion(id)).segments.length === 3);
  await gw('saveMotionJob', { jobId:id, segments:defaults,description:'白发、深蓝长袍' });
  const privateSettings = await gw('motionSettings', { save:true,baseUrl:base+'/v1',model:'mock-text',apiKey:'dummy-text-key',videoRate:.16,imageRate:.1 });
  check('text credentials masked and settings hidden from agent tools', privateSettings.apiKey === undefined && privateSettings.apiKeySet && !wire.TOOL_METHODS.some(s=>s.method==='motionSettings'));
  for (const [kind, bytes] of [['character',png(512,512)],['directions',png(864,480)]]) await gw('uploadMotionAsset', { jobId:id,kind,data:bytes.toString('base64') });
  const store = await import('../lib/store.js');
  const original = await store.createProject('Source directions');
  original.settings.keyColorOverride=true;original.settings.keyColor='#FF00FF';
  const colors = motion.MOTION_ORDER.map((_,i)=>[50+i*20,40+i*4,140+i*10]);
  for(const [index,direction] of motion.MOTION_ORDER.entries()) {
    const relative=`images/${direction}.png`;
    await writeFile(store.assetPath(original.id,relative),png(512,512,colors[index]));
    original.images[direction]={...original.images[direction],status:'ready',file:relative};
  }
  await store.writeProject(original);
  await gw('uploadMotionAsset',{jobId:id,kind:'project',data:original.id});
  job = await motion.readMotion(id);
  check('existing sprite project imports all eight appearances locally', !!job.character && !!job.directions && (await media.probeSize(motion.motionAssetPath(id,job.directions))).width===864);
  const grid = await media.decodeToRgba(motion.motionAssetPath(id,job.directions));
  for(let d=0;d<8;d++) {
    const offset = ((Math.floor(d/4)*240+120)*864+(d%4*216+108))*4;
    assert.deepEqual([...grid.rgba.subarray(offset,offset+3)],colors[d]);
  }
  check('appearance grid preserves all eight compass positions',true);
  await step(id,'prompt',{ useModel:true });
  check('model enriches appearance while structural constraints retained', (await motion.readMotion(id)).prompt.includes('四列两行') && (await motion.readMotion(id)).prompt.includes('深蓝长袍与白发'));
  await step(id,'prepare');
  job = await motion.readMotion(id);
  videoBytes = await readFile(motion.motionAssetPath(id,job.prepared.video));
  check('local reference is exactly 4 seconds, 864×480', Math.abs(await media.probeDuration(motion.motionAssetPath(id,job.prepared.video))-4)<.01 && (await media.probeSize(motion.motionAssetPath(id,job.prepared.video))).width===864);
  await step(id,'video',{},/确认/);
  check('no video request without cost confirmation', videoPosts===0);
  await step(id,'video',{ confirmed:true },/已锁定/);
  check('default video lock makes no paid request and leaves no submission ledger', videoPosts===0 && !(await motion.readMotion(id)).video);
  await gw('saveConfig', { allowPaidVideoGeneration:true });
  await gw('runMotionStep', { jobId:id,step:'video',confirmed:true });
  await assert.rejects(()=>gw('runMotionStep',{ jobId:id,step:'video',confirmed:true }),/重复/);
  await settled(id);
  await step(id,'video',{ confirmed:true },/禁止重复/);
  check('double click and pending state cause exactly one submission', videoPosts===1);
  check('video request has reference video, two images, 480P and 4 seconds', postedVideo.duration===4 && postedVideo.resolution==='480P' && postedVideo.content.filter(v=>v.type==='video_url').length===1 && postedVideo.content.filter(v=>v.type==='image_url').length===2);
  // Changing the default model/endpoint must not redirect an in-flight task.
  await config.saveConfig({ allowPaidVideoGeneration:false, minimaxModel:'MiniMax-Hailuo-02', minimaxBaseUrl:'http://invalid.invalid' });
  await step(id,'poll');
  job = await motion.readMotion(id);
  check('queries and download use recorded endpoint/model', videoQueries===1 && job.video.status==='ready');
  await config.saveConfig({ allowPaidVideoGeneration:true });
  await step(id,'extract',{},/确认抽帧范围/);
  await gw('saveMotionJob',{ jobId:id,ranges:defaults,rangesConfirmed:true });
  await step(id,'extract');
  job = await motion.readMotion(id);
  check('two actions × eight directions × four distinct frame slots', job.frames.length===64 && new Set(job.frames.map(f=>f.id)).size===64);
  const first = job.frames[0];
  check('extracted frames use 512×512 transparent canvas', (await media.probeSize(motion.motionAssetPath(id,first.keyed))).width===512 && (await media.decodeToRgba(motion.motionAssetPath(id,first.keyed))).rgba[3]===0);
  await step(id,'redraw',{ targets:[first.id] },/确认/);
  check('no redraw without confirmation', imagePosts===0);
  await step(id,'redraw',{ targets:[first.id],confirmed:true });
  check('redraw uses two reference images, mask, high quality and 1024 target', (postedImage.match(/name="image\[\]"/g)||[]).length===2 && postedImage.includes('name="mask"') && postedImage.includes('high') && postedImage.includes('1024x1024'));
  await step(id,'redraw',{ targets:[first.id],confirmed:true });
  check('completed frames skipped without regeneration flag', imagePosts===1);
  job = await motion.readMotion(id);
  check('raw returned image and aligned output both retained', !!job.frames[0].redraw.raw && !!job.frames[0].redraw.file);
  failImage = true;
  await step(id,'redraw',{ targets:[job.frames[1].id],confirmed:true },/未自动重试/);
  check('masked edits failure never falls back to generations and secrets redacted', imagePosts===2 && !(await motion.readMotion(id)).error.includes('dummy-image-key'));
  await step(id,'redraw',{ targets:[job.frames[1].id],confirmed:true },/结果未知/);
  check('unknown redraw result blocks automatic retry', imagePosts===2);
  failImage=false;blankImage=true;
  await step(id,'redraw',{ targets:[job.frames[2].id],confirmed:true },/未得到可用人物/);
  const blank = (await motion.readMotion(id)).frames[2].redraw;
  check('empty redraw rejected while raw paid result preserved', blank.status==='unknown' && !!blank.raw);
  await step(id,'export',{ useRedraw:true },/未完成帧/);
  job = await step(id,'export');
  const files = unzip(await readFile(motion.motionAssetPath(id,job.archive)));
  const metadata = JSON.parse(files.get('animation.json'));
  check('ZIP contains 64 PNG frames, two sheets, timing and CC0 notice', files.size===69 && metadata.actions.length===2 && metadata.actions.every(a=>a.loopVerified===false&&a.frameDurationMs===500) && files.has('source-license.txt'));
  const sheet = files.get('walkfoward-sheet.png');
  check('sheet has eight rows with four frame columns', sheet.readUInt32BE(16)===2048 && sheet.readUInt32BE(20)===4096);
  check('export contains no credentials', ![...files.values()].some(b=>b.includes(Buffer.from('dummy-image-key'))||b.includes(Buffer.from('dummy-video-key'))||b.includes(Buffer.from('dummy-text-key'))));
  const assetBase = `/dsh-game-material-master/motion-assets/${id}/`;
  check('motion frame route is accessible', (await request(assetBase+first.keyed)).status===200);
  check('video route supports seeking', (await request(assetBase+job.video.file,{range:'bytes=0-99'})).status===206);
  check('job JSON blocked by asset allowlist', (await request(assetBase+'job.json')).status===403);
  check('path traversal blocked', (await request(assetBase+'refs/%2e%2e%2fjob.json')).status===400);
  const tool = captured.tools[0];
  const status = await tool.execute({action:'status',id},{});
  check('agent status and deep link identify motion workflow', status.workflow==='motion' && status.openUrl.includes(encodeURIComponent(id)) && !status.openUrl.includes('project='));
  const review = await tool.execute({action:'review',id},{});
  check('agent review supports motion frames', review.stages.find(s=>s.stage==='frames').cells.length===64);
  const intake = await tool.execute({action:'intake',module:'sprite',id},{});
  check('motion intake uses references and per-step confirmation', intake.workflow==='motion' && intake.reviewModeQuestion===null && !intake.questions.some(q=>q.key==='source'||q.key==='generateMode'));
  await gw('uploadMotionAsset',{jobId:id,kind:'video',data:videoBytes.toString('base64')});
  job = await motion.readMotion(id);
  check('local import clears pending pointer and downstream products', !job.video.taskId && !job.frames.length && !job.archive && !job.rangesConfirmed);
  await config.saveConfig({ minimaxModel:'MiniMax-H3-Lite',minimaxBaseUrl:base });
  failVideo=true;
  await step(id,'video',{confirmed:true,regenerate:true},/可能已计费/);
  const before = videoPosts;
  await step(id,'video',{confirmed:true,regenerate:true},/禁止重复/);
  await motion.resumeMotionJobs();
  check('unknown video blocks retry and restart never resubmits', videoPosts===before && (await motion.readMotion(id)).video.status==='unknown');
  // Cancellation is local and must preserve already finished reference assets.
  const other = (await gw('createMotionJob',{})).jobId;
  for(const kind of ['character','directions']) await gw('uploadMotionAsset',{jobId:other,kind,data:png(kind==='character'?512:864,kind==='character'?512:480).toString('base64')});
  await gw('runMotionStep',{jobId:other,step:'prepare'});
  await gw('runMotionStep',{jobId:other,step:'cancel'});
  check('local cancellation ends processing with a clear warning', (await settled(other)).error?.includes('本地处理已停止'));
  console.log(`\n${checks} workflow checks passed. Loopback mocks only; no charges.`);
} finally {
  motion.disposeMotion();
  globalThis.fetch = originalFetch;
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  await rm(home,{recursive:true,force:true});
}
