# 0006. `adopt()` documents a single-writer invariant, adds no cross-process lock, and is a pure attach

**Status:** accepted
**Date:** 2026-05-28

## Context

`adopt(opts)` is the public mirror of `create()` for re-adopting a session that is already live but
was created by another process — the daemon/process-restart recovery path. Exposing it surfaces two
properties that were always present but never *named*:

1. **Multi-attach.** Two `SessionHandle`s — possibly in two processes — can point at the same live
   pane. The substrate serializes only *within* a single handle (a per-handle `Mutex`,
   `src/session/handle.ts`); it does **not** serialize across handles or processes. This is not new:
   the stateless CLI already reattaches to live sessions on every invocation over the stable shared
   socket (`src/cli/context.ts`), so two writers into one pane is an existing capability. `adopt()`
   only gives it a public name.
2. **Foreign session state.** An adopted session may be sitting at a boot/permission/workspace-trust
   dialog the adopting process never created. `create()` deliberately fails closed on the
   workspace-trust dialog (trusting a folder is a persistent, global, per-cwd authority grant — see
   `WorkspaceUntrusted` and the private strategic brain ADR 0010 *claudemux-owns-no-config*).

A cross-process write-lock (e.g. a tmux session-option lease) and an auto-`wait`/auto-dismiss flag
on `adopt()` were both considered. All three decisions below are instances of the substrate's
mechanism-not-policy boundary (the private strategic brain ADR 0013, *mechanism-not-policy substrate
boundary*; and brain ADR 0010, *claudemux-owns-no-config*): claudemux reports state and provides the
attach mechanism; the consumer decides write-serialization and trust policy.

## Decision

1. **Document the single-writer invariant; add no lock.** The substrate states plainly: *claudemux
   serializes within a handle, NOT across handles or processes; single-writer discipline is the
   consumer's responsibility.* No cross-process write-lock is added.
2. **`adopt()` is a pure attach.** It does not spawn, boot, dismiss dialogs, assert REPL-readiness,
   or take an auto-`wait` flag. It returns a handle to the pane as-is.
3. **The post-adopt protocol carries the safety:** *after a successful `adopt()`, the consumer MUST
   call `state()` before driving the pane.* `state()` classifies dialog / wedged / `PaneDead`, which
   is what lets the consumer recover correctly (the A/B/C recovery taxonomy in README §adopt).

## Consequences

- **No distributed-lock trap.** A cross-process lease would import lease-expiry, crash-mid-hold, and
  stale-lock-blocks-recovery failure modes — and would spend a scarce innovation token on a property
  the single-writer daemon already owns for free. The invariant is enforced by the consumer's
  architecture, where it belongs.
- **The real enforcement boundary is the socket, and it is already correct.** tmux sockets are
  per-UID at `/tmp/tmux-$UID/<name>`, mode `0700`. A second writer is necessarily a *same-UID*
  process, so multi-attach crosses no privilege/trust boundary — it is a byte-interleaving
  *integrity* risk among co-equal writers who already hold full authority over the pane, never a
  confidentiality or authorization risk. A lock would protect integrity, never authz; the OS already
  gates everything a lock could. The README states this so a multi-tenant consumer knows the real
  question is "who shares the UID," not "what does claudemux lock."
- **No silent authority grant.** Because `adopt()` dismisses nothing, it can never auto-trust a
  foreign session's workspace or auto-answer a permission prompt — adopting a session mid-trust-dialog
  yields a handle at that state, and `state()` reports it; the consumer decides policy. Auto-dismissal
  would have been a silent policy decision the substrate refuses to make.
- **The guardrail is a doc contract, not a mechanism.** This puts weight on the README landing the
  `state()`-after-adopt protocol as the headline (not a footnote) and on the single-writer sentence.
  A consumer that adopts and skips `state()`, or runs two writers, can still corrupt a pane — the
  substrate reports state faithfully but does not prevent misuse. This is the deliberate tradeoff:
  report state, the consumer decides policy.
- **Known gap on the read path, and a deliberately-deferred fix.** `state()` collapses *every*
  dialog to the single coarse value `"dialog"`, so after `adopt()` a consumer cannot distinguish a
  benign boot dialog from the workspace-trust dialog — and `send()`-ing to clear it answers a
  persistent authority grant with no error. v0.0.x mitigation is the README headline warning (never
  `send()` to a `dialog`-state session you did not boot without inspecting `capture()` first). The
  misuse-resistant fix — **surfacing dialog identity / a `gated` flag on the read path** so a
  consumer can replicate `create()`'s fail-closed posture — is **deferred**: it is a public
  `State`/classifier API change touching `create`/`wait`/`state`, a one-way door that warrants its
  own initiative rather than being rushed into this S build. Recorded here so it reads as *chosen*,
  not missed.
- **Deferred: a runtime agent-def-mismatch guard (v0.0.2+).** `adopt()` cannot detect that the
  passed `agent` differs from the one the session was `create()`d with — the session carries no agent
  def (only, via the paired `expose-agentsessionid`, the `agentSessionId`), and it shouldn't (agent
  defs are consumer-constructible and have no stable identity — ADR 0010). A guard is therefore a
  policy/mechanism the substrate declines for now; the silent-misclassification hazard is covered by
  the README silent-vs-loud warning. Named here so that when a consumer eventually ships a custom
  agent and is bitten, the record shows the guard was *deferred by decision*, with its blockers, not
  overlooked.
- **`attachHandle` is no longer internal-only.** Its docstring (which claimed public consumers always
  go through `create()`) is updated — `adopt()` is the public attach path built on it.

## Evidence

Verified against the code at HEAD: the per-handle `Mutex` is minted per `makeHandle`
(`src/session/handle.ts`), giving no cross-handle/process serialization; the stateless CLI already
reattaches via `attachHandle` every invocation (`src/cli/context.ts`), so multi-attach is an
existing, CI-exercised capability rather than a new race introduced here. The workspace-trust
fail-closed behavior `adopt()` must not undo is implemented in the boot path and `WorkspaceUntrusted`
(`src/errors.ts`). Reviewed with security-infra before build.
