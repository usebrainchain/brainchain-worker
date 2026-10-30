import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Hex } from "viem";

export interface TaskState {
  /** Kept across retries and restarts, so a failed upload or submit does not run the paid command again. */
  result?: string;
  stored?: { uri: string; hash: Hex };
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

/** State in a 0600 JSON file, replaced whole on every save so a crash never leaves half a file. */
export function fileStore(file: string, board: string): Store {
  let state = empty(board);
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    let saved: Partial<State>;
    try {
      saved = JSON.parse(text) as Partial<State>;
    } catch {
      throw new Error(`${file} is not valid JSON. Move it aside to start with no saved work.`);
    }
    if (saved.board === state.board) state = { ...state, ...saved, tasks: saved.tasks ?? {}, done: saved.done ?? [] };
  }
  return {
    state,
    save() {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
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
