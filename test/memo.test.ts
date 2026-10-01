import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { configuration, executeMemo, MemoClient, MAX_OUTPUT_BYTES, type MemoConfig, type MemoResult } from "../src/memo.ts";
import { argumentsFor } from "../src/arguments.ts";

async function setup(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-optmem-client-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, MEMORY_DIR: join(cwd, "memory") };
  delete env.OPTMEM_PYTHON;
  const config = configuration(env, cwd);
  return { cwd, config, client: new MemoClient(config) };
}

test("relative and tilde directories resolve deterministically and capture the environment", () => {
  const env = { MEMORY_DIR: "relative memory", OPTMEM_PYTHON: "/custom/python", HOME: "unused" };
  const config = configuration(env, "/workspace");
  assert.equal(config.directory, resolve("/workspace", "relative memory"));
  assert.equal(config.explicitDirectory, true);
  assert.equal(config.python, "/custom/python");
  env.MEMORY_DIR = "different";
  assert.equal(config.env.MEMORY_DIR, config.directory);
  assert.equal(configuration({ MEMORY_DIR: "~/memories" }, "/workspace").directory, join(homedir(), "memories"));
  assert.equal(configuration({}, "/workspace").explicitDirectory, false);
  assert.throws(() => configuration({ MEMORY_DIR: " " }, "/workspace"), /empty/);
});

test("filesystem errors are not treated as a request to create a store", async (t) => {
  const { cwd, config } = await setup(t);
  const file = join(cwd, "file");
  await writeFile(file, "not a directory");
  const client = new MemoClient({ ...config, directory: file });
  await assert.rejects(client.prepare(), /not a directory/);
  await mkdir(config.directory);
  await mkdir(join(config.directory, "LOG.txt"));
  await assert.rejects(new MemoClient(config).initialized(), /not a regular file/);
});

test("missing Python has an actionable error", async (t) => {
  const { config } = await setup(t);
  await assert.rejects(executeMemo({ ...config, python: join(config.cwd, "no-such-python") }, ["wake"]), /Install Python.*OPTMEM_PYTHON/);
});

test("the runner preserves complete UTF-8 output and subprocess exit codes", async (t) => {
  const { cwd, config } = await setup(t);
  const program = join(cwd, "utf8.py");
  await writeFile(program, 'import sys\nsys.stdout.buffer.write("João → reunião".encode("utf-8"))\nsys.stderr.write("diagnostic")\nsys.exit(7)\n');
  const result = await executeMemo(config, [], undefined, 1000, program);
  assert.equal(result.stdout, "João → reunião");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.code, 7);
});

test("a hung subprocess is terminated by its timeout", async (t) => {
  const { cwd, config } = await setup(t);
  const program = join(cwd, "sleep.py");
  await writeFile(program, "import time\ntime.sleep(60)\n");
  await assert.rejects(executeMemo(config, [], undefined, 100, program), /timed out/);
});

test("cancellation terminates an active subprocess", async (t) => {
  const { cwd, config } = await setup(t);
  const program = join(cwd, "sleep.py");
  await writeFile(program, "import time\ntime.sleep(60)\n");
  const controller = new AbortController();
  const pending = executeMemo(config, [], controller.signal, 3000, program);
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, /cancelled/); } finally { clearTimeout(timer); }
});

test("a pre-aborted call launches no subprocess", async (t) => {
  const { config } = await setup(t);
  assert.throws(() => executeMemo(config, [], AbortSignal.abort()));
});

test("excessive command output fails explicitly instead of truncating protocol instructions", async (t) => {
  const { cwd, config } = await setup(t);
  const program = join(cwd, "large.py");
  await writeFile(program, `import sys\nsys.stdout.write("x" * ${MAX_OUTPUT_BYTES + 1})\n`);
  await assert.rejects(executeMemo(config, [], undefined, 3000, program), /exceeded 128 KiB/);
});

