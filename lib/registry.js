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
export class BackendRegistry {
    label;
    hint;
    factories = [];
    constructor(label, hint) {
        this.label = label;
        this.hint = hint;
    }
    register(factory) {
        if (this.factories.some(item => item.name === factory.name)) {
            throw new Error(`${this.label} "${factory.name}" is already registered`);
        }
        this.factories.push(factory);
        return () => {
            const index = this.factories.indexOf(factory);
            if (index >= 0)
                this.factories.splice(index, 1);
        };
    }
    /** Registered factories, highest priority first. */
    list() {
        return [...this.factories].sort((left, right) => right.priority - left.priority);
    }
    /**
     * Create the backend for one batch.
     *
     * A concrete name tries only that factory; `auto` takes the first non-null
     * backend in priority order.
     */
    async select(requested, options) {
        const factories = this.list();
        if (requested !== 'auto') {
            const factory = factories.find(item => item.name === requested);
            if (!factory)
                throw new Error(`${this.label} "${requested}" is not registered (registered: ${names(factories)})`);
            const backend = await factory.create(options);
            if (!backend)
                throw new Error(`${this.label} "${requested}" is not available for this batch`);
            return backend;
        }
        for (const factory of factories) {
            const backend = await factory.create(options);
            if (backend)
                return backend;
        }
        throw new Error(`no ${this.label} is available (registered: ${names(factories)}); ${this.hint}`);
    }
}
export class ResearchWorkspaceRegistry extends BackendRegistry {
    constructor() {
        super('workspace backend', 'load dsh-auto-research/layerfs or dsh-auto-research/snapshot');
    }
}
export class ResearchExecutorRegistry extends BackendRegistry {
    constructor() {
        super('executor', 'load dsh-auto-research/local or dsh-auto-research/colab');
    }
}
function names(factories) {
    return factories.length > 0 ? factories.map(item => item.name).join(', ') : 'none';
}
//# sourceMappingURL=registry.js.map