/** Staged workspaces: real Chromium, synthetic assets/API, no paid or external requests. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, maskConfig } from '../lib/config.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
await mkdir('.verify', { recursive: true });
const calls = [], errors = [], outbound = [];
let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log('✓ ' + name); checks++; };
const clone = value => structuredClone(value);
const directions = ['front','back','downLeft','downRight','upLeft','upRight','left','right'];
const project = { id:'p1', name:'林间旅人 · 八方向', updatedAt:1, assetBase:'/assets/p1/', source:{file:'hero.png',name:'character.png'},
  images:Object.fromEntries(directions.map(key=>[key,{status:'ready',file:key+'.png',updatedAt:1}])),
  videos:Object.fromEntries(directions.map(key=>[key,{status:'ready',file:key+'.mp4',updatedAt:1}])),
  frames:Object.fromEntries(directions.map(key=>[key,{status:'ready',strip:key+'-strip.png',frames:['frame.png'],duration:4,updatedAt:1}])),
  prompts:{images:{},video:'保持角色外观一致，原地行走'}, settings:{imageMode:'directions'}, sheet:{status:'ready',file:'sheet.png',width:1024,height:1024}, jobs:[], log:[{at:1,level:'info',message:'本地预览素材已准备'}] };
const segments=[{action:'walkfoward',start:0,end:2,frameCount:4},{action:'runforward',start:2,end:4,frameCount:4}];
const motion={id:'w1',name:'林间旅人 · 动作素材',description:'绿色披风、棕色短发，保持角色比例与服装配色一致。',prompt:'以角色参考保持外观，按照白模参考执行行走与奔跑，固定镜头。',segments,ranges:clone(segments),rangesConfirmed:false,character:'hero.png',directions:'directions.png',prepared:{video:'reference.mp4'},video:{status:'ready',file:'out.mp4',duration:4,taskId:'mock-only'},
  frames:directions.flatMap(direction=>Array.from({length:4},(_,index)=>({id:direction+'-'+index,action:'walkfoward',direction,index,keyed:direction+'.png'}))),
  costs:{video:1.28,imageRate:.1},templates:[{key:'walkfoward',name:'行走',originalName:'walk'},{key:'runforward',name:'奔跑',originalName:'run'}],assetBase:'/assets/w1/'};
const sequence={id:'s1',name:'林间旅人 · 行走动画',updatedAt:1,mode:'frames',prompt:'角色原地自然行走，镜头固定，动作流畅，保持衣服和发型不变。',suffix:'',settings:{duration:4,resolution:'480P',frameCount:8,cellWidth:256,cellHeight:256},keying:{},refs:{firstFrame:{file:'hero.png',name:'character.png'},referenceImages:[],referenceVideos:[]},
  video:{status:'ready',file:'video.mp4',updatedAt:1},frames:{status:'ready',raw:'frames/raw.bin',files:['1.png','2.png','3.png'],keyed:['1.png','2.png','3.png'],duration:4,updatedAt:1},sheet:{status:'ready',file:'strip.png'},assetBase:'/assets/s1/',log:[]};
let sequences=[sequence], motions=[motion], projects=[project];
let failCreate=false;
const config=maskConfig({...DEFAULT_CONFIG,moduleNames:{},hiddenModules:[],moduleOrder:['image','sprite','sequence','sfx','music','iso','map','rig']});
const conversations={sprite:[],sequence:[]};
const invoke=async(method,payload)=>{
  calls.push({method,payload});
  if(method==='getConfig')return clone(config);
  if(method==='listProjects')return {projects:clone(projects)};
  if(method==='getProject')return clone(projects.find(item=>item.id===(payload?.projectId||payload))||project);
  if(method==='listMotionJobs')return {jobs:clone(motions)};
  if(method==='getMotionJob')return clone(motions.find(item=>item.id===payload.jobId));
  if(method==='motionSettings')return {baseUrl:'http://127.0.0.1:11434/v1',model:'',videoRate:.16,imageRate:.1};
  if(method==='listSequenceJobs')return {jobs:clone(sequences)};
  if(method==='getSequenceJob')return clone(sequences.find(item=>item.id===(payload?.jobId||payload)));
  if(method==='saveSequenceJob'){const job=sequences.find(item=>item.id===payload.jobId);Object.assign(job,payload);return clone(job);}
  if(method==='saveMotionJob'){const job=motions.find(item=>item.id===payload.jobId);Object.assign(job,payload);return {ok:true};}
  if(method==='renameProject'){const job=projects.find(item=>item.id===payload.projectId);job.name=payload.name;return {ok:true};}
  if(method==='createSequenceJob'){if(failCreate)throw Error('本地测试：创建失败');const job={...clone(sequence),id:'s2',name:payload.name};sequences.push(job);return {jobId:job.id};}
  if(method==='deleteSequenceJob'){sequences=sequences.filter(item=>item.id!==payload.jobId);return {ok:true};}
  if(method==='createProject'){const item={...clone(project),id:'p2',name:payload.name};projects.push(item);return {projectId:item.id};}
  if(method==='setReviewMode')return {ok:true};
  if(method==='reportClientOrigin')return {ok:true};
  if(method==='getWorkflowConversation')return {module:payload.module,jobId:payload.jobId,rounds:clone(conversations[payload.module])};
  if(method==='submitWorkflowRound'){
    const parent=payload.module==='sprite'?motions.find(j=>j.id===payload.jobId):sequences.find(j=>j.id===payload.jobId);
    const n=conversations[payload.module].length+1,childId=parent.id+'child'+n;
    const job=clone(parent);job.id=childId;const r={id:payload.module+'round'+n,childId,createdAt:Date.now(),prompt:parent.prompt,request:{prompt:parent.prompt,settings:parent.settings,segments:parent.segments},status:'ready',versions:[{id:'raw'+n,kind:'raw',files:['raw.png','raw2.png']},{id:'keyed'+n,kind:'keyed',files:['keyed.png','keyed2.png']},{id:'sheet'+n,kind:'sheet',files:['sheet.png']}],job,assetBase:'/assets/'+childId+'/'};
    conversations[payload.module].push(r);parent.prompt='';return {roundId:r.id,childId};
  }
  if(method==='runWorkflowRoundStep'){const r=conversations[payload.module].find(r=>r.id===payload.roundId);r.versions.push({id:'manual'+Date.now(),kind:'keyed',files:['rekeyed.png']});return {ok:true};}
  if(method==='reuseWorkflowRound'){const r=conversations[payload.module].find(r=>r.id===payload.roundId);Object.assign(payload.module==='sprite'?motions[0]:sequences[0],r.request);return {ok:true};}
  if(method==='listMapProjects')return {projects:[{id:'m1',name:'我的地图'}]};
  if(method==='listIsoProjects')return {projects:[{id:'t1',name:'我的45度地图'}]};
  if(method==='transferAsset')return {module:payload.target,jobId:payload.targetId||'newtarget',transferId:'transfer-test',dialog:'add'};
  throw Error('Unexpected API call: '+method);
};
const art='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect x="0" y="0" width="256" height="256" fill="#eef1ed"/><path d="M81 124Q128 98 175 124L187 203H69Z" fill="#578873"/><path d="M103 193L100 236H120L128 198L138 236H158L154 193" fill="#735a46"/><circle cx="128" cy="79" r="40" fill="#f1ccac"/><path d="M89 78Q73 22 128 27Q184 28 167 82L155 55Q131 78 95 58" fill="#685044"/><path d="M91 122L66 177M164 122L187 177" stroke="#f1ccac" stroke-width="17" stroke-linecap="round"/><path d="M108 160H148" stroke="#b19b69" stroke-width="9"/><circle cx="114" cy="81" r="3" fill="#403d36"/><circle cx="143" cy="81" r="3" fill="#403d36"/><path d="M121 99Q128 105 136 99" fill="none" stroke="#936653" stroke-width="3"/></svg>';
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>{errors.push('Unexpected native dialog: '+dialog.type());void dialog.dismiss();});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://gmm.test'){outbound.push(url.href);return route.abort();}
    if(url.pathname.startsWith('/assets/'))return route.fulfill({contentType:url.pathname.endsWith('.mp4')?'video/mp4':'image/svg+xml',body:url.pathname.endsWith('.mp4')?Buffer.alloc(0):art});
    return route.fulfill({contentType:'text/html',body:'<html></html>'});
  });
  await page.goto('http://gmm.test');
  await page.setContent('<meta charset="utf-8"><style>:root{--dsw-alias-label-primary:#242428;--dsw-alias-label-secondary:#66666b;--dsw-alias-label-tertiary:#8c8c92;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:#f3f3f5;--dsw-alias-bg-layer-3:#eee;--dsw-alias-border-l1:#ececef;--dsw-alias-border-l2:#dedee2;--dsw-alias-state-business-primary:#4977ff;--dsw-alias-interactive-bg-hover-solid:#eaeaec}body{margin:0;font:14px system-ui;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}#root{height:100vh}</style><div id="root"></div>');
  await page.addScriptTag({path:resolve(process.env.REACT_TEST_ROOT||'.verify','react.js')});
  await page.addScriptTag({path:resolve(process.env.REACT_TEST_ROOT||'.verify','react-dom.js')});
  await page.evaluate(()=>{window.__ModuleLoader__={load:r=>window.bundle=r.factory(n=>{if(n==='react')return React;throw Error(n);})};});
  await page.addScriptTag({path:'lib/client.js'});await page.exposeFunction('invokeLocal',invoke);
  await page.evaluate(()=>{
    const style=document.createElement('style');style.textContent=bundle.__test.CSS;document.head.append(style);
    window.api=new Proxy({},{get:(_t,method)=>payload=>invokeLocal(method,payload)});
    bundle.__test.rememberStudioModule('sprite');window.root=ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(bundle.__test.StudioPanel,{api}));
  });
  const motionView=page.getByTestId('motion-workflow'),sequenceView=page.getByTestId('sequence-workflow');
  await motionView.getByTestId('workflow-conversation').waitFor();
  check('motion retains shared project sidebar',await motionView.locator('.SPR_jobSidebar').count()===1);
  check('configuration is collapsed initially',await page.getByRole('dialog').count()===0);
  check('rounds show a centered empty state',await motionView.getByText('添加素材，描述动作，结果会保留在每一轮中。').isVisible());
  for(const [width,height] of [[918,542],[1440,900],[390,700]]){
    await page.setViewportSize({width,height});
    await page.evaluate(width=>document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed',String(width<900)),width);
    for(const module of ['sprite','sequence']){
      await page.locator('.SPR_modules [data-module='+module+']').click();
      const view=module==='sprite'?motionView:sequenceView;
      await view.getByTestId('workflow-conversation').waitFor();
      const welcome=view.locator('.SPR_flowScroll>.SPR_workflowEmpty');
      const scroll=view.locator('.SPR_flowScroll');
      const before=await welcome.boundingBox();
      check(module+' empty chat has no overflow at '+width+'x'+height,await scroll.evaluate(el=>el.scrollHeight<=el.clientHeight+1));
      await welcome.hover();await page.mouse.wheel(0,700);await page.waitForTimeout(350);
      const after=await welcome.boundingBox();
      check(module+' empty welcome stays fixed when wheeling at '+width,Math.abs(after.y-before.y)<=1&&await scroll.evaluate(el=>el.scrollTop===0));
      check(module+' empty welcome stays centered at '+width,await scroll.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.firstElementChild.getBoundingClientRect();return Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<=2;}));
      const composer=await view.locator('.SPR_flowComposer').boundingBox();
      check(module+' empty composer remains visible at '+width,composer.y>=0&&composer.y+composer.height<=height+1);
      check(module+' empty controls are not clipped at '+width,await scroll.evaluate(el=>{const bounds=el.getBoundingClientRect();return [...el.firstElementChild.children].every(child=>{const r=child.getBoundingClientRect();return r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;});}));
      if(width===918)await page.screenshot({path:'.verify/empty-scroll-'+module+'-918x542.png'});
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed','false'));
  await page.locator('.SPR_modules [data-module=sprite]').click();await motionView.getByTestId('workflow-conversation').waitFor();
  await motionView.getByRole('button',{name:'素材与参数',exact:true}).click();
  const configDialog=page.getByRole('dialog',{name:'素材与参数',exact:true});await configDialog.waitFor();
  check('settings drawer focuses on character and reference',await configDialog.getByRole('tab').count()===2);
  await configDialog.getByRole('tab').nth(1).click();
  check('editable prompt and reference preparation are preserved',await configDialog.getByText('生成提示词（可编辑）').isVisible()&&await configDialog.getByRole('button',{name:'准备白模参考（本地免费）',exact:true}).count()===1);
  check('drawer uses themed dropdowns',await configDialog.locator('select').count()===0);await page.keyboard.press('Escape');
  const prompt=motionView.getByRole('textbox',{name:'动作提示词',exact:true});await prompt.fill('行走后奔跑，固定镜头');
  await motionView.getByRole('button',{name:'生成新视频',exact:true}).click();
  await page.getByRole('dialog',{name:'确认生成视频',exact:true}).waitFor();
  check('opening confirmation submits nothing',!calls.some(c=>c.method==='submitWorkflowRound'));
  check('confirmation shows resolution and duration',(await page.getByRole('dialog',{name:'确认生成视频',exact:true}).innerText()).includes('480P'));
  await page.getByRole('dialog',{name:'确认生成视频',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
  await motionView.locator('.SPR_flowRound').waitFor();
  check('prompt appears in the submitted round',await motionView.locator('.SPR_chatPrompt').innerText()==='行走后奔跑，固定镜头');
  check('composer clears only after accepted submission',await prompt.inputValue()==='');
  check('one accepted send creates one message',await motionView.locator('.SPR_flowRound').count()===1);
  await motionView.getByRole('button',{name:'结果版本',exact:true}).click();await page.getByRole('menuitemradio',{name:'抠图版',exact:true}).click();
  check('version picker changes the displayed result',await motionView.locator('.SPR_flowMedia img').getAttribute('src')==='/assets/w1child1/keyed.png');
  await motionView.getByRole('button',{name:'下一张',exact:true}).click();
  check('frame navigation changes the actual version file',await motionView.locator('.SPR_flowMedia img').getAttribute('src')==='/assets/w1child1/keyed2.png');
  await prompt.fill('未发送的动作草稿');
  await page.locator('.SPR_modules [data-module=sequence]').click();await sequenceView.getByTestId('workflow-conversation').waitFor();
  await page.locator('.SPR_modules [data-module=sprite]').click();await motionView.getByTestId('workflow-conversation').waitFor();
  check('switching modules restores the unsent draft',await motionView.getByRole('textbox',{name:'动作提示词',exact:true}).inputValue()==='未发送的动作草稿');
  await motionView.getByRole('button',{name:'复用本轮',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.SPR_flowInput')?.value==='行走后奔跑，固定镜头');
  check('reuse restores the round prompt',await prompt.inputValue()==='行走后奔跑，固定镜头');
  await motionView.getByRole('button',{name:'生成新视频',exact:true}).click();await page.getByRole('dialog',{name:'确认生成视频',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
  await motionView.locator('.SPR_flowRound').nth(1).waitFor();
  check('second send preserves first round and adds locator',await motionView.locator('.SPR_flowRound').count()===2&&await motionView.getByRole('navigation',{name:'轮次定位'}).count()===1);
  const messages=motionView.locator('.SPR_flowScroll');
  await messages.evaluate(el=>{el.style.scrollBehavior='auto';el.scrollTop=0;});
  await messages.hover({position:{x:80,y:80}});await page.mouse.wheel(0,400);await page.waitForTimeout(350);
  check('populated chat still scrolls while the outer page stays fixed',await messages.evaluate(el=>el.scrollTop>0)&&await page.evaluate(()=>document.querySelector('.SPR_root').scrollTop===0&&window.scrollY===0));
  const first=motionView.locator('.SPR_flowRound').first();await first.getByRole('button',{name:'单独执行',exact:true}).click();
  const step=page.getByRole('dialog',{name:'单独执行',exact:true});await step.waitFor();
  check('motion ranges can be adjusted without video submission',await step.getByText('开始秒',{exact:true}).count()===2);
  await page.keyboard.press('Escape');
  for(const dark of [false,true]){
    await page.evaluate(dark=>{document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-bg-layer-3:#2e2e33;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'';},dark);
    for(const width of [1440,720,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(width=>document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed',String(width<900)),width);
      for(const module of ['sprite','sequence']){
        await page.locator('.SPR_modules [data-module='+module+']').click();
        const view=module==='sprite'?motionView:sequenceView;await view.getByTestId('workflow-conversation').waitFor();
        check(module+' fits '+width+(dark?' dark':' light'),await view.locator('.SPR_workflowMain').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
        const box=await view.locator('.SPR_flowComposer').boundingBox();
        check(module+' composer stays within viewport '+width,box.y+box.height<=900&&box.x>=0&&box.x+box.width<=width+1);
        await page.screenshot({path:'.verify/workflow-chat-'+module+'-'+width+(dark?'-dark':'-light')+'.png'});
      }
    }
  }
  await page.setViewportSize({width:1440,height:1000});await page.locator('.SPR_modules [data-module=sequence]').click();
  const seqPrompt=sequenceView.getByRole('textbox',{name:'动作提示词',exact:true});await seqPrompt.fill('序列帧动作');
  await sequenceView.getByRole('button',{name:'生成新视频',exact:true}).click();await page.getByRole('dialog',{name:'确认生成视频',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
  await sequenceView.locator('.SPR_flowRound').waitFor();
  const seqRound=sequenceView.locator('.SPR_flowRound').first();await seqRound.getByRole('button',{name:'单独执行',exact:true}).click();
  await page.getByRole('dialog',{name:'单独执行',exact:true}).getByRole('button',{name:'抠像与合成',exact:true}).click();await page.keyboard.press('Escape');
  check('single-step processing keeps one conversation round',await sequenceView.locator('.SPR_flowRound').count()===1&&calls.some(c=>c.method==='runWorkflowRoundStep'&&c.payload.step==='keyed'));
  // Isolate transfer menu to inspect the selected source without navigating a real editor.
  await page.evaluate(()=>root.render(React.createElement(bundle.__test.AssetTransferButton,{api,source:{module:'image',jobId:'image-test',file:'keyed/exact-selected-version.png'},name:'当前抠图版'})));
  await page.getByRole('button',{name:'流转到',exact:true}).click();
  check('unified menu offers both animation workflows and both map editors',await page.getByRole('menuitem').count()===4);
  await page.getByRole('menuitem',{name:'俯视地图编辑器',exact:true}).click();
  const transfer=page.getByRole('dialog');await transfer.waitFor();await transfer.getByRole('button',{name:'目标项目',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'我的地图',exact:true}).click();await transfer.getByRole('button',{name:'继续',exact:true}).click();await transfer.waitFor({state:'hidden'});
  const transferCall=calls.find(c=>c.method==='transferAsset');
  check('transfer passes exact selected version and destination',transferCall.payload.source.file==='keyed/exact-selected-version.png'&&transferCall.payload.target==='map'&&transferCall.payload.targetId==='m1');
  check('no native dropdowns or browser dialogs',await page.locator('select').count()===0&&!errors.length);
  check('all requests stayed inside the synthetic fixture',!outbound.length);
  await page.evaluate(()=>{
    window.oldHostCalls=0;
    window.blockedSendCalls=0;
    const unavailableApi={getConfig:async()=>{window.blockedSendCalls++;return {};},getWorkflowConversation:async()=>{window.oldHostCalls++;throw Error('gateway/internal: client api: gameStudio/getWorkflowConversation failed: transport failure for /api/gameStudio/getWorkflowConversation: HTTP 404');}};
    root.render(React.createElement(bundle.__test.WorkflowConversation,{key:'old-host',api:unavailableApi,module:'sequence',job:{id:'old-host',refs:{}},prompt:'未发送的内容',onPrompt:()=>{},onSave:async()=>{},onConsumed:()=>{},onReuse:()=>{}}));
  });
  await page.getByRole('alert').waitFor();
  check('404 explains the backend restart without a transport stack',(await page.getByRole('alert').innerText()).includes('插件后台尚未更新')&&!(await page.getByRole('alert').innerText()).includes('gateway/internal'));
  check('error is a separate themed card above the composer',await page.locator('.SPR_flowComposerError>.SPR_flowError').count()===1&&await page.locator('.SPR_flowComposer [role=alert]').count()===0);
  await page.screenshot({path:'.verify/workflow-chat-error-desktop.png'});
  await page.setViewportSize({width:390,height:800});await page.screenshot({path:'.verify/workflow-chat-error-narrow.png'});
  check('error card stays inside a narrow screen',await page.getByRole('alert').evaluate(el=>el.getBoundingClientRect().right<=390));
  await page.getByRole('textbox',{name:'动作提示词',exact:true}).press('Control+Enter');
  check('keyboard send is blocked when the host method is missing',await page.evaluate(()=>blockedSendCalls===0));
  await page.evaluate(()=>document.documentElement.style.cssText='');
  await page.screenshot({path:'.verify/workflow-chat-error-narrow-light.png'});
  await page.setViewportSize({width:1440,height:900});await page.screenshot({path:'.verify/workflow-chat-error-desktop-light.png'});
  await page.waitForTimeout(3200);
  check('missing backend method is not repeatedly polled',await page.evaluate(()=>oldHostCalls===1));
  console.log({errors,outbound});console.log('Passed '+checks+' workflow conversation browser checks. No paid requests.');
}finally{await browser.close();}
