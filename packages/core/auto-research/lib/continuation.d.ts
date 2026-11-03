/**
 * Continue a worker on public dsh APIs. dsh resumes a settled child only
 * through `sendMessage`, which returns a message id and tells the parent model
 * when the turn ends. The continue phase instead starts a new worker session
 * seeded with the leader worker's completed turns: the same history, observed
 * like any other activation.
 *
 * The seed is the `prepareContinuable` contribution of the
 * `auto-research-continue` provider, the way dsh's fork provider seeds a child
 * with its parent's turns.
 */
import type { SessionQuery, SubagentProvider } from './types.js';
export declare const CONTINUE_PROVIDER = "auto-research-continue";
export declare class ContinueProvider implements SubagentProvider {
    private readonly query;
    readonly name = "auto-research-continue";
    readonly capabilities: {
        agentOptions: boolean;
        agentPreset: boolean;
        outputSchema: boolean;
        depthLimit: boolean;
    };
    readonly inheritsParentContext = false;
    /** Seeds by reserved child session id, until that child is created. */
    private readonly seeds;
    constructor(query: () => SessionQuery | undefined);
    /**
     * Read `session` up to its last completed turn as the seed of the child
     * `childId`. Returns the function that drops the seed once the child exists.
     */
    prepare(childId: string, session: string, signal: AbortSignal): Promise<() => void>;
    prepareContinuable(request: {
        sessionId: string;
    }): Promise<{
        seed?: unknown[];
    }>;
}
//# sourceMappingURL=continuation.d.ts.map