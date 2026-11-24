/** Delete real immutable snapshots through wire/gateway in temporary storage. No generation. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const home=await mkdtemp(join(tmpdir(),'gmm-version-delete-'));
process.env.DSH_HOME=home;
const {Context}=await import('@deepseek-ai/cordis');
const motion=await import('../lib/motiongen.js'),seq=await import('../lib/seqgen.js');
const chat=await import('../lib/workflowchat.js'),wire=await import('../lib/wire.js');
const {dataRoot}=await import('../lib/config.js'),{writeJsonAtomic}=await import('../lib/jsonio.js');
const {encodePng}=await import('../lib/png.js'),plugin=await import('../lib/index.js');
const ctx=new Context();ctx.provide('typert',{register:()=>()=>{}});ctx.provide('webServer',{register:()=>()=>{}});
plugin.apply(ctx);const gateway=ctx.get('gameStudio');
let checks=0,network=0;const originalFetch=globalThis.fetch;
globalThis.fetch=()=>{network++;throw Error('No network is permitted');};
const check=(name,ok)=>{assert.ok(ok,name);checks++;console.log('✓ '+name);};
const exists=async file=>readFile(file).then(()=>true,()=>false);
const gw=async(method,payload)=>{const spec=wire.METHODS.find(s=>s.method===method);assert.ok(spec,method);const parsed=spec.payload.parse(payload);assert.deepEqual(parsed,payload);return gateway[method](parsed);};
const png=encodePng(Buffer.alloc(16*16*4,255),16,16),video=Buffer.from('generated-video-must-remain-byte-identical');
try{
  check('version deletion is client-only and requires explicit confirmation',wire.METHODS.find(s=>s.method==='deleteWorkflowVersion').clientOnly===true);
  for(const module of ['sprite','sequence']){
    const create=module==='sprite'?motion.createMotionJob:seq.createSequenceJob;
    const path=module==='sprite'?motion.motionAssetPath:seq.sequenceAssetPath;
    const parent=await create('Delete fixture'),child=await create('Owned child');
    child.workflowParent=parent.id;
    child.video={status:'ready',file:'videos/generated.mp4'};
    if(module==='sprite')child.frames=[{id:'walk-front-0',action:'walk',direction:'front',index:0,target:'frames/source.png',keyed:'frames/source.png'}];
    else child.frames={status:'ready',files:['frames/source.png'],keyed:['frames/source.png']};
    await mkdir(dirname(path(child.id,'videos/generated.mp4')),{recursive:true});
    await mkdir(dirname(path(child.id,'frames/source.png')),{recursive:true});
    await writeFile(path(child.id,'videos/generated.mp4'),video);await writeFile(path(child.id,'frames/source.png'),png);
    await writeJsonAtomic(path(child.id,'job.json'),child);
    const r={id:randomUUID(),childId:child.id,requestId:'fixture',createdAt:1,prompt:'',automatic:false,localOnly:false,status:'ready',stage:'done',versions:[]};
    for(const kind of ['video','raw','raw','raw','keyed','redraw','export']){
      const id=randomUUID(),file=`out/versions/${id}/0-result.${kind==='video'?'mp4':kind==='export'?'zip':'png'}`;
      await mkdir(dirname(path(child.id,file)),{recursive:true});await writeFile(path(child.id,file),kind==='video'?video:png);
      r.versions.push({id,kind,files:[file],createdAt:1});
    }
    const manifest=join(dataRoot(),'workflow-conversations',`${module}-${parent.id}.json`);
    const c={module,jobId:parent.id,rounds:[r]};await writeJsonAtomic(manifest,c);
    const parentBytes=await readFile(path(parent.id,'job.json')),childBytes=await readFile(path(child.id,'job.json'));
    const input={module,jobId:parent.id,roundId:r.id,versionId:r.versions[2].id,confirmed:true};
    const before=await readFile(manifest);
    for(const patch of [{confirmed:false},{confirmed:undefined},{versionId:'../videos/generated.mp4'}])await assert.rejects(()=>gw('deleteWorkflowVersion',{...input,...patch}));
    await assert.rejects(()=>chat.deleteWorkflowVersion({...input,confirmed:false}),/确认/);
    await assert.rejects(()=>gw('deleteWorkflowVersion',{...input,roundId:randomUUID()}),/Round not found/);
    await assert.rejects(()=>gw('deleteWorkflowVersion',{...input,versionId:r.versions[0].id}),/视频不允许删除/);
    await assert.rejects(()=>gw('deleteWorkflowVersion',{...input,versionId:r.versions.at(-1).id}),/只能删除/);
    check(module+': invalid IDs, missing confirmation, video and export deletion leave the manifest unchanged',Buffer.compare(before,await readFile(manifest))===0);
    r.status='running';await writeJsonAtomic(manifest,c);
    await assert.rejects(()=>gw('deleteWorkflowVersion',input),/等待/);r.status='ready';await writeJsonAtomic(manifest,c);
    check(module+': active rounds block deletion',await exists(path(child.id,r.versions[2].files[0])));
    const unsafe=r.versions[2],original=unsafe.files[0];unsafe.files=['videos/generated.mp4'];await writeJsonAtomic(manifest,c);
    await assert.rejects(()=>gw('deleteWorkflowVersion',input),/Invalid version files/);
    unsafe.files=[original];r.versions[1].files.push(original);await writeJsonAtomic(manifest,c);
    await assert.rejects(()=>gw('deleteWorkflowVersion',input),/shared/);r.versions[1].files.pop();await writeJsonAtomic(manifest,c);
    check(module+': corrupted or shared snapshot paths cannot delete another result',await exists(path(child.id,original))&&Buffer.compare(video,await readFile(path(child.id,child.video.file)))===0);
    const wrongParent=await create('Unrelated parent');await writeJsonAtomic(join(dataRoot(),'workflow-conversations',`${module}-${wrongParent.id}.json`),{...c,jobId:wrongParent.id});
    await assert.rejects(()=>gw('deleteWorkflowVersion',{...input,jobId:wrongParent.id}),/Invalid workflow child/);
    await gw('deleteWorkflowVersion',input);
    let view=(await gw('getWorkflowConversation',{module,jobId:parent.id})).rounds[0];
    check(module+': deleting the selected version removes its manifest entry and actual PNG directory',!view.versions.some(v=>v.id===input.versionId)&&!await exists(path(child.id,original))&&!(await readdir(path(child.id,'out/versions'))).includes(input.versionId));
    check(module+': surviving versions retain their original v1 and v3 numbers',view.versions.filter(v=>v.kind==='raw').map(v=>v.number).join(',')==='1,3'&&view.versionCounters.raw===3);
    check(module+': sources, working job, parent draft, generated and snapshot videos remain byte-identical',Buffer.compare(childBytes,await readFile(path(child.id,'job.json')))===0&&Buffer.compare(parentBytes,await readFile(path(parent.id,'job.json')))===0&&Buffer.compare(video,await readFile(path(child.id,child.video.file)))===0&&Buffer.compare(video,await readFile(path(child.id,r.versions[0].files[0])))===0&&Buffer.compare(png,await readFile(path(child.id,'frames/source.png')))===0);
    check(module+': removed snapshots lose transfer ownership and other versions keep it',!await chat.workflowOwnsFile(module,child.id,original)&&await chat.workflowOwnsFile(module,child.id,r.versions[1].files[0]));
    const first=view.versions.find(v=>v.kind==='raw');
    const concurrent=await Promise.allSettled([gw('deleteWorkflowVersion',{...input,versionId:first.id}),gw('deleteWorkflowVersion',{...input,versionId:first.id})]);
    check(module+': simultaneous deletions commit once and cannot race the manifest',concurrent.filter(r=>r.status==='fulfilled').length===1);
    view=(await gw('getWorkflowConversation',{module,jobId:parent.id})).rounds[0];
    for(const v of view.versions.filter(v=>['raw','keyed','redraw'].includes(v.kind)))await gw('deleteWorkflowVersion',{...input,versionId:v.id});
    view=(await gw('getWorkflowConversation',{module,jobId:parent.id})).rounds[0];
    check(module+': all frame versions can be deleted while video and export remain after a fresh disk read',view.versions.map(v=>v.kind).join(',')==='video,export'&&view.versionCounters.redraw===1&&Buffer.compare(video,await readFile(path(child.id,child.video.file)))===0);
    // A reparse point must not make a version deletion escape its owned job.
    const linkedId=randomUUID(),outside=join(home,'outside-'+module);await mkdir(outside);await writeFile(join(outside,'0-result.png'),png);
    const linked=path(child.id,'out/versions/'+linkedId);await symlink(outside,linked,'junction');
    const persisted=JSON.parse(await readFile(manifest,'utf8'));persisted.rounds[0].versions.push({id:linkedId,kind:'raw',files:[`out/versions/${linkedId}/0-result.png`],createdAt:2});await writeJsonAtomic(manifest,persisted);
    await assert.rejects(()=>gw('deleteWorkflowVersion',{...input,versionId:linkedId}),/Invalid version directory/);
    check(module+': linked directories cannot remove files outside the child job',await exists(join(outside,'0-result.png')));
    // Locked-file quarantine is retried on restart without touching active versions.
    const deleted=path(child.id,`out/versions/.deleted-${randomUUID()}-${randomUUID()}`);await mkdir(deleted);await writeFile(join(deleted,'0-result.png'),png);
    await chat.resumeWorkflowChats();
    check(module+': restart cleans committed deletion quarantine without touching videos',!await exists(join(deleted,'0-result.png'))&&await exists(path(child.id,r.versions[0].files[0])));
    await rm(linked,{force:true,recursive:true});
  }
  check('no generation, optimization or external requests were made',network===0);
  console.log(`${checks} version deletion checks passed; temporary data only.`);
}finally{chat.disposeWorkflowChat();motion.disposeMotion();seq.disposeSequence();globalThis.fetch=originalFetch;await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:150});}
