// formatSessionLabel moved to `src/backends/types.ts` so the backend layer
// can use it without importing from `src/session/`. This file re-exports
// for callers that already use the `src/session/ref` path.
export { formatSessionLabel } from "../backends/types.js";
