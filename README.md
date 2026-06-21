# memestrat

an autonomous memecoin scalping pipeline. an agent discovers solana memecoin candidates,
generates signals, manages risk, and proves the strategy in simulation before anything goes
live. built and driven by a fully autonomous coding agent; a human gates what lands and what
trades.

status: **spec stage.** the docs below define the goal; no code scaffolded yet. stack is the
agent's call (the discovery/data layer drives it toward the solana ecosystem — rust or ts).

## docs

  - [TASK.md](./TASK.md) — the autonomous goal handed to the agent: mandate, discovery,
    watcher service, risk limits, performance targets, the simulation gate.
  - [STRAT.md](./STRAT.md) — the per-symbol signal + position logic: regime gate, entries,
    confirmation, exits, sizing.
  - [WORKFLOW.md](./WORKFLOW.md) — how the agent uses git + github: branch per task, one PR
    per task, CI as the gate, human-gated merge.
  - [AGENTS.md](./AGENTS.md) — the engineering habits the agent builds by.

## the core idea

these are scalps, not holds. maximize profit in **risk units (R)** while bounding downside;
the catastrophic loss (rug / unsellable / -100%) is the enemy. success is risk-based, not
win-rate based — expectancy, profit factor, risk-adjusted return, drawdown, and tail control
are the bar (see TASK.md). most of the edge is in survivorship (discovery filtering) and
exits, not in the signal.

## control model — three planes

the agent runs unattended; a human stays in the loop without babysitting diffs:

  - **telegram = control.** start/stop/steer; get pinged when a PR is ready. not a diff viewer.
  - **github = review.** read the diff, approve, merge from web/mobile.
  - **CI = the gate.** [ci.yml](./.github/workflows/ci.yml) runs the test suite on every PR;
    main is branch-protected so nothing merges without green CI + human approval.

this mirrors the trading rule: no real capital moves without explicit human sign-off.

## ci

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) auto-detects the stack — runs the
rust path if `Cargo.toml` is present, the node path if `package.json` is present — and exposes
a single status check named `ci`. point branch protection at that check; it stays correct
whichever stack the agent picks.

## getting started

```bash
git init
git add -A && git commit -m "spec: task, strat, workflow, ci"
gh repo create memestrat --private --source . --push
# then, in repo settings, protect main:
#   require status check "ci" + at least one approving review
```

after that the agent works the loop in WORKFLOW.md: branch per task -> TDD commits ->
PR with CI green -> telegram ping -> human approve -> squash-merge.
