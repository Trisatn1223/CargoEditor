import { solve } from './modules/solver.js';
self.onmessage = ({ data }) => {
  try {
    const result = solve(data.draft, data.catalog, { ...data.limits, onProgress: progress => self.postMessage({ type: 'progress', progress }) });
    self.postMessage({ type: 'result', result });
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
