# Temporary HTTP 422 ship 7 workaround — rollback instructions

**Status:** Experimental / opt-in. **No new Git branch was created.**
The feature is in the existing `main` branch, guarded by a single switch:

```js
// public/config.js
export const ENABLE_PRESET_7_UPLOAD_WORKAROUND = true;
```

This is **not** a fix for the real FastAPI validation bug, and cannot force
an invalid level through the API. Only the server can issue a genuine code.

## Why this exists

On 24 October 2026 the public editor sent
`{"preset_id":7,"max_x_variance":3,...}` but `POST /levels`
returned HTTP 422:

```
Schiff 7.max_x_variance: Zahl zwischen 0 und 100000 erforderlich.
```

The browser already sends the correctly typed value. The API appears to
reject the ship preset/snapshot on the server side. The API source and
server-side validation were not available to verify the root cause.

The bundled approved catalog contains **ship preset 8** with the same
`scene_path`, `layout`, `max_x_variance`, `max_y_variance`, and
`center_offset` as **preset 7**. Their **default cargo definitions differ**.
This workaround therefore does *not* treat them as globally identical presets.

## Scope and safety

- Implemented in `public/modules/preset-workaround.js`, with UI in
  `public/app.js`. Public client-side flag in `public/config.js`.
- Applies **only** to an HTTP 422 explicitly naming
  `Schiff 7.max_x_variance`, and only when the current local draft includes
  preset 7.
- The **current live** `GET /editor/presets` response must contain both 7 and
  8 with exactly matching scene, slot geometry, X/Y variance values and offset.
  Any mismatch disables the option.
- The user sees a separate **Review alternative preset 8** action and
  an explicit consent dialog. **No automatic retry, no silent remapping.**
- Builds a *copy* of the original validated payload and replaces only the
  matching ship snapshot's **preset ID** (plus identical values from the
  approved alternative). The configured initial/target cargo, allowed zones,
  depot, train and star thresholds are copied unchanged.
- The browser's local draft stays at preset 7 if the user cancels or the API
  rejects the alternative. Once the API returns a valid code, the browser's
  saved draft is updated to preset 8 to match the version actually uploaded;
  the saved-code dialog shows a visible warning.
- This workaround does not include a secret service/admin token and does not
  bypass server authentication, validation, or level approval.
- The game and API may interpret preset-specific defaults differently despite
  matching geometry. **Verify any saved alternative level in the mobile game
  and compare its full stored snapshot.**
- An HTTP timeout/5xx on retry may have created a level even if the browser
  received no code; **check the saved-level list before posting again**.

## Usage

1. Load the latest GitHub `main` version and refresh the browser.
2. Check your level locally and click **Publish level**.
3. Only if the API returns the known HTTP 422 on preset 7, use
   **Review alternative preset 8**.
4. Review the warning and explicitly click **Upload using preset 8**.
5. The API may still reject it. If a new code is issued, reload that code
   with the owner/player identity and test its initial/target cargo and ship
   balance in the actual game. The returned `published` flag still controls
   public visibility.

## Disable without any new branch (recommended rollback)

After fixing the actual API bug:

1. Open **`public/config.js` in `main`** on GitHub.
2. Change this one line:

   ```js
   export const ENABLE_PRESET_7_UPLOAD_WORKAROUND = false;
   ```

3. Commit directly to `main` (e.g. `Disable temporary preset 7 workaround`).
4. The normal systemd update timer deploys that commit. Or trigger it now:

   ```bash
   systemctl start cargo-editor-update.service
   curl -fsS https://cargo-editor.dreamislandstudio.de/version.json
   ```

5. Reload the browser using Ctrl+F5. Existing API levels created with
   preset 8 **remain preset 8**; disabling the feature never rewrites them.

**No feature branch, database migration, Docker or Caddy config changes are
required.** To fully remove dead code later, delete
`public/modules/preset-workaround.js`, its import and opt-in UI code in
`public/app.js`, the flag and the tests in a separate cleanup commit to
`main`. Do that only after the backend fix and regression testing.

Do not edit tracked files directly in `/opt/cargo-editor` on the VPS; the
systemd updater refuses locally modified checkouts. Commit through GitHub.

## How to test / audit

```bash
npm test
curl -fsS https://cargo-editor.dreamislandstudio.de/version.json
```

GitHub Actions also runs a mocked Chromium end-to-end test for the 422,
explicit review, cancellation (no retry), and successful substitute upload.
The live FastAPI endpoint is **not exercised by these tests**, so the workaround
is not guaranteed to succeed against production.

For the server-side root-cause fix, inspect how ship preset 7 is loaded by
the backend before `max_x_variance` is validated. Do not suppress that
validation or inject dummy values merely to obtain a code.
