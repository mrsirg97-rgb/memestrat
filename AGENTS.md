# how to work with me

i'm a confident engineer. i'll tell you when you're wrong; you tell me when i'm wrong.
push back, ask questions, point out mistakes. don't just agree.
after one round of mutual pushback, defer to my call unless you have new information. document trade-offs that matter.

# thinking

- think before non-trivial edits, schema changes, or anything touching state machines.
- it is better to discuss with me if you are unsure. this is a team effort.
- be concise with your thinking. think linearly, branch only when needed, do not overthink.
- stay grounded, do not make up material just to add filler.
- if you find yourself thinking >2k tokens on a routine task, stop and just do it.

# in the loop

- read before you edit. never modify a file you haven't read this session.
- never invent paths, symbols, or apis. if unsure it exists, grep for it.
- "i don't know" is a valid answer. confabulation is not. state uncertainty explicitly. "verified x. not sure about y." beats confident wrong.
- stay in scope. do exactly what's asked. no drive-by refactors.
- ask before starting if scope is ambiguous. ask mid-task only for hard blockers. otherwise note questions, finish, raise at the end.
- no preamble, no flattery, no recap. output the change.
- when a tool fails, report it and stop. don't retry blindly.
- list only what actually applies; asymmetric, uneven or short lists are fine. it is better to be honest.
- when done, one line: what changed. don't summarize the diff.
- utilize tools to search external sources if you are unsure about your response to validate your decisions.
- make sure the data you utilize is up to date and relevant.
- acknowledge mistakes in one line, fix them, move on. no over-apologizing.
- confirm before commits, force-push, branch deletes, package removals, anything touching shared state.

# workflow

- design → contracts/types → implementation → tests. always. no skipping ahead.
- write a brief design doc first (terse, not academic — 2-4 sentences per decision).
- no regressions on existing code. modify/add only what's needed.

# conventions

how i build — system shape down to code-level habits, one list. language-agnostic: the mechanism differs, the rule doesn't; concrete syntax lives in #examples.

system shape:

- **design to the interface.** types/contracts first — they're 80% of the app and portable. the interface is the loadbearing surface and the blueprint for everything else (the DI section elaborates).
- **simple wins.** core primitives have few moving parts. complexity evolves at the edges — tests, integrations — but the central invariants stay easy to reason about.
- **closed + deterministic.** the program is a state machine you can prove — no hidden external surface. dependencies compose it; internal transitions stay deterministic.
- **schema is the source of truth.** normalized, indexed tables are the spine; code is a projection of them. schema and interfaces are two views of the same objects.
- **compose at the service layer.** transactional paths use narrow indexed seeks composed in code, not joins — predictable plans, visible cost. save joins for analytical paths.
- **one process by default.** modular monolith with DI; go cross-process only when isolation or cadence demands it. most "we need distributed" is a data-arch problem in disguise.
- **small files, single responsibility.** easier to reason about, smaller blast radius.
- **structural fix > compensation.** for concurrency or state bugs, change the design. retries and reconciliation are not fixes.

code-level:

- **fallibility is explicit and carries context.** never fail silently. overflow, missing, and invalid are values you handle at a defined boundary, not surprises.
- **fail closed on uncertain state.** a safety-critical read with stale or incomplete inputs refuses rather than guesses. oracle still warming up means no liquidation; missing config means exit, not degrade.
- **pure core, imperative shell.** pure logic (math, scoring, decode, distance) is inputs to outputs with zero I/O or state. an orchestration layer calls the pure core, mutates, then emits. the core stays pure — it's what you prove and test.
- **enforce invariants as early as the language allows.** compile-time beats startup-check beats runtime-surprise. a build failure is the cheapest place to catch a broken relationship.
- **writes are idempotent, pipelines replayable.** dedup on a natural key, invalidate cache on mutation. a replay produces no double-effect and no silent failure.
- **derive custody, track control-flow.** balances you hold are derived from the source of truth; values that drive logic are tracked explicitly. derived state can't drift, it's donation-immune.
- **comments explain WHY and cite.** rationale, not restatement. mark breaking changes, design-doc and fix references, and derived-not-stored fields. the line earns its place by saying something the code can't.
- **performance is consistency, not just median.** the hot path uses narrow indexed lookups, no scans, no joins; batch per unit of work; precompute invariants once, not per-event. cache per-request and bounded, redis only when numbers prove it. target p99 ≈ p50.
- **naming carries intent.** mark internal-only members; files state their role; a type earns a dedicated file only at a DI seam, otherwise the declaration is the contract.

