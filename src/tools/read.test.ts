import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readTool } from "./read.ts";
import { resolve } from "path";

const tmpDir = resolve(process.cwd(), "tmp-test-read");
const smallFile = resolve(tmpDir, "small.txt");
const largePaginateFile = resolve(tmpDir, "large-paginate.txt");
const unicodeFile = resolve(tmpDir, "unicode-heavy.txt");
const wideLineFile = resolve(tmpDir, "wide-lines.txt");
const manyLinesFile = resolve(tmpDir, "many-lines.txt");
const bigOffsetFile = resolve(tmpDir, "big-offset.txt");

// JSONL fixtures
const flatJsonl = resolve(tmpDir, "flat.jsonl");
const nestedJsonl = resolve(tmpDir, "nested.jsonl");
const unionJsonl = resolve(tmpDir, "union.jsonl");
const bigRecordJsonl = resolve(tmpDir, "big-record.jsonl");
const malformedJsonl = resolve(tmpDir, "malformed.jsonl");
const singleLineJsonl = resolve(tmpDir, "single.jsonl");
const emptyJsonl = resolve(tmpDir, "empty.jsonl");
const allBadJsonl = resolve(tmpDir, "all-bad.jsonl");
const nonObjectJsonl = resolve(tmpDir, "non-object.jsonl");
const mixedTopJsonl = resolve(tmpDir, "mixed-top.jsonl");
const crlfJsonl = resolve(tmpDir, "crlf.jsonl");

// Field-truncation fixtures
const longFieldJsonl = resolve(tmpDir, "long-field.jsonl");
const nestedLongJsonl = resolve(tmpDir, "nested-long.jsonl");
const arrayLongJsonl = resolve(tmpDir, "array-long.jsonl");

beforeAll(async () => {
  await Bun.write(smallFile, "line0\nline1\nline2\n");

  // large-paginate.txt replaces large.jsonl for pagination tests (plain text, not JSONL)
  const paginateLines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: i }));
  await Bun.write(largePaginateFile, paginateLines.join("\n"));

  // Unicode-heavy file: CJK chars are 3 bytes each in UTF-8
  const cjkLine = "漢字漢字漢字".repeat(50);
  const unicodeLines = Array.from({ length: 200 }, () => cjkLine);
  await Bun.write(unicodeFile, unicodeLines.join("\n"));

  // Wide-lines file: 1500 lines but >50KB total
  const wideLine = "x".repeat(40);
  const wideLines = Array.from({ length: 1500 }, () => wideLine);
  await Bun.write(wideLineFile, wideLines.join("\n"));

  // Many-lines file: 3000 lines but <50KB total
  const manyLines = Array.from({ length: 3000 }, (_, i) => `line${i}`);
  await Bun.write(manyLinesFile, manyLines.join("\n"));

  // Big-offset file: 10000 lines
  const bigLines = Array.from({ length: 10000 }, (_, i) => `row${String(i).padStart(5, "0")}`);
  await Bun.write(bigOffsetFile, bigLines.join("\n"));

  // ── JSONL fixtures ──

  // Flat records
  const flatLines = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ a: i, b: `val${i}` }),
  );
  await Bun.write(flatJsonl, flatLines.join("\n"));

  // Nested records
  const nestedLines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ id: i, meta: { tags: ["x", "y"], score: i * 0.1 } }),
  );
  await Bun.write(nestedJsonl, nestedLines.join("\n"));

  // Type union: field is number in some, null in others
  const unionLines = [
    JSON.stringify({ x: 1, y: "a" }),
    JSON.stringify({ x: null, y: "b" }),
    JSON.stringify({ x: 3, y: "c", z: true }),
  ];
  await Bun.write(unionJsonl, unionLines.join("\n"));

  // Big record: single record >8KB
  const bigObj = { data: "x".repeat(10000) };
  await Bun.write(bigRecordJsonl, [
    JSON.stringify(bigObj),
    JSON.stringify(bigObj),
    JSON.stringify(bigObj),
  ].join("\n"));

  // Mixed valid/malformed
  await Bun.write(malformedJsonl, [
    JSON.stringify({ ok: 1 }),
    "not json at all",
    JSON.stringify({ ok: 2 }),
    "{broken",
    JSON.stringify({ ok: 3 }),
  ].join("\n"));

  // Single line
  await Bun.write(singleLineJsonl, JSON.stringify({ solo: true }));

  // Empty file
  await Bun.write(emptyJsonl, "");

  // All malformed
  await Bun.write(allBadJsonl, "bad1\nbad2\nbad3\n");

  // Non-object top-level: bare strings, numbers, arrays
  await Bun.write(nonObjectJsonl, [
    JSON.stringify("hello"),
    JSON.stringify(42),
    JSON.stringify([1, 2, 3]),
  ].join("\n"));

  // CRLF line endings
  await Bun.write(crlfJsonl,
    `{"a":1}\r\n{"a":2}\r\n{"a":3}\r\n`,
  );

  // Mixed object / non-object
  await Bun.write(mixedTopJsonl, [
    JSON.stringify({ a: 1 }),
    JSON.stringify("just a string"),
    JSON.stringify([10, 20]),
  ].join("\n"));

  // ── Field-truncation fixtures ──

  // Long string field (300 chars) + short field
  const longStr = "x".repeat(300);
  await Bun.write(longFieldJsonl, JSON.stringify({ body: longStr, id: 1 }));

  // Nested object with a long string
  await Bun.write(nestedLongJsonl, JSON.stringify({ meta: { description: longStr }, id: 2 }));

  // Array of long strings
  await Bun.write(arrayLongJsonl, JSON.stringify({ items: [longStr, longStr], n: 5 }));
});

