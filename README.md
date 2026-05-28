# claudemux

> Drive long-lived Claude Code sessions from Node.
> `await session.wait()` actually returns when the agent is done.

## 1. TL;DR

You have `child_process.spawn('claude', [...])` + ad-hoc ANSI regex + `sleep(5)` somewhere. It works on your laptop, breaks in CI, hangs on the first-run dialog, and silently stalls on permission prompts. claudemux retires that layer once.

```ts
import { create } from "claudemux";

const session = await create({ name: "job", cwd: process.cwd() });
await session.send("Add a CHANGELOG entry for the next release");
await session.wait();
const text = await session.capture();
```

`create()` boots the agent, dismisses the first-run dialogs, and returns when the REPL is genuinely ready — not after a `sleep`. `wait()` blocks until the agent is in an actionable state (idle, awaiting a permission decision, or showing a dialog). The five-line example above is the whole substrate.

## 2. Install

```sh
npm install claudemux
```

Requires Node ≥20 and a working `claude` CLI on `PATH` (you've run `claude` interactively at least once so it's authenticated). MIT-licensed.

## 3. CLI usage

The CLI and library map 1:1 — `claudemux send name "..."` is `send(name, "...")` on the library side. Same eight verbs, one vocabulary.

```sh
$ npm i claudemux
$ claudemux spawn my-job --cwd ./fresh-repo
$ claudemux send my-job "Add a CHANGELOG entry for the next release"
$ claudemux wait my-job
idle
$ claudemux capture my-job
$ claudemux kill my-job
```

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
  SessionExists,    // create() collision; never silently adopts
  LoginRequired,    // claude isn't authenticated; run `claude` interactively first
  DialogStuck,      // a known dialog matched but didn't advance after the response
  ReplTimeout,      // boot or wait budget elapsed before the state settled
  PaneDead,         // the pane's process died (with the signal)
  SessionGone,      // the session vanished from the backend
  BackendUnreachable,
  BackendError,
} from "claudemux";
```

## 5. State model

`state()` and `wait()` report one of five values. The classifier scans only the bottom-N lines of the pane, so a stray match in scrollback can't fire by construction.

| State | Meaning |
|---|---|
| `working` | The agent is producing output (streaming, tool calls, spinners). |
| `idle` | The REPL is ready for input — the input box is showing the ready marker and the pane has been stable briefly. |
| `permission-prompt` | The agent is waiting on a permission decision. |
| `dialog` | The agent is showing a system dialog (theme picker, trust prompt, etc.). |
| `unknown` | No predicate fired; consumers must not treat as idle. |

`wait()` returns as soon as state ∈ `{idle, permission-prompt, dialog}` — those are the three "actionable" states. `unknown` is a contractual "the substrate doesn't recognize what's on the pane" return value; treating it as idle would race against a turn still in flight. Default `wait()` timeout is 5 minutes; pass `{ timeoutMs }` to override.

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
| tmux 3.0a | ✓ | ✓ | — |
| tmux 3.2a | ✓ | ✓ | — |
| tmux 3.4 | ✓ | ✓ | — |
| tmux 3.5a | ✓ | ✓ | — |

CI runs the full integration suite on every cell of the matrix. Windows-native support is not on the roadmap; WSL is community-contributable, undocumented by us.

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
