import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Hex } from "viem";

import type { Network } from "./network.js";

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

/** A delivered task waiting for its Proof: watched until it settles, then minted for at most once an hour. */
export interface ProofTask {
  /** Wall-clock seconds when the result was delivered. */
  deliveredAt: number;
  /** When the task was first seen paid. */
  paidAt?: number;
  /** Wall-clock seconds before which the task is not looked at again. */
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
  /** Delivered tasks waiting for the worker to mint their Proof, by task id. */
  proofs?: Record<string, ProofTask>;
}

export interface Store {
  state: State;
  save(): void;
}

export const stateDir = () => join(homedir(), ".config", "brainchain-worker");

/** The decision count a one-shot watch run stopped at, kept per decision log; undefined when there is none or it cannot be read. */
export function readWatched(log: string, dir = stateDir()): bigint | undefined {
  try {
    const { seen } = JSON.parse(readFileSync(join(dir, `watch.${log.toLowerCase()}.json`), "utf8")) as { seen?: unknown };
    return typeof seen === "string" && /^\d+$/.test(seen) ? BigInt(seen) : undefined;
  } catch {
    return undefined;
  }
}

export function writeWatched(log: string, seen: bigint, dir = stateDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `watch.${log.toLowerCase()}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ seen: seen.toString() }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

const empty = (board: string): State => ({ board: board.toLowerCase(), tasks: {}, done: [] });

export function memoryStore(board = ""): Store {
  return { state: empty(board), save: () => undefined };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isHash = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isIds = (value: unknown) => Array.isArray(value) && value.every((id) => typeof id === "string" && /^\d+$/.test(id));

function isTask(value: unknown): value is TaskState {
  if (!isObject(value) || !isCount(value.failures) || !isCount(value.nextAt)) return false;
  if (value.result !== undefined && typeof value.result !== "string") return false;
  if (value.tx !== undefined && !isHash(value.tx)) return false;
  return value.stored === undefined || (isObject(value.stored) && typeof value.stored.uri === "string" && isHash(value.stored.hash));
}

function isProofs(value: unknown): boolean {
  if (!isObject(value) || !isIds(Object.keys(value))) return false;
  return Object.values(value).every((p) => isObject(p) && isCount(p.deliveredAt) && isCount(p.nextAt) && (p.paidAt === undefined || isCount(p.paidAt)));
}

/** Whether a parsed file is a state this worker can go on from; any other shape fails every round that reads it. */
function isState(value: unknown): value is State {
  if (!isObject(value) || typeof value.board !== "string" || !isObject(value.tasks) || !isIds(value.done)) return false;
  if (!Object.values(value.tasks).every(isTask)) return false;
  const { hired, command, proofs } = value;
  if (hired !== undefined && !(isObject(hired) && isCount(hired.block) && isIds(hired.tasks))) return false;
  if (proofs !== undefined && !isProofs(proofs)) return false;
  // Group 0 is this process's own and -1 is every process, so only a real command's group is signalled.
  return command === undefined || (isObject(command) && isCount(command.pgid) && command.pgid > 1 && isCount(command.startedAt));
}

function parse(text: string): State | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isState(value) ? value : undefined;
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
  if (saved?.board === state.board) state = saved;
  if (text !== undefined && saved === undefined) {
    // Refusing to start would turn one bad file into a crash loop under a supervisor.
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "")}`;
    renameSync(file, aside);
    warn(`${file} could not be read as saved worker state, so it was moved to ${aside} and this run starts with no saved work`);
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

const holder = (file: string) => (existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0);

const held = (pid: number, file: string) =>
  new Error(`Another run (pid ${pid}) is already working for this worker. Stop it before starting another; ${file} holds its lock.`);

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
    const pid = holder(file);
    if (alive(pid)) throw held(pid, file);
    rmSync(file, { force: true });
  }
  const release = () => {
    if (existsSync(file) && readFileSync(file, "utf8") === String(process.pid)) rmSync(file, { force: true });
  };
  process.once("exit", release);
  return release;
}

/**
 * Moves the state 0.3.0 and earlier kept per address alone to `file`, once,
 * when it was kept for `board`, and says whether it did. State for the other
 * network stays where it is until a run there moves it.
 */
function migrate(old: string, file: string, board: string): boolean {
  let text: string;
  try {
    text = readFileSync(`${old}.json`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (parse(text)?.board !== board.toLowerCase()) return false;
  // A run from before the move may still be working on this network's tasks from the old file.
  const pid = holder(`${old}.lock`);
  if (alive(pid)) throw held(pid, `${old}.lock`);
  if (existsSync(`${file}.json`)) return false;
  // Removed rather than moved: this run already holds the new lock.
  rmSync(`${old}.lock`, { force: true });
  renameSync(`${old}.json`, `${file}.json`);
  return true;
}

/**
 * Takes the worker's lock on one network and loads its saved state. Each
 * network has its own `<address>.<network>.json` and `.lock`, so one key can
 * run on testnet and mainnet at once without sharing cursors or tasks.
 */
export function openStore(address: string, network: Network, log: (line: string) => void = console.log, dir = stateDir()): Store {
  const old = join(dir, address);
  const file = `${old}.${network.id}`;
  lock(`${file}.lock`);
  if (migrate(old, file, network.contracts.taskBoard)) log(`moved ${old}.json to ${file}.json`);
  return fileStore(`${file}.json`, network.contracts.taskBoard, (message) => log(`warning: ${message}`));
}
