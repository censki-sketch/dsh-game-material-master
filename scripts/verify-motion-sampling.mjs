/** Native-rate fixture, real extraction and paged ZIPs. Isolated home, no network. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
const home=await mkdtemp(join(tmpdir(),'gmm-motion-sampling-'));
process.env.DSH_HOME=home;
const motion=await import('../lib/motiongen.js');
const media=await import('../lib/media.js');
const {METHODS}=await import('../lib/wire.js');
const originalFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('Sampling verification must never use the network');};
let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('✓ '+name);};
const parse=(method,payload)=>{const out=METHODS.find(m=>m.method===method).payload.parse(payload);assert.deepEqual(out,payload,'wire must retain all sampling fields');return out;};
async function step(id,step) {
  await motion.runMotionStep(id,{step});
  const until=Date.now()+120000;
  while(Date.now()<until){const job=await motion.motionView(id);if(!job.active){assert.equal(job.error,undefined);return job;}await new Promise(r=>setTimeout(r,30));}
  throw Error('sampling step timed out');
}
function unzip(bytes) {
  const files=new Map();let p=0;
  while(bytes.readUInt32LE(p)===0x04034b50){const method=bytes.readUInt16LE(p+8),size=bytes.readUInt32LE(p+18),n=bytes.readUInt16LE(p+26),e=bytes.readUInt16LE(p+28),start=p+30+n+e;files.set(bytes.toString('utf8',p+30,p+30+n),method===8?inflateRawSync(bytes.subarray(start,start+size)):bytes.subarray(start,start+size));p=start+size;}
  return files;
}
try {
  check('legacy ranges preserve their frame count',motion.motionSampling({start:0,end:2,frameCount:8}).frameCount===8);
  check('target FPS derives frame count rather than trusting a stale count',motion.motionSampling({start:0,end:2,frameCount:8,targetFps:24}).frameCount===48);
  assert.throws(()=>motion.motionSampling({start:0,end:120,frameCount:8,targetFps:24}),/720/);
  assert.throws(()=>motion.motionSampling({start:0,end:2,frameCount:8,targetFps:0}),/FPS/);
  check('over-budget frame counts and invalid FPS fail explicitly',true);
  const width=432,height=240,frameBytes=width*height*4,raw=Buffer.alloc(frameBytes*90);
  for(let i=0;i<90;i++)for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw.set([i*2,30+(Math.floor(y/120)*4+Math.floor(x/108))*24,90,255],i*frameBytes+(y*width+x)*4);
  const input=join(home,'source.rgba'),movie=join(home,'source.mp4');await writeFile(input,raw);
  await media.runFfmpeg(['-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate','30','-i',input,'-c:v','libx264','-crf','0','-pix_fmt','yuv444p','-y',movie]);
  const originalVideo=await readFile(movie),job=await motion.createMotionJob('Sampling fixture'),id=job.id;
  await motion.uploadMotionAsset(id,'video',originalVideo.toString('base64'));
  const imported=await motion.readMotion(id);
  check('import defaults to 24 FPS across the actual clip duration',imported.videoRange.targetFps===24&&imported.videoRange.frameCount===72);
  let extracted;
  for(const fps of [24,17]) {
    const range={action:'video',start:.1,end:2.1,frameCount:fps*2,targetFps:fps};
    const payload=parse('saveMotionJob',{jobId:id,videoRange:{start:.1,end:2.1,frameCount:fps*2,targetFps:fps},ranges:[range],rangesConfirmed:true,processing:{...motion.motionProcessing(),key:false,cellWidth:1024,cellHeight:16}});
    await motion.saveMotionJob(id,payload);
    parse('runWorkflowRoundStep',{module:'sprite',jobId:id,roundId:'test',step:'extract',ranges:[range]});
    extracted=await step(id,'extract');
    check(`${fps} FPS extracts ${fps*2} frames for every direction`,extracted.frames.length===fps*2*8);
    const expected=(await media.runFfmpeg(['-ss','0.1','-i',movie,'-vf',`fps=${fps},format=rgba`,'-frames:v',String(fps*2),'-f','rawvideo','-pix_fmt','rgba','-'])).stdout;
    for(const frame of extracted.frames){
      const d=motion.MOTION_ORDER.indexOf(frame.direction),src=(frame.index*width*height+(Math.floor(d/4)*120+60)*width+(d%4*108+54))*4;
      const actual=await media.decodeToRgba(motion.motionAssetPath(id,frame.target));
      assert.deepEqual([...actual.rgba.subarray((256*512+256)*4,(256*512+256)*4+4)],[...expected.subarray(src,src+4)],`${fps} FPS: direction ${d}, frame ${frame.index}, including batch boundaries`);
    }
    check(`${fps} FPS preserves the continuous source sequence at all batch boundaries`,true);
    if(fps===24){
      const out=await step(id,'export'),files=unzip(await readFile(motion.motionAssetPath(id,out.archive))),meta=JSON.parse(files.get('animation.json')),action=meta.actions[0];
      check('48-frame action exports twelve bounded sheet pages',meta.version===2&&action.sheets.length===12&&!action.sheet);
      check('manifest preserves 24 FPS and a two-second total duration',action.fps===24&&Math.abs(action.frameDurationMs-1000/24)<1e-9&&action.frameDurationMs*48===2000);
      for(const [i,page] of action.sheets.entries()){
        const png=files.get(page.file);
        assert.equal(png.readUInt32BE(16),4096);assert.equal(png.readUInt32BE(20),128);assert.equal(page.firstFrame,i*4);assert.equal(page.frameCount,4);assert.deepEqual(page.rowOrder,motion.MOTION_ORDER);
        const decodedPath=join(home,`page-${i}.png`);await writeFile(decodedPath,png);const decoded=await media.decodeToRgba(decodedPath);
        for(let d=0;d<8;d++)for(let f=0;f<4;f++){
          const p=((d*16+8)*4096+f*1024+512)*4,src=((i*4+f)*width*height+(Math.floor(d/4)*120+60)*width+(d%4*108+54))*4;
          assert.deepEqual([...decoded.rgba.subarray(p,p+4)],[...expected.subarray(src,src+4)]);
          assert.ok(files.has(`video/${motion.MOTION_ORDER[d]}/f${String(i*4+f).padStart(2,'0')}.png`));
        }
      }
      check('every page maps to the correct original frame and direction, with standalone PNGs',true);
    }
  }
  await motion.saveMotionJob(id,{ranges:[{action:'video',start:0,end:2,frameCount:2}],rangesConfirmed:true,processing:{key:false,cellWidth:16,cellHeight:1024}});
  await step(id,'extract');const out=await step(id,'export'),files=unzip(await readFile(motion.motionAssetPath(id,out.archive))),action=JSON.parse(files.get('animation.json')).actions[0];
  check('tall cells paginate direction rows within 4096 pixels',action.sheets.length===2&&action.sheets.every((p,i)=>p.rows===4&&p.firstFrame===0&&p.frameCount===2&&JSON.stringify(p.rowOrder)===JSON.stringify(motion.MOTION_ORDER.slice(i*4,i*4+4))&&files.get(p.file).readUInt32BE(20)===4096));
  check('imported video stays byte-identical after all local processing',Buffer.compare(originalVideo,await readFile(motion.motionAssetPath(id,imported.video.file)))===0);
  console.log(`${checks} sampling/export checks passed; no network or paid calls.`);
} finally {motion.disposeMotion();globalThis.fetch=originalFetch;await rm(home,{recursive:true,force:true});}
