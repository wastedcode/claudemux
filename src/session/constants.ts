/**
 * The default namespace prefix used by `create`, `exists`, `kill`, `list`
 * when the caller doesn't pass one. Two consumers on the same machine
 * pick distinct namespaces to coexist on one shared backend server.
 */
export const DEFAULT_NAMESPACE = "claudemux";
