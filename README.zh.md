# dsh-auto-research

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上以评估器打分的研究批次，分支放在 [LayerFS](https://github.com/layerfs) 上。

一次 `subagent_auto_research` 调用运行一个**批次**。每个研究状态都是一个 LayerFS 提交，由 plan 指定的评估器打分：

- **explore**：从 leader 的提交 fork 出若干新分支，每个分支起一个新 worker。
- **continue**：在 leader 的分支上续接 leader 自己的 worker 会话。
- **选择**：保留有效分数最好的状态。

目标、指标以及是否再跑一批，由协调者模型决定，插件不做判断。

## 包

本仓库是 pnpm workspace，每个包是一个 Cordis 插件：

| 包 | 路径 | 职责 |
| --- | --- | --- |
| `dsh-auto-research` | `packages/core/auto-research` | bundle 本身和 runner：注册 `auto-research` SubagentProvider 和 worker 的 `research_run` 工具，提供 `ctx.researchExecutor` 注册表和 `ctx.researchWorkers` |
| `dsh-auto-research-api` | `packages/core/api` | 插件之间的约定：`BranchRef`、`Workspace`、`ExecutorBackend`、工厂接口，以及提示词包共用的 skill 注册函数 |
| `dsh-auto-research-workspace-layerfs` | `packages/workspace/workspace-layerfs` | 所有 LayerFS 相关的代码：提供 `ctx.researchWorkspace`（fork 对话所绑定项目的分支、读取 head、在自己的 Sandbox 里对某个提交执行命令、把提交导出为 tarball），并把这个 Sandbox 登记为 `sandbox` 执行器，优先级 0 |
| `dsh-auto-research-coordinator` | `packages/skill/coordinator` | 只有提示词：协调者 skill `auto-research` |
| `dsh-auto-research-worker` | `packages/skill/worker` | 只有提示词：`worker.md`，通过 `ctx.systemPrompt.context` 只注入给正在运行的 worker（依据核心提供的 `ctx.researchWorkers`），其他会话看不到 |
| `dsh-auto-research-executor-colab` | `packages/executor/executor-colab` | 经已登录 Colab CLI 的 ssh 代理在 Google Colab GPU 上执行命令，附带 Colab 的 skill，配置后优先级 100 |

```bash
pnpm install
pnpm run build
```

## 安装

把 `packages/core/auto-research` 链接进 dsh profile，并在 bundles 里加入 `dsh-auto-research`。bundle 自带的 [`cordis.patch.yml`](packages/core/auto-research/cordis.patch.yml) 会插入五行：核心、LayerFS、协调者和 worker 的提示词、`subagent_auto_research` 工具。

要用 Colab，再插入 Colab 行并指定会话：

```yaml
- insert:
    - id: auto-research-executor-colab
      name: 'dsh-auto-research-executor-colab'
      config:
        sessions: [my-h100]   # 已用 `colab new -s my-h100 --gpu H100` 创建的会话
```

依赖：

- [dsh-layerfs](https://github.com/layerfs/dsh-layerfs)，且对话绑定了 LayerFS 项目。worker 通过它提供的 `layerfs` 命令操作分支。
- 会话持久化。continue 阶段新建一个 worker 会话，用 `ctx.sessionQuery` 读出 leader worker 的持久化记录作为种子。不需要改 dsh。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `providerName` | `auto-research` | provider 注册名 |
| `batchTool` | `subagent_auto_research` | 工具那一行的 `toolName`；worker 的 agent 创建时去掉这个工具 |
| `workerProvider` | `spawn` | worker 使用的 provider，必须支持可续接的进程内子 agent |
| `workerModel`、`workerLlmProvider`、`workerReasoningEffort`、`workerAgentOptions` | 与协调者相同 | worker 使用的模型；不指定 provider 时用协调者的 provider |
| `planPath` | `.auto-research-methods/plan.json` | plan 文件路径，相对于协调者所在目录 |
| `rounds` | `3` | 每个批次的轮数 |
| `branches` | `4` | 每轮 explore 的分支数 |
| `explorationMinutes` | `5` | explore 阶段每个 worker 的时长（分钟） |
| `exploitationMinutes` | `15` | continue 阶段的时长（分钟） |
| `forkAndFlush` | `true` | 每一轮都执行 explore |
| `rsiTop` | `false` | 只在停滞时执行 explore，并给 worker 随机指标视图、要求写假设组合 |
| `executor` | `auto` | 已登记的执行器（`sandbox`、`colab`）；`auto` 按优先级取第一个可用的 |

plan 的 `options` 可以覆盖以上任何一项。

## Plan

写在协调者目录下的 `.auto-research-methods/plan.json`：

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

- `base` 是第一个批次的起点，填一个 LayerFS ref。
- 之后的批次从 `LATEST.json` 记录的 leader 继续。
- 每个批次开始时都用本批的评估器和执行器重新给起点打分，所以换评估器或换 GPU 不需要特殊处理。

## 评估器约定

评估器是宿主机上的一个文件。runner 每个批次读取一次。对每个候选提交，执行器：

1. 取该提交的一份新副本，把评估器放到 `.auto-research/<name>`；
2. 在分支根目录执行 `<interpreter> .auto-research/<name> .`；
3. 执行结束后丢弃这份副本。

解释器按扩展名选择：`.py` 用 `python3 -B`，`.js`/`.mjs` 用 `node`，`.sh` 用 `bash`；也可以用 `evaluator_interpreter` 指定。

stdout 的最后一行是结果：`{"valid": true, "score": <数字>, "metrics": {…}}`。无效候选输出 `"valid": false` 并附 `reason`。

worker 改不到评估器：评估器在所有分支之外，每个 worker 只能写自己的分支。

## 批次流程

```
AutoResearchProvider.start
 ① 校验 plan，读取评估器，确定 worker provider 和模型
 ② workspace = researchWorkspace.select()，executor = researchExecutor.select()
 ③ 基线：用本批的评估器和执行器重新评估 LATEST.json 中的 leader（没有时 fork plan.base）
 ④ 每一轮
    ├ explore：从 leader 的提交 fork 出 branches 个分支；startActivation(spawn, cwd = 草稿目录)
    │          到时 interrupt；评估各分支 head；选择
    ├ continue：在 leader 的分支上 startActivation(auto-research-continue，种子 = leader worker 已完成的回合)；
    │          到时 interrupt；评估；选择
    └ 停滞计时：增益超过 meaningful_gain 时清零
 ⑤ 写 DASHBOARD.json、LEADER.json、RESULT.json、LATEST.json
```

- worker 的 cwd 是宿主机上的草稿目录 `runs/<run>/<branch>/scratch`，里面放 `BRANCH.json`、worker 的笔记，RSI-top 分支还有 `PORTFOLIO.json`。
- 项目本身是 worker 的 LayerFS 分支，worker 用 `layerfs` 命令修改它。
- worker 在自己的回合里想在评估硬件上试跑（例如在 Colab GPU 上测 kernel），先提交，再调用 `research_run` 工具（`{ command, timeout_seconds }`）。命令会在分支 head 上通过本批次的执行器运行，和评估排在同一个队列里。
- `research_run` 注册时带 `when` 条件：只有本批次正在运行的 worker 会话能看到它，协调者和其他会话看不到。
- worker 的 agent 创建时就拿掉了 `subagent_auto_research` 工具，worker 无法启动批次。
- 每次调用都会记录到该分支目录的 `research-runs.jsonl`。

## 产物

`.auto-research-methods/runs/<run>/` 下：

- `PLAN.json`
- `DASHBOARD.json`：全部轨迹、每次选择、指标诊断。
- `LEADER.json`、`RESULT.json`
- 每个分支一个目录，含：
  - `RESULT.json`：分支、提交、会话、评估结果；
  - `worker-output.md`、`evaluation.log`；
  - `scratch/`。

`.auto-research-methods/LATEST.json` 记录 leader 和 RSI-top 的停滞计时，供下一个批次使用。插件不会合并或发布任何内容。

## 限制

- worker 必须是进程内的 dsh agent（`spawn`）；外部 provider 的会话不能续接。
- worker 如果在命令执行到一半时被中断，可能留下一个未卸载的 LayerFS Workspace，它所在的 Sandbox 会一直运行到该 Workspace 被卸载。
- Colab 执行器使用的 `exportTree` 导出时会排除 `.git`。
