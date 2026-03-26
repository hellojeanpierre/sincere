import { resolve, extname, sep } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { logger } from "../lib/logger.ts";

const MAX_BYTES = 50 * 1024; // 50KB

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
    "Read a UTF-8 text file from disk. Returns file contents with line-based pagination. Supports .md, .json, .jsonl, .csv, .txt, .html and similar text formats. Output is truncated to 2000 lines or 50KB, whichever is hit first. Use offset and limit for large files.",
  parameters: readSchema,
  async execute(_toolCallId, params) {
    const projectRoot = process.cwd();
    const resolvedPath = resolve(projectRoot, params.path);

    if (resolvedPath !== projectRoot && !resolvedPath.startsWith(projectRoot + sep)) {
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

    const offset = params.offset ?? 0;
    const limit = params.limit ?? 2000;
    const end = offset + limit;

    const sliceLines: string[] = [];
    let lineIndex = 0;
    let pos = 0;
    let bytesCollected = 0;
    let byteLimited = false;

    while (pos <= raw.length) {
      const nextNewline = raw.indexOf("\n", pos);
      const lineEnd = nextNewline === -1 ? raw.length : nextNewline;

      if (lineIndex >= offset && lineIndex < end) {
        const line = raw.slice(pos, lineEnd);
        const lineBytes = Buffer.byteLength(line, "utf-8");
        const separatorBytes = sliceLines.length > 0 ? 1 : 0; // \n between lines
        if (bytesCollected + lineBytes + separatorBytes > MAX_BYTES) {
          byteLimited = true;
          break;
        }
        sliceLines.push(line);
        bytesCollected += lineBytes + separatorBytes;
      }
      lineIndex++;
      pos = lineEnd + 1;
      if (nextNewline === -1) break;
    }

    // If we broke early due to byte limit, still need to count remaining lines
    if (byteLimited) {
      while (pos <= raw.length) {
        const nextNewline = raw.indexOf("\n", pos);
        lineIndex++;
        if (nextNewline === -1) break;
        pos = nextNewline + 1;
      }
    }

    const totalLines = lineIndex;
    const returnedLines = sliceLines.length;
    const returnedBytes = bytesCollected;

    let text = sliceLines.join("\n");

    if (offset + returnedLines < totalLines) {
      const lastLine = offset + returnedLines - 1;
      const nextOffset = offset + returnedLines;
      const reason = byteLimited ? " (50KB byte limit reached)" : "";
      text += `\n\n[Showing lines ${offset}-${lastLine} of ${totalLines}${reason}. Call read again with offset=${nextOffset} to continue.]`;
    }

    logger.info({ path: resolvedPath, sizeKB, totalLines, returnedLines, returnedBytes }, "read file");

    if (params.path.startsWith("skills/") || params.path.includes("/skills/")) {
      const skillName = params.path.replace(/^.*skills\//, "").replace(/\.md$/, "");
      logger.info({ skill: skillName }, "skill selected");
    }

    return {
      content: [{ type: "text", text }],
      details: { path: resolvedPath, sizeKB, format, totalLines, returnedLines, returnedBytes },
    };
  },
};
