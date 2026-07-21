export interface SkillOption {
	name: string;
	description: string;
}

export function filterSkills(
	text: string,
	skills: SkillOption[],
): SkillOption[] {
	if (!text.startsWith("/")) return [];
	if (/\s/.test(text.slice(1))) return [];
	const query = text.slice(1).split(/\s/, 1)[0] ?? "";
	return skills.filter((skill) => skill.name.startsWith(query));
}

export function parseSkillCommand(
	text: string,
	skills: readonly SkillOption[],
): { skillName?: string; text: string } {
	const match = text.match(/^\/([^\s]+)(?:\s([\s\S]*))?$/);
	if (!match || !skills.some((skill) => skill.name === match[1]))
		return { text };
	return { skillName: match[1], text: match[2]?.trim() ?? "" };
}

export function moveSkillSelection(
	index: number,
	direction: 1 | -1,
	length: number,
): number {
	return length ? (index + direction + length) % length : 0;
}
