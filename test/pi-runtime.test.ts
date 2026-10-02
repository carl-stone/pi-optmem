import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager,
  type ModelRegistry, type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import { configuration, MemoClient } from "../src/memo.ts";
import { createOptmemExtension, MEMORY_MESSAGE } from "../extension.ts";
import { memoryInstructions } from "../src/instructions.ts";

async function setup(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-optmem-runtime-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, MEMORY_DIR: join(cwd, "memory") };
  delete env.OPTMEM_DISABLED;
  delete env.OPTMEM_PYTHON;
  const client = new MemoClient(configuration(env, cwd));
  await client.init();
  return { cwd, env, client };
}

async function runnerFor(cwd: string, loader: DefaultResourceLoader) {
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings, []);
  const manager = SessionManager.inMemory(cwd);
  // Model services are intentionally absent: these tests only exercise the
  // real Pi loader, event dispatcher, context transformation, and session tree.
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, {} as ModelRegistry);
  const errors: ExtensionError[] = [];
  runner.onError((error) => errors.push(error));
  return { runner, manager, errors, loaded };
}

function options(cwd: string) {
  return {
    cwd, agentDir: join(cwd, "agent"), settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  };
}

test("real Pi renders memory guidance once in its own system-prompt section", async (t) => {
  const { cwd, env, client } = await setup(t);
  let rendered = "";
  const loader = new DefaultResourceLoader({
    ...options(cwd),
    extensionFactories: [
      createOptmemExtension({ env }),
      (pi) => { pi.on("before_agent_start", (event) => { rendered = event.systemPrompt; }); },
    ],
  });
  const { runner, errors } = await runnerFor(cwd, loader);
  await runner.emit({ type: "session_start", reason: "startup" });
  const tool = runner.getToolDefinition("optmem")!;
  assert.ok(tool);
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(tool.executionMode, "sequential");
  assert.doesNotMatch(tool.description, /CLI|shell|subagent/i);
  assert.deepEqual((tool.parameters as any).required, ["action"]);

  const first = await runner.emitBeforeAgentStart("Hello", undefined, {
    cwd, selectedTools: ["read", "optmem"],
    toolSnippets: { optmem: tool.promptSnippet! },
    sections: { other: "Other extension instructions" },
  });
  const expected = memoryInstructions(client.config.directory);
  assert.ok(rendered.includes(`<optmem>\n${expected}\n</optmem>`));
  assert.match(rendered, /- optmem: Read and maintain permanent cross-session memory/);
  assert.ok(rendered.includes("<other>\nOther extension instructions\n</other>"));
  assert.ok(rendered.startsWith("You are an expert coding assistant"));
  assert.doesNotMatch(rendered, /- ## Memory|call `optmem` with|memo CLI/i);
  assert.equal(first.systemPromptOptions.forceSystemPrompt, undefined);

  await runner.emitBeforeAgentStart("Next turn", undefined, first.systemPromptOptions);
  assert.equal(rendered.match(/<optmem>/g)?.length, 1);
  assert.equal(rendered.match(/Your memory is OptMem:/g)?.length, 1);

  await runner.emitBeforeAgentStart("Custom prompt", undefined, {
    ...first.systemPromptOptions, customPrompt: "User's custom system prompt",
  });
  assert.ok(rendered.startsWith("User's custom system prompt"));
  assert.ok(rendered.includes(`<optmem>\n${expected}\n</optmem>`));

  const inactive = await runner.emitBeforeAgentStart("Tool disabled", undefined, {
    ...first.systemPromptOptions, selectedTools: ["read"],
  });
  assert.equal(inactive.systemPromptOptions.sections.optmem, undefined);
  assert.doesNotMatch(rendered, /<optmem>|Your memory is OptMem:/);
  assert.deepEqual(errors, []);
});

test("real Pi loads the packaged extension from disk without initializing during load", async (t) => {
  const { cwd, env, client } = await setup(t);
  const previous = process.env.MEMORY_DIR;
  const disabled = process.env.OPTMEM_DISABLED;
  process.env.MEMORY_DIR = env.MEMORY_DIR;
  delete process.env.OPTMEM_DISABLED;
  let result: Awaited<ReturnType<typeof runnerFor>>;
  try {
    const loader = new DefaultResourceLoader({ ...options(cwd), additionalExtensionPaths: [resolve("extension.ts")] });
    result = await runnerFor(cwd, loader);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = previous;
    if (disabled === undefined) delete process.env.OPTMEM_DISABLED;
    else process.env.OPTMEM_DISABLED = disabled;
  }
  const { runner, manager, errors } = result;
  assert.ok(runner.getToolDefinition("optmem"));
  assert.ok(runner.getCommand("optmem"));
  assert.deepEqual(manager.getEntries(), []);
  await client.run(["note", "A memory loaded by the actual Pi runtime"]);
  await runner.emit({ type: "session_start", reason: "startup" });
  const messages = await runner.emitContext([
    { role: "system", content: "Base system instructions", timestamp: 1 },
    { role: "user", content: "Hello", timestamp: 2 },
  ]);
  assert.equal(messages[0].role, "system");
  assert.match((messages[1] as any).content, /A memory loaded by the actual Pi runtime/);
  assert.equal(messages[2].role, "user");
  assert.deepEqual(manager.getEntries(), []);
  assert.deepEqual(errors, []);
});

test("real Pi restores memory across session projection compaction and retry dispatch", async (t) => {
  const { cwd, env, client } = await setup(t);
  const loader = new DefaultResourceLoader({ ...options(cwd), extensionFactories: [createOptmemExtension({ env })] });
  const { runner, manager, errors } = await runnerFor(cwd, loader);
  await client.run(["note", "Do not lose this durable fact"]);
  await runner.emit({ type: "session_start", reason: "startup" });
  manager.appendMessage({ role: "user", content: "Old conversation", timestamp: 1 });
  const kept = manager.appendMessage({ role: "user", content: "Current question", timestamp: 2 });
  manager.appendCompaction("Summary without the memory", kept, 1000);
  const compact = manager.getEntries().find((entry) => entry.type === "compaction")!;
  assert.equal(compact.type, "compaction");
  await runner.emit({ type: "session_compact", compactionEntry: compact, fromExtension: false, reason: "overflow", willRetry: true });
  const canonical = manager.buildSessionContext().messages;
  const first = await runner.emitContext(canonical);
  const second = await runner.emitContext(first);
  assert.equal(second.filter((m) => m.role === "custom" && m.customType === MEMORY_MESSAGE).length, 1);
  assert.match((second.find((m) => m.role === "custom") as any).content, /Do not lose this durable fact/);
  assert.equal(canonical.some((m) => m.role === "custom"), false);
  assert.equal(manager.getEntries().some((e) => e.type === "custom_message"), false);
  assert.deepEqual(errors, []);
});

test("real Pi disabled extension has no registered hooks, commands or tools", async (t) => {
  const { cwd, env } = await setup(t);
  const loader = new DefaultResourceLoader({
    ...options(cwd), extensionFactories: [createOptmemExtension({ env: { ...env, OPTMEM_DISABLED: "1" } })],
  });
  const { runner, loaded } = await runnerFor(cwd, loader);
  assert.equal(runner.getToolDefinition("optmem"), undefined);
  assert.equal(runner.getCommand("optmem"), undefined);
  for (const extension of loaded.extensions) assert.equal(extension.handlers.size, 0);
});
