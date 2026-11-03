/**
 * Backend registries the core plugin provides:
 *
 * - `ctx.researchWorkspace`: where branches live (`dsh-auto-research/layerfs`,
 *   `dsh-auto-research/snapshot`)
 * - `ctx.researchExecutor`: where the frozen evaluator runs
 *   (`dsh-auto-research/local`, `dsh-auto-research/colab`)
 *
 * Backends are Cordis plugins that inject a registry and register a factory.
 * The core ships no backend of its own.
 */
import type { ExecutorBackend, ExecutorBackendCreateOptions, ExecutorBackendFactory, WorkspaceBackend, WorkspaceBackendCreateOptions, WorkspaceBackendFactory } from './types.js';
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
export declare class ResearchWorkspaceRegistry extends BackendRegistry<WorkspaceBackend, WorkspaceBackendCreateOptions, WorkspaceBackendFactory> {
    constructor();
}
export declare class ResearchExecutorRegistry extends BackendRegistry<ExecutorBackend, ExecutorBackendCreateOptions, ExecutorBackendFactory> {
    constructor();
}
export {};
//# sourceMappingURL=registry.d.ts.map