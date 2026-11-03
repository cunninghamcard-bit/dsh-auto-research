/**
 * `ctx.researchExecutor`, the registry the core plugin provides: where
 * commands run. Executors are Cordis plugins that inject it and register a
 * factory: `sandbox` from `dsh-auto-research-workspace-layerfs`, `colab` from
 * `dsh-auto-research-executor-colab`. The core ships none of its own.
 */
import type { ExecutorBackend, ExecutorBackendFactory, Logger } from 'dsh-auto-research-api';
interface Factory<B, O> {
    readonly name: string;
    readonly priority: number;
    create: (options: O) => Promise<B | null>;
}
export declare class BackendRegistry<B, O, F extends Factory<B, O> = Factory<B, O>> {
    private readonly label;
    private readonly hint;
    private readonly factories;
    constructor(label: string, hint: string);
    register(factory: F): () => void;
    /** Registered factories, highest priority first. */
    list(): F[];
    /**
     * Create the backend for one batch.
     *
     * A concrete name tries only that factory; `auto` takes the first non-null
     * backend in priority order.
     */
    select(requested: string, options: O): Promise<B>;
}
export declare class ResearchExecutorRegistry extends BackendRegistry<ExecutorBackend, {
    logger?: Logger;
}, ExecutorBackendFactory> {
    constructor();
}
export {};
//# sourceMappingURL=registry.d.ts.map