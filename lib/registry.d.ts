/**
 * `ctx.researchWorkspace`: the registry of workspace backend factories.
 *
 * Backends are Cordis plugins (`dsh-auto-research/layerfs`,
 * `dsh-auto-research/snapshot`, or third-party ones) that inject this service
 * and register a factory. The core ships no backend of its own.
 */
import type { ResearchWorkspaceService, WorkspaceBackend, WorkspaceBackendCreateOptions, WorkspaceBackendFactory } from './types.js';
export declare class ResearchWorkspaceRegistry implements ResearchWorkspaceService {
    private readonly factories;
    register(factory: WorkspaceBackendFactory): () => void;
    /** Registered factories, highest priority first. */
    list(): WorkspaceBackendFactory[];
    /**
     * Create the backend for one batch.
     *
     * A concrete name tries only that factory; `auto` takes the first non-null
     * backend in priority order.
     */
    select(requested: string, options: WorkspaceBackendCreateOptions): Promise<WorkspaceBackend>;
}
//# sourceMappingURL=registry.d.ts.map