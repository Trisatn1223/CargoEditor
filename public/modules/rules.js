import { tally, validate } from './model.js';
// Settled-turn model: wait for each train/ship animation before the next transfer.
// Source mapping and intentional safety differences: docs/GODOT_RULES.md.
export function compile(draft, catalog) {
  const errors = validate(draft, catalog); if (errors.length) throw new Error(errors.join('\n'));
  const containers = new Map(catalog.containers.map(c => [c.id, c]));
  const ships = draft.ships.map(s => {
    const p = catalog.ships.find(p => p.id === s.presetId);
    return { ...s, slots: p.layout.slots, offset: p.center_offset, limit: p.max_x_variance };
  });
  const used = [...draft.train, ...draft.depot, ...draft.ships.flatMap(s => [...s.initial, ...Object.keys(s.targets).map(Number)])].filter(id => id !== null);
  return {
    ships, containers, train: draft.train, depot: draft.depot,
    hasEffects: used.some(id => containers.get(id).function_id !== 0),
    canTransform: used.some(id => containers.get(id).function_id === 4),
  };
}
export function balance(cells, ship, containers) {
  let moment = 0, light = Infinity, heavy = 0;
  cells.forEach((id, i) => {
    if (id === null) return;
    const w = containers.get(id).weight;
    light = Math.min(light, w); heavy = Math.max(heavy, w);
    moment += w * (ship.slots[i].lever[1] + ship.offset[1]);
  });
  return heavy ? moment / ((light + heavy) / 2) : 0;
}
export function effects(cells, ship, containers) {
  const out = [...cells];
  cells.forEach((id, i) => {
    if (id === null || containers.get(id).function_id !== 4) return;
    const a = ship.slots[i];
    const cooled = cells.some((other, j) => {
      if (other === null || containers.get(other).function_id !== 1) return false;
      const b = ship.slots[j];
      return a.zone === b.zone && i !== j && Math.abs(a.position[0] - b.position[0]) <= 1 && Math.abs(a.position[1] - b.position[1]) <= 1;
    });
    if (!cooled) out[i] = 5;
  });
  return out;
}
export function matchesGoal(cells, ship) {
  const counts = tally(cells), ids = new Set([...Object.keys(counts), ...Object.keys(ship.targets)]);
  if ([...ids].some(id => (counts[id] || 0) !== (ship.targets[id] || 0))) return false;
  // Current Godot containsIundV compares grid position only, not zone ID.
  return cells.every((id, i) => {
    if (id === null) return true;
    const allowed = ship.slots.filter((_, j) => ship.zones[j].includes(id));
    return !allowed.length || allowed.some(s => s.position[0] === ship.slots[i].position[0] && s.position[1] === ship.slots[i].position[1]);
  });
}
/**
 * Proves a terminal configuration impossible, before exploring any transfers.
 * Check both allowed cargo slots and the final Godot Easy Y-balance. This
 * deliberately does NOT approximate cooling effects or intermediate moves.
 * Return null when possible OR when a bounded static check is inconclusive.
 */
export function impossibleGoalReason(model) {
  for (let shipNumber = 0; shipNumber < model.ships.length; shipNumber++) {
    const ship = model.ships[shipNumber], requirements = Object.entries(ship.targets)
      .filter(([, count]) => count > 0).map(([id, count]) => ({
        id: Number(id), count, weight: model.containers.get(Number(id)).weight,
      }));
    const slots = ship.slots, required = requirements.reduce((sum, t) => sum + t.count, 0);
    if (required > slots.length) return `Ship ${shipNumber + 1}: target cargo exceeds capacity.`;
    const accepted = requirements.map(t => {
      const selected = slots.filter((slot, i) => ship.zones[i].includes(t.id));
      return slots.map((slot, i) => !selected.length || selected.some(s =>
        s.position[0] === slot.position[0] && s.position[1] === slot.position[1]));
    });
    for (let t = 0; t < requirements.length; t++) {
      if (accepted[t].filter(Boolean).length < requirements[t].count) {
        return `Ship ${shipNumber + 1}: allowed target positions cannot hold all required cargo type ${requirements[t].id} containers.`;
      }
    }
    const light = Math.min(...requirements.map(t => t.weight));
    const heavy = Math.max(...requirements.map(t => t.weight));
    const normalizer = (light + heavy) / 2;
    const counts = requirements.map(t => t.count);
    let visited = 0;
    const maxChecks = 250000;
    const search = (i, remaining, moment) => {
      if (++visited > maxChecks) return null; // inconclusive, never declare impossible
      const placesLeft = slots.length - i;
      if (placesLeft < remaining) return false;
      if (i === slots.length) return remaining === 0 &&
        Math.abs(moment / normalizer) <= ship.limit + 1e-9;
      let unknown = false;
      if (remaining < placesLeft) {
        const empty = search(i + 1, remaining, moment);
        if (empty === true) return true;
        if (empty === null) unknown = true;
      }
      for (let j = 0; j < requirements.length; j++) {
        if (!counts[j] || !accepted[j][i]) continue;
        counts[j]--;
        const next = search(i + 1, remaining - 1,
          moment + requirements[j].weight * (slots[i].lever[1] + ship.offset[1]));
        counts[j]++;
        if (next === true) return true;
        if (next === null) unknown = true;
      }
      return unknown ? null : false;
    };
    const feasible = search(0, required, 0);
    if (feasible === false) return `Ship ${shipNumber + 1}: no final loading arrangement satisfies both the target positions and the Y balance limit.`;
  }
  return null;
}

