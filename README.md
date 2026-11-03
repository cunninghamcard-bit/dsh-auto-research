# dsh-auto-research

Evidence-scored research batches for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), on [LayerFS](https://github.com/layerfs) branches.

One `subagent_auto_research` call runs one **batch**. Every research state is a LayerFS commit, and the plan's evaluator scores each one.

- **Explore** forks the leader's commit into new branches, each with a fresh worker.
- **Continue** resumes the leader's own worker session on the leader's branch.
- **Selection** keeps the best valid score.

The coordinator model, not this plugin, owns the objective, the metrics and the decision to run another batch.

## Packages

This repository is a pnpm workspace. Each package is one Cordis plugin:

| Package | Path | Role |
| --- | --- | --- |
| `dsh-auto-research` | `packages/core/auto-research` | The bundle and the runner. Registers the `auto-research` SubagentProvider and the workers' `research_run` tool, and provides the `ctx.researchExecutor` registry and `ctx.researchWorkers`. |
| `dsh-auto-research-api` | `packages/core/api` | The contract: `BranchRef`, `Workspace`, `ExecutorBackend`, factories, and the skill registration the prompt packages share. |
| `dsh-auto-research-workspace-layerfs` | `packages/workspace/workspace-layerfs` | Everything LayerFS. Provides `ctx.researchWorkspace` (forks branches of the conversation's project, reads heads, runs a command on a commit in its own Sandbox, exports a commit as a tarball) and registers that Sandbox as the `sandbox` executor, priority 0. |
| `dsh-auto-research-coordinator` | `packages/skill/coordinator` | Prompts only: the `auto-research` coordinator skill. |
| `dsh-auto-research-worker` | `packages/skill/worker` | Prompts only: `worker.md`, injected with `ctx.systemPrompt.context` into the prompt of every running worker (the core's `ctx.researchWorkers`) and of no other session. |
| `dsh-auto-research-executor-colab` | `packages/executor/executor-colab` | Runs commands on a Google Colab GPU over ssh through the signed-in Colab CLI's proxy, with its skill. Priority 100 when configured. |

```bash
pnpm install
pnpm run build
```

## Install

Link `packages/core/auto-research` into a dsh profile and list `dsh-auto-research` in its bundles. The bundle's [`cordis.patch.yml`](packages/core/auto-research/cordis.patch.yml) inserts five rows: the core, LayerFS, the coordinator and worker prompts, and the `subagent_auto_research` tool. To use Colab, insert the Colab row with sessions:

```yaml
- insert:
    - id: auto-research-executor-colab
      name: 'dsh-auto-research-executor-colab'
      config:
        sessions: [my-h100]   # running `colab new -s my-h100 --gpu H100` sessions
```

Requirements:

- [dsh-layerfs](https://github.com/layerfs/dsh-layerfs) with the conversation bound to a LayerFS project. Workers use its `layerfs` command.
- A dsh with `ctx.subagents.continueActivation` (deepseek-harness `feat/subagent-continue-activation`).
- Session persistence. Continue cold-resumes the worker session.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `providerName` | `auto-research` | Registry name of the provider |
| `workerProvider` | `spawn` | Worker provider; it must support continuable (in-process) children |
| `workerModel`, `workerLlmProvider`, `workerReasoningEffort`, `workerAgentOptions` | the coordinator's | Worker LLM; without a provider, the coordinator's provider |
| `planPath` | `.auto-research-methods/plan.json` | Plan file, relative to the coordinator's folder |
| `rounds` | `3` | Rounds per batch |
| `branches` | `4` | Explore branches per round |
| `explorationMinutes` | `5` | Explore turn length |
| `exploitationMinutes` | `15` | Continue turn length |
| `forkAndFlush` | `true` | Explore every round |
| `rsiTop` | `false` | Explore when stalled, with randomized metric views and portfolios |
| `executor` | `auto` | A registered executor (`sandbox`, `colab`); `auto` takes the first available by priority |

A plan overrides any of these in `options`.

## Plan

`.auto-research-methods/plan.json` in the coordinator's folder:

```json
{
  "objective": "…",
  "worker_prompt": "…",
  "base": "main",
  "evaluator": "/abs/path/evaluate.py",
  "evaluation_seconds": 120,
  "direction": "maximize",
  "metrics": [{ "name": "speedup" }],
  "meaningful_gain": 0.01,
  "options": { "rounds": 3, "branches": 4 }
}
```

`base` is the LayerFS ref the first batch starts from. Later batches start from the leader in `LATEST.json`. Every batch first scores its starting commit again with its own evaluator and executor, so a changed evaluator or GPU needs no special handling.

## Evaluator contract

The evaluator is a file on the host. The runner reads it once per batch. For each candidate commit, the executor:

1. places the evaluator at `.auto-research/<name>` in a fresh copy of the commit;
2. runs `<interpreter> .auto-research/<name> .` from the branch root;
3. discards the copy.

The interpreter is `python3 -B` for `.py`, `node` for `.js`/`.mjs`, `bash` for `.sh`, or `evaluator_interpreter`.

The last line of stdout is the result: `{"valid": true, "score": <number>, "metrics": {…}}`. An invalid candidate prints `"valid": false` with a `reason`.

Workers cannot change the evaluator. It lives outside every branch, and each worker writes only its own branch.

## Batch

```
AutoResearchProvider.start
 ① validate the plan, read the evaluator, pick the worker provider and model
 ② workspace = researchWorkspace.select(), executor = researchExecutor.select()
 ③ baseline: score the LATEST.json leader (or a fork of plan.base) again with this batch's evaluator and executor
 ④ each round
    ├ explore: fork the leader's commit into `branches` branches; startActivation(spawn, cwd = a scratch folder)
    │          interrupt at the deadline; evaluate each branch head; choose
    ├ continue: continueActivation(leader session) on the leader's branch; interrupt at the deadline; evaluate; choose
    └ stall clock: reset on a gain above meaningful_gain
 ⑤ write DASHBOARD.json, LEADER.json, RESULT.json, LATEST.json
```

A worker's cwd is a scratch folder on the host, `runs/<run>/<branch>/scratch`. It holds `BRANCH.json`, the worker's notes and, on RSI-top branches, `PORTFOLIO.json`. The project itself is the worker's LayerFS branch, which it changes with the `layerfs` command.

To try something on the evaluation hardware during its turn, for example a kernel on the Colab GPU, a worker commits and calls the `research_run` tool (`{ command, timeout_seconds }`). The command runs on the branch head through the batch executor, in the same queue as evaluations. The tool is registered with a `when` condition, so only a running worker session of a batch sees it; the coordinator and other sessions do not. Workers' agents are created without the `subagent_auto_research` tool, so a worker cannot start a batch. Every request is logged in the branch's `research-runs.jsonl`.

## Artifacts

Under `.auto-research-methods/runs/<run>/`:

- `PLAN.json`
- `DASHBOARD.json`: every trajectory, every selection, and the metric diagnostics.
- `LEADER.json`, `RESULT.json`
- Per branch: `RESULT.json` (branch, commit, session, evaluation), `worker-output.md`, `evaluation.log`, `scratch/`.

`.auto-research-methods/LATEST.json` holds the leader and the RSI-top stall clock for the next batch. Nothing is merged or published.

## Limitations

- Workers must be in-process dsh agents (`spawn`). External providers cannot continue a session.
- A worker interrupted mid-command may leave a LayerFS Workspace mounted. Its Sandbox stays up until that Workspace is unmounted.
- `exportTree` (used by the Colab executor) excludes `.git`.