# dependency injection

DI is the backbone, not a framework choice. the rule: **a component depends on an interface, never a concrete.** the concrete is built once at a single composition root and injected in. why it's worth the discipline:

- **the dependency graph becomes explicit.** every node declares its needs in its constructor; one composition root knows the whole graph. you read the wiring in one file.
- **everything is swappable in one place.** change a registration, not the consumers. implement the interface, rewire one line, zero consumer changes.
- **everything is testable.** inject a fake at the seam, no globals to monkey-patch, no network in unit tests.
- **boundaries stay honest.** if a module reaches around its injected interface to a concrete, the seam leaked.

# lazy loading

defer construction, computation, and I/O until something is actually needed — then do it once and remember. this is the *when* of the DI graph: wired eagerly, materialized lazily. the discipline keeps startup cheap and the dependency tree from paying for paths it never walks.

- **lazy by default, eager where the hot path can't eat a cold start.** rare or expensive-and-maybe-unused things (a model load, a second-tier client, a big precompute) build on first use. but a singleton on the critical path gets warmed at the composition root — laziness must never turn p99 into a first-request spike. the choice is per-dependency, not a global switch.
- **initialize exactly once, even under concurrency.** a guarded once-init (OnceCell, a lazy static, a memoized promise) so two callers racing the first access don't double-construct or read a half-built value. lazy init is a write; make it idempotent like any other.
- **memoize the result, invalidate on mutation.** the point is to pay the cost once — cache it behind the seam and drop it when the source of truth changes. a stale lazy value is the same bug as a stale cache, wearing a different hat.
- **load data on demand, not eagerly by relation.** fetch the narrow slice you need when you need it (paginate, stream, seek by key) instead of hydrating whole object graphs up front. this is composition-over-joins in the time dimension.
- **fail closed if lazy init fails.** a first-load that can't complete surfaces an explicit error to the caller — never a cached, half-initialized object that looks ready. warming-up refuses, it doesn't guess.
- **laziness stays behind the interface.** the consumer asks and receives; whether the thing was built now or an hour ago is the provider's secret. don't leak init order or a "call .ready() first" contract onto callers — that's the seam leaking, same failure as reaching past an injected interface.

# systems

a system is the program scaled out: many nodes, partial failure as the normal case, no shared clock. shape it so no single box is load-bearing.

- **horizontal first.** scale by adding identical stateless nodes in front of the data, not by growing one box. state lives in the data tier; compute nodes are cattle — any one can die and be replaced with no handoff. a node holding session state in memory is a vertical bottleneck wearing a horizontal costume.
- **APIs are stateless, always.** an endpoint holds no state past the request. no in-memory session, no sticky affinity, no "second call depends on what the first left in this process." everything needed comes in with the request (token, ids, args); everything that must persist goes out to the data tier before the response returns. this is what makes nodes interchangeable: any replica can serve any request, load-balance round-robin, restart mid-traffic. stateful sessions belong in a store (db/cache/token), never in the process.
- **fault tolerance is the default posture, not a mode.** assume every remote call times out, every node crashes mid-write, every network partitions. design the happy path and the partition path together. the recovery path *is* the feature. health-check, fail over, drain, resume are ordinary operations, not incident-only.
- **decouple everything.** components talk through explicit contracts (a queue, an event log, an interface) never by reaching into each other's state. a producer doesn't know its consumers; a consumer replays from the log. loose coupling is what lets you scale, restart, and redeploy one piece without stopping the rest. this is the interface-over-concrete rule from DI, applied across the wire.
- **idempotent + replayable across nodes.** single-node idempotency becomes survival at scale: at-least-once delivery means every handler dedups on a natural key. an event log you can replay is both your recovery story and your audit trail.
- **consensus only where correctness needs one truth.** when replicas must agree on an ordering (who holds the lock, what the committed log is) you need a consensus protocol, not a heuristic. Raft is the worked example: one elected leader takes all writes and replicates an append-only log; an entry commits once a majority quorum has it; on leader loss the rest elect a new leader by term, and any committed entry survives because it sits on a majority. the lessons that generalize: a quorum (N/2+1) tolerates ⌊(N−1)/2⌋ failures, the log is the source of truth (not node memory), and a partitioned minority must refuse writes rather than diverge, fail closed, again. don't hand-roll it; reach for Raft or a coordinator that implements it, and reserve consensus for the few decisions that truly need one global order.
- **structural fix over compensation, at scale too.** a distributed bug is a design bug. if two nodes race, change the ownership model (partition the keyspace, elect a leader, make the write commutative) don't paper over it with retries and reconciliation.
- **cqrs for event driven systems** there should be a clear separation between writes and reads on the system, especially for event/notification based systems.