afterAll(async () => {
  const proc = Bun.spawnSync(["rm", "-rf", tmpDir]);
  if (proc.exitCode !== 0) throw new Error("cleanup failed");
});

// ── Existing read tool tests (non-JSONL) ──

describe("read tool", () => {
  test("reads a small file — all lines returned", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/small.txt" });
    const text = result.content[0].text;
    expect(text).toContain("line0");
    expect(text).toContain("line2");
    expect(text).not.toContain("[Showing lines");
    expect(result.details).not.toBeNull();
    expect(result.details!.totalLines).toBe(4);
    expect(result.details!.returnedLines).toBe(4);
    expect(result.details!.format).toBe("txt");
  });

  test("file not found returns error in content", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/nope.txt" });
    expect(result.content[0].text).toContain("File not found");
    expect(result.details).toBeNull();
  });

  test("path traversal returns error in content", async () => {
    const result = await readTool.execute("test", { path: "../../etc/passwd" });
    expect(result.content[0].text).toContain("escapes project root");
    expect(result.details).toBeNull();
  });

  test("sibling-directory prefix collision is blocked", async () => {
    const cwd = process.cwd();
    const result = await readTool.execute("test", { path: `${cwd}-secrets/foo.txt` });
    expect(result.content[0].text).toContain("escapes project root");
    expect(result.details).toBeNull();
  });

  test("pagination with offset and limit", async () => {
    const result = await readTool.execute("test", {
      path: "tmp-test-read/large-paginate.txt",
      offset: 5,
      limit: 10,
    });
    const text = result.content[0].text;
    expect(text).toContain('"id":5');
    expect(text).toContain('"id":14');
    expect(text).not.toContain('"id":4');
    expect(text).not.toContain('"id":15');
    expect(text).toContain("[Showing lines 5-14 of 50. Call read again with offset=15 to continue.]");
  });

  test("multi-byte characters: byte limit hit before line limit", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/unicode-heavy.txt" });
    const d = result.details!;
    expect(d.returnedLines).toBeLessThan(200);
    expect(d.returnedBytes).toBeLessThanOrEqual(50 * 1024);
    expect(d.totalLines).toBe(200);
    const text = result.content[0].text;
    expect(text).toContain("(50KB byte limit reached)");
  });

  test("offset + byte cap applies to returned chunk only", async () => {
    const result = await readTool.execute("test", {
      path: "tmp-test-read/big-offset.txt",
      offset: 5000,
      limit: 3000,
    });
    const d = result.details!;
    expect(d.returnedLines).toBe(3000);
    expect(d.returnedBytes).toBeLessThanOrEqual(50 * 1024);
    const text = result.content[0].text;
    expect(text).toContain("row05000");
    expect(text).toContain("row07999");
    expect(text).not.toContain("row04999");
  });

  test("line limit hit — no byte limit message", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/many-lines.txt" });
    const d = result.details!;
    expect(d.returnedLines).toBe(2000);
    expect(d.totalLines).toBe(3000);
    const text = result.content[0].text;
    expect(text).toContain("[Showing lines 0-1999 of 3000.");
    expect(text).not.toContain("byte limit");
  });

  test("byte limit hit — message indicates byte limit", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/wide-lines.txt" });
    const d = result.details!;
    expect(d.returnedLines).toBeLessThan(1500);
    expect(d.returnedBytes).toBeLessThanOrEqual(50 * 1024);
    expect(d.totalLines).toBe(1500);
    const text = result.content[0].text;
    expect(text).toContain("(50KB byte limit reached)");
  });
});

