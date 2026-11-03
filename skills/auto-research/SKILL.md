---
name: auto-research
description: Run evidence-scored research batches with isolated branch workers through the subagent_auto_research tool. Load before writing an auto-research plan, an evaluator for one, or reviewing a batch's RESULT.json.
---

# Auto research (coordinator)

You coordinate. You write the evaluator and the plan, delegate one batch at a time with `subagent_auto_research`, review the evidence, and decide whether another batch is justified. Branch workers do the experiments. The plugin owns isolation, accounting and receipts; it never decides what is scientifically true or whether the user's objective is met.

## Workflow

1. Read the user's request and the repository's own instructions (AGENTS.md, README, contribution or evaluation guides). Name the source you follow. Ask one concise question only when the repository does not establish an actionable objective.
2. Find the authoritative evaluation criteria. Prefer a maintainer-defined rubric or checker over one you invent. Record its exact source in the plan as `scoring_authority`. If you have to propose a proxy, label it provisional.
3. Write the evaluator (contract below). Run it on the current workspace and on a deliberately invalid fixture before delegating. Check that its raw JSON matches the plan you are about to write: every non-optional metric present and finite, every `selection_metrics` entry present and finite.
4. Write the plan to `<checkout>/.auto-research-methods/plan.json`.
5. Call `subagent_auto_research` with the checkout and a short request. One call runs one complete batch and returns paths.
6. Review the returned artifacts (below), then report to the user or plan the next batch.

Do not edit the original checkout while a batch runs, do not run two batches on one checkout, and never let a worker start a batch.

## Plan

```json
{
  "objective": "The user's exact objective and scope",
  "worker_prompt": "Task-specific instructions: constraints, how to run checks, where to save evidence",
  "evaluator": "/absolute/path/to/evaluator.mjs",
  "evaluation_seconds": 60,
  "direction": "maximize",
  "metrics": [
    { "name": "validity", "definition": "task-specific fixed definition" },
    { "name": "best_trial", "definition": "best valid trial so far", "optional": true }
  ],
  "selection_metrics": [{ "name": "validity", "direction": "maximize" }],
  "stall_seconds": 1200,
  "meaningful_gain": 0.01,
  "metric_subset": 1,
  "portfolio_size": 4,
  "scoring_authority": { "primary": "source and version of the rubric" },
  "options": { "rounds": 1, "branches": 4, "rsiTop": true, "forkAndFlush": true }
}
```

The values are schema examples, not defaults. Choose each from task evidence.

- `objective`, `worker_prompt`, `evaluator`, `evaluation_seconds` are required. `direction` defaults to `maximize`; use `minimize` for costs.
- `metrics`: fixed definitions the evaluator computes. A metric that only exists after a particular experiment is `"optional": true`; omit it from the evaluator output when unavailable. A missing observation is never zero.
- `selection_metrics`: declared metrics that rank candidates whose primary scores tie. They must be present and finite in every valid result.
- `meaningful_gain`: the smallest primary-score gain that counts as progress. It drives the RSI-top stall clock; it does not gate leader selection.
- With `rsiTop`: `stall_seconds`, `metric_subset` (1..number of metrics), `portfolio_size` (≥ 2) and a positive `meaningful_gain` are required.
- `options` overrides the installed configuration for this batch: `rounds`, `branches` (≥ 2), `explorationMinutes`, `exploitationMinutes`, `rsiTop`, `forkAndFlush`, `shareContext`, `sharingIntervalMinutes`, `workerProvider`, `workerModel`.
- `workspace`: for a large checkout, a relative subdirectory holding a compact, self-contained seed (source closure, data, evaluator inputs). It must resolve to a directory inside the checkout, must not contain `..`, and must not sit inside `.auto-research-methods`.

The plan is frozen for the batch. Revise metrics or the evaluator between batches, explicitly, never mid-batch.

## Evaluator contract

The runner copies the evaluator outside every candidate, hashes it, and runs it with the candidate workspace as the last argument (`.py` with `python3 -I -B`, `.js/.mjs/.cjs` with the current Node; override with `evaluator_interpreter`).

```text
{"valid": true, "score": 1.0, "metrics": {"validity": 1.0}, "evidence": ["relative/receipt.json"]}
```

- Print exactly one JSON object on stdout. An invalid candidate prints `"valid": false` with a `reason`.
- `score` and every metric are finite numbers; booleans are rejected.
- A valid result needs at least one `evidence` entry; an empty list fails the evaluation. Each entry is a relative path to a regular file that existed in the workspace before evaluation, or one the evaluator wrote under `.method-evaluation/`. Citing the evaluated source file is enough.
- Never modify the workspace. Disposable files go under the candidate's `.method-evaluation/` only. The runner compares the full inventory before and after.
- Check real correctness or feasibility. Do not trust scores the candidate reports about itself; replay them. Do not import editable candidate code as the checker.
- If no honest automatic evaluator is possible, explain the missing criterion and stop.

## Methods

Each round runs an explore phase (`branches` parallel fresh workers) followed by a continue phase (one worker on the selected leader), or only the continue phase.

- `forkAndFlush`: every round explores.
- `rsiTop`: a round explores when phase work since the last gain above `meaningful_gain` reaches `stall_seconds`. That stall time is carried across batches in `LATEST.json`, so RSI-top alone works with `rounds: 1`. Explore workers receive distinct randomized metric views and must write a portfolio of distinct hypotheses.
- `shareContext`: each phase runs cooperative epochs every `sharingIntervalMinutes` inside the same phase window. Workers publish checkpoints and review every peer before continuing.

Selection uses the frozen evaluator only: valid candidates and the incumbent are ranked by primary score, then `selection_metrics`, and a tied completed branch is preferred over the untouched baseline. Continuation between turns is a handoff note, not a resumed provider session.

## Review after a batch

Read the paths the tool returns:

- `RESULT.json`: status (`COMPLETED`, `STOPPED`, `FAILED`), `stop_reason`, `pending_workspaces`.
- `LEADER.json`, `SELECTIONS.json`: the selected candidate and every selection with candidate scores.
- `DASHBOARD.json`: all trajectories and `metric_diagnostics`. A metric constant across observed checkpoints gives no discrimination; say so instead of reading progress into it.
- Per branch: `LAUNCH.json`, `provider.jsonl`, `RESULT.json`, `RESEARCH_HANDOFF.md`, and with sharing `SHARED_CHECKPOINT.json`, `PEER-REVIEW.json`.

A batch boundary is not evidence that the objective is met or that a benchmark improved. Pending workspaces (timeouts, interrupted epochs) are unverified until independently checked. Report where the selected work lives. Nothing is merged, published or deleted automatically; do not do so without the user's authorization.

If the original checkout changed since the last batch, the next batch refuses to start. Reconcile the intended starting point with the user instead of overwriting either version.
