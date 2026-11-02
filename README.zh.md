# 自动研究（dsh-auto-research）

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供以证据评分的研究批次，注册为名为 `auto-research` 的 `SubagentProvider`。

一次激活运行一个**批次**：冻结评估器、评估基线、用**分叉-刷新（fork-and-flush）**和/或 **RSI-top** 运行隔离的研究分支；可选地在协作 cohort 之间共享检查点；按独立评估分数选择 leader；并写入完整的凭据链。科学目标、指标与“是否继续”的判断属于协调模型，而不属于本插件。

技术栈：Node.js ESM、Cordis 插件、`ctx.subagents`，可选 [LayerFS](https://github.com/layerfs) 写时复制分支。无运行时依赖。

## 新增内容

| Cordis 行 | 作用 |
| --- | --- |
| `subagent-auto-research` | 提供 `ctx.researchWorkspace` 与 `ctx.researchExecutor`，注册 `auto-research` provider 与 `auto-research` / `auto-research-worker` 两个 skill |
| `auto-research-layerfs` | 在 `ctx.researchWorkspace` 注册 LayerFS 写时复制分支（优先级 100） |
| `auto-research-snapshot` | 在 `ctx.researchWorkspace` 注册全量复制快照分支（优先级 0，回退） |
| `auto-research-local` | 在本机运行冻结评估器，存在 `ctx.subprocess` 时经由它（`ctx.researchExecutor`，优先级 0） |
| `tool-subagent-auto-research` | 通过 `@deepseek-ai/dsh-tool-subagent` 暴露 `subagent_auto_research`，深度由 provider 管理 |

协调者加载 `auto-research` skill。它检查仓库、编写计划、委派一个批次，然后审阅 `RESULT.json`、`DASHBOARD.json`、`LEADER.json`、`SELECTIONS.json` 以及协作证据，再决定是否运行下一批。


## Skills

所有面向模型的指令都以 skill 形式放在 [`skills/`](skills)，插件不注入任何系统提示词。插件把两个 skill 注册到 `skills` 服务（`@deepseek-ai/dsh-skill`），profile 必须加载该服务：

| Skill | 在哪些 cwd 列出 | 内容 |
| --- | --- | --- |
| `auto-research` | 分支 checkout 之外的所有 cwd | 协调者流程、plan 结构、evaluator 契约、审阅 |
| `auto-research-worker` | 存活分支 checkout 内的 cwd（用户不可调用） | 分支规则、`BRANCH.json` 字段、RSI-top portfolio、协作 epoch |
| `auto-research-colab` | 加载 `dsh-auto-research/colab` 时的所有 cwd | 用 `$DSH_COLAB_CLI` 做 GPU 预检、`options.executor: "colab"` |

worker 的提示词由 plan 的 `worker_prompt`、目标、checkout 路径，以及指向 worker skill 和 `.auto-research-methods/BRANCH.json` 的说明组成。启动前 runner 在 checkout 中写入：

- `.auto-research-methods/BRANCH.json`：run 与分支 id、阶段、父分支、LayerFS 分支、截止时间、provider 秒数、`handoff`、`rsi_top`（portfolio 大小与完整指标视图）、`cooperation`（同伴证据、共享上下文）、环境变量名。
- `.auto-research-methods/WORKER.json`：标识 worker checkout 的标记。
- 分支续接父分支时的 `.auto-research-methods/HANDOFF.md`。
- `.claude/skills/auto-research-worker/SKILL.md` 与 `.agents/skills/auto-research-worker/SKILL.md`，供外部 CLI worker（`claude-code`、`codex`）从 checkout 中发现 worker skill。

这些文件在 activation 结束时、评估与提交之前全部删除；`.agents` 不计入 inventory。

## 安装

把该 bundle 加入 DSH profile（插件管理器会读取 `dsh.bundle.patch`），或手动把 [`cordis.patch.yml`](cordis.patch.yml) 中的各行插入 profile patch。下面的代码块与该文件逐字一致；配置表列的是代码默认值，profile 中的配置会覆盖它们。插件注入 `skills` 服务，profile 必须加载 `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-tool-skill`（DSH base bundle 已包含）。provider 需要至少一个其他已注册的 `ctx.subagents` provider 来执行 worker（`claude-code`、`codex`、`acp`、`dsh-sdk`、`spawn` 等）。存在多个候选时请显式设置 `workerProvider`。

```yaml
- insert:
    - id: subagent-auto-research
      name: 'dsh-auto-research'
      config:
        providerName: auto-research
        rounds: 1
        branches: 4
        explorationMinutes: 30
        exploitationMinutes: 30
        rsiTop: true
        forkAndFlush: true
        shareContext: false
        sharingIntervalMinutes: 10

    - id: auto-research-layerfs
      name: 'dsh-auto-research/layerfs'

    - id: auto-research-snapshot
      name: 'dsh-auto-research/snapshot'

    - id: auto-research-local
      name: 'dsh-auto-research/local'

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
| `executor` | `auto` | 运行冻结评估器的已注册执行后端（`local`、`colab` 或第三方）；`auto` 按优先级取第一个可用的。计划可在 `options.executor` 覆盖 |
| `workspaceBackend` | `auto` | 已注册的后端名称（`layerfs`、`snapshot` 或第三方后端）；`auto` 按优先级取第一个可用的。计划可在 `options.workspaceBackend` 覆盖 |
| `layerfs` | 自动 | 显式 LayerFS 设置；`false` 使 `layerfs` 后端拒绝本批次 |
| `workerEnv` | `{}` | 按配置原样传给 worker 的环境变量（`DSH_*` 名同时经 `ctx.shellEnv` 提供）；`CONFIG.json` 省略疑似机密的键 |

计划可以包含 `options` 对象，按批次覆盖上述值。科学取值由模型决定；插件只拒绝不可能的组合（例如指标子集大于已声明指标集）。

## 计划

协调者把计划写在候选源码之外的 `planPath`（默认 `.auto-research-methods/plan.json`），或由 profile 在配置中设置 `plan`。只有这两个来源。单批覆盖写在 `plan.options` 下，字段名与配置相同（`workerProvider`、`workerModel`、`branches` 等）。

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
- `workspace` 可以指定 checkout 内的紧凑种子子目录；必须是相对路径，解析后严格位于 checkout 内，且不在 `.auto-research-methods` 内。

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
3. 每轮判断 `stalled`（`stalled_work_seconds >= stall_seconds`）与 `explore = forkAndFlush || (rsiTop && stalled)`。`stalled_work_seconds` 只累计上次超过 `meaningful_gain` 的提升之后的阶段工作时间，通过 `LATEST.json` 的 `frontier` 跨批次保存，因此单开 RSI-top 在 `rounds: 1` 时也会探索。评估器哈希不同的 frontier 会被丢弃。
4. 探索阶段运行 `branches` 个并行 worker；继续阶段运行一个。每个分支获得隔离 fork/mount、Worker Prompt、预算预留；RSI-top 下还会获得不同的随机指标视图与 portfolio 协议。
5. 用冻结评估器评估完成的分支，校验 `PORTFOLIO.json`，选择 leader：主分数（按计划的 `direction`）只要更好就替换 leader，提升再小也替换。主分数相同时依次比较 `selection_metrics`，再优先非基线分支，再取最新的分支。`meaningful_gain` 不参与选择，只用于重置停滞计时。评估器分数有噪声时，应由评估器自己多次试验取平均。
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

`<checkout>/.auto-research-methods/LATEST.json` 记录选中的工作区、其 LayerFS 分支、原始清单，以及停滞状态 `frontier`（`evaluator_sha256`、`anchor_score`、`stalled_work_seconds`）。下一批只在原始工作区仍匹配时从该 leader 开始；否则停止并要求协调者先对齐起点。使用 LayerFS 时，若之前的挂载路径已不可用，会重新挂载保存的分支。

## LayerFS 集成

存在 `DSH_LAYERFS_PROJECT` 与 `DSH_LAYERFS_SDK`（或 `config.layerfs` 提供）时，分支使用 `branch.fork`、`workspace.mount`、`workspace.commit` 与 `workspace.unmount`。`Busy` 拒绝会以指数退避重试；分支名保持在 63 字符以内；被采用的分支名会先校验。验证通过的状态会提交，并以其 LayerFS 分支作为检查点；已完成的科学拒绝分支会以 `rejected` 提交并以 `discard: false` 卸载，保留在 LayerFS 历史中；provider 失败与超时的工作会作为未验证状态提交并保留以供审阅。没有绑定项目时 `layerfs` 工厂返回 null，`auto` 选择落到 `snapshot` 后端（全量拷贝与内容寻址检查点对象）。核心自身不注册任何后端：没有可用后端时批次失败，错误信息列出已注册的后端。第三方后端从 `dsh-auto-research/api` 引入类型与共享工具，inject `researchWorkspace`，并调用 `ctx.researchWorkspace.register({ name, priority, create })`。

真实 LayerFS 挂载返回 Sandbox 内部路径（如 `/workspaces/1`）。当该路径在宿主上不可访问时，后端在 `<run>/<branch>/workspace` 暂存宿主副本，并在该副本上执行评估与 worker，同时在提交时用 `client.fs.apply`（或 `fs.write`/`fs.rm`）发布新增/修改/删除的文件，再调用 `workspace.commit`。冻结基线后会重新挂载分支，使 Sandbox 内的 `/workspaces/<n>` 与宿主暂存副本一致；worker 轮次结束后会把已提交的 Sandbox 覆盖层同步回宿主副本再评估。`fs.read` 无法表示的二进制文件通过 `workspace.exec` + `base64` 原样复制，无法复制时标记为跳过且绝不会被误删。worker 还会收到 `DSH_AUTO_RESEARCH_BRANCH` 与 `DSH_AUTO_RESEARCH_SANDBOX_PATH`。

宿主暂存副本是唯一写入方，Sandbox 挂载只用于执行。worker 返回后，`reconcile` 先把 Sandbox overlay 的改动提交进分支历史，再把两边与暂存副本的初始清单比较：只有 Sandbox 改动时合并回宿主副本；只有宿主改动时由提交发布；两边都改动时分支判为无效（`workspace conflict: host and sandbox both modified: <路径>`），不评估，并以 `rejected` 提交，两边的改动都留在分支历史中。

每个 cohort 开始前由后端估算分支新增的字节数：snapshot 后端与暂存的 LayerFS 挂载按全量宿主副本计算，宿主可直接访问的 LayerFS 挂载（写时复制）计为 0。只有估算值超过可用空间时才拒绝。

符号链接在清单中记为 `symlink:<链接文本>`，不跟随。snapshot 复制时原样重建；已完成状态的检查点记在 `links` 中；暂存的 LayerFS 分支只在宿主副本保留链接（SDK 不能写入链接），并列入 `skippedFiles`。

provider 从 `config.layerfs`、`process.env` 与会话的 `ctx.shellEnv` contributor 解析 `DSH_LAYERFS_PROJECT`、`DSH_LAYERFS_SDK`、`DSH_LAYERFS_OPERATOR`、`DSH_LAYERFS_CLI`、`DSH_LAYERFS_SKILL`、`DSH_LAYERFS_HOME`、`DSH_LAYERFS_STORE_PATH`、`DSH_LAYERFS_DOCKER`、`DSH_LAYERFS_IMAGE`、`DSH_LAYERFS_VOLUME`、`DSH_LAYERFS_DAEMON`、`DSH_LAYERFS_CONTAINER_PREFIX`、`DSH_LAYERFS_DAEMON_HOST`、`DSH_LAYERFS_STORE_CONTAINER`、`DSH_LAYERFS_BUNDLE`、`DSH_LAYERFS_WSL_ENDPOINT`、`DSH_LAYERFS_TRACE`、`DSH_LAYERFS_TRACE_STEP` 与 `DSH_LAYERFS_TRACE_START`。显式 `config.layerfs` 优先；宿主注入的 `layerfs.client` 从不由本插件关闭。

## Colab GPU 评估

默认 patch 不含 `dsh-auto-research/colab`，需要连同 endpoint 自行插入：

```yaml
- insert:
    - id: auto-research-colab
      name: 'dsh-auto-research/colab'
      config:
        connectionFile: ~/.config/dsh-colab/connection.json
```

`node lib/colab/cli.js bootstrap` 输出启动队列服务（`COLAB_WORKER_PY`）与隧道的单格 Colab notebook 代码。配置了 endpoint 或连接文件（在该行中，或 `DSH_COLAB_ENDPOINT` / `DSH_COLAB_CONNECTION`）时，`colab` 执行后端（优先级 100）在 `auto` 选择中胜出；未配置时它返回 null，由 `local` 运行评估器。队列一次只跑一个任务。每次评估上传冻结评估器及其哈希和工作区清单；远端评估器哈希与冻结副本不同，或评估改动了上传的工作区时，结果被拒绝。`FrozenEvaluator` 本地的哈希与清单校验照常执行。worker 通过 `ctx.shellEnv` 获得 `DSH_COLAB_*`，用 `node "$DSH_COLAB_CLI" exec . -- <命令>` 做 GPU 预检。

## 安全

- 用户原始 checkout 永远不会被评估或修改；分支是拷贝或 CoW 挂载。
- 共享检查点拒绝符号链接、路径穿越、点文件（`.method-evaluation` 除外）、私有凭据文件名以及疑似凭据内容。
- worker skill 禁止递归派生与发布/合并；provider 也会拒绝来自 worker checkout 或存活 worker 子会话的 `subagent_auto_research` 调用。
- `CONFIG.json` 省略 `workerEnv` 与 `layerfs` 中疑似机密的键；worker 仍按配置收到完整的 `workerEnv`。
- 不会自动合并、重置、覆盖、删除或发布。
- 批次边界不能证明用户目标已完成，也不能证明存在基准提升。

## 构建

源码位于 `src/*.ts`（严格 TypeScript），`npm run build` 编译到 `lib/`（`lib/index.js`、`lib/*.d.ts`），`npm test` 依次执行 typecheck、build 和 `node --test tests/*.test.ts`。测试也全部是严格 TypeScript（`tsconfig.test.json` 同时检查 `src` 与 `tests`）。

## 测试

```bash
npm test
```

`node:test` 测试覆盖协议（指标视图、portfolio、检查点、peer review、综合上下文）、评估器冻结与完整性、两种工作区后端与完成状态恢复、完整运行器批次（分叉-刷新、RSI 停滞、协作、失败/超时区分）、provider/插件生命周期、取消与包元数据。

## 限制

- worker 的 provider session 会被记录，但通用 `startActivation` 接口无法恢复会话；续跑依靠 handoff：上一轮的助手输出写入下一轮 checkout 的 `.auto-research-methods/HANDOFF.md`（由 `BRANCH.json` 的 `handoff` 指出），run 目录在 `<branch>/HANDOFF.md` 留一份副本。`LAUNCH.json` 记录 `continuation: "handoff"`（全新分支为 `"none"`）。
- Sandbox 内部的 LayerFS 挂载通过宿主暂存目录桥接；超大工作区需要复制成本。二进制文件通过 `workspace.exec` 原样复制，无法复制时跳过并告警，且不会被删除。
- 协作 epoch 复用分支工作区，要求 worker 在共享窗口内完成；硬性阶段截止时间仍然生效。
- 评估器必须是本地可执行脚本；除已接受的工作区与清单检查外没有额外沙箱。
