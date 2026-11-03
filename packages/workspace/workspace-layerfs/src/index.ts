/**
 * `dsh-auto-research-workspace-layerfs`: research branches as LayerFS branches
 * of the coordinator's project.
 *
 * Workers reach their branch with the `layerfs` command the dsh-layerfs preset
 * gives every bash call; this plugin forks branches, reads their heads, and
 * runs commands on a commit in a Sandbox of its own. It provides
 * `ctx.researchWorkspace` and registers that Sandbox as the `sandbox`
 * executor, the default where no other executor applies. Nothing is copied to
 * the host except an exported tarball an executor asks for.
 */

import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { untilAborted } from 'dsh-auto-research-api'
import type {
  BranchRef,
  ExecutionRequest,
  ExecutionResult,
  ExecutorBackend,
  ExecutorBackendFactory,
  Logger,
  PluginContext,
  RunOptions,
  Workspace,
  WorkspaceService,
} from 'dsh-auto-research-api'

export const name = 'dsh-auto-research-workspace-layerfs'
export const inject: string[] = ['researchExecutor', 'shellEnv']

/** A mounted Workspace. */
interface Mount {
  sandbox: string
  path: string
}

/** The `@layerfs/agent` 1.1 calls this backend makes. */
export interface LayerFSClient {
  branch: {
    fork: (name: string, fromRef?: string) => Promise<{ branch: string; base: string; head: string | null }>
  }
  project: {
    list_branches: (pageSize?: number, pagePos?: number) => Promise<{
      items: Array<{ name: string; base: string; head: string | null }>
      hasMore: boolean
      nextPagePos: number | null
    }>
  }
  sandbox: {
    create: () => Promise<{ sandbox: string }>
  }
  workspace: {
    mount: (sandbox: string, branch: string) => Promise<Mount>
    exec: (ws: Mount, command: string, message?: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>
    unmount: (ws: Mount, discard?: boolean) => Promise<unknown>
  }
  close: () => Promise<unknown>
}

/** The `DSH_LAYERFS_*` names `@dsh-layerfs/host` publishes, and the `LAYERFS_*` names `LayerFS.open` reads. */
const SDK_ENVIRONMENT = [
  ['LAYERFS_HOME', 'DSH_LAYERFS_HOME'],
  ['LAYERFS_STORE_PATH', 'DSH_LAYERFS_STORE_PATH'],
  ['LAYERFS_DOCKER', 'DSH_LAYERFS_DOCKER'],
  ['LAYERFS_IMAGE', 'DSH_LAYERFS_IMAGE'],
  ['LAYERFS_VOLUME', 'DSH_LAYERFS_VOLUME'],
  ['LAYERFS_DAEMON', 'DSH_LAYERFS_DAEMON'],
  ['LAYERFS_CONTAINER_PREFIX', 'DSH_LAYERFS_CONTAINER_PREFIX'],
  ['LAYERFS_DAEMON_HOST', 'DSH_LAYERFS_DAEMON_HOST'],
  ['LAYERFS_WORKER_ENDPOINT', 'DSH_LAYERFS_WORKER_ENDPOINT'],
] as const

/** Opens run one at a time: each one owns `process.env`'s `LAYERFS_*` names while it reads them. */
let opening: Promise<unknown> = Promise.resolve()

/**
 * Open the coordinator's LayerFS project with the SDK its session names.
 * `LayerFS.open` reads its deployment from `LAYERFS_*` once, so those names are
 * set on `process.env` around the open and restored right after it.
 */
export async function openLayerfs(env: Readonly<Record<string, string | undefined>>): Promise<LayerFSClient | null> {
  const project = env.DSH_LAYERFS_PROJECT
  const sdk = env.DSH_LAYERFS_SDK
  if (!project || !sdk) return null
  const open = opening.then(async () => {
    const saved = SDK_ENVIRONMENT.map(([key]) => [key, process.env[key]] as const)
    for (const [key, source] of SDK_ENVIRONMENT) {
      const value = env[source]
      if (value) process.env[key] = value
      else delete process.env[key]
    }
    try {
      const url = sdk.startsWith('file:') ? sdk : pathToFileURL(isAbsolute(sdk) ? sdk : resolve(sdk)).href
      const module = await import(url) as { LayerFS?: { open?: (name: string) => Promise<LayerFSClient> } }
      if (typeof module.LayerFS?.open !== 'function') throw new Error('LayerFS SDK does not export LayerFS.open: ' + sdk)
      return await module.LayerFS.open(project)
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  opening = open.catch(() => {})
  return open
}

function refusal(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

const TRANSIENT = /ECONNREFUSED|ECONNRESET|EPIPE|Connection refused|socket hang up|failed to connect to daemon/i

/**
 * Retry a call LayerFS refused for a passing reason: `Busy` (another agent is
 * changing the project) or a Sandbox daemon still binding its port.
 */
async function retry<T>(call: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      const passing = refusal(error) === 'Busy' || TRANSIENT.test(String((error as Error)?.message ?? error))
      if (!passing || attempt >= attempts) throw error
      await new Promise(done => setTimeout(done, 150 * 2 ** attempt).unref())
    }
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Bytes per exported chunk; base64 of it stays well inside one exec reply. */
const EXPORT_CHUNK = 4 * 1024 * 1024

export class LayerFSWorkspace implements Workspace {
  private sandbox: Promise<string> | null = null

  constructor(
    readonly client: LayerFSClient,
    readonly project: string,
    readonly logger: Logger | null = null,
  ) {}

  async fork(from: BranchRef | string, name: string): Promise<BranchRef> {
    const source = typeof from === 'string' ? from : from.commit ?? from.base
    const forked = await retry(() => this.client.branch.fork(name, source))
    return { branch: forked.branch, commit: forked.head, base: forked.base }
  }

  describe(ref: BranchRef): string {
    return [
      `Your branch: LayerFS project ${this.project}, branch ${ref.branch}. Work and commit only on this branch.`,
      'Read and change it with the `layerfs` command or the SDK, as the LayerFS instructions in your system prompt describe: mount a Workspace in your own Sandbox, run commands there, commit, and unmount every Workspace before you end your turn.',
    ].join('\n')
  }

  async head(branch: string): Promise<BranchRef> {
    for (let page = 0; ;) {
      const listed = await retry(() => this.client.project.list_branches(1000, page))
      const found = listed.items.find(item => item.name === branch)
      if (found) return { branch, commit: found.head, base: found.base }
      if (!listed.hasMore || listed.nextPagePos === null) throw new Error(`LayerFS branch ${branch} does not exist`)
      page = listed.nextPagePos
    }
  }

  /** Run a command on `ref` in this workspace's Sandbox; nothing is committed. The `sandbox` executor queues these. */
  async execute(ref: BranchRef, options: RunOptions): Promise<ExecutionResult> {
    const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000))
    const setup = (options.files ?? []).map(file => {
      const target = quote(file.name)
      const data = Buffer.from(file.text, 'utf8').toString('base64')
      return `mkdir -p "$(dirname ${target})" && printf %s ${quote(data)} | base64 -d > ${target}`
    })
    const command = [
      ...setup,
      `timeout -k 10 ${seconds} ${options.argv.map(quote).join(' ')}`,
    ].join(' && ')
    const result = await this.onCommit(ref, ws => retry(() => this.client.workspace.exec(ws, command, 'auto-research run')))
    return {
      code: result.exitCode,
      // `timeout` exits 124 when it stopped the command, 137 when it had to kill it.
      timedOut: result.exitCode === 124 || result.exitCode === 137,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      environment: 'layerfs',
    }
  }

  async exportTree(ref: BranchRef, directory: string): Promise<string> {
    const target = join(directory, `${ref.branch}-${(ref.commit ?? ref.base).slice(0, 12)}.tar.gz`)
    const archive = `/tmp/ar-export-${randomUUID()}.tar.gz`
    await fsp.mkdir(directory, { recursive: true })
    await this.onCommit(ref, async ws => {
      const exec = async (command: string): Promise<string> => {
        const result = await retry(() => this.client.workspace.exec(ws, command, 'auto-research export'))
        if (result.exitCode !== 0) throw new Error(`LayerFS export of ${ref.branch} failed: ${result.stderr}`)
        return result.stdout
      }
      const size = Number((await exec(`tar czf ${archive} --exclude=./.git . && wc -c < ${archive}`)).trim())
      const handle = await fsp.open(target, 'w')
      try {
        for (let offset = 0; offset < size; offset += EXPORT_CHUNK) {
          const chunk = await exec(`tail -c +${offset + 1} ${archive} | head -c ${EXPORT_CHUNK} | base64 -w0`)
          await handle.write(Buffer.from(chunk, 'base64'))
        }
      } finally {
        await handle.close()
        await exec(`rm -f ${archive}`).catch(() => '')
      }
    })
    return target
  }

  async close(): Promise<void> {
    await this.client.close()
  }

  /**
   * Mount `ref` for one call and unmount it with its changes discarded. A
   * branch whose head moved past `ref` is read through a scratch branch forked
   * at `ref`, so the call always sees exactly that commit.
   */
  private async onCommit<T>(ref: BranchRef, use: (ws: Mount) => Promise<T>): Promise<T> {
    const head = await this.head(ref.branch)
    const branch = head.commit === ref.commit
      ? ref.branch
      : (await this.fork(ref, `${ref.branch.slice(0, 48)}-at-${randomUUID().slice(0, 8)}`)).branch
    const ws = await this.mount(branch)
    try {
      return await use(ws)
    } finally {
      await retry(() => this.client.workspace.unmount(ws, true)).catch((error: unknown) => {
        this.logger?.warn?.(`[auto-research] unmount of ${ws.sandbox}:${ws.path} failed: ${(error as Error).message}`)
      })
    }
  }

  /**
   * Mount in this backend's Sandbox. A Sandbox closes itself two minutes after
   * its last Workspace and holds at most 16; either refusal makes a new one.
   */
  private async mount(branch: string): Promise<Mount> {
    for (let attempt = 0; ; attempt += 1) {
      const current = this.sandbox ??= retry(() => this.client.sandbox.create()).then(made => made.sandbox)
      try {
        const sandbox = await current
        return await retry(() => this.client.workspace.mount(sandbox, branch))
      } catch (error) {
        if (this.sandbox === current) this.sandbox = null
        const code = refusal(error)
        if (attempt > 0 || (code !== 'NoSuchSandbox' && code !== 'Capacity')) throw error
      }
    }
  }
}

/** The synthetic tool-call id the coordinator's bash variables are read under. */
const SHELL_ENV_CALL_ID = 'auto-research-env'

/** `ctx.shellEnv` surface: the `DSH_*` variables a bash call of `agent` would get. */
interface ShellEnv {
  collect: (execution: { agent?: unknown; callId: string; rootCallId?: string }) => Readonly<Record<string, string>>
}

/** `ctx.researchWorkspace`: the project the coordinator's session is bound to. */
export class LayerFSWorkspaceService implements WorkspaceService {
  constructor(readonly shellEnv: ShellEnv) {}

  async open(parent: unknown, options: { logger?: Logger }): Promise<LayerFSWorkspace> {
    const env = this.shellEnv.collect({ agent: parent, callId: SHELL_ENV_CALL_ID, rootCallId: SHELL_ENV_CALL_ID })
    const client = await openLayerfs(env)
    if (!client) throw new Error('This session is not bound to a LayerFS project; use LayerFS in the conversation first')
    return new LayerFSWorkspace(client, env.DSH_LAYERFS_PROJECT as string, options.logger ?? null)
  }
}

/** The `sandbox` executor: run in the batch workspace's own Sandbox (CPU), one command at a time. */
export class SandboxExecutor implements ExecutorBackend {
  readonly name = 'sandbox'
  /** The last request; each starts after the previous command has ended. */
  private queue: Promise<unknown> = Promise.resolve()

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    const { ref, workspace, ...options } = request
    const current = this.queue.catch(() => {}).then(() => {
      options.signal?.throwIfAborted()
      return (workspace as LayerFSWorkspace).execute(ref, options)
    })
    this.queue = current
    return untilAborted(current, options.signal)
  }
}

export class SandboxExecutorFactory implements ExecutorBackendFactory {
  readonly name = 'sandbox'
  readonly priority = 0

  async create(): Promise<SandboxExecutor> {
    return new SandboxExecutor()
  }
}

export function apply(ctx: PluginContext): void {
  ctx.provide('researchWorkspace', new LayerFSWorkspaceService(ctx.shellEnv as ShellEnv))
  ctx.effect(() => ctx.researchExecutor!.register(new SandboxExecutorFactory()))
}
