# Solver research and implemented strategy (24 October 2026)

Cargo Chief is a **unit-cost state-space planning** problem, not Sokoban:
containers can be transferred between the train, a fixed four-cell depot,
ship slots, and the outgoing train. The incoming train cycles, cargo has
individual types and weights, and completion requires both exact cargo
targets and the configured Y-balance limit. Every legal transfer costs 1.

## Research and algorithm choice

1. [Pereira, Ritt & Buriol: Optimal Sokoban solving using pattern databases
   with specific domain knowledge (Artificial Intelligence, 2015)](https://www.sciencedirect.com/science/article/pii/S0004370215000867):
   Domain-specific heuristics, deadlock tests, and effective tie breaking matter
   substantially more than blindly increasing the search budget.
2. [Pereira et al.: Finding Optimal Solutions to Sokoban Using Instance Dependent
   Pattern Databases (SOCS)](https://ojs.aaai.org/index.php/SOCS/article/view/18290):
   Goal abstraction and instance-dependent pattern databases improve A*'s
   admissible lower bounds on transportation puzzles.
3. [Asai & Fukunaga: Tiebreaking Strategies for A* Search (AAAI 2016)](https://ojs.aaai.org/index.php/AAAI/article/view/10071):
   Tie-breaking within large equal-cost plateaus can dominate practical effort.
4. [Corrêa, Pereira & Ritt: Analyzing Tie-Breaking Strategies for A* (IJCAI 2018)](https://www.ijcai.org/proceedings/2018/655):
   There is no one universally optimal tie-breaking rule.

A precomputed Sokoban pattern database is **not** dropped into this code:
there are no push-only moves, no walls, and the cyclic train/depot/weight
constraints would invalidate Sokoban's graph. A custom Cargo Chief pattern
database would require an independent proof that its abstraction never
overestimates moves. The current smaller rule-based heuristic is easier to
maintain and test against the mobile game.

## Search pipeline in the browser Web Worker

- First, a **bounded static goal feasibility check** tries final cargo layouts
  respecting target zones and ship Y balance. If it exhausts all assignments
  without a valid end layout, the result is genuinely impossible with a
  specific message; a 250,000-node cap makes an inconclusive test fall back to
  the main search, never a false impossible result.
- Next, the actual game transition generator checks **every legal one-move
  finish**. This includes depot -> ship and has no dependency on a large search
  budget. A one-transfer finish is already globally optimal because this game
  only completes a ship after a transfer. The witness is replayed.
- Otherwise, run **exact A*** ordered primarily by `f = g + h`.
  The admissible lower bound counts unavoidable per-type removals/additions
  for ordinary cargo, and discounts the food-to-waste changes that can happen
  automatically. The search is still correct with refrigerators.
- Within equal `f`/`g` plateaus, prefer loading directly from depot or train
  to ship before storage and outbound detours. Only the ordering changes.
- Alternative equally short routes are preserved in a predecessor DAG,
  replayed, and compared by a secondary handling-cost preference (never
  altering the proven minimum move count). Only this secondary enumeration is
  time-boxed to 4 seconds or 20,000 further expansions.
- The UI gets a progress report as soon as an A* goal is popped and the
  minimum is mathematically proven. It does not have to wait for ten variant
  routes. If no solution is proven before the overall budget, report
  `limit` instead of incorrectly calling the level impossible.
- All moves, snapshots, and calculations remain **entirely local**. Only the
  separate publication action sends level configuration to FastAPI.

## Specifically: one container already in the depot

A level with one ship, one target normal cargo type, that cargo in the depot,
and an empty balanced middle ship slot should finish in **one move**:
`depot[index] -> ship[centre]`.

The regression test sets `maxStates: 0`: the dedicated direct-goal probe must
still return `minimum:1`, `explored:1`, and a re-playable witness.

If the same-looking level fails, inspect the **target cargo type**, target
positions, Y-balance threshold, ship preset, cooling effects, and the fact that
completion only happens following a legal transfer. An apparent one-move
finish may not actually satisfy those rules. The feasibility checker now
detects some such hard contradictions without expanding a search graph.

## Limits

There is no guarantee of finding *all* solutions or solving every large
instance within 2,000,000 states or 180 seconds. One-move optimality and
infeasible end layouts are proven without the large search. Other solved
results remain optimal under the editor's documented settled-turn rules,
which still differ from some Godot animation/signal timing behavior.

See `docs/GODOT_RULES.md` for the exact Y-axis and transition contracts.
