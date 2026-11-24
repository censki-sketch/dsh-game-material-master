/** Staged workspaces: real Chromium, synthetic assets/API, no paid or external requests. */
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG, maskConfig } from '../lib/config.js';
import { PROMPT_TEMPLATE_DEFAULTS, templatesOfType, validatePromptTemplates } from '../lib/prompttemplates.js';
import { runFfmpeg } from '../lib/media.js';
import { motionTemplatePreview, motionVideoModels, createMotionJob, previewMotionReference, motionAssetPath } from '../lib/motiongen.js';
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
  reviewMode:'auto',videoModels:motionVideoModels(),videoConfig:{model:'MiniMax-H3-Lite',resolution:'480P'},
  frames:directions.flatMap(direction=>Array.from({length:4},(_,index)=>({id:direction+'-'+index,action:'walkfoward',direction,index,keyed:direction+'.png'}))),
  costs:{video:1.28,imageRate:.1},templates:[{key:'walkfoward',name:'行走',originalName:'walk'},{key:'runforward',name:'奔跑',originalName:'run'}],assetBase:'/assets/w1/'};
const sequence={id:'s1',name:'林间旅人 · 行走动画',updatedAt:1,mode:'frames',prompt:'角色原地自然行走，镜头固定，动作流畅，保持衣服和发型不变。',suffix:'',settings:{duration:4,resolution:'480P',frameCount:8,cellWidth:256,cellHeight:256},keying:{},refs:{firstFrame:{file:'hero.png',name:'character.png'},referenceImages:[],referenceVideos:[]},
  video:{status:'ready',file:'video.mp4',updatedAt:1},frames:{status:'ready',raw:'frames/raw.bin',files:['1.png','2.png','3.png'],keyed:['1.png','2.png','3.png'],duration:4,updatedAt:1},sheet:{status:'ready',file:'strip.png'},assetBase:'/assets/s1/',log:[]};
