/**
 * Register the `SKILL.md` folders of one package with `ctx.skills`. Every
 * auto-research package that ships prompts uses this.
 */
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
/** dsh's rank for packaged (bundled) skills. */
const BUNDLED_SKILL_RANK = 600;
/** Split a `SKILL.md` into its frontmatter fields and body. */
function parseSkill(text) {
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (!match)
        throw new Error('Packaged skill has no frontmatter');
    const fields = {};
    for (const line of match[1].split('\n')) {
        const colon = line.indexOf(':');
        if (colon > 0)
            fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return { fields, content: text.slice(match[0].length).replace(/^\n+/, '') };
}
/**
 * Register every `<root>/<name>/SKILL.md` for `names` under `provider`.
 * @param root - absolute directory holding one folder per skill.
 */
export function registerSkillDirectory(skills, provider, root, names) {
    const candidates = names.map(name => {
        const file = join(root, name, 'SKILL.md');
        const { fields } = parseSkill(readFileSync(file, 'utf8'));
        return {
            name: fields.name ?? name,
            description: fields.description ?? '',
            invocation: { modelInvocable: true, userInvocable: fields['user-invocable'] !== 'false' },
            provider,
            source: 'bundled',
            rank: BUNDLED_SKILL_RANK,
            resourceBase: { kind: 'directory', path: join(root, name) },
            locator: file,
        };
    });
    skills.registerProvider(() => ({
        name: provider,
        list: async () => candidates,
        async get(found, options) {
            const { rank: _rank, locator, ...summary } = found;
            const text = await fsp.readFile(locator, { encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}) });
            return { ...summary, content: parseSkill(text).content };
        },
    }));
}
//# sourceMappingURL=skills.js.map