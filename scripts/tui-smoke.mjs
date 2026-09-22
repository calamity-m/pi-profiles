#!/usr/bin/env node
/** Launch a disposable, offline Pi TUI. All writable configuration is temporary. */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "pi-profiles-smoke-"));
const agentDir = join(home, "agent");
const cwd = join(home, "cwd");
const fixtures = join(home, "fixtures");
try {
  await Promise.all([agentDir, cwd, fixtures].map((path) => mkdir(path, { recursive: true })));
  for (const name of ["alpha", "bravo"])
    await cp(join(repo, "tests", "fixtures", `${name}.js`), join(fixtures, `${name}.js`));
  await writeFile(
    join(fixtures, "package.json"),
    JSON.stringify({ type: "module", pi: { extensions: ["alpha.js", "bravo.js"] } }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [repo, fixtures],
      enableInstallTelemetry: false,
      defaultProjectTrust: "never",
      quietStartup: true,
    }),
  );
  const packageRoot = dirname(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  );
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const executable = resolve(
    packageRoot,
    typeof metadata.bin === "string" ? metadata.bin : metadata.bin.pi,
  );
  console.log(
    `Disposable HOME: ${home}\nSettings: ${join(agentDir, "settings.json")}\nLifecycle log: ${join(home, "lifecycle.log")}\nTry /profile, create/duplicate/edit/switch, /fixture-alpha and /fixture-bravo. Exit cleans up.`,
  );
  const child = spawn(
    process.execPath,
    [
      executable,
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-session",
    ],
    {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_PROFILES_FIXTURE_LOG: join(home, "lifecycle.log"),
      },
      stdio: "inherit",
    },
  );
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
} finally {
  await rm(home, { recursive: true, force: true });
}
