import { randomBytes } from "node:crypto";

/**
 * The substrate's default tmux socket name — `"claudemux"`.
 *
 * Pure function (no env reads here). The bootstrap layer
 * (`src/session/default-backend.ts`) composes the precedence:
 *
 *   explicit `tmuxBackend({ socket })` > `--socket` flag > `CLAUDEMUX_SOCKET` env >
 *   `defaultSocketName()`
 *
 * tmux already namespaces socket files per-UID (`/tmp/tmux-$UID/claudemux`,
 * mode 0700), so a fixed name is per-user-safe by construction. Two
 * consumers from the same user share the same tmux server and coexist via
 * the substrate's namespace prefix (`<ns>--<name>`) — that is the
 * substrate's one justified isolation primitive.
 *
 * See `brain/decisions/0006-default-backend-rendezvous-identity.md`.
 */
export function defaultSocketName(): string {
  return "claudemux";
}

/**
 * Mint a unique tmux socket name. Used by the test harness for per-test
 * isolation (`test/harness/index.ts`). Production code should NOT mint a
 * random socket — the CLI's cross-process discovery requires a stable
 * rendezvous identity (see {@link defaultSocketName}).
 */
export function mintSocket(): string {
  return `claudemux-${randomBytes(6).toString("hex")}`;
}
