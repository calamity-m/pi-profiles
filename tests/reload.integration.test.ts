import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "real offline Pi profile reload swaps commands/tools/hooks while preserving conversation",
  { timeout: 30000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-profiles-reload-"));
    try {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("fixtures/reload-driver.mjs", import.meta.url))],
        {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, "agent"),
            PI_OFFLINE: "1",
            PI_PROFILES_FIXTURE_LOG: join(home, "lifecycle.log"),
          },
          encoding: "utf8",
          timeout: 25000,
        },
      );
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Real profile reload preserved transcript/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
