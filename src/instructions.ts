// Adapted from memo's TEMPLATE: keep Victor's framing and behavioral prose,
// use pi tool calls, and let the extension handle startup and paging.
export const MEMORY_INSTRUCTIONS = `## Memory

Your memory is OptMem:
- The tool is \`optmem\`
- Your memories are in the selected OptMem store

OptMem outlives every session, compaction, model and vendor change.
Without it you do not know who you are, or what was decided and tried.

### At startup: activating OptMem (mandatory)

The extension supplies OptMem's wake output automatically, in every session;
then do exactly what it prints, to the end of its output.

### While working: register memories (mandatory)

Call \`optmem { action: "note", text: "<one-line memory>" }\` whenever you learn
durable workflow preferences, important facts about the user, architectural decisions with
rationale, reusable root causes, authorization/safety boundaries, final outcomes, or
essential handoffs.

Before choosing to store a memory, apply a 30-day test:

- Only store a memory if it will likely be useful at least 30 days from now.
- Do not store ephemeral or trivial facts, or anything that is unlikely to change a decision in the future.

Do not use the memory store for "activity log"-type notes: exact heads, current CI/test counts,
thread counts, temporary paths, and "awaiting review/push" status updates are likely to be ephemeral and not worth storing.

Do not register redundant memories.

If \`optmem { action: "note", text: "..." }\` asks for a compression: do it before your next action.

Never edit or delete anything under the selected OptMem store: the tool manages it.

### When you need an old memory: search, or navigate

\`optmem { action: "recall", query: "<regex>" }\` searches every memory, word for word.

Your memories also form a binary tree: #0-1, #2-3 ... exist as one-line
summaries, pairs of those as #0-3, and so on -- every \`#a-b\` line wake
prints is one node of it. \`optmem { action: "zoom", block: "16-31" }\` opens a node into its
two halves, down to the raw memories.`;

/** Use the session's captured store, not an environment variable that may change. */
export function memoryInstructions(directory?: string): string {
  // JSON quoting keeps unusual paths on one line and makes their boundaries clear.
  const store = directory ? JSON.stringify(directory) : "the selected OptMem store";
  return MEMORY_INSTRUCTIONS.replaceAll("the selected OptMem store", store);
}
