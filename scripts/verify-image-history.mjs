/** Real gateway, isolated storage and loopback-only image API. No real credentials or billing. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
const home=await mkdtemp(join(tmpdir(),'gmm-image-history-'));process.env.DSH_HOME=home;
const {Context}=await import('@deepseek-ai/cordis');
const plugin=await import('../lib/index.js'),wire=await import('../lib/wire.js');
const imagegen=await import('../lib/imagegen.js');
const {saveConfig,loadConfig}=await import('../lib/config.js');
const {encodePng}=await import('../lib/png.js');
const ctx=new Context();
for(const name of ['typert','webServer','tools'])ctx.provide(name,{register:()=>()=>{}});
ctx.provide('systemPrompt',{section:()=>()=>{}});plugin.apply(ctx);const gateway=ctx.get('gameStudio');
const invoke=async(method,payload)=>{
 const spec=wire.METHODS.find(m=>m.method===method);assert.ok(spec,method);
 const parsed=spec.payload.parse(payload);assert.deepEqual(parsed,payload,'wire must preserve fields');
 return spec.result.parse(await gateway[method](parsed));
};
const calls=[];let hold=false,fail=false;const releases=[];
const server=createServer(async(req,res)=>{
 try{
  assert.ok(['/images/edits','/images/generations'].includes(req.url));
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
  const form=req.url==='/images/edits'?await new Request('http://127.0.0.1/images/edits',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:bytes}).formData():null;
  const body=form?{prompt:String(form.get('prompt')).replace(/\r\n/g,'\n'),model:form.get('model'),size:form.get('size'),images:await Promise.all([...form.getAll('image'),...form.getAll('image[]')].map(async f=>Buffer.from(await f.arrayBuffer()).toString('base64')))}:JSON.parse(bytes);
  const serial=calls.length+1;calls.push(body);if(hold)await new Promise(resolve=>releases.push(resolve));
  if(fail){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic generation failure'}}));return;}
  const pixels=Buffer.alloc(32*32*4);for(let y=0;y<32;y++)for(let x=0;x<32;x++){
   const p=(y*32+x)*4,subject=x>9&&x<22&&y>5&&y<27;
   pixels[p]=subject?100+serial:0;pixels[p+1]=subject?60:0;pixels[p+2]=subject?20:255;pixels[p+3]=255;
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{b64_json:encodePng(pixels,32,32).toString('base64')}]}));
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{assert.equal(new URL(url instanceof Request?url.url:url).origin,origin,'Only loopback fake API is allowed');return originalFetch(url,options);};
let checks=0;const check=(name,value)=>{assert.ok(value,name);checks++;console.log('✓ '+name);};
const waitFor=async(test)=>{const deadline=Date.now()+15000;while(!await test()){if(Date.now()>deadline)throw Error('local task timeout');await new Promise(r=>setTimeout(r,20));}};
const settled=async id=>{await waitFor(async()=>!(await invoke('getImageJob',{jobId:id})).tasks.length);return imagegen.readImageJob(id);};
const exists=async path=>stat(path).then(()=>true,()=>false);
try{
 await saveConfig({imageProvider:'custom',customProtocol:'openai',customBaseUrl:origin,customApiKey:'fake-local-key-never-in-history',customModel:'fake-original',customSize:'1024x1024',keyColor:'#0000FF'});
 const {jobId}=await invoke('createImageJob',{name:'history fixture',promptTemplate:'character',lang:'zh'});
 const ref=encodePng(Buffer.from([220,40,30,255]),1,1).toString('base64');
 await invoke('uploadImageRef',{jobId,name:'synthetic.png',data:ref});
 await invoke('saveImageJob',{jobId,prompt:'蓝色法师，参考@图片1',settings:{count:2,sizeMode:'custom',size:'1024x1536'},keying:{enabled:true,keyColor:'#0000FF'}});
 const authored=await imagegen.readImageJob(jobId);hold=true;
 const start=await invoke('runImageJob',{jobId});await waitFor(()=>calls.length===2);
 check('two images start as one batch',start.started&&releases.length===2);
 await assert.rejects(invoke('runImageJob',{jobId}),/正在处理/);
 await assert.rejects(invoke('deleteImageJob',{jobId}),/正在处理/);
 await assert.rejects(invoke('removeImageItem',{jobId,index:0}),/正在处理/);
 await Promise.all([
  invoke('saveImageJob',{jobId,prompt:'用户正在改的新草稿',settings:{size:'1536x1024'},keying:{keyColor:'#00FF00'}}),
  invoke('setReviewMode',{id:jobId,module:'image',reviewMode:'manual'})
 ]);
 await saveConfig({customModel:'fake-new-model',customSize:'2048x2048'});
 hold=false;releases.splice(0).forEach(release=>release());const first=await settled(jobId);
 check('concurrent completions retain both independent versions',first.history.length===2&&new Set(first.history.map(e=>e.item.file)).size===2&&first.items.every(i=>i.status==='ready'));
 check('batch ids match and snapshots retain submitted prompt/model/size/key color',new Set(first.history.map(e=>e.batchId)).size===1&&first.history.every(e=>e.request.prompt===authored.prompt&&e.request.settings.model==='fake-original'&&e.request.settings.size==='1024x1536'&&e.request.keying.keyColor==='#0000FF'));
 check('actual requests match immutable snapshots',calls.every(c=>c.prompt===first.history[0].request.finalPrompt&&c.model==='fake-original'&&c.size==='1024x1536'&&c.images[0]===ref));
 check('draft and review-mode edits survive generation completion',first.prompt==='用户正在改的新草稿'&&first.settings.size==='1536x1024'&&first.keying.keyColor==='#00FF00'&&first.reviewMode==='manual');
 check('saved job/history contain no provider credential',!(await readFile(join(imagegen.imageJobDir(jobId),'job.json'),'utf8')).includes('fake-local-key-never-in-history'));
 const old=first.history.find(e=>e.item.index===1),oldBytes=await readFile(imagegen.imageAssetPath(jobId,old.item.file)),oldKeyed=await readFile(imagegen.imageAssetPath(jobId,old.item.keyedFile));
 const beforeSingle=calls.length;await invoke('runImageJob',{jobId,index:1});const second=await settled(jobId);
 check('regenerating index 1 makes exactly one request, leaving index 0 intact',calls.length===beforeSingle+1&&second.items[0].versionId===first.items[0].versionId&&second.items[1].versionId!==old.id);
 check('a later explicit generation uses the current global model',calls.at(-1).model==='fake-new-model'&&second.history.at(-1).request.settings.model==='fake-new-model');
 check('new generation preserves previous bytes and uses a new batch',second.history.length===3&&second.history.at(-1).batchId!==old.batchId&&(await readFile(imagegen.imageAssetPath(jobId,old.item.file))).equals(oldBytes)&&(await readFile(imagegen.imageAssetPath(jobId,old.item.keyedFile))).equals(oldKeyed));
 await assert.rejects(invoke('runImageJob',{jobId,index:1,count:2}),/不能同时/);
 await assert.rejects(invoke('runImageJob',{jobId,index:50}),/不存在/);
 check('invalid regeneration payloads submit zero requests',calls.length===beforeSingle+1);
 fail=true;await invoke('runImageJob',{jobId,index:1});const failed=await settled(jobId);fail=false;
 check('generation failure keeps previous version and never retries',calls.length===beforeSingle+2&&failed.history.length===3&&failed.items[1].status==='error'&&failed.items[1].file===second.items[1].file);
 const localStart=calls.length;
 await invoke('manageImageHistory',{jobId,historyId:old.id,action:'restore'});
 const restored=await imagegen.readImageJob(jobId);check('restore selects historical original and keyed version',restored.items[1].versionId===old.id&&restored.items[1].keyedFile===old.item.keyedFile);
 await invoke('removeImageRef',{jobId,file:authored.refs[0].file});check('removing a draft reference retains historical reference bytes',await exists(imagegen.imageAssetPath(jobId,authored.refs[0].file)));
 await invoke('manageImageHistory',{jobId,historyId:old.id,action:'reuse'});const reused=await imagegen.readImageJob(jobId);
 check('reuse restores text, template, refs, keying and custom size without changing global provider',reused.prompt===authored.prompt&&reused.suffix===authored.suffix&&reused.promptTemplateId===authored.promptTemplateId&&reused.refs[0].file===authored.refs[0].file&&reused.settings.sizeMode==='custom'&&reused.settings.size==='1024x1536'&&reused.keying.keyColor==='#0000FF');
 check('parameter reuse leaves global credentials and model unchanged',(await loadConfig()).customModel==='fake-new-model'&&(await loadConfig()).customApiKey==='fake-local-key-never-in-history');
 await invoke('saveImageJob',{jobId,keying:{despill:0.2}});
 await invoke('keyImageJob',{jobId});const keyed=await settled(jobId);
 check('local re-key creates new history versions without overwriting prior transparency',keyed.history.length===5&&keyed.history.slice(-2).every(e=>e.kind==='keyed')&&keyed.items[1].keyedFile!==old.item.keyedFile&&(await readFile(imagegen.imageAssetPath(jobId,old.item.keyedFile))).equals(oldKeyed));
 check('local keying settings stay separate from the unmodified generation snapshot',keyed.history.at(-1).keying.despill===0.2&&keyed.history.at(-1).request.keying.despill===old.request.keying.despill&&keyed.history.at(-1).request.finalPrompt===old.request.finalPrompt);
 const current=keyed.history.at(-1);await invoke('manageImageHistory',{jobId,historyId:current.id,action:'delete'});
 check('deleting history retains files used by current results',await exists(imagegen.imageAssetPath(jobId,current.item.keyedFile)));
 await invoke('removeImageItem',{jobId,index:1});check('removing a current result deletes only unreferenced bytes',!await exists(imagegen.imageAssetPath(jobId,current.item.keyedFile))&&await exists(imagegen.imageAssetPath(jobId,old.item.file)));
 await invoke('manageImageHistory',{jobId,historyId:old.id,action:'restore'});await invoke('removeImageItem',{jobId,index:1});
 check('removing a restored current result retains its archived bytes',await exists(imagegen.imageAssetPath(jobId,old.item.keyedFile)));
 await invoke('manageImageHistory',{jobId,historyId:old.id,action:'delete'});
 check('deleting the last reference removes its independent image files',!await exists(imagegen.imageAssetPath(jobId,old.item.file))&&!await exists(imagegen.imageAssetPath(jobId,old.item.keyedFile)));
 const uploaded=await imagegen.addImageToJob(jobId,'synthetic-upload.png',ref);const afterUpload=await imagegen.readImageJob(jobId);
 check('uploaded images are archived as local uploads',afterUpload.history.at(-1).kind==='uploaded'&&afterUpload.history.at(-1).id===uploaded.versionId);
 await assert.rejects(invoke('manageImageHistory',{jobId,historyId:uploaded.versionId,action:'reuse'}),/没有保存生成参数/);
 await assert.rejects(invoke('manageImageHistory',{jobId,historyId:'missing',action:'restore'}),/不存在/);
 check('all history, upload, restore, delete, re-key and reuse operations are free',calls.length===localStart);
 const reload=await import('../lib/imagegen.js?fresh-history-test');check('history persists across module reload',JSON.stringify((await reload.readImageJob(jobId)).history)===JSON.stringify(afterUpload.history));
 const legacy=await imagegen.createImageJob('legacy fixture');const legacyPath='out/img-00.png';await writeFile(imagegen.imageAssetPath(legacy.id,legacyPath),Buffer.from(ref,'base64'));
 legacy.items=[{index:0,status:'ready',source:'generated',file:legacyPath,updatedAt:123}];delete legacy.history;
 await imagegen.writeImageJob(legacy);const migrated=await imagegen.readImageJob(legacy.id);
 check('legacy files are visible without inventing historical prompts',migrated.history.length===1&&migrated.history[0].kind==='legacy'&&migrated.history[0].createdAt===123&&!migrated.history[0].request&&migrated.items[0].versionId===migrated.history[0].id);
 await assert.rejects(invoke('manageImageHistory',{jobId:legacy.id,historyId:migrated.history[0].id,action:'reuse'}),/没有保存生成参数/);
 await invoke('manageImageHistory',{jobId:legacy.id,historyId:migrated.history[0].id,action:'restore'});
 check('legacy retention is persisted on next write',JSON.parse(await readFile(join(imagegen.imageJobDir(legacy.id),'job.json'),'utf8')).history[0].kind==='legacy');
 const fixed=await imagegen.createImageJob('sequential batch fixture');await imagegen.editImageJob(fixed.id,job=>{job.prompt='fixed batch prompt';});
 const prepared=await imagegen.prepareImageBatch(fixed.id,2),fixedStart=calls.length;
 await imagegen.generateImageItem(fixed.id,0,prepared);await saveConfig({customModel:'later-global-model'});
 await imagegen.editImageJob(fixed.id,job=>{job.prompt='later draft';});await imagegen.generateImageItem(fixed.id,1,prepared);
 const pinned=await imagegen.readImageJob(fixed.id);
 check('later requests within the same batch keep the prepared provider configuration',calls.length===fixedStart+2&&calls.slice(fixedStart).every(c=>c.model==='fake-new-model'&&c.prompt==='fixed batch prompt')&&pinned.history.every(e=>e.batchId===prepared.id&&e.request.prompt==='fixed batch prompt'));
 await invoke('deleteImageJob',{jobId});check('deleting a task removes its entire local history directory',!await exists(imagegen.imageJobDir(jobId)));
 console.log(`Passed ${checks} image history checks. Loopback API only, no real billing.`);
}finally{
 releases.splice(0).forEach(release=>release());await new Promise(resolve=>server.close(resolve));globalThis.fetch=originalFetch;
 const target=resolve(home);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('gmm-image-history-'));await rm(target,{recursive:true,force:true});
}
