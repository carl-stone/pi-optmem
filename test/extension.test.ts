import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOptmemExtension, MEMORY_MESSAGE, type ExtensionOptions } from "../extension.ts";
import { MemoClient, type MemoConfig } from "../src/memo.ts";
import { MEMORY_INSTRUCTIONS, memoryInstructions } from "../src/instructions.ts";
import { argumentsFor, type Parameters as MemoryParameters } from "../src/arguments.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function environment(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  delete env.MEMORY_DIR;
  delete env.OPTMEM_DISABLED;
  delete env.OPTMEM_PYTHON;
  return { ...env, ...overrides };
}

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-optmem-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function harness(cwd: string, env: NodeJS.ProcessEnv, clientFactory?: ExtensionOptions["clientFactory"]) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Command>();
  const sent: any[] = [];
  const notices: Array<{ text: string; type: string }> = [];
  let wakes = 0;
  let runs = 0;
  let constructions = 0;
  let actual: MemoClient | undefined;
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify: (text: string, type = "info") => notices.push({ text, type }) },
  } as unknown as ExtensionContext;
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    sendMessage: (message: any) => sent.push(message),
  } as unknown as ExtensionAPI;
  createOptmemExtension({
    env,
    clientFactory: (config) => {
      constructions++;
      // Never touch the tester's real default memory, even when env is unset.
      const dir = config.explicitDirectory ? config.directory : join(cwd, "default-memory");
      const safe: MemoConfig = { ...config, directory: dir, env: { ...config.env, MEMORY_DIR: dir } };
      actual = clientFactory ? clientFactory(safe) : new MemoClient(safe);
      const wake = actual.wake.bind(actual);
      actual.wake = async (signal) => { wakes++; return wake(signal); };
      const run = actual.run.bind(actual);
      actual.run = async (args, signal) => { runs++; return run(args, signal); };
      return actual;
    },
  })(api);
  return {
    handlers, tools, commands, notices, sent, ctx,
    get wakes() { return wakes; },
    get runs() { return runs; },
    get constructions() { return constructions; },
    get client() { return actual!; },
    async emit(event: string, data: any = {}) { return handlers.get(event)?.(data, ctx); },
    async start() { await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx); },
    async context(messages: AgentMessage[] = []) {
      const result = await handlers.get("context")!({ type: "context", messages }, ctx);
      return result.messages as AgentMessage[];
    },
    async call(params: MemoryParameters, signal?: AbortSignal) {
      return tools.get("optmem")!.execute("test-call", params, signal, undefined, ctx as any);
    },
    async command(args: string) { await commands.get("optmem")!.handler(args, ctx as ExtensionCommandContext); },
  };
}

function snapshotText(messages: AgentMessage[]): string {
  const message = messages.find((m) => m.role === "custom" && m.customType === MEMORY_MESSAGE);
  assert.ok(message && "content" in message && typeof message.content === "string");
  return message.content;
}

async function settle(client: MemoClient) {
  for (let i = 0; i < 100; i++) {
    const prompt = await client.run(["nap"]);
    if (prompt.stdout.includes("Nothing left to compress")) return;
    const block = /Compress memories #(\d+-\d+)/.exec(prompt.stdout)?.[1];
    assert.ok(block, prompt.stdout + prompt.stderr);
    const result = await client.run(["nap", block, "A deterministic test summary"]);
    assert.equal(result.code, 0, result.stderr);
  }
  throw new Error("Unexpected compression loop");
}

test("disabled mode registers nothing and constructs no memory client", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment({ OPTMEM_DISABLED: "1", MEMORY_DIR: join(cwd, "missing") }));
  await h.start();
  assert.equal(h.handlers.size, 0);
  assert.equal(h.tools.size, 0);
  assert.equal(h.commands.size, 0);
  assert.equal(h.constructions, 0);
  assert.deepEqual(await readdir(cwd), []);
});

test("extension loading alone has no memory side effects", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  assert.equal(h.constructions, 0);
  assert.deepEqual(await readdir(cwd), []);
  assert.equal(h.handlers.has("before_agent_start"), true);
  assert.equal(h.tools.get("optmem")!.promptGuidelines, undefined);
  assert.equal(h.tools.get("optmem")!.executionMode, "sequential");
});

