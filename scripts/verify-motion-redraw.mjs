/** Real grouped image edits and splitting, with temporary storage and loopback API only. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const home=await mkdtemp(join(tmpdir(),'gmm-grouped-redraw-'));
process.env.DSH_HOME=home;
const motion=await import('../lib/motiongen.js');
const config=await import('../lib/config.js');
const {encodePng}=await import('../lib/png.js');
const {decodeToRgba}=await import('../lib/media.js');
const wire=await import('../lib/wire.js');
let checks=0;
const check=(name,ok)=>{assert.ok(ok,name);checks++;console.log('✓ '+name);};
const colors=[[60,100,180],[180,110,60],[60,170,100],[170,60,110],[40,130,180],[180,150,40],[140,100,190],[100,160,160]];
function fixture(edge,side=1,blank=-1,rows=side,mode='normal'){
  const height=edge/side*rows,rgba=Buffer.alloc(edge*height*4);if(mode!=='alpha')rgba.fill(Buffer.from([255,0,255,255]));
  const cell=edge/side;
  for(let i=0;i<side*rows;i++)if(i!==blank){
    const scale=mode==='large'?1.15:mode==='drift'&&i===0?1.3:1;
    for(let y=Math.ceil(cell*(.55-.35*scale));y<cell*(.55+.35*scale);y++)for(let x=Math.ceil(cell*(.5-.15*scale));x<cell*(.5+.15*scale);x++){
    const px=Math.floor(x)+(i%side)*cell,py=Math.floor(y)+Math.floor(i/side)*cell;
    rgba.set([...(mode==='alpha'&&y>cell*.6?[20,20,20]:colors[i]),255],(py*edge+px)*4);
    }
  }
  return encodePng(rgba,edge,height);
}
const sheet=fixture(2048,2),sheet8=fixture(4096,4,-1,2),single=fixture(1024),target=fixture(512);
const requests=[];let failAt=0,malformed=false,blankCell=false,replyMode='normal';
const server=createServer(async(req,res)=>{
  try{
    assert.equal(req.url,'/v1/images/edits');assert.equal(req.method,'POST');
    const chunks=[];for await(const c of req)chunks.push(c);
    const form=await new Response(Buffer.concat(chunks),{headers:{'Content-Type':req.headers['content-type']}}).formData();
    const images=await Promise.all(form.getAll('image[]').map(async f=>Buffer.from(await f.arrayBuffer())));
    const mask=Buffer.from(await form.get('mask').arrayBuffer());
    requests.push({size:form.get('size'),quality:form.get('quality'),prompt:form.get('prompt'),images,mask});
    res.setHeader('Content-Type','application/json');
    if(failAt===requests.length){res.writeHead(502);res.end('{"error":"fake-image-key interrupted"}');return;}
    const bytes=replyMode!=='normal'?fixture(4096,4,-1,2,replyMode):malformed?fixture(512):blankCell?fixture(2048,2,2):form.get('size')==='4096x2048'?sheet8:form.get('size')==='2048x2048'?sheet:single;
    res.end(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,originalFetch=globalThis.fetch;
globalThis.fetch=(url,...args)=>{assert.equal(new URL(String(url)).origin,origin,'external request prohibited');return originalFetch(url,...args);};
const frames=(action,direction,n)=>Array.from({length:n},(_,index)=>({id:`${action}-${direction}-${index}`,action,direction,index,time:index/24,target:'frames/target.png',keyed:'frames/target.png'}));
const persist=job=>writeFile(motion.motionAssetPath(job.id,'job.json'),JSON.stringify(job));
async function execute(id,extra){
  const payload={jobId:id,step:'redraw',...extra};
  assert.deepEqual(wire.METHODS.find(m=>m.method==='runMotionStep').payload.parse(payload),payload,'wire must preserve scheme');
  await motion.runMotionStep(id,payload);
  const until=Date.now()+60000;
  while(Date.now()<until){const view=await motion.motionView(id);if(!view.active)return motion.readMotion(id);await new Promise(resolve=>setTimeout(resolve,20));}
  throw Error('redraw timed out');
}
try{
  const large={frames:motion.MOTION_ORDER.flatMap(d=>[...frames('walk',d,48),...frames('run',d,41)])};
  const ids=large.frames.map(f=>f.id),grouped=motion.motionRedrawPlan(large,ids,'sheet'),perFrame=motion.motionRedrawPlan(large,ids,'frame');
  check('712 actual frames need 184 grouped edits or 712 per-frame edits',grouped.frameCount===712&&grouped.requestCount===184&&perFrame.requestCount===712);
  const eightPlan=motion.motionRedrawPlan(large,ids,'sheet8');
  check('eight-frame grouping needs 96 requests for the same 712 frames',eightPlan.frameCount===712&&eightPlan.requestCount===96&&eightPlan.groups.every(g=>g.length<=8));
  check('24 contiguous frames need six four-frame or three eight-frame requests',motion.motionRedrawPlan(large,ids.slice(0,24),'sheet').requestCount===6&&motion.motionRedrawPlan(large,ids.slice(0,24),'sheet8').requestCount===3);
  check('all groups preserve consecutive order within one action and direction',grouped.groups.every(g=>g.length<=4&&g.every((id,i)=>{const a=large.frames.find(f=>f.id===g[0]),b=large.frames.find(f=>f.id===id);return a.action===b.action&&a.direction===b.direction&&b.index===a.index+i;})));
  const selected=[ids[7],ids[0],ids[1],ids[3]],custom=motion.motionRedrawPlan(large,selected,'sheet');
  check('sampled custom selections stay grouped in time order',JSON.stringify(custom.groups)===JSON.stringify([[ids[0],ids[1],ids[3],ids[7]]]));
  for(const targets of [[ids[0],ids[0]],['missing'],[]])assert.throws(()=>motion.motionRedrawPlan(large,targets,'sheet'));
  check('invalid and duplicated selections are rejected before image requests',requests.length===0);
  await config.saveConfig({imageProvider:'custom',customProtocol:'openai',customBaseUrl:origin+'/v1',customModel:'fake-edit',customApiKey:'fake-image-key'});
  let job=await motion.createMotionJob('Grouped redraw fixture');
  await motion.uploadMotionAsset(job.id,'character',target.toString('base64'));
  await motion.uploadMotionAsset(job.id,'directions',fixture(1024,2).toString('base64'));
  job=await motion.readMotion(job.id);
  await writeFile(motion.motionAssetPath(job.id,'frames/target.png'),target);
  job.frames=[...frames('walk','front',24),...frames('run','right',8)];await persist(job);
  const targets=job.frames.map(f=>f.id);
  const rangePayload={jobId:job.id,validFrameRanges:{'walk::front':{start:1,end:19}}};
  assert.deepEqual(wire.METHODS.find(m=>m.method==='saveMotionJob').payload.parse(rangePayload),rangePayload);
  await motion.saveMotionJob(job.id,rangePayload);job=await motion.readMotion(job.id);
  check('start and end source indexes survive wire and real child-job persistence',job.validFrameRanges['walk::front'].start===1&&job.validFrameRanges['walk::front'].end===19);
  const validPlan=motion.motionRedrawPlan(job,targets,'sheet');
  check('invalid boundary frames do not count as selected frames or paid requests',validPlan.selectionCount===27&&validPlan.frameCount===27&&validPlan.requestCount===7&&!validPlan.targets.includes(targets[0])&&!validPlan.targets.includes(targets[23]));
  const validExport=motion.motionRedrawFrames({...job,redrawTargets:targets});
  check('narrowing a previously enhanced selection filters invalid frames without rejecting remaining frames',validExport.length===27&&validExport.every(f=>motion.motionFrameIsValid(job,f)));
  assert.throws(()=>motion.motionRedrawFrames({...job,redrawTargets:['missing']}));
  check('missing source IDs still reject stale enhancement selections',true);
  await motion.saveMotionJob(job.id,{validFrameRanges:{}});job=await motion.readMotion(job.id);
  check('clearing the range restores all frames without touching source files',!job.validFrameRanges&&job.frames.length===32&&requests.length===0);
  job=await execute(job.id,{targets,scheme:'sheet'});
  check('missing paid confirmation makes no image request',requests.length===0&&/确认/.test(job.error));
  job=await execute(job.id,{targets:[],scheme:'sheet8',confirmed:true});
  check('empty scope is blocked before any paid attempt',requests.length===0&&/请选择/.test(job.error)&&job.frames.every(f=>!f.redraw));
  failAt=2;
  job=await execute(job.id,{targets,scheme:'sheet',confirmed:true});
  check('failure stops after one successful group and one failed request',requests.length===2&&job.frames.slice(0,4).every(f=>f.redraw.status==='ready')&&job.frames.slice(4,8).every(f=>f.redraw.status==='unknown')&&job.frames.slice(8).every(f=>!f.redraw));
  check('a shared request has a shared ledger and failure redacts keys',new Set(job.frames.slice(0,4).map(f=>f.redraw.batchId)).size===1&&new Set(job.frames.slice(4,8).map(f=>f.redraw.batchId)).size===1&&!job.error.includes('fake-image-key'));
  const request=requests[0];
  check('grouped edits request one 2048 square with high quality, three references and a mask',request.size==='2048x2048'&&request.quality==='high'&&request.images.length===3&&request.prompt.includes('2列2行')&&request.prompt.includes('采样的4帧'));
  await writeFile(join(home,'input.png'),request.images[0]);await writeFile(join(home,'mask.png'),request.mask);
  const input=await decodeToRgba(join(home,'input.png')),mask=await decodeToRgba(join(home,'mask.png'));
  check('sheet and mask dimensions match every target cell',input.width===2048&&input.height===2048&&mask.width===2048&&mask.height===2048);
  for(let i=0;i<4;i++){
    const p=((Math.floor(i/2)*1024+512)*2048+(i%2)*1024+512)*4;
    assert.equal(mask.rgba[p+3],0,'each subject interior editable');assert.equal(mask.rgba[(Math.floor(i/2)*1024*2048+(i%2)*1024)*4+3],255,'cell background locked');
    const output=await decodeToRgba(motion.motionAssetPath(job.id,job.frames[i].redraw.file));
    const center=(256*512+256)*4;
    assert.deepEqual([...output.rgba.subarray(center,center+3)],colors[i],'row-major split must preserve cell identity');
    assert.equal(output.rgba[3],0,'generated background must be keyed');
  }
  check('all four real output cells split in order with transparent backgrounds',true);
  const readyFile=job.frames[0].redraw.file,readyBytes=await readFile(motion.motionAssetPath(job.id,readyFile));
  job=await execute(job.id,{targets,scheme:'sheet',confirmed:true});
  check('unknown requests cannot be automatically retried',requests.length===2&&/未知/.test(job.error));
  failAt=0;
  job=await execute(job.id,{targets:targets.slice(4),scheme:'sheet',confirmed:true,regenerate:true});
  check('explicit retry finishes remaining groups without altering earlier successful files',requests.length===9&&job.frames.every(f=>f.redraw.status==='ready')&&Buffer.compare(await readFile(motion.motionAssetPath(job.id,readyFile)),readyBytes)===0);
  const readyPlan=motion.motionRedrawPlan(job,targets,'sheet');
  check('completed frames cost zero new requests unless regeneration is explicit',readyPlan.requestCount===0&&motion.motionRedrawPlan(job,targets,'sheet',true).requestCount===8);
  job.frames.slice(0,3).forEach(f=>delete f.redraw);await persist(job);
  job=await execute(job.id,{targets:targets.slice(0,24),scheme:'sheet',confirmed:true});
  const tail=requests.at(-1);await writeFile(join(home,'tail-mask.png'),tail.mask);
  const tailMask=await decodeToRgba(join(home,'tail-mask.png'));
  check('resuming a 24-frame scope redraws only its three unfinished frames and locks the fourth cell',requests.length===10&&tail.prompt.includes('前3格')&&tailMask.rgba[((1536*2048)+1536)*4+3]===255&&job.frames.slice(0,3).every(f=>f.redraw.status==='ready'));
  malformed=true;
  job=await execute(job.id,{targets:targets.slice(0,24),scheme:'sheet',confirmed:true,regenerate:true});
  check('undersized grouped reply is retained and all four statuses become unknown',requests.length===11&&job.frames.slice(0,4).every(f=>f.redraw.status==='unknown'&&f.redraw.raw)&&/尺寸/.test(job.error));
  check('raw malformed reply survives for inspection',(await readFile(motion.motionAssetPath(job.id,job.frames[0].redraw.raw))).length>0);
  malformed=false;blankCell=true;
  job=await execute(job.id,{targets:targets.slice(0,24),scheme:'sheet',confirmed:true,regenerate:true});
  check('one empty cell prevents partial group completion',requests.length===12&&job.frames.slice(0,4).every(f=>f.redraw.status==='unknown')&&/人物/.test(job.error));
  blankCell=false;
  failAt=requests.length+2;
  job=await execute(job.id,{targets:targets.slice(0,24),scheme:'frame',confirmed:true,regenerate:true});
  check('per-frame method retains a 1024 square single-frame edit within a 24-frame scope',requests.length===14&&requests.at(-1).size==='1024x1024'&&job.frames[0].redraw.status==='ready'&&job.frames[0].redraw.scheme==='frame'&&!requests.at(-1).prompt.includes('2列2行'));
  failAt=0;const eightStart=requests.length;
  job=await execute(job.id,{targets:targets.slice(0,24),scheme:'sheet8',confirmed:true,regenerate:true});
  check('24 frames use three real eight-frame edits',requests.length===eightStart+3&&job.frames.slice(0,24).every(f=>f.redraw.status==='ready'&&f.redraw.scheme==='sheet8'));
  const eightRequest=requests[eightStart];
  check('eight-frame requests preserve square cells in a four-by-two 4096x2048 sheet',eightRequest.size==='4096x2048'&&eightRequest.prompt.includes('4列2行')&&eightRequest.prompt.includes('采样的8帧'));
  await writeFile(join(home,'eight-input.png'),eightRequest.images[0]);await writeFile(join(home,'eight-mask.png'),eightRequest.mask);
  const eightInput=await decodeToRgba(join(home,'eight-input.png')),eightMask=await decodeToRgba(join(home,'eight-mask.png'));
  assert.equal(eightInput.width,4096);assert.equal(eightInput.height,2048);assert.equal(eightMask.width,4096);assert.equal(eightMask.height,2048);
  for(let i=0;i<8;i++){
    const center=((Math.floor(i/4)*1024+512)*4096+(i%4)*1024+512)*4;
    assert.equal(eightMask.rgba[center+3],0,'all eight subject interiors editable');
    const output=await decodeToRgba(motion.motionAssetPath(job.id,job.frames[i].redraw.file));
    assert.deepEqual([...output.rgba.subarray((256*512+256)*4,(256*512+256)*4+3)],colors[i],'eight output cells retain row-major identity');
    assert.equal(output.rgba[3],0);
  }
  check('eight-frame input and mask align, and all eight outputs split in order with transparency',true);
  job.frames.slice(0,5).forEach(f=>delete f.redraw);await persist(job);
  job=await execute(job.id,{targets:targets.slice(0,24),scheme:'sheet8',confirmed:true});
  await writeFile(join(home,'eight-tail-mask.png'),requests.at(-1).mask);
  const eightTail=await decodeToRgba(join(home,'eight-tail-mask.png'));
  check('five-frame remainder keeps four-by-two layout and locks unused cells',requests.at(-1).prompt.includes('前5格')&&eightTail.rgba[((1536*4096)+3584)*4+3]===255&&job.frames.slice(0,5).every(f=>f.redraw.status==='ready'));
  malformed=true;
  job=await execute(job.id,{targets:targets.slice(0,24),scheme:'sheet8',confirmed:true,regenerate:true});
  check('bad eight-frame replies keep the raw file and never partially finish the group',job.frames.slice(0,8).every(f=>f.redraw.status==='unknown'&&f.redraw.raw)&&/尺寸/.test(job.error));
  malformed=false;
  const smallStart=requests.length,smallTargets=[0,6,12,18].map(i=>targets[i]);
  job=await execute(job.id,{targets:smallTargets,scheme:'sheet',confirmed:true,regenerate:true});
  check('four sampled output frames need one paid request without a 24-frame minimum',requests.length===smallStart+1&&!job.error&&smallTargets.every(id=>job.frames.find(f=>f.id===id).redraw.status==='ready')&&JSON.stringify(job.redrawTargets)===JSON.stringify(smallTargets));
  const eightTargets=Array.from({length:8},(_,i)=>targets[i*3]);
  job=await execute(job.id,{targets:eightTargets,scheme:'sheet8',confirmed:true,regenerate:true});
  assert.equal(job.error,undefined,'sampled eight-frame response must preserve its input layout');
  check('eight sampled output frames need one eight-cell request',requests.length===smallStart+2&&!job.error&&job.redrawTargets.length===8);
  replyMode='alpha';
  job=await execute(job.id,{targets:eightTargets,scheme:'sheet8',confirmed:true,regenerate:true});
  assert.equal(job.error,undefined);
  const transparentReply=await decodeToRgba(motion.motionAssetPath(job.id,job.frames[0].redraw.file));
  check('real image-edits alpha reply preserves connected black trousers',job.frames[0].redraw.background==='alpha'&&transparentReply.rgba[(380*512+256)*4+3]===255&&transparentReply.rgba[(380*512+256)*4]===20);
  replyMode='large';
  job=await execute(job.id,{targets:eightTargets,scheme:'sheet8',confirmed:true,regenerate:true});
  assert.equal(job.error,undefined);
  check('all cells of an enlarged provider reply record one corrected scale',new Set(eightTargets.map(id=>job.frames.find(f=>f.id===id).redraw.scale)).size===1&&job.frames[0].redraw.scale>.85&&job.frames[0].redraw.scale<.89);
  replyMode='drift';const beforeDrift=requests.length;
  job=await execute(job.id,{targets:eightTargets,scheme:'sheet8',confirmed:true,regenerate:true});
  check('a wrong-size cell blocks the entire reply, retains raw and makes no retry',requests.length===beforeDrift+1&&/比例或姿势/.test(job.error)&&eightTargets.every(id=>{const r=job.frames.find(f=>f.id===id).redraw;return r.status==='unknown'&&r.raw&&!r.file;}));
  console.log(`${checks} grouped redraw checks passed; temporary data and fake image API only.`);
}finally{
  motion.disposeMotion();globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(home,{recursive:true,force:true});
}
