import { API_BASE } from '../config.js';
const TOKEN_KEY = 'cargo-chief-player-token-v1';
export function normalizeCode(value) {
  const code = String(value).trim().toUpperCase();
  // Existing Godot online examples have six letters; never manufacture codes.
  if (!/^[A-Z0-9]{5,12}$/.test(code)) throw new Error('Enter a valid level code (5–12 letters or digits).');
  return code;
}
// Render validation hints, not Pydantic's echoed "input" values (they may
// contain user-provided data). Never log or expose authorization tokens.
export function validationMessage(responseData) {
  const detail = responseData?.detail;
  const safe = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180);
  if (Array.isArray(detail)) {
    const items = detail.slice(0, 4).map(issue => {
      if (!issue || typeof issue !== 'object') return '';
      const path = Array.isArray(issue.loc) ? issue.loc.map(part => safe(part)).join('.') : '';
      const message = typeof issue.msg === 'string' ? safe(issue.msg) : 'Invalid value';
      return `${path ? path + ': ' : ''}${message}`;
    }).filter(Boolean);
    if (items.length) return items.join(' | ');
  }
  if (typeof detail === 'string') return safe(detail);
  if (typeof responseData?.message === 'string') return safe(responseData.message);
  return 'The API did not provide validation details.';
}
export class ApiError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
export class CargoAPI {
  constructor({ base = API_BASE, fetcher = fetch, storage } = {}) { this.base = base; this.fetcher = (...args) => fetcher(...args); try { this.storage = storage ?? globalThis.localStorage; } catch { this.storage = null; } this.token = null; }
  async request(path, { method = 'GET', body, token, signal } = {}) {
    let response;
    try { response = await this.fetcher(this.base + path, { method, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: signal || AbortSignal.timeout(20000), headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch (error) { throw new ApiError(error.name === 'TimeoutError' ? 'The API took too long to respond. Your draft is safe.' : 'Cannot reach the level API. Check the /api reverse proxy on your server (or CORS when running locally). Your draft is safe.'); }
    // Read the status before insisting on JSON. Reverse proxies often return
    // HTML for 404/502, and otherwise the useful HTTP error gets obscured.
    const contentType = response.headers?.get('content-type') || '';
    let raw;
    try { raw = await response.text(); }
    catch { throw new ApiError(`Could not read the API response (HTTP ${response.status}, ${path}).`, response.status); }
    let data;
    try { data = raw.trim() ? JSON.parse(raw) : null; }
    catch { data = null; }
    if (!response.ok) {
      const messages = {
        401: 'Your player session is no longer valid. Use “Renew player session” in Connection.',
        403: 'The API does not permit this action.',
        404: path.startsWith('/levels/') || path.startsWith('/me/levels/')
          ? 'This level code was not found or is not accessible yet. Unpublished levels can only be loaded with their original player identity.'
          : `API endpoint not found (HTTP 404 at ${path}). Check the /api Caddy proxy.`,
        409: 'The API reported a conflict. Your draft has been kept.',
        422: `The API rejected this level (HTTP 422): ${validationMessage(data)}. Your draft has been kept.`,
        429: 'Too many requests. Please wait and try again.',
        502: 'Gateway error (HTTP 502). Caddy cannot reach the API container; check the Docker network and /api proxy.',
        503: 'The API is temporarily unavailable (HTTP 503).',
        504: 'The API gateway timed out (HTTP 504).',
      };
      throw new ApiError(messages[response.status] || `API request failed (HTTP ${response.status} at ${path}).`, response.status);
    }
    if (data === null || typeof data !== 'object' || !raw.trim()) {
      const responseType = /html/i.test(contentType) || /^\s*</.test(raw) ? 'HTML' : 'non-JSON';
      throw new ApiError(`Expected JSON but got ${responseType} (HTTP ${response.status} at ${path}). Check the /api reverse proxy and whether the requested route exists.`, response.status);
    }
    return data;
  }
  presets() { return this.request('/editor/presets'); }
  storedToken() { try { return this.token || this.storage?.getItem(TOKEN_KEY); } catch { return this.token; } }
  async identity() {
    const existing = this.storedToken(); if (existing) return existing;
    const result = await this.request('/auth/anonymous', { method: 'POST', body: {} });
    if (typeof result.token !== 'string' || !result.token) throw new Error('The API did not return a player token.');
    this.token = result.token; try { this.storage?.setItem(TOKEN_KEY, result.token); } catch { /* Session remains usable in memory. */ }
    return result.token;
  }
  renewIdentity() { this.token = null; try { this.storage?.removeItem(TOKEN_KEY); } catch {} }
  async load(value) {
    const code = normalizeCode(value);
    try { return await this.request('/levels/' + code); }
    catch (error) { if (error.status !== 404 || !this.storedToken()) throw error; return this.request('/me/levels/' + code, { token: this.storedToken() }); }
  }
  async create(payload) {
    const token = await this.identity();
    const result = await this.request('/levels', { method: 'POST', body: { user_difficulty: 'easy', payload }, token });
    if (typeof result.code !== 'string' || !/^[A-Z0-9]{5,12}$/i.test(result.code)) throw new ApiError('The API accepted the request but returned no valid code. Do not publish again; check your saved levels first.');
    return { code: normalizeCode(result.code), version: result.version ?? null, published: result.published === true };
  }
}
