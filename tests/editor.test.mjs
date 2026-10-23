import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyDraft, newShip, catalogFrom, toPayload, fromPayload, stars, validate } from '../public/modules/model.js';
import { compile, initialState, successors, balance, effects, matchesGoal, replay } from '../public/modules/rules.js';
import { solve } from '../public/modules/solver.js';
import { CargoAPI, normalizeCode } from '../public/modules/api.js';
const catalog = catalogFrom(JSON.parse(readFileSync(new URL('../public/presets.json', import.meta.url))), JSON.parse(readFileSync(new URL('../public/layouts.json', import.meta.url))));
function draftWith(targets = { 0: 1 }, train = [0]) { const d = emptyDraft(); d.ships = [newShip(catalog.ships.find(p => p.id === 7))]; d.ships[0].targets = targets; d.train = train; return d; }
const quick = { maxMs: 5000, maxStates: 50000 };
test('Easy mode Y balance changes across rows but not across columns', () => {
  const m = compile(draftWith(), catalog), ship = m.ships[0];
  const cells = Array(9).fill(null);
  cells[0] = 2; // top left -> Y lever -1
  assert.equal(balance(cells, ship, m.containers), -1);
  cells[0] = null; cells[2] = 2; // top right: same Y despite different X
  assert.equal(balance(cells, ship, m.containers), -1);
  cells[2] = null; cells[4] = 2; // centre -> Y lever 0
  assert.equal(balance(cells, ship, m.containers), 0);
  cells[4] = null; cells[8] = 2; // bottom right -> Y lever +1
  assert.equal(balance(cells, ship, m.containers), 1);
  cells.fill(null); cells[1] = 0; cells[7] = 2; // opposite Y moments cancel
  assert.equal(balance(cells, ship, m.containers), 1);
});
test('Godot Easy compares the Y moment with max_x_variance (as implemented in game)', () => {
  const c = structuredClone(catalog), p = c.ships.find(s => s.id === 7);
  p.max_x_variance = 0; p.max_y_variance = 100;
  const m = compile(draftWith(), c);
  const next = [...successors(initialState(m), m)];
  assert(!next.some(x => x.move.to.kind === 'ship' && x.move.to.index === 0)); // top row forbidden
  assert(next.some(x => x.move.to.kind === 'ship' && x.move.to.index === 3)); // middle row allowed
  assert(next.some(x => x.move.to.kind === 'ship' && x.move.to.index === 5)); // X-coordinate irrelevant
});
test('solver compares up to ten completed solution paths', () => {
  const r = solve(draftWith({ 0: 3 }), catalog, { ...quick, maxSolutions: 10 });
  assert.equal(r.status, 'solved');
  assert.equal(r.minimum, 3);
  assert(r.solutionsFound >= 1 && r.solutionsFound <= 10);
  assert(replay(draftWith({ 0: 3 }), catalog, r.moves));
});
test('single delivery and already-on-board cargo produce actual minimums', () => {
  const d = draftWith({ 0: 3 }); const r = solve(d, catalog, quick); assert.equal(r.status, 'solved'); assert.equal(r.minimum, 3); assert(replay(d, catalog, r.moves));
  d.ships[0].initial[3] = 0; const r2 = solve(d, catalog, quick); assert.equal(r2.minimum, 2);
});
test('train sequence cycles and unwanted cargo can go outbound', () => {
  const d = draftWith({ 0: 1 }, [1, 0]); const r = solve(d, catalog, quick); assert.equal(r.minimum, 2); assert(replay(d, catalog, r.moves));
  const d2 = draftWith({ 0: 2 }, [0]); assert.equal(solve(d2, catalog, quick).minimum, 2);
});
test('surplus starting cargo must be removed', () => {
  const d = draftWith(); d.ships[0].initial[4] = 1;
  const r = solve(d, catalog, quick); assert.equal(r.minimum, 2);
});
test('depot cargo is included and shared between sequential ships', () => {
  const d = draftWith(); d.depot[0] = 0; d.ships.push(newShip(catalog.ships.find(p => p.id === 7))); d.ships[1].targets = { 1: 1 }; d.train = [1];
  const r = solve(d, catalog, quick); assert.equal(r.minimum, 2); assert(replay(d, catalog, r.moves));
});
test('food is cooled diagonally in its own zone, else transforms into waste', () => {
  const m = compile(draftWith({ 3: 1, 4: 1 }, [3, 4]), catalog), s = m.ships[0];
  const cells = Array(9).fill(null); cells[0] = 3; cells[4] = 4;
  assert.equal(effects(cells, s, m.containers)[4], 4);
  cells[0] = null; assert.equal(effects(cells, s, m.containers)[4], 5);
  const r = solve(draftWith({ 3: 1, 4: 1 }, [3, 4]), catalog, quick); assert.equal(r.status, 'solved'); assert.equal(r.minimum, 2);
});
test('an uncooled-food target cannot pass the local checker', () => {
  const c = structuredClone(catalog); const p = c.ships.find(s => s.id === 7); p.layout.slots = [p.layout.slots[4]];
  const d = emptyDraft(); d.ships = [newShip(p)]; d.ships[0].targets = { 4: 1 }; d.train = [4];
  const r = solve(d, c, quick); assert.equal(r.status, 'impossible');
});
test('target positions are allowed locations, not additional required cargo', () => {
  const d = draftWith(); d.ships[0].zones[0] = [0]; d.ships[0].zones[1] = [0];
  const m = compile(d, catalog); const cells = Array(9).fill(null); cells[0] = 0; assert(matchesGoal(cells, m.ships[0]));
  cells[0] = null; cells[4] = 0; assert(!matchesGoal(cells, m.ships[0]));
});
test('unknown from limits is never reported as impossible', () => {
  const r = solve(draftWith({ 0: 5 }), catalog, { maxStates: 0, maxMs: 100 }); assert.equal(r.status, 'limit');
});
test('exhausted finite search reports impossible', () => {
  const c = structuredClone(catalog); const p = c.ships.find(s => s.id === 7); p.layout.slots = [p.layout.slots[4]];
  const d = emptyDraft(); d.ships = [newShip(p)]; d.ships[0].targets = { 1: 1 }; d.train = [0];
  assert.equal(solve(d, c, quick).status, 'impossible');
});
test('replay rejects fabricated moves', () => { assert.throws(() => replay(draftWith(), catalog, [{ from: { kind: 'ship', index: 0 }, to: { kind: 'outbound', index: 0 } }])); });
test('payload uses easy mode, official IDs, count fields and no private values', () => {
  const d = draftWith({ 0: 2 }); d.ships[0].zones[0] = [0]; d.depot[2] = 1;
  const p = toPayload(d, catalog, 3); assert.equal(p.level_mode, 0); assert.equal(p.ships[0].target_load[0].count, 2);
  assert(!('scene_path' in p.ships[0])); assert(!('max_y_variance' in p.ships[0])); assert.deepEqual(p.depot.initial_load[0].position, [0, 1]);
  const imported = fromPayload(p, catalog, 'ABCDE'); assert.equal(imported.sourceCode, 'ABCDE'); assert.equal(imported.saved, null); assert.deepEqual(toPayload(imported, catalog, 3), p);
});
test('copy preserves multi-type target restrictions and rejects unknown positions', () => {
  const d = draftWith({ 0: 1, 1: 1 }); d.ships[0].zones[0] = [0, 1];
  const p = toPayload(d, catalog, 2); assert.deepEqual(fromPayload(p, catalog, 'ABCDE').ships[0].zones[0], [0, 1]);
  p.ships[0].target_zones[0].position = [99, 99]; assert.throws(() => fromPayload(p, catalog, 'ABCDE'));
});
test('empty train blocked because Godot modulo-zero would fail', () => { const d = draftWith({}, []); assert(validate(d, catalog).length >= 2); });
test('star thresholds are ceil(1.5x/2x/3x)', () => { assert.deepEqual(stars(3), { one: 9, two: 6, three: 5 }); });
test('existing six-letter codes and five-letter codes accepted; paths rejected', () => { assert.equal(normalizeCode(' iwnmtc '), 'IWNMTC'); assert.equal(normalizeCode('abcde'), 'ABCDE'); assert.throws(() => normalizeCode('../levels')); });
function memoryStorage() { const m = new Map(); return { getItem: k => m.get(k), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) }; }
test('API creates anonymous identity and community level only, reuses player token', async () => {
  const requests = []; const api = new CargoAPI({ storage: memoryStorage(), fetcher: async (url, options) => { requests.push([url, options]); return new Response(JSON.stringify(url.endsWith('/anonymous') ? { token: 'test-player-token' } : { code: 'ABCDE', version: 1, published: false }), { status: 201 }); } });
  const result = await api.create({ level_mode: 0 }); assert.equal(result.published, false); assert.equal(result.code, 'ABCDE');
  assert(requests[0][0].endsWith('/auth/anonymous')); assert(requests[1][0].endsWith('/levels')); assert.equal(requests[1][1].headers.Authorization, 'Bearer test-player-token'); assert.equal(JSON.parse(requests[1][1].body).user_difficulty, 'easy');
  await api.create({}); assert.equal(requests.length, 3); assert(!requests.some(([url]) => url.includes('/service/')));
});
test('unpublished own level fallback only with existing token', async () => {
  const storage = memoryStorage(); storage.setItem('cargo-chief-player-token-v1', 'test'); const urls = [];
  const api = new CargoAPI({ storage, fetcher: async url => { urls.push(url); return new Response(JSON.stringify(url.includes('/me/') ? { code: 'ABCDE', payload: {} } : { detail: 'Not Found' }), { status: url.includes('/me/') ? 200 : 404 }); } });
  assert.equal((await api.load('abcde')).code, 'ABCDE'); assert(urls[1].includes('/me/levels/ABCDE'));
});
test('malformed successful publish response is never a fabricated code', async () => { const api = new CargoAPI({ storage: memoryStorage(), fetcher: async url => new Response(JSON.stringify(url.endsWith('/anonymous') ? { token: 'test' } : { published: true })) }); await assert.rejects(() => api.create({}), /no valid code/); });
test('published state requires explicit API confirmation', async () => { const api = new CargoAPI({ storage: memoryStorage(), fetcher: async url => new Response(JSON.stringify(url.endsWith('/anonymous') ? { token: 'test' } : { code: 'ABCDE' })) }); assert.equal((await api.create({})).published, false); });
test('browser fetch is invoked without the API instance as its receiver', async () => {
  let called = false;
  const api = new CargoAPI({ storage: memoryStorage(), fetcher: function () { assert.equal(this, undefined); called = true; return Promise.resolve(new Response(JSON.stringify({ ships: [] }))); } });
  await api.presets(); assert(called);
});

