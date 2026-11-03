/**
 * Backend registries the core plugin provides:
 *
 * - `ctx.researchWorkspace`: where branches live (`dsh-auto-research-workspace-layerfs`)
 * - `ctx.researchExecutor`: where commands run (`dsh-auto-research-executor-local`,
 *   `dsh-auto-research-executor-colab`)
 *
 * Backends are Cordis plugins that inject a registry and register a factory.
 * The core ships no backend of its own.
 */

import type {
  BackendCreateOptions,
  ExecutorBackend,
  ExecutorBackendFactory,
  WorkspaceBackend,
  WorkspaceBackendFactory,
} from 'dsh-auto-research-api'

interface Factory<B, O> {
  readonly name: string
  readonly priority: number
  create: (options: O) => Promise<B | null>
}

export class BackendRegistry<B, O, F extends Factory<B, O> = Factory<B, O>> {
  private readonly factories: F[] = []

  constructor(private readonly label: string, private readonly hint: string) {}

  register(factory: F): () => void {
    if (this.factories.some(item => item.name === factory.name)) {
      throw new Error(`${this.label} "${factory.name}" is already registered`)
    }
    this.factories.push(factory)
    return () => {
      const index = this.factories.indexOf(factory)
      if (index >= 0) this.factories.splice(index, 1)
    }
  }

  /** Registered factories, highest priority first. */
  list(): F[] {
    return [...this.factories].sort((left, right) => right.priority - left.priority)
  }

  /**
   * Create the backend for one batch.
   *
   * A concrete name tries only that factory; `auto` takes the first non-null
   * backend in priority order.
   */
  async select(requested: string, options: O): Promise<B> {
    const factories = this.list()
    if (requested !== 'auto') {
      const factory = factories.find(item => item.name === requested)
      if (!factory) throw new Error(`${this.label} "${requested}" is not registered (registered: ${names(factories)})`)
      const backend = await factory.create(options)
      if (!backend) throw new Error(`${this.label} "${requested}" is not available for this batch`)
      return backend
    }
    for (const factory of factories) {
      const backend = await factory.create(options)
      if (backend) return backend
    }
    throw new Error(`no ${this.label} is available (registered: ${names(factories)}); ${this.hint}`)
  }
}

export class ResearchWorkspaceRegistry
  extends BackendRegistry<WorkspaceBackend, BackendCreateOptions, WorkspaceBackendFactory> {
  constructor() {
    super('workspace backend', 'load dsh-auto-research-workspace-layerfs and bind the session to a LayerFS project')
  }
}

export class ResearchExecutorRegistry
  extends BackendRegistry<ExecutorBackend, BackendCreateOptions, ExecutorBackendFactory> {
  constructor() {
    super('executor', 'load dsh-auto-research-executor-local or dsh-auto-research-executor-colab')
  }
}

function names(factories: ReadonlyArray<{ name: string }>): string {
  return factories.length > 0 ? factories.map(item => item.name).join(', ') : 'none'
}