test("parallel notes use distinct IDs and retain all records", async (t) => {
  const { config, client } = await setup(t);
  await client.init();
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => client.run(["note", `Parallel memory ${i}`])));
  assert.ok(results.every((r) => r.code === 0));
  const ids = results.map((r) => /Saved as #(\d+)/.exec(r.stdout)![1]);
  assert.equal(new Set(ids).size, 16);
  const log = await readFile(join(config.directory, "LOG.txt"));
  assert.equal(log.length, 16 * 320);
  const recall = await client.run(["recall", "Parallel memory"]);
  assert.match(recall.stdout, /16 matches/);
});

class FakePages extends MemoClient {
  calls: string[][] = [];
  constructor(config: MemoConfig, readonly pages: MemoResult[]) { super(config); }
  override async run(args: string[]) {
    this.calls.push(args);
    const page = this.pages.shift();
    assert.ok(page, "Unexpected page request");
    return page;
  }
}

test("paging forwards the printed snapshot even if memories arrive between pages", async (t) => {
  const { config } = await setup(t);
  const client = new FakePages(config, [
    { code: 0, stdout: "#0 Old\nNot awake yet. Run: /a path/memo wake 2 99\n", stderr: "" },
    { code: 0, stdout: "#98 New\nYou are awake.\n", stderr: "" },
  ]);
  const snapshot = await client.wake();
  assert.deepEqual(client.calls, [["wake"], ["wake", "2", "99"]]);
  assert.match(snapshot.output, /#0 Old/);
  assert.match(snapshot.output, /#98 New/);
  assert.doesNotMatch(snapshot.output, /Not awake yet/);
});

test("inconsistent paging is rejected", async (t) => {
  const { config } = await setup(t);
  const client = new FakePages(config, [{ code: 0, stdout: "#0 Old\nNot awake yet. Run: memo wake 3 99", stderr: "" }]);
  await assert.rejects(client.wake(), /inconsistent/);
});

test("wake distinguishes protocol work from real failures", async (t) => {
  const { config } = await setup(t);
  const blocked = new FakePages(config, [{ code: 1, stdout: "Cannot wake: missing summary\nCompress memories #0-1", stderr: "" }]);
  assert.equal((await blocked.wake()).blocked, true);
  const broken = new FakePages(config, [{ code: 1, stdout: "", stderr: "Permission denied" }]);
  await assert.rejects(broken.wake(), /Permission denied/);
});

test("wake bounds total accumulated pages as well as individual command output", async (t) => {
  const { config } = await setup(t);
  const pages = Array.from({ length: 8 }, (_, i) => ({
    code: 0, stderr: "", stdout: "x".repeat(20000) + `\nNot awake yet. Run: memo wake ${i + 2} 99`,
  }));
  await assert.rejects(new FakePages(config, pages).wake(), /memory context exceeded/);
});

test("tool arguments are validated before spawning and retain literal strings", () => {
  assert.deepEqual(argumentsFor({ action: "note", text: "$(whoami)" }), ["note", "$(whoami)"]);
  assert.deepEqual(argumentsFor({ action: "wake", part: 2, snapshot: 99 }), ["wake", "2", "99"]);
  assert.deepEqual(argumentsFor({ action: "nap" }), ["nap"]);
  assert.throws(() => argumentsFor({ action: "wake", part: 1.5 }), /safe integer/);
  assert.throws(() => argumentsFor({ action: "wake", snapshot: 1 }), /requires part/);
  assert.throws(() => argumentsFor({ action: "nap", text: "summary" }), /requires block/);
  assert.throws(() => argumentsFor({ action: "bad" } as any), /Unknown/);
});

function gitBlob(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

test("vendored engine and engine tests match the documented upstream commit", async () => {
  const provenance = await readFile(new URL("../UPSTREAM.md", import.meta.url), "utf8");
  assert.match(provenance, /1fb164cf39028047781f72ac3bb1e5a691c1dcb0/);
  const memo = await readFile(new URL("../memo", import.meta.url));
  const upstreamTests = await readFile(new URL("../upstream-test.py", import.meta.url));
  assert.equal(gitBlob(memo), "224409b932904a0355cd97145d17c6b28cf1213c");
  assert.equal(gitBlob(upstreamTests), "0a57e28dbaa75ecb96df0e94ac49bb2666ababe7");
});
