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
//# sourceMappingURL=index.js.map