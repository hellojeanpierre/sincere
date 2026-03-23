import { readFileSync, globSync } from "fs";
import { resolve } from "path";

export function loadSystemPrompt(srcDir: string): string {
  const operatorPrompt = readFileSync(resolve(srcDir, "operator.md"), "utf-8");
  const skillFiles = globSync(resolve(srcDir, "skills", "*.md"));
  const skills = skillFiles.map((f) => readFileSync(f, "utf-8")).join("\n\n");
  return skills ? `${operatorPrompt}\n\n${skills}` : operatorPrompt;
}