# security

attacker-mindset, grounded in how i build but framed to port across languages. every new code path is an attack surface — design the guard with the feature, not after. concrete snippets in #security examples.

- **authorize at the boundary, not in the body.** the framework's validation layer is the guard. by the time logic runs, access is already proven. put auth in the declarative layer (account constraints on-chain, route middleware/guards in a web API, an interceptor on an RPC) so a new code path physically cannot forget it. never scatter ad-hoc checks through handlers.
- **deny by default.** capabilities start closed and open explicitly; allowlists over denylists. a denylist is a list of the attacks you happened to think of. unknown input, route, or origin is refused.
- **fail closed on uncertain state.** stale, warming-up, missing, or unverifiable inputs refuse rather than guess. the safe default is "no".
- **least privilege; separate capabilities.** who-can-read is not who-can-write is not who-can-extract. grant the narrowest capability that works, and keep operate-on distinct from own. a component that uses a resource shouldn't be able to drain it.
- **derive authority from the source of truth, never a mutable counter.** entitlement comes from the canonical record, not a number a caller can influence or that can drift. tracked totals are accounting, not permission.
- **canonicalize untrusted input before you compare or act on it.** resolve to the real thing, then check: a path through realpath before an allowlist (else a symlink or `..` escapes), a URL's host resolved and private/loopback/link-local addresses rejected before the fetch and re-checked across redirects (else SSRF), an identifier normalized before equality.
- **never feed untrusted input to an interpreter.** SQL, shell, template, deserializer, regex, eval. use parameterized or escaped APIs, never string interpolation. data must never be able to become code.
- **bound the work an untrusted caller can induce.** size, time, depth, and rate caps so one request can't exhaust the system (input-size limits, batch caps, query timeouts, pagination, recursion guards, rate limits). unbounded work is a DoS waiting to happen.
- **protect sensitive operations against replay.** a nonce, idempotency key, or signature consumed exactly once; replays land inert. the security face of idempotent writes, the threat is a captured-and-resent request, not an accidental retry.
- **make dangerous operations total.** arithmetic that can overflow, casts that can truncate, indices that can run off the end. handle the edge explicitly and abort, never wrap/truncate/panic silently into a bad state.
- **check and use atomically — mind TOCTOU.** if you validate then act, an attacker races the gap: DNS rebinding between an SSRF check and the fetch, a file swapped between stat and open. pin the validated artifact or re-validate at the moment of use.
- **defense in depth — independent, layered brakes.** no single check is load-bearing; stack independent controls (cap AND depth AND ratio AND min-size) so one bypass doesn't open the door. redundancy is the design, not the fallback.
- **handle secrets as secrets.** never in code, logs, or error messages; loaded from env or a secret store; short-lived and scoped; redacted on the way out.
- **dependencies are attack surface you didn't write.** minimal, pinned, audited before they land.
- **log every state mutation as a structured event; errors carry context, never silent.** the event log is the audit trail and the incident reconstruction.

# testing

- real programs > mocks. e2e against a real deployment setting.
- formal verification (eg. kani proofs) + proptests for invariants + math.
- unit tests for pure utility functions and providing coverage for edges that formal verification misses. 
- loadtest is correctness. every system has a stated spec (e.g. p99 < 100ms at N concurrent). passes/fails like any other test.

# code examples

short, real, from my repos. this is the shape, match it. organized by language; each is a best-practice you can lift. all concrete code in this doc belongs here, not in the prose sections above.

## typescript

**async: return the promise, don't await it.** `return await fn()` adds a needless microtask tick and an extra stack frame — `return fn()` does the same thing cheaper. only keep `await` when the call sits inside a `try` whose `catch` must see the rejection.
```ts
const load = async (id: string): Promise<Doc> => {
  return fetchDoc(id)          // not: return await fetchDoc(id)
}
```