test("memory instructions retain upstream framing and navigation without an extra tool-usage section", async () => {
  const source = await readFile(new URL("../memo", import.meta.url), "utf8");
  const template = /TEMPLATE = """\\\n([\s\S]*?)\n"""/.exec(source)?.[1];
  assert.ok(template, "upstream setup template must exist");
  const end = template.indexOf("\n\n### If you're a subagent:");
  assert.ok(end > 0, "upstream section boundary must exist");
  const adapted = template.slice(0, end)
    .replace('- The tool is `{memo}`', '- The tool is `optmem`')
    .replace('- Your memories are in `{data}`', '- Your memories are in the selected OptMem store')
    .replace('Run `{memo} wake` before any other tool call, in every session, and', "The extension supplies OptMem's wake output automatically, in every session;")
    .replace('`{memo} note "<1 line, max {chars} bytes>"`', '`optmem { action: "note", text: "<one-line memory>" }`')
    .replace('`{memo} note`', '`optmem { action: "note", text: "..." }`')
    .replace('`{data}`', 'the selected OptMem store')
    .replace('`{memo} recall <regex>`', '`optmem { action: "recall", query: "<regex>" }`')
    .replace('`{memo} zoom <a-b>`', '`optmem { action: "zoom", block: "16-31" }`');
  // The note-taking policy is intentionally customized; keep the surrounding
  // upstream framing and navigation intact without adding another instruction block.
  assert.ok(MEMORY_INSTRUCTIONS.startsWith(adapted.slice(0, adapted.indexOf("Call `optmem"))));
  assert.ok(MEMORY_INSTRUCTIONS.endsWith(adapted.slice(adapted.indexOf("Never edit or delete"))));
  assert.doesNotMatch(MEMORY_INSTRUCTIONS, /### Using the tool|### Compression|### Memory data/);

  const text = MEMORY_INSTRUCTIONS;
  assert.match(text, /Your memory is OptMem:/);
  assert.match(text, /Without it you do not know who you are, or what was decided and tried\./);
  assert.match(text, /supplies OptMem's wake output automatically/);
  assert.doesNotMatch(text, /subagent|OPTMEM_DISABLED|translate|memo CLI|\{memo\}|\{data\}|\{chars\}/i);
  const examples = [...text.matchAll(/`optmem (\{[^`]+\})`/g)].map((match) =>
    JSON.parse(match[1].replace(/([{,]\s*)(\w+):/g, '$1"$2":')) as MemoryParameters);
  assert.deepEqual(examples.map((example) => example.action), ["note", "note", "recall", "zoom"]);
  assert.doesNotMatch(text, /action:\s*"wake"|wake` before any other tool call|call `optmem` with/i);
  for (const example of examples) assert.doesNotThrow(() => argumentsFor(example));
});

test("memory guidance is one prompt section using the captured store, only while the tool is active", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  const systemPromptOptions = { selectedTools: ["optmem"], sections: { other: "Unrelated instructions" } as Record<string, string> };
  await h.emit("before_agent_start", { systemPromptOptions });
  assert.equal(systemPromptOptions.sections.optmem, memoryInstructions(h.client.config.directory));
  assert.ok(systemPromptOptions.sections.optmem.includes(JSON.stringify(h.client.config.directory)));
  assert.equal(systemPromptOptions.sections.other, "Unrelated instructions");
  await h.emit("before_agent_start", { systemPromptOptions });
  assert.equal(systemPromptOptions.sections.optmem.match(/## Memory/g)?.length, 1);
  systemPromptOptions.selectedTools = ["read"];
  await h.emit("before_agent_start", { systemPromptOptions });
  assert.equal(systemPromptOptions.sections.optmem, undefined);
  assert.equal(systemPromptOptions.sections.other, "Unrelated instructions");
});

test("first startup initializes only the unset default location", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  assert.ok(await h.client.initialized());
  assert.match(snapshotText(await h.context()), /You are awake/);
  assert.match(h.notices[0].text, /Memory created/);
});

test("a missing explicit MEMORY_DIR stays missing until the user runs init", async (t) => {
  const cwd = await directory(t);
  const store = join(cwd, "mistyped store");
  const h = harness(cwd, environment({ MEMORY_DIR: store }));
  await h.start();
  await assert.rejects(access(store));
  assert.match(snapshotText(await h.context()), /unavailable.*No initialized/s);
  assert.match(h.notices[0].text, /\/optmem init/);
  await assert.rejects(h.call({ action: "note", text: "must not create anything" }), /No initialized/);
  assert.equal(h.wakes, 0);
  await h.command("init");
  assert.ok(await h.client.initialized());
  assert.match(snapshotText(await h.context()), /You are awake/);
  assert.match(h.sent[0].content, /Initialized OptMem/);
});

