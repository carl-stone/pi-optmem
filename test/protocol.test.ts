import assert from "node:assert/strict";
import { test } from "node:test";
import { protocolOutput } from "../src/protocol.ts";

const memo = "/a path with spaces/memo";

test("empty-store guidance uses the registered tool", () => {
  assert.equal(protocolOutput(`No memories yet. Record the first with: ${memo} note "<one line>"\nYou are awake.`),
    'No memories yet. Record the first with: `optmem { action: "note", text: "<one-line memory>" }`\nYou are awake.');
});

test("compression requests preserve the engine's instructions and show the requested tool call", () => {
  const body = 'Compress memories #16-31 into one line of at most 280 bytes.\nKeep what has lasting effect, drop what does not. Invent nothing.\n\n  #16 Some original memory';
  const output = protocolOutput(`${body}\nRun: ${memo} nap 16-31 "<your line>"`);
  assert.equal(output, `${body}\nCall \`optmem { action: "nap", block: "16-31", text: "<one-line summary>" }\``);
  assert.equal(protocolOutput(output), output);
});

test("blocked-wake guidance relies on automatic refresh, not another wake call", () => {
  for (const count of ["1 compression", "3 compressions"]) {
    assert.equal(protocolOutput(`Do the ${count} below, then run ${memo} wake again.`),
      `Do the ${count} below. The extension will refresh memory automatically.`);
  }
});

test("rebuild and recovery directions use tool arguments without losing diagnostics", () => {
  assert.equal(protocolOutput(`Forgot 1 summary, from 0-1 up. Run: ${memo} nap`),
    'Forgot 1 summary, from 0-1 up. Call `optmem { action: "nap" }`');
  assert.equal(protocolOutput(`The summary of #0-1 is blank. Run: ${memo} forget 0-1`),
    'The summary of #0-1 is blank. Call `optmem { action: "forget", block: "0-1" }`');
  assert.equal(protocolOutput(`Wrong block: 2-3. The next is 0-1. Run: ${memo} nap`),
    'Wrong block: 2-3. The next is 0-1. Call `optmem { action: "nap" }`');
});

test("explicit page reads retain their continuation coordinates", () => {
  assert.equal(protocolOutput(`Not awake yet. Run: ${memo} wake 2 99`),
    'Not awake yet. Call `optmem { action: "wake", part: 2, snapshot: 99 }`');
  assert.equal(protocolOutput(`No part 9: the memory has 2 parts. Run: ${memo} wake`),
    'No part 9: the memory has 2 parts. Call `optmem { action: "wake" }`');
});

test("raw memories and summaries are never rewritten, even when they quote protocol commands", () => {
  const lines = [
    `#0 2026-01-01 Run: ${memo} nap 0-1 "<your line>"`,
    `#16-31 Run: ${memo} forget 0-1`,
    `  #0 2026-01-01 Run: ${memo} nap`,
    `  #16-31 Do the 1 compression below, then run ${memo} wake again.`,
    "Other text is unchanged. João → reunião",
  ].join("\n");
  assert.equal(protocolOutput(lines), lines);
});
