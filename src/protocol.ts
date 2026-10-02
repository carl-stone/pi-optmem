import type { Parameters } from "./arguments.ts";

function call(params: Parameters): string {
  const args = Object.entries(params).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ");
  return `\`optmem { ${args} }\``;
}

/** Adapt engine-owned CLI directions only; original memories stay byte-for-byte intact. */
export function protocolOutput(output: string): string {
  return output.split("\n").map((line) => {
    // wake/recall/zoom and compression inputs all identify memory lines this way.
    if (/^\s*#\d+(?:-\d+)?\s/.test(line)) return line;
    if (/^No memories yet\. Record the first with: .+ note "<one line>"$/.test(line)) {
      return `No memories yet. Record the first with: ${call({ action: "note", text: "<one-line memory>" })}`;
    }
    const blocked = /^Do the (\d+ compressions?) below, then run .+ wake again\.$/.exec(line);
    if (blocked) return `Do the ${blocked[1]} below. The extension will refresh memory automatically.`;
    return line
      .replace(/Run: .+ nap (\d+-\d+) "<your line>"$/, (_match, block: string) =>
        `Call ${call({ action: "nap", block, text: "<one-line summary>" })}`)
      .replace(/Run: .+ nap$/, `Call ${call({ action: "nap" })}`)
      .replace(/Run: .+ forget (\d+-\d+)$/, (_match, block: string) =>
        `Call ${call({ action: "forget", block })}`)
      .replace(/Run: .+ wake (\d+) (\d+)$/, (_match, part: string, snapshot: string) =>
        `Call ${call({ action: "wake", part: Number(part), snapshot: Number(snapshot) })}`)
      .replace(/Run: .+ wake$/, `Call ${call({ action: "wake" })}`);
  }).join("\n");
}