test('HTML 404 from a proxy preserves not-found status and triggers the private-level fallback', async () => {
  const storage = memoryStorage();
  storage.setItem('cargo-chief-player-token-v1', 'test-player');
  const calls = [];
  const api = new CargoAPI({ base: '/api', storage, fetcher: async (url) => {
    calls.push(url);
    if (url.includes('/me/')) return new Response(JSON.stringify({ code: 'ABCDE', payload: {} }), { status: 200 });
    return new Response('<html><body>Not Found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
  } });
  assert.equal((await api.load('ABCDE')).code, 'ABCDE');
  assert.deepEqual(calls, ['/api/levels/ABCDE', '/api/me/levels/ABCDE']);
});
test('HTML gateway responses identify API proxy errors instead of an unreadable response', async () => {
  const api = new CargoAPI({ base: '/api', storage: memoryStorage(), fetcher: async () =>
    new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(() => api.load('ABCDE'), error =>
    error.status === 502 && /gateway error.*caddy/i.test(error.message));
});
test('Unexpected HTML on successful GET identifies endpoint and HTTP status', async () => {
  const api = new CargoAPI({ base: '/api', storage: memoryStorage(), fetcher: async () =>
    new Response('<html>Editor index</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(() => api.load('ABCDE'), error =>
    error.status === 200 && /expected json.*html.*http 200 at \/levels\/abcde/i.test(error.message));
});

test('imported level inherits preset cargo only when ship fields were omitted', () => {
  const payload = toPayload(draftWith(), catalog, 1);
  payload.ships = [{ preset_id: 0 }];
  const inherited = fromPayload(payload, catalog, 'IWNMTC');
  assert.equal(inherited.ships.length, 1);
  assert.equal(inherited.ships[0].initial[8], 1);
  assert.equal(inherited.ships[0].targets[0], 2);
  assert.equal(inherited.ships[0].targets[1], 1);
  assert.equal(inherited.ships[0].zones[7].includes(0), true);
  payload.ships = [{ preset_id: 0, initial_load: [], target_load: [{ container_type_id: 0, count: 1 }], target_zones: [] }];
  const explicitEmpty = fromPayload(payload, catalog, 'IWNMTC');
  assert.equal(explicitEmpty.ships[0].initial.every(id => id === null), true);
  assert.deepEqual(explicitEmpty.ships[0].targets, { 0: 1 });
});
