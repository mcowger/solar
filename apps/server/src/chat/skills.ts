import { parseDocument } from "yaml";
import { db } from "../db";

export const MAX_SKILL_BYTES = 64 * 1024;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillInvocation {
	name: string;
	content: string;
}

function skillBodyOffset(content: string): number {
	const opening = content.match(/^---[ \t]*\r?\n/);
	if (!opening) throw new Error("SKILL.md must begin with YAML frontmatter");
	const frontmatterText = content.slice(opening[0].length);
	const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(frontmatterText);
	if (!closing || closing.index === undefined)
		throw new Error("SKILL.md frontmatter must be closed");
	return opening[0].length + closing.index + closing[0].length;
}

export function skillInstructions(content: string): string {
	return content.slice(skillBodyOffset(content));
}

export function parseSkill(content: string): {
	name: string;
	description: string;
} {
	if (new TextEncoder().encode(content).byteLength > MAX_SKILL_BYTES)
		throw new Error("SKILL.md must not exceed 64 KiB");
	skillBodyOffset(content);
	const opening = content.match(/^---[ \t]*\r?\n/)!;
	const frontmatterText = content.slice(opening[0].length);
	const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(frontmatterText)!;
	const document = parseDocument(frontmatterText.slice(0, closing.index));
	if (document.errors.length)
		throw new Error("SKILL.md frontmatter is invalid YAML");
	const frontmatter = document.toJSON();
	if (
		!frontmatter ||
		typeof frontmatter !== "object" ||
		Array.isArray(frontmatter)
	)
		throw new Error("SKILL.md frontmatter must be a YAML mapping");
	const { name, description } = frontmatter as Record<string, unknown>;
	if (
		typeof name !== "string" ||
		!SKILL_NAME_PATTERN.test(name) ||
		name.length > 64
	)
		throw new Error(
			"Skill name must be 1-64 lowercase ASCII letters, digits, or single hyphens",
		);
	if (
		typeof description !== "string" ||
		!description.trim() ||
		description.length > 1024
	)
		throw new Error(
			"Skill description must be nonempty and at most 1024 characters",
		);
	return { name, description };
}

export function skillInvocationContext(invocation: SkillInvocation): string {
	return `\n\n<explicit-skill name="${invocation.name}">\n${invocation.content}\n</explicit-skill>`;
}

export function parseSkillInvocation(
	parts: string | null,
): SkillInvocation | null {
	if (!parts) return null;
	try {
		const value = JSON.parse(parts) as { solarSkillInvocation?: unknown };
		const invocation = value.solarSkillInvocation;
		return invocation &&
			typeof invocation === "object" &&
			typeof (invocation as SkillInvocation).name === "string" &&
			SKILL_NAME_PATTERN.test((invocation as SkillInvocation).name) &&
			typeof (invocation as SkillInvocation).content === "string"
			? (invocation as SkillInvocation)
			: null;
	} catch {
		return null;
	}
}

export function contextualUserText(text: string, parts: string | null): string {
	const invocation = parseSkillInvocation(parts);
	return invocation ? `${text}${skillInvocationContext(invocation)}` : text;
}

export async function listExposedSkills(userId: string) {
	return db
		.selectFrom("skill")
		.select(["name", "description", "content"])
		.where("userId", "=", userId)
		.where("exposed", "=", 1)
		.orderBy("name", "asc")
		.execute();
}

export function skillCatalogContext(
	skills: { name: string; description: string }[],
): string | null {
	if (!skills.length) return null;
	return `<available-skills>\n${skills.map((skill) => `- ${skill.name}: ${escapeXml(skill.description)}`).join("\n")}\n</available-skills>\nThe skills above are available to you. Use read_skill(name) only to read an exposed skill when its full instructions are needed.`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
