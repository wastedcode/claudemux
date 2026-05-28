# claudemux

> Run and coordinate multiple real-login Claude Code sessions on your box, from Node.
> `await session.wait()` actually returns when the agent is done.

## 1. TL;DR

You have `claude` logged in on your machine and you want to drive it from code — spawn a session (or several), send a task, **know when it's actually done**, read the result, coordinate them. Today that's `child_process.spawn('claude', …)` + ad-hoc ANSI regex + `sleep(5)`, times N sessions, plus glue to keep them from colliding: it hangs on the first-run trust dialog, silently stalls on prompts, and rots on every claude update. claudemux retires that layer once.

```ts
import { create } from "claudemux";

const session = await create({ name: "job", cwd: process.cwd() });
await session.send("Add a CHANGELOG entry for the next release");
await session.wait();
const text = await session.capture();
```

`create()` boots the agent, dismisses the first-run dialogs, and returns when the REPL is genuinely ready — not after a `sleep`. `wait()` blocks until the agent is in an actionable state (idle, awaiting a permission decision, or showing a dialog). The five-line example above is the whole substrate.

**What this is for:** driving the *consumer-login* `claude` CLI (the one you set up with `claude login`) on a box you control — one session, or many coordinating, the way an orchestrator might run several claude sessions that talk to each other. It inherits your box's claude config (auth, permission mode, model, MCP) and passes claude's own flags through; it owns no configuration of its own (one exception: workspace trust, §4).

**What this is *not* for:** deployed or anonymous automation that drives claude via injected credentials or API keys — CI fleets, hosted services. Consumer-login claude can't run there (ephemeral boxes can't interactively log in, and it's against Anthropic's terms); that's what the Claude Agent SDK + API are for. claudemux makes the on-a-box, real-login case reliable.

## 2. Install

```sh
npm install claudemux
```

Requires Node ≥20 and a working `claude` CLI on `PATH` (you've run `claude` interactively at least once so it's authenticated). MIT-licensed.

## 3. CLI usage

The CLI and library map 1:1 — `claudemux send name "..."` is `send(name, "...")` on the library side. Same eight verbs, one vocabulary.

```sh
$ npm i claudemux
$ claudemux spawn my-job --cwd ./fresh-repo --trust-workspace
$ claudemux send my-job "Add a CHANGELOG entry for the next release"
$ claudemux wait my-job
idle
$ claudemux capture my-job
$ claudemux kill my-job
```

