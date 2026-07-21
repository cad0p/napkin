import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EXIT_ERROR } from "../utils/exit-codes.js";
import {
  type CommandRunner,
  type PackageManagerResolver,
  update,
} from "./update.js";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/** Fixed npm resolver so tests are deterministic regardless of host PATH. */
const npmOnly: PackageManagerResolver = () => ({
  command: npmCommand,
  args: ["install", "-g", "@cad0p/napkin@latest"],
});

const originalLog = console.log;
const originalError = console.error;
let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

async function captureExit(fn: () => Promise<void>): Promise<number> {
  const originalExit = process.exit;
  let exitCode = -1;
  (process as unknown as Record<string, unknown>).exit = (code: number) => {
    exitCode = code;
    throw new Error("exit");
  };

  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "exit") throw error;
  } finally {
    (process as unknown as Record<string, unknown>).exit = originalExit;
  }

  return exitCode;
}

describe("update command", () => {
  test("runs npm install globally for the latest napkin package", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { silent: boolean };
    }> = [];

    await update(
      {},
      async (command, args, options) => {
        calls.push({ command, args, options });
        return 0;
      },
      npmOnly,
    );

    expect(calls).toEqual([
      {
        command: npmCommand,
        args: ["install", "-g", "@cad0p/napkin@latest"],
        options: { silent: false },
      },
    ]);
    expect(logs.join("\n")).toContain("Updated @cad0p/napkin@latest");
  });

  test("returns structured JSON and silences npm output", async () => {
    let silent = false;

    await update(
      { json: true },
      async (_command, _args, options) => {
        silent = options.silent;
        return 0;
      },
      npmOnly,
    );

    expect(silent).toBe(true);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      updated: true,
      target: "@cad0p/napkin@latest",
    });
    expect(errors).toEqual([]);
  });

  test("suppresses command and npm output in quiet mode", async () => {
    let silent = false;

    await update(
      { quiet: true },
      async (_command, _args, options) => {
        silent = options.silent;
        return 0;
      },
      npmOnly,
    );

    expect(silent).toBe(true);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("reports a non-zero npm exit status", async () => {
    const exitCode = await captureExit(() =>
      update({}, async () => 7, npmOnly),
    );

    expect(exitCode).toBe(EXIT_ERROR);
    expect(errors.join("\n")).toContain("exited with status 7");
  });

  test("returns structured JSON for a failed update", async () => {
    const exitCode = await captureExit(() =>
      update({ json: true }, async () => 2, npmOnly),
    );

    expect(exitCode).toBe(EXIT_ERROR);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      updated: false,
      target: "@cad0p/napkin@latest",
      error: `${npmCommand} install -g @cad0p/napkin@latest exited with status 2`,
    });
    expect(errors).toEqual([]);
  });

  test("adds context when npm cannot be started", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("not found");
    };
    const exitCode = await captureExit(() => update({}, runner, npmOnly));

    expect(exitCode).toBe(EXIT_ERROR);
    expect(errors.join("\n")).toContain(
      `Update failed: Could not run ${npmCommand}: not found`,
    );
  });

  test("prefers pnpm when available on PATH", async () => {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const pnpmResolver: PackageManagerResolver = () => ({
      command: pnpmCommand,
      args: ["add", "-g", "@cad0p/napkin@latest"],
    });
    const calls: Array<{ command: string; args: string[] }> = [];

    await update(
      {},
      async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
      pnpmResolver,
    );

    expect(calls).toEqual([
      {
        command: pnpmCommand,
        args: ["add", "-g", "@cad0p/napkin@latest"],
      },
    ]);
  });
});
