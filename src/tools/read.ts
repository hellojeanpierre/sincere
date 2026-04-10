import { resolve, extname, sep } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { logger } from "../lib/logger.ts";

const MAX_BYTES = 50 * 1024; // 50KB
const SCHEMA_SAMPLE_COUNT = 10;
const MAX_SAMPLE_BYTES = 8192;
const MAX_FIELD_CHARS = 200;

// ── JSONL manifest helpers ──────────────────────────────────────────

type SchemaNode =
  | "string" | "number" | "boolean" | "null" | "unknown"
  | { object: Record<string, SchemaNode> }
  | { array: SchemaNode }
  | SchemaNode[];

function inferType(v: unknown): SchemaNode {
  if (v === null) return "null";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) {
    if (v.length === 0) return { array: "unknown" };
    const merged = v.map(inferType).reduce(mergeTypes);
    return { array: merged };
  }
  if (typeof v === "object") {
    const entries = Object.keys(v as Record<string, unknown>).sort().map(
      (k) => [k, inferType((v as Record<string, unknown>)[k])] as const,
    );
    return { object: Object.fromEntries(entries) };
  }
  return "unknown";
}

function mergeTypes(a: SchemaNode, b: SchemaNode): SchemaNode {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;

  // Both objects — merge keys
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a.object), ...Object.keys(b.object)])].sort();
    const merged: Record<string, SchemaNode> = {};
    for (const k of keys) {
      if (k in a.object && k in b.object) merged[k] = mergeTypes(a.object[k], b.object[k]);
      else merged[k] = a.object[k] ?? b.object[k];
    }
    return { object: merged };
  }

  // Both arrays — merge element types
  if (isArr(a) && isArr(b)) return { array: mergeTypes(a.array, b.array) };

  // Otherwise build a union
  const flat: SchemaNode[] = [];
  for (const node of [a, b]) {
    if (Array.isArray(node)) flat.push(...node);
    else flat.push(node);
  }
  // Dedupe by serialized form, sort for determinism
  const seen = new Map<string, SchemaNode>();
  for (const n of flat) seen.set(JSON.stringify(n), n);
  return [...seen.values()].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
}

function isObj(n: SchemaNode): n is { object: Record<string, SchemaNode> } {
  return typeof n === "object" && !Array.isArray(n) && "object" in n;
}
function isArr(n: SchemaNode): n is { array: SchemaNode } {
  return typeof n === "object" && !Array.isArray(n) && "array" in n;
}

function formatSchema(node: SchemaNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return `[${node.map((n) => formatSchema(n, 0)).join(", ")}]`;
  if ("array" in node) return `array<${formatSchema(node.array, 0)}>`;
  if ("object" in node) {
    const entries = Object.entries(node.object);
    if (entries.length === 0) return "object<empty>";
    return entries
      .map(([k, v]) => {
        const valStr = formatSchema(v, indent + 1);
        if (isObj(v)) return `${pad}${k}:\n${valStr}`;
        return `${pad}${k}: ${valStr}`;
      })
      .join("\n");
  }
  return "unknown";
}

interface JsonlManifestDetails {
  path: string;
  sizeKB: number;
  format: "jsonl";
  rows: number;
  samplesReturned: number;
  schemaInferredFrom: number;
  malformedLines: number;
  schema: SchemaNode;
}

function truncateSample(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  let end = maxBytes;
  // If we landed inside a multi-byte character, back up to the lead byte
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
  // Now buf[end - 1] is either ASCII or a lead byte. Check if the lead byte's
  // full sequence fits: 110xxxxx = 2 bytes, 1110xxxx = 3, 11110xxx = 4.
  if (end > 0) {
    const lead = buf[end - 1];
    let expected = 1;
    if (lead >= 0xf0) expected = 4;
    else if (lead >= 0xe0) expected = 3;
    else if (lead >= 0xc0) expected = 2;
    // Drop the lead byte only if its full sequence doesn't fit before maxBytes
    if (end - 1 + expected > maxBytes) end--;
  }
  return buf.subarray(0, end).toString("utf-8") + "…[truncated]";
}

function truncateFieldValues(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) + "…[truncated]" : v;
  }
  if (Array.isArray(v)) return v.map(truncateFieldValues);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = truncateFieldValues(val);
    }
    return out;
  }
  return v;
}

/** Helper: stream lines from a Bun file, yielding each non-empty line. */
async function* streamLines(file: ReturnType<typeof Bun.file>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let leftover = "";
  for await (const chunk of file.stream()) {
    const text = leftover + decoder.decode(chunk, { stream: true });
    const segments = text.split("\n");
    leftover = segments.pop()!;
    for (const line of segments) {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length > 0) yield trimmed;
    }
  }
  if (leftover.length > 0) {
    const trimmed = leftover.endsWith("\r") ? leftover.slice(0, -1) : leftover;
    if (trimmed.length > 0) yield trimmed;
  }
}

/**
 * Build a JSONL manifest via streaming. Never loads the full file into memory.
 *
 * Pass 1: count rows, infer schema from first N valid records, capture first + last valid lines.
 * Pass 2 (partial): stream to the middle valid record and capture it, then stop.
 */
