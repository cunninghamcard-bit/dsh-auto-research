/**
 * Register the `SKILL.md` folders of one package with `ctx.skills`. Every
 * auto-research package that ships prompts uses this.
 */
/** `ctx.skills` registration surface. */
export interface SkillsService {
    registerProvider: (factory: (control: {
        invalidate: () => void;
        signal: AbortSignal;
    }) => {
        name: string;
        list: (options: {
            cwd?: string;
            signal?: AbortSignal;
        }) => Promise<unknown>;
        get: (candidate: never, options: {
            cwd?: string;
            signal?: AbortSignal;
        }) => Promise<unknown>;
    }) => unknown;
}
/**
 * Register every `<root>/<name>/SKILL.md` for `names` under `provider`.
 * @param root - absolute directory holding one folder per skill.
 */
export declare function registerSkillDirectory(skills: SkillsService, provider: string, root: string, names: readonly string[]): void;
//# sourceMappingURL=skills.d.ts.map