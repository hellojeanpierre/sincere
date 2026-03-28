import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * Reads config.json from srcDir, validates it, resolves file-backed
 * template vars, and returns a flat Record<string, string> ready for
 * prompt template substitution.
 *
 * Returns an empty record when no config.json exists.
 */
export function resolveConfig(srcDir: string): Record<string, string> {
  const configPath = resolve(srcDir, "config.json");
  if (!existsSync(configPath)) return {};

  const raw: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${configPath}: expected a JSON object`);
  }
  const config = raw as Record<string, unknown>;
  const vars: Record<string, string> = {};

  // Collect plain string values as template vars.
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") vars[key] = value;
  }

  // Resolve rootCauseLibrary → rootCauses template var.
  if (typeof config.rootCauseLibrary === "string") {
    const libPath = resolve(srcDir, config.rootCauseLibrary);
    if (!existsSync(libPath)) {
      throw new Error(`rootCauseLibrary: file not found: ${libPath}`);
    }
    const entries: unknown = JSON.parse(readFileSync(libPath, "utf-8"));
    if (!Array.isArray(entries)) {
      throw new Error(`${libPath}: expected a JSON array`);
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (typeof e?.id !== "string" || typeof e?.description !== "string") {
        throw new Error(`${libPath}[${i}]: each entry must have string id and description`);
      }
    }
    vars.rootCauses = entries
      .map((e: { id: string; description: string }) => `- **${e.id}**: ${e.description}`)
      .join("\n");
    // rootCauseLibrary is a path, not a template var — remove it.
    delete vars.rootCauseLibrary;
  }

  return vars;
}