let sequences=[sequence], motions=[motion], projects=[project];
let motionTransferRoles=['character','directions'];
let holdReferencePreview=false,releaseReferencePreview,failReferencePreview=false;
let failCreate=false, holdOptimization=false, releaseOptimization;
const config={...maskConfig({...DEFAULT_CONFIG,minimaxModel:'MiniMax-H3-Lite',moduleNames:{},hiddenModules:[],moduleOrder:['image','sprite','sequence','sfx','music','iso','map','rig']}),promptTemplateDefaults:clone(PROMPT_TEMPLATE_DEFAULTS)};
const conversations={sprite:[],sequence:[]};
const invoke=async(method,payload)=>{
  calls.push({method,payload});
  if(method==='getConfig')return clone(config);
  if(method==='getPromptOptimizerModel')return {available:true,provider:'deepseek',model:'deepseek-chat',imageReferencesSupported:true,models:[{provider:'deepseek',model:'deepseek-chat',name:'DeepSeek',providerName:'DeepSeek'},{provider:'local',model:'vision',name:'Local vision',providerName:'Local'}]};
  if(method==='previewMotionPrompt')return {prompt:payload.promptTemplate.content.replaceAll('{{timeline}}','0–2s walk; 2–4s run').replaceAll('{{description}}',payload.description||'character').replaceAll('{{keyColor}}',payload.processing.keyColor)+'\n'+payload.prompt,references:[{label:'@图片1',name:'角色细节参考图'},{label:'@图片2',name:'八方向外观图（四列两行）'}]};
  if(method==='optimizeMotionPrompt'){
    if(holdOptimization)await new Promise(resolve=>releaseOptimization=resolve);
    return {prompt:payload.prompt+'，固定镜头，动作衔接自然。',summary:{goal:'平滑动作',changes:['动作衔接'],preserve:['固定朝向'],references:[],clarifications:[]},provider:payload.modelSelection?.provider||'deepseek',model:payload.modelSelection?.model||'deepseek-chat'};
  }
  if(method==='listProjects')return {projects:clone(projects)};
  if(method==='getProject')return clone(projects.find(item=>item.id===(payload?.projectId||payload))||project);
  if(method==='listMotionJobs')return {jobs:clone(motions),...(motionTransferRoles?{assetTransferRoles:clone(motionTransferRoles)}:{})};
  if(method==='getMotionJob')return clone(motions.find(item=>item.id===payload.jobId));
  if(method==='getMotionVideoTimeline')return payload.page===undefined?{file:'out.mp4',times:Array.from({length:4},(_,index)=>index/10),duration:.4}:{kind:'video-frame-previews',file:'out.mp4',page:0,firstFrame:0,count:4,columns:4,rows:1,sheet:'preview.png',width:192,height:108};
  if(method==='saveConfig'){
    config.promptTemplates=validatePromptTemplates(payload.promptTemplates);
    config.imagePromptTemplates=templatesOfType(config.promptTemplates,'image');return clone(config);
  }
  if(method==='motionSettings')return {templates:templatesOfType(config.promptTemplates,'video'),templateDefaults:clone(PROMPT_TEMPLATE_DEFAULTS.filter(t=>t.type==='video')),baseUrl:'http://127.0.0.1:11434/v1',model:'',videoRate:.16,imageRate:.1};
  if(method==='listSequenceJobs')return {jobs:clone(sequences)};
  if(method==='getSequenceJob')return clone(sequences.find(item=>item.id===(payload?.jobId||payload)));
  if(method==='saveSequenceJob'){const job=sequences.find(item=>item.id===payload.jobId);Object.assign(job,payload);return clone(job);}
  if(method==='saveMotionJob'){const job=motions.find(item=>item.id===payload.jobId);Object.assign(job,payload);job.finalPrompt=(job.promptTemplate?.content||'').replaceAll('{{timeline}}','0–2s walk; 2–4s run').replaceAll('{{description}}',job.description||'').replaceAll('{{keyColor}}','#FF00FF')+'\n'+job.prompt;return {ok:true};}
  if(method==='uploadMotionAsset'){
    const job=motions.find(item=>item.id===payload.jobId);
    if(payload.kind==='video'){job.sourceVideo={file:'imported.mp4',duration:4};job.videoRange={start:0,end:4,frameCount:24};job.inputMode='video';job.rangesConfirmed=false;}
    else if(payload.kind.startsWith('remove-')){const key=payload.kind.slice(7);if(key==='video'){delete job.sourceVideo;job.inputMode='generate';}else delete job[key];}
    else job[payload.kind]=payload.kind+'-replacement.png';
    return {ok:true};
  }
  if(method==='getMotionTemplatePreview')return motionTemplatePreview(payload.action,payload.direction);
  if(method==='previewMotionReference'){
    if(holdReferencePreview)await new Promise(resolve=>releaseReferencePreview=resolve);
    if(failReferencePreview)throw Error('本地测试：预览失败');
    return {assetBase:'/assets/'+payload.jobId+'/',video:'prepared/reference.mp4',first:'prepared/reference-first.png',duration:4};
  }
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
    const job=clone(parent);job.id=childId;const r={id:payload.module+'round'+n,childId,createdAt:Date.now(),prompt:parent.prompt,request:{prompt:parent.prompt,settings:parent.settings,segments:parent.segments,reviewMode:parent.reviewMode,videoModel:parent.videoModel},status:'ready',versions:[{id:'raw'+n,kind:'raw',files:['raw.png','raw2.png']},{id:'keyed'+n,kind:'keyed',files:['keyed.png','keyed2.png']},{id:'sheet'+n,kind:'sheet',files:['sheet.png']}],job,assetBase:'/assets/'+childId+'/'};
    conversations[payload.module].push(r);if(!(payload.module==='sprite'&&payload.localOnly))parent.prompt='';return {roundId:r.id,childId};
  }
  if(method==='runWorkflowRoundStep'){if(payload.planOnly&&payload.step==='process')return {kind:'local-processing',steps:['extract','export'],actions:payload.ranges.map(r=>r.action),changed:true};const r=conversations[payload.module].find(r=>r.id===payload.roundId);r.versions.push({id:'manual'+Date.now(),kind:'keyed',files:['rekeyed.png']});return {ok:true};}
  if(method==='reuseWorkflowRound'){const r=conversations[payload.module].find(r=>r.id===payload.roundId);Object.assign(payload.module==='sprite'?motions[0]:sequences[0],r.request);return {ok:true};}
  if(method==='listMapProjects')return {projects:[{id:'m1',name:'我的地图'}]};
  if(method==='listIsoProjects')return {projects:[{id:'t1',name:'我的45度地图'}]};
  if(method==='transferAsset')return {module:payload.target,jobId:payload.targetId||'newtarget',transferId:'transfer-test',dialog:'add'};
  throw Error('Unexpected API call: '+method);
};
const art='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect x="0" y="0" width="256" height="256" fill="#eef1ed"/><path d="M81 124Q128 98 175 124L187 203H69Z" fill="#578873"/><path d="M103 193L100 236H120L128 198L138 236H158L154 193" fill="#735a46"/><circle cx="128" cy="79" r="40" fill="#f1ccac"/><path d="M89 78Q73 22 128 27Q184 28 167 82L155 55Q131 78 95 58" fill="#685044"/><path d="M91 122L66 177M164 122L187 177" stroke="#f1ccac" stroke-width="17" stroke-linecap="round"/><path d="M108 160H148" stroke="#b19b69" stroke-width="9"/><circle cx="114" cy="81" r="3" fill="#403d36"/><circle cx="143" cy="81" r="3" fill="#403d36"/><path d="M121 99Q128 105 136 99" fill="none" stroke="#936653" stroke-width="3"/></svg>';
const {stdout:videoFixture}=await runFfmpeg(['-hide_banner','-f','lavfi','-i','testsrc2=size=160x90:rate=10:duration=0.4','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
const referenceHome=await mkdtemp(join(tmpdir(),'gmm-reference-browser-'));process.env.DSH_HOME=referenceHome;
const referenceJob=await createMotionJob('Local reference preview fixture');
const referenceFixture=await previewMotionReference(referenceJob.id,{segments,keyColor:'#FF00FF'});
const referenceVideo=await readFile(motionAssetPath(referenceJob.id,referenceFixture.video)),referencePoster=await readFile(motionAssetPath(referenceJob.id,referenceFixture.first));
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>{errors.push('Unexpected native dialog: '+dialog.type());void dialog.dismiss();});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://gmm.test'){outbound.push(url.href);return route.abort();}
    if(url.pathname.endsWith('/prepared/reference.mp4'))return route.fulfill({contentType:'video/mp4',body:referenceVideo});
    if(url.pathname.endsWith('/prepared/reference-first.png'))return route.fulfill({contentType:'image/png',body:referencePoster});
    if(url.pathname.startsWith('/assets/'))return route.fulfill({contentType:url.pathname.endsWith('.mp4')?'video/mp4':'image/svg+xml',body:url.pathname.endsWith('.mp4')?videoFixture:url.pathname.includes('keyed2')?art.replace('#578873','#ba6644'):art});
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
  check('rounds show a centered empty state',await motionView.getByText('上传素材并选择动作，结果会保留在每一轮中。').isVisible());
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
      if(await scroll.evaluate(el=>el.scrollHeight>el.clientHeight+1)){console.log(await scroll.evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,children:[...el.querySelectorAll('*')].map(c=>({tag:c.tagName,cls:c.className,r:c.getBoundingClientRect().toJSON()})),composer:el.parentElement.querySelector('.SPR_flowComposer').getBoundingClientRect().toJSON()})));await page.screenshot({path:'.verify/layout-overflow.png'});}
      check(module+' empty chat has no overflow at '+width+'x'+height,await scroll.evaluate(el=>el.scrollHeight<=el.clientHeight+1));
      await welcome.hover();await page.mouse.wheel(0,700);await page.waitForTimeout(350);
      const after=await welcome.boundingBox();
      check(module+' empty welcome stays fixed when wheeling at '+width,Math.abs(after.y-before.y)<=1&&await scroll.evaluate(el=>el.scrollTop===0));
      check(module+' empty welcome stays centered at '+width,await scroll.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.firstElementChild.getBoundingClientRect();return Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<=2;}));
      const composer=await view.locator('.SPR_flowComposer').boundingBox();
      check(module+' empty composer remains visible at '+width,composer.y>=0&&composer.y+composer.height<=height+1);
      check(module+' empty controls are not clipped at '+width,await scroll.evaluate(el=>{const bounds=el.getBoundingClientRect();return [...el.firstElementChild.children].filter(child=>getComputedStyle(child).display!=="none").every(child=>{const r=child.getBoundingClientRect();return r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;});}));
      if(width===918)await page.screenshot({path:'.verify/empty-scroll-'+module+'-918x542.png'});
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed','false'));
  await page.locator('.SPR_modules [data-module=sprite]').click();await motionView.getByTestId('workflow-conversation').waitFor();
  await motionView.locator('.SPR_workflowHeader').getByRole('button',{name:'处理配置',exact:true}).click();
  const configDialog=page.getByRole('dialog',{name:'处理配置',exact:true});await configDialog.waitFor();
  check('assets and actions are in the composer',await motionView.locator('.SPR_motionAttachments input[type=file]').count()===2 && await motionView.locator('.SPR_motionActionTrigger').count()===2);
  check('processing toggles replace stage tabs',await configDialog.getByRole('switch').count()===3 && await configDialog.getByRole('tab').count()===0);
  check('text credentials are password inputs',await configDialog.locator('input[type=password]').count()===1);
  check('drawer uses themed dropdowns',await configDialog.locator('select').count()===0);await page.keyboard.press('Escape');
  await motionView.getByRole('button',{name:'审核模式',exact:true}).click();
  await page.getByRole('menuitemradio',{name:/^人工审核/}).click();
  await motionView.getByRole('button',{name:'切换模型',exact:true}).click();
  const officialVideoOption=page.getByRole('menu',{name:'切换模型',exact:true}).getByRole('menuitemradio').filter({has:page.getByText('MiniMax-H3',{exact:true})});
  check('video picker offers compatible models only',await officialVideoOption.count()===1&&await page.getByRole('menuitemradio',{name:/H3-Max|Hailuo/}).count()===0);
  await officialVideoOption.click();
  check('review and video selection do not submit or mutate global settings',!calls.some(c=>c.method==='submitWorkflowRound'||c.method==='saveConfig')&&await motionView.getByRole('button',{name:'切换模型',exact:true}).innerText().then(text=>text.includes('MiniMax-H3')));
  check('review is the first composer tool',await motionView.locator('.SPR_motionComposerTools button').first().getAttribute('aria-label')==='审核模式');
  check('one model trigger shows video and prompt models',await motionView.locator('.SPR_chatModels [data-model-kind=video]').count()===1&&await motionView.locator('.SPR_chatModels [data-model-kind=prompt]').count()===1&&await motionView.getByRole('button',{name:'切换模型',exact:true}).count()===1);
  const prompt=motionView.getByRole('textbox',{name:'本轮补充要求',exact:true});await prompt.fill('行走后奔跑，固定镜头');
  await motionView.getByRole('button',{name:'生成新视频',exact:true}).click();
  await page.getByRole('dialog',{name:'确认生成视频',exact:true}).waitFor();
  check('opening confirmation submits nothing',!calls.some(c=>c.method==='submitWorkflowRound'));
  check('confirmation reflects the chosen model and adapted resolution',(await page.getByRole('dialog',{name:'确认生成视频',exact:true}).innerText()).includes('MiniMax-H3 · 4秒 · 768P'));
  await page.getByRole('dialog',{name:'确认生成视频',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
  await motionView.locator('.SPR_flowRound').waitFor();
  check('prompt appears in the submitted round',await motionView.locator('.SPR_chatPrompt').innerText()==='行走后奔跑，固定镜头');
  check('composer clears only after accepted submission',await prompt.inputValue()==='');
  check('one accepted send creates one message',await motionView.locator('.SPR_flowRound').count()===1);
  check('manual review and chosen video model reach submission',calls.filter(c=>c.method==='submitWorkflowRound').at(-1).payload.automatic===false&&calls.filter(c=>c.method==='submitWorkflowRound').at(-1).payload.expectedVideoModel==='MiniMax-H3'&&calls.filter(c=>c.method==='saveMotionJob').at(-1).payload.reviewMode==='manual'&&calls.filter(c=>c.method==='saveMotionJob').at(-1).payload.videoModel==='MiniMax-H3');
  await motionView.getByRole('button',{name:'结果版本',exact:true}).click();await page.getByRole('menuitemradio',{name:'抠图帧',exact:true}).click();
  const resultPlayer=motionView.locator('.SPR_flowAnimation');await resultPlayer.waitFor();
  check('version picker shows a player without opening animation details',await resultPlayer.isVisible()&&await motionView.getByText('动画预览',{exact:true}).count()===0);
  await resultPlayer.getByRole('button',{name:'暂停',exact:true}).click();
  await resultPlayer.getByRole('button',{name:'下一帧',exact:true}).click();await page.waitForTimeout(150);
  const framePixels=await resultPlayer.locator('canvas').evaluate(el=>el.toDataURL());
  await resultPlayer.getByRole('button',{name:'下一帧',exact:true}).click();await page.waitForTimeout(150);
  check('frame navigation changes actual rendered animation pixels',await resultPlayer.locator('canvas').evaluate((el,before)=>el.toDataURL()!==before,framePixels));
  await prompt.fill('未发送的动作草稿');
  await page.locator('.SPR_modules [data-module=sequence]').click();await sequenceView.getByTestId('workflow-conversation').waitFor();
  await page.locator('.SPR_modules [data-module=sprite]').click();await motionView.getByTestId('workflow-conversation').waitFor();
  check('switching modules restores the unsent draft',await motionView.getByRole('textbox',{name:'本轮补充要求',exact:true}).inputValue()==='未发送的动作草稿');
  check('review and video choice survive switching modules',await motionView.getByRole('button',{name:'审核模式',exact:true}).innerText().then(text=>text.includes('人工审核'))&&await motionView.getByRole('button',{name:'切换模型',exact:true}).innerText().then(text=>text.includes('MiniMax-H3')));
  await motionView.getByRole('button',{name:'复用本轮',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.SPR_flowInput')?.value==='行走后奔跑，固定镜头');
  check('reuse restores the round prompt',await prompt.inputValue()==='行走后奔跑，固定镜头');
  await motionView.getByRole('button',{name:'审核模式',exact:true}).click();await page.getByRole('menuitemradio',{name:/^自动审核/}).click();
  await motionView.getByRole('button',{name:'生成新视频',exact:true}).click();await page.getByRole('dialog',{name:'确认生成视频',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
  await motionView.locator('.SPR_flowRound').nth(1).waitFor();
  check('second send preserves first round and adds locator',await motionView.locator('.SPR_flowRound').count()===2&&await motionView.getByRole('navigation',{name:'轮次定位'}).count()===1);
  check('automatic review reaches the next submission',calls.filter(c=>c.method==='submitWorkflowRound').at(-1).payload.automatic===true);
  const messages=motionView.locator('.SPR_flowScroll');
  await messages.evaluate(el=>{el.style.scrollBehavior='auto';el.scrollTop=0;});
  await messages.hover({position:{x:80,y:80}});await page.mouse.wheel(0,400);await page.waitForTimeout(350);
  check('populated chat still scrolls while the outer page stays fixed',await messages.evaluate(el=>el.scrollTop>0)&&await page.evaluate(()=>document.querySelector('.SPR_root').scrollTop===0&&window.scrollY===0));
  const first=motionView.locator('.SPR_flowRound').first();await first.getByRole('button',{name:'视频处理',exact:true}).click();
  const step=page.getByRole('dialog',{name:'视频处理',exact:true});await step.waitFor();
  check('motion processing keeps frame calibration behind the comparison entry',await step.getByText('起始帧',{exact:true}).count()===0);
  const sendsBeforeComparison=calls.filter(c=>c.method==='submitWorkflowRound').length;
  await step.locator('.SPR_flowRangeEntry').getByRole('button',{name:'展开帧对比',exact:true}).click();
  const comparison=page.getByRole('dialog',{name:'帧对比',exact:true});await comparison.getByText('起始帧',{exact:true}).waitFor();
  check('comparison contains the selected range and output FPS without submitting video',await comparison.getByText('起始帧',{exact:true}).count()===1&&await comparison.getByText('抽帧 FPS',{exact:true}).count()===1&&calls.filter(c=>c.method==='submitWorkflowRound').length===sendsBeforeComparison);
  await page.keyboard.press('Escape');
  check('leaving frame comparison preserves the outer processing dialog',await comparison.count()===0&&await step.isVisible());
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
  const seqPrompt=sequenceView.getByRole('textbox',{name:'动作提示词',exact:true});
  await seqPrompt.fill(' \n\t　 ');
  const sequenceSends=calls.filter(c=>c.method==='submitWorkflowRound').length;
  await seqPrompt.press('Control+Enter');
  check('blank sequence instructions disable sending and its keyboard shortcut',await sequenceView.locator('.SPR_flowSend').isDisabled()&&calls.filter(c=>c.method==='submitWorkflowRound').length===sequenceSends&&await page.getByRole('dialog',{name:'确认生成视频',exact:true}).count()===0);
  await seqPrompt.fill('序列帧动作');
  await sequenceView.getByRole('button',{name:'生成新视频',exact:true}).click();await page.getByRole('dialog',{name:'确认生成视频',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
  await sequenceView.locator('.SPR_flowRound').waitFor();
  const seqRound=sequenceView.locator('.SPR_flowRound').first();await seqRound.getByRole('button',{name:'单独执行',exact:true}).click();
  await page.getByRole('dialog',{name:'单独执行',exact:true}).getByRole('button',{name:'抠像与合成',exact:true}).click();await page.keyboard.press('Escape');
  check('single-step processing keeps one conversation round',await sequenceView.locator('.SPR_flowRound').count()===1&&calls.some(c=>c.method==='runWorkflowRoundStep'&&c.payload.step==='keyed'));
  // Keep the real neighboring controls: a bare trigger hid text overflowing its fixed icon width.
  await page.evaluate(()=>{
    const h=React.createElement;
    root.render(h('section',{className:'SPR_transferFixture',style:{maxWidth:820,margin:'32px auto',padding:16}},
      h('img',{src:'/assets/image-test/keyed.png',alt:'当前抠图版',style:{display:'block',width:'100%',height:180,objectFit:'contain'}}),
      h('div',{className:'SPR_chatVersionBar'},
        h('span',{className:'SPR_chatVersionLabel'},'抠图版本 1'),
        h('button',{type:'button',className:'SPR_taskIconButton SPR_imageBookmark','aria-label':'收藏当前版本'},
          h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor'},h('path',{d:'M6 4h12v17l-6-4-6 4Z'}))),
        h('div',{className:'SPR_chatImageActions'},
          h(bundle.__test.AssetTransferButton,{api,source:{module:'image',jobId:'image-test',file:'keyed/exact-selected-version.png'},name:'当前抠图版'}),
          ...['作为参考','抠图设置','下载 PNG'].map(label=>h('button',{key:label,type:'button',className:'SPR_btn'},label))))));
  });
  const transferTrigger=page.getByRole('button',{name:'流转到',exact:true}),transferMenu=page.getByRole('menu',{name:'流转到',exact:true});
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'',dark);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:760});
      check('transfer label fits its trigger at '+width+' '+dark,await transferTrigger.evaluate(button=>{const b=button.getBoundingClientRect(),label=button.querySelector('.SPR_flowTransferLabel').getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();return [label,icon].every(r=>r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom);}));
      check('transfer does not overlap neighboring actions at '+width+' '+dark,await page.locator('.SPR_chatVersionBar').evaluate(bar=>{const controls=[...bar.querySelectorAll('button')].map(button=>button.getBoundingClientRect()).filter(r=>r.width>0);return controls.every((r,i)=>r.left>=0&&r.right<=innerWidth&&controls.slice(i+1).every(other=>r.right<=other.left||other.right<=r.left||r.bottom<=other.top||other.bottom<=r.top));}));
      await transferTrigger.click();await transferMenu.waitFor();
      check('transfer menu fits '+width+' '+dark,await transferMenu.evaluate(menu=>{const r=menu.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
      await page.keyboard.press('End');
      check('transfer keyboard reaches last destination at '+width+' '+dark,await transferMenu.evaluate(menu=>document.activeElement===menu.querySelector('button:last-child')));
      await page.locator('.SPR_transferFixture').screenshot({path:'.verify/transfer-actions-'+width+'-'+(dark?'dark':'light')+'.png'});
      await page.keyboard.press('Escape');
      check('transfer Escape restores focus at '+width+' '+dark,await transferMenu.isHidden()&&await transferTrigger.evaluate(button=>button===document.activeElement));
      await transferTrigger.click();await page.mouse.click(4,4);await transferTrigger.click();
      check('transfer reopens with one click after outside dismissal at '+width+' '+dark,await transferMenu.isVisible());
      await page.keyboard.press('Escape');
    }
  }
  await page.evaluate(()=>document.documentElement.style.cssText='');await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'流转到',exact:true}).click();
  check('unified menu offers both animation workflows and both map editors',await page.getByRole('menuitem').count()===4);
  await page.getByRole('menuitem',{name:'俯视地图编辑器',exact:true}).click();
  const transfer=page.getByRole('dialog');await transfer.waitFor();await transfer.getByRole('button',{name:'目标项目',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'我的地图',exact:true}).click();await transfer.getByRole('button',{name:'继续',exact:true}).click();await transfer.waitFor({state:'hidden'});
  const transferCall=calls.find(c=>c.method==='transferAsset');
  check('transfer passes exact selected version and destination',transferCall.payload.source.file==='keyed/exact-selected-version.png'&&transferCall.payload.target==='map'&&transferCall.payload.targetId==='m1');
  for(const [target,title,module] of [['sprite','八方向图生成','sprite-motion'],['sequence','序列帧生成','sequence']]){
    const saved=target==='sprite'?motions:sequences;
    const extras=[{...clone(saved[0]),id:'archived-target',name:'已归档项目'},{...clone(saved[0]),id:'hidden-target',name:'已隐藏项目'},{...clone(saved[0]),id:'removed-target',name:'已移除文件夹项目',saveDirectory:'C:/game/removed'}];
    if(target==='sprite')motions=[...saved,...extras];else sequences=[...saved,...extras];
    await page.evaluate(({module,visibleId})=>{
      localStorage.setItem('dsh-game-material-master:'+module+'-task-preferences',JSON.stringify({showArchived:true,archivedProjects:['archived-target'],hiddenProjects:['hidden-target'],folders:{'C:\\game\\removed':{removed:true}}}));
      localStorage.setItem('dsh-game-material-master:image-task-preferences',JSON.stringify({archivedProjects:[visibleId]}));
      localStorage.setItem('dsh-game-material-master:sprite-task-preferences',JSON.stringify({archivedProjects:[visibleId]}));
    },{module,visibleId:saved[0].id});
    await transferTrigger.click();await page.getByRole('menuitem',{name:title,exact:true}).click();
    await transfer.getByRole('button',{name:'继续',exact:true}).waitFor();
    await transfer.getByRole('button',{name:'目标项目',exact:true}).click();
    const options=await page.getByRole('menuitemradio').allTextContents();
    check(target+' transfer hides archived, hidden and removed-folder projects even in archive view',extras.every(item=>!options.includes(item.name)));
    check(target+' transfer reads its own module preferences and retains normal destinations',saved.every(item=>options.includes(item.name))&&options.includes('新建项目'));
    await page.keyboard.press('Escape');await transfer.getByRole('button',{name:'取消',exact:true}).click();
    if(target==='sprite')motions=saved;else sequences=saved;
    await page.evaluate(module=>{for(const key of [module,'image','sprite'])localStorage.removeItem('dsh-game-material-master:'+key+'-task-preferences');},module);
  }
  await transferTrigger.click();await page.getByRole('menuitem',{name:'八方向图生成',exact:true}).click();
  await transfer.getByRole('button',{name:'填入位置',exact:true}).waitFor();
  check('animation transfer explicitly identifies its character slot',await transfer.getByRole('button',{name:'填入位置',exact:true}).innerText()==='角色细节参考图');
  await transfer.getByRole('button',{name:'填入位置',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'八方向外观图（四列两行）',exact:true}).click();
  await transfer.getByRole('button',{name:'目标项目',exact:true}).click();
  await page.getByRole('menuitemradio',{name:motion.name,exact:true}).click();
  for(const [width,dark] of [[1440,false],[1440,true],[390,false],[390,true]]){
    await page.setViewportSize({width,height:760});
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'',dark);
    check('animation transfer destination fits '+width,await transfer.evaluate(dialog=>{const r=dialog.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&dialog.scrollWidth<=dialog.clientWidth+1;}));
    await transfer.screenshot({path:'.verify/transfer-slot-'+width+'-'+(dark?'dark':'light')+'.png'});
  }
  await transfer.getByRole('button',{name:'继续',exact:true}).click();await transfer.waitFor({state:'hidden'});
  const directionTransfer=calls.filter(c=>c.method==='transferAsset').at(-1).payload;
  check('animation transfer sends the chosen slot without changing the chosen project or version',directionTransfer.target==='sprite'&&directionTransfer.targetId===motion.id&&directionTransfer.targetRole==='directions'&&directionTransfer.source.file==='keyed/exact-selected-version.png');
  motionTransferRoles=null;
  await transferTrigger.click();await page.getByRole('menuitem',{name:'八方向图生成',exact:true}).click();
  await transfer.getByRole('button',{name:'填入位置',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'八方向外观图（四列两行）',exact:true}).click();
  const previousTransfers=calls.filter(c=>c.method==='transferAsset').length;
  await transfer.getByRole('button',{name:'继续',exact:true}).click();
  await transfer.getByRole('alert').waitFor();
  check('old host blocks directions transfer before any write to the character slot',calls.filter(c=>c.method==='transferAsset').length===previousTransfers&&await transfer.isVisible());
  check('old host explains the full restart required to load the new slot schema',(await transfer.getByRole('alert').innerText()).includes('完全退出 DSH（包括托盘）'));
  await transfer.screenshot({path:'.verify/transfer-old-host-390-dark.png'});
  await transfer.getByRole('button',{name:'取消',exact:true}).click();motionTransferRoles=['character','directions'];
  await page.evaluate(()=>document.documentElement.style.cssText='');await page.setViewportSize({width:1440,height:1000});
  check('no native dropdowns or browser dialogs',await page.locator('select').count()===0&&!errors.length);
  check('all requests stayed inside the synthetic fixture',!outbound.length);
  // New composer: blank selections, one file per role, video-only parsing and snapshots.
  const priorReferenceCalls=calls.filter(c=>c.method==='previewMotionReference').length;
  const fresh={...clone(motion),id:'wnew',name:'新建角色动作',prompt:'',segments:segments.map(s=>({...s,action:''})),ranges:segments.map(s=>({...s,action:''})),composerVersion:1,inputMode:'generate',frames:[],character:undefined,directions:undefined,video:undefined,prepared:undefined};
  motions=[fresh];conversations.sprite=[];
  await page.evaluate(()=>{
    bundle.__test.publishWorkflowIntent({module:'sprite',jobId:'wnew'});
    for(const key of Object.keys(localStorage))if(key.startsWith('dsh-game-material-master:workflow:'))localStorage.removeItem(key);
    root.render(React.createElement('div',{className:'SPR_root'},React.createElement(bundle.__test.MotionModule,{key:'fresh-composer',api})));
  });
  await page.locator('.SPR_motionActionTrigger').nth(1).waitFor();
  check('new tasks have no default action',await page.locator('.SPR_motionActionTrigger').allTextContents().then(values=>values.every(value=>value==='选择动作')));
  check('blank actions cannot send',await page.locator('.SPR_flowSend').isDisabled());
  check('reference preview stays disabled and does not render with blank actions',await page.getByRole('button',{name:'预览参考视频',exact:true}).isDisabled()&&calls.filter(c=>c.method==='previewMotionReference').length===priorReferenceCalls);
  check('empty upload, action and reference cards share centered gray captions',await page.locator('.SPR_motionAttachments').evaluate(row=>{const labels=[...row.querySelectorAll('.SPR_motionCardCaption')],base=labels[0].getBoundingClientRect();return labels.length===5&&labels.every(label=>Math.abs(label.getBoundingClientRect().bottom-base.bottom)<1.1&&getComputedStyle(label).position==='static'&&getComputedStyle(label).color==='rgb(102, 102, 107)');}));
  for(const [width,height] of [[1440,900],[918,542],[390,700]]){
    await page.setViewportSize({width,height});
    for(const theme of ['light','dark']){
      await page.evaluate(({theme,width})=>{document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed',String(width<900));document.documentElement.style.cssText=theme==='dark'?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-bg-layer-3:#2e2e33;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'';},{theme,width});
      await page.waitForTimeout(250);
      check('composer fits '+width+' '+theme,await page.locator('.SPR_flowComposer').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&el.scrollWidth<=el.clientWidth+1;}));
      check('empty card captions and icon colors align in '+width+' '+theme,await page.locator('.SPR_motionAttachments').evaluate((row,dark)=>{const labels=[...row.querySelectorAll('.SPR_motionCardCaption')],base=labels[0].getBoundingClientRect(),iconColor=getComputedStyle(row.querySelector('.SPR_motionActionThumb>svg')).color;return labels.length===5&&labels.every(label=>{const card=label.closest('.SPR_motionAttachment,.SPR_motionActionControl,.SPR_motionReferenceCard'),r=card.getBoundingClientRect(),text=label.getBoundingClientRect(),icon=card.querySelector('svg'),bounds=icon.getBoundingClientRect();return Math.abs(text.bottom-base.bottom)<1.1&&Math.abs((bounds.top+text.bottom)/2-(r.top+r.bottom)/2)<1.1&&text.bottom<r.bottom-5&&getComputedStyle(label).position==='static'&&getComputedStyle(label).color===(dark?'rgb(170, 170, 177)':'rgb(102, 102, 107)')&&getComputedStyle(icon).color===iconColor&&getComputedStyle(card.querySelector('button')).opacity==='1';});},theme==='dark'));
      await page.screenshot({path:'.verify/revised-motion-'+width+'-'+theme+'.png'});
      check('empty card captions remain fully visible at '+width+' '+theme,await page.locator('.SPR_motionCardCaption').evaluateAll(labels=>labels.every(label=>label.scrollWidth<=label.clientWidth+1)));
      for(const label of ['审核模式','切换模型']){
        const trigger=page.getByRole('button',{name:label,exact:true}),menu=page.getByRole('menu',{name:label,exact:true});
        await trigger.click();await menu.waitFor();
        check(label+' menu fits '+width+' '+theme,await menu.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
        await page.keyboard.press('End');
        check(label+' supports keyboard navigation '+width+' '+theme,await menu.evaluate(el=>el.contains(document.activeElement)&&document.activeElement.getAttribute('role')==='menuitemradio'));
        if(label==='切换模型'&&width!==918)await page.screenshot({path:'.verify/motion-video-models-'+width+'-'+theme+'.png'});
        await page.keyboard.press('Escape');
        check(label+' Escape restores focus '+width+' '+theme,await menu.isHidden()&&await trigger.evaluate(el=>document.activeElement===el));
        await trigger.click();await page.mouse.click(5,5);await trigger.click();
        check(label+' reopens after outside dismissal '+width+' '+theme,await menu.isVisible());await page.keyboard.press('Escape');
      }
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>{document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed','false');document.documentElement.style.cssText='';});
  const beforePreview=calls.filter(c=>c.method==='getMotionTemplatePreview').length;
  await page.locator('.SPR_motionActionTrigger').first().click();
  check('opening a blank action picker neither preselects nor requests a preview',await page.getByRole('button',{name:'选择这个动作',exact:true}).isDisabled()&&calls.filter(c=>c.method==='getMotionTemplatePreview').length===beforePreview);
  await page.getByRole('option').first().click();await page.getByRole('button',{name:'选择这个动作',exact:true}).click();
  await page.waitForTimeout(250);
  check('one selected action does not start reference assembly',calls.filter(c=>c.method==='previewMotionReference').length===priorReferenceCalls);
  await page.locator('.SPR_motionActionTrigger').nth(1).click();await page.getByRole('option').first().click();await page.getByRole('button',{name:'选择这个动作',exact:true}).click();
  await page.waitForTimeout(250);
  check('duplicate actions cannot assemble or preview a reference video',calls.filter(c=>c.method==='previewMotionReference').length===priorReferenceCalls&&await page.getByRole('button',{name:'预览参考视频',exact:true}).isDisabled());
  const beforeReferenceSaves=calls.filter(c=>c.method==='saveMotionJob').length,beforeReferenceSends=calls.filter(c=>c.method==='submitWorkflowRound').length;
  holdReferencePreview=true;
  await page.locator('.SPR_motionActionTrigger').nth(1).click();await page.getByRole('option').nth(1).click();await page.getByRole('button',{name:'选择这个动作',exact:true}).click();
  check('choosing actions alone does not allow generation without both images',await page.locator('.SPR_flowSend').isDisabled());
  const referenceTrigger=page.getByRole('button',{name:'预览参考视频',exact:true}),referenceDialog=page.getByRole('dialog',{name:'参考视频预览',exact:true});
  check('reference preview sits directly after the selected actions',await page.locator('.SPR_motionAttachments').evaluate(row=>{const preview=row.querySelector('.SPR_motionReferenceCard'),actions=[...row.querySelectorAll('.SPR_motionActionControl')];return preview===row.lastElementChild&&preview.previousElementSibling===actions.at(-1)&&preview.getBoundingClientRect().left>=actions.at(-1).getBoundingClientRect().right;}));
  await page.locator('.SPR_motionReferenceLoading').waitFor();
  // Wait for the automatic local request, without clicking the reference card.
  for(let n=0;n<50&&!releaseReferencePreview;n++)await page.waitForTimeout(20);
  check('selecting all actions automatically assembles while preview remains closed and disabled',await referenceTrigger.isDisabled()&&await referenceDialog.count()===0&&calls.filter(c=>c.method==='previewMotionReference').length===priorReferenceCalls+1);
  releaseReferencePreview();holdReferencePreview=false;
  await page.waitForFunction(()=>{const card=document.querySelector('.SPR_motionReferenceCard');return !card.querySelector('button').disabled&&card.querySelector('img')?.naturalWidth===864;});
  check('automatic completion shows a thumbnail without opening the preview',await referenceDialog.count()===0);
  await referenceTrigger.click();
  await page.waitForFunction(()=>{const v=document.querySelector('.SPR_motionReferenceVideo');return v?.readyState>=2&&v.videoWidth===864;});
  const previewRequest=calls.filter(c=>c.method==='previewMotionReference').at(-1).payload;
  check('reference preview uses unsaved actions without images, a prompt or a draft save',previewRequest.jobId==='wnew'&&previewRequest.segments.every(s=>s.action)&&motions[0].segments.every(s=>!s.action)&&calls.filter(c=>c.method==='saveMotionJob').length===beforeReferenceSaves&&calls.filter(c=>c.method==='submitWorkflowRound').length===beforeReferenceSends);
  check('reference preview decodes the real four-second eight-direction MP4 with playback controls',await referenceDialog.locator('video').evaluate(v=>Math.abs(v.duration-4)<.02&&v.videoWidth===864&&v.videoHeight===480&&v.controls&&v.loop&&v.muted));
  await referenceDialog.locator('video').evaluate(v=>{v.pause();v.currentTime=.5;});
  for(const [width,dark] of [[1440,false],[1440,true],[390,false],[390,true]]){
    await page.setViewportSize({width,height:760});
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'',dark);
    check('reference preview and its close control fit '+width+' '+dark,await referenceDialog.evaluate(el=>{const r=el.getBoundingClientRect(),v=el.querySelector('video').getBoundingClientRect(),close=el.querySelector('[aria-label="关闭"]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&v.right<=r.right&&v.bottom<=r.bottom&&close.right<=r.right&&el.scrollWidth<=el.clientWidth+1;}));
    await page.screenshot({path:'.verify/reference-preview-'+width+'-'+(dark?'dark':'light')+'.png'});
  }
  await page.keyboard.press('Escape');await referenceDialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>!document.querySelector('.SPR_motionReferenceCard button').disabled);
  check('generated reference card shows a decoded poster',await page.locator('.SPR_motionReferenceCard img').evaluate(img=>img.complete&&img.naturalWidth===864));
  await referenceTrigger.click();await referenceDialog.locator('video').waitFor();
  check('reopening an unchanged reference reuses the local preview',calls.filter(c=>c.method==='previewMotionReference').length===priorReferenceCalls+1);
  await referenceDialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>document.documentElement.style.cssText='');await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'动作数量',exact:true}).click();await page.getByRole('menuitemradio',{name:'3种动作',exact:true}).click();
  check('adding a third action never assigns a default',await page.locator('.SPR_motionActionTrigger').nth(2).innerText()==='选择动作');
  await page.setViewportSize({width:390,height:700});await page.evaluate(()=>document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed','true'));await page.waitForTimeout(250);
  check('toolbar keeps a fixed send button without action dropdowns',await page.locator('.SPR_flowComposerBar').evaluate(el=>{const tools=el.querySelector('.SPR_motionComposerTools'),p=el.closest('.SPR_flowComposer').getBoundingClientRect(),send=el.querySelector('.SPR_flowSend').getBoundingClientRect(),r=tools.getBoundingClientRect();return !tools.querySelector('.SPR_motionActionControl')&&send.right<=p.right&&r.right<=send.left&&[...tools.children].every(c=>{const b=c.getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom;});}));
  check('uploads, three actions and reference preview stay in one horizontally scrollable row',await page.locator('.SPR_motionAttachments').evaluate(row=>{const cards=[...row.children];return cards.length===6&&getComputedStyle(row).overflowX==='auto'&&cards.every(card=>{const b=card.getBoundingClientRect();return Math.abs(b.width-b.height)<1&&b.width<=64&&Math.abs(b.top-cards[0].getBoundingClientRect().top)<1;})&&document.querySelector('.SPR_flowComposer').scrollWidth<=document.querySelector('.SPR_flowComposer').clientWidth+1;}));
  check('changing the action count removes the obsolete reference preview',await page.locator('.SPR_motionReferenceCard img').count()===0&&await referenceTrigger.isDisabled());
  await page.screenshot({path:'.verify/revised-motion-actions-390.png'});
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed','false'));
  await page.getByRole('button',{name:'动作数量',exact:true}).click();await page.getByRole('menuitemradio',{name:'2种动作',exact:true}).click();
  const files=page.locator('.SPR_motionAttachments input[type=file]');
  check('generation shows two single-image roles without a video upload',await files.evaluateAll(nodes=>nodes.length===2&&nodes.every(n=>!n.multiple&&n.accept.startsWith('image/'))));
  check('square asset and action row sits below the text',await page.locator('.SPR_flowComposer').evaluate(el=>{const input=el.querySelector('textarea').getBoundingClientRect(),cards=el.querySelector('.SPR_motionAttachments').getBoundingClientRect();return cards.top>=input.bottom&&cards.height>=56&&cards.height<=70;}));
  check('composer has no repeated missing-action or parse instructions',await page.locator('.SPR_motionMissing,.SPR_motionLocalHint').count()===0);
  check('settings moved to header and template controls left the main composer',await page.locator('.SPR_flowComposer').getByRole('button',{name:'处理配置',exact:true}).count()===0&&await page.locator('.SPR_workflowHeader').getByRole('button',{name:'处理配置',exact:true}).count()===1&&await page.locator('.SPR_flowComposer').getByRole('button',{name:'视频提示词模板',exact:true}).count()===0);
  await page.getByRole('button',{name:'清除动作',exact:true}).first().click();
  check('clearing an action returns it to blank and disables send',await page.locator('.SPR_motionActionTrigger').first().innerText()==='选择动作'&&await page.locator('.SPR_flowSend').isDisabled());
  check('clearing an action also disables reference assembly',await referenceTrigger.isDisabled());
  const beforeFailedReference=calls.filter(c=>c.method==='previewMotionReference').length;
  failReferencePreview=true;
  await page.locator('.SPR_motionActionTrigger').first().click();await page.getByRole('option').first().click();await page.getByRole('button',{name:'选择这个动作',exact:true}).click();
  await page.getByRole('alert',{name:'操作提示',exact:true}).waitFor();
  check('automatic preview failures explain the error without opening a preview or submitting a paid video',(await page.getByRole('alert',{name:'操作提示',exact:true}).innerText()).includes('本地测试：预览失败')&&await referenceDialog.count()===0&&calls.filter(c=>c.method==='submitWorkflowRound').length===beforeReferenceSends);
  await page.waitForTimeout(500);
  check('failed automatic previews do not retry in a loop',calls.filter(c=>c.method==='previewMotionReference').length===beforeFailedReference+1);
  await page.keyboard.press('Escape');failReferencePreview=false;
  await page.waitForFunction(()=>!document.querySelector('.SPR_motionReferenceCard button').disabled);
  await page.getByRole('button',{name:'重新合成参考视频',exact:true}).click();
  await page.waitForFunction(()=>{const card=document.querySelector('.SPR_motionReferenceCard');return !card.querySelector('button').disabled&&card.querySelector('img')?.naturalWidth===864;});
  check('a failed local preview can be retried without opening it, saving or generating a video',await referenceDialog.count()===0&&calls.filter(c=>c.method==='previewMotionReference').length===beforeFailedReference+2&&calls.filter(c=>c.method==='saveMotionJob').length===beforeReferenceSaves);
  await referenceTrigger.click();await referenceDialog.locator('video').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('.SPR_motionReferenceCard button').disabled);
  for(const [i,name] of ['character.png','directions.png'].entries()){
    await page.waitForFunction(()=>[...document.querySelectorAll('.SPR_motionAttachmentAdd')].every(button=>!button.disabled));
    await files.nth(i).setInputFiles({name,mimeType:'image/png',buffer:Buffer.from('synthetic upload')});
    await page.locator('.SPR_motionAttachment').nth(i).locator('.SPR_motionAttachmentPreview').waitFor();
    if(i===0){
      check('a filled character overlays its gray caption while empty cards center their labels',await page.locator('.SPR_motionAttachments').evaluate(row=>[...row.children].every(card=>{const label=card.querySelector('.SPR_motionCardCaption,.SPR_motionReferenceCaption'),r=card.getBoundingClientRect(),text=label.getBoundingClientRect(),filled=card.dataset.filled==='true';return getComputedStyle(label).color==='rgb(102, 102, 107)'&&(filled?Math.abs(text.bottom-r.bottom)<2&&getComputedStyle(label).position==='absolute':text.bottom<r.bottom-5&&getComputedStyle(label).position==='static');})));
      await page.locator('.SPR_flowComposer').screenshot({path:'.verify/motion-mixed-card-captions.png'});
    }
  }
  await page.locator('.SPR_motionAttachmentPreview').nth(1).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.SPR_motionAttachmentAdd')].every(button=>!button.disabled));
  const requiredPrompt=page.getByRole('textbox',{name:'本轮补充要求',exact:true}),beforeBlankSends=calls.filter(c=>c.method==='submitWorkflowRound').length;
  check('generation no longer describes its prompt as optional',(await requiredPrompt.getAttribute('placeholder'))==='描述角色动作…');
  for(const value of ['', ' \n\t　 ']){
    await requiredPrompt.fill(value);
    await requiredPrompt.press('Control+Enter');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('gmm-workflow-send',{detail:{module:'sprite',jobId:'wnew'}})));
    check('blank motion instructions block the send button, keyboard and editor event',await page.locator('.SPR_flowSend').isDisabled()&&(await page.locator('.SPR_flowSend').getAttribute('title'))==='请先填写提示词。'&&calls.filter(c=>c.method==='submitWorkflowRound').length===beforeBlankSends&&await page.getByRole('dialog',{name:'确认生成视频',exact:true}).count()===0);
  }
  await requiredPrompt.fill('按白模先行走再奔跑，保持角色外观，原地循环。');
  check('nonempty instructions enable sending once both images and actions are present',await page.locator('.SPR_flowSend').isEnabled());
  await requiredPrompt.fill('');
  check('clearing instructions disables generation again',await page.locator('.SPR_flowSend').isDisabled());
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:760});
    await page.evaluate(width=>document.querySelector('.SPR_root').setAttribute('data-sidebar-collapsed',String(width<900)),width);
    if(width<900)await page.waitForFunction(()=>document.querySelector('.SPR_side').getBoundingClientRect().right<=0);
    await page.waitForFunction(()=>[...document.querySelectorAll('.SPR_motionActionThumb canvas')].length===2);
    check('upload thumbnails, actions and reference preview fill aligned square cards at '+width,await page.locator('.SPR_motionAttachments').evaluate(row=>{const cards=[...row.children],first=cards[0].getBoundingClientRect();return cards.length===5&&cards.every(card=>{const r=card.getBoundingClientRect();return Math.abs(r.width-r.height)<1&&r.width<=64&&Math.abs(r.top-first.top)<1;})&&[...row.querySelectorAll('.SPR_imageResultPreview img')].every(img=>img.complete&&img.naturalWidth>0&&img.getBoundingClientRect().height>30)&&[...row.querySelectorAll('.SPR_motionActionThumb canvas')].every(canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((v,i)=>i%4===3&&v>0));}));
    check('the complete card row starts at the input edge without a leading blank at '+width,await page.locator('.SPR_motionAttachments').evaluate(row=>{const r=row.getBoundingClientRect(),first=row.firstElementChild.getBoundingClientRect();return Math.abs(first.left-r.left-parseFloat(getComputedStyle(row).paddingLeft))<1;}));
    check('upload images extend behind the caption at '+width,await page.locator('.SPR_motionAttachment').evaluateAll(cards=>cards.every(card=>{const image=card.querySelector('img').getBoundingClientRect(),caption=card.querySelector('.SPR_motionCardCaption').getBoundingClientRect(),r=card.getBoundingClientRect();return image.top<=r.top+2&&image.bottom>=r.bottom-2&&image.bottom>caption.top&&image.left<=r.left+2&&image.right>=r.right-2;})));
    check('filled uploads, actions and reference keep equal gray captions at '+width,await page.locator('.SPR_motionAttachments').evaluate(row=>{const labels=[...row.querySelectorAll('.SPR_motionCardCaption')],base=labels[0].getBoundingClientRect();return labels.length===5&&labels.every(label=>Math.abs(label.getBoundingClientRect().bottom-base.bottom)<1.1&&getComputedStyle(label).color==='rgb(102, 102, 107)');}));
    await page.screenshot({path:'.verify/square-motion-uploads-'+width+'.png'});
    const card=page.locator('.SPR_motionAttachment').first();
    await page.mouse.move(0,0);
    check('replace and remove stay hidden until hover at '+width,await card.locator('.SPR_motionAttachmentAdd,.SPR_motionAttachmentRemove').evaluateAll(buttons=>buttons.every(b=>getComputedStyle(b).opacity==='0')));
    await card.hover();
    check('hover reveals square upload controls at '+width,await card.locator('.SPR_motionAttachmentAdd,.SPR_motionAttachmentRemove').evaluateAll(buttons=>buttons.every(b=>getComputedStyle(b).opacity==='1')));
  }
  const thumbnail=page.locator('.SPR_motionActionThumb canvas').first(),frameBefore=await thumbnail.getAttribute('data-frame');
  await page.waitForFunction(frame=>document.querySelector('.SPR_motionActionThumb canvas').dataset.frame!==frame,frameBefore);
  check('selected action cards animate locally without playback controls inside buttons',await page.locator('.SPR_motionActionTrigger .SPR_motionPlaybackControls').count()===0);
  await page.locator('.SPR_motionAttachment').first().getByRole('button',{name:'预览 角色细节参考图',exact:true}).click();
  await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('textbox',{name:'本轮补充要求',exact:true}).fill('切回生成时保留的草稿');
  const generationActions=await page.locator('.SPR_motionActionTrigger').allTextContents();
  await page.getByRole('button',{name:'执行方式',exact:true}).click();await page.getByRole('menuitemradio',{name:'解析视频',exact:true}).click();
  check('parse mode shows only a single video upload',await files.evaluateAll(nodes=>nodes.length===1&&!nodes[0].multiple&&nodes[0].accept.startsWith('video/')));
  await files.first().setInputFiles({name:'directions.mp4',mimeType:'video/mp4',buffer:Buffer.from('mock video upload')});
  await page.locator('.SPR_motionVideoPreview').waitFor();
  await page.waitForFunction(()=>{const video=document.querySelector('.SPR_motionVideoPreview>video');return video?.readyState>=2&&video.videoWidth===160;});
  check('uploaded video shows an actual decoded thumbnail frame',await page.locator('.SPR_motionVideoPreview>video').evaluate(video=>video.readyState>=2&&video.videoHeight===90&&!video.autoplay));
  await page.getByRole('button',{name:'预览视频',exact:true}).click();
  await page.getByRole('dialog',{name:'预览视频',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  check('parse mode has no action picker',await page.locator('.SPR_motionActionTrigger').count()===0&&await page.getByText('按四列两行布局解析，不会自动识别动作。',{exact:true}).count()===0);
  check('parsing keeps review but hides both generation model selectors',await page.getByRole('button',{name:'审核模式',exact:true}).count()===1&&await page.getByRole('button',{name:'切换模型',exact:true}).count()===0);
  check('parse mode has no action-count control',await page.getByRole('button',{name:'动作数量',exact:true}).count()===0&&await files.count()===1);
  check('parse mode hides reference-video assembly',await referenceTrigger.count()===0);
  await page.waitForFunction(()=>!document.querySelector('.SPR_flowSend').disabled).catch(async error=>{console.log('parse disabled reason',await page.locator('.SPR_flowSend').getAttribute('title'));throw error;});
  check('uploading a video switches to parse mode and hides extra prompt input',await page.getByRole('textbox',{name:'本轮补充要求',exact:true}).count()===0&&await page.locator('.SPR_flowSend').isEnabled());
  await page.locator('.SPR_workflowHeader').getByRole('button',{name:'处理配置',exact:true}).click();
  const parseConfig=page.getByRole('dialog',{name:'处理配置',exact:true});
  check('parse configuration has one neutral range and no action confirmation',await parseConfig.getByText('视频范围',{exact:true}).count()===1&&await parseConfig.getByText('开始秒',{exact:true}).count()===1&&await parseConfig.getByRole('checkbox',{name:'已观看并确认这些动作范围',exact:true}).count()===0);
  check('parse defaults to the whole video',await parseConfig.getByRole('spinbutton').nth(0).inputValue()==='0'&&await parseConfig.getByRole('spinbutton').nth(1).inputValue()==='4');
  await parseConfig.getByRole('switch').nth(0).uncheck();
  await parseConfig.getByRole('button',{name:'完成',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.SPR_flowSend').disabled);
  const submittedBefore=calls.filter(c=>c.method==='submitWorkflowRound').length;
  await page.locator('.SPR_flowSend').click();await page.locator('.SPR_flowRound').waitFor();
  const parseCall=calls.filter(c=>c.method==='submitWorkflowRound').at(-1),savedCall=calls.filter(c=>c.method==='saveMotionJob').at(-1);
  check('confirmed video-only parsing sends without a paid confirmation dialog',parseCall.payload.localOnly===true&&calls.filter(c=>c.method==='submitWorkflowRound').length===submittedBefore+1&&await page.getByRole('dialog').count()===0);
  check('parsing saves only clip settings without hidden generation actions',savedCall.payload.segments===undefined&&savedCall.payload.processing.extract===false&&savedCall.payload.videoRange.end===4);
  await page.screenshot({path:'.verify/motion-composer-video-only.png'});
  await files.first().setInputFiles({name:'replacement.mp4',mimeType:'video/mp4',buffer:Buffer.from('replacement fixture')});
  await page.waitForFunction(()=>!document.querySelector('.SPR_flowSend').disabled);
  check('replacing a source video resets to the whole clip without action confirmation',await page.locator('.SPR_flowSend').isEnabled());
  await page.getByRole('button',{name:'执行方式',exact:true}).click();await page.getByRole('menuitemradio',{name:'生成新视频',exact:true}).click();
  check('returning to generation retains its prompt and selected actions',await page.getByRole('textbox',{name:'本轮补充要求',exact:true}).inputValue()==='切回生成时保留的草稿'&&JSON.stringify(await page.locator('.SPR_motionActionTrigger').allTextContents())===JSON.stringify(generationActions));
  const paidBefore=calls.filter(c=>c.method==='submitWorkflowRound').length, optimizationsBefore=calls.filter(c=>c.method==='optimizeMotionPrompt').length;
  await page.getByRole('button',{name:'切换模型',exact:true}).click();await page.getByRole('menuitemradio',{name:'Local vision Local',exact:true}).click();
  check('model switch is directly available in the main composer',await page.locator('.SPR_flowComposer').getByRole('button',{name:'切换模型',exact:true}).count()===1);
  const mainInput=page.getByRole('textbox',{name:'本轮补充要求',exact:true});await mainInput.fill('自然流畅地完成动作');
  await page.getByRole('button',{name:'优化提示词',exact:true}).click();
  const optimizer=page.getByRole('dialog',{name:'优化提示词',exact:true});await optimizer.waitFor();
  check('opening optimizer does not request optimization or generation',calls.filter(c=>c.method==='optimizeMotionPrompt').length===optimizationsBefore&&calls.filter(c=>c.method==='submitWorkflowRound').length===paidBefore);
  check('one collapsed preview replaces both scattered details links',await optimizer.locator('details').count()===0&&await optimizer.getByRole('button',{name:'提示词预览',exact:true}).getAttribute('aria-expanded')==='false'&&await optimizer.locator('.SPR_promptPreviewPanel').count()===0);
  check('the close action is an icon in the top corner',await optimizer.getByRole('button',{name:'关闭',exact:true}).innerText()===''&&await optimizer.getByRole('button',{name:'关闭',exact:true}).locator('svg').count()===1);
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-bg-layer-3:#2e2e33;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'',dark);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:760});
      check('template tools precede equal editors at '+width+' '+dark,await optimizer.evaluate(el=>{const tools=el.querySelector('.SPR_promptPreviewTools').getBoundingClientRect(),editors=[...el.querySelectorAll('.SPR_promptReferenceEditor')].map(n=>n.getBoundingClientRect());return editors.every(r=>r.top>=tools.bottom&&r.width>100)&&Math.abs(editors[0].height-editors[1].height)<1&&(innerWidth<=600||Math.abs(editors[0].top-editors[1].top)<1);}));
      await page.screenshot({path:'.verify/prompt-optimizer-clean-'+width+'-'+(dark?'dark':'light')+'.png'});
    }
  }
  await page.evaluate(()=>document.documentElement.style.cssText='');await page.setViewportSize({width:1440,height:1000});
  await optimizer.getByRole('button',{name:'视频提示词模板',exact:true}).click();await page.getByRole('menuitemradio',{name:'八方向角色动作',exact:true}).click();
  check('template selection uses a themed popover without native select',await optimizer.locator('select').count()===0);
  const previewsBefore=calls.filter(c=>c.method==='previewMotionPrompt').length;
  await optimizer.getByRole('button',{name:'提示词预览',exact:true}).click();
  check('template text is available in the single preview without requesting a model or final composition',await optimizer.getByRole('textbox',{name:'模板内容',exact:true}).inputValue().then(text=>text.includes('{{timeline}}'))&&calls.filter(c=>c.method==='previewMotionPrompt').length===previewsBefore);
  await optimizer.getByRole('tab',{name:'模板内容',exact:true}).press('ArrowRight');
  check('preview tabs support keyboard selection',await optimizer.getByRole('tab',{name:'最终提示词',exact:true}).evaluate(el=>el===document.activeElement&&el.getAttribute('aria-selected')==='true'));
  await optimizer.getByRole('textbox',{name:'最终视频提示词',exact:true}).waitFor();
  check('final video preview uses the unsaved draft without generation',await optimizer.getByRole('textbox',{name:'最终视频提示词',exact:true}).inputValue().then(text=>text.includes('#FF00FF')&&text.includes('自然流畅地完成动作')&&!text.includes('{{'))&&calls.filter(c=>c.method==='submitWorkflowRound').length===paidBefore);
  check('reference mapping has its own row above the final prompt',await optimizer.locator('.SPR_promptPreviewReferences').evaluate(el=>{const text=el.parentElement.querySelector('textarea').getBoundingClientRect(),r=el.getBoundingClientRect();return el.children.length===2&&r.bottom<=text.top&&[...el.children].every(child=>child.getBoundingClientRect().bottom<=r.bottom);}));
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:rgba(29,29,32,.72);--dsw-alias-bg-layer-2:#232326;--dsw-alias-bg-layer-3:#2e2e33;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'--dsw-alias-bg-layer-1:rgba(250,250,250,.72)',dark);
    check('optimizer remains opaque under a translucent theme '+dark,await optimizer.evaluate(el=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle=getComputedStyle(el).backgroundColor;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]===255;}));
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:760});
      check('reference names stay inside the preview without covering prompt text at '+width+' '+dark,await optimizer.locator('.SPR_promptPreviewReferences').evaluate(el=>{const r=el.getBoundingClientRect(),area=el.parentElement.querySelector('textarea').getBoundingClientRect();return r.bottom<=area.top&&[...el.children].every(child=>{const c=child.getBoundingClientRect();return c.left>=r.left&&c.right<=r.right;});}));
      await page.screenshot({path:'.verify/prompt-opaque-references-'+width+'-'+(dark?'dark':'light')+'.png'});
    }
  }
  await page.evaluate(()=>document.documentElement.style.cssText='');await page.setViewportSize({width:1440,height:1000});
  check('optimizer does not repeat the main model switch',await optimizer.getByRole('button',{name:'切换模型',exact:true}).count()===0);
  await page.screenshot({path:'.verify/prompt-optimizer-unified-preview.png'});
  await optimizer.getByRole('button',{name:'提示词预览',exact:true}).click();
  await optimizer.getByRole('textbox',{name:'原提示词',exact:true}).fill('顺畅完成动作，不移动相机');
  await optimizer.getByRole('button',{name:'优化提示词',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="采用优化结果"]')||[...document.querySelectorAll('button')].some(b=>b.textContent==='采用优化结果'&&!b.disabled));
  const optimizedCall=calls.filter(c=>c.method==='optimizeMotionPrompt').at(-1);
  check('one explicit optimization sends selected model and current workflow constraints',calls.filter(c=>c.method==='optimizeMotionPrompt').length===optimizationsBefore+1&&optimizedCall.payload.prompt==='顺畅完成动作，不移动相机'&&optimizedCall.payload.modelSelection.provider==='local'&&optimizedCall.payload.segments.every(s=>s.action)&&optimizedCall.payload.composerVersion===1);
  check('optimized results omit the repeated model label and its reserved row',await optimizer.evaluate(dialog=>!dialog.textContent.includes('DSH模型：')&&[...dialog.querySelectorAll('.SPR_promptSourceActions')].every(row=>row.childElementCount===0&&row.getBoundingClientRect().height===0)));
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'',dark);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:760});
      check('optimized editors leave no model footer at '+width+' '+dark,await optimizer.locator('.SPR_promptCompare').evaluate(compare=>{const rows=[...compare.querySelectorAll('.SPR_promptSourceActions')];return rows.length===2&&rows.every(row=>getComputedStyle(row).display==='none'&&row.getBoundingClientRect().height===0)&&compare.scrollWidth<=compare.clientWidth+1;}));
      await optimizer.screenshot({path:'.verify/prompt-optimizer-no-model-'+width+'-'+(dark?'dark':'light')+'.png'});
    }
  }
  await page.evaluate(()=>document.documentElement.style.cssText='');await page.setViewportSize({width:1440,height:1000});
  await optimizer.getByRole('button',{name:'采用优化结果',exact:true}).click();await optimizer.waitFor({state:'hidden'});
  check('adopting optimization only updates the draft',await mainInput.inputValue()==='顺畅完成动作，不移动相机，固定镜头，动作衔接自然。'&&calls.filter(c=>c.method==='submitWorkflowRound').length===paidBefore);
  await page.getByRole('button',{name:'优化提示词',exact:true}).click();await optimizer.waitFor();
  holdOptimization=true;
  await optimizer.getByRole('button',{name:'优化提示词',exact:true}).click();
  while(!releaseOptimization)await new Promise(resolve=>setTimeout(resolve,10));
  check('optimization shows busy state and blocks a second click',await optimizer.getByRole('button',{name:'优化提示词',exact:true}).isDisabled());
  await optimizer.getByRole('button',{name:'视频提示词模板',exact:true}).click();await page.getByRole('menuitemradio',{name:'不使用模板',exact:true}).click();
  holdOptimization=false;releaseOptimization();
  await optimizer.getByText('提示词、模板、参考图或背景设置已修改，请重新优化后再采用。',{exact:true}).waitFor();
  check('an in-flight result cannot overwrite changed template constraints',await optimizer.getByRole('button',{name:'采用优化结果',exact:true}).isDisabled());
  await optimizer.getByRole('button',{name:'视频提示词模板',exact:true}).click();await page.getByRole('menuitemradio',{name:'八方向角色动作',exact:true}).click();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:760});
    check('video optimizer fits '+width,await optimizer.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&el.scrollWidth<=el.clientWidth+1;}));
    await page.screenshot({path:'.verify/video-optimizer-'+width+'.png'});
  }
  await page.setViewportSize({width:1440,height:1000});
  await optimizer.getByRole('button',{name:'管理模板',exact:true}).click();
  const manager=page.getByTestId('prompt-template-manager');await manager.waitFor();
  await page.evaluate(()=>document.documentElement.style.setProperty('--dsw-alias-bg-layer-1','rgba(250,250,250,.72)'));
  check('template manager header matches an opaque dialog surface',await manager.evaluate(el=>{const dialog=el.closest('dialog'),head=dialog.querySelector('.SPR_chatRequestHead'),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),bg=getComputedStyle(dialog).backgroundColor;ctx.fillStyle=bg;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]===255&&getComputedStyle(head).backgroundColor===bg;}));
  const saveGroup=manager.locator('.SPR_templateManagerActions');
  const neutralSaveSurface=await saveGroup.evaluate(el=>getComputedStyle(el).backgroundColor);
  check('unchanged Save and dropdown share one neutral surface',await saveGroup.evaluate(el=>el.dataset.ready==='false'&&getComputedStyle(el.firstElementChild).opacity==='1'&&[...el.querySelectorAll(':scope>button,:scope>.SPR_imageResultActions>button')].every(button=>getComputedStyle(button).backgroundColor==='rgba(0, 0, 0, 0)')));
  await page.screenshot({path:'.verify/template-manager-opaque-header.png'});
  await page.evaluate(()=>document.documentElement.style.cssText='');
  check('video opens the unified themed template editor',await manager.getByRole('textbox',{name:'模板内容',exact:true}).count()===1&&await manager.locator('select').count()===0);
  check('unified manager starts in video type with a protected built-in',await manager.getByRole('button',{name:'模板类型',exact:true}).isDisabled()&&await manager.getByRole('textbox',{name:'模板名称',exact:true}).inputValue()==='八方向角色动作');
  await manager.getByRole('group',{name:'模板分类',exact:true}).getByRole('button',{name:'图片',exact:true}).click();
  check('image filter displays the image catalog in the same editor',await manager.locator('.SPR_promptTemplateChoice').count()===3);
  await manager.getByRole('group',{name:'模板分类',exact:true}).getByRole('button',{name:'视频',exact:true}).click();
  await manager.getByRole('button',{name:'新增模板',exact:true}).click();
  await manager.getByRole('textbox',{name:'模板名称',exact:true}).fill('自定义动作视频');await manager.getByRole('textbox',{name:'模板内容',exact:true}).fill('{{description}} / {{timeline}} / {{keyColor}}');
  check('editing highlights both action segments consistently',await saveGroup.evaluate((el,neutral)=>{const buttons=el.querySelectorAll(':scope>button,:scope>.SPR_imageResultActions>button');return !buttons[0].disabled&&getComputedStyle(el).backgroundColor!==neutral&&getComputedStyle(buttons[0]).color===getComputedStyle(buttons[1]).color&&getComputedStyle(buttons[0]).boxShadow==='none';},neutralSaveSurface));
  await manager.getByRole('group',{name:'模板分类',exact:true}).getByRole('button',{name:'图片',exact:true}).click();
  await manager.getByRole('group',{name:'模板分类',exact:true}).getByRole('button',{name:'视频',exact:true}).click();
  await manager.locator('.SPR_promptTemplateChoice').last().click();
  check('switching template types retains unsaved edits',await manager.getByRole('textbox',{name:'模板名称',exact:true}).inputValue()==='自定义动作视频');
  await manager.getByRole('button',{name:'保存模板',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.SPR_templateManagerActions button').disabled);
  const saveCall=calls.filter(c=>c.method==='saveConfig').at(-1);
  check('one save retains image and video type fields',saveCall.payload.promptTemplates.length===5&&saveCall.payload.promptTemplates.filter(t=>t.type==='video').length===2);
  await page.getByTestId('notice-popup').getByRole('button',{name:'关闭提示',exact:true}).click();
  await page.screenshot({path:'.verify/motion-template-management.png'});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:700});
    check('video template editor fits '+width,await manager.evaluate(el=>{const dialog=el.closest('dialog'),r=dialog.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&dialog.scrollWidth<=dialog.clientWidth+1;}));
    await page.screenshot({path:'.verify/motion-template-'+width+'.png'});
  }
  await page.keyboard.press('Escape');
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
  // The image optimizer shares the toolbar and preview, including legacy saved text.
  await page.evaluate(templates=>{
    window.imagePreviewCalls=[];
    window.imageOptimizerApi={
      getPromptOptimizerModel:()=>api.getPromptOptimizerModel(),
      previewImagePrompt:async payload=>{imagePreviewCalls.push(payload);return {prompt:payload.prompt+'\n'+payload.suffix,references:[]};}
    };
    function ImageOptimizerHarness(){
      const [prompt,setPrompt]=React.useState('修改成女性角色，保留服装');
      const [suffix,setSuffix]=React.useState('未关联模板的历史基础提示词');
      const [templateId,setTemplateId]=React.useState(undefined);
      return React.createElement(bundle.__test.PromptOptimizer,{api:imageOptimizerApi,jobId:'image-layout-fixture',prompt,suffix,templates,templateId,references:[],onApply:setPrompt,onManageTemplates:()=>{},onTemplateApply:id=>{setTemplateId(id);setSuffix(templates.find(t=>t.id===id)?.prompt.zh||'');}});
    }
    root.render(React.createElement(ImageOptimizerHarness));
  },templatesOfType(config.promptTemplates,'image'));
  await page.getByRole('button',{name:'优化提示词',exact:true}).click();
  const imageOptimizer=page.getByRole('dialog',{name:'优化提示词',exact:true});await imageOptimizer.waitFor();
  check('image optimizer uses the same collapsed preview and themed template menu',await imageOptimizer.locator('select,details').count()===0&&await imageOptimizer.getByRole('button',{name:'提示词预览',exact:true}).getAttribute('aria-expanded')==='false');
  await imageOptimizer.getByRole('button',{name:'基础提示词',exact:true}).click();
  const templateMenu=page.getByRole('menu');
  await templateMenu.getByRole('menuitemradio',{name:'不使用模板',exact:true}).click();
  check('switching a legacy custom suffix still asks before replacing it',await imageOptimizer.getByRole('status').innerText().then(text=>text.includes('套用会替换')));
  await imageOptimizer.getByRole('button',{name:'取消',exact:true}).click();
  await imageOptimizer.getByRole('button',{name:'提示词预览',exact:true}).click();
  check('canceling template replacement preserves historical content',await imageOptimizer.getByRole('textbox',{name:'模板内容',exact:true}).inputValue()==='未关联模板的历史基础提示词');
  await imageOptimizer.getByRole('tab',{name:'最终提示词',exact:true}).click();
  await imageOptimizer.getByRole('textbox',{name:'最终生图提示词',exact:true}).waitFor();
  check('image final preview includes the draft and saved template',await imageOptimizer.getByRole('textbox',{name:'最终生图提示词',exact:true}).inputValue()==='修改成女性角色，保留服装\n未关联模板的历史基础提示词');
  await imageOptimizer.getByRole('textbox',{name:'原提示词',exact:true}).fill('改为女骑士');
  await page.waitForFunction(()=>document.querySelector('[aria-label="最终生图提示词"]')?.value.startsWith('改为女骑士'));
  check('final image preview follows unsaved source edits',await page.evaluate(()=>imagePreviewCalls.at(-1).prompt==='改为女骑士'));
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:760});
    await imageOptimizer.getByRole('button',{name:'基础提示词',exact:true}).click();
    check('image template menu stays within the viewport at '+width,await templateMenu.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
    await page.screenshot({path:'.verify/image-optimizer-template-menu-'+width+'.png'});
    await page.keyboard.press('Escape');
    check('Escape closes only the template menu at '+width,await imageOptimizer.isVisible()&&await templateMenu.count()===0);
  }
  await imageOptimizer.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'优化提示词',exact:true}).click();
  check('reopening the optimizer keeps the draft and collapses the preview',await imageOptimizer.getByRole('textbox',{name:'原提示词',exact:true}).inputValue()==='改为女骑士'&&await imageOptimizer.getByRole('button',{name:'提示词预览',exact:true}).getAttribute('aria-expanded')==='false');
  check('shared optimizer has no native dialogs or browser errors',errors.length===0&&outbound.length===0);
  // A reference belongs to the round that consumed it, even when it was an earlier result.
  await page.evaluate(()=>{
    const h=React.createElement,ref={file:'refs/from-round1.png',name:'第1轮.png'},extra={file:'refs/new.png',name:'新参考.png'};
    const request={prompt:'生成角色',settings:{size:'1024x1024'},refs:[],referenceFiles:[],keying:{enabled:false}};
    const first={id:'image-v1',batchId:'image-r1',roundId:'image-r1',createdAt:1,kind:'generated',request,item:{versionId:'image-v1',roundId:'image-r1',index:0,status:'ready',file:'out/first.png'}};
    const nextRequest={...request,prompt:'根据@图片1生成八方向外观',refs:[ref],referenceFiles:[ref.file]};
    const second={id:'image-v2',batchId:'image-r2',roundId:'image-r2',createdAt:2,kind:'generated',request:nextRequest,item:{versionId:'image-v2',roundId:'image-r2',index:0,status:'ready',file:'out/second.png'}};
    function ImageCardsHarness(){
      const [refs,setRefs]=React.useState([ref,extra]);
      const job={id:'image-card-fixture',name:'八方向素材测试',assetBase:'/assets/image-card-fixture/',updatedAt:3,refs,history:[first,second],items:[second.item],log:[]};
      return h('main',{className:'SPR_main SPR_imageMain',style:{height:'100%'}},h(bundle.__test.ImageConversation,{api,job,busy:false,keyingBusy:false,
        renderResult:item=>h('img',{src:job.assetBase+item.file,alt:'角色结果',style:{display:'block',width:'100%',height:240,objectFit:'contain'}}),
        onReference:item=>{window.addedReference=item.file;},onReuse:async()=>{},onRegenerate:async()=>{},onHistory:async()=>true,onUpload:async()=>{},
        parameters:h('div'),keying:h('div'),
        composer:h('div',{className:'SPR_chatInputCard'},h('div',{className:'SPR_chatComposerRefs'},h(bundle.__test.ImageReferenceList,{compact:true,references:refs,assetBase:job.assetBase,onRemove:item=>setRefs(values=>values.filter(value=>value.file!==item.file))})),h('textarea',{className:'SPR_flowInput','aria-label':'描述图片',defaultValue:'生成同一角色的八方向外观'}))}));
    }
    root.render(h(ImageCardsHarness));
  });
  const imageCards=page.locator('.SPR_chatComposerRefs .SPR_imageRefItem');await imageCards.first().waitFor();
  check('unkeyed image results omit the redundant original label and keep bookmark and transfer actions',await page.locator('.SPR_chatVersionBar').count()===2&&await page.locator('.SPR_chatVersionLabel').count()===0&&await page.locator('.SPR_chatVersionBar>.SPR_imageBookmark').count()===2&&await page.locator('.SPR_assetTransfer').count()===2);
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'',dark);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:760});
      await page.waitForFunction(()=>[...document.querySelectorAll('.SPR_chatComposerRefs img')].every(image=>image.complete&&image.naturalWidth));
      check('image references use square thumbnails with overlapping gray captions at '+width+' '+dark,await imageCards.evaluateAll((cards,dark)=>cards.every(card=>{const r=card.getBoundingClientRect(),image=card.querySelector('img').getBoundingClientRect(),caption=card.querySelector('.SPR_imageRefDetails').getBoundingClientRect(),label=card.querySelector('.SPR_imageRefLabel');return Math.abs(r.width-r.height)<1&&r.width<=64&&image.top<=r.top+2&&image.bottom>=r.bottom-2&&caption.top<image.bottom&&getComputedStyle(label).color===(dark?'rgb(170, 170, 177)':'rgb(102, 102, 107)');}),dark));
      check('image reference cards share one row at '+width,await imageCards.evaluateAll(cards=>Math.abs(cards[0].getBoundingClientRect().top-cards[1].getBoundingClientRect().top)<1));
      await page.mouse.move(0,0);
      check('image reference remove icons are hidden without hover at '+width,await imageCards.locator('.SPR_imageRefRemove').evaluateAll(buttons=>buttons.every(button=>getComputedStyle(button).opacity==='0'&&button.textContent==='')));
      await page.locator('.SPR_chatInputCard').screenshot({path:'.verify/image-upload-overlays-'+width+'-'+(dark?'dark':'light')+'.png'});
    }
  }
  await imageCards.first().getByRole('button',{name:/^预览 /}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');
  check('image reference preview closes and restores focus',await imageCards.first().getByRole('button',{name:/^预览 /}).evaluate(button=>button===document.activeElement));
  await imageCards.nth(1).hover();await imageCards.nth(1).getByRole('button',{name:'移除 新参考.png',exact:true}).click();
  check('overlay remove icon only removes its own draft reference',await imageCards.count()===1&&await imageCards.first().locator('.SPR_imageRefLabel').innerText()==='@图片1');
  await page.getByRole('button',{name:'项目素材',exact:true}).click();
  const materialPanel=page.getByRole('dialog',{name:'项目素材',exact:true});await materialPanel.waitFor();
  check('submitted references have no separate global reference group',await materialPanel.locator('[data-group=references]').count()===0);
  check('first round keeps its result and second round labels the reference alongside its result',await materialPanel.locator('[data-group="round:1"] .SPR_chatMaterial[data-kind=original]').count()===1&&await materialPanel.locator('[data-group="round:2"] .SPR_chatMaterial[data-kind=reference]').count()===1&&await materialPanel.locator('[data-group="round:2"] .SPR_chatMaterial[data-kind=original]').count()===1&&await materialPanel.locator('[data-group="round:2"] .SPR_chatMaterial[data-kind=reference] .SPR_chatMaterialHead').innerText().then(text=>text.includes('参考图')));
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.style.cssText=dark?'--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338':'',dark);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:760});
      check('round-grouped materials fit '+width+' '+dark,await materialPanel.locator('.SPR_chatPanel').evaluate(panel=>{const r=panel.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&panel.scrollWidth<=panel.clientWidth+1;}));
      await page.screenshot({path:'.verify/material-reference-rounds-'+width+'-'+(dark?'dark':'light')+'.png'});
    }
  }
  await materialPanel.locator('[data-group="round:2"] .SPR_chatMaterial[data-kind=reference]').getByRole('button',{name:'加入输入框',exact:true}).click();
  check('reference materials keep their exact file when reused',await page.evaluate(()=>window.addedReference==='refs/from-round1.png'));
  check('card and transfer checks made no browser errors or external requests',errors.length===0&&outbound.length===0);
  check('card fixtures leave no error toast behind',await page.locator('[data-testid=notice-popup][data-kind=error]').count()===0);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'本轮更多操作',exact:true}).last().click();
  await page.screenshot({path:'.verify/image-reuse-menu-390-dark.png'});
  await page.keyboard.press('Escape');
  console.log({errors,outbound});console.log('Passed '+checks+' workflow conversation browser checks. No paid requests.');
}catch(failure){
  const failurePage=browser.contexts()[0]?.pages()[0];
  if(failurePage){
    await failurePage.screenshot({path:'.verify/workflow-chat-failure.png'});
    console.log('Browser failure context',await failurePage.locator('.SPR_flowComposerError,[role=dialog],[data-testid=notice-popup]').allTextContents(),calls.slice(-12),errors);
    console.log('Card captions',await failurePage.locator('.SPR_motionCardCaption').evaluateAll(labels=>labels.map(label=>({text:label.textContent,rect:label.getBoundingClientRect().toJSON(),color:getComputedStyle(label).color,position:getComputedStyle(label).position}))));
  }
  throw failure;
}finally{await browser.close();await rm(referenceHome,{recursive:true,force:true});}
