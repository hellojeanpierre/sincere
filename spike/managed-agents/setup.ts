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

await Bun.write("spike.env", `AGENT_ID=${AGENT_ID}\nENVIRONMENT_ID=${environment.id}\n`);
console.log("Saved to spike.env");
