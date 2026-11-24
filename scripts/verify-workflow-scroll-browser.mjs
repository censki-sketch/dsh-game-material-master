/** Verify first painted chat location and late-media growth in real Chromium. Local mocks only. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {encodePng} from '../lib/png.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
let checks=0;const check=(name,ok)=>{assert.ok(ok,name);checks++;console.log('✓ '+name);};
const errors=[],network=[];
try{
  const page=await browser.newPage({viewport:{width:1100,height:820}});page.setDefaultTimeout(6000);
  page.on('pageerror',e=>errors.push(e.message));
  let releaseImages;const imagesReady=new Promise(resolve=>releaseImages=resolve);
  const png=encodePng(Buffer.alloc(600*700*4,200),600,700);
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://gmm.test'){network.push(url.href);return route.abort();}
    if(url.pathname.startsWith('/assets/')){if(url.pathname.includes('late'))await imagesReady;return route.fulfill({contentType:'image/png',body:png});}
    return route.fulfill({contentType:'text/html',body:'<html></html>'});
  });
  await page.goto('http://gmm.test');await page.setContent('<div id="root"></div>');
  await page.addScriptTag({path:resolve('.verify/react.js')});await page.addScriptTag({path:resolve('.verify/react-dom.js')});
  await page.evaluate(()=>{window.__ModuleLoader__={load:r=>window.bundle=r.factory(n=>{if(n==='react')return React;throw Error(n);})};});
  await page.addScriptTag({path:'lib/client.js'});
  await page.evaluate(()=>{
    const style=document.createElement('style');style.textContent=bundle.__test.CSS+':root{--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666;--dsw-alias-label-tertiary:#888;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:#eee;--dsw-alias-bg-layer-3:#ddd;--dsw-alias-border-l2:#ccc}body{margin:0}#root,.SPR_root{height:100vh}.SPR_flowRound{min-height:360px}';document.head.append(style);
    const h=React.createElement;window.root=ReactDOM.createRoot(document.getElementById('root'));window.rounds=[];
    window.addRound=(id,file='late-'+id+'.png')=>({id,childId:'wchild-'+id,createdAt:1,prompt:'Round '+id,status:'ready',assetBase:'/assets/',job:{},versions:[{id:'v-'+id,kind:'sheet',files:[file]}]});
    window.rounds=Array.from({length:8},(_,i)=>addRound('r'+i));
    window.api={getConfig:async()=>({minimaxModel:'mock',minimaxDuration:4,minimaxResolution:'480P'}),getWorkflowConversation:async()=>({rounds:structuredClone(rounds)}),submitWorkflowRound:async()=>{rounds.push(addRound('submitted','ready.png'));return {};}};
    window.mount=(id,key=id)=>root.render(h('div',{className:'SPR_root'},h(bundle.__test.WorkflowConversation,{key,api,module:'sprite',job:{id},prompt:'测试本地假提交',onPrompt:()=>{},onSave:async()=>{},onConsumed:()=>{},onReuse:()=>{}})));
    window.samples=[];window.sample=true;const tick=()=>{const el=document.querySelector('.SPR_flowScroll');if(sample&&el?.querySelector('.SPR_flowRound'))samples.push({top:el.scrollTop,gap:el.scrollHeight-el.clientHeight-el.scrollTop,max:el.scrollHeight-el.clientHeight});requestAnimationFrame(tick);};requestAnimationFrame(tick);
    mount('wscroll-a');
  });
  const scroll=page.locator('.SPR_flowScroll');await page.waitForFunction(()=>samples.length>=4);
  check('the first populated painted frame is already at the bottom',await page.evaluate(()=>samples[0].max>0&&samples[0].gap<=1));
  check('initial restoration never animates through intermediate positions',await page.evaluate(()=>samples.every(s=>s.gap<=1)));
  check('the scroll container no longer enables global smooth behavior',await scroll.evaluate(el=>getComputedStyle(el).scrollBehavior==='auto'));
  await page.locator('.SPR_flowScroll img').evaluateAll(images=>images.forEach(img=>img.loading='eager'));
  releaseImages();await page.waitForFunction(()=>[...document.querySelectorAll('.SPR_flowScroll img')].every(img=>img.complete));await page.waitForTimeout(150);
  check('late image loading stays pinned at the bottom without a scroll animation',await page.evaluate(()=>samples.every(s=>s.gap<=1)));
  await scroll.hover();await page.mouse.wheel(0,-650);await page.waitForTimeout(250);
  const readTop=await scroll.evaluate(el=>el.scrollTop);
  check('manual upward scrolling leaves the latest result to read history',await scroll.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>400));
  await page.evaluate(()=>{sample=false;rounds[0].prompt+=' updated';rounds.push(addRound('new','ready.png'));});
  await page.waitForTimeout(3300);
  check('polling and new results do not pull a reader back down',await scroll.evaluate((el,top)=>Math.abs(el.scrollTop-top)<2,readTop));
  await page.evaluate(()=>mount('wscroll-b'));await page.locator('.SPR_flowRound').last().waitFor();await page.waitForTimeout(100);
  check('another conversation opens directly at its own bottom',await scroll.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<=1));
  await page.evaluate(()=>mount('wscroll-a'));await page.waitForTimeout(150);
  check('returning to an explicitly scrolled conversation restores its reading position immediately',await scroll.evaluate((el,top)=>Math.abs(el.scrollTop-top)<2,readTop));
  await scroll.evaluate(el=>el.scrollTo({top:el.scrollHeight,behavior:'instant'}));await page.waitForTimeout(80);
  await page.evaluate(()=>mount('wscroll-b'));await page.waitForTimeout(80);await page.evaluate(()=>{samples=[];sample=true;mount('wscroll-a');});await page.waitForFunction(()=>samples.length>=4);
  check('returning from another conversation remembers bottom-follow mode',await page.evaluate(()=>samples.every(s=>s.gap<=1)));
  await page.setViewportSize({width:390,height:740});await page.waitForTimeout(100);
  check('viewport resize keeps the bottom without replaying a top-to-bottom scroll',await scroll.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<=1));
  await scroll.hover();await page.mouse.wheel(0,-450);await page.waitForTimeout(150);
  await page.getByRole('button',{name:'生成新视频',exact:true}).click();await page.getByRole('dialog',{name:'确认生成视频',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
  await page.locator('#workflow-round-submitted').waitFor();await page.waitForTimeout(100);
  check('explicit submission jumps straight to the new round even after reading history',await scroll.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<=1));
  await page.screenshot({path:'.verify/workflow-instant-scroll.png'});
  check('scroll restoration makes no browser errors or external requests',errors.length===0&&network.length===0);
  console.log(`${checks} instant scroll checks passed.`);
}finally{await browser.close();}