// ── JSONL manifest tests ──

describe("read tool — JSONL manifest", () => {
  test("basic manifest structure", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/flat.jsonl" });
    const text = result.content[0].text;
    expect(text).toContain("[JSONL Manifest:");
    expect(text).toContain("rows:");
    expect(text).toContain("schema:");
    expect(text).toContain("samples:");
  });

  test("flat schema inference", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/flat.jsonl" });
    const d = result.details!;
    expect(d.format).toBe("jsonl");
    expect(d.rows).toBe(20);
    expect(d.schema).toEqual({ object: { a: "number", b: "string" } });
    expect(d.samplesReturned).toBe(3);
    expect(d.schemaInferredFrom).toBe(10);
    expect(d.malformedLines).toBe(0);
  });

  test("nested schema inference", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/nested.jsonl" });
    const d = result.details!;
    expect(d.schema).toEqual({
      object: {
        id: "number",
        meta: {
          object: {
            score: "number",
            tags: { array: "string" },
          },
        },
      },
    });
  });

  test("type union — mixed shapes", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/union.jsonl" });
    const d = result.details!;
    const schema = d.schema as { object: Record<string, any> };
    expect(schema.object.x).toEqual(["null", "number"]);
    expect(schema.object.y).toBe("string");
    expect(schema.object.z).toBe("boolean");
  });

  test("sample budget exceeded — truncation", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/big-record.jsonl" });
    const d = result.details!;
    expect(d.samplesReturned).toBe(1);
    const text = result.content[0].text;
    expect(text).toContain("…[truncated]");
  });

  test("malformed lines — samples from valid records only", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/malformed.jsonl" });
    const d = result.details!;
    expect(d.rows).toBe(5);
    expect(d.malformedLines).toBe(2);
    expect(d.schemaInferredFrom).toBe(3);
    expect(d.samplesReturned).toBe(3);
    // Samples should only contain valid records
    const text = result.content[0].text;
    expect(text).toContain('"ok"');
    expect(text).not.toContain("not json at all");
    expect(text).not.toContain("{broken");
  });

  test("single-line file — 1 sample, no duplicates", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/single.jsonl" });
    const d = result.details!;
    expect(d.rows).toBe(1);
    expect(d.samplesReturned).toBe(1);
    expect(d.schema).toEqual({ object: { solo: "boolean" } });
  });

  test("empty file", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/empty.jsonl" });
    const d = result.details!;
    expect(d.rows).toBe(0);
    expect(d.samplesReturned).toBe(0);
    const text = result.content[0].text;
    expect(text).toContain("empty");
  });

  test("all-malformed file — degraded structured details", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/all-bad.jsonl" });
    const d = result.details!;
    expect(d.format).toBe("jsonl");
    expect(d.rows).toBe(3);
    expect(d.samplesReturned).toBe(0);
    expect(d.schemaInferredFrom).toBe(0);
    expect(d.malformedLines).toBe(3);
    expect(d.schema).toBe("unknown");
    const text = result.content[0].text;
    expect(text).toContain("malformed");
  });

  test("offset/limit ignored — full manifest with notice", async () => {
    const result = await readTool.execute("test", {
      path: "tmp-test-read/flat.jsonl",
      offset: 5,
      limit: 2,
    });
    const d = result.details!;
    expect(d.rows).toBe(20);
    expect(d.samplesReturned).toBe(3);
    const text = result.content[0].text;
    expect(text).toContain("offset/limit do not apply to JSONL manifests");
    expect(text).toContain("bash");
  });

  test("no offset/limit notice when params omitted", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/flat.jsonl" });
    const text = result.content[0].text;
    expect(text).not.toContain("offset/limit do not apply");
  });

  test("non-object top-level records", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/non-object.jsonl" });
    const d = result.details!;
    expect(d.rows).toBe(3);
    // Schema should be a union of string, number, and array
    const schema = d.schema as any[];
    expect(Array.isArray(schema)).toBe(true);
    expect(schema).toContainEqual("string");
    expect(schema).toContainEqual("number");
    expect(schema).toContainEqual({ array: "number" });
  });

  test("mixed object and non-object records", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/mixed-top.jsonl" });
    const d = result.details!;
    expect(d.rows).toBe(3);
    const schema = d.schema as any[];
    expect(Array.isArray(schema)).toBe(true);
    // Should contain the object type, string, and array type
    expect(schema).toContainEqual({ object: { a: "number" } });
    expect(schema).toContainEqual("string");
    expect(schema).toContainEqual({ array: "number" });
  });

  test("CRLF line endings — \\r stripped from samples", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/crlf.jsonl" });
    const d = result.details!;
    expect(d.rows).toBe(3);
    expect(d.malformedLines).toBe(0);
    const text = result.content[0].text;
    expect(text).not.toContain("\r");
    expect(text).toContain('"a":1');
  });

  test("details object has correct shape for JSONL", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/flat.jsonl" });
    const d = result.details!;
    expect(d.path).toBe(resolve(process.cwd(), "tmp-test-read/flat.jsonl"));
    expect(d.sizeKB).toBeGreaterThan(0);
    expect(d.format).toBe("jsonl");
    expect(d.rows).toBe(20);
    expect(typeof d.samplesReturned).toBe("number");
    expect(typeof d.schemaInferredFrom).toBe("number");
    expect(typeof d.malformedLines).toBe("number");
    expect(d.schema).toBeDefined();
  });
});

