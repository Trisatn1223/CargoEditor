import { API_BASE, RULES_VERSION, SEARCH_LIMITS } from './config.js';
import { CargoAPI } from './modules/api.js';
import { emptyDraft, newShip, catalogFrom, validate, toPayload, fromPayload, stars, copy } from './modules/model.js';
import { compile, balance } from './modules/rules.js';
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORE = 'cargo-workshop-draft-v1';
const api = new CargoAPI();
let catalog, layouts, draft = emptyDraft(), step = 'ship', layer = 'initial', activeShip = 0, selected = 0, result = null, worker = null, live = false, busy = false, uncertainPublish = false, connectionError = '', saveFailed = false;
let drag = null, toastTimer, operation = 0;
const steps = ['ship', 'depot', 'train', 'review'];
function cargo(id) { return catalog.containers.find(c => c.id === id); }
function cargoName(c) { if (!c) return 'Unknown cargo'; return c.function_id === 1 ? 'Refrigerated' : c.function_id === 4 ? 'Food' : c.id === 5 ? 'Waste' : `Standard ${c.weight}`; }
function cargoColor(c) { const a = c?.color_rgba; return Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(Number.isFinite) ? `rgb(${a.slice(0, 3).map(n => Math.round(Math.max(0, Math.min(1, n)) * 255)).join(',')})` : '#b6c6ba'; }
function box(id, attrs = '') { const c = cargo(id); return `<div class="cargo ${attrs ? 'drag-source' : ''}" style="--cargo:${cargoColor(c)}" ${attrs}><span>${c?.function_id === 1 ? '❄' : c?.function_id === 4 ? 'F' : c?.id === 5 ? 'W' : c?.weight ?? '?'}</span></div>`; }
function persist() { try { localStorage.setItem(STORE, JSON.stringify({ version: 1, draft, uncertainPublish })); saveFailed = false; } catch { saveFailed = true; } $('save-status').textContent = saveFailed ? 'Draft is in memory only' : 'Saved on this device'; }
function mutate(fn) { if (busy) return; if (draft.saved) draft.sourceCode = draft.saved.code; fn(); draft.saved = null; result = null; uncertainPublish = false; persist(); render(); }
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500); }
function modal(content, { locked = false } = {}) { $('modal-content').innerHTML = content; $('modal').dataset.locked = String(locked); if (!$('modal').open) $('modal').showModal(); }
function closeModal() { if (!busy && !worker) $('modal').close(); }
function modalHead(title) { return `<div class="modal-top"><h2 id="modal-title">${title}</h2><button class="close-button" data-action="close" aria-label="Close dialog">×</button></div>`; }
function catalogSignature(c) { return JSON.stringify(c); }
function syncHeader() {
  $('level-code').textContent = draft.saved?.code || 'Not published';
  $('code-label').textContent = draft.saved ? (draft.saved.published ? 'PUBLISHED LEVEL' : 'SAVED LEVEL CODE') : 'LEVEL CODE';
  $('source-code').textContent = draft.sourceCode ? `New copy of ${draft.sourceCode}` : 'Your next great level starts here.';
  $('connection-label').textContent = live ? 'API connected' : 'Offline presets';
  $('connection-dot').classList.toggle('offline', !live);
  $('steps').innerHTML = steps.map((s, i) => `<button class="step ${step === s ? 'active' : ''}" data-action="step" data-step="${s}" ${step === s ? 'aria-current="step"' : ''}><i>0${i + 1}</i>${['Ship', 'Depot', 'Train', 'Check & share'][i]}</button>`).join('');
  $('check-button').disabled = !catalog || busy;
  $('check-button').innerHTML = draft.saved ? 'View level code <span>↗</span>' : result?.status === 'solved' ? 'Publish level <span>↗</span>' : 'Check level <span>→</span>';
}
function palette() {
  return `<aside class="panel palette-panel"><div><div class="section-label">CARGO LIBRARY <small>Drag or tap</small></div><p class="micro">Select a container, then tap a slot. Or drag it into place.</p></div><div class="palette">${catalog.containers.filter(c => [0, 1, 4].includes(c.function_id)).map(c => `<button class="palette-card drag-source ${selected === c.id ? 'selected' : ''}" data-action="select-cargo" data-cargo="${c.id}" data-drag="palette" data-id="${c.id}" aria-label="Select ${cargoName(c)}" aria-pressed="${selected === c.id}">${box(c.id)}<strong>${cargoName(c)}</strong><small>${c.weight} weight</small></button>`).join('')}</div><div class="erase-row"><button class="button outline full ${selected === null ? 'active-erase' : ''}" data-action="eraser" aria-pressed="${selected === null}">⌫ Erase</button><p class="micro">Right-click a slot to clear it.</p></div><div class="trash" data-drop="trash">⌫ Drop here to remove</div></aside>`;
}
function emptyScene() { return `<section class="empty-stage"><div class="ship-hull" aria-hidden="true"><div class="bridge"><i></i><i></i></div><div class="hold">${Array.from({ length: 9 }, () => '<div class="slot empty"></div>').join('')}</div></div><span class="tag">YOUR WORKSHOP IS READY</span><h2>Every puzzle starts with a ship.</h2><p>Add a ship, set its cargo and give other captains a balancing challenge.</p><div class="empty-actions"><button class="button primary" data-action="add-ship">＋ Choose a ship</button><button class="button outline" data-action="example">Try an example</button></div></section>`; }
function shipGrid(ship, preset) {
  const zones = [...new Set(preset.layout.slots.map(s => s.zone))];
  return `<div class="ship-hull ${zones.length > 1 ? 'double' : ''}"><div class="bridge" aria-hidden="true"><i></i><i></i><i></i></div>${zones.map(zone => `<div class="hold-wrap"><div class="hold">${preset.layout.slots.map((slot, i) => {
    if (slot.zone !== zone) return '';
    const filled = layer === 'initial' ? ship.initial[i] !== null : ship.zones[i].length > 0;
    return `<button class="slot ${filled ? '' : 'empty'}" data-action="slot" data-drop="ship" data-index="${i}" aria-label="Hold ${zone + 1}, column ${slot.position[0] + 1}, row ${slot.position[1] + 1}${layer === 'initial' && filled ? ': ' + cargoName(cargo(ship.initial[i])) : ''}"><span class="slot-coordinate">${slot.position[0] + 1}·${slot.position[1] + 1}</span>${layer === 'initial' ? (filled ? box(ship.initial[i], `data-drag="ship" data-index="${i}" data-id="${ship.initial[i]}"`) : '') : `<span class="zone-marks">${ship.zones[i].map(id => `<i class="zone-mark" style="--cargo:${cargoColor(cargo(id))}" title="${cargoName(cargo(id))}">${id}</i>`).join('')}</span>`}</button>`;
  }).join('')}</div><span class="hold-label">HOLD ${zone + 1}</span></div>`).join('')}</div>`;
}
function renderShip() {
  if (!draft.ships.length) return emptyScene();
  activeShip = Math.min(activeShip, draft.ships.length - 1);
  const ship = draft.ships[activeShip], p = catalog.ships.find(s => s.id === ship.presetId);
  if (!p) return `<section class="empty-stage"><h2>Ship preset unavailable</h2><p>The API no longer provides this ship. Please create a new level or load a compatible code.</p></section>`;
  const total = Object.values(ship.targets).reduce((n, v) => n + v, 0);
  const raw = { slots: p.layout.slots, offset: p.center_offset, limit: p.max_x_variance };
  const y = balance(ship.initial, raw, new Map(catalog.containers.map(c => [c.id, c]))), limit = p.max_x_variance, at = Math.max(0, Math.min(100, 50 + (limit ? y / limit : Math.sign(y)) * 45));
  return `<section class="editor">${palette()}<div class="stage"><header class="stage-header"><div><h2>Design your ship</h2><p>${p.layout.slots.length} cargo slots · ${draft.ships.length} ${draft.ships.length === 1 ? 'ship' : 'ships'} in this level</p>${draft.sourceCode ? `<div class="loaded-summary inline-summary">Loaded from ${esc(draft.sourceCode)} · ${ship.initial.filter(id => id !== null).length} starting containers · ${total} target containers</div>` : ""}</div><div class="ship-control"><select id="ship-select" class="ship-select" aria-label="Active ship">${draft.ships.map((s, i) => `<option value="${i}" ${i === activeShip ? 'selected' : ''}>Ship ${i + 1}</option>`).join('')}</select><button class="button square" data-action="add-ship" aria-label="Add a ship">+</button></div></header><div class="layer-tabs" role="group" aria-label="Ship editing layer"><button class="layer-tab ${layer === 'initial' ? 'active' : ''}" data-action="layer" data-layer="initial">Starting cargo</button><button class="layer-tab ${layer === 'zones' ? 'active' : ''}" data-action="layer" data-layer="zones">Allowed positions</button></div><div class="sea"><div class="compass">↑ Y BALANCE</div>${shipGrid(ship, p)}<div class="sea-label">CARGO CHIEF / LEVEL WORKSHOP</div></div><div class="canvas-caption"><span><i class="caption-key"></i>${layer === 'initial' ? 'Cargo already on board when the ship arrives.' : 'Paint allowed positions for the selected cargo type.'}</span><button class="button ghost" data-action="delete-ship" aria-label="Remove current ship">Remove ship</button></div></div><aside class="panel inspector"><div><div class="section-label">TARGET MANIFEST <small>${total} / ${p.layout.slots.length}</small></div><p class="micro">What should this ship leave with?</p><div class="manifest" data-drop="target">${catalog.containers.filter(c => [0, 1, 4].includes(c.function_id)).map(c => `<div class="manifest-row">${box(c.id)}<label>${cargoName(c)}</label><div class="quantity"><button data-action="quantity" data-id="${c.id}" data-delta="-1" aria-label="Remove one ${cargoName(c)} from target" ${!ship.targets[c.id] ? 'disabled' : ''}>−</button><output>${ship.targets[c.id] || 0}</output><button data-action="quantity" data-id="${c.id}" data-delta="1" aria-label="Add one ${cargoName(c)} to target" ${total >= p.layout.slots.length ? 'disabled' : ''}>+</button></div></div>`).join('')}</div></div><div class="tip-box">No painted positions? That cargo can go anywhere. Multiple colours mean multiple allowed cargo types.</div><div class="balance-box"><div class="balance-top"><span>Starting Y balance</span><b>${y.toFixed(2)} / ±${limit}</b></div><div class="balance-track"><i class="balance-pointer ${Math.abs(y) > limit ? 'bad' : ''}" style="--at:${at}%"></i></div><div class="balance-labels"><span>−${limit}</span><span>Balanced</span><span>+${limit}</span></div></div></aside></section>`;
}
function renderDepot() { return `<section class="editor wide-editor">${palette()}<div class="stage"><header class="stage-header"><div><h2>A little room to manoeuvre.</h2><p>Set the depot’s starting cargo. Empty slots leave room for later.</p></div><span class="tag">${draft.depot.filter(v => v !== null).length} / 4 OCCUPIED</span></header><div class="supply-area"><div class="depot-pad">${draft.depot.map((id, i) => `<button class="slot ${id === null ? 'empty' : ''}" data-action="depot-slot" data-drop="depot" data-index="${i}" aria-label="Depot slot ${i + 1}${id !== null ? ': ' + cargoName(cargo(id)) : ', empty'}">${id === null ? '' : box(id, `data-drag="depot" data-index="${i}" data-id="${id}"`)}</button>`).join('')}</div><p class="micro">A fixed 2 × 2 depot. Shared by every ship in your level.</p></div><div class="canvas-caption"><span>Stored containers do not affect ship balance.</span><button class="button primary" data-action="step" data-step="train">Set up the train →</button></div></div></section>`; }
function renderTrain() { return `<section class="editor wide-editor">${palette()}<div class="stage"><header class="stage-header"><div><h2>Keep the cargo coming.</h2><p>The train delivers one container at a time, then repeats this sequence.</p></div><button class="button outline" data-action="auto-train">Auto-fill</button></header><div class="supply-area"><div class="train-area"><div class="train-line"><div class="locomotive" aria-label="Train engine"></div>${Array.from({ length: draft.train.length + 1 }, (_, i) => `<button class="train-insert" data-action="train-insert" data-drop="train" data-index="${i}" aria-label="Insert cargo at train position ${i + 1}">+</button>${i < draft.train.length ? `<div class="wagon drag-source" data-drag="train" data-index="${i}" data-id="${draft.train[i]}">${box(draft.train[i])}<small>${String(i + 1).padStart(2, '0')} · ${cargoName(cargo(draft.train[i]))}</small><button data-action="train-remove" data-index="${i}" aria-label="Remove train container ${i + 1}">×</button></div>` : ''}`).join('')}</div></div><p class="micro">${draft.train.length ? '↻ After the last container, the sequence starts again.' : 'Choose cargo and tap +, or drag it between wagons.'}</p></div><div class="canvas-caption"><span>${draft.train.length} / 200 sequence entries · Unwanted cargo can leave on the outbound train.</span><button class="button primary" data-action="step" data-step="review">Review level →</button></div></div></section>`; }
function thresholds(minimum) { const t = stars(minimum); return `<div class="star-row">${[['★★★', t.three], ['★★', t.two], ['★', t.one]].map(([label, n]) => `<div class="star-card"><span>${label}</span><b>${n}</b><small>moves</small></div>`).join('')}</div>`; }
function renderReview() {
  const errors = validate(draft, catalog);
  return `<section class="review"><div class="review-main"><span class="tag">READY FOR A TEST RUN?</span><h2>Make sure it can set sail.</h2><p>The checker compares up to ten optimal routes on your device. Your level stays on this device until you publish it.</p><div class="stat-grid"><div class="stat"><b>${draft.ships.length}</b><span>Ships</span></div><div class="stat"><b>${draft.ships.reduce((n, s) => n + Object.values(s.targets).reduce((a, b) => a + b, 0), 0)}</b><span>Target containers</span></div><div class="stat"><b>${draft.train.length}</b><span>Train entries</span></div></div><div class="checklist">${errors.length ? errors.map(e => `<div class="check-item error">${esc(e)}</div>`).join('') : '<div class="check-item">Cargo and ship data are complete.</div><div class="check-item">Easy mode checks the Y-axis only.</div><div class="check-item">The depot stays fixed at 2 × 2.</div>'}</div></div><div class="review-side"><div class="section-label">LOCAL CHECK</div>${result?.status === 'solved' ? `<h2>${result.minimum} moves.</h2><p>A solution was found and replayed locally. The shortest solution was chosen from the locally checked routes.</p>${thresholds(result.minimum)}<button class="button primary full" data-action="check">${draft.saved ? 'View level code' : 'Publish level'} ↗</button>${solutionDetails()}` : `<h2>${result?.status === 'impossible' ? 'No route found.' : result?.status === 'limit' ? 'More time needed.' : 'Ready when you are.'}</h2><p>${result?.status === 'impossible' ? 'Every reachable state in the local rules was explored. Adjust the cargo, allowed positions or train order.' : result?.status === 'limit' ? 'The search limit was reached. This does not mean your level is impossible. Simplify it and check again.' : 'A full-screen progress display will keep you updated while your browser explores the possible moves.'}</p><div class="checklist"><div class="check-item">No solver running on the server.</div><div class="check-item">Editing always resets the check.</div><div class="check-item">Only the API creates a level code.</div></div><button class="button primary full" data-action="check" ${errors.length ? 'disabled' : ''}>Check level →</button>`}</div></section>`;
}
function render() { if (!catalog) return; syncHeader(); $('workspace').innerHTML = step === 'ship' ? renderShip() : step === 'depot' ? renderDepot() : step === 'train' ? renderTrain() : renderReview(); }
function pickShip() {
  if (draft.ships.length >= 20) { toast('A level can contain at most 20 ships.'); return; }
  // One community ship type. Keep official IDs when copying an existing level.
  const preset = catalog.ships.find(p => p.id === 7) || catalog.ships.find(p => p.layout.zones === 1) || catalog.ships[0];
  mutate(() => {
    draft.ships.push(newShip(preset));
    activeShip = draft.ships.length - 1; step = 'ship'; layer = 'initial';
  });
}

