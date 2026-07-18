import { afterEach, describe, expect, mock, test } from "bun:test";

type AttachmentRow = {
  id: string;
  userId: string;
  messageId: string | null;
  filename: string;
  mimeType: string;
  kind: "image" | "text";
  byteSize: number;
  storageKey: string;
  createdAt: string;
};

type WhereClause = [string, string, unknown];

const files = new Map<string, Uint8Array>();
const rows = new Map<string, AttachmentRow>();
const queryLog: { operation: string; where: WhereClause[] }[] = [];

function filterRows(where: WhereClause[]) {
  return [...rows.values()].filter((row) => where.every(([column, operator, value]) => {
    if (operator === "in") return (value as string[]).includes(row[column as keyof AttachmentRow] as string);
    if (operator === "is") return row[column as keyof AttachmentRow] === value;
    return row[column as keyof AttachmentRow] === value;
  }));
}

function selectQuery() {
  const where: WhereClause[] = [];
  const query = {
    select: () => query,
    selectAll: () => query,
    where: (column: string, operator: string, value: unknown) => {
      where.push([column, operator, value]);
      return query;
    },
    orderBy: () => query,
    execute: async () => {
      queryLog.push({ operation: "select", where });
      return filterRows(where);
    },
    executeTakeFirst: async () => {
      queryLog.push({ operation: "select", where });
      return filterRows(where)[0];
    },
  };
  return query;
}

const db = {
  insertInto: () => ({
    values: (row: AttachmentRow) => ({
      execute: async () => {
        rows.set(row.id, row);
      },
    }),
  }),
  selectFrom: () => selectQuery(),
  updateTable: () => {
    const where: WhereClause[] = [];
    let changes: Partial<AttachmentRow> = {};
    const query = {
      set: (value: Partial<AttachmentRow>) => {
        changes = value;
        return query;
      },
      where: (column: string, operator: string, value: unknown) => {
        where.push([column, operator, value]);
        return query;
      },
      execute: async () => {
        queryLog.push({ operation: "update", where });
        for (const row of filterRows(where)) Object.assign(row, changes);
      },
    };
    return query;
  },
  deleteFrom: () => ({
    where: (column: string, operator: string, value: unknown) => ({
      execute: async () => {
        queryLog.push({ operation: "delete", where: [[column, operator, value]] });
        for (const row of filterRows([[column, operator, value]])) rows.delete(row.id);
      },
    }),
  }),
};

mock.module("../config", () => ({ config: { attachmentsDataDir: "/test/attachments" } }));
mock.module("../db", () => ({ db }));
mock.module("@struktoai/mirage-node", () => ({
  DiskResource: class {
    open = async () => {};
    mkdir = async () => {};
    writeFile = async (path: { toString(): string }, bytes: Uint8Array) => {
      files.set(path.toString(), bytes);
    };
    readFile = async (path: { toString(): string }) => {
      const bytes = files.get(path.toString());
      if (!bytes) throw new Error("missing file");
      return bytes;
    };
    unlink = async (path: { toString(): string }) => {
      files.delete(path.toString());
    };
  },
  PathSpec: { fromStrPath: (value: string) => ({ toString: () => value }) },
}));

const attachments = await import("./attachments");

function row(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: "attachment-1",
    userId: "user-1",
    messageId: "message-1",
    filename: "note.txt",
    mimeType: "text/plain",
    kind: "text",
    byteSize: 0,
    storageKey: "user-1/attachment-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  files.clear();
  rows.clear();
  queryLog.length = 0;
});

describe("attachments", () => {
  test("saves image and text MIME types with their classified kinds", async () => {
    const image = await attachments.saveAttachment({
      userId: "user-1", filename: "photo.png", mimeType: "image/png", bytes: new Uint8Array([1]),
    });
    const text = await attachments.saveAttachment({
      userId: "user-1", filename: "note.txt", mimeType: "text/plain", bytes: new Uint8Array([2]),
    });

    expect(image.kind).toBe("image");
    expect(text.kind).toBe("text");
    expect([...rows.values()].map((saved) => saved.kind)).toEqual(["image", "text"]);
  });

  test("rejects unsupported MIME types before writing a file or row", async () => {
    await expect(attachments.saveAttachment({
      userId: "user-1", filename: "report.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]),
    })).rejects.toThrow("Unsupported file type: application/pdf");

    expect(files).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  test("rejects files larger than 20 MB before writing a file or row", async () => {
    await expect(attachments.saveAttachment({
      userId: "user-1", filename: "large.txt", mimeType: "text/plain", bytes: new Uint8Array(20 * 1024 * 1024 + 1),
    })).rejects.toThrow("File exceeds the 20 MB limit");

    expect(files).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  test("only reads attachments belonging to the requesting user", async () => {
    rows.set("attachment-1", row());
    files.set("/user-1/attachment-1", new Uint8Array([7]));

    expect(await attachments.readAttachment("attachment-1", "other-user")).toBeNull();
    expect(queryLog.at(-1)?.where).toContainEqual(["userId", "=", "other-user"]);
  });

  test("links only the user's orphaned attachments", async () => {
    rows.set("orphan", row({ id: "orphan", messageId: null }));
    rows.set("linked", row({ id: "linked", messageId: "existing-message" }));
    rows.set("other-user", row({ id: "other-user", userId: "user-2", messageId: null }));

    await attachments.linkAttachments(["orphan", "linked", "other-user"], "user-1", "message-2");

    expect(rows.get("orphan")?.messageId).toBe("message-2");
    expect(rows.get("linked")?.messageId).toBe("existing-message");
    expect(rows.get("other-user")?.messageId).toBeNull();
  });

  test("does not remove another user's orphan attachment", async () => {
    rows.set("attachment-1", row({ messageId: null }));
    files.set("/user-1/attachment-1", new Uint8Array([1]));

    expect(await attachments.removeOrphanAttachment("attachment-1", "other-user")).toBeFalse();
    expect(rows).toHaveLength(1);
    expect(files).toHaveLength(1);
  });

  test("builds base64 image parts and wrapped UTF-8 text parts", async () => {
    rows.set("image", row({ id: "image", filename: "photo.png", mimeType: "image/png", kind: "image", storageKey: "user-1/image" }));
    rows.set("text", row({ id: "text", filename: "note.txt", storageKey: "user-1/text" }));
    files.set("/user-1/image", new Uint8Array([0, 1, 2]));
    files.set("/user-1/text", new TextEncoder().encode("Hello, Solar!"));

    await expect(attachments.loadAttachmentContentParts("message-1")).resolves.toEqual([
      { type: "image", data: "AAEC", mimeType: "image/png" },
      { type: "text", text: '<attachment name="note.txt">\nHello, Solar!\n</attachment>' },
    ]);
  });

  test("returns no content parts without attachments", async () => {
    await expect(attachments.loadAttachmentContentParts("missing-message")).resolves.toEqual([]);
  });
});
