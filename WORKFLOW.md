# workflow

how the autonomous agent uses git + github. the point is not code-review ceremony — it is a
**gate** (nothing lands on main unsupervised) and a **review surface** (diffs live on github,
not in the telegram control channel).

## three planes — keep them separate

  - **telegram = control.** start/stop/steer the agent; receive notifications ("PR #N ready,
    M files, CI green, <link>"). it is a notifier, not a diff viewer. never review code here.
  - **github = review.** the web/mobile UI is the diff surface. approve + merge from here.
  - **CI = the gate.** github actions runs the test suite on every PR. main is branch-
    protected: merge requires green CI + human approval. the agent can author and push, but
    physically cannot merge junk to main.

this mirrors the live-trading rule in TASK.md: no merge to main without human sign-off, the
same way no real capital moves without it.

## branch per task

  - one branch per TASK-level unit of work. never commit to main directly.
  - naming: `agent/<short-slug>` (e.g. `agent/discovery-filter`, `agent/fill-model`).
  - the branch is a quarantine boundary: a bad autonomous run is isolated. if it's garbage,
    close the PR — main never saw it.

## commits inside the branch

  - follow TDD: isolate a feature, write the test, make it pass, commit. one feature per
    commit, tests green before every commit.
  - commit messages: imperative, terse, say what + why. small commits are fine — they get
    squashed at merge.

## one PR per task

  - open the PR only when the full task is done and the local test suite is green (do not
    open half-finished PRs that sit red in CI).
  - the agent authors the PR body: what changed, why, and which performance/risk targets it
    touches. this description is the human's primary review aid — make it worth reading.
  - `gh pr create --fill` then edit the body, or pass `--title`/`--body` directly.
  - do NOT open a PR per commit. PR granularity = task; commit granularity = feature.

## merge

  - squash-merge each PR so main reads as one clean commit per reviewed task — clean bisect.
  - delete the branch after merge.
  - merge is human-gated. the agent's job ends at "PR open + CI green + telegram pinged."

## guardrails

  - main is protected: required status checks (tests) + at least one approving review.
  - the agent never force-pushes to main and never merges its own PR.
  - if CI is red, the agent fixes it on the branch and pushes again — it does not ask for a
    merge until green.
  - notify on every state change worth a human's attention: PR opened, CI passed, CI failed.

## the loop, end to end

```
pick task -> branch agent/<slug> -> (TDD: test, code, commit)* -> tests green locally
  -> push -> gh pr create (agent writes the why) -> CI runs
  -> telegram: "PR #N ready, CI <state>, <link>"
  -> human reviews on github -> approve -> squash-merge -> delete branch
```
