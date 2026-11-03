/**
 * `dsh-auto-research-executor-colab`: run a command on a commit on a Google
 * Colab GPU, over ssh through the signed-in Colab CLI's proxy.
 *
 * Each request streams the commit as a tarball into a fresh directory on the
 * VM, runs the command there under `timeout`, and removes the directory. One
 * ssh connection per session is kept open and reused. Requests on one
 * session run one at a time, so runs do not share the GPU. Sessions cost
 * compute units: by default only sessions named in the configuration are used.
 */

import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutorBackend,
  ExecutorBackendFactory,
  Logger,
  PluginContext,
} from 'dsh-auto-research-api'

export const name = 'dsh-auto-research-executor-colab'
export const inject: string[] = ['researchExecutor', 'skills']

export interface ColabConfig {
  /** The Colab CLI. */
  cli?: string
  /** Names of running sessions to use, one request at a time each. */
  sessions?: string[]
  /** Let the executor create sessions when none are configured (costs compute units). */
  createSessions?: boolean
  /** GPU for created sessions: T4, L4, G4, H100, A100. */
  gpu?: string
  /** How many sessions to create. */
  maxSessions?: number
}

/** The ssh key the Colab proxy installs on the VM; created on first use. */
const KEY = join(homedir(), '.cache', 'dsh-auto-research', 'ssh', 'id_ed25519')

/** Control sockets of the reused connections; a Unix socket path must stay short. */
const CONTROL_DIR = join(homedir(), '.cache', 'arssh')

/** Output kept per stream: the tail. */
const OUTPUT_BYTES = 1_000_000

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolveRun({ stdout, stderr })
    })
  })
}

/** The shell command run on the VM, reading the commit tarball on stdin. */
function remoteCommand(id: string, files: ReadonlyArray<{ name: string; text: string }>, argv: readonly string[], seconds: number): string {
  const dir = `/content/auto-research/${id}`
  const writes = files.map(file => {
    const path = `${dir}/${file.name}`
    return `mkdir -p "$(dirname ${quote(path)})" && printf %s ${quote(Buffer.from(file.text, 'utf8').toString('base64'))} | base64 -d > ${quote(path)}`
  })
  return [
    // an ssh login lacks the container's environment the notebook kernel has (CUDA and node on PATH, PYTHONPATH)
    `while IFS= read -r -d '' kv; do case "$kv" in [A-Za-z_]*=*) export "$kv";; esac; done < /proc/1/environ`,
    `mkdir -p ${quote(dir)} && tar -xzf - -C ${quote(dir)}`,
    ...writes,
    `cd ${quote(dir)} && timeout -k 10 ${seconds} ${argv.map(quote).join(' ')}; code=$?; rm -rf ${quote(dir)}; exit $code`,
  ].join(' && ')
}

export class ColabExecutor implements ExecutorBackend {
  readonly name = 'colab'
  readonly cli: string
  /** Each session's queue: the promise of its last request. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<string, number>()
  private readonly created: string[] = []
  private readonly used = new Set<string>()
  private key: Promise<void> | null = null

  constructor(readonly config: ColabConfig, readonly logger: Logger | null = null) {
    this.cli = config.cli ?? join(homedir(), '.local', 'bin', 'colab')
  }

  private sshOptions(session: string): string[] {
    return [
      '-i', KEY,
      '-o', `ProxyCommand=${this.cli} ssh --proxy-mode -s ${session} -i ${KEY}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${join(CONTROL_DIR, '%C')}`,
      '-o', 'ControlPersist=600',
    ]
  }

  private ensureKey(): Promise<void> {
    return this.key ??= (async () => {
      await fsp.mkdir(join(KEY, '..'), { recursive: true, mode: 0o700 })
      await fsp.mkdir(CONTROL_DIR, { recursive: true, mode: 0o700 })
      if (!await fsp.access(KEY).then(() => true, () => false)) {
        await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'dsh-auto-research-colab', '-f', KEY], 30_000)
      }
    })()
  }

  /** Sessions to use; creates them on first use when allowed. */
  private async sessions(): Promise<string[]> {
    if (this.config.sessions?.length) return this.config.sessions
    if (this.created.length === 0) {
      const count = this.config.maxSessions ?? 1
      for (let index = 0; index < count; index += 1) {
        const session = `auto-research-${randomUUID().slice(0, 8)}`
        await run(this.cli, ['new', '-s', session, ...(this.config.gpu ? ['--gpu', this.config.gpu] : [])], 15 * 60_000)
        this.created.push(session)
      }
    }
    return this.created
  }

