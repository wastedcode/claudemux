---
name: Bug report
about: Report a defect in claudemux's observable behavior
title: "[bug] "
labels: bug
assignees: ""
---

## What happened

A clear, concise description of the behavior you observed.

## What you expected

What you expected the substrate to do instead.

## Minimal repro

The smallest snippet that reproduces it. The library is a substrate — please
show the verb sequence (`create` / `send` / `wait` / `state` / …), not your
surrounding policy code.

```ts
// ...
```

## Observability

If you can, attach the `onBackendCommand` output for the failing call (argv,
duration, exit code, streams). This is usually enough to localize a bug.

```
// onBackendCommand events
```

## Environment

- claudemux version:
- Node version (`node -v`):
- OS / arch:
- tmux version (`tmux -V`):
- claude CLI version (`claude --version`):

## Notes

Anything else — does it reproduce every time, only after a restart, only under
load, etc.