// ── Field-value truncation tests ──

describe("read tool — JSONL field-value truncation", () => {
  test("long string field is truncated at 200 chars", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/long-field.jsonl" });
    const text = result.content[0].text;
    const sample = text.split("--- record 0 ---\n")[1];
    const parsed = JSON.parse(sample);
    expect(parsed.body).toHaveLength(200 + "…[truncated]".length);
    expect(parsed.body).toEndWith("…[truncated]");
  });

  test("short fields are untouched", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/long-field.jsonl" });
    const text = result.content[0].text;
    const sample = text.split("--- record 0 ---\n")[1];
    const parsed = JSON.parse(sample);
    expect(parsed.id).toBe(1);
  });

  test("nested object — long string truncated recursively", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/nested-long.jsonl" });
    const text = result.content[0].text;
    const sample = text.split("--- record 0 ---\n")[1];
    const parsed = JSON.parse(sample);
    expect(parsed.meta.description).toEndWith("…[truncated]");
    expect(parsed.meta.description.length).toBeLessThanOrEqual(200 + "…[truncated]".length);
    expect(parsed.id).toBe(2);
  });

  test("array elements — each long string truncated", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/array-long.jsonl" });
    const text = result.content[0].text;
    const sample = text.split("--- record 0 ---\n")[1];
    const parsed = JSON.parse(sample);
    expect(parsed.items).toHaveLength(2);
    for (const item of parsed.items) {
      expect(item).toEndWith("…[truncated]");
      expect(item.length).toBeLessThanOrEqual(200 + "…[truncated]".length);
    }
    expect(parsed.n).toBe(5);
  });

  test("non-string fields are unchanged", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/flat.jsonl" });
    const text = result.content[0].text;
    // flat.jsonl has short fields — samples should contain valid JSON with original values
    const sampleSection = text.split("samples:\n")[1];
    const firstSample = sampleSection.split("\n--- record")[0].replace(/^--- record \d+ ---\n/, "");
    const parsed = JSON.parse(firstSample);
    expect(typeof parsed.a).toBe("number");
    expect(typeof parsed.b).toBe("string");
  });
});
