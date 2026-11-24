/** Alpha preservation and temporal scale correction. Pure local RGBA, no API. */
import assert from 'node:assert/strict';
import { processMotionEdits } from '../lib/motionimage.js';
globalThis.fetch = async () => { throw Error('Network prohibited'); };
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('✓ ' + name); };
function person({ scale = 1, dx = 0, dy = 0, opaque = false, leg = 0 } = {}) {
  const rgba = Buffer.alloc(512 * 512 * 4);
  if (opaque) rgba.fill(Buffer.from([255, 0, 255, 255]));
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const sx = (x - 256 - dx) / scale + 256, sy = (y - 120 - dy) / scale + 120;
    const head = sx >= 190 && sx < 322 && sy >= 70 && sy < 180;
    const torso = sx >= 206 && sx < 306 && sy >= 180 && sy < 290;
    const legs = sx >= 210 && sx < 302 && sy >= 290 && sy < 390 + leg;
    const edge = sx >= 189 && sx < 190 && sy >= 70 && sy < 180;
    if (head || torso || legs || edge) rgba.set([...(head || edge ? [180, 150, 125] : [22, 21, 20]), edge && !opaque ? 96 : 255], (y * 512 + x) * 4);
  }
  return rgba;
}
function bounds(rgba) {
  let top=512,bottom=-1,left=512,right=-1;
  for(let y=0;y<512;y++)for(let x=0;x<512;x++)if(rgba[(y*512+x)*4+3]>127){top=Math.min(top,y);bottom=Math.max(bottom,y);left=Math.min(left,x);right=Math.max(right,x);}
  return {top,bottom,left,right,height:bottom-top+1,width:right-left+1};
}
const source=person();
const preserved=processMotionEdits([source],[source])[0];
check('real transparency preserves dark clothes and semitransparent edges byte for byte',preserved.background==='alpha'&&Buffer.compare(source,preserved.rgba)===0&&preserved.scale===1);
const magenta=person({opaque:true});
const keyed=processMotionEdits([magenta],[source],{keyColor:'#FF00FF'})[0];
check('opaque magenta still keys normally and retains dark trousers',keyed.background==='keyed'&&keyed.rgba[3]===0&&keyed.rgba[(350*512+256)*4+3]===255);
const border=Buffer.from(magenta);
for(let y=0;y<512;y++)for(let x=0;x<512;x++)if(x===0||x===511||y===0||y===511)border[(y*512+x)*4+3]=0;
check('a thin transparent rim does not bypass opaque-background keying',processMotionEdits([border],[source],{keyColor:'#FF00FF'})[0].background==='keyed');
const originals=Array.from({length:8},(_,i)=>person({dy:i%4*2,leg:i%3*3}));
const enlarged=Array.from({length:8},(_,i)=>person({scale:1.15,dx:9,dy:i%4*2-7,leg:i%3*3,opaque:i%2===0}));
const corrected=processMotionEdits(enlarged,originals,{keyColor:'#FF00FF'});
check('a mixed alpha/opaque reply uses one common correction for its eight cells',new Set(corrected.map(f=>f.scale)).size===1&&corrected[0].scale>.85&&corrected[0].scale<.89&&corrected.every(f=>f.translation.length===2));
for(let i=0;i<8;i++){
  const expected=bounds(originals[i]),actual=bounds(corrected[i].rgba);
  assert.ok(Math.abs(expected.height-actual.height)<=3,`frame ${i} body height corrected`);
  assert.ok(Math.abs(expected.top-actual.top)<=2&&Math.abs(expected.left-actual.left)<=2,`frame ${i} source anchor retained`);
}
check('corrected frames retain the source bob and changing leg poses',true);
const natural=processMotionEdits(originals,originals);
check('natural pose changes are not individually fitted to a fixed bounding box',natural.every((f,i)=>f.scale===1&&Buffer.compare(f.rgba,originals[i])===0));
assert.throws(()=>processMotionEdits([person({scale:1.15}),source],[source,source]),/比例或姿势/);
check('conflicting sizes within one batch are rejected before it is saved',true);
assert.throws(()=>processMotionEdits([person({scale:1.5})],[source]),/比例或姿势/);
check('extreme scale drift is rejected instead of silently accepted',true);
assert.throws(()=>processMotionEdits([person({dx:100})],[source]),/位置/);
check('large placement changes are rejected',true);
assert.throws(()=>processMotionEdits([Buffer.alloc(source.length)],[source]),/未得到可用人物/);
check('empty alpha results remain invalid',true);
console.log(`${checks} motion-image checks passed; network disabled.`);
