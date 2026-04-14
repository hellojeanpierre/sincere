import { join } from "path";
import { apiPost, AGENT_ID } from "./types";

const environment = await apiPost<{ id: string }>("/environments", {
  name: `spike-env-${Date.now()}`,
  config: {
    type: "cloud",
    networking: {
      type: "limited",
      allowed_hosts: ["help.pinterest.com"],
    },
  },
});
console.log("Environment created:", environment.id);
console.log("Agent:", AGENT_ID);

// Append ENVIRONMENT_ID to root .env (AGENT_ID is hardcoded in types.ts).
const rootEnv = join(import.meta.dir, "..", "..", ".env");
const existing = await Bun.file(rootEnv).text().catch(() => "");
const lines = existing.split("\n").filter((l) => !l.startsWith("ENVIRONMENT_ID="));
lines.push(`ENVIRONMENT_ID=${environment.id}`, "");
await Bun.write(rootEnv, lines.join("\n"));
console.log("Saved ENVIRONMENT_ID to root .env");
