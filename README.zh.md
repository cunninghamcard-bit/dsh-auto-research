# 自动研究（dsh-auto-research）

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供以证据评分的研究批次，注册为名为 `auto-research` 的 `SubagentProvider`。

一次激活运行一个**批次**：冻结评估器、评估基线、用**分叉-刷新（fork-and-flush）**和/或 **RSI-top** 运行隔离的研究分支；可选地在协作 cohort 之间共享检查点；按独立评估分数选择 leader；并写入完整的凭据链。科学目标、指标与“是否继续”的判断属于协调模型，而不属于本插件。

技术栈：Node.js ESM、Cordis 插件、`ctx.subagents`，可选 [LayerFS](https://github.com/layerfs) 写时复制分支。无运行时依赖。

## 新增内容

| Cordis 行 | 作用 |
| --- | --- |
| `subagent-auto-research` | 注册 `auto-research` provider 与协调者提示词段落 |
| `tool-subagent-auto-research` | 通过 `@deepseek-ai/dsh-tool-subagent` 暴露 `subagent_auto_research`，深度由 provider 管理 |

协调者会收到研究策略、方法策略与继续策略组成的系统提示词段落。它检查仓库、编写计划、委派一个批次，然后审阅 `RESULT.json`、`DASHBOARD.json`、`LEADER.json`、`SELECTIONS.json` 以及协作证据，再决定是否运行下一批。

## 安装

把该 bundle 加入 DSH profile（插件管理器会读取 `dsh.bundle.patch`），或手动把 [`cordis.patch.yml`](cordis.patch.yml) 中的两行插入 profile patch。provider 需要至少一个其他已注册的 `ctx.subagents` provider 来执行 worker（`claude-code`、`codex`、`acp`、`dsh-sdk`、`spawn` 等）。存在多个候选时请显式设置 `workerProvider`。

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

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `providerName` | `auto-research` | provider 注册名 |
| `workerProvider` | 第一个其他 provider | 执行分支 worker 的 `ctx.subagents` provider |
| `planPath` | `.auto-research-methods/plan.json` | 从委派 checkout 读取的计划文件 |
| `rounds` | `1` | 单批次轮数（上限，不是完成声明） |
| `branches` | `4` | 并行探索分支数 |
| `explorationMinutes` | `30` | 每阶段探索窗口 |
| `exploitationMinutes` | `30` | 每阶段继续窗口 |
| `rsiTop` | `false` | 启用随机指标子集视图与 portfolio |
| `forkAndFlush` | `false` | 每轮强制启动新的探索 cohort |
| `shareContext` | `false` | 启用协作检查点与 peer review |
| `sharingIntervalMinutes` | `10` | 阶段窗口内的检查点节奏 |
| `layerfs` | 自动 | 显式 LayerFS 设置；`false` 强制使用快照后端 |
| `workerEnv` | `{}` | 展示给 worker 的非机密环境事实 |

计划可以包含 `options` 对象，按批次覆盖上述值。科学取值由模型决定；插件只拒绝不可能的组合（例如指标子集大于已声明指标集）。

## 计划

协调者把计划写在候选源码之外。provider 也接受委派提示词中的 fenced JSON 块或 `PLAN_JSON:` 行。

```json
{
  "objective": "用户的确切目标与范围",
  "worker_prompt": "任务特定说明、约束、如何运行检查、如何保存证据",
  "evaluator": "/absolute/path/to/evaluator.mjs",
  "evaluation_seconds": 60,
  "direction": "maximize",
  "metrics": [
    { "name": "validity", "definition": "任务特定的固定定义" },
    { "name": "best_trial", "definition": "最佳有效试验", "optional": true }
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

- `selection_metrics` 必须同时声明在 `metrics` 中且为有限值；只在主分数并列时用于排序。
- 可选指标可以缺失；缺失的观测不会被当成 0。
- 启用 `rsiTop` 时必须给出 `stall_seconds`、`metric_subset` 和 `portfolio_size`。
- `workspace` 可以指定 checkout 内的紧凑种子子目录；必须是相对路径、无符号链接，且不在 `.auto-research-methods` 内。

## 评估器契约

评估器会被复制到候选工作区之外、计算哈希，并以候选工作区作为最后一个参数执行：

```text
<stdout> {"valid": true, "score": 1.0, "metrics": {"validity": 1.0}, "evidence": ["relative/receipt.json"]}
```

- stdout 只输出一个 JSON 对象；无效候选输出 `valid: false`。
- `score` 必须有限；布尔值与非有限哨兵会被拒绝。
- `evidence` 的每一项都必须是被评估工作区内包含的普通文件。
- 脚本不得修改工作区；运行器会比较评估前后的完整清单。
- 每次评估前后都会校验冻结副本的 SHA-256。
- `.py` 使用 `python3 -I -B`；`.js/.mjs/.cjs` 使用当前 Node 可执行文件。可用 `evaluator_interpreter` 覆盖。

## 批次生命周期

1. 冻结评估器并写入 `PLAN.json` / `CONFIG.json`。
2. 快照（或建立 LayerFS 基线）起始工作区并评估。基线无效时，在任何 worker 启动前停止。
3. 每轮判断 `stalled`（`now - bestTime >= stall_seconds`）与 `explore = forkAndFlush || (rsiTop && stalled)`。
4. 探索阶段运行 `branches` 个并行 worker；继续阶段运行一个。每个分支获得隔离 fork/mount、Worker Prompt、预算预留；RSI-top 下还会获得不同的随机指标视图与 portfolio 协议。
5. 用冻结评估器评估完成的分支，校验 `PORTFOLIO.json`，选择 leader。
6. 运行继续阶段，或写出 `RESULT.json` 结束。

启用 `shareContext` 时，每个阶段在总窗口内运行协作 epoch。每个 epoch 发布 `PEER-EVIDENCE.json` 与 `shared-context.md`；分支写 `SHARED_CHECKPOINT.json`（显式文本证据白名单），恢复 epoch 还要写 `PEER-REVIEW.json`，且必须恰好覆盖每个 peer 一次。验证通过的完成状态会按内容寻址保存；若后续 epoch 失败，会恢复到独立的 `<branch>-last-completed/` 目录。

## 产物

所有内容位于 `<checkout>/.auto-research-methods/runs/<run-id>/`：

| 文件 | 用途 |
| --- | --- |
| `PLAN.json`、`CONFIG.json` | 冻结输入 |
| `evaluator.*` | 冻结评估器副本 |
| `initial/` | 基线工作区、清单、评估 |
| `round-N-<phase>-<n>/` | 分支工作区、`INPUT-MANIFEST.json`、`LAUNCH.json`、`BUDGET.json`、`RESULT.json`、评估日志 |
| `round-N-<phase>-epoch-N-branch-M/` | 协作 epoch 分支产物 |
| `round-N-<phase>-COLLABORATION.json` | epoch 历史、peer bundle 路径、保留的检查点 |
| `PEER-EVIDENCE.json` | 不可变的 peer 观测发布 |
| `shared-context.md` | 逐字研究检查点与 `RESEARCH_CONTEXT/` 主题索引 |
| `checkpoint-objects/` | 内容寻址的完成文件 |
| `DASHBOARD.json` | 所有轨迹与指标诊断 |
| `SELECTIONS.json` | 每轮选择凭据 |
| `LEADER.json` | 选中的候选 |
| `RESULT.json` | 批次边界结果 |

`<checkout>/.auto-research-methods/LATEST.json` 记录选中的工作区与原始清单。下一批只在原始工作区仍匹配时从该 leader 开始；否则停止并要求协调者先对齐起点。

## LayerFS 集成

存在 `DSH_LAYERFS_PROJECT` 与 `DSH_LAYERFS_SDK`（或 `config.layerfs` 提供）时，分支使用 `branch.fork`、`workspace.mount`、`workspace.commit` 与 `workspace.unmount`。验证通过的状态会提交；被拒绝或不完整的状态以 `discard: true` 卸载。没有绑定项目时，使用全量拷贝快照后端与内容寻址检查点对象。

provider 读取 `DSH_LAYERFS_PROJECT`、`DSH_LAYERFS_SDK`、`DSH_LAYERFS_OPERATOR`、`DSH_LAYERFS_STORE_PATH`、`DSH_LAYERFS_HOME`。显式 `config.layerfs` 优先于环境变量。

## 安全

- 用户原始 checkout 永远不会被评估或修改；分支是拷贝或 CoW 挂载。
- 共享检查点拒绝符号链接、路径穿越、点文件（`.method-evaluation` 除外）、私有凭据文件名以及疑似凭据内容。
- Worker 提示词禁止递归派生与发布/合并。
- 序列化前会清理配置；疑似机密的环境变量键不会写入。
- 不会自动合并、重置、覆盖、删除或发布。
- 批次边界不能证明用户目标已完成，也不能证明存在基准提升。

## 测试

```bash
npm test
```

`node:test` 测试覆盖协议（指标视图、portfolio、检查点、peer review、综合上下文）、评估器冻结与完整性、两种工作区后端与完成状态恢复、完整运行器批次（分叉-刷新、RSI 停滞、协作、失败/超时区分）、provider/插件生命周期、取消与包元数据。

## 限制

- worker 的 provider session 会被记录，但通用 `startActivation` 接口无法恢复会话；每个 worker 轮次都收到全新提示词。
- 假定 LayerFS 挂载暴露主机可访问的工作区路径。
- 协作 epoch 复用分支工作区，要求 worker 在共享窗口内完成；硬性阶段截止时间仍然生效。
- 评估器必须是本地可执行脚本；除已接受的工作区与清单检查外没有额外沙箱。
