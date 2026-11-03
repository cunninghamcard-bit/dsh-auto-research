/**
 * `dsh-auto-research-workspace-layerfs`: research branches as LayerFS branches
 * of the coordinator's project.
 *
 * Workers reach their branch with the `layerfs` command the dsh-layerfs preset
 * gives every bash call; this backend only forks branches, reads their heads,
 * and runs commands on a commit in a Sandbox of its own. Nothing is copied to
 * the host except an exported tarball an executor asks for.
 */
import type { BackendCreateOptions, BranchRef, ExecutionResult, Logger, PluginContext, RunOptions, WorkspaceBackend, WorkspaceBackendFactory } from 'dsh-auto-research-api';
export declare const name = "dsh-auto-research-workspace-layerfs";
export declare const inject: string[];
/** A mounted Workspace. */
interface Mount {
    sandbox: string;
    path: string;
}
/** The `@layerfs/agent` 1.1 calls this backend makes. */
export interface LayerFSClient {
    branch: {
        fork: (name: string, fromRef?: string) => Promise<{
            branch: string;
            base: string;
            head: string | null;
        }>;
    };
    project: {
        list_branches: (pageSize?: number, pagePos?: number) => Promise<{
            items: Array<{
                name: string;
                base: string;
                head: string | null;
            }>;
            hasMore: boolean;
            nextPagePos: number | null;
        }>;
    };
    sandbox: {
        create: () => Promise<{
            sandbox: string;
        }>;
    };
    workspace: {
        mount: (sandbox: string, branch: string) => Promise<Mount>;
        exec: (ws: Mount, command: string, message?: string) => Promise<{
            exitCode: number | null;
            stdout: string;
            stderr: string;
        }>;
        unmount: (ws: Mount, discard?: boolean) => Promise<unknown>;
    };
    fs: {
        read: (ref: string, path: string, startLine?: number) => Promise<{
            text: string;
            nextLine?: number | null;
        }>;
    };
    close: () => Promise<unknown>;
}
/**
 * Open the coordinator's LayerFS project with the SDK its session names.
 * `LayerFS.open` reads its deployment from `LAYERFS_*` once, so those names are
 * set on `process.env` around the open and restored right after it.
 */
export declare function openLayerfs(env: Readonly<Record<string, string | undefined>>): Promise<LayerFSClient | null>;
export declare class LayerFSWorkspace implements WorkspaceBackend {
    readonly client: LayerFSClient;
    readonly project: string;
    readonly runId: string;
    readonly logger: Logger | null;
    readonly name = "layerfs";
    private sandbox;
    constructor(client: LayerFSClient, project: string, runId: string, logger?: Logger | null);
    fork(from: BranchRef | string, name: string): Promise<BranchRef>;
    head(branch: string): Promise<BranchRef>;
    readText(ref: BranchRef, path: string): Promise<string | null>;
    run(ref: BranchRef, options: RunOptions): Promise<ExecutionResult>;
    exportTree(ref: BranchRef, directory: string): Promise<string>;
    close(): Promise<void>;
    /**
     * Mount `ref` for one call and unmount it with its changes discarded. A
     * branch whose head moved past `ref` is read through a scratch branch forked
     * at `ref`, so the call always sees exactly that commit.
     */
    private onCommit;
    /**
     * Mount in this backend's Sandbox. A Sandbox closes itself two minutes after
     * its last Workspace and holds at most 16; either refusal makes a new one.
     */
    private mount;
}
export declare class LayerFSWorkspaceFactory implements WorkspaceBackendFactory {
    readonly name = "layerfs";
    readonly priority = 100;
    create(options: BackendCreateOptions): Promise<LayerFSWorkspace | null>;
}
export declare function apply(ctx: PluginContext): void;
export {};
//# sourceMappingURL=index.d.ts.map