import { compile, initialState, stateKey, successors, heuristic, replay } from './rules.js';

// All work is performed by the browser Web Worker. No server-side search.
class Heap {
  data = [];
  peek() { return this.data[0]; }
  push(node) {
    let i = this.data.length;
    this.data.push(node);
    while (i) {
      const p = (i - 1) >> 1;
      if (this.data[p].f <= node.f) break;
      this.data[i] = this.data[p]; i = p;
    }
    this.data[i] = node;
  }
  pop() {
    const top = this.data[0], last = this.data.pop();
    if (this.data.length) {
      let i = 0;
      while (i * 2 + 1 < this.data.length) {
        let c = i * 2 + 1;
        if (c + 1 < this.data.length && this.data[c + 1].f < this.data[c].f) c++;
        if (this.data[c].f >= last.f) break;
        this.data[i] = this.data[c]; i = c;
      }
      this.data[i] = last;
    }
    return top;
  }
}

function witness(node) {
  const moves = [];
  for (let n = node; n.move; n = n.parent) moves.push(n.move);
  return moves.reverse();
}

/**
 * A* for ordinary cargo and Dijkstra for effects (the heuristic is zero).
 * Up to maxSolutions optimal terminal paths are compared. Goal states bypass
 * visited-state deduplication so different paths to the same completed state
 * can actually be counted. The first popped goal is optimal under this model;
 * paths with more moves are never needed after that point.
 */
export function solve(draft, catalog, {
  maxStates = 2000000, maxMs = 180000, maxSolutions = 10, onProgress = () => {},
} = {}) {
  const start = performance.now(), model = compile(draft, catalog);
  const queue = new Heap(), best = new Map(), root = initialState(model);
  queue.push({ state: root, g: 0, f: heuristic(root, model), parent: null, move: null });
  best.set(stateKey(root), 0);
  const solutionLimit = Math.max(1, Math.min(10, Math.floor(maxSolutions) || 10));
  let explored = 0, lastUpdate = 0, bestPath = null, found = 0;
  const emit = (elapsed, depth = 0) => onProgress({
    explored, states: best.size, queued: queue.data.length, elapsed, depth,
    found, maxSolutions: solutionLimit, maxStates,
  });
  const finish = (elapsed, limited = false) => {
    emit(elapsed, bestPath?.length || 0);
    if (bestPath) return {
      status: 'solved', minimum: bestPath.length, moves: bestPath,
      solutionsFound: found, searchComplete: !limited, explored, states: best.size, elapsed,
    };
    return {
      status: limited ? 'limit' : 'impossible', solutionsFound: 0,
      explored, states: best.size, elapsed,
    };
  };
  while (queue.data.length) {
    const elapsed = performance.now() - start;
    if (elapsed > maxMs || best.size > maxStates || queue.data.length > maxStates) {
      return finish(elapsed, true);
    }
    // After the optimal solution is known, no longer paths are useful.
    if (bestPath && queue.peek().f > bestPath.length) return finish(elapsed);
    const node = queue.pop();
    if (node.state.ship === model.ships.length) {
      const moves = witness(node);
      if (!replay(draft, catalog, moves)) throw new Error('Solution replay failed.');
      found++;
      if (!bestPath || moves.length < bestPath.length) bestPath = moves;
      if (found >= solutionLimit) return finish(performance.now() - start);
      continue;
    }
    if (best.get(stateKey(node.state)) !== node.g) continue;
    explored++;
    const now = performance.now();
    if (now - lastUpdate >= 100) { emit(now - start, node.g); lastUpdate = now; }
    for (const child of successors(node.state, model)) {
      const g = node.g + 1;
      if (bestPath && g > bestPath.length) continue;
      if (child.state.ship === model.ships.length) {
        // Keep distinct completion paths even though they share one goal key.
        queue.push({ ...child, g, f: g, parent: node });
        continue;
      }
      const k = stateKey(child.state);
      if (best.has(k) && best.get(k) <= g) continue;
      best.set(k, g);
      queue.push({ ...child, g, f: g + heuristic(child.state, model), parent: node });
    }
  }
  return finish(performance.now() - start);
}