The first spawn in a never-trusted folder needs `--trust-workspace` (above) — it fails closed otherwise, and the flag writes a persistent per-folder authority grant; see [Workspace trust (fail-closed)](#workspace-trust-fail-closed) before pointing it at code you don't control.

The full verb set:

| Verb | What it does |
|---|---|
| `spawn <name> --cwd <path>` | Start a session; dismiss boot dialogs; return when ready |
| `send <name> <text>` | Deliver multi-line text as one logical user turn (use `-` to pipe from stdin) |
| `wait <name>` | Block until idle / permission-prompt / dialog; prints the state |
| `state <name>` | Print the current state (no blocking) |
| `capture <name>` | Print the pane text; `--ansi` keeps escape codes |
| `kill <name>` | Kill exactly that session (idempotent) |
| `exists <name>` | `true`/`false` on stdout; exit 0/1 |
| `list [namespace]` | Print short names in the namespace |

Every command accepts `--namespace <name>` (default `claudemux`) so two consumers on one machine don't collide.

All `claudemux` invocations from the same user share one rendezvous socket (the default `claudemux` socket file, owned per-UID by the OS). That's how `spawn` in one process is visible to `send`/`wait`/`capture` in subsequent processes. To opt into an isolated socket (a second independent orchestrator on the same box, or debugging), pass `--socket <name>` or set `CLAUDEMUX_SOCKET=<name>` in the environment.

## 4. Library usage

The library mirrors the CLI. The canonical 30-second example lives in [`examples/spawn-send-wait-capture.ts`](./examples/spawn-send-wait-capture.ts) and is the only canonical sample — README snippets reference it rather than duplicate it.

```ts
import { create, type SessionHandle } from "claudemux";

const session: SessionHandle = await create({
  name: "job",
  cwd: process.cwd(),
});
await session.send("Add a CHANGELOG entry");
const finalState = await session.wait();   // "idle" | "permission-prompt" | "dialog"
const paneText = await session.capture();
await session.kill();
```

Bare-name operations (no handle needed):

```ts
import { exists, kill, list } from "claudemux";

await exists({ name: "job" });        // boolean
await list();                         // string[] of names in the default namespace
await kill({ name: "job" });          // idempotent
```

Typed errors — all extend `ClaudemuxError`:

```ts
import {
  SessionExists,      // create() collision; never silently adopts
  LoginRequired,      // claude isn't authenticated; run `claude` interactively first
  DialogStuck,        // a known dialog matched but didn't advance after the response
  ReplTimeout,        // boot or wait budget elapsed before the state settled
  PaneDead,           // the pane's process died (with the signal)
  SessionGone,        // the session vanished from the backend
  InvalidSessionName, // name was empty, too long, or had illegal characters
  BackendUnreachable, // the backend isn't installed / not running / timed out
  BackendError,       // the backend command failed (message scrubbed of its argv)
  WorkspaceUntrusted, // cwd isn't trusted and trustWorkspace wasn't set (see below)
} from "claudemux";
```

### Workspace trust (fail-closed)

The first time the agent runs in a folder it hasn't seen, it asks to trust it. Trusting a folder is an **authority grant** — the agent gains read/edit/execute on those files — so claudemux does **not** answer that prompt for you. By default `create` (and `claudemux spawn`) throw `WorkspaceUntrusted` *before sending any keystroke*. Opt in explicitly:

```ts
await create({ name: "job", cwd, trustWorkspace: true });   // library
```
```sh
claudemux spawn job --cwd ./repo --trust-workspace          # CLI
```

⚠️ Opting in writes a **persistent, per-folder** trust flag to the agent's config (`~/.claude.json`) — it is *not* session-scoped and applies to every future run in that path, including your own interactive sessions. If you point a session at code you don't fully trust (a repo you just cloned to look at), use an **ephemeral unique path or an ephemeral `HOME` per run** — trust is sticky per `(HOME × path)`, so a reused path a prior run trusted is trusted silently.

## 5. State model

`state()` and `wait()` report one of five values. The classifier scans only the bottom-N lines of the pane, so a stray match in scrollback can't fire by construction.

| State | Meaning |
|---|---|
| `working` | The agent is producing output (streaming, tool calls, spinners). |
| `idle` | The REPL is ready for input — the input box is showing the ready marker and the pane has been stable briefly. |
| `permission-prompt` | The agent is waiting on a permission decision. **Reserved for v0.1 — not emitted in v0.0.1 (see below).** |
| `dialog` | The agent is showing a system dialog (theme picker, trust prompt, etc.). |
| `unknown` | No predicate fired; consumers must not treat as idle. |

`wait()` returns as soon as state ∈ `{idle, permission-prompt, dialog}` — those are the three "actionable" states. `unknown` is a contractual "the substrate doesn't recognize what's on the pane" return value; treating it as idle would race against a turn still in flight. Default `wait()` timeout is 5 minutes; pass `{ timeoutMs }` to override.

**Permission prompts in v0.0.1.** claudemux owns no configuration — you set claude's permission mode (see §1). v0.0.1 therefore does **not** detect mid-turn tool-approval prompts: the `permission-prompt` state exists in the type but is never emitted, and a prompt classifies as `unknown` (never as `idle` — so it is never mistaken for a finished turn). The consequence: a session left in interactive `default` mode that hits a prompt has no one to answer it, so `wait()` runs out its budget and throws `ReplTimeout`. **Run unattended sessions in a non-interactive permission mode** — e.g. spawn claude with `--permission-mode acceptEdits` (or `bypassPermissions`), or set it in `~/.claude`. v0.1 adds prompt detection together with a `respond()` primitive so you can answer prompts programmatically (and starts emitting the reserved `permission-prompt` state — a non-breaking change for consumers already handling the documented return type).

## 6. Architecture

The public API is **backend-neutral by design**. The current implementation drives sessions through `tmux` (covered in §7), but the surface — `create`, `send`, `wait`, `state`, `capture`, `kill`, `exists`, `list` — has no concept of tmux. A future backend (node-pty, `CustomPaneBackend`, anything that satisfies the internal seam) slots in without rewriting `import { create } from "claudemux"`.

Three small seams compose the whole substrate:

- **`Backend`** — drives a named pane: spawn, send keys, paste, capture text, kill. Knows nothing about claude.
- **`AgentDef`** — claude-specific in exactly one place (`src/agents/claude.ts`): the spawn argv, the boot-dialog matchers + responses, the ready detector, the classifier predicates.
- **`Classifier`** — a six-line dispatch mapping pane text → state, taking per-agent rules. The "dialog must be checked before idle" invariant is enforced by the function's structure.

Layering is grep-enforced in CI: `src/backends/**` never imports from `src/agents/**` and vice versa. No tmux concepts appear in `src/index.ts`, public types, or `--help` output.

Read the codebase top-down and the architecture is the file layout. There is no plugin registry, no second-backend stub, no observability framework beyond `onBackendCommand` (one event per backend call — that's the entire observability surface).

## 7. Compatibility

| | Linux | macOS | Windows |
|---|---|---|---|
| tmux 3.2a | ✓ | ✓ | — |
| tmux 3.4 | ✓ | ✓ | — |
| tmux 3.5a | ✓ | ✓ | — |

**Minimum tmux is 3.2** — claudemux sets per-session environment via
`new-session -e`, which tmux added in 3.2. CI runs the full integration suite
on every cell of the matrix. Windows-native support is not on the roadmap; WSL
is community-contributable, undocumented by us.

`claude` is the only supported agent in v0.0.1. The architecture allows additional agents (`codex`, etc.) via `AgentDef`; real demand will pull alternatives in.

## 8. Contributing

Run `npm install && npm test`. Tests touch the real `claude` binary for the pre-auth integration path — you need `claude` on `PATH` and a writable `~/.claude/`. The substrate sandboxes its own probes via a private socket and `mktemp`-rooted HOME so it cannot corrupt your real auth state; a sentinel-mtime guard verifies this on every test run.

Three safety rules are CI-enforced:

- Never match peer processes (`pkill claude` etc.) by name — claudemux runs alongside your own live REPL. PID/PGID only, captured at spawn.
- Every shell invocation of the backend's CLI carries the backend's "no-conf" flag — see the substrate's bootstrap in source if you're adding a new backend.
- The public API does not leak the backend's vocabulary.

Issues and PRs welcome. The architecture's small seams (Backend, AgentDef, Classifier) are designed to be the only places change is needed.

## 9. License

MIT — see [LICENSE](./LICENSE).
