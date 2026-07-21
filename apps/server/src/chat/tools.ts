import { resolveBuiltinTools, type UserLocation } from "./builtins";
import { resolveMcpTools, type ResolvedTool } from "./mcp";
import { Type } from "@earendil-works/pi-ai";
import { listExposedSkills, skillInstructions } from "./skills";

export interface ToolResolutionContext {
	userId: string;
	conversationId: string;
	userLocation?: UserLocation;
}

export interface ToolProvider {
	resolve(context: ToolResolutionContext): Promise<ResolvedTool[]>;
}

class BuiltinToolProvider implements ToolProvider {
	async resolve(context: ToolResolutionContext): Promise<ResolvedTool[]> {
		return resolveBuiltinTools(context.userLocation);
	}
}

class McpToolProvider implements ToolProvider {
	async resolve(context: ToolResolutionContext): Promise<ResolvedTool[]> {
		return resolveMcpTools(context.userId, context.conversationId);
	}
}

class SkillToolProvider implements ToolProvider {
	async resolve(context: ToolResolutionContext): Promise<ResolvedTool[]> {
		const skills = await listExposedSkills(context.userId);
		return resolveSkillTools(skills);
	}
}

export function resolveSkillTools(
	skills: { name: string; content: string }[],
): ResolvedTool[] {
	if (!skills.length) return [];
	return [
		{
			tool: {
				name: "read_skill",
				description:
					"Read the complete SKILL.md instructions for one of the user's exposed skills.",
				parameters: Type.Object({
					name: Type.Union(
						skills.map((skill) => Type.Literal(skill.name)),
						{ description: "Exposed skill name." },
					),
				}),
			},
			serverName: "builtin",
			remoteName: "read_skill",
			execute: async (args) => {
				if (!args || typeof args.name !== "string")
					return {
						content: "Skill is not exposed or does not exist.",
						isError: true,
					};
				const skill = skills.find((candidate) => candidate.name === args.name);
				return skill
					? { content: skillInstructions(skill.content), isError: false }
					: {
							content: "Skill is not exposed or does not exist.",
							isError: true,
						};
			},
		},
	];
}

class CompositeToolProvider implements ToolProvider {
	constructor(private readonly providers: ToolProvider[]) {}

	async resolve(context: ToolResolutionContext): Promise<ResolvedTool[]> {
		const lists = await Promise.all(
			this.providers.map((provider) => provider.resolve(context)),
		);
		return lists.flat();
	}
}

export const toolProvider = new CompositeToolProvider([
	new BuiltinToolProvider(),
	new SkillToolProvider(),
	new McpToolProvider(),
]);
