# Cargo Chief · Level Workshop

A responsive, English-language community editor for Cargo Chief. The production container serves static HTML, CSS, JavaScript and preset data. The solver runs in a browser Web Worker. There is **no server-side game solver, application backend, database, or service token** in this repository.

- Build starting cargo, target quantities, allowed target positions, a 2 × 2 depot and a cyclic incoming train.
- Easy mode only (`level_mode: 0`); only the Y balance is evaluated.
- Run a cancellable local A*/Dijkstra search, replay its witness locally and derive star thresholds from its proven minimum **within the documented local rules**.
- Load an existing code as a new copy. The original level is never overwritten.
- After checking, submit with an anonymous **player** token; display the actual API-assigned code, Copy to clipboard, and New level.
- Distinguish a saved level from an API-confirmed published level. There are no fabricated share codes.
- Autosave drafts on this device; keep editing if the API is unavailable.

## Run locally

```sh
python3 -m http.server 8080 --directory public
```

Open http://localhost:8080. ES modules and Web Workers require HTTP(S), not `file://`. Local design/checking uses the bundled official presets when CORS prevents live API access.

```sh
npm test
docker compose up -d --build
```

The Docker site is at http://127.0.0.1:8090. It is intended to sit behind your existing HTTPS reverse proxy.

## Deployment

**Start here: [German server guide](docs/SERVER_SETUP_DE.md).**

Domain: `cargo-editor.dreamislandstudio.de`

Repository: https://github.com/Trisatn1223/CargoEditor

API: `https://cargo-api.dreamislandstudio.de`

The supplied systemd timer checks `main` every 30 minutes, runs tests during the image build, probes the new image, and deploys it. Failed tests/builds do not replace the running site. A failed Compose deployment attempts to restore the previous image.

## Integration boundaries

1. On 23 October 2026, `/editor/presets` returned official data, but the API's CORS preflight rejected the editor domain. The API operator must allow that exact origin. The editor container cannot override another origin's CORS policy.
2. The supplied backend handoff says automatic replay approval is not implemented. `POST /levels` is wired, but this frontend **cannot force `published: true`**. If the API responds with false or omits that flag, the UI says saved/pending.
3. The Godot upload contains several rule-order bugs. The local model reproduces the moment formula, Easy-mode threshold, cyclic train, depot, target counts and current grid-coordinate target matching, but uses stable, sequential turns and rejects food-spoilage race wins. See [Godot rule mapping and limits](docs/GODOT_RULES.md). Local minimums are not a claim of server verification or full animation-race equivalence.
4. Existing Godot online code examples have **six letters**, while the handoff described five. The editor accepts 5–12 alphanumeric characters and always displays the code supplied by the API. Code length is owned by the backend.

## Project layout

| Path | Purpose |
| --- | --- |
| `public/app.js`, `styles.css` | English UI, drag/tap interaction and publication workflow |
| `public/modules/model.js` | Draft validation and strict API payload conversion |
| `public/modules/rules.js` | Local, documented game rules |
| `public/modules/solver.js`, `solver.worker.js` | Local search and independent witness replay |
| `public/modules/api.js` | Anonymous player authentication, load and create |
| `public/layouts.json` | Geometry extracted from the two supplied Godot ship scenes |
| `public/presets.json` | Public official preset snapshot, 23 October 2026 |
| `deploy/` | Nginx, Caddy, update script and timer |
| `tests/` | Rule/contract tests and optional mocked browser integration tests |

No Godot project, private assets, credentials, editor tokens or server SSH keys are published here.
