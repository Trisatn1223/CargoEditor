import { compile, initialState, stateKey, successors, heuristic, replay, impossibleGoalReason } from './rules.js';

// All search, alternative-route enumeration and replay remain in a Web Worker.
// Equal-cost predecessors form a shortest-path DAG instead of being silently
// dropped by the visited-state map.
class Heap {
  data = [];
  static less(a, b) {
    // Prefer deeper paths at the same A* lower bound: reach a complete
    // solution quickly without compromising optimality.
    return a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.order < b.order)));
  }
  peek() { return this.data[0]; }
  push(node) {
    let i = this.data.length;
    this.data.push(node);
    while (i) {
      const p = (i - 1) >> 1;
      if (!Heap.less(node, this.data[p])) break;
      this.data[i] = this.data[p]; i = p;
    }
    this.data[i] = node;
  }
  pop() {
    const top = this.data[0], last = this.data.pop();
    if (this.data.length) {
      let i = 0;
      while (2 * i + 1 < this.data.length) {
        let c = i * 2 + 1;
        if (c + 1 < this.data.length && Heap.less(this.data[c + 1], this.data[c])) c++;
        if (!Heap.less(this.data[c], last)) break;
        this.data[i] = this.data[c]; i = c;
      }
      this.data[i] = last;
    }
    return top;
  }
}

function pathCount(node, known, cap) {
  if (known.has(node)) return known.get(node);
  if (!node.parents.length) return 1;
  let count = 0;
  for (const edge of node.parents) {
    if (edge.parent.g + 1 !== node.g) continue;
    count += pathCount(edge.parent, known, cap);
    if (count >= cap) break;
  }
  const result = Math.min(cap, count);
  known.set(node, result);
  return result;
}

function* routes(node, moves = []) {
  if (!node.parents.length) {
    yield [...moves].reverse();
    return;
  }
  for (const { parent, move } of node.parents) {
    if (parent.g + 1 !== node.g) continue;
    yield* routes(parent, [...moves, move]);
  }
}

// Prefer direct loading where optimal routes have the same move count.
// This is a secondary preference, not an extra turn cost for A*.
function handlingCost(moves) {
  let score = 0;
  for (const move of moves) {
    if (move.to.kind === 'depot') score += 2;
    if (move.from.kind === 'ship' && move.to.kind === 'ship') score += 2;
    if (move.to.kind === 'outbound') score += 1;
  }
  return score;
}

/**
 * Fast one-move proof. A cargo level cannot finish without a transfer, so a
 * legal goal reached after one action is optimal. The same official successor
 * rules and witness replay are used as in the full solver.
 */
