/**
 * `ctx.researchWorkspace`: the registry of workspace backend factories.
 *
 * Backends are Cordis plugins (`dsh-auto-research/layerfs`,
 * `dsh-auto-research/snapshot`, or third-party ones) that inject this service
 * and register a factory. The core ships no backend of its own.
 */

import type {
  ResearchWorkspaceService,
  WorkspaceBackend,
  WorkspaceBackendCreateOptions,
  WorkspaceBackendFactory,
} from './types.js'

export class ResearchWorkspaceRegistry implements ResearchWorkspaceService {
  private readonly factories: WorkspaceBackendFactory[] = []

  register(factory: WorkspaceBackendFactory): () => void {
    if (this.factories.some(item => item.name === factory.name)) {
      throw new Error(`workspace backend "${factory.name}" is already registered`)
    }
    this.factories.push(factory)
    return () => {
      const index = this.factories.indexOf(factory)
      if (index >= 0) this.factories.splice(index, 1)
    }
  }

  /** Registered factories, highest priority first. */
  list(): WorkspaceBackendFactory[] {
    return [...this.factories].sort((left, right) => right.priority - left.priority)
  }

  /**
   * Create the backend for one batch.
   *
   * A concrete name tries only that factory; `auto` takes the first non-null
   * backend in priority order.
   */
  async select(requested: string, options: WorkspaceBackendCreateOptions): Promise<WorkspaceBackend> {
    const factories = this.list()
    if (requested !== 'auto') {
      const factory = factories.find(item => item.name === requested)
      if (!factory) throw new Error(`workspace backend "${requested}" is not registered (registered: ${names(factories)})`)
      const backend = await factory.create(options)
      if (!backend) throw new Error(`workspace backend "${requested}" is not available for this batch`)
      return backend
    }
    for (const factory of factories) {
      const backend = await factory.create(options)
      if (backend) return backend
    }
    throw new Error(`no workspace backend is available (registered: ${names(factories)}); load dsh-auto-research/layerfs or dsh-auto-research/snapshot`)
  }
}

function names(factories: WorkspaceBackendFactory[]): string {
  return factories.length > 0 ? factories.map(item => item.name).join(', ') : 'none'
}
