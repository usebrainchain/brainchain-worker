import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { stateDir } from "./state.js";

/** Names the file a run passes its key through when it restarts itself without the key in its environment. */
const HANDOFF = "BRAINCHAIN_WORKER_KEY_HANDOFF";
const HANDOFF_NAME = /^brainchain-worker-key-[0-9a-f]{32}$/;

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

/** Whether the environment names a key, without reading it: a key file can be a pipe, which reads only once. */
export const keyConfigured = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env[HANDOFF] || env.BRAINCHAIN_WORKER_KEY?.trim() || env.BRAINCHAIN_WORKER_KEY_FILE?.trim());

function fromFile(path: string, warn: (message: string) => void): string {
  const file = expandHome(path);
  let text: string;
  try {
    const stat = statSync(file);
    if (stat.isFile() && (stat.mode & 0o077) !== 0) warn(`warning: other users can read ${file}; run chmod 600 on it`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`BRAINCHAIN_WORKER_KEY_FILE names ${file}, which could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
  }
  // The file holds the key alone, or the line new-key prints.
  return /^\s*(?:BRAINCHAIN_WORKER_KEY=)?(\S+)\s*$/m.exec(text)?.[1] ?? "";
}

/** The text of the worker's key, from wherever the environment says it is; undefined when it names none. */
export function keyText(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): string | undefined {
  const handoff = env[HANDOFF];
  if (handoff !== undefined) {
    delete env[HANDOFF];
    if (!HANDOFF_NAME.test(basename(handoff))) throw new Error(`${HANDOFF} is for the worker's own use; unset it`);
    const text = readFileSync(handoff, "utf8");
    rmSync(handoff, { force: true });
    return text;
  }
  const inline = env.BRAINCHAIN_WORKER_KEY?.trim();
  const file = env.BRAINCHAIN_WORKER_KEY_FILE?.trim();
  if (inline && file) throw new Error("Set BRAINCHAIN_WORKER_KEY or BRAINCHAIN_WORKER_KEY_FILE, not both");
  return file ? fromFile(file, warn) : inline || undefined;
}

/** Writes a new key to a file only its owner can read; an existing file is left alone, since it may hold a wallet's only key. */
export function writeKeyFile(path: string, key: string): void {
  const file = expandHome(path);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, `${key}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${file} already exists, and new-key never replaces a key`);
    throw error;
  }
}

/** Memory rather than disk where the system offers it. The file lives for the milliseconds a restart takes. */
function handoffDir(): string {
  try {
    accessSync("/dev/shm", constants.W_OK);
    return "/dev/shm";
  } catch {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    return stateDir();
  }
}

/**
 * Restarts this process in place without BRAINCHAIN_WORKER_KEY in its
 * environment. Deleting the variable would not do: `ps eww` and /proc read the
 * block the process started with, and a command run by `run` can reach both.
 * The pid, the output and the supervisor's view all stay as they were. Returns
 * when there is nothing to clear, or when it could not be cleared.
 */
export function clearKeyFromEnvironment(key: string, warn: (message: string) => void, env: NodeJS.ProcessEnv = process.env, execve = process.execve): void {
  if (env.BRAINCHAIN_WORKER_KEY === undefined) return;
  if (typeof execve !== "function") return warn(`warning: Node.js ${process.version} cannot clear the key from this process's environment; Node.js 22.15 or later can`);
  const { BRAINCHAIN_WORKER_KEY: _, ...rest } = env;
  let file: string | undefined;
  try {
    file = join(handoffDir(), `brainchain-worker-key-${randomBytes(16).toString("hex")}`);
    writeFileSync(file, key, { flag: "wx", mode: 0o600 });
    execve(process.execPath, [process.execPath, ...process.execArgv, process.argv[1]!, ...process.argv.slice(2)], { ...rest, [HANDOFF]: file } as Record<string, string>);
  } catch (error) {
    if (file !== undefined) rmSync(file, { force: true });
    warn(`warning: could not clear the key from this process's environment (${(error as Error).message})`);
  }
}
