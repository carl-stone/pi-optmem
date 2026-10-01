import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MEMO = fileURLToPath(new URL("../memo", import.meta.url));
export const TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 128 * 1024;

export interface MemoConfig {
  directory: string;
  explicitDirectory: boolean;
  python: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface MemoResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface WakeSnapshot {
  output: string;
  blocked: boolean;
}

export function configuration(env: NodeJS.ProcessEnv, cwd: string): MemoConfig {
  const explicitDirectory = Object.hasOwn(env, "MEMORY_DIR");
  const raw = explicitDirectory ? env.MEMORY_DIR : resolve(homedir(), ".optmem/memory");
  if (!raw?.trim()) throw new Error("MEMORY_DIR is explicitly set but empty. Set a path or unset it.");
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") || raw.startsWith("~\\")
    ? resolve(homedir(), raw.slice(2)) : raw;
  const directory = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return {
    directory,
    explicitDirectory,
    python: env.OPTMEM_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    cwd,
    // Capture the child environment so changing process.env cannot redirect this store.
    env: { ...env, MEMORY_DIR: directory },
  };
}

export function outputOf(result: MemoResult): string {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
}

/** Direct process execution: no shell, explicit store, bounded output and lifetime. */
export function executeMemo(
  config: MemoConfig,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = TIMEOUT_MS,
  program = MEMO,
): Promise<MemoResult> {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(config.python, [program, ...args], {
      cwd: config.cwd,
      env: config.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let done = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (done || failure) return;
      failure = error;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        if (!done) child.kill("SIGKILL");
      }, 1_000);
      forceKill.unref();
    };
    const onAbort = () => stop(new Error("OptMem operation cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => stop(new Error(`OptMem timed out after ${timeoutMs}ms.`)), timeoutMs);
    const cleanup = () => {
      done = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
    };
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        stop(new Error("OptMem output exceeded 128 KiB. Reduce PART_CHARS or WAKE_LINES with /optmem config."));
      } else target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", (error) => {
      cleanup();
      reject(new Error(`Cannot run OptMem with ${config.python}: ${error.message}. Install Python 3.7+ or set OPTMEM_PYTHON.`));
    });
    child.on("close", (code, killedBy) => {
      if (done) return;
      cleanup();
      if (failure) reject(failure);
      else if (killedBy) reject(new Error(`OptMem terminated by ${killedBy}.`));
      else resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? 1 });
    });
    // Cover an abort arriving between the preflight check and listener registration.
    if (signal?.aborted) onAbort();
  });
}

async function info(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class MemoClient {
  constructor(readonly config: MemoConfig) {}

  async initialized(): Promise<boolean> {
    const directory = await info(this.config.directory);
    if (directory && !directory.isDirectory()) {
      throw new Error(`OptMem path is not a directory: ${this.config.directory}`);
    }
    const log = directory ? await info(resolve(this.config.directory, "LOG.txt")) : undefined;
    if (log && !log.isFile()) throw new Error("OptMem LOG.txt is not a regular file.");
    return !!log;
  }

  async prepare(): Promise<boolean> {
    if (await this.initialized()) return false;
    if (this.config.explicitDirectory) throw new Error(this.initializationHint());
    await this.init();
    return true;
  }

  initializationHint(): string {
    return `No initialized OptMem store at ${this.config.directory}. Run /optmem init to create it deliberately, or correct MEMORY_DIR and restart pi.`;
  }

  async init(signal?: AbortSignal): Promise<void> {
    const result = await executeMemo(this.config, ["init"], signal);
    if (result.code !== 0) throw new Error(outputOf(result) || `OptMem init exited ${result.code}.`);
  }

  async run(args: string[], signal?: AbortSignal): Promise<MemoResult> {
    // Never re-create a disappearing store during a live session, even the default.
    if (!(await this.initialized())) throw new Error(this.initializationHint());
    return executeMemo(this.config, args, signal);
  }

  async wake(signal?: AbortSignal): Promise<WakeSnapshot> {
    let args = ["wake"];
    const pages: string[] = [];
    let bytes = 0;
    let previousPart = 1;
    let snapshot: string | undefined;
    for (let pageNumber = 0; pageNumber < 256; pageNumber++) {
      const result = await this.run(args, signal);
      const output = outputOf(result);
      // A missing summary is normal protocol work, not a broken store.
      if (result.code === 1 && result.stdout.startsWith("Cannot wake:") && !result.stderr) {
        return { output, blocked: true };
      }
      if (result.code !== 0) throw new Error(output || `OptMem wake exited ${result.code}.`);
      if (!output) throw new Error("OptMem wake returned no output.");
      const continuation = /\nNot awake yet\. Run: .* wake (\d+) (\d+)$/.exec(output);
      const page = continuation ? output.slice(0, continuation.index) : output;
      pages.push(page);
      bytes += Buffer.byteLength(page, "utf8") + 2;
      if (bytes > MAX_OUTPUT_BYTES) {
        throw new Error("OptMem memory context exceeded 128 KiB. Reduce WAKE_LINES with /optmem config.");
      }
      if (!continuation) return { output: pages.join("\n\n"), blocked: false };
      const part = Number(continuation[1]);
      if (part !== previousPart + 1 || (snapshot !== undefined && snapshot !== continuation[2])) {
        throw new Error("OptMem returned an inconsistent wake continuation.");
      }
      previousPart = part;
      snapshot = continuation[2];
      args = ["wake", String(part), snapshot];
    }
    throw new Error("OptMem wake exceeded 256 pages. Increase PART_LINES or reduce WAKE_LINES with /optmem config.");
  }
}
