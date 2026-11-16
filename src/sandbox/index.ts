import type { DispatchConfig } from "../utils/config.js";
import { DockerSandbox } from "./docker.js";
import { SrtSandbox } from "./srt.js";
import type { SandboxBackend } from "./types.js";

export type { SandboxBackend, IssueSandbox, SandboxRecord } from "./types.js";

/** The configured sandbox backend, or undefined when sandboxing is off */
export function createSandbox(config: DispatchConfig): SandboxBackend | undefined {
  const extra = {
    extraDomains: config.sandboxAllowedDomains,
    extraRead: config.sandboxAllowRead,
    extraWrite: config.sandboxAllowWrite,
  };
  if (config.sandbox === "srt") return new SrtSandbox({ srtPath: config.srtPath, ...extra });
  if (config.sandbox === "docker") return new DockerSandbox({ image: config.dockerImage, ...extra });
  return undefined;
}

/** One line for the run log saying what the sandbox allows */
export function describeSandbox(sandbox: SandboxBackend): string {
  return sandbox.name === "docker"
    ? "docker. Each agent runs in its own container on an internal network; only the Claude API and package registries are reachable"
    : "srt. Agents read only their worktree and toolchains, and reach only the Claude API and package registries";
}