export function initialState(model) {
  return { ship: 0, cells: [...model.ships[0].initial], depot: [...model.depot], train: 0 };
}
export function stateKey(state) {
  // Depot positions are NOT interchangeable for solution replay: a witness
  // references exact depot indices. Distinct arrangements must remain distinct.
  return `${state.ship}|${state.train}|${state.cells.map(v => v ?? '_').join(',')}|${state.depot.map(v => v ?? '_').join(',')}`;
}
export function* successors(state, model) {
  const ship = model.ships[state.ship]; if (!ship) return;
  const sources = [{ kind: 'train', index: state.train, id: model.train[state.train] },
    ...state.cells.flatMap((id, index) => id === null ? [] : [{ kind: 'ship', index, id }]),
    ...state.depot.flatMap((id, index) => id === null ? [] : [{ kind: 'depot', index, id }])];
  const destinations = [
    ...state.cells.flatMap((id, index) => id !== null ? [] : [{ kind: 'ship', index }]),
    // Only one empty depot slot is needed: all four are equivalent.
    ...(state.depot.includes(null) ? [{ kind: 'depot', index: state.depot.indexOf(null) }] : []),
    { kind: 'outbound', index: 0 },
  ];
  for (const from of sources) for (const to of destinations) {
    if (from.kind === 'depot' && to.kind === 'depot') continue;
    const next = { ship: state.ship, cells: [...state.cells], depot: [...state.depot], train: state.train };
    if (from.kind === 'train') next.train = (state.train + 1) % model.train.length;
    else next[from.kind === 'ship' ? 'cells' : 'depot'][from.index] = null;
    if (to.kind !== 'outbound') next[to.kind === 'ship' ? 'cells' : 'depot'][to.index] = from.id;
    // Check both before and after food effects, avoiding the game's signal-order
    // race in which a ship can depart before food turns into waste.
    if (Math.abs(balance(next.cells, ship, model.containers)) > ship.limit + 1e-9) continue;
    next.cells = effects(next.cells, ship, model.containers);
    if (Math.abs(balance(next.cells, ship, model.containers)) > ship.limit + 1e-9) continue;
    if (matchesGoal(next.cells, ship)) {
      next.ship++;
      next.cells = model.ships[next.ship] ? [...model.ships[next.ship].initial] : [];
    }
    const move = { ship: state.ship, container_type_id: from.id, from: { kind: from.kind, index: from.index }, to };
    yield { state: next, move };
  }
}
export function heuristic(state, model) {
  // Non-transforming cargo needs one move per excess/missing type. Food may
  // spoil into waste for free when another move happens, so exclude these
  // free conversions but keep the other type deficits/surpluses as an
  // admissible lower bound. This is much stronger than uniform-cost search.
  let lowerBound = 0;
  for (let i = state.ship; i < model.ships.length; i++) {
    const ship = model.ships[i], cells = i === state.ship ? state.cells : ship.initial;
    const counts = tally(cells);
    if (model.canTransform) {
      // Food (ID 4) can spoil into waste (ID 5) during another transfer.
      // Such a free conversion may eliminate food surplus or fill a waste
      // deficit, so do not charge a move for either. All other count changes
      // still require loading/unloading one container per move.
      for (const id of new Set([...Object.keys(counts), ...Object.keys(ship.targets)])) {
        const current = counts[id] || 0, required = ship.targets[id] || 0;
        if (Number(id) !== 5) lowerBound += Math.max(0, required - current);
        if (Number(id) !== 4) lowerBound += Math.max(0, current - required);
      }
      continue;
    }
    for (const id of new Set([...Object.keys(counts), ...Object.keys(ship.targets)])) {
      lowerBound += Math.abs((counts[id] || 0) - (ship.targets[id] || 0));
    }
  }
  return lowerBound;
}
export function replay(draft, catalog, moves) {
  const model = compile(draft, catalog); let state = initialState(model);
  for (const move of moves) {
    const candidate = [...successors(state, model)].find(c => JSON.stringify(c.move) === JSON.stringify(move));
    if (!candidate) throw new Error('The solution contains an illegal move.');
    state = candidate.state;
  }
  return state.ship === model.ships.length;
}