  /** The session with the fewest queued requests. */
  private async pick(): Promise<string> {
    const sessions = await this.sessions()
    return [...sessions].sort((a, b) => (this.pending.get(a) ?? 0) - (this.pending.get(b) ?? 0))[0] as string
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const session = await this.pick()
    this.pending.set(session, (this.pending.get(session) ?? 0) + 1)
    const previous = this.queues.get(session) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this.runOn(session, request))
    this.queues.set(session, current)
    try {
      return await current
    } finally {
      this.pending.set(session, (this.pending.get(session) ?? 1) - 1)
    }
  }

  private async runOn(session: string, request: ExecutionRequest): Promise<ExecutionResult> {
    request.signal?.throwIfAborted()
    await this.ensureKey()
    this.used.add(session)
    const local = await fsp.mkdtemp(join(tmpdir(), 'auto-research-colab-'))
    const environment = `colab:${this.config.gpu ?? session}`
    const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000))
    try {
      const archive = await request.workspace.exportTree(request.ref, local)
      const command = remoteCommand(randomUUID(), request.files ?? [], request.argv, seconds)
      return await new Promise<ExecutionResult>((resolveRun, reject) => {
        const child = spawn('ssh', [...this.sshOptions(session), `root@colab-${session}`, command], { stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-OUTPUT_BYTES) })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-OUTPUT_BYTES) })
        createReadStream(archive).pipe(child.stdin)
        // The remote `timeout` ends the command; this ends a connection that hangs past it.
        const guard = setTimeout(() => child.kill('SIGKILL'), (seconds + 60) * 1000)
        const abort = (): void => { child.kill('SIGKILL') }
        request.signal?.addEventListener('abort', abort, { once: true })
        child.on('error', reject)
        child.on('close', code => {
          clearTimeout(guard)
          request.signal?.removeEventListener('abort', abort)
          resolveRun({ code, timedOut: code === 124 || code === 137 || code === null, stdout, stderr, environment })
        })
      })
    } finally {
      await fsp.rm(local, { recursive: true, force: true })
    }
  }

  /** Close the reused connections; stop only the sessions this executor created. */
  async close(): Promise<void> {
    for (const session of this.used) {
      await run('ssh', [...this.sshOptions(session), '-O', 'exit', `root@colab-${session}`], 10_000).catch(() => {})
    }
    for (const session of this.created.splice(0)) {
      await run(this.cli, ['stop', '-s', session], 120_000).catch((error: unknown) => {
        this.logger?.warn?.(`[auto-research] colab stop ${session} failed: ${(error as Error).message}`)
      })
    }
  }
}

export class ColabExecutorFactory implements ExecutorBackendFactory {
  readonly name = 'colab'
  readonly priority = 100

  constructor(readonly config: ColabConfig) {}

  /** Null unless sessions are named or may be created, so `auto` falls back to local. */
  async create(options: { logger?: Logger }): Promise<ColabExecutor | null> {
    if (!this.config.sessions?.length && !this.config.createSessions) return null
    return new ColabExecutor(this.config, options.logger ?? null)
  }
}

const SKILL = fileURLToPath(new URL('../skills/auto-research-colab/SKILL.md', import.meta.url))

export function apply(ctx: PluginContext, config: ColabConfig = {}): void {
  ctx.effect(() => ctx.researchExecutor!.register(new ColabExecutorFactory(config)))
  const skill = {
    name: 'auto-research-colab',
    description: 'Evaluate auto-research candidates on a Google Colab GPU: plan options.executor "colab".',
    invocation: { modelInvocable: true, userInvocable: false },
    provider: name,
    source: 'bundled',
    rank: 600,
    resourceBase: { kind: 'directory', path: join(SKILL, '..') },
  }
  ctx.skills!.registerProvider(() => ({
    name,
    list: async () => [skill],
    get: async () => ({ ...skill, content: (await fsp.readFile(SKILL, 'utf8')).replace(/^---\n[\s\S]*?\n---\n+/, '') }),
  }))
}
