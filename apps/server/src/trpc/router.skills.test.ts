import { beforeEach, describe, expect, mock, test } from "bun:test";

type SkillRow = {
	id: string;
	userId: string;
	name: string;
	description: string;
	content: string;
	exposed: number;
	createdAt: string;
	updatedAt: string;
};

let skills: SkillRow[] = [];
let forceUniqueError = false;

function skillQuery() {
	const filters: [keyof SkillRow, unknown][] = [];
	const builder = {
		select: () => builder,
		selectAll: () => builder,
		orderBy: () => builder,
		where: (key: keyof SkillRow, _op: string, value: unknown) => {
			filters.push([key, value]);
			return builder;
		},
		execute: async () =>
			skills
				.filter((skill) =>
					filters.every(([key, value]) => skill[key] === value),
				)
				.sort((a, b) => a.name.localeCompare(b.name)),
		executeTakeFirst: async () =>
			skills.find((skill) =>
				filters.every(([key, value]) => skill[key] === value),
			),
	};
	return builder;
}

mock.module("../db", () => ({
	db: {
		selectFrom: () => skillQuery(),
		insertInto: () => ({
			values: (row: SkillRow) => ({
				execute: async () => {
					if (forceUniqueError) {
						const error = new Error(
							"UNIQUE constraint failed: skill.userId, skill.name",
						);
						forceUniqueError = false;
						throw error;
					}
					skills.push(row);
				},
			}),
		}),
		updateTable: () => {
			const filters: [keyof SkillRow, unknown][] = [];
			let updates: Partial<SkillRow> = {};
			const builder = {
				set: (value: Partial<SkillRow>) => {
					updates = value;
					return builder;
				},
				where: (key: keyof SkillRow, _op: string, value: unknown) => {
					filters.push([key, value]);
					return builder;
				},
				executeTakeFirst: async () => {
					const rows = skills.filter((skill) =>
						filters.every(([key, value]) => skill[key] === value),
					);
					for (const row of rows) Object.assign(row, updates);
					return { numUpdatedRows: BigInt(rows.length) };
				},
			};
			return builder;
		},
		deleteFrom: () => {
			const filters: [keyof SkillRow, unknown][] = [];
			const builder = {
				where: (key: keyof SkillRow, _op: string, value: unknown) => {
					filters.push([key, value]);
					return builder;
				},
				executeTakeFirst: async () => {
					const before = skills.length;
					skills = skills.filter(
						(skill) => !filters.every(([key, value]) => skill[key] === value),
					);
					return { numDeletedRows: BigInt(before - skills.length) };
				},
			};
			return builder;
		},
	},
	sqlite: {},
}));
mock.module("../auth", () => ({
	createSolarApiKey: async () => ({ id: "key", key: "sk_solar_test" }),
	createSolarUser: async () => {},
	setSolarUserPassword: async () => true,
}));
mock.module("../chat/attachments", () => ({
	deleteAttachmentFilesForMessages: async () => {},
	deleteAttachmentFilesForUser: async () => {},
}));

const { appRouter } = await import("./router");

const content = `---
name: release-notes
description: Draft release notes.
---
# Release notes
`;

describe("skill router", () => {
	beforeEach(() => {
		skills = [];
		forceUniqueError = false;
	});

	test("creates hidden skills and confines CRUD to the owner", async () => {
		const owner = appRouter.createCaller({ user: { id: "owner" } } as never);
		const other = appRouter.createCaller({ user: { id: "other" } } as never);
		const { id } = await owner.skill.create({ content });

		await expect(owner.skill.list()).resolves.toMatchObject([
			{ id, name: "release-notes", exposed: false },
		]);
		await expect(other.skill.get({ id })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			other.skill.setExposed({ id, exposed: true }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await owner.skill.setExposed({ id, exposed: true });
		await expect(owner.skill.get({ id })).resolves.toMatchObject({
			exposed: true,
			content,
		});
		await expect(other.skill.remove({ id })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await owner.skill.remove({ id });
		await expect(owner.skill.list()).resolves.toEqual([]);
	});

	test("maps both duplicate checks and a unique-index race to CONFLICT", async () => {
		const caller = appRouter.createCaller({ user: { id: "owner" } } as never);
		forceUniqueError = true;
		await expect(caller.skill.create({ content })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await caller.skill.create({ content });
		await expect(caller.skill.create({ content })).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	test("requires authentication", async () => {
		const caller = appRouter.createCaller({ user: null } as never);
		await expect(caller.skill.list()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});
