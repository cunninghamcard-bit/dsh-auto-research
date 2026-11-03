/**
 * `dsh-auto-research-worker`: prompts only. Injects `worker.md` into the
 * prompt of every running branch worker, and of no other session.
 */
import type { PluginContext } from 'dsh-auto-research-api';
export declare const name = "dsh-auto-research-worker";
export declare const inject: string[];
export declare function apply(ctx: PluginContext): void;
//# sourceMappingURL=index.d.ts.map