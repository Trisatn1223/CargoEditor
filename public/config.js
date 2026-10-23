// Public configuration only. Never put an editor/service token here.
// Production uses the existing Caddy proxy at /api, avoiding cross-origin CORS.\n// Local development still contacts the public API directly.\nexport const API_BASE = globalThis.location?.hostname === 'cargo-editor.dreamislandstudio.de'\n  ? '/api' : 'https://cargo-api.dreamislandstudio.de';
export const RULES_VERSION = 'editor-2026-10-23-easy-x-v2';
export const SEARCH_LIMITS = { maxStates: 2000000, maxMs: 180000, maxSolutions: 10 };
