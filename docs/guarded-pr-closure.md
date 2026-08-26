# Close an approved pull request

Use this procedure after QA passes and the post-QA record is complete. The Senior Backend reviewer owns the final closure. The reviewer closes only the pull request and feature refs named in the bound closure record.

## Check the repository path

Run the disposable check from the repository root.

```bash
npx tsx --test test/guarded-closure-reproduction.test.ts
```

The check requires Git on your `PATH`. It creates a temporary bare remote and temporary working clones. It does not contact GitHub, read operator configuration, or change this repository. It removes the temporary directory after each test.

A successful run reports these four cases:

- A valid bound change reaches the default branch, then removes only its local and remote feature refs.
- Missing approval or a mismatched pull request stops before merge.
- A failed remote-ref cleanup records rejection and stops without later cleanup.
- A replay after merge accepts absent bound refs without another merge or an unrelated ref deletion.

Run the focused check before the full suite.

```bash
npm test
```

The disposable check models the Git path and fixed pull request facts. The final review of a live pull request still verifies GitHub approval, checks, and branch metadata.

## Close the bound pull request

Before closure, the final reviewer verifies all of these conditions:

- The repository, pull request number, head ref, and head commit match the bound record.
- The pull request is approved, open, mergeable, and has passing required checks.
- The pull request targets the repository default branch.
- The local worktree is clean and is not behind or ahead of the expected branch state.
- QA passed and the post-QA record names the same pull request and head commit.

The guarded closure tool performs the only allowed mutation sequence. It squash-merges with the expected head commit, confirms the default branch contains the result, removes the exact local feature ref, removes the exact remote feature ref, and records the result. Do not use a raw Git or GitHub command to merge the pull request or delete a ref.

Record the pull request identity, approval state, check result, default branch, merged commit, and the result for both feature refs. Those details let a later reviewer distinguish a complete closure from a read-only inspection.

## Handle rejection

If a prerequisite is missing, reject closure before any mutation. Do not report success from an inspection.

If a merge or cleanup step fails, stop at that step. Record the failed condition and do not run a later merge, deletion, release, version, or source-change command. Resolve the blocked state before asking the final reviewer to try again.

## Replay a completed closure

Replay only with the same bound pull request and head commit. If the pull request is already merged, verify the recorded merge before treating replay as successful. If the exact local or remote feature ref is already absent, record a safe no-op for that ref.

Reject replay when the pull request identity, head commit, branch target, or ref binding is ambiguous. Never merge twice or remove an unrelated ref.
