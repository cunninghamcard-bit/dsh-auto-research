---
name: auto-research-colab
description: Evaluate auto-research candidates on a Google Colab GPU: plan options.executor "colab".
---

# Auto research on Colab GPUs

With `"options": { "executor": "colab" }` in the plan, every candidate commit is evaluated on a Colab GPU instead of a LayerFS Sandbox. Leave `executor` as `auto` to use Colab whenever the executor is configured with sessions.

How a request runs:

1. The candidate commit is exported from LayerFS as a tarball and uploaded to the session.
2. On the Colab VM it is extracted into its own directory, with the evaluator at `.auto-research/<name>`.
3. The evaluator runs as a new process group from that directory, and is killed at `evaluation_seconds`.
4. The directory is removed. One request runs at a time per session; others wait in the executor's queue.

Write the evaluator for the Colab VM: it runs with the VM's `python3`, its CUDA and the packages installed there. Install what it needs inside the evaluator or once in the session beforehand.

Sessions cost compute units. The executor uses only the sessions named in its configuration unless `createSessions` is set; ask the user before a batch that would create or keep sessions running.

A score measured on one GPU is not comparable with one from another: the batch frontier is keyed by evaluator and executor, so switching executor starts over from `base`.