**DI — the composition root wires the whole graph in one file** (tsyringe):
```ts
container.registerInstance<DBProvider>(TOKEN_MAP.DBProvider, db)        // concrete, built once
container.registerSingleton(TOKEN_MAP.JWTMiddleware, JWTProvider)
container.register<AuthEndpoints>(TOKEN_MAP.AuthEndpoints, AuthService) // interface → impl
// nothing else knows the graph; everything else just asks for an interface.
```

**DI — depend on the interface, injected by constructor** (tsyringe):
```ts
@injectable()
export class AuthService implements AuthEndpoints {
  constructor(
    @inject(TOKEN_MAP.JWTMiddleware) private jwtMiddleware: JWTMiddleware<User>,
    @inject(TOKEN_MAP.UserEndpoints) private userService: UserEndpoints, // ← interface, not UserService
  ) {}
}
```

**DI — constructor injection via parameter properties** (no container):
```ts
export class EmbedProvider {
  constructor(private readonly runtime: EmbedRuntime) {}   // the field IS the injected interface
}
```

**DI — the swap payoff: one line moves, consumers don't**:
```ts
const embedRuntime: EmbedRuntime = new HttpEmbedRuntime(inference.embed) // was new LlamaEmbedRuntime(...)
this.embed = new EmbedProvider(embedRuntime)                             // EmbedProvider never changed
```

**sealed contract — the interface IS the type**:
```ts
export abstract class AuthEndpoints {
  abstract login: (o: AuthRequest<'login'>) => Promise<AuthResponse<'login'>>
}
// routes/consumers depend on AuthEndpoints; the impl must match exactly.
```

**pure core, imperative shell**:
```ts
private __calculateScore(o: { ... }): number { /* normalize + weight; pure, no I/O */ }
async update(...) { const s = this.__calculateScore(...); await this.save(s) } // shell does the I/O
```

**naming carries intent** — internal-only marked `__private`; files named for their role (`*.service.ts`, `*.provider.ts`).

## rust / solana

**fallibility — explicit, handled at the edge**:
```rust
pub fn calc_swap_fee(amount: u64) -> Option<u64> {            // pure; None = overflow
    amount.checked_mul(SWAP_FEE_BPS)?.checked_div(FEE_DENOMINATOR)
}
let fee = math::calc_swap_fee(amt).ok_or(ErrorCode::MathOverflow)?; // converted to error at the boundary
```

**invariant enforced at compile time**:
```rust
const _: () = assert!(CREATOR_SOL_MIN_BPS <= TREASURY_SOL_MAX_BPS); // build fails if the relationship breaks
```

## sql

**idempotent write — replay-safe**:
```sql
-- ON CONFLICT (signature, inner_ix_idx) DO NOTHING — a replayed event inserts nothing twice.
```

# security examples

the security principles above, made concrete — same shape, match it.

**authorize at the boundary — the constraint IS the guard** (Rust/Anchor):
```rust
#[account(
    seeds = [GLOBAL_CONFIG_SEED],
    has_one = authority @ Error::Unauthorized,                 // caller must equal the stored authority
    constraint = args.amount >= MIN_AMOUNT @ Error::TooSmall,  // input bound, validated before the body
)]
pub config: Account<'info, GlobalConfig>,
// the handler body runs only once every constraint holds — auth can't be skipped or forgotten.
```

**fail closed on an uncertain read** (Rust):
```rust
// TWAP returns None while the oracle ring is younger than the lookback (warmup).
let price = pool.twap(lookback).ok_or(Error::OracleWarmingUp)?;  // refuse, don't guess
```

**derive authority from the source of truth** (Rust):
```rust
let spendable = ctx.accounts.vault_sol.lamports();   // derived from the account — donation-immune
// not: vault.total_deposited - vault.total_withdrawn   (a stored counter that can drift)
```

**canonicalize before allowlist — close the symlink/`..` escape** (TS):
```ts
const real = realpathSync(resolve(path))                       // collapse `..` AND resolve symlinks
if (!roots.some((r) => real === r || real.startsWith(r + '/')))
  throw new Error('path escapes allowed roots')                // prefix-match only AFTER canonicalizing
```

**reject internal targets before fetch — close the SSRF** (TS):
```ts
const { address } = await dns.lookup(new URL(url).hostname)
if (isPrivate(address)) throw new Error('refusing private/loopback/link-local target')
// re-run this check on every redirect hop; a public URL can 302 to 169.254.169.254
```

**never interpolate into an interpreter — parameterize** (TS):
```ts
db.prepare('SELECT * FROM chunks WHERE source_id = ?').all(sourceId)  // never `... = ${sourceId}`
```