function directFinish(draft, catalog, model, rootState, limit, startedAt) {
  const candidates = [], unique = new Set();
  for (const child of successors(rootState, model)) {
    if (child.state.ship !== model.ships.length) continue;
    const moves = [child.move], key = JSON.stringify(moves);
    if (unique.has(key)) continue;
    unique.add(key);
    if (!replay(draft, catalog, moves)) throw new Error('One-move goal failed replay.');
    candidates.push({ moves, score: handlingCost(moves), key });
    if (candidates.length >= limit) break;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
  return { status: 'solved', minimum: 1, moves: candidates[0].moves,
    solutionsFound: candidates.length, searchComplete: candidates.length < limit,
    optimalProven: true, strategy: 'direct-goal', explored: 1, states: 1,
    elapsed: performance.now() - startedAt };
}

export function solve(draft, catalog, {
  maxStates = 2000000, maxMs = 180000, maxSolutions = 10, onProgress = () => {},
} = {}) {
  const start = performance.now(), model = compile(draft, catalog);
  const impossible = impossibleGoalReason(model);
  if (impossible) {
    const elapsed = performance.now() - start;
    onProgress({ explored: 0, states: 0, queued: 0, elapsed,
      found: 0, maxSolutions, maxStates, phase: 'impossible', reason: impossible });
    return { status: 'impossible', reason: impossible, explored: 0,
      states: 0, solutionsFound: 0, elapsed };
  }
  const queue = new Heap(), best = new Map(), goalNodes = [];
  const limit = Math.max(1, Math.min(10, Math.floor(maxSolutions) || 10));
  let order = 0, explored = 0, optimal = null, found = 0, lastUpdate = 0;
  const rootState = initialState(model);
  const rootKey = stateKey(rootState);
  const root = { key: rootKey, state: rootState, g: 0, f: heuristic(rootState, model), parents: [], order: order++ };
  best.set(rootKey, root); queue.push(root);
  const immediate = directFinish(draft, catalog, model, rootState, limit, start);
  if (immediate) {
    onProgress({ explored: 1, states: 1, queued: 0, elapsed: immediate.elapsed,
      found: immediate.solutionsFound, bestMoves: 1, maxSolutions: limit, maxStates,
      phase: 'complete', directChecked: true });
    return immediate;
  }
  const directChecked = true;
  // Only the secondary enumeration of equally short routes is time-boxed.
  // This prevents a proven minimum being held hostage by variants.
  const alternativesMs = 4000, alternativesStates = 20000;
  let foundAt = 0, exploredAtFirstGoal = 0;

  const countGoalPaths = () => {
    const cache = new Map();
    let count = 0;
    for (const goal of goalNodes) {
      count += pathCount(goal, cache, limit - count);
      if (count >= limit) break;
    }
    return Math.min(count, limit);
  };
  const emit = elapsed => onProgress({
    explored, states: best.size, queued: queue.data.length, elapsed,
    found, maxSolutions: limit, maxStates, bestMoves: optimal,
    phase: optimal === null ? 'search' : 'alternatives', directChecked,
  });
  const finish = (limited = false) => {
    const elapsed = performance.now() - start;
    if (optimal === null) {
      emit(elapsed);
      return { status: limited ? 'limit' : 'impossible', explored,
        states: best.size, solutionsFound: 0, elapsed };
    }
    const distinct = new Set(), candidates = [];
    for (const goal of goalNodes) {
      for (const moves of routes(goal)) {
        if (moves.length !== optimal) continue;
        // Multiple predecessor edges can still produce the same move sequence.
        const key = JSON.stringify(moves);
        if (distinct.has(key)) continue;
        distinct.add(key);
        if (!replay(draft, catalog, moves)) throw new Error('Solution replay failed.');
        candidates.push({ moves, score: handlingCost(moves), key });
        if (candidates.length >= limit) break;
      }
      if (candidates.length >= limit) break;
    }
    if (!candidates.length) throw new Error('No valid route could be reconstructed.');
    candidates.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
    found = candidates.length;
    emit(elapsed);
    return { status: 'solved', minimum: optimal, moves: candidates[0].moves,
      solutionsFound: found, searchComplete: !limited, optimalProven: true,
      strategy: 'astar', explored, states: best.size, elapsed };
  };

  let limited = false;
  while (queue.data.length) {
    const elapsed = performance.now() - start;
    if (elapsed > maxMs || best.size > maxStates || queue.data.length > maxStates) {
      limited = true; break;
    }
    if (optimal !== null) {
      if (queue.peek().f > optimal) break;
      if (elapsed - foundAt > alternativesMs || explored - exploredAtFirstGoal > alternativesStates) {
        limited = true; break;
      }
    }
    const node = queue.pop();
    if (best.get(node.key) !== node) continue; // stale, improved path
    if (node.state.ship === model.ships.length) {
      if (optimal === null) {
        optimal = node.g; foundAt = performance.now() - start;
        exploredAtFirstGoal = explored;
        found = 1;
        emit(foundAt); // a mathematically proven minimum is available
      }
      if (node.g === optimal && !goalNodes.includes(node)) goalNodes.push(node);
      found = countGoalPaths();
      if (found >= limit) break;
      continue;
    }
    explored++;
    const now = performance.now();
    if (now - lastUpdate >= 100) {
      if (goalNodes.length) found = countGoalPaths();
      emit(now - start); lastUpdate = now;
    }
    for (const child of successors(node.state, model)) {
      const g = node.g + 1;
      const f = g + heuristic(child.state, model);
      if (optimal !== null && f > optimal) continue;
      const key = stateKey(child.state), previous = best.get(key);
      if (previous && previous.g < g) continue;
      const parentEdge = { parent: node, move: child.move };
      if (previous && previous.g === g) {
        // Preserve alternate equal-cost paths through the same game state.
        if (previous.parents.length < limit &&
            !previous.parents.some(e => e.parent === node && JSON.stringify(e.move) === JSON.stringify(child.move))) {
          previous.parents.push(parentEdge);
        }
        continue;
      }
      const next = { key, state: child.state, g, f, parents: [parentEdge], order: order++ };
      best.set(key, next);
      queue.push(next);
    }
  }
  return finish(limited);
}
