---
name: auto-research
description: Run evidence-scored research batches on LayerFS branches with the subagent_auto_research tool. Load before writing an auto-research plan or evaluator, or reviewing a batch's results.
---

# Auto research (coordinator)

You coordinate. You write the evaluator and the plan, delegate one batch at a time with `subagent_auto_research`, review the evidence, and decide whether another batch is justified. Branch workers do the experiments. The plugin owns branches, scheduling and scoring; it never decides what is scientifically true or whether the user's objective is met.

The conversation must be bound to a LayerFS project: every branch of a batch is a branch of that project.

## Workflow

1. Read the user's request and the project's own instructions. Name the source you follow. Ask one concise question only when nothing establishes an actionable objective.
2. Find the authoritative evaluation criteria. Prefer a maintainer-defined rubric or checker over one you invent; record its source in the plan as `scoring_authority`. A proxy you propose is provisional.
3. Prepare the starting state on a LayerFS branch (or use `main`). Its name or commit goes into the plan as `base`.
4. Write the evaluator as a file in your current folder (contract below). Run it on the starting state and on a deliberately broken one before delegating.
5. Write the plan to `.auto-research-methods/plan.json` in your current folder.
6. Call `subagent_auto_research` with a short request. One call runs one complete batch and returns the leader branch, its commit and score.
7. Review the artifacts (below), then report to the user or plan the next batch.

Do not run two batches from one folder, and never let a worker start a batch.

## Plan

```json
{
  "objective": "The user's exact objective and scope",
  "worker_prompt": "Task-specific instructions: constraints, how to run checks",
  "base": "starter",
  "evaluator": "/absolute/path/to/evaluate.py",
  "evaluation_seconds": 120,
  "direction": "maximize",
  "metrics": [{ "name": "speedup", "definition": "task-specific fixed definition" }],
  "selection_metrics": [],
  "stall_seconds": 1200,
  "meaningful_gain": 0.01,
  "scoring_authority": { "primary": "source and version of the rubric" },
  "options": { "rounds": 3, "branches": 4, "explorationMinutes": 5, "exploitationMinutes": 15 }
}
```

The values are schema examples, not defaults. Choose each from task evidence.

- `objective`, `worker_prompt`, `evaluator`, `evaluation_seconds` are required. `base` defaults to `main`. `direction` defaults to `maximize`.
- `metrics`: fixed definitions the evaluator computes. A metric that only exists after a particular experiment is `"optional": true`; omit it when unavailable. A missing observation is never zero.
- `selection_metrics`: declared metrics that rank candidates whose primary scores tie.
- `meaningful_gain`: the smallest primary-score gain that counts as progress; it drives the RSI-top stall clock.
- With `rsiTop`: `stall_seconds`, `metric_subset`, `portfolio_size` (≥ 2) and a positive `meaningful_gain` are required.
- `options` overrides the installed configuration for this batch: `rounds`, `branches` (≥ 2), `explorationMinutes`, `exploitationMinutes`, `rsiTop`, `forkAndFlush`, `executor`, `workerModel`.

The plan is fixed for the batch. Revise metrics or the evaluator between batches, never mid-batch. Each batch continues from the last leader in `LATEST.json` and first scores it again with the batch's evaluator and executor.

## Evaluator contract

The runner reads your evaluator once per batch. For every candidate commit, the executor puts the script at `.auto-research/<name>` in a fresh copy of that commit and runs it from the branch root: `<interpreter> .auto-research/<name> .` (`.py` with `python3 -B`, `.js/.mjs` with `node`, `.sh` with `bash`; override with `evaluator_interpreter`). Nothing it writes is kept.

The last line of stdout is the result:

```text
{"valid": true, "score": 1.0, "metrics": {"speedup": 1.0}}
```

- An invalid candidate prints `"valid": false` with a `reason`.
- `score` and every metric are finite numbers.
- Check real correctness. Do not trust numbers the candidate reports about itself; measure them.
- If no honest automatic evaluator is possible, explain the missing criterion and stop.

## Methods

Each round runs an explore phase followed by a continue phase, or only the continue phase.

- **explore**: `branches` new branches forked from the leader's commit, each with a fresh worker.
- **continue**: the leader's own worker session continues on the leader's branch.
- `forkAndFlush`: every round explores.
- `rsiTop`: a round explores when work since the last gain above `meaningful_gain` reaches `stall_seconds`. That time carries across batches in `LATEST.json`. Explore workers get distinct randomized metric views and are asked to write a portfolio of distinct hypotheses, which is recorded with each branch.

Selection uses only the evaluator: valid candidates and the incumbent are ranked by primary score, then `selection_metrics`.

## Review after a batch

The tool returns the run folder. In it:

- `RESULT.json`, `LEADER.json`: the outcome and the selected state (branch, commit, score, worker session).
- `DASHBOARD.json`: every trajectory, every selection, and `metric_diagnostics`. A metric constant across observed states gives no discrimination; say so instead of reading progress into it.
- Per branch: `RESULT.json`, `worker-output.md`, `evaluation.log`, and the worker's scratch folder with `BRANCH.json` and its notes.

A batch boundary is not evidence that the objective is met. Report the leader branch and commit. Nothing is merged or published automatically; do not do so without the user's authorization.
