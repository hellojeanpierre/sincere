import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readTool } from "./read.ts";
import { resolve } from "path";

const tmpDir = resolve(process.cwd(), "tmp-test-read");
const smallFile = resolve(tmpDir, "small.txt");
const largeFile = resolve(tmpDir, "large.jsonl");
const unicodeFile = resolve(tmpDir, "unicode-heavy.txt");
const wideLineFile = resolve(tmpDir, "wide-lines.txt");
const manyLinesFile = resolve(tmpDir, "many-lines.txt");
const bigOffsetFile = resolve(tmpDir, "big-offset.txt");

beforeAll(async () => {
  await Bun.write(smallFile, "line0\nline1\nline2\n");
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: i }));
  await Bun.write(largeFile, lines.join("\n"));

  // Unicode-heavy file: CJK chars are 3 bytes each in UTF-8, emoji are 4 bytes
  // ~200 lines of 300 CJK chars each = 200 * 900 bytes = ~180KB, well over 50KB
  const cjkLine = "漢字漢字漢字".repeat(50); // 300 CJK chars = 900 bytes per line
  const unicodeLines = Array.from({ length: 200 }, () => cjkLine);
  await Bun.write(unicodeFile, unicodeLines.join("\n"));

  // Wide-lines file: 1500 lines but >50KB total (each line ~40 bytes)
  const wideLine = "x".repeat(40);
  const wideLines = Array.from({ length: 1500 }, () => wideLine);
  await Bun.write(wideLineFile, wideLines.join("\n"));

  // Many-lines file: 3000 lines but <50KB total (each line ~10 bytes)
  const manyLines = Array.from({ length: 3000 }, (_, i) => `line${i}`);
  await Bun.write(manyLinesFile, manyLines.join("\n"));

  // Big-offset file: 10000 lines, each ~10 bytes
  const bigLines = Array.from({ length: 10000 }, (_, i) => `row${String(i).padStart(5, "0")}`);
  await Bun.write(bigOffsetFile, bigLines.join("\n"));
});

afterAll(async () => {
  const proc = Bun.spawnSync(["rm", "-rf", tmpDir]);
  if (proc.exitCode !== 0) throw new Error("cleanup failed");
});

describe("read tool", () => {
  test("reads a small file — all lines returned", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/small.txt" });
    const text = result.content[0].text;
    expect(text).toContain("line0");
    expect(text).toContain("line2");
    expect(text).not.toContain("[Showing lines");
    expect(result.details).not.toBeNull();
    expect(result.details!.totalLines).toBe(4); // 3 lines + trailing newline
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
      path: "tmp-test-read/large.jsonl",
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

  test("details object has correct shape and values", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/large.jsonl" });
    const d = result.details!;
    expect(d.path).toBe(resolve(process.cwd(), "tmp-test-read/large.jsonl"));
    expect(d.sizeKB).toBeGreaterThan(0);
    expect(d.format).toBe("jsonl");
    expect(d.totalLines).toBe(50);
    expect(d.returnedLines).toBe(50);
    expect(d.returnedBytes).toBeGreaterThan(0);
  });

  test("multi-byte characters: byte limit hit before line limit", async () => {
    const result = await readTool.execute("test", { path: "tmp-test-read/unicode-heavy.txt" });
    const d = result.details!;
    // 200 lines of 900 bytes each — should hit 50KB well before 2000-line limit
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
    // Each line is ~10 bytes, 3000 lines = ~30KB, well under 50KB
    // Byte budget should count from offset, not from file start
    expect(d.returnedLines).toBe(3000);
    expect(d.returnedBytes).toBeLessThanOrEqual(50 * 1024);
    const text = result.content[0].text;
    expect(text).toContain("row05000");
    expect(text).toContain("row07999");
    expect(text).not.toContain("row04999");
  });

  test("line limit hit — no byte limit message", async () => {
    // 3000 lines of ~10 bytes each = ~30KB, under 50KB but over 2000-line default
    const result = await readTool.execute("test", { path: "tmp-test-read/many-lines.txt" });
    const d = result.details!;
    expect(d.returnedLines).toBe(2000);
    expect(d.totalLines).toBe(3000);
    const text = result.content[0].text;
    expect(text).toContain("[Showing lines 0-1999 of 3000.");
    expect(text).not.toContain("byte limit");
  });

  test("byte limit hit — message indicates byte limit", async () => {
    // 1500 lines of 40 bytes each = 60KB, over 50KB but under 2000-line default
    const result = await readTool.execute("test", { path: "tmp-test-read/wide-lines.txt" });
    const d = result.details!;
    expect(d.returnedLines).toBeLessThan(1500);
    expect(d.returnedBytes).toBeLessThanOrEqual(50 * 1024);
    expect(d.totalLines).toBe(1500);
    const text = result.content[0].text;
    expect(text).toContain("(50KB byte limit reached)");
  });
});
