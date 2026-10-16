import { describe, expect, test } from "bun:test";
import { sortModelsByName } from "./sortModels";

const model = (name: string, modelId = name.toLowerCase()) => ({
	name,
	modelId,
	provider: "Plexus",
	endpointId: "e",
	api: "openai-completions",
});

describe("sortModelsByName", () => {
	test("sorts A to Z by display name, ignoring case", () => {
		const sorted = sortModelsByName([
			model("kimi-k3"),
			model("Claude Sonnet 5.5"),
			model("gpt-6.1-sol"),
			model("claude-haiku-4-5"),
		]);
		expect(sorted.map((m) => m.name)).toEqual([
			"claude-haiku-4-5",
			"Claude Sonnet 5.5",
			"gpt-6.1-sol",
			"kimi-k3",
		]);
	});

	test("orders numbers by value, so 5.5 comes after 5 and 10 after 9", () => {
		const sorted = sortModelsByName([
			model("glm-10"),
			model("glm-5.3"),
			model("glm-9"),
			model("glm-5"),
		]);
		expect(sorted.map((m) => m.name)).toEqual([
			"glm-5",
			"glm-5.3",
			"glm-9",
			"glm-10",
		]);
	});

	test("breaks ties on the model id and never changes the input", () => {
		const input = [model("Same", "b-id"), model("Same", "a-id")];
		const sorted = sortModelsByName(input);
		expect(sorted.map((m) => m.modelId)).toEqual(["a-id", "b-id"]);
		expect(input.map((m) => m.modelId)).toEqual(["b-id", "a-id"]);
	});
});
