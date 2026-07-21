import { describe, expect, test } from "bun:test";
import {
	filterSkills,
	moveSkillSelection,
	parseSkillCommand,
} from "./skillCommands";

const skills = [
	{ name: "release-notes", description: "Draft release notes" },
	{ name: "review", description: "Review code" },
];

describe("skill commands", () => {
	test("filters canonical names only from a leading slash", () => {
		expect(filterSkills("/re", skills).map((skill) => skill.name)).toEqual([
			"release-notes",
			"review",
		]);
		expect(filterSkills(" /re", skills)).toEqual([]);
	});

	test("parses command-only and command request invocations", () => {
		expect(parseSkillCommand("/review", skills)).toEqual({
			skillName: "review",
			text: "",
		});
		expect(parseSkillCommand("/review inspect this", skills)).toEqual({
			skillName: "review",
			text: "inspect this",
		});
	});

	test("leaves unknown and indented commands as ordinary text", () => {
		expect(parseSkillCommand("/unknown request", skills)).toEqual({
			text: "/unknown request",
		});
		expect(parseSkillCommand(" /review request", skills)).toEqual({
			text: " /review request",
		});
		expect(parseSkillCommand("/review /release-notes", skills)).toEqual({
			skillName: "review",
			text: "/release-notes",
		});
		expect(filterSkills("/review request", skills)).toEqual([]);
	});

	test("wraps keyboard selection through matching skills", () => {
		expect(moveSkillSelection(0, -1, 2)).toBe(1);
		expect(moveSkillSelection(1, 1, 2)).toBe(0);
	});
});
