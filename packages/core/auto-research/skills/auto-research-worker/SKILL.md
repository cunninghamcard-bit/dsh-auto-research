---
name: auto-research-worker
description: Instructions for an auto-research branch worker. Load when your prompt says you are working on an auto-research branch; read before starting any experiment.
user-invocable: false
---

# Auto research (branch worker)

You run experiments on one LayerFS branch of a research batch. A coordinator owns the plan and the evaluator. After your turn the runner reads your branch's newest commit and scores it with the evaluator. Only committed work is scored.

## Start

1. Read `BRANCH.json` in your current directory (fields below).
2. If this is a continued session (a message tells you your branch was selected as the leader), keep working from where you left off on the same branch.
3. Read your notes in the current directory if you left any.

## Where things are

- **The project** is your LayerFS branch, `layerfs_branch` in project `layerfs_project`. Read and change it with the `layerfs` command or the SDK, as the LayerFS instructions in your system prompt describe: mount a Workspace in your own Sandbox, run commands there, commit, unmount.
- **Your current directory** is a scratch folder on the host for notes, scripts and logs. It is not part of the project and is not evaluated.

## Running on the evaluation hardware

Your own Sandbox has no GPU. To run a command where the evaluator runs (a Colab GPU when the batch uses one, else a LayerFS Sandbox), commit first, then:

```bash
node "$DSH_AUTO_RESEARCH_RUN" --timeout 600 -- python3 bench.py --size 4096
```

It runs the command from the root of your branch's newest commit, in a fresh copy, and prints its stdout and stderr; the exit code is the command's (124 on timeout). Only committed files are there; nothing it writes is kept. Your runs wait in one queue with every other branch's runs and evaluations, so keep them short and purposeful. The first stderr line names the environment and commit.

## Rules

- Change only your own branch. Never fork, merge into or publish to another branch or `main`.
- Commit after every step that changes files, with a message naming the step and its result. Before your time runs out, make sure your best state is the branch head.
- Unmount every Workspace before you end your turn.
- Never call `subagent_auto_research` and never start other batches.
- Do not modify the evaluator or weaken any check to make a candidate pass. Do not fabricate results or passing checks.
- End your turn before `deadline_unix`. Do not start a command likely to overrun it. When the time is up the turn is interrupted; what you committed is still scored.
- Keep `NOTES.md` in your current directory current: results, failed approaches with the reason, and the next step. A continued session reads it again.

## BRANCH.json

| Field | Meaning |
|---|---|
| `branch_id`, `phase` | This branch's id, and `explore` or `continue` |
| `layerfs_project`, `layerfs_branch` | Where you work |
| `start_commit` | The commit your turn started from |
| `deadline_unix`, `seconds` | When your turn ends, and its length |
| `rsi_top` | `{ portfolio_size, metric_view }` on RSI-top explore branches, else `null` |

## RSI-top explore branches (`rsi_top` set)

1. Use `metric_view` first: it is a deliberately partial dashboard (`definitions`, `diagnostics`, `rows`). Each row's `workspace` is a branch name you may read.
2. Before experimenting, write `PORTFOLIO.json` in your current directory: a JSON array of exactly `portfolio_size` objects, each with non-empty strings `bottleneck`, `mechanism`, `expected_effect`, `lineage`, and a number `verbalized_probability` in [0, 1]. The bottleneck/mechanism/effect triples must be distinct. The probabilities are proposal weights and need not sum to one.
3. Test the feasible directions within your time. Never report untested proposals as completed experiments.

A missing or malformed portfolio rejects the branch.
