/**
 * `dsh-auto-research-api`: the contract between the auto-research core and
 * its plugins, plus the skill registration every prompt package shares.
 *
 * - `ctx.researchWorkspace` ({@link WorkspaceService}): where branches live.
 *   `dsh-auto-research-workspace-layerfs` provides it.
 * - `ctx.researchExecutor` ({@link BackendRegistry} of executor factories):
 *   where commands run. The core provides the registry; the LayerFS Sandbox
 *   and Colab plugins register on it.
 * - `ctx.researchWorkers` ({@link WorkersService}): which sessions are running
 *   branch workers. The core provides it; the worker prompt package reads it.
 */
export { registerSkillDirectory } from './skills.js';
/** `promise`, or a rejection with the abort reason once `signal` aborts; the work itself goes on. */
export function untilAborted(promise, signal) {
    if (!signal)
        return promise;
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolveWait, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolveWait, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
//# sourceMappingURL=index.js.map