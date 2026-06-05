# claudemux

> Run and coordinate multiple real-login Claude Code sessions on your box, from Node.
> `await session.wait()` actually returns when the agent is done.

## 1. TL;DR

You have `claude` logged in on your machine and you want to drive it from code — spawn a session (or several), send a task, **know when it's actually done**, read the result, coordinate them. Today that's `child_process.spawn('claude', …)` + ad-hoc ANSI regex + `sleep(5)`, times N sessions, plus glue to keep them from colliding: it hangs on the first-run trust dialog, silently stalls on prompts, and rots on every claude update. claudemux retires that layer once.

```ts
import { create } from "claudemux";

const session = await create({ name: "job", cwd: process.cwd() });
await session.send("Add a CHANGELOG entry for the next release");
await session.wait(); // blocks until the turn ends; pass { maxMs } / { idleMs } to bound it
const text = await session.capture();
```

`create()` boots the agent, dismisses the first-run dialogs, and returns when the REPL is genuinely ready — not after a `sleep`. `wait()` blocks until the turn reaches a terminal **`TurnOutcome`** — `completed` (and the reply is readable), `awaiting` a decision, `aborted`, or out of your patience budget — fused from the agent's hooks + transcript, not screen-scraping. For the whole round-trip in one call there's `ask()` (send → wait → read); to continue a conversation after a crash there's `resume()`. The example above is the whole substrate.

**What this is for:** driving the *consumer-login* `claude` CLI (the one you set up with `claude login`) on a box you control — one session, or many coordinating, the way an orchestrator might run several claude sessions that talk to each other. It inherits your box's claude config (auth, permission mode, model, MCP) and passes claude's own flags through; it owns no configuration of its own (one exception: workspace trust, §4).

**What this is *not* for:** deployed or anonymous automation that drives claude via injected credentials or API keys — CI fleets, hosted services. Consumer-login claude can't run there (ephemeral boxes can't interactively log in, and it's against Anthropic's terms); that's what the Claude Agent SDK + API are for. claudemux makes the on-a-box, real-login case reliable.

## 2. Install

```sh
npm install claudemux
```

Requires Node ≥20 and a working `claude` CLI on `PATH` (you've run `claude` interactively at least once so it's authenticated). MIT-licensed.

## 3. CLI usage

The CLI and library map 1:1 — `claudemux send name "..."` is `send(name, "...")` on the library side. One vocabulary.

```sh
$ npm i claudemux
$ claudemux spawn my-job --cwd ./fresh-repo --trust-workspace
{"agentSessionId":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}   # persist this for resume
$ claudemux ask my-job "Add a CHANGELOG entry for the next release"
{"outcome":{"kind":"completed"},"messages":[…],"cursor":"…"}
$ claudemux kill my-job
```

`ask` is the one-shot round-trip; the primitives (`send` → `wait` → `messages`) are there when you want to drive the turn yourself.

