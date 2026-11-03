/**
 * `ctx.researchExecutor`, the registry the core plugin provides: where
 * commands run. Executors are Cordis plugins that inject it and register a
 * factory. The core ships none of its own.
 */

import type { ExecutorBackend, ExecutorBackendFactory, Logger } from 'dsh-auto-research-api'

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

export class ResearchExecutorRegistry
  extends BackendRegistry<ExecutorBackend, { logger?: Logger }, ExecutorBackendFactory> {
  constructor() {
    super('executor', 'load an executor plugin of the bundle')
  }
}

function names(factories: ReadonlyArray<{ name: string }>): string {
  return factories.length > 0 ? factories.map(item => item.name).join(', ') : 'none'
}
