/** Real gateway + ffmpeg + loopback API only. Never uses the user's home/config/keys. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';
const home = await mkdtemp(join(tmpdir(), 'gmm-flow-chat-'));
process.env.DSH_HOME = home;
const { Context } = await import('@deepseek-ai/cordis');
const config = await import('../lib/config.js'), images = await import('../lib/imagegen.js');
const motion = await import('../lib/motiongen.js'), seq = await import('../lib/seqgen.js');
const chat = await import('../lib/workflowchat.js'), { encodePng } = await import('../lib/png.js');
const { runFfmpeg, decodeToRgba } = await import('../lib/media.js'), wire = await import('../lib/wire.js');
const plugin = await import('../lib/index.js');
let posts = 0, checks = 0, videoBytes, editJobId, imagePosts = 0, imageFailAt = 0;
const imageRequests = [];
const imageRequestModels = [];
const videoRequests=[];
const ctx = new Context();
ctx.provide('typert', { register: () => () => {} });
ctx.provide('webServer', { register: () => () => {} });
plugin.apply(ctx); const gateway = ctx.get('gameStudio');
const originalFetch = globalThis.fetch;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v2/video_generation') { posts++; const parts=[];for await (const chunk of req)parts.push(chunk);videoRequests.push(JSON.parse(Buffer.concat(parts)));res.end(JSON.stringify({task_id:'mock-'+posts})); }
  else if (req.url.startsWith('/v2/query/video_generation/')) res.end(JSON.stringify({status:'succeeded',content:{url:base+'/movie.mp4'}}));
  else if (req.url === '/movie.mp4') { res.setHeader('Content-Type','video/mp4');res.end(videoBytes); }
  else if (req.url === '/v1/images/edits') {
    imagePosts++; const parts=[];for await (const chunk of req)parts.push(chunk);const body=Buffer.concat(parts);imageRequests.push(body.toString('latin1'));
    const form=await new Response(body,{headers:{'Content-Type':req.headers['content-type']}}).formData();
    const requestModel=String(form.get('model'));imageRequestModels.push({model:requestModel,size:String(form.get('size'))});
    if (imagePosts === imageFailAt) { res.statusCode=502;res.end('{"error":"mock interruption"}'); }
    else {
      // Recolor the actual submitted foreground, retaining pose and alpha.
      const editing=await motion.readMotion(editJobId),frame=editing.frames.find(f=>f.redraw?.status==='attempted');
      const edited=await decodeToRgba(motion.motionAssetPath(editJobId,frame.keyed));
      for(let p=0;p<edited.rgba.length;p+=4)if(edited.rgba[p+3])edited.rgba.set([210,60,120],p);
      if(requestModel==='mock-1k-independent'){
        const enlarged=Buffer.alloc(1024*1024*4);
        for(let y=0;y<1024;y++)for(let x=0;x<1024;x++){
          const source=((Math.floor(y*edited.height/1024)*edited.width)+Math.floor(x*edited.width/1024))*4;
          edited.rgba.copy(enlarged,(y*1024+x)*4,source,source+4);
        }
        res.end(JSON.stringify({data:[{b64_json:encodePng(enlarged,1024,1024).toString('base64')}]}));
      }else res.end(JSON.stringify({data:[{b64_json:encodePng(edited.rgba,edited.width,edited.height).toString('base64')}]}));
    }
  }
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
const timingSignature = timings => timings.map(({step,status}) => `${step}:${status}`);
function checkCompletedTimings(round, expected, label) {
  assert.ok(Array.isArray(round.timings), 'round must expose timings');
  assert.deepEqual(timingSignature(round.timings), expected, label);
  let previousEnd = 0;
  for (const timing of round.timings) {
    assert.ok(Number.isSafeInteger(timing.startedAt) && timing.startedAt >= previousEnd, 'timing starts in order');
    assert.ok(Number.isSafeInteger(timing.endedAt) && timing.endedAt >= timing.startedAt, 'timing has a valid finish time');
    previousEnd = timing.endedAt;
  }
  check(label, true);
}
function unzip(bytes) {
  const entries = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method=bytes.readUInt16LE(offset+8),size=bytes.readUInt32LE(offset+18),length=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
    const name=bytes.toString('utf8',offset+30,offset+30+length),start=offset+30+length+extra,value=bytes.subarray(start,start+size);
    entries.set(name,method===8?inflateRawSync(value):value);offset=start+size;
  }
  return entries;
}
try {
  const rgba=Buffer.alloc(64*64*4);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=(y*64+x)*4;const body=x>20&&x<44&&y>10&&y<58;rgba[i]=body?70:255;rgba[i+1]=body?140:0;rgba[i+2]=body?90:255;rgba[i+3]=255;}
  const png=encodePng(rgba,64,64), fixture=join(home,'source.png'), movie=join(home,'fixture.mp4');
  await writeFile(fixture,png);
  // The fake video has one complete character in each direction cell.
  const grid=Buffer.alloc(864*480*4);
  for(let y=0;y<480;y++)for(let x=0;x<864;x++){const p=((Math.floor((y%240)*64/240)*64)+Math.floor((x%216)*64/216))*4;rgba.copy(grid,(y*864+x)*4,p,p+4);}
  const gridFile=join(home,'eight-directions.png');await writeFile(gridFile,encodePng(grid,864,480));
  await runFfmpeg(['-loop','1','-i',gridFile,'-t','4','-r','8','-c:v','libx264','-pix_fmt','yuv420p','-y',movie]);videoBytes=await readFile(movie);
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
  const transferCapabilities=wire.METHODS.find(item=>item.method==='listMotionJobs').result.parse(await gw('listMotionJobs'));
  check('motion list advertises slot-aware transfers through the real result schema',transferCapabilities.assetTransferRoles?.includes('directions')&&transferCapabilities.assetTransferRoles.includes('character'));
  const characterTransfer=await gw('transferAsset',{source:{module:'image',jobId:source.id,file:original},target:'sprite',name:'role transfer'});
  const characterJob=await motion.readMotion(characterTransfer.jobId),characterFile=characterJob.character;
  check('legacy animation transfer fills only the character slot',!!characterFile&&!characterJob.directions);
  await gw('transferAsset',{source:{module:'image',jobId:source.id,file:keyed},target:'sprite',targetId:characterJob.id,targetRole:'directions',name:'directions reference'});
  const withDirections=await motion.readMotion(characterJob.id);
  check('directions transfer preserves the existing character and owns the selected version',withDirections.character===characterFile&&!!withDirections.directions&&Buffer.compare(await readFile(motion.motionAssetPath(characterJob.id,withDirections.directions)),await readFile(images.imageAssetPath(source.id,keyed)))===0);
  const directionsFile=withDirections.directions;
  const explicitCharacter=await gw('transferAsset',{source:{module:'image',jobId:source.id,file:original},target:'sprite',targetId:characterJob.id,targetRole:'character'});
  check('explicit character transfer leaves the directions slot intact',(await motion.readMotion(characterJob.id)).directions===directionsFile);
  const roleRecord=await gw('getAssetTransfer',{transferId:explicitCharacter.transferId,module:'sprite',jobId:characterJob.id});
  check('transfer record retains the explicit destination slot',roleRecord.targetRole==='character');
  await assert.rejects(()=>gw('transferAsset',{source:{module:'image',jobId:source.id,file:original},target:'sprite',targetRole:'unknown'}));checks++;
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
  for(const prompt of ['', ' \n\t　 ']){
    parent.prompt=prompt;await seq.writeSequenceJob(parent);
    await assert.rejects(()=>gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'empty-sequence-prompt',automatic:true,confirmed:true}),/请先填写提示词/);checks++;
    check('empty sequence instructions create no round or paid request',(await gw('getWorkflowConversation',{module:'sequence',jobId:parent.id})).rounds.length===0&&posts===0&&(await seq.readSequenceJob(parent.id)).prompt===prompt);
  }
  parent.prompt='walk in place';await seq.writeSequenceJob(parent);
  await assert.rejects(()=>gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'no-confirm',automatic:true}));checks++;
  const submitted=await gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'first',automatic:true,confirmed:true});
  const duplicate=await gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'first',automatic:true,confirmed:true});
  check('idempotent send returns the original round',duplicate.roundId===submitted.roundId);
  await assert.rejects(()=>gw('submitWorkflowRound',{module:'sequence',jobId:parent.id,requestId:'parallel',automatic:true,confirmed:true}));checks++;
  check('submitted prompt is consumed',(await seq.readSequenceJob(parent.id)).prompt==='');
  let c=await wait('sequence',parent.id),r=c.rounds[0];assert.equal(r.status,'ready',r.error);
  check('video, frames, keying and composition stay in one round',c.rounds.length===1&&['video','raw','keyed','sheet'].every(kind=>r.versions.some(v=>v.kind===kind)));
  checkCompletedTimings(r,['video:ready','extract:ready'],'a generated sequence records one video step and one automatic extraction');
  check('one send makes exactly one mock video POST',posts===1);
  check('request snapshot retains the prompt and refs',r.request.prompt==='walk in place'&&r.request.refs.firstFrame.file===parent.refs.firstFrame.file);
  check('child round is not a separate sidebar project',(await gw('listSequenceJobs')).jobs.length===1);
  const before=r.versions.length, priorFile=r.versions.find(v=>v.kind==='keyed').files[0], priorBytes=await readFile(seq.sequenceAssetPath(r.childId,priorFile));
  const failedChild=await seq.readSequenceJob(r.childId);failedChild.frames.status='error';failedChild.frames.error='Previous local processing failure';await seq.writeSequenceJob(failedChild);
  await gw('runWorkflowRoundStep',{module:'sequence',jobId:parent.id,roundId:r.id,step:'keyed'});
  c=await wait('sequence',parent.id);r=c.rounds[0];
  checkCompletedTimings(r,['video:ready','extract:ready','keyed:ready'],'manual sequence keying appends its own timing');
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
  const motionProjectCount=(await gw('listMotionJobs')).jobs.length;
  const w=await motion.createMotionJob('local animation');
  await motion.uploadMotionAsset(w.id,'character',png.toString('base64'));await motion.uploadMotionAsset(w.id,'directions',png.toString('base64'));await motion.uploadMotionAsset(w.id,'video',videoBytes.toString('base64'));
  await motion.saveMotionJob(w.id,{segments:[{action:'walkfoward',start:0,end:2,frameCount:4},{action:'runforward',start:2,end:4,frameCount:4}]});
  // Changing actions invalidates video, as in the existing editor; re-import the fixture.
  await motion.uploadMotionAsset(w.id,'video',videoBytes.toString('base64'));
  await motion.saveMotionJob(w.id,{rangesConfirmed:true,videoRange:{start:0,end:4,frameCount:4}});
  await gw('submitWorkflowRound',{module:'sprite',jobId:w.id,requestId:'local',automatic:true,localOnly:true});
  let mc=await wait('sprite',w.id);assert.equal(mc.rounds[0].status,'ready',mc.rounds[0].error);
  check('automatic review still waits at the original video until ranges are confirmed',mc.rounds.length===1&&mc.rounds[0].stage==='awaiting-ranges'&&mc.rounds[0].versions.map(v=>v.kind).join(',')==='video'&&!mc.rounds[0].job.frames.length&&mc.rounds[0].job.rangesConfirmed===false);
  checkCompletedTimings(mc.rounds[0],['import:ready'],'an uploaded video only records import until the user applies ranges');
  const importedProcessing={...motion.motionProcessing(mc.rounds[0].job.processing),cellWidth:64,cellHeight:64};
  const importProcess={module:'sprite',jobId:w.id,roundId:mc.rounds[0].id,step:'process'};
  const twoRanges=[{action:'video',start:.25,end:1.25,frameCount:1,targetFps:1},{action:'video-2',start:2.5,end:3.5,frameCount:1,targetFps:1}];
  const applyTwo={...importProcess,ranges:twoRanges,processing:importedProcessing,autoUpscale:false};
  await assert.rejects(()=>gw('runWorkflowRoundStep',{...importProcess,processing:importedProcessing}),/确认全部动作范围/);
  await assert.rejects(()=>gw('runWorkflowRoundStep',{...importProcess,step:'extract',ranges:twoRanges}),/应用并处理|确认全部动作范围/);
  const pendingImport=(await gw('getWorkflowConversation',{module:'sprite',jobId:w.id})).rounds[0];
  check('unconfirmed or direct extraction keeps the initial upload pending',pendingImport.stage==='awaiting-ranges'&&pendingImport.status==='ready'&&pendingImport.versions.length===1&&pendingImport.timings.length===1);
  const initialLocalPlan=await gw('runWorkflowRoundStep',{...applyTwo,planOnly:true});
  check('the two-range plan counts only selected frames and leaves the atlas for a separate step',initialLocalPlan.steps.join(',')==='extract'&&initialLocalPlan.frameCount===16);
  const initialClip=JSON.stringify(await motion.readMotion(mc.rounds[0].childId));
  for (const ranges of [
    [twoRanges[0],{...twoRanges[1],start:1}],
    [twoRanges[0],{...twoRanges[1],action:'video'}],
  ]) await assert.rejects(()=>gw('runWorkflowRoundStep',{...applyTwo,ranges}));
  check('overlapping or duplicate imported ranges are rejected before touching the job',JSON.stringify(await motion.readMotion(mc.rounds[0].childId))===initialClip);
  await gw('runWorkflowRoundStep',applyTwo);
  mc=await wait('sprite',w.id);assert.equal(mc.rounds[0].status,'ready',mc.rounds[0].error);
  const twoRangeRound=mc.rounds[0];
  check('applying two independent ranges yields just the expected raw and keyed frames',twoRangeRound.versions.map(v=>v.kind).join(',')==='video,raw,keyed'&&twoRangeRound.job.frames.length===16&&twoRangeRound.job.frames.every(f=>twoRanges.some(r=>r.action===f.action&&f.time>=r.start&&f.time<r.end)));
  await gw('runWorkflowRoundStep',{...applyTwo,forceLocal:'export'});
  mc=await wait('sprite',w.id);assert.equal(mc.rounds[0].status,'ready',mc.rounds[0].error);
  check('explicit atlas composition retains the selected frame versions',mc.rounds[0].versions.map(v=>v.kind).join(',')==='video,raw,keyed,export'&&twoRangeRound.versions.every(v=>mc.rounds[0].versions.some(saved=>saved.id===v.id)));
  checkCompletedTimings(mc.rounds[0],['import:ready','extract:ready','export:ready'],'manual local timing follows the actual import, extraction and requested export sequence');
  const motionRun=JSON.parse(await readFile(join(config.dataRoot(),'workflow-conversations','sprite-'+w.id+'.json'),'utf8'));
  const motionWire=wire.METHODS.find(item=>item.method==='getWorkflowConversation').result.parse(mc);
  check('the motion timing history persists exactly and reaches the gateway result',JSON.stringify(motionRun.rounds[0].timings)===JSON.stringify(mc.rounds[0].timings)&&JSON.stringify(motionWire.rounds[0].timings)===JSON.stringify(mc.rounds[0].timings));
  const extractDetails=mc.rounds[0].timings.find(timing=>timing.step==='extract').details;
  check('extraction records decoding, frame writing, keying and snapshot separately', ['decode','frames','keyed','snapshot'].every(step=>extractDetails.some(timing=>timing.step===step&&Number.isSafeInteger(timing.startedAt)&&timing.endedAt>=timing.startedAt)));
  const exportDetails=mc.rounds[0].timings.find(timing=>timing.step==='export').details;
  check('local export records atlas, ZIP and snapshot timings',['atlas','zip','snapshot'].every(step=>exportDetails.some(timing=>timing.step===step&&timing.endedAt>=timing.startedAt)));
  check('local animation incurs no image or video generation',posts===2);
  check('motion child is hidden from the project list',(await gw('listMotionJobs')).jobs.length===motionProjectCount+1);
  const motionRound=mc.rounds[0], motionFile=motionRound.versions.find(v=>v.kind==='keyed').files[0];
  const spriteSource={module:'sprite',jobId:motionRound.childId,file:motionFile};
  const sequenceCount=(await gw('listSequenceJobs')).jobs.length;
  for(const target of ['sprite','sequence']) await assert.rejects(()=>gw('transferAsset',{source:spriteSource,target}),/八方向图只能流转到地图编辑器/);
  check('blocked sprite transfers never create an animation project',(await gw('listMotionJobs')).jobs.length===motionProjectCount+1&&(await gw('listSequenceJobs')).jobs.length===sequenceCount);
  for(const [target,targetId] of [['map',mapTransfer.jobId],['iso',isoTransfer.jobId]]){
    const result=await gw('transferAsset',{source:spriteSource,target,targetId,name:'sprite frame'});
    const staged=await gw('getAssetTransfer',{transferId:result.transferId,module:target,jobId:targetId});
    check('sprite frame can flow to '+target,result.module===target&&result.jobId===targetId&&result.dialog==='add'&&Buffer.from(staged.data,'base64').equals(await readFile(motion.motionAssetPath(spriteSource.jobId,motionFile))));
  }
  // Composer rules are enforced through the real wire, not only disabled buttons.
  const local=await motion.createMotionJob('video without pictures'),chosen=[{action:'walkfoward',start:0,end:2,frameCount:4},{action:'runforward',start:2,end:4,frameCount:4}];
  for(const prompt of ['', ' \n\t　 ']){
    await gw('saveMotionJob',{jobId:local.id,prompt});
    await assert.rejects(()=>gw('submitWorkflowRound',{module:'sprite',jobId:local.id,requestId:'empty-motion-prompt',automatic:true,confirmed:true}),/请先填写提示词/);checks++;
    check('empty motion instructions create no round or paid request',(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})).rounds.length===0&&posts===2&&(await motion.readMotion(local.id)).prompt===prompt);
  }
  const submitLocal=()=>gw('submitWorkflowRound',{module:'sprite',jobId:local.id,requestId:'video-only',automatic:true,localOnly:true});
  await assert.rejects(submitLocal,/导入视频/);checks++;
  await gw('saveMotionJob',{jobId:local.id,segments:chosen,prompt:'Follow the chosen reference actions in place'});
  await assert.rejects(()=>gw('submitWorkflowRound',{module:'sprite',jobId:local.id,requestId:'missing-images',automatic:true,confirmed:true}),/角色图/);checks++;
  await gw('uploadMotionAsset',{jobId:local.id,kind:'character',data:png.toString('base64')});
  await assert.rejects(()=>gw('submitWorkflowRound',{module:'sprite',jobId:local.id,requestId:'one-image',automatic:true,confirmed:true}),/八方向/);checks++;
  await gw('uploadMotionAsset',{jobId:local.id,kind:'remove-character',data:''});
  await gw('saveMotionJob',{jobId:local.id,segments:chosen.map(s=>({...s,action:''}))});
  await gw('uploadMotionAsset',{jobId:local.id,kind:'video',data:videoBytes.toString('base64')});
  check('uploading a source video creates no premature chat message',(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})).rounds.length===0);
  check('video upload defaults to a whole clip without touching generation actions',(await motion.readMotion(local.id)).videoRange.end===4&&(await motion.readMotion(local.id)).segments.every(s=>s.action===''));
  await assert.rejects(()=>gw('saveMotionJob',{jobId:local.id,videoRange:{start:0,end:5,frameCount:4}}),/Invalid video range/);checks++;
  await assert.rejects(()=>gw('saveMotionJob',{jobId:local.id,videoRange:{start:0,end:4,frameCount:4.5}}),/Invalid video range/);checks++;
  const processing={...motion.motionProcessing(),extract:false,key:false,sheet:false,cellWidth:64,cellHeight:80};
  const settings=await gw('motionSettings',{}),template=structuredClone(settings.templates[0]);template.prompt.zh='{{timeline}} | {{description}} | {{keyColor}}';
  await gw('motionSettings',{save:true,templates:[template]});
  const promptTemplate={id:template.id,lang:'zh',content:template.prompt.zh};
  await gw('saveMotionJob',{jobId:local.id,composerVersion:1,inputMode:'video',processing,promptTemplate,description:'Blue cape',prompt:'Extra instructions',videoRange:{start:0,end:4,frameCount:4}});
  const ready=await gw('getMotionJob',{jobId:local.id});
  check('template replaces placeholders and appends only the round instructions',ready.finalPrompt.includes('Blue cape | #FF00FF')&&ready.finalPrompt.endsWith('Extra instructions')&&!ready.finalPrompt.includes('{{'));
  await submitLocal();let lc=await wait('sprite',local.id),lr=lc.rounds[0];
  check('video-only parsing works without images, actions, confirmation or paid calls',lc.rounds.length===1&&lr.status==='ready'&&!lr.request.character&&!lr.request.directions&&!lr.request.segments.length&&lr.job.ranges.length===1&&lr.job.ranges[0].action==='video'&&posts===2);
  check('parsing keeps the unused generation prompt on the parent',(await motion.readMotion(local.id)).prompt==='Extra instructions'&&lr.prompt===''&&lr.request.finalPrompt==='');
  check('the imported round initially contains only its video',lr.versions.length===1&&lr.versions[0].kind==='video');
  checkCompletedTimings(lr,['import:ready'],'import alone only records video preparation');
  check('the submitted round owns processing and template snapshots',JSON.stringify(lr.request.processing)===JSON.stringify(processing)&&lr.request.promptTemplate.content===promptTemplate.content);
  template.prompt.zh='New template {{description}}';await gw('motionSettings',{save:true,templates:[template]});
  check('editing a global template preserves prior round content',(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})).rounds[0].request.promptTemplate.content===promptTemplate.content);
  await assert.rejects(()=>gw('motionSettings',{save:true,templates:[]}));checks++;
  await assert.rejects(()=>gw('motionSettings',{save:true,templates:[{...template,prompt:{zh:'{{unknown}}',en:'{{unknown}}'}}]}));checks++;
  await gw('runWorkflowRoundStep',{module:'sprite',jobId:local.id,roundId:lr.id,step:'process',ranges:[{action:'video',start:0,end:4,frameCount:4}],processing,autoUpscale:false});
  lc=await wait('sprite',local.id);lr=lc.rounds[0];assert.equal(lr.status,'ready',lr.error);
  check('manual extraction with keying disabled saves only a raw version',lr.versions.some(v=>v.kind==='raw')&&!lr.versions.some(v=>v.kind==='keyed'||v.kind==='export'));
  const rawOnlyDetails=lr.timings.at(-1).details;
  check('raw-only extraction records frame writing without a keying timing',rawOnlyDetails.some(timing=>timing.step==='frames')&&!rawOnlyDetails.some(timing=>timing.step==='keyed'));
  const rawVersion=lr.versions.find(v=>v.kind==='raw'),rawFile=motion.motionAssetPath(lr.childId,rawVersion.files[0]),rawBytes=await readFile(rawFile);
  check('frame versions snapshot the actual extraction timing',rawVersion.ranges?.[0].frameCount===4&&rawVersion.ranges[0].end===4&&rawVersion.frames.every(f=>Number.isFinite(f.time)));
  check('disabled keying leaves the actual PNG opaque',(await decodeToRgba(rawFile)).rgba[3]===255);
  await gw('runWorkflowRoundStep',{module:'sprite',jobId:local.id,roundId:lr.id,step:'keyed',processing:{...processing,key:true}});
  lc=await wait('sprite',local.id);lr=lc.rounds[0];assert.equal(lr.status,'ready',lr.error);
  const cleanVersion=lr.versions.find(v=>v.kind==='keyed');
  check('later processing preserves the original version timing',cleanVersion.ranges[0].frameCount===4&&rawVersion.ranges[0].end===4);
  check('standalone keying writes transparent pixels while preserving the raw version',(await decodeToRgba(motion.motionAssetPath(lr.childId,cleanVersion.files[0]))).rgba[3]===0&&Buffer.compare(await readFile(rawFile),rawBytes)===0);
  await gw('runWorkflowRoundStep',{module:'sprite',jobId:local.id,roundId:lr.id,step:'export',processing:{...processing,key:true}});
  lc=await wait('sprite',local.id);lr=lc.rounds[0];assert.equal(lr.status,'ready',lr.error);
  const { readdir }=await import('node:fs/promises');const out=motion.motionAssetPath(lr.childId,lr.job.archive).replace(/sprites\.zip$/,'');
  const metadata=JSON.parse(await readFile(join(out,'animation.json'),'utf8'));
  const sheet=(await readdir(out)).find(name=>name.endsWith('-sheet.png'));const sheetBytes=await readFile(join(out,sheet));
  check('configured cell dimensions affect the actual sheet',metadata.cellWidth===64&&metadata.cellHeight===80&&sheetBytes.readUInt32BE(16)===256&&sheetBytes.readUInt32BE(20)===640);
  check('individual steps retain one message and never submit videos',lc.rounds.length===1&&posts===2);
  const localSteps=['import:ready','extract:ready','keyed:ready','export:ready'];
  checkCompletedTimings(lr,localSteps,'manual motion steps preserve earlier timings and append exactly the steps executed');
  const fakeUpscale=join(home,'fake-workflow-upscale.mjs'), holdUpscale=join(home,'hold-upscale');
  await writeFile(fakeUpscale,`
    import { mkdir, readdir, writeFile, stat } from 'node:fs/promises';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import { encodePng } from ${JSON.stringify(new URL('../lib/png.js',import.meta.url).href)};
    const option=flag=>process.argv[process.argv.indexOf(flag)+1];
    const exists=file=>stat(file).then(()=>true,()=>false);
    if(await exists(${JSON.stringify(holdUpscale)})) {
      const deadline=Date.now()+10000;
      while(Date.now()<deadline && !(await exists(option('--cancel-file')))) await delay(20);
      process.exit(130);
    }
    const out=option('--output'), frames=await readdir(option('--source'));
    await mkdir(out,{recursive:true});
    const png=encodePng(Buffer.alloc(1024*1024*4),1024,1024);
    for(const frame of frames) await writeFile(join(out,frame),png);
    await writeFile(join(out,'sr-report.json'),JSON.stringify({frame_count:frames.length,native_scale:2}));
  `);
  const upscaleEnv={ GMM_LOCAL_UPSCALE_SCRIPT:fakeUpscale, GMM_LOCAL_UPSCALE_PYTHON:process.execPath };
  const previousEnv=Object.fromEntries(Object.keys(upscaleEnv).map(key=>[key,process.env[key]]));
  Object.assign(process.env,upscaleEnv);
  try {
    const threeRanges=[{action:'video',start:0,end:1,frameCount:1,targetFps:1},{action:'video-2',start:1.375,end:2.375,frameCount:1,targetFps:1},{action:'video-3',start:2.875,end:3.875,frameCount:1,targetFps:1}];
    const applyThree={...importProcess,ranges:threeRanges,processing:importedProcessing,autoUpscale:true};
    const twoRangeJob=JSON.stringify(await motion.readMotion(mc.rounds[0].childId));
    await assert.rejects(()=>gw('runWorkflowRoundStep',{...applyThree,processing:{...importedProcessing,key:false}}));
    check('automatic upscale cannot submit a range draft without transparent keying',JSON.stringify(await motion.readMotion(mc.rounds[0].childId))===twoRangeJob);
    const threeRangePlan=await gw('runWorkflowRoundStep',{...applyThree,planOnly:true});
    check('the plan adds local upscaling after extraction for the three selected ranges',threeRangePlan.steps.join(',')==='extract,upscale'&&threeRangePlan.frameCount===24);
    await gw('runWorkflowRoundStep',applyThree);
    const split=(await wait('sprite',w.id)).rounds[0];
    assert.equal(split.status,'ready',split.error);
    check('applying three ranges runs local upscale and preserves the older frame and atlas versions',split.versions.map(v=>v.kind).join(',')==='video,raw,keyed,export,raw,keyed,upscale'&&mc.rounds[0].versions.every(v=>split.versions.some(saved=>saved.id===v.id)));
    const finalSplit=split.versions.at(-1);
    check('source times and output IDs exclude every discarded gap across all directions',finalSplit.frames.length===24&&new Set(finalSplit.frames.map(frame=>frame.id)).size===24&&threeRanges.every(range=>finalSplit.frames.filter(frame=>frame.action===range.action&&frame.time>=range.start&&frame.time<range.end).length===8));
    check('multi-range processing remains wholly local',posts===2&&imagePosts===0&&(await readFile(motion.motionAssetPath(split.childId,split.versions[0].files[0]))).equals(videoBytes));
    checkCompletedTimings(split,['import:ready','extract:ready','export:ready','extract:ready','upscale:ready'],'each applied local pipeline records only the stages it executed');
    const identicalDraft=await gw('runWorkflowRoundStep',{...applyThree,planOnly:true});
    check('applying an unchanged selection does not plan duplicate extraction or upscaling',identicalDraft.steps.length===0);

    const upscale={module:'sprite',jobId:local.id,roundId:lr.id,step:'upscale',confirmed:true};
    await gw('runWorkflowRoundStep',upscale);
    const upscaled=(await wait('sprite',local.id)).rounds[0];
    const oldUpscale=upscaled.versions.find(v=>v.kind==='upscale');
    assert.equal(upscaled.status,'ready',upscaled.error);
    assert.ok(oldUpscale);
    checkCompletedTimings(upscaled,[...localSteps,'upscale:ready'],'successful local upscaling records its own timing');
    const upscaleDetails=upscaled.timings.at(-1).details;
    check('local upscale records preparation, inference, writing and snapshot timings',['upscale-prepare','upscale-enhance','upscale-finish','snapshot'].every(step=>upscaleDetails.some(timing=>timing.step===step&&timing.endedAt>=timing.startedAt)));
    await writeFile(holdUpscale,'');
    await gw('runWorkflowRoundStep',upscale);
    const inProgress=(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})).rounds[0];
    const activeTiming=inProgress.timings.at(-1);
    check('running timing is visible before local upscaling finishes',activeTiming.step==='upscale'&&activeTiming.status==='running'&&Number.isSafeInteger(activeTiming.startedAt)&&activeTiming.endedAt===undefined);
    await assert.rejects(()=>gw('runWorkflowRoundStep',upscale),/请等待当前轮次完成|任务正在处理/);
    const stillRunning=(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})).rounds[0];
    assert.deepEqual(stillRunning.timings,inProgress.timings);
    check('a duplicate request cannot disturb the accepted operation or its timing',stillRunning.status==='running');
    await gw('runWorkflowRoundStep',{module:'sprite',jobId:local.id,roundId:lr.id,step:'cancel'});
    lc=await wait('sprite',local.id);lr=lc.rounds[0];
    checkCompletedTimings(lr,[...localSteps,'upscale:ready','upscale:stopped'],'cancelled local upscaling updates the pending timing with its stopped outcome');
    check('cancelling another upscale keeps the preceding result',lr.status==='stopped'&&lr.versions.filter(v=>v.kind==='upscale').length===1&&lr.versions.some(v=>v.id===oldUpscale.id));
  } finally {
    for(const [key,value] of Object.entries(previousEnv)) if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
  await gw('saveMotionJob',{jobId:local.id,prompt:'New draft'});await gw('reuseWorkflowRound',{module:'sprite',jobId:local.id,roundId:lr.id});
  const restored=await motion.readMotion(local.id);
  check('reuse restores original template, source video and processing',restored.prompt==='New draft'&&restored.segments.every(s=>s.action==='')&&restored.processing.key===false&&restored.promptTemplate.content===promptTemplate.content&&!!(await readFile(motion.motionAssetPath(local.id,restored.sourceVideo.file))).length);
  await gw('runWorkflowRoundStep',{module:'sprite',jobId:w.id,roundId:mc.rounds[0].id,step:'extract',ranges:chosen,processing});
  const legacyRanges=await wait('sprite',w.id);
  check('existing multi-action ranges still support standalone extraction',legacyRanges.rounds[0].job.ranges.length===2&&legacyRanges.rounds[0].job.frames.length===64);
  const persisted=JSON.parse(await readFile(join(config.dataRoot(),'workflow-conversations','sprite-'+w.id+'.json'),'utf8'));
  const pendingRound=persisted.rounds[0], completedBeforeRestart=structuredClone(pendingRound.timings);
  pendingRound.status='running';pendingRound.stage='submit';
  pendingRound.timings.push({step:'video',status:'running',startedAt:Date.now()});
  await writeFile(join(config.dataRoot(),'workflow-conversations','sprite-'+w.id+'.json'),JSON.stringify(persisted));
  chat.disposeWorkflowChat();chat.activateWorkflowChat();await chat.resumeWorkflowChats();
  const interruptedMotion=(await gw('getWorkflowConversation',{module:'sprite',jobId:w.id})).rounds[0];
  check('restart never replays an interrupted paid submission',interruptedMotion.status==='error'&&posts===2);
  assert.deepEqual(interruptedMotion.timings.slice(0,-1),completedBeforeRestart);
  const interruptedTiming=interruptedMotion.timings.at(-1);
  check('restart closes interrupted timing without inventing a finish timestamp',interruptedTiming.step==='video'&&interruptedTiming.status==='error'&&interruptedTiming.endedAt===undefined);
  await gw('saveMotionJob',{jobId:local.id,reviewMode:'manual',processing:{...processing,extract:true,key:true,sheet:true}});
  await gw('submitWorkflowRound',{module:'sprite',jobId:local.id,requestId:'manual-parse',automatic:false,localOnly:true});
  let manual=await wait('sprite',local.id);const parsed=manual.rounds.at(-1);
  check('manual review also waits at the video until the user selects useful frames',parsed.status==='ready'&&parsed.versions.map(v=>v.kind).join(',')==='video'&&!parsed.job.frames.length&&posts===2);
  checkCompletedTimings(parsed,['import:ready'],'manual review only records the completed import');
  check('a fresh imported round defaults to one neutral action range',parsed.job.ranges.length===1&&parsed.job.ranges[0].action==='video');
  check('manual review is snapshotted with the local round',parsed.request.reviewMode==='manual'&&parsed.automatic===false);
  const {stdout:directionPng}=await runFfmpeg(['-i',fixture,'-vf','scale=864:480','-frames:v','1','-c:v','png','-f','image2pipe','pipe:1']);
  await gw('uploadMotionAsset',{jobId:local.id,kind:'character',data:png.toString('base64')});await gw('uploadMotionAsset',{jobId:local.id,kind:'directions',data:directionPng.toString('base64')});
  await assert.rejects(()=>gw('saveMotionJob',{jobId:local.id,videoModel:'MiniMax-H3-Max'}),/4秒/);checks++;
  await gw('saveMotionJob',{jobId:local.id,reviewMode:'manual',videoModel:'MiniMax-H3',inputMode:'generate',segments:chosen});
  await assert.rejects(()=>gw('submitWorkflowRound',{module:'sprite',jobId:local.id,requestId:'changed-model',automatic:false,confirmed:true,expectedVideoModel:'MiniMax-H3-Lite'}),/模型已变更/);checks++;
  await gw('submitWorkflowRound',{module:'sprite',jobId:local.id,requestId:'chosen-model',automatic:false,confirmed:true,expectedVideoModel:'MiniMax-H3'});
  await config.saveConfig({minimaxModel:'MiniMax-H3-Lite',toapisVideo:true});
  manual=await wait('sprite',local.id);const generated=manual.rounds.at(-1);assert.equal(generated.status,'ready',generated.error);
  check('the chosen video model reaches the real adapter with a compatible resolution',posts===3&&videoRequests.at(-1).model==='MiniMax-H3'&&videoRequests.at(-1).duration===4&&videoRequests.at(-1).resolution==='768P');
  check('model changes after send cannot reroute the queued round',generated.request.videoGeneration.model==='MiniMax-H3'&&generated.job.video.backend==='minimax'&&generated.job.video.model==='MiniMax-H3');
  check('manual generation stops at video without extraction',generated.versions.length===1&&generated.versions[0].kind==='video'&&generated.request.reviewMode==='manual');
  // Exercise the real image adapter and all downstream local steps with a small
  // complete eight-direction set. Failed requests never trigger more billing.
  await config.saveConfig({imageProvider:'custom',customProtocol:'openai',customBaseUrl:base+'/v1',customApiKey:'fake-image-key',customModel:'mock-image'});
  const hdInput={module:'sprite',jobId:local.id,roundId:generated.id};
  editJobId=generated.childId;
  await gw('runWorkflowRoundStep',{...hdInput,step:'extract',ranges:chosen.map(range=>({...range,frameCount:2})),processing:{...processing,key:true}});
  let hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('local extraction is never presented as an AI version',hd.job.frames.length===32&&!hd.versions.some(v=>v.kind==='redraw')&&imagePosts===0);
  const rawBefore=hd.versions.find(v=>v.kind==='raw'),originalFrame=await readFile(motion.motionAssetPath(hd.childId,rawBefore.files[0]));
  const targets=hd.job.frames.map(f=>f.id);
  const ledgerBefore=await readFile(motion.motionAssetPath(hd.childId,'job.json'));
  const conversationBefore=JSON.stringify(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id}));
  const groupedPlan=await gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets,scheme:'sheet',planOnly:true});
  check('read-only redraw plan preserves wire fields and never groups across actions or directions',groupedPlan.frameCount===32&&groupedPlan.requestCount===16&&groupedPlan.scheme==='sheet');
  check('request planning needs no cost confirmation and changes no job, conversation or requests',imagePosts===0&&Buffer.compare(await readFile(motion.motionAssetPath(hd.childId,'job.json')),ledgerBefore)===0&&JSON.stringify(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id}))===conversationBefore);
  await assert.rejects(()=>gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets:targets.slice(0,2)}),/确认/);checks++;
  check('unconfirmed enhancement sends no image request',imagePosts===0);
  await assert.rejects(()=>gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets:['missing'],scheme:'sheet8',confirmed:true}),/Unknown frame/);checks++;
  check('host rejects invalid frame IDs before writing a paid attempt',imagePosts===0&&Buffer.compare(await readFile(motion.motionAssetPath(hd.childId,'job.json')),ledgerBefore)===0);
  imageFailAt=2;
  await gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets,confirmed:true});
  hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('a failed batch preserves a playable successful AI frame',hd.status==='error'&&hd.versions.filter(v=>v.kind==='redraw').at(-1)?.files.length===1&&hd.job.frames.filter(f=>f.redraw?.status==='unknown').length===1);
  const failedTiming=hd.timings.at(-1);
  check('a failed redraw closes its own timing',failedTiming.step==='redraw'&&failedTiming.status==='error'&&Number.isSafeInteger(failedTiming.endedAt)&&failedTiming.endedAt>=failedTiming.startedAt);
  check('partial AI output cannot produce an HD asset pack',imagePosts===2&&!hd.versions.some(v=>v.kind==='export'));
  await gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets,confirmed:true});
  hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('unknown results block automatic retries and duplicate AI versions',hd.status==='error'&&imagePosts===2&&hd.versions.filter(v=>v.kind==='redraw').length===1);
  await gw('runWorkflowRoundStep',{...hdInput,step:'export',useRedraw:true});
  hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('manual HD export also rejects incomplete frames',hd.status==='error'&&!hd.versions.some(v=>v.kind==='export')&&imagePosts===2);
  await gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets:targets.slice(1,25),confirmed:true,regenerate:true});
  hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('explicit retry enhances the chosen 24-frame scope',hd.status==='ready'&&imagePosts===26&&hd.versions.filter(v=>v.kind==='redraw').at(-1).files.length===24&&hd.versions.at(-1).sourceKind==='redraw');
  const recoveringFile=join(config.dataRoot(),'workflow-conversations','sprite-'+local.id+'.json');
  const recovering=JSON.parse(await readFile(recoveringFile,'utf8')),hdInterrupted=recovering.rounds.at(-1);
  hdInterrupted.status='running';hdInterrupted.stage='redraw';hdInterrupted.versions.pop();
  await writeFile(recoveringFile,JSON.stringify(recovering));chat.disposeWorkflowChat();chat.activateWorkflowChat();await chat.resumeWorkflowChats();
  hd=(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})).rounds.at(-1);
  check('restart recovers completed AI frames without replaying paid calls',hd.status==='error'&&hd.versions.filter(v=>v.kind==='redraw').at(-1).files.length===24&&imagePosts===26);
  await gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets,confirmed:true});
  hd=(await wait('sprite',local.id)).rounds.at(-1);assert.equal(hd.status,'ready',hd.error);
  check('confirmed remaining frames call images/edits and automatically export',imagePosts===33&&posts===3&&hd.versions.at(-1).kind==='export'&&hd.versions.at(-1).sourceKind==='redraw'&&hd.job.archiveKind==='redraw');
  check('actual image calls include the pose, character, matching appearance and mask',imageRequests.every(body=>(body.match(/name="image\[\]"/g)||[]).length===3&&body.includes('name="mask"')&&body.includes('1024x1024')));
  const hdOut=motion.motionAssetPath(hd.childId,hd.job.archive).replace(/sprites\.zip$/,'');
  const hdMeta=JSON.parse(await readFile(join(hdOut,'animation.json'),'utf8'));
  const hdVersion=hd.versions.filter(v=>v.kind==='redraw').at(-1);
  const hdPixels=await decodeToRgba(motion.motionAssetPath(hd.childId,hdVersion.files[0]));
  check('HD output is genuinely keyed, composed and labelled in metadata',hdPixels.rgba[3]===0&&hdMeta.mode==='redrawn'&&hdMeta.actions[0].sheets.length>0&&hdVersion.files.length===32);
  check('AI versions contain the actual returned image instead of the video crop',hdPixels.rgba[(256*512+256)*4]===210&&hdPixels.rgba[(256*512+256)*4+3]===255);
  const downloaded=unzip(await readFile(motion.motionAssetPath(hd.childId,hd.versions.at(-1).files[0])));
  check('downloaded HD ZIP includes all enhanced frames and matching timing metadata',JSON.parse(downloaded.get('animation.json')).mode==='redrawn'&&[...downloaded.keys()].filter(name=>/\/f\d+\.png$/.test(name)).length===32&&hdMeta.actions.every(action=>action.sheets.every(sheet=>downloaded.has(sheet.file))));
  check('AI output preserves the video frame version byte for byte',Buffer.compare(await readFile(motion.motionAssetPath(hd.childId,rawBefore.files[0])),originalFrame)===0);
  const fourTargets=hd.job.frames.filter(f=>f.action===hd.job.frames[0].action&&f.index===0).slice(0,4).map(f=>f.id);
  await gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets:fourTargets,confirmed:true});
  hd=(await wait('sprite',local.id)).rounds.at(-1);
  const fourVersion=hd.versions.filter(v=>v.kind==='redraw').at(-1),fourZip=unzip(await readFile(motion.motionAssetPath(hd.childId,hd.versions.at(-1).files[0]))),fourMeta=JSON.parse(fourZip.get('animation.json'));
  check('a completed four-frame scope exports without drawing extra frames',hd.status==='ready'&&fourVersion.files.length===4&&imagePosts===33&&[...fourZip.keys()].filter(name=>/\/f\d+\.png$/.test(name)).length===4);
  check('sampled versions keep full motion duration and actual source indices',fourVersion.ranges.every(range=>range.sampled)&&fourMeta.actions.length===1&&fourMeta.actions[0].sampled&&Object.values(fourMeta.actions[0].directionFrames).every(d=>d.frameCount===1&&d.sourceIndices.length===1&&d.fps===1/(fourMeta.actions[0].end-fourMeta.actions[0].start)));
  check('local video-frame packages record their actual source',lr.versions.filter(v=>v.kind==='export').at(-1).sourceKind==='keyed');
  const lastNumber=fourVersion.number,videoBeforeDelete=await readFile(motion.motionAssetPath(hd.childId,hd.job.video.file));
  await gw('deleteWorkflowVersion',{module:'sprite',jobId:local.id,roundId:hd.id,versionId:fourVersion.id,confirmed:true});
  hd=(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})).rounds.at(-1);
  check('a real paid HD snapshot can be deleted while its source video and earlier HD results remain',!hd.versions.some(v=>v.id===fourVersion.id)&&hd.versions.some(v=>v.kind==='redraw')&&Buffer.compare(videoBeforeDelete,await readFile(motion.motionAssetPath(hd.childId,hd.job.video.file)))===0);
  await gw('runWorkflowRoundStep',{...hdInput,step:'redraw',targets:fourTargets,confirmed:true});
  hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('a new snapshot continues numbering after a deleted latest version without repeating paid requests',hd.versions.filter(v=>v.kind==='redraw').at(-1).number===lastNumber+1&&imagePosts===33);
  const localInput={...hdInput,step:'process',ranges:hd.job.ranges,processing:{...motion.motionProcessing(hd.job.processing),sheet:true}};
  const videosBeforeProcessing=posts,imagesBeforeProcessing=imagePosts;
  let processPlan=await gw('runWorkflowRoundStep',{...localInput,planOnly:true});
  check('local processing recognizes that the latest HD pack needs a separate ordinary atlas',processPlan.kind==='local-processing'&&processPlan.steps.join(',')==='export');
  const targetsBeforeLocal=hd.job.frames.map(f=>f.target),keyedBeforeLocal=hd.job.frames.map(f=>f.keyed);
  await gw('runWorkflowRoundStep',localInput);hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('apply-only composition preserves source and keyed files and finishes the local queue',hd.status==='ready'&&!hd.localSteps&&hd.job.archiveKind==='keyed'&&JSON.stringify(hd.job.frames.map(f=>f.target))===JSON.stringify(targetsBeforeLocal)&&JSON.stringify(hd.job.frames.map(f=>f.keyed))===JSON.stringify(keyedBeforeLocal));
  processPlan=await gw('runWorkflowRoundStep',{...localInput,planOnly:true});
  check('completed local artifacts produce a no-op plan',processPlan.steps.length===0);
  const timingsBeforeNoop=hd.timings;
  await gw('runWorkflowRoundStep',localInput);hd=(await wait('sprite',local.id)).rounds.at(-1);
  assert.deepEqual(hd.timings,timingsBeforeNoop);
  check('applying a no-op plan does not claim a new timing',true);
  const changedProcessing={...localInput.processing,keyLow:localInput.processing.keyLow+1};
  processPlan=await gw('runWorkflowRoundStep',{...localInput,processing:changedProcessing,planOnly:true});
  check('a keying-only draft skips extraction',processPlan.steps.join(',')==='keyed,export');
  await gw('runWorkflowRoundStep',{...localInput,processing:changedProcessing});hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('apply queues actual keying then export as new immutable versions',hd.status==='ready'&&JSON.stringify(hd.job.frames.map(f=>f.target))===JSON.stringify(targetsBeforeLocal)&&JSON.stringify(hd.job.frames.map(f=>f.keyed))!==JSON.stringify(keyedBeforeLocal)&&hd.versions.at(-1).kind==='export'&&hd.versions.at(-2).kind==='keyed');
  const beforeBadDraft=JSON.stringify(await motion.readMotion(hd.childId));
  await assert.rejects(()=>gw('runWorkflowRoundStep',{...localInput,ranges:localInput.ranges.map((r,i)=>i===0?{...r,end:99}:r),processing:{...changedProcessing,cellWidth:64}}));
  check('invalid process drafts are rejected before mutating ranges or settings',JSON.stringify(await motion.readMotion(hd.childId))===beforeBadDraft);
  const newRanges=localInput.ranges.map(r=>({...r,targetFps:2,frameCount:Math.round((r.end-r.start)*2)}));
  processPlan=await gw('runWorkflowRoundStep',{...localInput,ranges:newRanges,processing:changedProcessing,planOnly:true});
  check('changing FPS plans extraction before downstream composition',processPlan.steps.join(',')==='extract,export');
  await gw('runWorkflowRoundStep',{...localInput,ranges:newRanges,processing:changedProcessing});hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('apply re-extracts the changed timing and runs through the final atlas',hd.status==='ready'&&!hd.localSteps&&hd.job.ranges.every(r=>r.targetFps===2)&&hd.job.frames.every(f=>!targetsBeforeLocal.includes(f.target))&&hd.versions.slice(-3).map(v=>v.kind).join(',')==='raw,keyed,export');
  const disabledSheet={...changedProcessing,sheet:false};
  await gw('runWorkflowRoundStep',{...localInput,ranges:newRanges,processing:disabledSheet});hd=(await wait('sprite',local.id)).rounds.at(-1);
  const beforeForced=hd.versions.length;
  await gw('runWorkflowRoundStep',{...localInput,ranges:newRanges,processing:disabledSheet,forceLocal:'keyed'});hd=(await wait('sprite',local.id)).rounds.at(-1);
  check('more re-key respects the disabled atlas option and adds just one version',hd.status==='ready'&&hd.versions.length===beforeForced+1&&hd.versions.at(-1).kind==='keyed');
  check('the entire local apply flow preserves the original video and makes zero paid requests',posts===videosBeforeProcessing&&imagePosts===imagesBeforeProcessing&&Buffer.compare(videoBeforeDelete,await readFile(motion.motionAssetPath(hd.childId,hd.job.video.file)))===0);
  // 1K redraw selects its own saved edit route; unrelated image generation may
  // keep using Ark. Exercise the real config gateway, wire and multipart API.
  const independentConfig=await gw('saveConfig',{customConnection:{op:'create',values:{name:'Independent 1K edit fixture',enabled:true,customProtocol:'openai',customBaseUrl:base+'/v1',customModel:'mock-1k-independent',customApiKey:'fake-1k-only'}}});
  const independentConnection=independentConfig.customImageConnections.find(entry=>entry.name==='Independent 1K edit fixture');
  assert.ok(independentConnection,'the independent image connection must be persisted');
  const independentSelection={connectionId:independentConnection.id,model:'mock-1k-independent'};
  await gw('saveConfig',{imageProvider:'ark',motionRedrawSelection:independentSelection});
  const publicImageConfig=await gw('getConfig');
  check('getConfig exposes independent 1K choices without changing the global Ark route',publicImageConfig.imageProvider==='ark'&&publicImageConfig.motionRedrawModels.some(model=>model.connectionId===independentSelection.connectionId&&model.model===independentSelection.model)&&publicImageConfig.motionRedrawModel.connectionId===independentSelection.connectionId&&publicImageConfig.motionRedrawModel.model===independentSelection.model);
  const oneKFrame=hd.job.frames[0].id,oneKInput={...hdInput,step:'redraw',targets:[oneKFrame],scheme:'frame',image1k:true};
  const beforeOneKJob=await readFile(motion.motionAssetPath(hd.childId,'job.json'));
  const beforeOneKConversation=JSON.stringify(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id}));
  const beforeOneKImages=imagePosts,beforeOneKVideos=posts;
  const oneKPlan=await gw('runWorkflowRoundStep',{...oneKInput,planOnly:true});
  check('a 1K single-frame plan exposes the independent model and no blocker under global Ark',oneKPlan.image1k===true&&oneKPlan.requestCount===1&&oneKPlan.frameCount===1&&oneKPlan.scheme==='frame'&&oneKPlan.blocker===null&&oneKPlan.modelSelection.connectionId===independentSelection.connectionId&&oneKPlan.modelSelection.model===independentSelection.model);
  check('independent 1K planning is read-only and sends no image or video request',imagePosts===beforeOneKImages&&posts===beforeOneKVideos&&Buffer.compare(beforeOneKJob,await readFile(motion.motionAssetPath(hd.childId,'job.json')))===0&&beforeOneKConversation===JSON.stringify(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})));
  await assert.rejects(()=>gw('runWorkflowRoundStep',{...oneKInput,confirmed:true,expectedImageModel:{...independentSelection,model:'wrong-confirmed-model'}}),/模型|model/i);checks++;
  check('a changed confirmed 1K route is rejected before mutating the job or making a paid request',imagePosts===beforeOneKImages&&posts===beforeOneKVideos&&Buffer.compare(beforeOneKJob,await readFile(motion.motionAssetPath(hd.childId,'job.json')))===0&&beforeOneKConversation===JSON.stringify(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})));
  await gw('runWorkflowRoundStep',{...oneKInput,confirmed:true,expectedImageModel:independentSelection});
  hd=(await wait('sprite',local.id)).rounds.at(-1);
  const independentResult=hd.job.frames.find(frame=>frame.id===oneKFrame);
  check('confirmed 1K work uses the independent images/edits model while global image generation stays Ark',hd.status==='ready'&&imagePosts===beforeOneKImages+1&&posts===beforeOneKVideos&&imageRequestModels.at(-1).model===independentSelection.model&&imageRequestModels.at(-1).size==='1024x1024'&&independentResult.redraw?.status==='ready'&&independentResult.redraw.image1k===true&&(await gw('getConfig')).imageProvider==='ark');
  const independentVersion=hd.versions.filter(version=>version.kind==='redraw').at(-1);
  check('the 1K round creates one real output version and preserves its source pixels',independentVersion.files.length===1&&independentVersion.frames[0].id===oneKFrame&&independentVersion.frames[0].image1k===true&&Buffer.compare(await readFile(motion.motionAssetPath(hd.childId,rawBefore.files[0])),originalFrame)===0);
  await gw('saveConfig',{customConnection:{op:'update',id:independentConnection.id,values:{enabled:false}}});
  const disabledInput={...oneKInput,targets:[hd.job.frames[1].id]};
  const disabledJob=await readFile(motion.motionAssetPath(hd.childId,'job.json'));
  const disabledConversation=JSON.stringify(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id}));
  const disabledImages=imagePosts;
  const disabledPlan=await gw('runWorkflowRoundStep',{...disabledInput,planOnly:true});
  check('a disabled independent edit connection is visible as a blocker without a paid attempt',typeof disabledPlan.blocker==='string'&&disabledPlan.blocker.length>0&&imagePosts===disabledImages&&Buffer.compare(disabledJob,await readFile(motion.motionAssetPath(hd.childId,'job.json')))===0);
  await assert.rejects(()=>gw('runWorkflowRoundStep',{...disabledInput,confirmed:true,expectedImageModel:independentSelection}),/停用|禁用|不可用|连接|模型/);checks++;
  check('disabled 1K execution fails before any request or saved frame attempt',imagePosts===disabledImages&&posts===beforeOneKVideos&&Buffer.compare(disabledJob,await readFile(motion.motionAssetPath(hd.childId,'job.json')))===0&&disabledConversation===JSON.stringify(await gw('getWorkflowConversation',{module:'sprite',jobId:local.id})));
  const children=c.rounds.map(r=>r.childId);await gw('deleteSequenceJob',{jobId:parent.id});
  check('deleting a conversation cleans its owned round jobs',(await Promise.all(children.map(id=>seq.readSequenceJob(id)))).every(v=>!v));
  console.log(`Passed ${checks} workflow chat checks. Mock requests only.`);
} finally {
  chat.disposeWorkflowChat();motion.disposeMotion();seq.disposeSequence();globalThis.fetch=originalFetch;
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
