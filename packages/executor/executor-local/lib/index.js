/**
 * `dsh-auto-research-executor-local`: run a command on a commit in the batch
 * workspace's own Sandbox (CPU). Nothing runs on the host.
 */
export const name = 'dsh-auto-research-executor-local';
export const inject = ['researchExecutor'];
export class LocalExecutor {
    name = 'local';
    run(request) {
        const { ref, workspace, ...options } = request;
        return workspace.run(ref, options);
    }
}
export class LocalExecutorFactory {
    name = 'local';
    priority = 0;
    async create() {
        return new LocalExecutor();
    }
}
export function apply(ctx) {
    ctx.effect(() => ctx.researchExecutor.register(new LocalExecutorFactory()));
}
//# sourceMappingURL=index.js.map