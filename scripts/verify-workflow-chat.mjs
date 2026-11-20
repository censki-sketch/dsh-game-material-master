/** Real gateway + ffmpeg + loopback API only. Never uses the user's home/config/keys. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const home = await mkdtemp(join(tmpdir(), 'gmm-flow-chat-'));
process.env.DSH_HOME = home;
const { Context } = await import('@deepseek-ai/cordis');
const config = await import('../lib/config.js'), images = await import('../lib/imagegen.js');
const motion = await import('../lib/motiongen.js'), seq = await import('../lib/seqgen.js');
const chat = await import('../lib/workflowchat.js'), { encodePng } = await import('../lib/png.js');
const { runFfmpeg } = await import('../lib/media.js'), wire = await import('../lib/wire.js');
const plugin = await import('../lib/index.js');
let posts = 0, checks = 0, videoBytes;
const ctx = new Context();
ctx.provide('typert', { register: () => () => {} });
ctx.provide('webServer', { register: () => () => {} });
plugin.apply(ctx); const gateway = ctx.get('gameStudio');
const originalFetch = globalThis.fetch;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v2/video_generation') { posts++; for await (const _ of req) {} res.end(JSON.stringify({task_id:'mock-'+posts})); }
  else if (req.url.startsWith('/v2/query/video_generation/')) res.end(JSON.stringify({status:'succeeded',content:{url:base+'/movie.mp4'}}));
  else if (req.url === '/movie.mp4') { res.setHeader('Content-Type','video/mp4');res.end(videoBytes); }
  else { res.statusCode=500;res.end('{"error":"unexpected test endpoint"}'); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = 'http://127.0.0.1:'+server.address().port;
globalThis.fetch = (url,...args) => { assert.equal(new URL(String(url)).origin,base,'external request blocked');return originalFetch(url,...args); };
const check = (name,value) => { assert.ok(value,name);checks++;console.log('✓ '+name); };
const gw = async (method,payload) => {
  const spec=wire.METHODS.find(item=>item.method===method);assert.ok(spec,method);
  const parsed=spec.payload?.parse(payload);if(payload)assert.deepEqual(parsed,payload,'wire must retain every field');
  return gateway[method](parsed);
};
const wait = async (module,jobId) => {
  const until=Date.now()+90000;
  while(Date.now()<until){const c=await gw('getWorkflowConversation',{module,jobId});if(c.rounds.length&&!c.rounds.some(r=>r.status==='running'))return c;await new Promise(r=>setTimeout(r,80));}
  throw Error('round timed out');
};
try {
  const rgba=Buffer.alloc(64*64*4);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=(y*64+x)*4;const body=x>20&&x<44&&y>10&&y<58;rgba[i]=body?70:255;rgba[i+1]=body?140:0;rgba[i+2]=body?90:255;rgba[i+3]=255;}
  const png=encodePng(rgba,64,64), fixture=join(home,'source.png'), movie=join(home,'fixture.mp4');await writeFile(fixture,png);
  await runFfmpeg(['-loop','1','-i',fixture,'-vf','scale=864:480','-t','4','-r','8','-c:v','libx264','-pix_fmt','yuv420p','-y',movie]);videoBytes=await readFile(movie);
  await config.saveConfig({minimaxBaseUrl:base,minimaxApiKey:'fake-key-only',minimaxModel:'MiniMax-H3-Lite',allowPaidVideoGeneration:true,comfyVideo:false,toapisVideo:false,keyColor:'#FF00FF',workingLongEdge:128,frameCount:4,cellWidth:32,cellHeight:32});
  const source=await images.createImageJob('transfer test');await images.addImageToJob(source.id,'original.png',png.toString('base64'));
  let image=await images.readImageJob(source.id);const original=image.items[0].file;
  await images.rekeyImageJob(source.id);image=await images.readImageJob(source.id);const keyed=image.items[0].keyedFile;
  const transferred=await gw('transferAsset',{source:{module:'image',jobId:source.id,file:keyed},target:'sequence',name:'owned reference'});
  const parent=await seq.readSequenceJob(transferred.jobId);
  check('transfer owns the selected keyed version',Buffer.compare(await readFile(seq.sequenceAssetPath(parent.id,parent.refs.firstFrame.file)),await readFile(images.imageAssetPath(source.id,keyed)))===0);
  await assert.rejects(()=>gw('transferAsset',{source:{module:'image',jobId:source.id,file:'../config.json'},target:'map'}));checks++;
  await assert.rejects(()=>gw('transferAsset',{source:{module:'image',jobId:source.id,file:'refs/not-a-result.png'},target:'map'}));checks++;
  const mapTransfer=await gw('transferAsset',{source:{module:'image',jobId:source.id,file:original},target:'map',name:'map reference'});
  const isoTransfer=await gw('transferAsset',{source:{module:'image',jobId:source.id,file:keyed},target:'iso',name:'iso reference'});
  await images.deleteImageJob(source.id);
  const mapData=await gw('getAssetTransfer',{transferId:mapTransfer.transferId,module:'map',jobId:mapTransfer.jobId});
  check('map staging survives deletion of its source',Buffer.compare(Buffer.from(mapData.data,'base64'),png)===0&&mapData.width===64);
  check('map transfer does not import before property confirmation',(await gateway.getMapProject({projectId:mapTransfer.jobId})).tilesets.every(t=>t.builtin));
  check('iso staging owns the keyed data',(await gw('getAssetTransfer',{transferId:isoTransfer.transferId,module:'iso',jobId:isoTransfer.jobId})).data.length>0);
  const imported=await gw('importMapTileset',{projectId:mapTransfer.jobId,name:'confirmed object',data:mapData.data,shape:'stamp',stamp:{cols:1,rows:1,frames:1,pass:[0]},stampKey:false});
  check('confirmed map import accepts the owned image',imported.tilesets.some(t=>t.name==='confirmed object'));
  const isoData=await gw('getAssetTransfer',{transferId:isoTransfer.transferId,module:'iso',jobId:isoTransfer.jobId});
  const importedIso=await gw('importIsoTileset',{projectId:isoTransfer.jobId,name:'confirmed iso object',data:isoData.data,kind:'object',sourceCell:{width:64,height:64},frames:1,footprint:{cols:1,rows:1},anchor:{x:.5,y:1},objectScale:1,pass:[1],keyGreen:false});
  check('confirmed iso import accepts the owned image',importedIso.tilesets.some(t=>t.name==='confirmed iso object'));
  await assert.rejects(()=>gw('getAssetTransfer',{transferId:mapTransfer.transferId,module:'iso',jobId:mapTransfer.jobId}));checks++;
  check('local transfers make zero generation requests',posts===0);
  parent.prompt='walk in place';await seq.writeSequenceJob(parent);
  await assert.rejects(()=>gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'no-confirm',automatic:true}));checks++;
  const submitted=await gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'first',automatic:true,confirmed:true});
  const duplicate=await gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'first',automatic:true,confirmed:true});
  check('idempotent send returns the original round',duplicate.roundId===submitted.roundId);
  await assert.rejects(()=>gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'parallel',automatic:true,confirmed:true}));checks++;
  check('submitted prompt is consumed',(await seq.readSequenceJob(parent.id)).prompt==='');
  let c=await wait('sequence',parent.id),r=c.rounds[0];assert.equal(r.status,'ready',r.error);
  check('video, frames, keying and composition stay in one round',c.rounds.length===1&&['video','raw','keyed','sheet'].every(kind=>r.versions.some(v=>v.kind===kind)));
  check('one send makes exactly one mock video POST',posts===1);
  check('request snapshot retains the prompt and refs',r.request.prompt==='walk in place'&&r.request.refs.firstFrame.file===parent.refs.firstFrame.file);
  check('child round is not a separate sidebar project',(await gw('listSequenceJobs')).jobs.length===1);
  const before=r.versions.length, priorFile=r.versions.find(v=>v.kind==='keyed').files[0], priorBytes=await readFile(seq.sequenceAssetPath(r.childId,priorFile));
  const failedChild=await seq.readSequenceJob(r.childId);failedChild.frames.status='error';failedChild.frames.error='Previous local processing failure';await seq.writeSequenceJob(failedChild);
  await gw('runWorkflowRoundStep',{module:'sequence',jobId:parent.id,roundId:r.id,step:'keyed'});
  c=await wait('sequence',parent.id);r=c.rounds[0];
  check('manual processing adds a version, not a message',c.rounds.length===1&&r.versions.length>before);
  check('successful keying clears a prior local error',r.job.frames.status==='ready'&&!r.job.frames.error);
  check('keying preserves its new composite as a separate version',r.versions.filter(v=>v.kind==='sheet').length===2);
  check('old processed version remains byte identical',Buffer.compare(await readFile(seq.sequenceAssetPath(r.childId,priorFile)),priorBytes)===0);
  check('manual processing never repeats video submission',posts===1);
  const fromVersion=await gw('transferAsset',{source:{module:'sequence',jobId:r.childId,file:priorFile},target:'map',targetId:mapTransfer.jobId,name:'frame'});
  check('a saved frame version can flow to an existing map',fromVersion.jobId===mapTransfer.jobId);
  let edited=await seq.readSequenceJob(parent.id);edited.prompt='run in place';await seq.writeSequenceJob(edited);
  await gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'second',automatic:false,confirmed:true});c=await wait('sequence',parent.id);
  check('new generation creates a new round and keeps prior results',c.rounds.length===2&&c.rounds[0].request.prompt==='walk in place'&&c.rounds[1].request.prompt==='run in place');
  check('manual mode stops at the video',c.rounds[1].versions.length===1&&c.rounds[1].versions[0].kind==='video');
  const interruptedFile=join(config.dataRoot(),'workflow-conversations','sequence-'+parent.id+'.json');
  const interrupted=JSON.parse(await readFile(interruptedFile,'utf8'));interrupted.rounds[1].status='error';interrupted.rounds[1].stage='video';interrupted.rounds[1].error='Interrupted video query';await writeFile(interruptedFile,JSON.stringify(interrupted));
  await gw('runWorkflowRoundStep',{module:'sequence',jobId:parent.id,roundId:c.rounds[1].id,step:'poll'});c=await wait('sequence',parent.id);
  check('explicit query recovers an interrupted round without resubmitting',c.rounds[1].status==='ready'&&!c.rounds[1].error&&c.rounds[1].versions.length===1&&posts===2);
  await assert.rejects(()=>gw('runWorkflowRoundStep',{module:'sequence',jobId:parent.id,roundId:c.rounds[1].id,step:'redraw',confirmed:true,targets:['x']}));checks++;
  check('unsupported steps cannot submit paid work',posts===2);
  const different=await seq.readSequenceJob(parent.id);await seq.uploadSequenceRef(parent.id,'firstFrame','different.png',png.toString('base64'));
  await gw('reuseWorkflowRound',{module:'sequence',jobId:parent.id,roundId:c.rounds[0].id});
  const reused=await seq.readSequenceJob(parent.id);
  check('reuse restores the submitted references as well as the prompt',reused.prompt==='walk in place'&&reused.refs.firstFrame.file===c.rounds[0].request.refs.firstFrame.file);
  check('reused references remain owned and readable',(await readFile(seq.sequenceAssetPath(parent.id,reused.refs.firstFrame.file))).length>0);
  const w=await motion.createMotionJob('local animation');
  await motion.uploadMotionAsset(w.id,'character',png.toString('base64'));await motion.uploadMotionAsset(w.id,'directions',png.toString('base64'));await motion.uploadMotionAsset(w.id,'video',videoBytes.toString('base64'));
  await motion.saveMotionJob(w.id,{segments:[{action:'walkfoward',start:0,end:2,frameCount:4},{action:'runforward',start:2,end:4,frameCount:4}]});
  // Changing actions invalidates video, as in the existing editor; re-import the fixture.
  await motion.uploadMotionAsset(w.id,'video',videoBytes.toString('base64'));
  await gw('submitWorkflowRound',{module:'sprite',jobId:w.id,requestId:'local',automatic:true,localOnly:true});
  const mc=await wait('sprite',w.id);assert.equal(mc.rounds[0].status,'ready',mc.rounds[0].error);
  check('imported motion video auto-processes into one round',mc.rounds.length===1&&mc.rounds[0].versions.some(v=>v.kind==='export'));
  check('local animation incurs no image or video generation',posts===2);
  check('motion child is hidden from the project list',(await gw('listMotionJobs')).jobs.length===1);
  const persisted=JSON.parse(await readFile(join(config.dataRoot(),'workflow-conversations','sprite-'+w.id+'.json'),'utf8'));
  persisted.rounds[0].status='running';persisted.rounds[0].stage='submit';await writeFile(join(config.dataRoot(),'workflow-conversations','sprite-'+w.id+'.json'),JSON.stringify(persisted));
  chat.disposeWorkflowChat();chat.activateWorkflowChat();await chat.resumeWorkflowChats();
  check('restart never replays an interrupted paid submission',(await gw('getWorkflowConversation',{module:'sprite',jobId:w.id})).rounds[0].status==='error'&&posts===2);
  const children=c.rounds.map(r=>r.childId);await gw('deleteSequenceJob',{jobId:parent.id});
  check('deleting a conversation cleans its owned round jobs',(await Promise.all(children.map(id=>seq.readSequenceJob(id)))).every(v=>!v));
  console.log(`Passed ${checks} workflow chat checks. Mock requests only.`);
} finally {
  chat.disposeWorkflowChat();motion.disposeMotion();seq.disposeSequence();globalThis.fetch=originalFetch;
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});
}
