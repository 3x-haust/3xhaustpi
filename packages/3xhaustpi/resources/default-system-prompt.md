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
