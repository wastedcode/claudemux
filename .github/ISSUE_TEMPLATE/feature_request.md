---
name: Feature request
about: Propose a new capability for the substrate
title: "[feat] "
labels: enhancement
assignees: ""
---

## The problem

What can't you express today? Describe the consumer-side pain, not a
pre-chosen solution.

## Scope check

claudemux reports observable session **state**; the consumer owns **policy**.
Please check your proposal against that boundary (see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`docs/decisions/`](../../docs/decisions)):

- [ ] It's **mechanism** — a verb that does exactly one observable thing, or
      state the substrate can detect from the pane.
- [ ] It is **not** policy — retry/patience timeouts, watchdog logic, or
      injected-credential / API-key automation.
- [ ] It stays **backend-neutral** — no tmux (or other backend) vocabulary in
      the public surface.

If it's policy, it likely belongs in your consumer layer, not here — but open
the issue anyway and we'll talk it through.

## Proposed surface

What would the API look like? A verb signature or type sketch helps.

```ts
// ...
```

## Alternatives considered

What you tried, and why it falls short.
