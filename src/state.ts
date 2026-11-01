import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Hex } from "viem";

export interface TaskState {
  /** Kept across retries and restarts, so a failed upload or submit does not run the paid command again. */
  result?: string;
  stored?: { uri: string; hash: Hex };
  /** The submit sent for the stored result, waited on before another is sent. */
  tx?: Hex;
  failures: number;
  /** Chain time, in seconds, before which the task is not tried again. */
  nextAt: number;
}

export interface State {
  /** The task board the rest belongs to; state kept for another board is dropped. */
  board: string;
  tasks: Record<string, TaskState>;
  /** Tasks finished or given up, which stay hired on chain until they settle. */
  done: string[];
  /** The last block scanned for WorkerHired, and the tasks found that are still hired. */
  hired?: { block: number; tasks: string[] };
  /** The command running for a task, so the next run can stop it if this one dies first. */
  command?: { pgid: number; startedAt: number };
}

export interface Store {
  state: State;
  save(): void;
}

export const stateDir = () => join(homedir(), ".config", "brainchain-worker");

const empty = (board: string): State => ({ board: board.toLowerCase(), tasks: {}, done: [] });

export function memoryStore(board = ""): Store {
  return { state: empty(board), save: () => undefined };
}

function parse(text: string): Partial<State> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Partial<State>) : undefined;
  } catch {
    return undefined;
  }
}

/** State in a 0600 JSON file, replaced whole on every save so a crash never leaves half a file. */
export function fileStore(file: string, board: string, warn: (message: string) => void = console.warn): Store {
  let state = empty(board);
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const saved = text === undefined ? undefined : parse(text);
  if (saved?.board === state.board) state = { ...state, ...saved, tasks: saved.tasks ?? {}, done: saved.done ?? [] };
  if (text !== undefined && saved === undefined) {
    // Refusing to start would turn one bad file into a crash loop under a supervisor.
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "")}`;
    renameSync(file, aside);
    warn(`${file} was not valid JSON, so it was moved to ${aside} and this run starts with no saved work`);
  }
  return {
    state,
    save() {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      const fd = openSync(temp, "w", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(state));
        // On disk before the rename, so a power loss leaves the old file or the new one, never an empty one.
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, file);
    },
  };
}

function alive(pid: number): boolean {
  // A container restarts its process with the same pid, so our own pid in the file is a stale lock.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the lock in `file` for this process until it exits; refuses while a live process holds it. */
export function lock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // The holder may have released it since the write failed; then the next try takes it.
    const holder = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0;
    if (alive(holder)) throw new Error(`Another run (pid ${holder}) is already working for this worker. Stop it before starting another; ${file} holds its lock.`);
    rmSync(file, { force: true });
  }
  const release = () => {
    if (existsSync(file) && readFileSync(file, "utf8") === String(process.pid)) rmSync(file, { force: true });
  };
  process.once("exit", release);
  return release;
}
