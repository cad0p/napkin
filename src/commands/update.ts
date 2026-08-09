import { spawn, spawnSync } from "node:child_process";
import { EXIT_ERROR } from "../utils/exit-codes.js";
import {
  error,
  info,
  type OutputOptions,
  output,
  success,
} from "../utils/output.js";

const target = "@cad0p/napkin@latest";

interface RunOptions {
  silent: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<number>;

export type PackageManagerResolver = () => { command: string; args: string[] };

/**
 * Resolve the package manager to use for self-update. Prefers pnpm (this
 * fork's package manager) when available on PATH, then falls back to npm so
 * the command works for users who installed the global via `npm i -g`.
 */
export const resolvePackageManager: PackageManagerResolver = () => {
  // pnpm add -g @cad0p/napkin@latest
  // npm install -g @cad0p/napkin@latest
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const command = isOnPath(pnpm) ? pnpm : npm;
  const subcmd = command === pnpm ? "add" : "install";
  const args = [subcmd, "-g", target];
  return { command, args };
};

function isOnPath(bin: string): boolean {
  const check = process.platform === "win32" ? "where" : "command";
  const checkArgs = process.platform === "win32" ? [bin] : ["-v", bin];
  try {
    return spawnSync(check, checkArgs, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export async function update(
  opts: OutputOptions,
  runner: CommandRunner = runCommand,
  resolver: PackageManagerResolver = resolvePackageManager,
): Promise<void> {
  const { command, args } = resolver();
  const commandLine = `${command} ${args.join(" ")}`;

  if (!opts.quiet && !opts.json) info(`Updating napkin with ${commandLine}`);

  let status: number;
  try {
    status = await runner(command, args, {
      silent: Boolean(opts.quiet || opts.json),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    fail(opts, `Could not run ${command}: ${message}`);
  }

  if (status !== 0) fail(opts, `${commandLine} exited with status ${status}`);

  output(opts, {
    json: () => ({ updated: true, target }),
    quiet: () => {},
    human: () => success(`Updated ${target}`),
  });
}

function fail(opts: OutputOptions, message: string): never {
  if (opts.json) {
    output(opts, {
      json: () => ({ updated: false, target, error: message }),
      human: () => {},
    });
  } else {
    error(`Update failed: ${message}`);
  }
  process.exit(EXIT_ERROR);
}

function runCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.silent ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
}
