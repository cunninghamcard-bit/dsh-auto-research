/**
 * Plan reading and option resolution. Runs before any run directory or
 * branch exists, so a plan missing a required field leaves nothing behind.
 */
import { extname } from 'node:path';
function positive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
/** Defaults follow ara: three rounds, four branches, 5-minute explore, 15-minute continue. */
export function normalizeOptions(config = {}, plan = {}) {
    const overrides = plan.options && typeof plan.options === 'object' ? plan.options : {};
    return {
        rounds: overrides.rounds ?? config.rounds ?? 3,
        branches: overrides.branches ?? config.branches ?? 4,
        explorationMinutes: overrides.explorationMinutes ?? config.explorationMinutes ?? 5,
        exploitationMinutes: overrides.exploitationMinutes ?? config.exploitationMinutes ?? 15,
        rsiTop: overrides.rsiTop ?? config.rsiTop ?? false,
        forkAndFlush: overrides.forkAndFlush ?? config.forkAndFlush ?? true,
        workspaceBackend: overrides.workspaceBackend ?? config.workspaceBackend ?? 'auto',
        executor: overrides.executor ?? config.executor ?? 'auto',
    };
}
/** The interpreter the evaluator runs with inside the executor. */
function interpreter(raw, evaluator) {
    if (Array.isArray(raw) && raw.length > 0)
        return raw.map(String);
    if (typeof raw === 'string' && raw.trim())
        return raw.trim().split(/\s+/);
    const extension = extname(evaluator).toLowerCase();
    if (extension === '.py')
        return ['python3', '-B'];
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs')
        return ['node'];
    if (extension === '.sh')
        return ['bash'];
    return [];
}
/** Read the coordinator's plan: four required fields, defaults for the rest. */
export function validatePlan(input, _options) {
    const required = (key) => {
        const value = text(input[key]);
        if (!value)
            throw new Error(`Plan requires ${key}`);
        return value;
    };
    const evaluator = required('evaluator');
    const evaluationSeconds = Number(input.evaluation_seconds);
    if (!positive(evaluationSeconds))
        throw new Error('Plan requires a positive evaluation_seconds');
    return {
        objective: required('objective'),
        worker_prompt: required('worker_prompt'),
        evaluator,
        evaluator_interpreter: interpreter(input.evaluator_interpreter, evaluator),
        evaluation_seconds: evaluationSeconds,
        direction: input.direction === 'minimize' ? 'minimize' : 'maximize',
        metrics: (input.metrics ?? []),
        selection_metrics: (input.selection_metrics ?? []),
        stall_seconds: positive(input.stall_seconds) ? input.stall_seconds : null,
        metric_subset: typeof input.metric_subset === 'number' ? input.metric_subset : 1,
        portfolio_size: typeof input.portfolio_size === 'number' ? input.portfolio_size : 2,
        meaningful_gain: Number(input.meaningful_gain ?? 0),
        base: text(input.base) ?? 'main',
        options: input.options ?? {},
    };
}
/**
 * The worker LLM selection: the request's `agentOptions`, then `plan.options`,
 * then the plugin configuration. Within a layer `workerAgentOptions` wins over
 * the single `worker*` fields.
 */
export function resolveWorkerAgentOptions(config, plan, override) {
    const options = plan.options ?? {};
    const fields = (source) => ({
        provider: source.workerLlmProvider,
        model: source.workerModel,
        reasoningEffort: source.workerReasoningEffort,
    });
    const layers = [
        override ?? {},
        options.workerAgentOptions ?? {},
        fields(options),
        config.workerAgentOptions ?? {},
        fields(config),
    ];
    const pick = (key) => layers.map(layer => text(layer[key])).find(Boolean);
    const provider = pick('provider');
    const model = pick('model');
    const reasoningEffort = pick('reasoningEffort');
    const maxTokens = layers.map(layer => layer.maxTokens).find(positive);
    const merged = {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(maxTokens ? { maxTokens } : {}),
    };
    return Object.keys(merged).length > 0 ? merged : null;
}
//# sourceMappingURL=plan.js.map