test("an existing but uninitialized explicit directory also requires init", async (t) => {
  const cwd = await directory(t);
  const store = join(cwd, "empty");
  await mkdir(store);
  const h = harness(cwd, environment({ MEMORY_DIR: store }));
  await h.start();
  assert.deepEqual(await readdir(store), []);
  await h.command("init");
  assert.ok(await h.client.initialized());
});

test("an empty explicit MEMORY_DIR is an error, never the default", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment({ MEMORY_DIR: "" }));
  await h.start();
  assert.match(snapshotText(await h.context()), /explicitly set but empty/);
  assert.deepEqual(await readdir(cwd), []);
  await h.command("init");
  assert.deepEqual(await readdir(cwd), []);
});

test("startup and repeated initialization preserve existing log, summaries and tuned config", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  await h.call({ action: "note", text: "First durable memory" });
  await h.call({ action: "note", text: "Second durable memory" });
  await h.call({ action: "nap", block: "0-1", text: "Two durable memories" });
  await h.client.run(["config", "WAKE_LINES=12"]);
  const paths = ["LOG.txt", "TREE/2", "config"].map((p) => join(h.client.config.directory, p));
  const before = await Promise.all(paths.map((p) => readFile(p)));
  await h.start();
  await h.command("init");
  const after = await Promise.all(paths.map((p) => readFile(p)));
  assert.deepEqual(after, before);
});

test("ordinary turns reuse one stable request-local snapshot without persisted messages", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  const user: AgentMessage = { role: "user", content: "Hello", timestamp: 1 };
  const input = [user];
  const first = await h.context(input);
  const second = await h.context(first);
  assert.equal(h.wakes, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(input, [user]);
  assert.equal(first.filter((m) => m.role === "custom").length, 1);
  assert.deepEqual(h.sent, []);
  await h.call({ action: "note", text: "A new fact visible in tool history" });
  await h.context(input);
  assert.equal(h.wakes, 1);
});

test("overflow compaction restores updated memory without before_agent_start", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  await h.call({ action: "note", text: "A fact that compaction must not lose" });
  await h.emit("session_compact", { reason: "overflow", willRetry: true });
  // Simulate the retry's next model request; no new user/agent-start event.
  const messages = await h.context([{ role: "compactionSummary", summary: "Earlier conversation", tokensBefore: 1000, timestamp: 2 }]);
  assert.match(snapshotText(messages), /A fact that compaction must not lose/);
  assert.equal(h.wakes, 2);
  await h.context(messages);
  assert.equal(h.wakes, 2);
});

test("manual compaction, tree navigation and session starts refresh without duplication", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  for (const event of ["session_compact", "session_tree"]) {
    await h.emit(event);
    const messages = await h.context([]);
    assert.equal(messages.length, 1);
  }
  await h.start();
  assert.equal(h.wakes, 4);
});

test("startup transparently collects wake pages with one fixed snapshot", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  for (let i = 0; i < 8; i++) await h.client.run(["note", `Page memory ${i}`]);
  await settle(h.client);
  await h.client.run(["config", "PART_LINES=2"]);
  await h.start();
  const text = snapshotText(await h.context());
  for (let i = 0; i < 8; i++) assert.match(text, new RegExp(`Page memory ${i}`));
  assert.match(text, /part 4 of 4/);
  assert.doesNotMatch(text, /Not awake yet/);
  assert.match(text, /You are awake/);
});

test("a blocked wake becomes complete after the model pays compression", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  await h.client.run(["note", "First"]);
  await h.client.run(["note", "Second"]);
  await h.client.run(["config", "WAKE_LINES=1"]);
  await h.start();
  assert.match(snapshotText(await h.context()), /Cannot wake/);
  assert.equal(h.notices.filter((n) => n.type === "error").length, 0);
  await h.call({ action: "nap", block: "0-1", text: "Both facts" });
  assert.match(snapshotText(await h.context()), /Both facts/);
  const wake = await h.call({ action: "wake" });
  assert.match((wake.content[0] as any).text, /You are awake/);
});

