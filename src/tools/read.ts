import { resolve, extname } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { logger } from "../lib/logger.ts";

const readSchema = Type.Object({
  path: Type.String({ description: "File path relative to project root, or absolute" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start from (0-based). Default: 0" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max lines to return. Default: 2000" }),
  ),
});

export const readTool: AgentTool<typeof readSchema> = {
  name: "read",
  label: "Read File",
  description:
    "Read a UTF-8 text file from disk. Returns file contents with line-based pagination. Supports .md, .json, .jsonl, .csv, .txt, .html and similar text formats. Default reads first 2000 lines. Use offset and limit for large files.",
  parameters: readSchema,
  async execute(_toolCallId, params) {
    const projectRoot = process.cwd();
    const resolvedPath = resolve(projectRoot, params.path);

    if (!resolvedPath.startsWith(projectRoot)) {
      return {
        content: [{ type: "text", text: `Error: path escapes project root: ${params.path}` }],
        details: null,
      };
    }

    const file = Bun.file(resolvedPath);
    const exists = await file.exists();
    if (!exists) {
      return {
        content: [{ type: "text", text: `File not found: ${params.path}` }],
        details: null,
      };
    }

    const raw = await file.text();
    const sizeKB = Math.round((Buffer.byteLength(raw, "utf-8") / 1024) * 100) / 100;
    const format = extname(resolvedPath).replace(".", "") || "txt";
    const lines = raw.split("\n");
    const totalLines = lines.length;

    const offset = params.offset ?? 0;
    const limit = params.limit ?? 2000;
    const slice = lines.slice(offset, offset + limit);
    const returnedLines = slice.length;

    let text = slice.join("\n");

    if (offset + returnedLines < totalLines) {
      const nextOffset = offset + returnedLines;
      text += `\n\n[Showing lines ${offset}-${offset + returnedLines} of ${totalLines}. Call read again with offset=${nextOffset} to continue.]`;
    }

    logger.info({ path: resolvedPath, sizeKB, totalLines, returnedLines }, "read file");

    return {
      content: [{ type: "text", text }],
      details: { path: resolvedPath, sizeKB, format, totalLines, returnedLines },
    };
  },
};
