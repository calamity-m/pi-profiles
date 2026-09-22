import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register } from "../src/register.ts";

export default function (pi: ExtensionAPI): void {
  register(pi, fileURLToPath(import.meta.url));
}