test("model-facing protocol consistently uses tool calls and refreshes blocked memory automatically", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  const empty = snapshotText(await h.context());
  assert.match(empty, /optmem \{ action: "note", text:/);
  assert.doesNotMatch(empty, /\/memo|Run:/);
  await h.call({ action: "note", text: "First" });
  const second = await h.call({ action: "note", text: "Second" });
  const noteOutput = (second.content[0] as any).text as string;
  assert.match(noteOutput, /Keep what has lasting effect, drop what does not\. Invent nothing\./);
  assert.match(noteOutput, /optmem \{ action: "nap", block: "0-1", text:/);
  assert.doesNotMatch(noteOutput, /\/memo|Run:/);
  const pending = await h.call({ action: "nap" });
  assert.match((pending.content[0] as any).text, /optmem \{ action: "nap", block: "0-1", text:/);
  await h.call({ action: "nap", block: "0-1", text: "Both facts" });
  await h.client.run(["config", "WAKE_LINES=1"]);
  await h.call({ action: "wake" });
  const forgotten = await h.call({ action: "forget", block: "0-1" });
  assert.match((forgotten.content[0] as any).text, /Call `optmem \{ action: "nap" \}`/);
  const blocked = snapshotText(await h.context());
  assert.match(blocked, /The extension will refresh memory automatically/);
  assert.doesNotMatch(blocked, /wake again|\/memo|Run:/);
  await h.call({ action: "nap", block: "0-1", text: "Rebuilt facts" });
  assert.match(snapshotText(await h.context()), /Rebuilt facts/);
});

test("forget invalidates cached summaries and asks for rebuild without deleting raw history", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  await h.call({ action: "note", text: "First raw memory" });
  await h.call({ action: "note", text: "Second raw memory" });
  await h.call({ action: "nap", block: "0-1", text: "Incorrect summary" });
  await h.client.run(["config", "WAKE_LINES=1"]);
  await h.call({ action: "wake" });
  await h.call({ action: "forget", block: "0-1" });
  assert.match(snapshotText(await h.context()), /Cannot wake/);
  const recall = await h.call({ action: "recall", query: "raw memory" });
  assert.match((recall.content[0] as any).text, /First raw memory/);
  await h.call({ action: "nap", block: "0-1", text: "Corrected summary" });
  assert.match(snapshotText(await h.context()), /Corrected summary/);
});

test("bad arguments, regexes, block IDs and UTF-8 byte limits become failed tool calls", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  await assert.rejects(h.call({ action: "note" }), /requires text/);
  await assert.rejects(h.call({ action: "nap", block: "0-1" }), /requires text/);
  await assert.rejects(h.call({ action: "wake", snapshot: 1 }), /requires part/);
  await assert.rejects(h.call({ action: "recall", query: "[" }), /bad regex/);
  await assert.rejects(h.call({ action: "zoom", block: "3-9" }), /not a block/);
  await assert.rejects(h.call({ action: "note", text: "ã".repeat(150) }), /300 bytes/);
});

test("shell-looking notes are literal arguments, including paths with spaces", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment({ MEMORY_DIR: join(cwd, "a store with spaces") }));
  await h.start();
  await h.command("init");
  const marker = join(cwd, "must-not-exist");
  const text = `Literal $(touch '${marker}'); echo "quoted"`;
  await h.call({ action: "note", text });
  const recall = await h.call({ action: "recall", query: "Literal" });
  assert.ok((recall.content[0] as any).text.includes(text));
  await assert.rejects(access(marker));
});

test("deleting the default store during a session never silently recreates it", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  const store = h.client.config.directory;
  await rm(store, { recursive: true });
  await assert.rejects(h.call({ action: "note", text: "No second identity" }), /No initialized/);
  await assert.rejects(access(store));
});

test("non-UI failures are visible on stderr and do not spam ordinary requests", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment({ MEMORY_DIR: join(cwd, "missing") }));
  Object.assign(h.ctx, { hasUI: false });
  const errors: string[] = [];
  t.mock.method(console, "error", (text: string) => errors.push(text));
  await h.start();
  await h.context();
  await h.context();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No initialized/);
});

test("an aborted wake does not poison the last good cached snapshot", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  const signal = AbortSignal.abort();
  await assert.rejects(h.call({ action: "wake" }, signal));
  assert.match(snapshotText(await h.context()), /You are awake/);
  assert.equal(h.notices.filter((n) => n.type === "error").length, 0);
});

test("status/config commands are user-facing and unknown commands fail visibly", async (t) => {
  const cwd = await directory(t);
  const h = harness(cwd, environment());
  await h.start();
  await h.command("status");
  assert.match(h.sent[0].content, /Initialized: yes/);
  await h.command("config WAKE_LINES=12");
  assert.match(h.sent[1].content, /12/);
  await h.command("something-else");
  assert.match(h.notices.at(-1)!.text, /Usage:/);
});