The first spawn in a never-trusted folder needs `--trust-workspace` (above) — it fails closed otherwise, and the flag writes a persistent per-folder authority grant; see [Workspace trust (fail-closed)](#workspace-trust-fail-closed) before pointing it at code you don't control.

The full verb set:

| Verb | What it does |
|---|---|
| `spawn <name> --cwd <path>` | Start a fresh session; dismiss boot dialogs; return when ready. Prints `{agentSessionId}` |
| `resume <name> <agentSessionId> --cwd <path>` | Continue an existing conversation in a fresh pane (after a crash). Prints `{agentSessionId}` |
| `send <name> <text>` | Deliver multi-line text as one logical user turn (use `-` to pipe from stdin). Prints `{cursor}` |
| `ask <name> <text>` | One round-trip: send → wait → read. Prints `{outcome, messages, cursor}`; exit 0 iff completed |
| `wait <name>` | Block until the turn reaches a terminal outcome; prints the `TurnOutcome` JSON (exit 0 iff completed) |
| `messages <name> <cursor>` | Print the messages produced since `<cursor>` (from `send`/`ask`) as JSON |
| `turn-complete <name> <cursor>` | `true`/`false` (exit 0/1): did the turn at `<cursor>` produce a reply? (the re-send signal) |
| `interrupt <name>` | Fire ESC to stop a working agent (harmless when idle — clears the input box) |
| `state <name>` | Print the current fused state (no blocking) |
| `capture <name>` | Print the pane text; `--ansi` keeps escape codes |
| `kill <name>` | Kill exactly that session (idempotent) |
| `exists <name>` | `true`/`false` on stdout; exit 0/1 |
| `list [namespace]` | Print short names in the namespace |

`spawn`/`resume`/`send`/`ask`/`wait`/`state`/`capture`/… take `--agent`; the registry verbs (`kill`/`list`/`exists`) don't.

Every command accepts `--namespace <name>` (default `claudemux`) so two consumers on one machine don't collide.

All `claudemux` invocations from the same user share one rendezvous socket (the default `claudemux` socket file, owned per-UID by the OS). That's how `spawn` in one process is visible to `send`/`wait`/`capture` in subsequent processes. To opt into an isolated socket (a second independent orchestrator on the same box, or debugging), pass `--socket <name>` or set `CLAUDEMUX_SOCKET=<name>` in the environment.

## 4. Library usage

The library mirrors the CLI. The canonical 30-second example lives in [`examples/spawn-send-wait-capture.ts`](./examples/spawn-send-wait-capture.ts) and is the only canonical sample — README snippets reference it rather than duplicate it.

```ts
import { ask, create, type SessionHandle } from "claudemux";

const session: SessionHandle = await create({ name: "job", cwd: process.cwd() });

// One round-trip — the 90% path:
const { outcome, messages } = await ask(session, "Add a CHANGELOG entry");
if (outcome.kind === "completed") console.log(messages.at(-1));
else handleAbnormal(outcome);   // awaiting | aborted | budget-exceeded

await session.kill();
```

`wait()` returns a **`TurnOutcome`** — a discriminated union you branch on, never a thrown timeout:

```ts
const cursor = await session.send("…");
const outcome = await session.wait({ timeoutMs: 60_000 });
switch (outcome.kind) {
  case "completed":        break;                       // reply is readable (flush-skew closed)
  case "awaiting":         outcome.on; /* "permission-prompt" | "dialog" */ break;
  case "aborted":          break;                       // an interrupt() stopped it
  case "budget-exceeded":  outcome.reason; /* "idle" (stuck) | "max" (wall-clock) */ break;
}
```

`completed` guarantees the reply is readable — a following `messagesSince(cursor)` is race-free. **`budget-exceeded` does NOT mean failed** — your patience ran out, but the turn **may still be running**, so do **not** blindly re-send (a re-send into a live turn queues or duplicates *side effects* — the worst failure). Instead poll `progress()`: `toolInFlight === true` or a freshly-advancing `transcriptCount` means *slow-but-alive* (keep waiting); a long flat `transcriptCount` with `state` not `working` means likely wedged (then `interrupt()`, don't re-send). Re-send only a turn you've confirmed never landed — `turnComplete(cursor) === false`.

### Reading a turn's output (`send` → `messagesSince` / `progress`)

`send()` returns a **`Cursor`** anchored at that turn. Read back the messages the
turn produced as structured, backend-neutral `Message`s — no pane-scraping:

```ts
const cursor = await session.send("Summarize the README in one line");
await session.wait();                          // turn settles
const msgs = await session.messagesSince(cursor);
// → [{ role: "user", parts: [{ kind: "text", text }] },
//    { role: "assistant", parts: [{ kind: "text", text }, { kind: "tool", tool, summary }, …] }]
```

For *reliable* "is it working / done?", use `progress()` — fused from the agent's
**hooks + transcript** (deterministic), not the TUI:

```ts
const p = await session.progress();
// { phase: "prompt"|"tool"|"composing"|"done"|"unknown",
//   toolInFlight: boolean,        // a tool is legitimately running (not hung)
//   transcriptCount: number,
//   hookChannelHealthy: boolean,  // false → degraded to best-effort pane fallback
//   agentChannelHealthy: boolean, // false → ALL channels blind vs a non-empty pane (likely a claude-version drift)
//   state }
```

Patience is **yours**: poll `progress()` until `phase === "done"` (or your own
budget elapses) — claudemux reports the signal, never an idle timeout. Hooks are
injected on spawn by default; opt out with `create({ hooks: false })` (observe
then degrades to the pane fallback and says so via `hookChannelHealthy: false`).

Bare-name operations (no handle needed):

```ts
import { exists, kill, list } from "claudemux";

await exists({ name: "job" });        // boolean
await list();                         // string[] of names in the default namespace
await kill({ name: "job" });          // idempotent
```

### Resuming a conversation after a crash (`resume()` + `turnComplete()`)

`resume()` is a first-class lifecycle peer of `create()` (start fresh) and `adopt()`
(re-attach to a *running* pane). It continues an existing conversation in a **fresh
pane** — the recovery path when the box lost the tmux server mid-turn. Pass the
`agentSessionId` you persisted:

```ts
import { create, resume } from "claudemux";

const s = await create({ name: "job", cwd });
const id = s.agentSessionId!;            // persist { name: "job", agentSessionId: id }
const cursor = await s.send("…long task…");
// …the box crashes mid-turn; your daemon restarts…

const s2 = await resume({ name: "job-2", cwd, agentSessionId: id });   // history intact
```

**What to re-send.** A turn that was in flight when the pane died is left in the
transcript as a prompt with **no reply**. `turnComplete(cursor)` tells you — `false`
means re-send that prompt; earlier completed turns return `true` and are left alone:

```ts
if (!(await s2.turnComplete(cursor))) {
  await s2.send("…long task…");          // the in-flight turn was lost — re-send it
}
```

`send()` returns a real cursor when delivery is confirmed. When no user record
appears it returns one of two exported sentinels — both detectable, both reading
empty against `messagesSince`/`turnComplete` (never a whole-transcript slice):

- `DELIVERED_QUEUED` — the session was **busy** and the agent **queued** the
  message (claude shows "Press up to edit queued messages"). It is accepted and
  runs after the in-flight turn — **do not re-send** (that double-runs). `wait()`
  out the current turn, let the queued one run, then read with a fresh cursor.
- `DELIVERY_UNCONFIRMED` — no evidence it landed. Before returning this, `send()`
  already retries a **lost submit** itself: if the paste reached the composer but
  the Enter didn't register, it re-fires Enter once (it never re-pastes, so it
  can't duplicate your text) and re-checks. `DELIVERY_UNCONFIRMED` means even that
  recovery found nothing — safe to re-send.

Distinguishing the two is the point: a queued message is *not* lost, so treating
every unconfirmed send as "re-send" would double-run work issued into a busy
session. (A still-*running* pane after a daemon restart is `adopt()`, not
`resume()` — see below.)

**Resume vs adopt vs fork.** Three recovery/branch shapes, all over the same boot core:
- **`recover({ name, agentSessionId, cwd })`** — the one you usually want on daemon boot. It composes the two below into one call: tries `adopt`; if the pane is gone (a crash), `resume`s it. Returns `{ session, status }` where `status` is `"attached"` (pane survived) or `"resumed"` (it had crashed) — so "did it crash?" is a *field*, not a `try/catch` you write. The re-send decision stays yours: `if (status === "resumed" && !(await session.turnComplete(lastCursor))) await session.send(lastPrompt)`. Reach for the two primitives below directly when you want explicit control.
- **`adopt(name)`** — re-attach to a pane that is **still running** (your daemon restarted but the tmux server lived). Inherits the live session; no re-boot.
- **`resume({ agentSessionId })`** — the pane **died**; continue the *same* conversation in a fresh pane. History intact; the id is preserved.
- **Fork** — branch a *new* conversation off an existing one's history. There's no `fork()` verb; it's an `extraArgs` recipe: `create({ name, cwd, extraArgs: ["--resume", id, "--fork-session"] })`. claude replays `id`'s history into a **new** conversation that diverges from the original (both continue independently). **Caveat (verified):** the fork's id is **unknowable** up front — `agentSessionId` is `undefined`, so claudemux can only locate the fork's transcript once its first hook edge reports the path, which means the **first `send()` may return `DELIVERY_UNCONFIRMED`** (it couldn't anchor before the path resolved) and `messagesSince`/`turnComplete` are unavailable until then. Use fork for fire-and-forget branches, or read the branch via `capture()`; for a fully readable branch, prefer `resume()` (same id) over fork.

### Boot concurrency is yours

claudemux exposes **no** spawn-throttle. `create()` reports each session's readiness independently and honestly (it boots or throws `ReplTimeout` — never a false-ready, never crosstalk between concurrent boots), but spawning a fleet at once is a load decision the substrate doesn't make for you. If you boot many sessions on a busy box, **serialize or semaphore the `create()` calls yourself** (mechanism, not policy — same north star as patience).

### Interrupting a working agent (`interrupt()`)

`interrupt()` fires a single ESC — claude's own interrupt key — at the session, stopping a working turn. ESC is sent **regardless of state**; it's meaningful only when the agent is `working`. ESC on an idle claude is harmless, so the substrate does not guard on state — gate on `state()` yourself if you care. The verb does exactly one thing (stop the turn) and bundles no follow-up.

```ts
if ((await session.state()) === "working") {
  await session.interrupt();   // ESC + brief settle; the turn stops
}
```

Gating on `state()` like this is **not atomic** with the interrupt — there's a window between the read and the ESC landing. It matters most from the CLI, where `state` and `interrupt` are *separate processes*: a short turn can finish in the gap, so the ESC reaches an already-idle agent. That's a harmless no-op (it clears the input box), not an error — but if you need the interrupt to reliably catch a turn, do the `state()` check and `interrupt()` in one **tight in-process sequence**, and don't trust a `working` reading carried over from an earlier separate process.

> ⚠️ **After `interrupt()`, `state()` reads `unknown` and `wait()` resolves `{ kind: "aborted" }`.** claude does not return to a clean prompt: it **restores the interrupted message back into the composer**. The handle records the interrupt authoritatively (an interrupt fires no `stop` hook and leaves the spinner's "esc to interrupt" frozen in scrollback, so neither channel alone can tell aborted from working); the record clears on your next `send()`. One thing still bites:
>
> - **Do not naively `send()` a replacement after `interrupt()`.** `send()` pastes into the *non-empty* composer (the restored message), so what gets submitted is the two texts concatenated.

**Interrupt and replace** (claude-specific; there is deliberately no `interruptAndSend()`). To send a clean replacement you must first clear the restored composer. claude's only substrate-reachable composer clear is repeated ESC (its *"Esc again to clear"* ladder — `interrupt()` again), so clear by **observing the composer empty**, not by blind-counting keystrokes:

```ts
// claude-specific, verified against current claude — observe the composer empty, don't assume a fixed ESC count.
await session.interrupt();                        // ESC #1: stop the turn (composer now holds the old prompt)
for (let i = 0; i < 4 && (await session.capture()).includes(oldPromptSnippet); i++) {
  await session.interrupt();                      // each ESC walks claude's "Esc again to clear" ladder (today ~2 more)
}
await session.send("actually, do X instead");     // clean replacement — composer is empty
await session.wait();                             // settles the new turn (send() armed it)
```

(`oldPromptSnippet` is a distinctive substring of the instruction you interrupted — a cheap "is the restored prompt still in the composer?" check on `capture()`.)

`interrupt()` guarantees ESC was delivered plus a brief settle — **not** that a *slow* in-flight abort (e.g. a long-running tool call) has fully torn down. If you must be certain the turn died before replacing it, poll `state()` until it is no longer `working` first. This confirmation is consumer policy, not a substrate guarantee.

Typed errors — all extend `ClaudemuxError`:

```ts
import {
  SessionExists,         // create() collision; never silently adopts
  LoginRequired,         // claude isn't authenticated; run `claude` interactively first
  DialogStuck,           // a known dialog matched but didn't advance after the response
  ReplTimeout,           // boot budget elapsed before the REPL settled (wait() returns budget-exceeded, never throws)
  SessionGone,           // the session vanished from the backend (a crash, a kill, or the server died) — every per-session op
  TranscriptUnlocatable, // a read on a session whose transcript can't be located (no recoverable id / hook path)
  AgentExitedDuringBoot, // the agent exited before ready — usually an agentSessionId collision
  InvalidSessionName,    // name was empty, too long, or had illegal characters
  InvalidAgentSessionId, // a supplied agentSessionId wasn't a v4 UUID
  AgentSessionIdConflict,// agentSessionId given alongside an extraArgs identity flag
  BackendUnreachable,    // the backend isn't installed / not running / timed out
  BackendError,          // the backend command failed (message scrubbed of its argv)
  WorkspaceUntrusted,    // cwd isn't trusted and trustWorkspace wasn't set (see below)
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

### Session identity (`agentSessionId`)

Every session claudemux creates has a stable **conversation id**, surfaced as
`readonly agentSessionId?: string` on the handle. claudemux mints a v4 UUID,
assigns it to the agent at spawn, and hands it back — so you know the id
**before the agent writes its first byte**, with no scraping and no race:

```ts
const session = await create({ name: "job", cwd });
session.agentSessionId;   // e.g. "f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

It is **opaque and backend-neutral** (today it is claude's `--session-id`; the
field name keeps the API alive across a backend swap). claudemux now **always**
injects the id — a deliberate, stable surface you may depend on. Two jobs it
does:

- **Resume a crashed conversation** via the first-class `resume()` (see *Resuming
  a conversation after a crash*, above) — the neutral lifecycle peer of
  `create()`/`adopt()`. (The vendor `--resume` flag stays
  inside the agent seam; you pass a neutral `agentSessionId`.)
  ```ts
  const resumed = await resume({ name: "job2", cwd, agentSessionId: id });
  ```
- **Read the conversation** with `messagesSince(cursor)` — claudemux locates and
  parses the transcript for you (preferring the path the agent's hook reports), so
  you don't reconstruct claude's storage layout.

**Choosing the id for a fresh conversation.** Pass `agentSessionId` to pick it
yourself (validated as a v4 UUID; **caller-wins** — your own `extraArgs` identity
flag always beats the mint, and supplying both is a fail-fast `AgentSessionIdConflict`):

```ts
await create({ name: "job", cwd, agentSessionId: myUuid });   // fresh conversation under myUuid
```

If the id you choose **already has a conversation**, the agent refuses to
silently resume or clobber it — it exits, and `create()` throws
`AgentExitedDuringBoot` (fast, the id carried on the error), never a silent
resume. (Most other early-exit causes surface the same way; claudemux can't read
which, because panes run with the agent's stderr reaped on exit — the same
property that gives `adopt()` a clean `SessionGone` for a crash.)

**Optional by truth, never fabricated.** `agentSessionId` is `undefined` for a
session created by an older/non-claudemux toolchain, an `adopt()` whose recovery
cache missed, or a spawn that rode a **bare** `--resume`/`--fork-session` (where
the agent picks the id and claudemux genuinely can't know it). It is never a
guess.

**Persist `{ name, agentSessionId }` together** in your own store for restart
recovery. `adopt()` can recover the id from the live session while its backend
session survives, but recreating after a crash (session gone) needs *your*
stored id — see [persist *two* things per session](#persist-two-things-per-session--one-fails-loud-the-other-fails-silent).

> ⚠️ **`extraArgs` flows through the backend's command parser.** A bare `;`
> element is special to tmux (a command separator). claudemux validates that a
> chosen `agentSessionId` is a hex-and-hyphens UUID — so it can never carry such
> a token — and always passes `--session-id` and its value as *two separate argv
> elements* (never `--session-id=<id>`). On a single-user box an arbitrary string
> *you* put in `extraArgs` is a P3 footgun, not a vulnerability; it's noted here
> because this surface is now frozen.

### Re-adopting a live session after a restart (`adopt()`)

`adopt()` is the mirror of `create()`. Where `create()` boots a new session, `adopt()` re-attaches to one that is **already live** but was started by another process — the recovery path for when your daemon (or any long-lived orchestrator) restarts while its agents keep running. It's a **pure attach**: no spawn, no boot, no dialog dismissal. If the session isn't there, it throws `SessionGone`.

```ts
import { adopt, SessionGone } from "claudemux";

const session = await adopt({ name: "job" });   // throws SessionGone if it's not there
const where = await session.state();             // ← ALWAYS do this before you drive the pane
```

**Always call `state()` immediately after a successful `adopt()`, before you `send()` anything.** `adopt()` hands you the pane *as-is* — it may be idle, mid-dialog, wedged, or a dead husk. `state()` is how you learn which, and it's the only thing standing between you and driving a pane that isn't ready. Three things can be wrong with a "live" session you just adopted:

| Symptom after `adopt()` | State | What happened | Recovery |
|---|---|---|---|
| `adopt()` throws `SessionGone` | **A** | the process exited — a crashed `claude` tears down the whole session (the substrate runs `remain-on-exit off`, so a dead pane is reaped, never left as a husk), so absence is clean | `resume({ name, cwd, agentSessionId })` |
| handle returned, but `state()`/`wait()` never settles, or `state()` throws `SessionGone` mid-check | **B** | the pane is attached but **wedged**, or vanished between adopt and the read | `kill()` **then** `resume(…)` |

The full recovery loop — adopt, then fall back to `resume()` — is in [`examples/adopt-after-restart.ts`](./examples/adopt-after-restart.ts). (Or just call `recover()`, which does this whole dance and tells you `attached` vs `resumed`.) `adopt()` re-establishes and re-verifies **nothing**: it inherits whatever authority context the original `create()` set up (trusted folders, permission mode, MCP) — it does not re-grant or re-check any of it.

#### Persist *two* things per session — one fails loud, the other fails silent

To recover a session you must persist **both** the `agentSessionId` (for `resume()`) **and** which agent def it was created with — and their failure modes are opposite:

- **Forget the `agentSessionId` → you find out at once.** Without it `resume()` has nothing to continue and you start a fresh conversation (or error). Loud.
- **Forget or mismatch the agent def → it lies silently.** `state()`/`wait()` classify the live pane against **the agent you pass to `adopt()`**, not the one the session was created with. Pass the wrong agent and the classifier reports the wrong state with no error. This is a *dormant-then-armed* footgun: harmless while `claude` is the only agent you ship, armed the day you ship a custom one.

#### Single-writer is *your* job — claudemux holds no lock

Exactly one writer per pane at any instant. claudemux serializes calls **within a single handle** (a per-handle mutex), but **not across handles or processes, and it does not detect a violation**. Two handles writing the same pane interleave keystrokes and tear a turn — **silent corruption, not a thrown error**. The only thing between two writers is socket file permissions: tmux sockets are per-UID (`/tmp/tmux-$UID/…`, mode `0700`), so a second writer is necessarily a *same-UID* process — multi-attach is an integrity risk among co-equal writers, never a privilege-crossing one. Keeping it to one writer is your architecture's responsibility, not a lock claudemux takes. (Relatedly, the upfront existence check inside `adopt()` is a **courtesy fast-fail, not a guarantee** — TOCTOU means the first op on the handle can still throw `SessionGone`/`BackendUnreachable` if the session dies in between.)

#### ⚠️ Never blindly clear a dialog on a session you didn't boot

`state()` reports **every** dialog as the single generic value `"dialog"` — it cannot tell a benign boot dialog from the workspace-trust dialog. An adopted session may be sitting at a workspace-trust prompt some other process left it at, and `send()`-ing a key to clear it **answers a persistent, global, per-cwd authority grant** (the same grant `create()` deliberately fails closed on — see [Workspace trust](#workspace-trust-fail-closed)) with no error and no second chance. **Never `send()` to a `dialog`-state session you did not boot yourself without first inspecting `capture()`** to confirm it is not the trust dialog.

#### Recovering many sessions at once — watch for the storm

Because a cleanly-down backend server reports `false` for *every* session, all your `adopt()` calls return `SessionGone` at the same instant — and `resume()`-ing N sessions fired against a host whose backend just restarted is a recovery storm. **If you're recovering more than one session and they *all* report `SessionGone`, probe `list()`/`exists()` once for the batch before re-creating.** A uniformly-empty result is a server-restart event, not N independent session deaths.

## 5. State model

**`state()`** is a point-in-time snapshot — the one fused belief (hooks + transcript + pane), not a raw screen scrape. It reports one of five values:

| State | Meaning |
|---|---|
| `working` | The agent is producing output (streaming, tool calls, spinners). |
| `idle` | The REPL is ready for input — the ready box is showing and the pane has been stable briefly. |
| `permission-prompt` | The agent is paused on a tool-approval prompt — answer it with `respond()` (see below). |
| `dialog` | The agent is showing a system dialog (theme picker, trust prompt, etc.). |
| `unknown` | No predicate fired; consumers must not treat as idle. |

**`wait()`** returns a **`TurnOutcome`** — "the turn stopped, and why" — never a thrown timeout:

| `outcome.kind` | Meaning |
|---|---|
| `completed` | The turn finished **and its reply is readable** (the ~100ms hook→transcript flush skew is closed). |
| `awaiting` | Paused on a modal only the pane sees — `outcome.on ∈ {permission-prompt, dialog}`. |
| `aborted` | An `interrupt()` stopped it. |
| `budget-exceeded` | One of **your** patience bounds ran out — `outcome.reason: "idle"` (no progress for `idleMs`) vs `"max"` (wall-clock `maxMs`). **Not "failed"** — poll again, don't blindly re-send. |

`wait()` is the compound owner of the done-decision: it composes the Observer's belief with **your** patience. The library owns **none** — there is no default timeout. Pass `wait({ maxMs })` (wall-clock cap), `wait({ idleMs })` (give up after no progress for that long — a *working* turn or a tool in flight never trips it, only a genuinely stuck one), or both; with neither, `wait()` blocks until a terminal outcome and never invents a deadline. "Time is the policy's." (`progress()` is the same belief without the wait — `{ phase, toolInFlight, transcriptCount, hookChannelHealthy, agentChannelHealthy, state }`; poll it and apply your own patience if you'd rather not block. `agentChannelHealthy: false` is the **drift canary** — every observe channel came up blind against a non-empty pane, the signature of a Claude Code version moving the format out from under the parsers; treat persistent `false` as "re-check your version assumptions.")

**Permission prompts.** claudemux owns no configuration — you set claude's permission mode (see §1). A session left in interactive `default` mode that hits a mid-turn tool-approval prompt (`Do you want to create hello.txt?` → `1. Yes / 2. Yes, allow all… / 3. No`) surfaces it as a first-class state: `state()` reads `permission-prompt`, and `wait()` returns `{ kind: "awaiting", on: "permission-prompt" }` instead of timing out. Answer it with **`respond(choice)`** — `"approve"` (this once), `"approve-for-session"` (allow the rest of the session), or `"deny"`. The natural loop is the analog of `send → wait`:

```ts
let outcome = await session.wait();
while (outcome.kind === "awaiting" && outcome.on === "permission-prompt") {
  await session.respond("approve"); // your policy decision — claudemux never auto-answers
  outcome = await session.wait();   // wait for the turn to actually finish (or the next prompt)
}
```

`respond()` is a mechanism, not policy: choosing *whether* to approve is yours (claudemux never auto-approves an authority grant). It fires the keystroke unconditionally — gate it on a `permission-prompt` reading taken in the same quick sequence (the prompt is stable; it won't resolve underfoot). If you'd rather not field prompts at all, **run unattended sessions in a non-interactive permission mode** — spawn claude with `--permission-mode acceptEdits` (or `bypassPermissions`), or set it in `~/.claude`. (Detection requires the hook + pane observe channels; a denied tool fires no completing hook edge, so the settled idle pane is what tells `wait()` the turn ended — see §6.)

## 6. Architecture

The public API is **backend-neutral by design**. The current implementation drives sessions through `tmux` (covered in §7), but the surface — the lifecycle (`create`/`resume`/`adopt`/`exists`/`kill`/`list`), the per-session verbs (`send`/`wait`/`messagesSince`/`turnComplete`/`state`/`progress`/`interrupt`/`respond`/`capture`), and the `ask` composer — has no concept of tmux. A future backend (node-pty, anything that satisfies the internal seam) slots in without rewriting `import { create } from "claudemux"`.

**Read/write split.** The substrate *drives* via the write surface (tmux send-keys/paste) but *observes* via reliable channels: the agent's lifecycle **hooks** (injected at spawn → a per-session rendezvous file) + the on-disk **transcript**, with the pane as a marked fallback. Four small seams compose it:

- **`Backend`** — drives a named pane: spawn, send keys, paste, capture text, kill. Knows nothing about claude.
- **`AgentDef`** — claude-specific in exactly one place (`src/agents/claude.ts`): the spawn argv + flags, boot-dialog matchers, the ANSI-aware ready detector, the classifier predicates, and the transcript/hook **grammar** (parse a transcript record / a hook marker into neutral types). Adding `codex` = adding one file.
- **`Observer`** — the single owner of "what's true": fuses hook edges + transcript + a pre-classified pane into one belief. `state()`/`progress()` read it; `wait()` composes it with a patience budget into a `TurnOutcome`. No caller forms its own belief.
- **`Classifier`** — pane text → state via per-agent rules; "dialog before idle" is enforced structurally.

Layering is grep-enforced in CI: `src/backends/**` never imports from `src/agents/**` and vice versa, and no claude/transcript vocabulary leaks out of `src/agents/`. No tmux concepts appear in `src/index.ts`, public types, or `--help` output. The full consumer-journey contract (every happy/unhappy/recovery flow, with the standardized behavior) lives in [`docs/design/user-flows.md`](./docs/design/user-flows.md).

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

`claude` is the only supported agent today. The architecture allows additional agents (`codex`, etc.) via `AgentDef`; real demand will pull alternatives in.

## 8. Contributing

Run `npm install && npm test`. Tests touch the real `claude` binary for the pre-auth integration path — you need `claude` on `PATH` and a writable `~/.claude/`. The substrate sandboxes its own probes via a private socket and `mktemp`-rooted HOME so it cannot corrupt your real auth state; a sentinel-mtime guard verifies this on every test run.

Three safety rules are CI-enforced:

- Never match peer processes (`pkill claude` etc.) by name — claudemux runs alongside your own live REPL. PID/PGID only, captured at spawn.
- Every shell invocation of the backend's CLI carries the backend's "no-conf" flag — see the substrate's bootstrap in source if you're adding a new backend.
- The public API does not leak the backend's vocabulary.

Issues and PRs welcome. The architecture's small seams (Backend, AgentDef, Classifier) are designed to be the only places change is needed.

## 9. License

MIT — see [LICENSE](./LICENSE).
