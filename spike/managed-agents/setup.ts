import { join } from "path";
import { apiPost } from "./types";

const AGENT_ID = "agent_011Ca3dfRMVdQFpUVvur2fFD";

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

// Append to root .env so all scripts (spike and project) can read the values.
const rootEnv = join(import.meta.dir, "..", "..", ".env");
const existing = await Bun.file(rootEnv).text().catch(() => "");
const lines = existing.split("\n");
const filtered = lines.filter((l) => !l.startsWith("AGENT_ID=") && !l.startsWith("ENVIRONMENT_ID="));
filtered.push(`AGENT_ID=${AGENT_ID}`, `ENVIRONMENT_ID=${environment.id}`, "");
await Bun.write(rootEnv, filtered.join("\n"));
console.log("Saved AGENT_ID and ENVIRONMENT_ID to root .env");
