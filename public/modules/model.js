export const copy = value => structuredClone(value);
export const emptyDraft = () => ({ ships: [], depot: Array(4).fill(null), train: [], sourceCode: null, saved: null });
export const tally = cells => cells.reduce((out, id) => { if (id !== null) out[id] = (out[id] || 0) + 1; return out; }, {});
export const stars = moves => ({ one: Math.max(3, Math.ceil(moves * 3)), two: Math.max(2, Math.ceil(moves * 2)), three: Math.max(1, Math.ceil(moves * 1.5)) });
export const slotKey = entry => `${entry.zone_id}:${entry.position.join(',')}`;
export const layoutKey = slot => `${slot.zone}:${slot.position.join(',')}`;
export function catalogFrom(raw, layouts) {
  if (!Array.isArray(raw.ships) || !Array.isArray(raw.containers)) throw new Error('Invalid preset response.');
  const containers = raw.containers.filter(c => Number.isInteger(c.id) && c.id >= 0 && Number.isFinite(c.weight) && c.weight > 0 && Number.isInteger(c.function_id));
  // The API requires ship-physics values within these bounds when creating a
  // level. Accept only the approved values returned by /editor/presets; never
  // use user-editable ship physics from a level draft.
  const ships = raw.ships.filter(s =>
    Number.isInteger(s.id) && typeof s.scene_path === 'string' && layouts[s.scene_path] &&
    Number.isFinite(s.max_x_variance) && s.max_x_variance >= 0 && s.max_x_variance <= 100000 &&
    Number.isFinite(s.max_y_variance) && s.max_y_variance >= 0 && s.max_y_variance <= 100000 &&
    Array.isArray(s.center_offset) && s.center_offset.length === 2 && s.center_offset.every(Number.isFinite)
  ).map(s => ({ ...s, layout: layouts[s.scene_path] }));
  if (!ships.length || !containers.length) throw new Error('No supported ship layouts or containers.');
  return { ships, containers };
}
export function newShip(preset) {
  return { presetId: preset.id, initial: Array(preset.layout.slots.length).fill(null), targets: {}, zones: Array.from(preset.layout.slots, () => []) };
}
export function validate(draft, catalog) {
  const errors = [];
  if (!Array.isArray(draft.ships) || !draft.ships.length || draft.ships.length > 20) return ['Choose between 1 and 20 ships.'];
  const known = new Map(catalog.containers.map(c => [c.id, c]));
  const validCargo = id => id === null || (Number.isInteger(id) && known.has(id) && [0, 1, 4].includes(known.get(id).function_id));
  if (!Array.isArray(draft.depot) || draft.depot.length !== 4 || !draft.depot.every(validCargo)) errors.push('The depot must contain exactly four valid slots.');
  if (!Array.isArray(draft.train) || !draft.train.length || draft.train.length > 200 || !draft.train.every(id => id !== null && validCargo(id))) errors.push('Add 1–200 containers to the repeating train sequence.');
  for (const [index, ship] of draft.ships.entries()) {
    const label = `Ship ${index + 1}: `, preset = catalog.ships.find(s => s.id === ship.presetId);
    if (!preset) { errors.push(label + 'the preset is no longer available.'); continue; }
    const n = preset.layout.slots.length;
    if (!Array.isArray(ship.initial) || ship.initial.length !== n || !ship.initial.every(validCargo)) errors.push(label + 'invalid starting cargo.');
    if (!Array.isArray(ship.zones) || ship.zones.length !== n || !ship.zones.every(a => Array.isArray(a) && a.every(id => id !== null && validCargo(id)) && new Set(a).size === a.length)) errors.push(label + 'invalid target zones.');
    const targets = Object.entries(ship.targets || {});
    if (!targets.length || targets.some(([id, count]) => !validCargo(Number(id)) || !Number.isInteger(count) || count < 1) || targets.reduce((n, [, count]) => n + count, 0) > n) errors.push(label + 'choose a target cargo quantity that fits the ship.');
    if (ship.zones?.flat().length > 200) errors.push(label + 'too many target zone entries (maximum 200).');
  }
  if (catalog.containers.some(c => c.function_id === 4) && !known.has(5)) errors.push('The food-to-waste rule requires container ID 5.');
  return errors;
}
export function toPayload(draft, catalog, minimum) {
  const errors = validate(draft, catalog); if (errors.length) throw new Error(errors.join('\n'));
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error('A successful local check is required.');
  return {
    ships: draft.ships.map(ship => {
      const preset = catalog.ships.find(s => s.id === ship.presetId);
      const entry = (id, i) => ({ container_type_id: id, zone_id: preset.layout.slots[i].zone, position: preset.layout.slots[i].position });
      // The live API returns authoritative values for these preset fields.
      // Its current POST /levels validator rejects missing max_x_variance
      // (HTTP 422). Supply the complete canonical ship snapshot without
      // allowing users to change the physics or scene path.
      return {
        preset_id: preset.id,
        scene_path: preset.scene_path,
        max_x_variance: preset.max_x_variance,
        max_y_variance: preset.max_y_variance,
        center_offset: [...preset.center_offset],
        initial_load: ship.initial.flatMap((id, i) => id === null ? [] : [entry(id, i)]),
        target_load: Object.entries(ship.targets).map(([id, count]) => ({ container_type_id: Number(id), count })),
        target_zones: ship.zones.flatMap((ids, i) => ids.map(id => entry(id, i))),
      };
    }),
    train_container_types: [...draft.train], depot: { width: 2, height: 2, initial_load: draft.depot.flatMap((id, i) => id === null ? [] : [{ container_type_id: id, position: [i % 2, Math.floor(i / 2)] }]) },
    star_thresholds: stars(minimum), dialogue_refs: [], camera_zoom: [0.8, 0.8], level_mode: 0,
  };
}
export function fromPayload(payload, catalog, sourceCode) {
  if (!payload || !Array.isArray(payload.ships) || !Array.isArray(payload.train_container_types)) throw new Error('This level has no compatible payload.');
  if (payload.level_mode !== undefined && payload.level_mode !== 0) throw new Error('Only Easy mode levels can be copied in this editor.');
  if (payload.depot?.width !== 2 || payload.depot?.height !== 2) throw new Error('This level does not use a 2 × 2 depot.');
  const draft = emptyDraft(); draft.sourceCode = sourceCode;
  draft.train = [...payload.train_container_types];
  for (const entry of payload.depot.initial_load || []) {
    const [x, y] = entry.position || [];
    if (![x, y].every(v => Number.isInteger(v) && v >= 0 && v <= 1) || draft.depot[y * 2 + x] !== null) throw new Error('Invalid depot position.');
    draft.depot[y * 2 + x] = entry.container_type_id;
  }
  draft.ships = payload.ships.map(data => {
    const preset = catalog.ships.find(s => s.id === data.preset_id);
    if (!preset) throw new Error(`Ship preset ${data.preset_id} is not supported by this editor.`);
    if (data.scene_path && data.scene_path !== preset.scene_path) throw new Error('The ship scene changed. This level cannot be copied safely.');
    const ship = newShip(preset);
    const index = entry => { const i = preset.layout.slots.findIndex(slot => layoutKey(slot) === slotKey(entry)); if (i < 0) throw new Error('A level contains an unknown loading position.'); return i; };
    // Some older level snapshots reference a ship preset without repeating
    // all its fields. Match Godot's preset-copy behaviour only when the field
    // is OMITTED. An explicit [] means the level really starts empty.
    const initialLoad = Object.hasOwn(data, 'initial_load') ? data.initial_load : (preset.initial_load ?? []);
    const targetLoad = Object.hasOwn(data, 'target_load') ? data.target_load : (preset.target_load ?? []);
    const targetZones = Object.hasOwn(data, 'target_zones') ? data.target_zones : (preset.target_zones ?? []);
    if (![initialLoad, targetLoad, targetZones].every(Array.isArray)) throw new Error('Invalid ship cargo in the level snapshot.');
    for (const e of initialLoad) { const i = index(e); if (ship.initial[i] !== null) throw new Error('Duplicate starting position.'); ship.initial[i] = e.container_type_id; }
    for (const e of targetLoad) { if (Object.hasOwn(ship.targets, e.container_type_id)) throw new Error('Duplicate target quantity.'); ship.targets[e.container_type_id] = e.count; }
    for (const e of targetZones) ship.zones[index(e)].push(e.container_type_id);
    return ship;
  });
  const errors = validate(draft, catalog); if (errors.length) throw new Error(errors.join('\n'));
  return draft;
}
