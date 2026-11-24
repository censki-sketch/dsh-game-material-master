/** Real Chromium + the bundled motion PNGs. No credentials or external API calls. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const home = await mkdtemp(join(tmpdir(), 'gmm-motion-preview-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
let browser, checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('✓ ' + name); };
try {
  const { motionCatalog, motionTemplatePreview } = await import('../lib/motiongen.js');
  const catalog = await motionCatalog(), calls = [], errors = [], outbound = [], commits = [];
  await mkdir('.verify', { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push('Native ' + dialog.type()); void dialog.dismiss(); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://gmm.test') { outbound.push(url.href); return route.abort(); }
    return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
  });
  await page.goto('http://gmm.test');
  await page.setContent(`<meta charset="utf-8"><style>
    :root{--dsw-alias-label-primary:#242428;--dsw-alias-label-secondary:#66666b;--dsw-alias-label-tertiary:#8c8c92;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:#f3f3f5;--dsw-alias-bg-layer-3:#eee;--dsw-alias-border-l2:#dedee2;--dsw-alias-state-business-primary:#4977ff;--dsw-alias-interactive-bg-hover-solid:#eaeaec}
    body{margin:0;font:14px system-ui;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
    #root{height:100dvh}#panel{container-type:inline-size;width:320px;padding:16px}
    </style><div id="root"><div id="panel"></div></div>`);
  await page.addScriptTag({ path: resolve(process.env.REACT_TEST_ROOT || '.verify', 'react.js') });
  await page.addScriptTag({ path: resolve(process.env.REACT_TEST_ROOT || '.verify', 'react-dom.js') });
  await page.evaluate(() => { window.__ModuleLoader__ = { load: r => window.bundle = r.factory(n => { if (n === 'react') return React; throw Error(n); }) }; });
  await page.addScriptTag({ path: 'lib/client.js' });
  let hold = false, release;
  await page.exposeFunction('previewLocal', async payload => {
    calls.push(payload);
    if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
    return motionTemplatePreview(payload.action, payload.direction);
  });
  await page.exposeFunction('commitLocal', value => commits.push(value));
  await page.evaluate(templates => {
    const style = document.createElement('style'); style.textContent = bundle.__test.CSS; document.head.append(style);
    window.root = ReactDOM.createRoot(document.getElementById('panel'));
    root.render(React.createElement(bundle.__test.MotionActionPicker, {
      api: { getMotionTemplatePreview: payload => previewLocal(payload) }, action: templates[0].key,
      templates, onChange: value => commitLocal(value)
    }));
  }, catalog.actions);
  const trigger = page.locator('.SPR_motionActionTrigger');
  const dialog = page.getByRole('dialog', { name: '动作预览', exact: true });
  const list = dialog.getByRole('listbox'), image = dialog.locator('.SPR_motionPreviewViewport img');
  const canvas = dialog.locator('.SPR_motionTemplateStage canvas');
  const waitImage = () => page.waitForFunction(() => {
    const img = document.querySelector('.SPR_motionPreviewViewport img');
    return img?.complete && img.naturalWidth > 0 && document.querySelector('.SPR_motionTemplateStage canvas') && document.querySelector('.SPR_motionPreviewViewport').dataset.loading === 'false';
  });
  await trigger.click(); await waitImage();
  const hiddenScrollbar = await list.evaluate(el => getComputedStyle(el).scrollbarColor);
  check('the action scrollbar is transparent before scrolling', hiddenScrollbar === 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
  const listBeforeScroll = await list.boundingBox();
  await list.hover(); await page.mouse.wheel(0, 160);
  await page.waitForFunction(() => document.querySelector('.SPR_motionActionList').dataset.scrolling === 'true');
  check('wheeling reveals only the active scrollbar', await list.evaluate(el => el.scrollTop > 0 && getComputedStyle(el).scrollbarColor !== 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)' && !el.closest('dialog').hasAttribute('data-scrolling')));
  await page.waitForFunction(() => !document.querySelector('.SPR_motionActionList').hasAttribute('data-scrolling'));
  const listAfterScroll = await list.boundingBox();
  check('the thumb hides after scrolling without changing list geometry', await list.evaluate(el => getComputedStyle(el).scrollbarColor) === hiddenScrollbar && JSON.stringify(listBeforeScroll) === JSON.stringify(listAfterScroll));
  await list.evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: '.verify/motion-preview-structure.png' });
  check('preview and action list are two sibling columns', await dialog.locator('.SPR_motionActionLayout').evaluate(el =>
    el.children.length === 2 && el.children[0].classList.contains('SPR_motionActionSidebar') && el.children[1].classList.contains('SPR_motionActionPreview')));
  const search=dialog.getByRole('searchbox',{name:'搜索动作',exact:true});
  check('search receives focus without opening the explanation',await search.evaluate(el=>document.activeElement===el)&&await dialog.getByRole('tooltip').count()===0);
  const help=dialog.getByRole('button',{name:'查看动作预览说明',exact:true});
  await help.hover();await dialog.getByRole('tooltip').waitFor();
  check('local-only explanation is inside the title tooltip',await dialog.getByRole('tooltip').innerText()==='内置动作预览，不会调用生成模型'&&await dialog.locator('.SPR_motionActionHint').count()===0);
  await page.mouse.move(1,1);await dialog.getByRole('tooltip').waitFor({state:'hidden'});await search.click();
  const searchesBefore=calls.length;
  await search.fill(catalog.actions[0].name);
  check('search filters Chinese action names',await list.getByRole('option').count()===1&&await list.getByRole('option').first().innerText().then(text=>text.includes(catalog.actions[0].originalName)));
  await search.fill(catalog.actions[0].originalName.toUpperCase());
  check('search accepts case-insensitive original names',await list.getByRole('option').count()===1);
  await page.keyboard.press('ArrowDown');
  check('search and action list support keyboard navigation',await list.getByRole('option').first().evaluate(el=>document.activeElement===el));
  await search.fill('no-such-action-xyz');
  check('empty search results show a themed empty state',await list.getByRole('option').count()===0&&await dialog.getByText('没有匹配的动作',{exact:true}).count()===1);
  await dialog.getByRole('button',{name:'清除搜索',exact:true}).click();
  check('clearing search restores the catalog without model or preview calls',await list.getByRole('option').count()===catalog.actions.length&&calls.length===searchesBefore&&commits.length===0);
  check('preview is never nested inside the scroll list', await list.locator('.SPR_motionActionPreview').count() === 0);
  check('the bundled PNG draws one visible frame', await canvas.evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  }));
  check('only a single native-size frame is displayed', await canvas.evaluate(el => el.width === 126 && el.height === 132) && !await image.isVisible());
  const previewCalls = calls.length;
  await page.waitForFunction(() => Number(document.querySelector('.SPR_motionTemplateStage canvas').dataset.frame) > 2);
  check('preview starts playing automatically', await dialog.locator('.SPR_motionTemplatePlayer').getAttribute('data-playing') === 'true');
  check('playback loops through the animation', await page.evaluate(() => new Promise(resolve => {
    const canvas = document.querySelector('.SPR_motionTemplateStage canvas'), deadline = performance.now() + 2500;
    let previous = Number(canvas.dataset.frame);
    const sample = () => {
      const frame = Number(canvas.dataset.frame);
      if (frame < previous) return resolve(true);
      if (performance.now() > deadline) return resolve(false);
      previous = frame; requestAnimationFrame(sample);
    };
    sample();
  })));
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  const paused = await canvas.getAttribute('data-frame'); await page.waitForTimeout(180);
  check('pause holds the current frame', await canvas.getAttribute('data-frame') === paused);
  check('paused canvas matches the exact atlas cell', await canvas.evaluate((canvas, spec) => {
    const index = Number(canvas.dataset.frame), img = document.querySelector('.SPR_motionPreviewViewport img');
    const expected = document.createElement('canvas'); expected.width = spec.width; expected.height = spec.height;
    const ctx = expected.getContext('2d'); ctx.drawImage(img, index % 8 * spec.width, Math.floor(index / 8) * spec.height, spec.width, spec.height, 0, 0, spec.width, spec.height);
    const a = ctx.getImageData(0, 0, spec.width, spec.height).data;
    const b = canvas.getContext('2d').getImageData(0, 0, spec.width, spec.height).data;
    return a.every((value, i) => value === b[i]);
  }, catalog));
  await dialog.getByRole('button', { name: '播放', exact: true }).focus(); await page.keyboard.press('Space');
  await page.waitForFunction(frame => document.querySelector('.SPR_motionTemplateStage canvas').dataset.frame !== frame, paused);
  check('keyboard play resumes from the paused position', await dialog.getByRole('button', { name: '暂停', exact: true }).count() === 1);
  await dialog.getByRole('button', { name: '重播', exact: true }).click();
  check('replay restarts the animation', Number(await canvas.getAttribute('data-frame')) < 5 && await dialog.locator('.SPR_motionTemplatePlayer').getAttribute('data-playing') === 'true');
  check('playback controls make no additional API calls', calls.length === previewCalls);
  for (const key of ['die1', 'fightidle']) {
    const spec = catalog.actions.find(action => action.key === key);
    await list.getByRole('option').nth(catalog.actions.indexOf(spec)).click(); await waitImage();
    const measured = await canvas.evaluate(async canvas => {
      const before = Number(canvas.dataset.frame), start = performance.now();
      await new Promise(resolve => setTimeout(resolve, 350));
      return { before, after: Number(canvas.dataset.frame), elapsed: performance.now() - start };
    });
    const moved = (measured.after - measured.before + spec.frames) % spec.frames;
    const expected = measured.elapsed / spec.frameDurationsMs[0] % spec.frames;
    check('playback uses the template frame duration for ' + key, Math.min(Math.abs(moved - expected), spec.frames - Math.abs(moved - expected)) < 3);
  }
  await dialog.getByRole('button',{name:'八方向同时预览',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.SPR_motionDirectionCell canvas').length===8);
  check('all directions use the eight real local template views',await dialog.locator('.SPR_motionDirectionCell').count()===8&&new Set(calls.slice(-8).map(call=>call.direction)).size===8);
  check('eight directions expose one shared set of playback controls',await dialog.getByRole('group',{name:'播放控制',exact:true}).count()===1&&await dialog.locator('.SPR_motionDirectionGrid').count()===0);
  await page.waitForFunction(()=>Number(document.querySelector('.SPR_motionDirectionCell canvas')?.dataset.frame)>1);
  check('all direction animations advance on the same frame',await dialog.locator('.SPR_motionDirectionCell canvas').evaluateAll(nodes=>new Set(nodes.map(el=>el.dataset.frame)).size===1));
  await dialog.getByRole('button',{name:'暂停',exact:true}).click();
  const eightPaused=await dialog.locator('.SPR_motionDirectionCell canvas').first().getAttribute('data-frame');await page.waitForTimeout(160);
  check('one pause holds all eight directions',await dialog.locator('.SPR_motionDirectionCell canvas').evaluateAll((nodes,frame)=>nodes.every(el=>el.dataset.frame===frame),eightPaused));
  check('each direction matches the exact corresponding atlas cell',await dialog.locator('.SPR_motionTemplatePlayer').evaluate(el=>{
    const images=[...el.querySelectorAll('img')],canvases=[...el.querySelectorAll('canvas')];
    return canvases.every((canvas,i)=>{const index=Number(canvas.dataset.frame),image=images[i],expected=document.createElement('canvas');expected.width=canvas.width;expected.height=canvas.height;const context=expected.getContext('2d');context.drawImage(image,index%8*canvas.width,Math.floor(index/8)*canvas.height,canvas.width,canvas.height,0,0,canvas.width,canvas.height);const a=context.getImageData(0,0,canvas.width,canvas.height).data,b=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;return a.every((value,p)=>value===b[p]);});
  }));
  const eightCalls=calls.length;
  await dialog.getByRole('button',{name:'重播',exact:true}).click();
  check('shared replay starts every direction without additional requests',await dialog.locator('.SPR_motionDirectionCell canvas').evaluateAll(nodes=>nodes.every(el=>Number(el.dataset.frame)<5))&&calls.length===eightCalls);
  await page.screenshot({path:'.verify/motion-preview-eight-directions.png'});
  await dialog.getByRole('button',{name:'单方向',exact:true}).click();await waitImage();
  check('single-direction preview remains available',await canvas.count()===1&&await dialog.locator('.SPR_motionDirectionGrid button').count()===8);
  check('close button uses the X icon', await dialog.getByRole('button', { name: '关闭', exact: true }).locator('svg path').getAttribute('d') === 'm6 6 12 12M6 18 18 6');
  const before = await dialog.locator('.SPR_motionActionPreview').boundingBox();
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const after = await dialog.locator('.SPR_motionActionPreview').boundingBox();
  check('scrolling the list leaves the preview fixed', await list.evaluate(el => el.scrollTop > 0) && Math.abs(before.y - after.y) < 1);
  await list.getByRole('option').last().click(); await waitImage();
  check('the last action is reachable and previews its own frames', calls.at(-1).action === catalog.actions.at(-1).key);
  await dialog.locator('.SPR_motionDirectionGrid button').nth(1).click(); await waitImage();
  check('switching direction requests the selected action and direction', calls.at(-1).direction === 'back' && calls.at(-1).action === catalog.actions.at(-1).key);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  check('cancel never changes the selected action', commits.length === 0);
  check('cancel restores focus to the trigger', await trigger.evaluate(el => el === document.activeElement));
  await trigger.click(); await waitImage();
  check('reopening restores the committed action and front direction', await list.getByRole('option').first().getAttribute('aria-selected') === 'true' && calls.at(-1).direction === 'front');
  await list.getByRole('option').last().click(); await waitImage();
  await dialog.getByRole('button', { name: '选择这个动作', exact: true }).click();
  check('confirm commits exactly the requested action once', commits.length === 1 && commits[0] === catalog.actions.at(-1).key);

  for (const dark of [false, true]) {
    await page.evaluate(dark => {
      document.documentElement.style.cssText = dark ? '--dsw-alias-label-primary:#efeff1;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-label-tertiary:#777780;--dsw-alias-bg-layer-1:#1d1d20;--dsw-alias-bg-layer-2:#232326;--dsw-alias-bg-layer-3:#2e2e33;--dsw-alias-border-l2:#3b3b42;--dsw-alias-interactive-bg-hover-solid:#333338' : '';
    }, dark);
    for (const [width, height] of [[1440, 900], [768, 620], [390, 700], [768, 480]]) {
      await page.setViewportSize({ width, height }); await trigger.click(); await waitImage();
      const label = `${width}x${height} ${dark ? 'dark' : 'light'}`;
      const geometry = await dialog.evaluate(el => {
        const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const list = el.querySelector('.SPR_motionActionList'), preview = el.querySelector('.SPR_motionActionPreview');
        return { dialog: box(el), list: box(list), preview: box(preview), viewport: box(el.querySelector('.SPR_motionPreviewViewport')), img: box(el.querySelector('canvas')), controls: box(el.querySelector('.SPR_motionPlaybackControls')), footer: box(el.querySelector('.SPR_motionActionActions')), overflow: el.scrollHeight > el.clientHeight + 1 };
      });
      check('dialog and footer fit the viewport at ' + label, geometry.dialog.left >= 0 && geometry.dialog.right <= width && geometry.dialog.top >= 0 && geometry.dialog.bottom <= height && geometry.footer.bottom <= geometry.dialog.bottom && !geometry.overflow);
      check('preview follows the available dialog width at ' + label, width > 600 ? geometry.preview.left >= geometry.list.right : geometry.preview.top >= geometry.list.bottom);
      check('image stays visible and inside its viewport at ' + label, geometry.img.width > 60 && geometry.img.height > 40 && geometry.img.left >= geometry.viewport.left && geometry.img.right <= geometry.viewport.right + 1 && geometry.img.top >= geometry.viewport.top && geometry.img.bottom <= geometry.viewport.bottom + 1);
      check('playback controls stay under the animation at ' + label, geometry.controls.top >= geometry.img.bottom && geometry.controls.bottom <= geometry.viewport.bottom);
      check('action list scrolls independently at ' + label, await list.evaluate(el => el.scrollHeight > el.clientHeight));
      await page.screenshot({ path: `.verify/motion-preview-${width}x${height}-${dark ? 'dark' : 'light'}.png` });
      await dialog.getByRole('button',{name:'八方向同时预览',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('.SPR_motionDirectionCell canvas').length===8);
      await page.screenshot({path:`.verify/motion-preview-eight-${width}x${height}-${dark?'dark':'light'}.png`});
      check('eight directions and shared controls fit at '+label,await dialog.evaluate(el=>{const viewport=el.querySelector('.SPR_motionPreviewViewport').getBoundingClientRect(),controls=el.querySelector('.SPR_motionPlaybackControls').getBoundingClientRect(),cells=[...el.querySelectorAll('.SPR_motionDirectionCell')];return cells.length===8&&controls.bottom<=viewport.bottom&&cells.every(cell=>{const r=cell.getBoundingClientRect();return r.width>20&&r.height>24&&r.left>=viewport.left&&r.right<=viewport.right&&r.top>=viewport.top&&r.bottom<=controls.top;});}));
      await page.screenshot({path:`.verify/motion-preview-eight-${width}x${height}-${dark?'dark':'light'}.png`});
      await page.keyboard.press('Escape');
      check('Escape closes and restores focus at ' + label, await dialog.count() === 0 && await trigger.evaluate(el => el === document.activeElement));
    }
  }
  // A late local response must not replace the next action's preview.
  await page.setViewportSize({ width: 768, height: 620 }); await trigger.click(); await waitImage();
  hold = true;
  await list.getByRole('option').last().click();
  await page.waitForFunction(() => document.querySelector('.SPR_motionPreviewViewport').dataset.loading === 'true');
  check('switching action clears the stale image while loading', await image.count() === 0);
  await list.getByRole('option').nth(1).click(); await waitImage();
  const latestSrc = await image.getAttribute('src'); release();
  await page.waitForTimeout(150);
  check('late response cannot replace a newer action preview', await image.getAttribute('src') === latestSrc);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  check('X closes without another commit', await dialog.count() === 0 && commits.length === 1);
  await page.evaluate(templates=>{
    root.render(React.createElement(bundle.__test.MotionActionPicker,{api:{getMotionTemplatePreview:payload=>previewLocal(payload)},action:templates[0].key,templates,compact:true,onChange:value=>commitLocal(value)}));
  },catalog.actions);
  await page.waitForFunction(()=>document.querySelector('[data-compact=true] canvas'));
  check('selected action animation fills the card behind its caption',await page.locator('.SPR_motionActionControl').evaluate(el=>{const card=el.getBoundingClientRect(),thumb=el.querySelector('.SPR_motionActionThumb').getBoundingClientRect(),caption=el.querySelector('.SPR_motionActionTriggerText').getBoundingClientRect();return thumb.height>=card.height-2&&caption.top<thumb.bottom&&caption.bottom<=card.bottom&&getComputedStyle(el.querySelector('.SPR_motionActionTriggerText')).position==='absolute';}));
  await page.screenshot({path:'.verify/motion-action-card-expanded.png'});
  check('no native dialogs or browser errors', errors.length === 0);
  check('no external requests', outbound.length === 0);
  console.log(`Motion preview browser: ${checks} checks passed.`);
} finally {
  await browser?.close();
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  assert.ok(resolve(home).startsWith(resolve(tmpdir(), 'gmm-motion-preview-')));
  await rm(home, { recursive: true, force: true });
}
