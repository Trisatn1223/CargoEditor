import { compile, initialState, stateKey, successors, heuristic, replay } from './rules.js';
class Heap {
  data = [];
  push(node) { let i = this.data.length; this.data.push(node); while (i) { const p = (i - 1) >> 1; if (this.data[p].f <= node.f) break; this.data[i] = this.data[p]; i = p; } this.data[i] = node; }
  pop() { const top = this.data[0], last = this.data.pop(); if (this.data.length) { let i = 0; while (i * 2 + 1 < this.data.length) { let c = i * 2 + 1; if (c + 1 < this.data.length && this.data[c + 1].f < this.data[c].f) c++; if (this.data[c].f >= last.f) break; this.data[i] = this.data[c]; i = c; } this.data[i] = last; } return top; }
}
export function solve(draft, catalog, { maxStates = 250000, maxMs = 60000, onProgress = () => {} } = {}) {
  const start = performance.now(), model = compile(draft, catalog), root = initialState(model), queue = new Heap(), best = new Map();
  queue.push({ state: root, g: 0, f: heuristic(root, model), parent: null, move: null }); best.set(stateKey(root), 0);
  let explored = 0, lastUpdate = 0;
  while (queue.data.length) {
    const now = performance.now(), elapsed = now - start;
    if (elapsed > maxMs || best.size > maxStates || queue.data.length > maxStates) return { status: 'limit', explored, states: best.size, elapsed };
    const node = queue.pop(), key = stateKey(node.state);
    if (best.get(key) !== node.g) continue;
    if (node.state.ship === model.ships.length) {
      const moves = []; for (let n = node; n.move; n = n.parent) moves.push(n.move); moves.reverse();
      if (!replay(draft, catalog, moves)) throw new Error('Solution replay failed.');
      onProgress({ explored, states: best.size, elapsed, depth: node.g });
      return { status: 'solved', minimum: moves.length, moves, explored, states: best.size, elapsed };
    }
    explored++;
    if (now - lastUpdate >= 100) { onProgress({ explored, states: best.size, elapsed, depth: node.g }); lastUpdate = now; }
    for (const child of successors(node.state, model)) {
      const g = node.g + 1, k = stateKey(child.state);
      if (best.has(k) && best.get(k) <= g) continue;
      best.set(k, g); queue.push({ ...child, g, f: g + heuristic(child.state, model), parent: node });
    }
  }
  return { status: 'impossible', explored, states: best.size, elapsed: performance.now() - start };
}
