// Optional integration tests: PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/browser-smoke.mjs
// Start `npm start` first. All API traffic is mocked; no live level is published.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const screenshotDir = process.env.SCREENSHOT_DIR || '/tmp/cargo-editor-screenshots';
mkdirSync(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const errors = [], posts = [];
const presets = JSON.parse(readFileSync(new URL('../public/presets.json', import.meta.url)));
let published = false, responseMode = 'success', savedPayload;
await context.route('https://cargo-api.dreamislandstudio.de/**', async route => {
  const req = route.request(), url = new URL(req.url());
  let body, status = 200;
  if (req.method() === 'OPTIONS') body = {};
  else if (url.pathname === '/editor/presets') body = presets;
  else if (url.pathname === '/auth/anonymous') { body = { token: 'browser-test-player' }; status = 201; }
  else if (url.pathname === '/levels' && req.method() === 'POST') { posts.push(req.postDataJSON()); savedPayload = posts.at(-1).payload; if (responseMode === 'reject') { status = 422; body = { detail: [{ loc: ['body', 'payload', 'ships', 0, 'target_zones'], msg: 'Unknown position', type: 'value_error', input: 'do-not-echo' }] }; }
  else if (responseMode === 'variance' && savedPayload.ships.some(s => s.preset_id === 7)) { status = 422; body = { detail: 'Schiff 7.max_x_variance: Zahl zwischen 0 und 100000 erforderlich.' }; }
  else { body = { code: 'ABCDE', version: 1, published }; status = 201; } }
  else if (url.pathname === '/levels/ABCDE') body = { code: 'ABCDE', published: true, payload: savedPayload };
  else { status = 404; body = { detail: 'Not found' }; }
  await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': 'http://127.0.0.1:8080', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization,content-type' }, body: JSON.stringify(body) });
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
await page.goto('http://127.0.0.1:8080');
await page.getByText('API connected', { exact: true }).waitFor({ timeout: 10000 }).catch(async error => { await page.locator('#connection-button').click(); console.error(await page.locator('body').innerText(), errors); throw error; });
await page.getByRole('button', { name: 'Try an example' }).click();
assert.equal(await page.locator('[data-action="export-draft"], [data-action="export-solution"]').count(), 0);
await page.screenshot({ path: screenshotDir + '/editor-desktop.png', fullPage: true });
await page.locator('#check-button').click();
await page.getByRole('heading', { name: 'Your level has a solution.' }).waitFor({ timeout: 12000 }).catch(async error => {
  console.error('Check dialog at failure:', await page.locator('dialog').innerText().catch(() => 'not open'));
  console.error('Browser errors:', errors);
  throw error;
});
assert(await page.locator('dialog').innerText().then(t => t.includes('Best route: 3 moves')));
assert.equal(posts.length, 0, 'No level is uploaded during local checking');
await page.locator('dialog [data-action="publish"]').click();
await page.getByRole('heading', { name: 'Your level has a code.' }).waitFor();
assert((await page.locator('dialog').innerText()).includes('AWAITING API APPROVAL'));
assert.equal(posts.length, 1); assert.equal(posts[0].payload.level_mode, 0); assert.equal(posts[0].user_difficulty, 'easy');
const publishedPreset = presets.ships.find(x => x.id === posts[0].payload.ships[0].preset_id);
assert(publishedPreset);
assert.equal(posts[0].payload.ships[0].max_x_variance, publishedPreset.max_x_variance);
assert.equal(posts[0].payload.ships[0].max_y_variance, publishedPreset.max_y_variance);
assert.equal(posts[0].payload.ships[0].scene_path, publishedPreset.scene_path);
assert.deepEqual(posts[0].payload.ships[0].center_offset, publishedPreset.center_offset);
await page.getByRole('button', { name: 'Copy to clipboard', exact: true }).click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'ABCDE');
await page.locator('dialog [data-action="reset"]').click();
assert(await page.getByText('Every puzzle starts with a ship.').isVisible());
assert.equal(await page.locator('#level-code').innerText(), 'Not published');
const cleared = await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft);
assert.deepEqual(cleared.ships, []); assert.deepEqual(cleared.train, []); assert.deepEqual(cleared.depot, [null, null, null, null]);
await page.locator('#open-button').click(); await page.locator('#code-input').fill('abcde'); await page.getByRole('button', { name: 'Load a copy' }).click();
// A truly empty workshop must load the level immediately, without a second confirmation.
await page.getByText('New copy of ABCDE', { exact: true }).waitFor();
assert.equal(await page.locator('#accept-copy').count(), 0);
const imported = await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft);
assert.equal(imported.ships.length, 1);
assert.equal(imported.ships[0].targets[0], 3);
assert.deepEqual(imported.train, [0]);
assert.equal(await page.locator('#source-code').innerText(), 'New copy of ABCDE');
// When a user already has work, a copy must not silently overwrite it.
await page.locator('#open-button').click(); await page.locator('#code-input').fill('abcde');
await page.getByRole('button', { name: 'Load a copy' }).click();
await page.getByRole('heading', { name: 'Replace your current draft?' }).waitFor();
assert.equal((await page.locator('dialog').innerText()).includes('starting containers'), true);
assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft)).ships[0].targets[0], 3);
await page.locator('#accept-copy').click();
assert.equal(await page.locator('#level-code').innerText(), 'Not published');
await page.getByRole('button', { name: 'Add one Standard 1 to target', exact: true }).click();
await page.locator('#check-button').click(); await page.getByRole('heading', { name: 'Your level has a solution.' }).waitFor();
assert((await page.locator('dialog').innerText()).includes('Best route: 4 moves'));
published = true; await page.locator('dialog [data-action="publish"]').click(); await page.getByRole('heading', { name: 'A new challenge is ready.' }).waitFor();
assert.equal(posts.length, 2);
await page.locator('dialog [data-action="close"]').click();
// Any edit removes the saved code and invalidates the solution.
await page.getByRole('button', { name: 'Remove one Standard 1 from target', exact: true }).click();
assert.equal(await page.locator('#level-code').innerText(), 'Not published'); assert((await page.locator('#check-button').innerText()).includes('Check level'));
await page.locator('#check-button').click(); await page.getByRole('heading', { name: 'Your level has a solution.' }).waitFor();
responseMode = 'reject'; await page.locator('dialog [data-action="publish"]').click(); await page.locator('#publish-error').filter({ hasText: 'body.payload.ships.0.target_zones: Unknown position' }).waitFor();
assert(!(await page.locator('#publish-error').innerText()).includes('do-not-echo'));
assert.equal(await page.locator('#level-code').innerText(), 'Not published');
await page.locator('dialog [data-action="close"]').click();
// Temporary fallback is offered ONLY when a server 422 names ship 7.
// The old draft stays on preset 7 until explicit user approval and API success.
responseMode = 'variance';
await page.locator('#check-button').click();
await page.locator('dialog [data-action="publish"]').click();
await page.locator('#publish-error').filter({ hasText: 'Schiff 7.max_x_variance' }).waitFor();
await page.locator('[data-action="preview-preset-workaround"]').click();
await page.getByRole('heading', { name: 'Try a temporary ship-preset workaround?' }).waitFor();
let current = await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft);
assert.equal(current.ships[0].presetId, 7, 'Reviewing fallback must not alter the original draft');
// Cancel never posts a fallback upload.
const beforeFallback = posts.length;
await page.getByRole('button', { name: 'Cancel', exact: true }).click();
assert.equal(posts.length, beforeFallback);
await page.locator('#check-button').click();
await page.locator('dialog [data-action="preview-preset-workaround"]').click();
await page.locator('[data-action="confirm-preset-workaround"]').click();
await page.getByRole('heading', { name: 'A new challenge is ready.' }).waitFor();
assert.equal(posts.at(-1).payload.ships[0].preset_id, 8);
assert.equal(posts.at(-1).payload.ships[0].max_x_variance, 3);
current = await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft);
assert.equal(current.ships[0].presetId, 8);
assert.equal(current.saved.workaround.fromId, 7);
assert.equal(current.saved.workaround.toId, 8);
assert((await page.locator('dialog').innerText()).includes('Temporary workaround applied'));
await page.locator('dialog [data-action="close"]').click();
responseMode = 'success';
// Pointer drag from library to ship, then slot-to-slot, without duplication.
const source = page.locator('[data-drag="palette"][data-id="1"]'); const destination = page.locator('[data-drop="ship"][data-index="3"]');
const a = await source.boundingBox(), b = await destination.boundingBox();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await page.mouse.up();
assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft)).ships[0].initial[3], 1);
const occupied = page.locator('[data-drag="ship"][data-index="3"]'), empty = page.locator('[data-drop="ship"][data-index="4"]');
const c = await occupied.boundingBox(), d = await empty.boundingBox();
await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await page.mouse.down(); await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 10 }); await page.mouse.up();
const moved = (await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft)).ships[0].initial;
assert.equal(moved[3], null); assert.equal(moved[4], 1);
await page.reload(); await page.getByText('API connected', { exact: true }).waitFor();
assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft)).ships[0].initial[4], 1);
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: screenshotDir + '/editor-mobile.png', fullPage: true });
assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
// Force a long enough search to exercise the cancellable worker modal.
await page.setViewportSize({ width: 1440, height: 1000 });
await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('cargo-workshop-draft-v1'));
  saved.draft.ships[0].initial.fill(null); saved.draft.ships[0].targets = { 4: 9 };
  saved.draft.train = [4]; saved.draft.saved = null;
  localStorage.setItem('cargo-workshop-draft-v1', JSON.stringify(saved));
});
await page.reload(); await page.getByText('API connected', { exact: true }).waitFor();
await page.locator('#check-button').click();
await page.getByRole('button', { name: 'Cancel check', exact: true }).click();
assert.equal(await page.locator('dialog').evaluate(el => el.open), false);
assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cargo-workshop-draft-v1')).draft)).ships[0].targets[4], 9);
// Offline API still leaves the editor and local rules available.
await context.unroute('https://cargo-api.dreamislandstudio.de/**');
await context.route('https://cargo-api.dreamislandstudio.de/**', route => route.abort());
await page.reload(); await page.getByText('Offline presets', { exact: true }).waitFor();
assert(await page.getByText('Design your ship', { exact: true }).isVisible());
assert.deepEqual(errors, []);
console.log('PASS: local worker, minimum moves, pending/published flows, clipboard, full reset, load copy, invalidation, API rejection, drag/drop, persistence, mobile overflow, cancellation and offline fallback; no browser errors.');
await browser.close();
