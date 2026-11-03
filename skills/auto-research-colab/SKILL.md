---
name: auto-research-colab
description: Run GPU work for an auto-research batch on the Google Colab queue server: worker pre-flight commands through $DSH_COLAB_CLI, and frozen evaluation with plan options.executor "colab".
---

# Auto research on Colab GPUs

A Colab GPU queue server runs one job at a time, so concurrent branches never share the GPU. Branch workspaces stay local; each job uploads a copy of the workspace and verifies its SHA-256 manifest.

## Workers: pre-flight GPU commands

From inside your branch checkout:

```bash
node "$DSH_COLAB_CLI" exec . -- python3 <script.py>
```

This copies the checkout into an isolated workspace on the Colab GPU and runs the command through the queue. Add `--timeout <seconds>` for long jobs and `--cold-l2-flush` before timing measurements. `node "$DSH_COLAB_CLI" health` reports the GPU and queue depth.

Uploads skip `.git`, `node_modules`, virtualenvs, caches and secret files, and are capped in size. Symlinks are not uploaded.

## Coordinator: evaluate on Colab

Set the executor in the plan:

```json
{ "options": { "executor": "colab" } }
```

The frozen evaluator then runs on the Colab GPU for every branch. The evaluator is uploaded with its hash; a result is rejected when the remote evaluator hash differs from the frozen copy or the evaluation changed the uploaded workspace. Leave `executor` unset (`auto`) to use Colab whenever a Colab endpoint is configured.

## Rules

- Never call the queue server directly (raw HTTP, SSH, background jobs). The queue is what keeps GPU timing and memory single-tenant.
- Measure on the GPU you will be evaluated on. A CPU fallback result is not evidence of a GPU speedup.
