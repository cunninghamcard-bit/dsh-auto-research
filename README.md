# dsh-auto-research

Evidence-scored research batches for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), as a `SubagentProvider` named `auto-research`.

One activation runs one **Batch**: freeze the evaluator, evaluate the baseline, run isolated research branches with **fork-and-flush** and/or **RSI-top**, optionally share checkpoints between cooperative cohorts, select a leader by independently evaluated score, and write a complete receipt trail. The coordinator model — not this plugin — owns the scientific objective, metrics, and decision to continue.

Stack: Node.js ESM, Cordis plugins, `ctx.subagents`, optional [LayerFS](https://github.com/layerfs) copy-on-write branches. No runtime dependencies.

## What it adds

| Cordis row | Contribution |
| --- | --- |
| `subagent-auto-research` | Registers the `auto-research` provider and the coordinator prompt section |
| `tool-subagent-auto-research` | Exposes `subagent_auto_research` through `@deepseek-ai/dsh-tool-subagent` with provider-managed depth |

The coordinator receives the research policy, methods policy, and continuation policy as a system-prompt section. It inspects the repository, writes a plan, delegates one batch, then reviews `RESULT.json`, `DASHBOARD.json`, `LEADER.json`, `SELECTIONS.json`, and any cooperative evidence before deciding whether another batch is justified.

## Install

Add the bundle to a DSH profile (the plugin manager reads `dsh.bundle.patch`), or insert the two rows from [`cordis.patch.yml`](cordis.patch.yml) into the profile patch manually. The provider expects at least one other registered `ctx.subagents` provider to execute workers (`claude-code`, `codex`, `acp`, `dsh-sdk`, `spawn`, …). Set `workerProvider` when the profile has more than one candidate.

```yaml
- insert:
    - id: subagent-auto-research
      name: 'dsh-auto-research'
      config:
        workerProvider: claude-code
        rounds: 1
        branches: 4
        explorationMinutes: 30
        exploitationMinutes: 30
        rsiTop: true
        forkAndFlush: false
        shareContext: false
        sharingIntervalMinutes: 10
    - id: tool-subagent-auto-research
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: auto-research
        toolName: subagent_auto_research
        maxDepth: provider-managed
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `providerName` | `auto-research` | Registry name of the provider |
| `workerProvider` | first other provider | `ctx.subagents` provider used for branch workers |
| `planPath` | `.auto-research-methods/plan.json` | Plan file read from the delegated checkout |
| `rounds` | `1` | Rounds in one batch (a ceiling, not a completion claim) |
| `branches` | `4` | Parallel explore branches |
| `explorationMinutes` | `30` | Per-phase explore window |
| `exploitationMinutes` | `30` | Per-phase continue window |
| `rsiTop` | `false` | Enable randomized metric-subset views and portfolios |
| `forkAndFlush` | `false` | Force a fresh explore cohort every round |
| `shareContext` | `false` | Enable cooperative checkpoints and peer review |
| `sharingIntervalMinutes` | `10` | Checkpoint cadence inside a phase window |
| `layerfs` | auto | Explicit LayerFS settings; `false` forces the snapshot backend |
| `workerEnv` | `{}` | Non-secret environment facts shown to workers |

Every plan may include an `options` object that overrides these per-batch values. The model chooses scientific values; the plugin only rejects impossible combinations (for example a metric subset larger than the declared metric set).

## Plan

The coordinator writes the plan outside the candidate source. The provider also accepts a plan embedded in the delegation prompt as a fenced JSON block or a `PLAN_JSON:` line.

```json
{
  "objective": "The user's exact objective and scope",
  "worker_prompt": "Task-specific instructions, constraints, how to run checks, and how to save evidence",
  "evaluator": "absolute/path/to/evaluator.mjs",
  "evaluation_seconds": 60,
  "direction": "maximize",
  "metrics": [
    { "name": "validity", "definition": "task-specific fixed definition" },
    { "name": "best_trial", "definition": "best valid trial", "optional": true }
  ],
  "selection_metrics": [
    { "name": "verified_progress", "direction": "maximize" }
  ],
  "stall_seconds": 1200,
  "meaningful_gain": 0.0,
  "metric_subset": 1,
  "portfolio_size": 4
}
```

- `selection_metrics` must also be declared in `metrics` and be finite; they only rank candidates whose primary score ties.
- Optional metrics may be absent; a missing observation is never coerced to zero.
- `stall_seconds`, `metric_subset`, and `portfolio_size` are required when `rsiTop` is enabled.
- `workspace` may name a compact seed subdirectory inside the checkout. It must be relative, symlink-free, and outside `.auto-research-methods`.

## Evaluator contract

The evaluator is copied out of the candidate workspace, hashed, and executed with the candidate workspace as its final argument:

```text
<stdout> {"valid": true, "score": 1.0, "metrics": {"validity": 1.0}, "evidence": ["relative/receipt.json"]}
```

- One JSON object on stdout. Invalid candidates emit `valid: false`.
- `score` must be finite; booleans and non-finite sentinels are rejected.
- Every entry in `evidence` must be a contained regular file inside the evaluated workspace.
- The script must not modify the workspace; the runner compares the full inventory before and after.
- The frozen copy's SHA-256 is checked before and after every evaluation.
- `.py` evaluators run with `python3 -I -B`; `.js/.mjs/.cjs` run with the current Node executable. Set `evaluator_interpreter` to override.

## Batch lifecycle

1. Freeze the evaluator and write `PLAN.json` / `CONFIG.json`.
2. Snapshot (or LayerFS-baseline) the starting workspace and evaluate it. An invalid baseline stops the batch before any worker starts.
3. For each round, decide `stalled` (`now - bestTime >= stall_seconds`) and `explore = forkAndFlush || (rsiTop && stalled)`.
4. Explore runs `branches` parallel workers; continue runs one worker. Each branch gets an isolated fork/mount, a Worker Prompt, a budget reservation, and (under RSI-top) a distinct randomized metric view plus portfolio protocol.
5. Evaluate completed branches with the frozen evaluator, validate `PORTFOLIO.json`, and select a leader.
6. Either run the continue phase or finish with `RESULT.json`.

With `shareContext`, each phase runs cooperative epochs inside the same total window. Every epoch publishes `PEER-EVIDENCE.json` and `shared-context.md`; branches write `SHARED_CHECKPOINT.json` (explicit text evidence allowlist) and, on resumed epochs, `PEER-REVIEW.json` covering every supplied peer exactly once. A verified completed state is retained content-addressed and restored into a separate `<branch>-last-completed/` directory if a later epoch fails.

## Artifacts

Everything lives under `<checkout>/.auto-research-methods/runs/<run-id>/`:

| File | Purpose |
| --- | --- |
| `PLAN.json`, `CONFIG.json` | Frozen inputs |
| `evaluator.*` | Frozen evaluator copy |
| `initial/` | Baseline workspace, manifest, evaluation |
| `round-N-<phase>-<n>/` | Branch workspace, `INPUT-MANIFEST.json`, `LAUNCH.json`, `BUDGET.json`, `RESULT.json`, evaluation logs |
| `round-N-<phase>-epoch-N-branch-M/` | Cooperative epoch branch artifact |
| `round-N-<phase>-COLLABORATION.json` | Epoch history, peer bundle paths, retained checkpoints |
| `PEER-EVIDENCE.json` | Immutable published peer observations |
| `shared-context.md` | Verbatim research checkpoints plus `RESEARCH_CONTEXT/` topic index |
| `checkpoint-objects/` | Content-addressed completed files |
| `DASHBOARD.json` | Every trajectory plus metric diagnostics |
| `SELECTIONS.json` | Round-by-round selection receipts |
| `LEADER.json` | Selected candidate |
| `RESULT.json` | Batch boundary result |

`<checkout>/.auto-research-methods/LATEST.json` records the selected workspace, its LayerFS branch, and the original manifest. The next batch starts from that leader only when the original workspace still matches; otherwise it stops and asks the coordinator to reconcile the starting point. With LayerFS, the saved branch is remounted when its previous mount path is no longer available.

## LayerFS integration

When `DSH_LAYERFS_PROJECT` and `DSH_LAYERFS_SDK` are present (or `config.layerfs` provides them), branches use `branch.fork`, `workspace.mount`, `workspace.commit`, and `workspace.unmount`. Verified states are committed; scientific rejections are unmounted with `discard: true`, while provider failures and timed-out work are committed as unverified and kept for review. Without a bound project, a full-copy snapshot backend with content-addressed checkpoint objects is used.

The provider reads `DSH_LAYERFS_PROJECT`, `DSH_LAYERFS_SDK`, `DSH_LAYERFS_OPERATOR`, `DSH_LAYERFS_STORE_PATH`, and `DSH_LAYERFS_HOME`. Explicit `config.layerfs` wins over the environment.

## Safety

- The user's original checkout is never evaluated or mutated; branches are copies or CoW mounts.
- Symlinks, path traversal, dotfiles (except `.method-evaluation`), private credential names, and credential-looking evidence are rejected from shared checkpoints.
- Worker prompts forbid recursive spawning and publishing/merging.
- Config is sanitized before serialization; secret-looking environment keys are not written.
- No automatic merge, reset, overwrite, deletion, or publication occurs.
- A batch boundary is not proof that the user's objective is complete or that a benchmark gain exists.

## Tests

```bash
npm test
```

The `node:test` suite covers protocols (metric views, portfolios, checkpoints, peer review, synthesis context), evaluator freezing and integrity, both workspace backends and completion restoration, full runner batches (fork-and-flush, RSI stall, cooperation, failure/timeout distinctions), provider/plugin lifecycle, cancellation, and package metadata.

## Limitations

- Propagating a worker's provider session for continuation is recorded but not resumable through the generic `startActivation` seam; every worker turn receives a fresh prompt.
- LayerFS mounts are assumed to expose a host-accessible workspace path.
- Cooperative epochs reuse a branch workspace and require the worker to finish within the share window; the hard phase deadline still applies.
- The evaluator must be a local executable script; there is no built-in sandbox beyond the accepted workspace and inventory checks.
