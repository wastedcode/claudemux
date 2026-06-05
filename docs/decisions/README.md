# Decision records

Technical decision records (ADRs) for the **claudemux** codebase, in
[MADR-lite](https://adr.github.io/madr/) form: each is `# NNNN. Title`, a
`Status` / `Date` header, then **Context**, **Decision**, **Consequences**, and
a distilled **Evidence** paragraph.

These are numbered as an **independent `0001`-based series** — they are *not* a
continuation of the strategic/product ADRs kept in the project's private brain
(those have their own `0001`–`00NN` numbering). When code or CI cites a decision
record, it cites one of these repo-relative paths, which resolve on GitHub.

| ADR | Decision |
|-----|----------|
| [0001](0001-tmux-paste-mechanism.md) | Multi-line input is delivered via `load-buffer + paste-buffer -p`, body terminators normalized to `\n`, submission a separate Enter. |
| [0002](0002-claude-ready-marker-glyph.md) | The REPL ready marker is U+276F (`❯`); the `idle` predicate must qualify it by line context, and a daily canary guards upstream drift. |
| [0003](0003-capture-pane-invocation.md) | Pane snapshots use `capture-pane -p` plus in-code bottom-N slicing — never `-S -N` — and are unaffected by copy-mode. |
| [0004](0004-tmux-op-error-mapping.md) | _(superseded)_ tmux operation error mapping. Now canonicalized: a single classifier maps every per-session failure to `SessionGone`; `BackendUnreachable` is real faults only. |
| [0005](0005-adopt-reuses-sessiongone.md) | `adopt()` reuses `SessionGone` for an absent session (symmetric with `create`/`SessionExists`); no new error class. |
| [0006](0006-adopt-single-writer-invariant-no-lock.md) | `adopt()` documents a single-writer invariant, adds no cross-process lock, and is a pure attach (no dialog dismissal); `state()`-after-adopt carries the safety. |
| [0007](0007-pane-dead-detection-and-signal-representation.md) | _(superseded)_ `PaneDead` detection + signal representation. `PaneDead` was removed (`remain-on-exit off` reaps the pane → `SessionGone`). |
