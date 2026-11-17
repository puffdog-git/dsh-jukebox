// 把點唱機附的技能登記給 DSH（做法與 Discord 賽博群友相同）。技能正文在 skills/<名稱>/SKILL.md，用到時才讀。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const JUKEBOX_SKILLS = Object.freeze(['jukebox-player-control']);
export const JUKEBOX_SKILL_PROVIDER = 'dsh-jukebox';
const root = new URL('../skills/', import.meta.url);

/** 開頭的中繼資料只接受 name 與 description 兩行，其他寫法一律拒絕。 */
export function parseSkill(raw, name) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!m) throw Error(`技能 ${name}：缺少開頭的中繼資料`);
  const rows = m[1].split(/\r?\n/).filter(Boolean);
  if (rows.length !== 2 || !rows.includes(`name: ${name}`)) throw Error(`技能 ${name}：中繼資料不正確`);
  const description = rows.find((r) => r.startsWith('description: '))?.slice(13).trim();
  const content = raw.slice(m[0].length).trim();
  if (!description || !content) throw Error(`技能 ${name}：內容是空的`);
  return { description, content };
}

export function createSkillProvider(control, { read = readFile, isOn = () => true, warn = () => {} } = {}) {
  const base = (name) => ({ kind: 'directory', path: fileURLToPath(new URL(`${name}/`, root)).replaceAll('\\', '/') });
  async function load(name, signal) {
    if (!JUKEBOX_SKILLS.includes(name) || !isOn()) return null;
    try {
      return parseSkill(await read(new URL(`${name}/SKILL.md`, root), { encoding: 'utf8', signal }), name);
    } catch (error) {
      signal?.throwIfAborted();
      warn(`點唱機的技能 ${name} 讀不出來：` + String(error?.message || error).slice(0, 120));
      return null;
    }
  }
  const describe = (name, value) => ({ name, description: value.description, invocation: { modelInvocable: true, userInvocable: true }, provider: JUKEBOX_SKILL_PROVIDER, source: 'bundled', resourceBase: base(name) });
  return {
    name: JUKEBOX_SKILL_PROVIDER,
    async list(options = {}) {
      control?.signal?.throwIfAborted();
      const candidates = [];
      for (const name of JUKEBOX_SKILLS) {
        const value = await load(name, options.signal);
        if (value) candidates.push({ ...describe(name, value), rank: 600, locator: name });
      }
      return { candidates, complete: true };
    },
    async get(candidate, options = {}) {
      control?.signal?.throwIfAborted();
      if (candidate?.provider !== JUKEBOX_SKILL_PROVIDER) return;
      const value = await load(candidate.name, options.signal);
      return value ? { ...describe(candidate.name, value), content: value.content } : undefined;
    },
  };
}

/** 宿主有技能服務才登記；沒有就略過，不影響其他功能。 */
export function registerSkills(ctx, isOn) {
  ctx.inject?.(['skills'], (scope) => {
    scope.skills.registerProvider((control) => createSkillProvider(control, { isOn, warn: (message) => scope.logger?.warn?.(message) }));
  });
}
