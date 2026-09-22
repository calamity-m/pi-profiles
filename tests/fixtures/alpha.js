import { appendFileSync } from "node:fs";

export default function (pi) {
  const record = (event) => {
    if (process.env.PI_PROFILES_FIXTURE_LOG)
      appendFileSync(process.env.PI_PROFILES_FIXTURE_LOG, `alpha:${event}\n`);
  };
  pi.registerCommand("fixture-alpha", {
    description: "Alpha fixture command",
    handler: async () => {
      record("command");
    },
  });
  pi.registerTool({
    name: "fixture_alpha",
    label: "Alpha",
    description: "Alpha fixture tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "alpha" }], details: {} }),
  });
  pi.on("session_start", () => {
    record("start");
  });
  pi.on("session_shutdown", () => {
    record("shutdown");
  });
  pi.on("session_info_changed", () => {
    record("hook");
  });
}