async function buildJsonlManifest(
  file: ReturnType<typeof Bun.file>,
  resolvedPath: string,
  paginationRequested: boolean,
): Promise<{ text: string; details: JsonlManifestDetails }> {
  const sizeKB = Math.round((file.size / 1024) * 100) / 100;
  const fileName = resolvedPath.split("/").pop();

  // ── Pass 1: count, schema, first/last ──
  let rows = 0;
  let malformedLines = 0;
  let schemaInferred = 0;
  let schema: SchemaNode = "unknown";
  let validCount = 0;
  let firstValid: { index: number; text: string } | null = null;
  let lastValid: { index: number; text: string } | null = null;

  for await (const line of streamLines(file)) {
    rows++;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { malformedLines++; continue; }

    if (schemaInferred < SCHEMA_SAMPLE_COUNT) {
      const t = inferType(parsed);
      schema = schemaInferred === 0 ? t : mergeTypes(schema, t);
      schemaInferred++;
    }

    if (validCount === 0) firstValid = { index: rows - 1, text: line };
    lastValid = { index: rows - 1, text: line };
    validCount++;
  }

  if (malformedLines > 0) {
    logger.warn({ malformedLines, path: resolvedPath }, "malformed JSONL lines");
  }

  if (rows === 0) {
    return {
      text: `[JSONL Manifest: ${fileName}]\nrows: 0\n\nFile is empty.`,
      details: { path: resolvedPath, sizeKB, format: "jsonl", rows: 0, samplesReturned: 0, schemaInferredFrom: 0, malformedLines: 0, schema: "unknown" },
    };
  }

  if (validCount === 0) {
    return {
      text: `[JSONL Manifest: ${fileName}]\nrows: ${rows}\n\nAll ${rows} lines are malformed JSON.`,
      details: { path: resolvedPath, sizeKB, format: "jsonl", rows, samplesReturned: 0, schemaInferredFrom: 0, malformedLines, schema: "unknown" },
    };
  }

  // ── Pass 2 (partial): capture middle valid record ──
  let midValid: { index: number; text: string } | null = null;
  const midTarget = Math.floor(validCount / 2);

  if (validCount > 2) {
    let vi = 0;
    let lineIdx = 0;
    for await (const line of streamLines(file)) {
      try { JSON.parse(line); } catch { lineIdx++; continue; }
      if (vi === midTarget) { midValid = { index: lineIdx, text: line }; break; }
      vi++;
      lineIdx++;
    }
  }

  const candidates: { index: number; text: string }[] = [firstValid!];
  if (midValid && midValid.index !== firstValid!.index && midValid.index !== lastValid!.index) {
    candidates.push(midValid);
  }
  if (lastValid!.index !== firstValid!.index) {
    candidates.push(lastValid!);
  }

  // Truncate long field values so samples communicate structure, not usable content.
  for (const c of candidates) {
    try {
      c.text = JSON.stringify(truncateFieldValues(JSON.parse(c.text)));
    } catch {
      // Defensive: should be unreachable but truncate raw text rather than leak full content.
      if (c.text.length > MAX_FIELD_CHARS) {
        c.text = c.text.slice(0, MAX_FIELD_CHARS) + "…[truncated]";
      }
    }
  }

  const samples: { recordIndex: number; text: string }[] = [];
  let sampleBytes = 0;
  for (const c of candidates) {
    const byteLen = Buffer.byteLength(c.text, "utf-8");

    if (samples.length === 0 && byteLen > MAX_SAMPLE_BYTES) {
      samples.push({ recordIndex: c.index, text: truncateSample(c.text, MAX_SAMPLE_BYTES) });
      break;
    }
    if (sampleBytes + byteLen > MAX_SAMPLE_BYTES) break;
    samples.push({ recordIndex: c.index, text: c.text });
    sampleBytes += byteLen;
  }

  const schemaText = formatSchema(schema, 1);
  const sampleBlock = samples
    .map((s) => `--- record ${s.recordIndex} ---\n${s.text}`)
    .join("\n");

  const paginationNote = paginationRequested
    ? "\n\n[offset/limit do not apply to JSONL manifests. Use bash for record-level access.]"
    : "";

  return {
    text: `[JSONL Manifest: ${fileName}]\nrows: ${rows}\nschema:\n${schemaText}\n\nsamples:\n${sampleBlock}${paginationNote}`,
    details: {
      path: resolvedPath,
      sizeKB,
      format: "jsonl",
      rows,
      samplesReturned: samples.length,
      schemaInferredFrom: schemaInferred,
      malformedLines,
      schema,
    },
  };
}

const readSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
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

    const format = extname(resolvedPath).replace(".", "") || "txt";

    if (format === "jsonl") {
      const paginationRequested = params.offset !== undefined || params.limit !== undefined;
      const manifest = await buildJsonlManifest(file, resolvedPath, paginationRequested);
      logger.info({ path: resolvedPath, sizeKB: manifest.details.sizeKB, rows: manifest.details.rows }, "read jsonl manifest");
      return { content: [{ type: "text", text: manifest.text }], details: manifest.details };
    }

    const raw = await file.text();
    const sizeKB = Math.round((Buffer.byteLength(raw, "utf-8") / 1024) * 100) / 100;

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
