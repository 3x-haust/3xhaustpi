Optimize every change for fast delivery, efficient execution, and
enterprise-grade scale. Before implementation, inspect the architecture,
affected boundaries, data ownership, failure modes, security model,
observability, existing conventions, and expected growth of the product idea.

Design for clear domain boundaries, stable contracts, strict types,
maintainable modules, testability, operability, and safe evolution. Account for
high concurrency, horizontal scaling, backpressure, idempotency, consistency,
schema and API migration, fault isolation, capacity limits, and cost where they
are relevant. Prefer the smallest architecture that remains correct and
extensible at the stated enterprise scale. Avoid both premature complexity and
shortcuts that create predictable bottlenecks, fragile coupling, or costly
rewrites.

Keep hot paths efficient. Establish measurable latency, throughput, memory,
reliability, and cost budgets when performance matters. Profile before
optimizing uncertain bottlenecks, but remove proven waste at its root. Reuse
existing platform capabilities and project abstractions before adding new
layers, services, dependencies, fallbacks, or compatibility code.

Make the development feedback loop as fast as safely possible. During
iteration, run the smallest deterministic static checks and focused tests that
fully cover the changed seam, and run independent work in parallel. Order
checks from fastest and most diagnostic to slowest. Reuse safe dependency and
build caches, skip work proven unchanged, avoid duplicate installs and builds,
fail fast within a job, and cancel superseded runs for older commits on the
same pull request.

Use risk-based CI stages. Pull requests should have a fast required lane with
frozen dependency installation, static analysis, focused tests, build/package
smoke checks, and representative platform coverage. Move broader runtime and
operating-system matrices, expensive integration tests, endurance tests,
benchmarks, and deep security scans to main, scheduled, or release
qualification unless the current change directly risks them. Keep required
check names unique and unconditional so protected branches cannot remain
incorrectly pending.

Never gain speed by weakening tests, hiding diagnostics, skipping a required
contract, or accepting flaky timing. Fix nondeterminism and pipeline
bottlenecks at the root. Expand verification immediately when the blast radius,
security impact, persistence format, public API, concurrency model, or release
risk requires it.

Develop each substantive feature, bug fix, release, or concurrent task on a
dedicated short-lived branch in its own worktree, created from the latest
protected default branch. A trivial sequential typo or documentation-only edit
may use the current worktree on a new branch when isolation adds no value.
Never let concurrent agents share a writable worktree. Reuse safe shared
dependency-download caches, but keep generated state and builds isolated when
cross-task contamination is possible.

For hosted repositories, merge only through a reviewed pull request, required
green CI, and an actively protected default branch. Verify effective rules
through the hosting API instead of inferring enforcement from workflow files.
After merge, delete the remote work branch and remove its worktree and
temporary artifacts while preserving required evidence.

When publishing to npmjs and Trusted Publishing is supported and configured,
publish only through the trusted CI workflow with OIDC and provenance. Never
fall back to a local publish or long-lived npm write token. Preserve one
immutable identity across source commit, tag, tested artifact, package version,
provenance, and published artifact. If that contract is unavailable, stop and
request explicit approval.

Follow repository-local instructions and applicable skills for exact commands,
architecture constraints, service-level objectives, release identities,
required checks, and explicitly reviewed exceptions.

Treat hosted CI capacity as a finite production budget. Optimize primarily for
total billed runner minutes and quota consumption, not merely wall-clock
latency. Account for operating-system pricing multipliers, repeated workflow
runs, canceled work, cache misses, and reruns. Do not shard or fan out work when
doing so makes the result faster but consumes more aggregate runner time.

Before changing a CI system, measure recent real runs by workflow, trigger,
runner, job, and expensive step. Establish a billed-minutes baseline, identify
duplicate installs, builds, tests, audits, packaging, and attestations, and set
a concrete reduction target. Prefer evidence from hosted run metadata over
assumptions based only on workflow YAML.

Classify changes in a cheap preflight stage and derive the smallest correct test
plan. Documentation-only changes should not start expensive build or
cross-platform jobs. Run platform-independent checks once on the cheapest
trustworthy runner. Run macOS, Windows, native, integration, or full-matrix
coverage only when affected paths or risk boundaries require it, while keeping
scheduled and release qualification sufficient to detect platform drift.

Reuse verified outputs rather than repeating work. Share immutable build
artifacts when platform jobs consume identical inputs, use dependency-download
caches with precise lockfile and toolchain keys, cancel superseded commits, and
apply realistic job timeouts. Never cache mutable state or accept a restore key
that can substitute stale code, generated data, binaries, or security results.

Design conditional workflows so protected branches cannot remain pending.
Preserve stable required-check contracts or use one unconditional aggregator
that validates the computed plan, required jobs, skips, and conclusions. Ensure
dependency, lockfile, workflow, release, security, TUI, terminal, and native
changes automatically expand to the necessary platform and supply-chain gates.

Optimize release pipelines separately from pull-request pipelines. Build common
inputs once, investigate trustworthy cross-target packaging, and use expensive
platform runners for the minimum native work or runtime smoke testing they
uniquely provide. Never reduce artifact coverage, checksums, clean-install
checks, exact commit and tag identity, Trusted Publishing, provenance,
attestation, or platform startup verification to save quota.

Treat remote CI executions as scarce. Validate workflow syntax, expressions,
shells, dependency graphs, path classification, aggregators, and affected tests
locally before the first remote run. Do not hide instability with retries,
larger timeouts, skipped tests, or continue-on-error. Fix nondeterminism and
resource contention at the root, then verify both the pull-request head and the
post-merge default-branch commit. Report baseline and optimized billed minutes,
runner policy, remaining unavoidable cost, and the evidence that correctness
and security contracts remain intact.
