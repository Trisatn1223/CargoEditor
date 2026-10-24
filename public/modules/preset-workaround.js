import { ENABLE_PRESET_7_UPLOAD_WORKAROUND } from '../config.js';

// TEMPORARY workaround for a confirmed API error:
// "Schiff 7.max_x_variance: Zahl zwischen 0 und 100000 erforderlich."
// Do NOT change the game rules, edit the database, or silently substitute an
// alternative preset. The user must explicitly confirm the fallback upload.
// Presets 7 and 8 shared scene, geometry and physics in the bundled snapshot.
// Live /editor/presets is the authority; recheck before every use.
// Remove via the feature flag: docs/TEMP_PRESET_7_WORKAROUND.md
const ORIGINAL_PRESET = 7;
const SUBSTITUTE_PRESET = 8;

export function compatiblePresetPair(catalog, fromId = ORIGINAL_PRESET, toId = SUBSTITUTE_PRESET) {
  if (!ENABLE_PRESET_7_UPLOAD_WORKAROUND || fromId !== ORIGINAL_PRESET || toId !== SUBSTITUTE_PRESET) return null;
  const original = catalog?.ships?.find(ship => ship.id === fromId);
  const substitute = catalog?.ships?.find(ship => ship.id === toId);
  if (!original || !substitute || original.id === substitute.id) return null;
  // Physics must match exactly; differing initial/target preset defaults are
  // NOT treated as equivalent. Every level upload sends explicit cargo fields.
  if (original.scene_path !== substitute.scene_path ||
      original.max_x_variance !== substitute.max_x_variance ||
      original.max_y_variance !== substitute.max_y_variance ||
      JSON.stringify(original.center_offset) !== JSON.stringify(substitute.center_offset) ||
      JSON.stringify(original.layout) !== JSON.stringify(substitute.layout)) return null;
  return { fromId, toId };
}

export function offeredPresetWorkaround(error, draft, catalog) {
  if (!ENABLE_PRESET_7_UPLOAD_WORKAROUND || error?.status !== 422 ||
      !/Schiff\s+7\.max_x_variance\s*:/i.test(error.message ?? '')) return null;
  const count = draft?.ships?.filter(ship => ship.presetId === ORIGINAL_PRESET).length || 0;
  const pair = compatiblePresetPair(catalog);
  return count && pair ? { ...pair, count } : null;
}

export function remapUploadPayload(payload, option, catalog) {
  const pair = compatiblePresetPair(catalog, option?.fromId, option?.toId);
  if (!pair) throw new Error('The alternative ship preset is no longer compatible. Nothing was uploaded.');
  const substitute = catalog.ships.find(ship => ship.id === pair.toId);
  const source = catalog.ships.find(ship => ship.id === pair.fromId);
  if (!Array.isArray(payload?.ships) || !payload.ships.some(ship => ship.preset_id === pair.fromId))
    throw new Error('No eligible ship in this upload. Nothing was uploaded.');

  const result = structuredClone(payload);
  for (const ship of result.ships) {
    if (ship.preset_id !== pair.fromId) continue;
    // Ensure caller cannot remap an arbitrary mismatched payload. Arrays for
    // initial cargo, goals and positions are carried over unchanged.
    if (ship.scene_path !== source.scene_path ||
        ship.max_x_variance !== source.max_x_variance ||
        ship.max_y_variance !== source.max_y_variance ||
        JSON.stringify(ship.center_offset) !== JSON.stringify(source.center_offset))
      throw new Error('The original ship snapshot changed. Nothing was uploaded.');
    ship.preset_id = substitute.id;
    ship.scene_path = substitute.scene_path;
    ship.max_x_variance = substitute.max_x_variance;
    ship.max_y_variance = substitute.max_y_variance;
    ship.center_offset = [...substitute.center_offset];
  }
  return result;
}
