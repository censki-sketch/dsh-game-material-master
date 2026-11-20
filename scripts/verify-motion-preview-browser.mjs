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
  const waitImage = () => page.waitForFunction(() => {
    const img = document.querySelector('.SPR_motionPreviewViewport img');
    return img?.complete && img.naturalWidth > 0 && document.querySelector('.SPR_motionPreviewViewport').dataset.loading === 'false';
  });
  await trigger.click(); await waitImage();
  await page.screenshot({ path: '.verify/motion-preview-structure.png' });
  check('preview and action list are two sibling columns', await dialog.locator('.SPR_motionActionLayout').evaluate(el =>
    el.children.length === 2 && el.children[0].classList.contains('SPR_motionActionList') && el.children[1].classList.contains('SPR_motionActionPreview')));
  check('preview is never nested inside the scroll list', await list.locator('.SPR_motionActionPreview').count() === 0);
  check('the bundled PNG contains visible template pixels', await image.evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  }));
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
        return { dialog: box(el), list: box(list), preview: box(preview), viewport: box(el.querySelector('.SPR_motionPreviewViewport')), img: box(el.querySelector('img')), footer: box(el.querySelector('.SPR_motionActionActions')), overflow: el.scrollHeight > el.clientHeight + 1 };
      });
      check('dialog and footer fit the viewport at ' + label, geometry.dialog.left >= 0 && geometry.dialog.right <= width && geometry.dialog.top >= 0 && geometry.dialog.bottom <= height && geometry.footer.bottom <= geometry.dialog.bottom && !geometry.overflow);
      check('preview follows the available dialog width at ' + label, width > 600 ? geometry.preview.left >= geometry.list.right : geometry.preview.top >= geometry.list.bottom);
      check('image stays visible and inside its viewport at ' + label, geometry.img.width > 60 && geometry.img.height > 40 && geometry.img.left >= geometry.viewport.left && geometry.img.right <= geometry.viewport.right + 1 && geometry.img.top >= geometry.viewport.top && geometry.img.bottom <= geometry.viewport.bottom + 1);
      check('action list scrolls independently at ' + label, await list.evaluate(el => el.scrollHeight > el.clientHeight));
      await page.screenshot({ path: `.verify/motion-preview-${width}x${height}-${dark ? 'dark' : 'light'}.png` });
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
  check('no native dialogs or browser errors', errors.length === 0);
  check('no external requests', outbound.length === 0);
  console.log(`Motion preview browser: ${checks} checks passed.`);
} finally {
  await browser?.close();
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  assert.ok(resolve(home).startsWith(resolve(tmpdir(), 'gmm-motion-preview-')));
  await rm(home, { recursive: true, force: true });
}