function addTarget(id, delta) {
  const s = draft.ships[activeShip]; if (!s) return;
  const max = catalog.ships.find(p => p.id === s.presetId).layout.slots.length, total = Object.values(s.targets).reduce((a, b) => a + b, 0);
  if (delta > 0 && total >= max) { toast('The target cargo cannot exceed the ship’s capacity.'); return; }
  mutate(() => { s.targets[id] = Math.max(0, (s.targets[id] || 0) + delta); if (!s.targets[id]) delete s.targets[id]; });
}
function paintSlot(index, id = selected) {
  const s = draft.ships[activeShip]; if (!s) return;
  mutate(() => { if (layer === 'initial') s.initial[index] = id; else if (id === null) s.zones[index] = []; else if (s.zones[index].includes(id)) s.zones[index] = s.zones[index].filter(v => v !== id); else s.zones[index].push(id); });
}
function resetDraft() { operation++; draft = emptyDraft(); result = null; uncertainPublish = false; activeShip = 0; step = 'ship'; layer = 'initial'; selected = catalog.containers[0].id; persist(); render(); $('modal').close(); }
function confirmReset() {
  if (!draft.ships.length && !draft.train.length && draft.depot.every(v => v === null)) { resetDraft(); return; }
  modal(`<div class="modal-body">${modalHead('Start a new level?')}<p>This clears all ships, cargo, depot slots, train entries and the local check. Saved levels stay on the API.</p><div class="modal-buttons"><button class="button outline" data-action="close">Keep editing</button><button class="button primary" data-action="reset">New level</button></div></div>`);
}
function openCode() { modal(`<div class="modal-body">${modalHead('Open a level code')}<p>Load a public level or one saved with this browser’s player identity. You will create a new copy; the original stays unchanged.</p><form id="load-form"><label class="field-label" for="code-input">Level code</label><input class="code-input" id="code-input" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="ABCDE" required><div id="load-error" class="dialog-error" role="alert"></div><div class="modal-buttons"><button type="button" class="button outline" data-action="close">Cancel</button><button class="button primary" type="submit">Load a copy →</button></div></form></div>`); $('code-input').focus(); }
function levelSummary(value) {
  const ships = value.ships.length;
  const starting = value.ships.reduce((n, ship) => n + ship.initial.filter(id => id !== null).length, 0);
  const targets = value.ships.reduce((n, ship) => n + Object.values(ship.targets).reduce((total, count) => total + count, 0), 0);
  const stored = value.depot.filter(id => id !== null).length;
  return `${ships} ${ships === 1 ? 'ship' : 'ships'} · ${starting} starting containers · ${targets} target containers · ${stored} depot slots filled · ${value.train.length} train entries`;
}
function hasLocalWork() {
  return Boolean(draft.saved || draft.sourceCode || draft.ships.length || draft.train.length || draft.depot.some(id => id !== null));
}
function applyLoadedCopy(next, code) {
  // Do not mutate the API response, original published level, or existing token.
  draft = next;
  result = null;
  uncertainPublish = false;
  activeShip = 0;
  step = 'ship';
  layer = 'initial';
  persist();
  render();
  closeModal();
  toast(`Loaded ${code} · ${levelSummary(next)}`);
}
async function loadCode(event) {
  event.preventDefault();
  const button = event.target.querySelector('[type=submit]');
  const enteredCode = $('code-input').value;
  button.disabled = true;
  button.textContent = 'Loading…';
  busy = true;
  const ticket = ++operation;
  try {
    const data = await api.load(enteredCode);
    const code = data.code || enteredCode.trim().toUpperCase();
    const next = fromPayload(data.payload, catalog, code);
    if (ticket !== operation) return;
    busy = false;
    if (!hasLocalWork()) {
      // Opening into an empty workshop needs no second, easily missed click.
      applyLoadedCopy(next, code);
      return;
    }
    modal(`<div class="modal-body">${modalHead('Replace your current draft?')}<p>The level <strong>${esc(code)}</strong> was loaded successfully. To see it in the editor, replace your current local draft with a new copy. The original published level stays unchanged.</p><div class="loaded-summary">${esc(levelSummary(next))}</div><p class="micro">Your current unsaved changes will be replaced. Choose Keep editing to leave them untouched.</p><div class="modal-buttons"><button class="button outline" data-action="close">Keep editing</button><button class="button primary" id="accept-copy">Replace draft and open →</button></div></div>`);
    $('accept-copy').onclick = () => applyLoadedCopy(next, code);
  } catch (error) {
    const target = $('load-error');
    if (target) target.textContent = error.message;
    button.disabled = false;
    button.textContent = 'Load a copy →';
  } finally {
    busy = false;
  }
}
function connection() { modal(`<div class="modal-body">${modalHead('Connection')}<span class="tag ${live ? '' : 'warning'}">${live ? 'LIVE PRESETS' : 'OFFLINE PRESETS'}</span><p style="margin-top:16px">${live ? 'Official presets are up to date. Your level calculations run entirely in this browser.' : 'You can keep designing with the bundled official preset snapshot. A live connection is required before publishing.'}</p><p>${esc(connectionError)}</p><p>API: ${esc(API_BASE)}<br>Player identity is saved only in this browser. No studio or service token is used.</p><div class="modal-buttons stack"><button class="button primary" data-action="reconnect">Retry connection</button><button class="button outline" data-action="renew">Renew player session</button></div><p style="margin-top:15px;margin-bottom:0">Renewing your session loses access to unpublished levels saved with the previous identity. Published levels can still be opened by code.</p></div>`); }
async function refreshPresets() {
  const data = await api.presets(), updated = catalogFrom(data, layouts), changed = catalogSignature(updated) !== catalogSignature(catalog);
  catalog = updated; live = true; connectionError = '';
  if (changed) { result = null; if (worker) { worker.terminate(); worker = null; showError('Presets updated', 'Official ship or container data changed. Run the local check again.'); } }
  try { localStorage.setItem('cargo-workshop-presets-v1', JSON.stringify(data)); } catch {}
  return changed;
}
async function checkLevel() {
  if (busy || worker) return;
  if (draft.saved) { showCode(); return; }
  if (result?.status === 'solved') { showReady(); return; }
  const errors = validate(draft, catalog);
  if (errors.length) { step = 'review'; render(); toast(errors[0]); return; }
  const draftSnapshot = copy(draft), catalogSnapshot = copy(catalog);
  modal(`<div class="modal-body center"><div class="progress-graphic" aria-hidden="true"><i></i><i></i><i></i></div><span class="tag">RUNNING ON YOUR DEVICE</span><h2 id="modal-title" style="margin-top:14px">Finding a way to set sail.</h2><p>First checking direct one-move finishes, then searching for the shortest legal route with A* and Y balance.<br>You can cancel at any time without losing your draft.</p><progress id="search-progress" max="${SEARCH_LIMITS.maxStates}" value="0" aria-label="Search budget used"></progress><div class="search-budget" id="search-budget">Search budget used: 0%</div><div class="progress-details" aria-live="polite"><span id="search-states">Starting local worker…</span><span id="search-time">0.0 s</span></div><p class="micro">Search has no known percentage. Direct finishes and impossible goal layouts are tested first. A* can explore up to ${SEARCH_LIMITS.maxStates.toLocaleString('en')} states; comparing alternate routes stops early once the shortest route is proven. The bar shows search budget used, not probability of success.</p><button class="button outline" data-action="cancel-check">Cancel check</button></div>`, { locked: true });
  try {
    worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        const used = Math.min(SEARCH_LIMITS.maxStates, data.progress.states);
        $('search-progress').value = used;
        const proven = Number.isInteger(data.progress.bestMoves);
        $('search-budget').textContent = proven
          ? `Shortest solution proven: ${data.progress.bestMoves} moves · ${data.progress.found} / ${SEARCH_LIMITS.maxSolutions} routes compared`
          : `A* search budget: ${(used / SEARCH_LIMITS.maxStates * 100).toFixed(1)}% used · direct finish checked`;
        $('search-states').textContent = proven
          ? `Checking equally short alternatives · ${data.progress.explored.toLocaleString('en')} positions`
          : `${data.progress.explored.toLocaleString('en')} positions explored`;
        $('search-time').textContent = `${(data.progress.elapsed / 1000).toFixed(1)} s`;
      }
      else { worker.terminate(); worker = null; if (data.type === 'error') { showError('Check could not finish', data.message); return; } result = data.result; render(); if (result.status === 'solved') showReady(); else showError(result.status === 'limit' ? 'Not fully checked yet' : 'No legal solution', result.reason ||
    (result.status === 'limit'
      ? 'The shortest one-move finish was checked first but was not legal. A* reached its search budget without proving this level possible or impossible. Check the required cargo types, allowed target positions and Y balance.'
      : 'All reachable states were explored without a legal solution. Check target cargo, allowed positions, Y balance and train sequence.')); }
    };
    worker.onerror = () => { worker?.terminate(); worker = null; showError('Local checker unavailable', 'The worker could not start. Open this editor through its web address, not by double-clicking index.html.'); };
    worker.postMessage({ draft: draftSnapshot, catalog: catalogSnapshot, limits: SEARCH_LIMITS });
  } catch (error) { worker?.terminate(); worker = null; showError('Local checker unavailable', error.message); }
}
function showError(title, message) { modal(`<div class="modal-body center"><div class="result-icon warning">!</div><h2 id="modal-title">${esc(title)}</h2><p>${esc(message)}</p><button class="button primary full" data-action="close">Back to editing</button></div>`); }
function describeEndpoint(e) { return e.kind === 'train' ? 'incoming train' : e.kind === 'outbound' ? 'outbound train' : `${e.kind} slot ${e.index + 1}`; }
function solutionDetails() { return result?.moves ? `<details><summary>View local solution (${result.minimum} moves)</summary><ol class="solution-list">${result.moves.map(m => `<li>Ship ${m.ship + 1}: ${esc(cargoName(cargo(m.container_type_id)))} · ${describeEndpoint(m.from)} → ${describeEndpoint(m.to)}</li>`).join('')}</ol></details>` : ''; }
function showReady() {
  modal(`<div class="modal-body center"><div class="result-icon">✓</div><span class="tag">LOCAL CHECK COMPLETE</span><h2 id="modal-title" style="margin-top:13px">Your level has a solution.</h2><p>Best route: ${result.minimum} ${result.minimum === 1 ? 'move' : 'moves'}. Compared ${result.solutionsFound ?? 1} distinct optimal ${(result.solutionsFound ?? 1) === 1 ? 'route' : 'routes'} locally.${result.searchComplete === false ? ' Additional equally short routes may exist, but the shortest move count is proven.' : ''}</p>${thresholds(result.minimum)}<button class="button primary full" data-action="publish" ${uncertainPublish ? 'disabled' : ''}>Publish level ↗</button><p style="margin:12px 0 0">The API assigns your level code. Public availability depends on the API’s approval status.</p><div id="publish-error" class="dialog-error" role="alert">${uncertainPublish ? 'The previous upload may have been saved. Check your saved levels before creating another copy.' : ''}</div>${uncertainPublish ? '<button class="button outline full" data-action="recover">Check my saved levels</button>' : ''}${solutionDetails()}<button class="button ghost" data-action="close" style="margin-top:14px">Keep editing</button></div>`);
}
async function publish() {
  if (busy || result?.status !== 'solved' || draft.saved || uncertainPublish) return;
  busy = true; const button = $('modal').querySelector('[data-action="publish"]'); button.disabled = true; button.textContent = 'Connecting…'; $('modal').dataset.locked = 'true'; let posting = false;
  try {
    const changed = await refreshPresets();
    if (changed || !result) throw new Error('Official presets changed. Run the local check again before publishing.');
    const payload = toPayload(draft, catalog, result.minimum);
    button.textContent = 'Publishing…'; posting = true; uncertainPublish = true; persist();
    const saved = await api.create(payload); draft.saved = saved; uncertainPublish = false; persist(); busy = false; render(); showCode();
  } catch (error) {
    uncertainPublish = posting && (!error.status || error.status >= 500 || error.message.includes('accepted')); persist();
    busy = false; $('modal').dataset.locked = 'false'; render();
    if (result?.status === 'solved') { showReady(); $('publish-error').textContent = error.message + (uncertainPublish ? ' The request may have reached the API. Check your saved levels before trying again.' : ''); }
    else showError('Please check the level again', error.message);
  } finally { busy = false; }
}
function showCode() {
  const saved = draft.saved;
  if (!saved) { toast('A level code is assigned after a successful upload.'); return; }
  modal(`<div class="modal-body center"><div class="result-icon">${saved.published ? '↗' : '✓'}</div><span class="tag ${saved.published ? '' : 'warning'}">${saved.published ? 'PUBLISHED' : 'SAVED · AWAITING API APPROVAL'}</span><h2 id="modal-title" style="margin-top:13px">${saved.published ? 'A new challenge is ready.' : 'Your level has a code.'}</h2><p>${saved.published ? 'Share this code with another captain.' : 'Your level is saved. The API has not confirmed public availability yet. Keep the code; other players may not be able to open it until approval.'}</p><div class="large-code">${esc(saved.code)}</div><div class="modal-buttons stack"><button class="button primary full" data-action="copy-code">Copy to clipboard</button><button class="button outline full" data-action="reset">New level</button></div><button class="button ghost" data-action="close" style="margin-top:12px">Back to workshop</button></div>`);
}
async function copyCode() { try { await navigator.clipboard.writeText(draft.saved.code); $('modal').querySelector('[data-action="copy-code"]').textContent = 'Copied ✓'; } catch { const range = document.createRange(); range.selectNodeContents($('modal').querySelector('.large-code')); getSelection().removeAllRanges(); getSelection().addRange(range); toast('Select the code and press Ctrl+C (or hold to copy).'); } }
async function recover() {
  busy = true;
  try { const token = api.storedToken(); if (!token) throw new Error('No player identity is available in this browser.'); const data = await api.request('/me/levels', { token }); const levels = Array.isArray(data) ? data : data.levels || data.items; if (!Array.isArray(levels)) throw new Error('Unrecognized saved-level response. Contact the API administrator.');
    modal(`<div class="modal-body">${modalHead('Your saved levels')}<p>These are the levels saved with this browser’s identity. Open a code to inspect it before submitting another copy.</p><div class="checklist">${levels.map(l => `<div class="check-item">${esc(l.code)} · ${l.published === true ? 'Published' : 'Not confirmed public'}</div>`).join('') || '<p>No saved levels were returned.</p>'}</div><button class="button outline full" data-action="open">Open a level code</button></div>`);
  } catch (error) { showError('Could not recover saved levels', error.message); } finally { busy = false; }
}
// All pointer mutations use the same state change path as keyboard/tap actions.
let suppressClick = false;
document.addEventListener('pointerdown', event => {
  if (busy || worker || $('modal').open || event.button !== 0 || event.target.closest('[data-action="train-remove"]')) return;
  const source = event.target.closest('[data-drag]'); if (!source) return;
  drag = { kind: source.dataset.drag, id: Number(source.dataset.id), index: Number(source.dataset.index), x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false, ghost: null };
});
document.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return;
  event.preventDefault(); drag.moved = true;
  if (!drag.ghost) { const wrap = document.createElement('div'); wrap.innerHTML = box(drag.id); drag.ghost = wrap.firstChild; drag.ghost.classList.add('drag-ghost'); document.body.append(drag.ghost); }
  drag.ghost.style.left = event.clientX + 'px'; drag.ghost.style.top = event.clientY + 'px';
  document.querySelectorAll('.hot').forEach(el => el.classList.remove('hot'));
  document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop]')?.classList.add('hot');
}, { passive: false });
function stopDrag() { drag?.ghost?.remove(); document.querySelectorAll('.hot').forEach(el => el.classList.remove('hot')); drag = null; }
document.addEventListener('pointercancel', stopDrag);
window.addEventListener('blur', stopDrag);
document.addEventListener('pointerup', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const d = drag, target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop]');
  if (d.moved) {
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    if (target) {
      const kind = target.dataset.drop, i = Number(target.dataset.index);
      if (kind === 'target') addTarget(d.id, 1);
      else if (kind === 'trash' && d.kind !== 'palette') mutate(() => { if (d.kind === 'ship') draft.ships[activeShip].initial[d.index] = null; if (d.kind === 'depot') draft.depot[d.index] = null; if (d.kind === 'train') draft.train.splice(d.index, 1); });
      else if (kind === 'ship' && layer === 'zones' && d.kind === 'palette') paintSlot(i, d.id);
      else if ((kind === 'ship' && layer === 'initial' && ['palette', 'ship'].includes(d.kind)) || (kind === 'depot' && ['palette', 'depot'].includes(d.kind))) {
        const cells = kind === 'ship' ? draft.ships[activeShip].initial : draft.depot;
        if (cells[i] !== null && !(d.kind === kind && d.index === i)) toast('That slot is occupied. Clear it first.');
        else mutate(() => { if (d.kind !== 'palette') cells[d.index] = null; cells[i] = d.id; });
      } else if (kind === 'train' && ['palette', 'train'].includes(d.kind)) {
        if (d.kind === 'palette' && draft.train.length >= 200) toast('The train sequence is full.');
        else mutate(() => { let at = i; if (d.kind === 'train') { draft.train.splice(d.index, 1); if (d.index < at) at--; } draft.train.splice(at, 0, d.id); });
      }
    }
  }
  stopDrag();
});
document.addEventListener('contextmenu', event => {
  const slot = event.target.closest('[data-drop="ship"], [data-drop="depot"]'); if (!slot || busy || worker) return; event.preventDefault();
  if (slot.dataset.drop === 'ship') paintSlot(Number(slot.dataset.index), null); else mutate(() => { draft.depot[Number(slot.dataset.index)] = null; });
});
document.addEventListener('click', async event => {
  if (suppressClick) { event.preventDefault(); return; }
  const b = event.target.closest('[data-action]'); if (!b || b.disabled || busy) return; const a = b.dataset.action;
  if (worker && a !== 'cancel-check') return;
  if (a === 'close') closeModal();
  if (a === 'step') { step = b.dataset.step; render(); }
  if (a === 'add-ship') pickShip();
  if (a === 'select-cargo') { selected = Number(b.dataset.cargo); render(); }
  if (a === 'eraser') { selected = null; render(); }
  if (a === 'layer') { layer = b.dataset.layer; render(); }
  if (a === 'slot') paintSlot(Number(b.dataset.index));
  if (a === 'depot-slot') mutate(() => { draft.depot[Number(b.dataset.index)] = selected; });
  if (a === 'quantity') addTarget(Number(b.dataset.id), Number(b.dataset.delta));
  if (a === 'train-insert' && selected !== null) { if (draft.train.length >= 200) toast('The train sequence is full.'); else mutate(() => draft.train.splice(Number(b.dataset.index), 0, selected)); }
  if (a === 'train-remove') mutate(() => draft.train.splice(Number(b.dataset.index), 1));
  if (a === 'auto-train') { const ids = [...new Set(draft.ships.flatMap(s => Object.keys(s.targets).map(Number)))]; if (!ids.length) toast('Set your target cargo first.'); else mutate(() => { draft.train = ids; }); }
  if (a === 'delete-ship') modal(`<div class="modal-body">${modalHead('Remove this ship?')}<p>This clears the ship’s starting cargo, targets and allowed positions.</p><div class="modal-buttons"><button class="button outline" data-action="close">Cancel</button><button class="button danger" data-action="remove-ship">Remove ship</button></div></div>`);
  if (a === 'remove-ship') { mutate(() => { draft.ships.splice(activeShip, 1); activeShip = Math.max(0, activeShip - 1); }); closeModal(); }
  if (a === 'example') mutate(() => { const p = catalog.ships.find(p => p.id === 7) || catalog.ships.find(p => p.layout.zones === 1) || catalog.ships[0], c = catalog.containers.find(c => c.function_id === 0 && c.id !== 5); draft = emptyDraft(); const s = newShip(p); s.targets[c.id] = 3; draft.ships = [s]; draft.train = [c.id]; });
  if (a === 'reset') resetDraft();
  if (a === 'open') openCode();
  if (a === 'check') checkLevel();
  if (a === 'cancel-check') { worker?.terminate(); worker = null; result = null; $('modal').close(); toast('Check cancelled. Your draft is safe.'); }
  if (a === 'publish') await publish();
  if (a === 'copy-code') await copyCode();
  if (a === 'recover') await recover();
  if (a === 'reconnect') { b.disabled = true; b.textContent = 'Connecting…'; try { await refreshPresets(); } catch (error) { live = false; connectionError = error.message; } render(); connection(); }
  if (a === 'renew') { modal(`<div class="modal-body">${modalHead('Renew player identity?')}<p>Unpublished levels belonging to the old identity will no longer be accessible in this browser. Your current draft is kept.</p><div class="modal-buttons"><button class="button outline" data-action="close">Cancel</button><button class="button primary" data-action="confirm-renew">Renew identity</button></div></div>`); }
  if (a === 'confirm-renew') { api.renewIdentity(); closeModal(); toast('A new identity will be created on your next upload.'); }
});
document.addEventListener('change', event => { if (event.target.id === 'ship-select') { activeShip = Number(event.target.value); render(); } });
document.addEventListener('submit', event => { if (event.target.id === 'load-form') loadCode(event); });
$('modal').addEventListener('cancel', event => { if (worker || busy) event.preventDefault(); });
$('open-button').onclick = () => { if (!busy && !worker) openCode(); };
$('connection-button').onclick = () => { if (!busy && !worker) connection(); };
$('new-button').onclick = () => { if (!busy && !worker) confirmReset(); };
$('check-button').onclick = checkLevel;
$('level-code').onclick = () => { if (!busy && !worker) showCode(); };
async function boot() {
  try {
    const [layoutResponse, presetResponse] = await Promise.all([fetch('./layouts.json'), fetch('./presets.json')]);
    layouts = await layoutResponse.json(); const bundled = await presetResponse.json();
    catalog = catalogFrom(bundled, layouts);
    try { const cached = JSON.parse(localStorage.getItem('cargo-workshop-presets-v1')); if (cached) catalog = catalogFrom(cached, layouts); } catch {}
    try {
      const saved = JSON.parse(localStorage.getItem(STORE));
      if (saved?.version === 1 && saved.draft) {
        const d = saved.draft; uncertainPublish = saved.uncertainPublish === true;
        // Validate structural safety independently of completeness (partial drafts are normal).
        const ids = new Set(catalog.containers.map(c => c.id)), valid = id => id === null || ids.has(id);
        if (Array.isArray(d.ships) && d.ships.length <= 20 && Array.isArray(d.depot) && d.depot.length === 4 && d.depot.every(valid) && Array.isArray(d.train) && d.train.length <= 200 && d.train.every(id => id !== null && valid(id)) && d.ships.every(s => { const p = catalog.ships.find(p => p.id === s.presetId); return p && Array.isArray(s.initial) && s.initial.length === p.layout.slots.length && s.initial.every(valid) && Array.isArray(s.zones) && s.zones.length === s.initial.length && s.zones.every(a => Array.isArray(a) && a.every(id => id !== null && valid(id))) && s.targets && Object.entries(s.targets).every(([id, n]) => ids.has(Number(id)) && Number.isInteger(n) && n > 0); })) draft = d;
      }
    } catch {}
    selected = catalog.containers[0].id; render(); persist();
    try { await refreshPresets(); render(); } catch (error) { live = false; connectionError = error.message; syncHeader(); }
  } catch (error) { $('workspace').innerHTML = `<section class="empty-stage"><h2>Workshop could not load</h2><p>${esc(error.message)}</p><p>Serve the public folder over HTTP. Opening index.html directly does not support module workers.</p></section>`; $('check-button').disabled = true; }
}
boot();
