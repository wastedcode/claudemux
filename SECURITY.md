# Security Policy

## Supported versions

claudemux is pre-1.0. Security fixes land on the latest published minor; please
upgrade to the most recent release before reporting.

| Version | Supported |
|---------|-----------|
| latest `0.x` | ✅ |
| older `0.x`  | ❌ (upgrade first) |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report privately via one of:

- **GitHub Security Advisories** — [open a private report](https://github.com/wastedcode/claudemux/security/advisories/new)
  (preferred — keeps the disclosure and fix coordinated in one place).
- **Email** — inder@wastedcode.com.

Please include: affected version, a description of the issue, reproduction steps
or a proof-of-concept, and the impact you foresee. We aim to acknowledge within
**72 hours** and to agree a disclosure timeline with you before any public
write-up.

## Threat model — what claudemux does and does not touch

Understanding the boundary helps you judge whether something is a claudemux
vulnerability or expected behavior:

- **claudemux spawns and drives a real, already-authenticated `claude` CLI** on
  a box you control. It inherits that box's claude configuration (auth tokens,
  permission mode, model, MCP) and **owns no credentials of its own.** It never
  reads or writes your claude auth; it has no API keys.
- **It shells out to `tmux`.** Every invocation carries `-f /dev/null` so your
  `~/.tmux.conf` is never read, and the public surface is backend-neutral. The
  `Backend` interface exposes no `sendRawText` primitive — input cannot leak
  around the seam.
- **It never matches a peer process by name.** PID/PGID captured at spawn only,
  so it cannot accidentally kill another `claude` REPL running as the same user
  (see `docs/decisions/0004`).
- **Session names are validated** (`src/session/validate.ts`) to keep
  control/reserved characters out of backend argv.
- **Workspace trust fails closed.** Pointing a session at a never-trusted folder
  raises `WorkspaceUntrusted` unless you explicitly pass `--trust-workspace`,
  which writes a persistent per-folder authority grant — treat that flag as you
  would `sudo` for that directory.

### Out of scope

- The behavior, output, or safety of the underlying `claude` CLI and the agent
  it runs — report those to Anthropic.
- Anything a consumer's own policy layer (a watchdog, an orchestrator) does on
  top of claudemux.
- Running against code or a workspace you don't trust after deliberately passing
  `--trust-workspace` — that flag is the documented authority grant.

Thanks for helping keep claudemux and its users safe.
