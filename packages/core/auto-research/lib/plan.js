/**
 * Plan validation and option resolution. Runs before any lock, run directory
 * or branch exists, so an invalid plan leaves nothing behind.
 */
import { extname } from 'node:path';
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A finite number, or a decimal string of one; nothing that only coerces to one. */
export function scoreValue(value, label = 'score') {
    if (typeof value === 'string' && DECIMAL.test(value.trim()))
        return Number(value.trim());
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    throw new Error(`${label} must be a finite number`);
}
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
/** Validate the coordinator's plan and fill its defaults. */
export function validatePlan(input, options) {
    const objective = text(input.objective);
    if (!objective)
        throw new Error('Plan requires an objective');
    const workerPrompt = text(input.worker_prompt);
    if (!workerPrompt)
        throw new Error('Plan requires a worker_prompt');
    const evaluator = text(input.evaluator);
    if (!evaluator)
        throw new Error('Plan requires an evaluator script');
    const evaluationSeconds = Number(input.evaluation_seconds);
    if (!positive(evaluationSeconds))
        throw new Error('Plan requires a positive evaluation_seconds');
    const direction = input.direction ?? 'maximize';
    if (direction !== 'maximize' && direction !== 'minimize')
        throw new Error('Plan direction must be maximize or minimize');
    const metrics = input.metrics ?? [];
    if (!Array.isArray(metrics) || metrics.some(metric => !text(metric?.name))) {
        throw new Error('Plan metrics must be an array of { name }');
    }
    const names = metrics.map(metric => metric.name);
    if (new Set(names).size !== names.length)
        throw new Error('Plan metric names must be unique');
    const selection = input.selection_metrics ?? [];
    if (!Array.isArray(selection) || selection.some(spec => !names.includes(spec?.name)
        || (spec.direction !== 'maximize' && spec.direction !== 'minimize'))) {
        throw new Error('Selection metrics must name declared metrics with a direction');
    }
    if (!Number.isInteger(options.branches) || options.branches < 2)
        throw new Error('branches must be an integer of at least 2');
    if (!Number.isInteger(options.rounds) || options.rounds < 1)
        throw new Error('rounds must be a positive integer');
    if (!positive(options.explorationMinutes) || !positive(options.exploitationMinutes))
        throw new Error('Phase minutes must be positive');
    const stall = positive(input.stall_seconds) ? input.stall_seconds : null;
    const subset = typeof input.metric_subset === 'number' ? input.metric_subset : 1;
    const portfolio = typeof input.portfolio_size === 'number' ? input.portfolio_size : 2;
    const gain = input.meaningful_gain === undefined ? 0 : scoreValue(input.meaningful_gain, 'meaningful_gain');
    if (gain < 0)
        throw new Error('meaningful_gain must be non-negative');
    if (options.rsiTop) {
        if (!Number.isInteger(subset) || subset < 1 || subset > names.length)
            throw new Error('metric_subset must be between 1 and the number of metrics');
        if (stall === null)
            throw new Error('RSI-top requires stall_seconds');
        if (!Number.isInteger(portfolio) || portfolio < 2)
            throw new Error('RSI-top requires portfolio_size of at least 2');
        if (gain <= 0)
            throw new Error('RSI-top requires a positive meaningful_gain');
    }
    return {
        objective,
        worker_prompt: workerPrompt,
        evaluator,
        evaluator_interpreter: interpreter(input.evaluator_interpreter, evaluator),
        evaluation_seconds: evaluationSeconds,
        direction,
        metrics: metrics,
        selection_metrics: selection,
        stall_seconds: stall,
        metric_subset: subset,
        portfolio_size: portfolio,
        meaningful_gain: gain,
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