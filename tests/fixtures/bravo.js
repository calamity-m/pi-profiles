import { appendFileSync } from "node:fs";

export default function (pi) {
  const record = (event) => {
    if (process.env.PI_PROFILES_FIXTURE_LOG)
      appendFileSync(process.env.PI_PROFILES_FIXTURE_LOG, `bravo:${event}\n`);
  };
  pi.registerCommand("fixture-bravo", {
    description: "Bravo fixture command",
    handler: async () => {
      record("command");
    },
  });
  pi.registerTool({
    name: "fixture_bravo",
    label: "Bravo",
    description: "Bravo fixture tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "bravo" }], details: {} }),
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
