// Public configuration only. Never put a studio/service token here.
// In production, Caddy proxies /api to the existing Cargo API.
// Local development uses the API's public HTTPS origin.
export const API_BASE = globalThis.location?.hostname === 'cargo-editor.dreamislandstudio.de'
  ? '/api' : 'https://cargo-api.dreamislandstudio.de';
export const RULES_VERSION = 'editor-2026-10-23-easy-y-v3';
export const SEARCH_LIMITS = { maxStates: 2000000, maxMs: 180000, maxSolutions: 10 };
