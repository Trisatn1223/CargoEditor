# Local rules and Godot compatibility

Source: the user's Godot.zip supplied on 23 October 2026. Only the derived ship geometry is shipped. Source scene SHA-256 hashes are recorded in `public/layouts.json`.

## Implemented rules

| Behaviour | Source | Browser implementation |
| --- | --- | --- |
| A successful transfer counts as one move | `Objects/Spieler/spieler.gd`, `zugBeendetAufgabe` | One edge per transfer; no cost for waiting on animations |
| Free move to any empty accessible loading slot | `spieler.gd`, `stopMoveContainer` | Train → ship/depot/outbound, ship → ship/depot/outbound, depot → ship/outbound |
| Incoming train repeats its sequence | `Objects/Zug/Zug.gd`, `getJetzigeContainerID` | Train index increments modulo sequence length when consumed |
| Outgoing train removes cargo | `Zug.gd`, `moveTrain_ContainerWeg` | Outbound sink; wait until it leaves before next transfer |
| Depot has four slots | `Level/BasisLevel.tscn` | Four cells; occupancy persists between ships |
| Exact per-type target counts, no extra types | `Objects/Schiff/schiff.gd`, `checkFuerLadungsAnzahl` | Exact tally equality |
| Restrictions apply to each container type only if that type has target positions | `schiff.gd`, `checkForLadungsPosition` | A type with no restrictions can occupy any slot |
| Y lever arm = slot position-in-zone + zone offset + ship offset | `schiff.gd`, `berechneSchwerpunktsVektoren` | Scene-derived Y lever + API `center_offset[1]` |
| Y balance = sum(weight × Y lever) / ((lightest + heaviest) / 2) | `schiff.gd`, `getCurrentLadungsverteilung` | Same formula; empty ship = 0 |
| Easy checks the Y balance component against the X variance threshold | `LevelManager.gd`, `eZugBeendet` | Deliberately uses `max_x_variance`, matching the provided Godot source; X lever is not checked |
| Food without a refrigerator becomes ID 5 | `Objects/Container/container.gd`, `eZugBeendet` | Food transforms into waste after a move |
| Refrigerators cover eight neighbours, in the same zone | `ladepunkt.gd`, `getLadepunkteKreis` | Includes diagonal neighbours; no cross-zone cooling |
| Depot/train do not apply ship container effects | `container.gd`, `v_ZonenID >= 0` | Food is safe in depot/train |
| Completed ships depart | `LevelManager.gd`, `eZugBeendet` | Sequential ships; goals checked after transfers |

Only the currently supplied function IDs 0 (normal), 1 (refrigerator) and 4 (food) are supported. Unknown future functions, scenes or coordinates fail validation instead of being approximated. Container names are English UI labels; IDs, weights and functions come from the API.

## Important differences and existing Godot bugs

The editor is a **deterministic settled-turn rules model**, not a headless execution of the complete Godot project. It is not a server verifier.

- **Food event ordering:** the uploaded `LevelManager` subscribes to `ZugBeendet` before subsequently spawned containers. It can decide that a ship is complete before a food container spoils. The editor intentionally checks both balance and the post-effect goal; it will not publish a witness that relies on a spoiled-food race. For special-container levels, minimums may differ from the current game's race behaviour. Incoming pre-spawned ships also receive container signals in Godot; the editor applies effects only to the active ship. Fix the game to evaluate effects for the active ship first, then balance and goals once.
- **Animation interactions:** transient retrieval from a departing outbound train, and input during ship transition, are not modelled. The solver waits until each transfer and automatic animation has settled. This avoids timing-dependent solutions.
- **Y axis and threshold:** The editor now uses the **Y** lever component and `center_offset[1]`, matching the uploaded Godot Easy-mode call `getCurrentLadungsverteilungY()`. The uploaded game compares this Y value against `v_MaxXVarianz`, so the editor uses `max_x_variance` too. If that threshold is a Godot typo, fix the game and editor together before changing it to `max_y_variance`.
- **Target zones:** `C_GlobaleFunkitonen.containsIundV` compares `v` only; it ignores the zone stored in `i`. The browser mirrors that behaviour: restricting (x,y) in one hold also allows the same coordinate in another hold. The API export still preserves `zone_id`. Fix both implementations together to enforce hold-specific restrictions.
- **Move cap:** Godot fails when `moves >= one_star_threshold`, even on a completing move. The local solver searches without that provisional cap; derived thresholds are `ceil(min × 3/2/1.5)`, and a positive minimum is always below the one-star cap. A starting state that already meets the goal needs an actual transfer to trigger completion, as in the game.
- **Next ship bound:** `doesNextShipExsist()` uses `size >= id`; for zero-based indices it should normally be `id < size`. Test the last-ship transition in Godot before release.

These defects are documented rather than silently patching an uploaded game project. The static editor cannot fix the running mobile game or API.

## Search and correctness scope

A* is used for all supported cargo. With ordinary cargo, an admissible lower bound counts missing and surplus container types on remaining ships. When food can turn into waste as a side effect, the bound excludes free food-surplus removal and waste-deficit filling, but still counts unavoidable transfers of other types. This preserves optimality while searching more efficiently than plain Dijkstra. Every generated move costs one. A returned solved result is optimal **under the rules above**, and the witness is replayed against that same rule module before success is reported.

The queue and visited-state budgets are bounded. At 2,000,000 states/queued nodes or 180 seconds, the result is `limit`, not `impossible`. The UI offers cancellation by terminating the Web Worker. Only an exhausted queue can produce `impossible`. The search stores up to 10 equal-cost incoming transitions per state and reconstructs up to 10 **distinct** optimal routes, even when they merge into the same final game state. The move count remains the primary optimum; among equal-length routes, less depot handling and fewer outbound transfers are preferred. Depot slot order remains part of the state key so the replayed route uses the exact physical slots.

The solver is deliberately local. No moves or draft are sent while checking. The local solution uses an editor-only move format (`ship`, `container_type_id`, `from`, `to`); it is **not** sent to `/service/levels/{code}/submit-solutions`, whose replay contract is unspecified and requires a secret service role. The normal publication POST contains only the documented community payload.

## API-owned publication

Anonymous identity: `POST /auth/anonymous {}` → `token`, confirmed by `ContainerGameAPI_Autoload.gd`.

Create: `POST /levels {"user_difficulty":"easy","payload":...}` with that player's Bearer token. There is no update-in-place flow; copying a level always creates a fresh POST and a new server-assigned code.

For a fully immediate public workflow, the API must explicitly support a community publication policy. If it depends on the missing server replay validator, levels remain pending. Making the website static does not remove this policy. A public browser's local result is editable by its user, so the API must not treat a client-supplied minimum as independently verified. The web hosting container still performs no game calculations whichever API publication policy is chosen.
