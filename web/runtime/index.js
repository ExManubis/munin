// munin's agent runtime, as the frontend sees it. There's no runtime service yet, so this is
// the mock in mock.js; the real client will have the same functions, backed by /runtime/api.

export { mock as runtime } from './mock.js';
