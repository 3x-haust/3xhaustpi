---
name: release-governance
description: Govern release, CI, protected-branch, npmjs publishing, provenance, and recovery work. Use for release preparation, workflow changes, versioning, tags, publishing, deployment, or repository governance.
---

# Release governance

Use this procedure for release, CI, publishing, and repository-governance work.
Repository-local instructions define exact commands and identities.

## Applicability

- For npmjs publishing, use Trusted Publishing only when the repository and
  package have a supported, verified OIDC publisher.
- Never replace unavailable Trusted Publishing with a local publish or
  long-lived npm write token. Stop and request explicit approval.
- Other registries, offline repositories, and non-GitHub hosting require their
  own reviewed contract.

## Architecture first

1. Read the package graph, release workflow, branch/ruleset state, and existing
   repository instructions.
2. Choose the smallest correct change that preserves release identity,
   provenance, idempotence, and maintainability.
3. Keep workflow, hosted settings, registry settings, and package metadata as
   separate controls. Do not infer one from another.

## Branch and pull request

1. Create one short-lived branch per work unit.
2. For hosted repositories, require a protected default branch and merge by
   pull request.
3. Verify effective rules through the hosting API. Workflow presence does not
   prove required checks.
4. Use one unique, unconditional aggregate CI check when CI gates merge.
5. Wait for required CI and resolve failures; never weaken tests merely to
   obtain green output.
6. Merge using the repository's reviewed method, then remove the work branch.

## Proportionate CI

- Pull requests: frozen install, static checks, focused tests, build/package
  smoke, and representative supported-platform coverage.
- Main or scheduled qualification: broader supported runtime/OS matrix and
  slower integration checks.
- Release: exact immutable source, full required qualification, one tested
  artifact, provenance, and post-publish consumer smoke.
- Cancel superseded runs only when the old evidence has no continuing value,
  such as an earlier commit on the same pull request.
- Serialize publish and deployment side effects without cancelling a running
  release. Concurrency is not a FIFO release queue.
- Cache dependency downloads, not credentials or `node_modules`.

## npmjs Trusted Publishing

Before publishing, verify:

1. npm owner, repository, workflow filename, and optional environment exactly
   match the trusted publisher configuration.
2. The publisher job uses a GitHub-hosted runner, supported Node/npm versions,
   `contents: read`, and `id-token: write`.
3. No `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or other long-lived npm write credential
   reaches the publish job.
4. The environment restricts approved release refs and bypass; protected tags
   cannot be moved or deleted.
5. Event ref, checked-out commit, release tag, package version, tested artifact
   digest, and published artifact all identify one immutable release.
6. Third-party actions are pinned to reviewed immutable commit SHAs.
7. Package contents, version, repository metadata, tarball, and dry-run output
   are inspected before the publish job.

Trusted Publishing hardens credentials. Provenance links an artifact to a
source and build; neither proves the source is harmless.

## Publish and recovery

1. Query the exact package version before publishing.
2. If it exists, verify integrity and attestations, then finish idempotently.
3. If it does not exist, publish only from the reviewed trusted workflow.
4. After publication, verify version, dist-tag, integrity, provenance
   predicate, release assets, deployment status, and a clean consumer install.
5. On ambiguous failure, query the registry before retrying.
6. Never reuse or overwrite an npm name/version. Publish a corrected SemVer
   version when the artifact itself is wrong.
7. A workflow fix requires a new run from a corrected immutable source; reruns
   of an old run retain its original workflow SHA and ref.
