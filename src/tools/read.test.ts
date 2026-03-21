import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readTool } from "./read.ts";
import { resolve } from "path";

const tmpDir = resolve(process.cwd(), "tmp-test-read");
const smallFile = resolve(tmpDir, "small.txt");
const largeFile = resolve(tmpDir, "large.jsonl");

beforeAll(async () => {
  await Bun.write(smallFile, "line0\nline1\nline2\n");
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: i }));
  await Bun.write(largeFile, lines.join("\n"));
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
  });
});
