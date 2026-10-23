import { API_BASE } from '../config.js';
const TOKEN_KEY = 'cargo-chief-player-token-v1';
export function normalizeCode(value) {
  const code = String(value).trim().toUpperCase();
  // Existing Godot online examples have six letters; never manufacture codes.
  if (!/^[A-Z0-9]{5,12}$/.test(code)) throw new Error('Enter a valid level code (5–12 letters or digits).');
  return code;
}
export class ApiError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
export class CargoAPI {
  constructor({ base = API_BASE, fetcher = fetch, storage } = {}) { this.base = base; this.fetcher = (...args) => fetcher(...args); try { this.storage = storage ?? globalThis.localStorage; } catch { this.storage = null; } this.token = null; }
  async request(path, { method = 'GET', body, token, signal } = {}) {
    let response;
    try { response = await this.fetcher(this.base + path, { method, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: signal || AbortSignal.timeout(20000), headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch (error) { throw new ApiError(error.name === 'TimeoutError' ? 'The API took too long to respond. Your draft is safe.' : 'Cannot reach the API. Check your connection or the server’s CORS setting. Your draft is safe.'); }
    let data; try { data = await response.json(); } catch { throw new ApiError('The API returned an unreadable response.', response.status); }
    if (!response.ok) {
      const messages = { 401: 'Your player session is no longer valid. Use “Renew player session” in Connection.', 403: 'The API does not permit this action.', 404: 'This level is not public or does not exist.', 409: 'The API reported a conflict. Your draft has been kept.', 422: 'The API rejected the level data. The server contract may need updating.', 429: 'Too many requests. Please wait and try again.' };
      throw new ApiError(messages[response.status] || `API request failed (${response.status}).`, response.status);
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
