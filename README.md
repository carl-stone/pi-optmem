# OptMem for pi

A small [pi](https://pi.dev) extension around
[Victor Taelin's OptMem](https://github.com/VictorTaelin/OptMem): the same
append-only memory log and rebuildable summary tree, with explicit initialization
for configured stores, a complete subagent opt-out, and memory context that
survives pi compaction.

No separate model, database, background jobs, or runtime downloads.

## Install

Requires **Node.js 22.19+**, **Python 3.7+**, and a current pi installation
(tested with pi **0.99.2** and its `session_start`, `session_compact`, and
`context` APIs).

```sh
pi install git:github.com/carl-stone/pi-optmem
```

Restart pi after installation. For a project-local installation, add `-l`.
For a temporary local trial without changing settings:

```sh
pi -e /path/to/pi-optmem
```

This is a replacement for, not an addition to, `pi-pod/pi-optmem`. Disable or
remove the other extension first; both register the `optmem` tool. Remove the
standalone OptMem `## Memory` instructions from your agent context files when
using this extension, especially before using the subagent opt-out.

The package metadata uses `@carl-stone/pi-optmem`; it is **not published to
npm**. Install from GitHub. See [UPSTREAM.md](UPSTREAM.md) for
provenance and the unresolved upstream licensing.

## Initialization and location

Without `MEMORY_DIR`, memory lives at `~/.optmem/memory`. The extension creates
that default store on first session startup, or uses it unchanged if it exists.

An explicitly configured store must already be initialized:

```sh
MEMORY_DIR="$HOME/synced/agent-memory" pi
```

If that path is missing, or it is a directory without `LOG.txt`, startup
reports an error and **does not create it**. Correct the path and restart pi,
or deliberately run:

```text
/optmem init
```

An empty `MEMORY_DIR` is an error, not a request to use the default. Relative
paths resolve against the session's working directory; `~` is supported.
The resolved path and child environment are captured for the session. Restart
or reload pi to apply environment changes.

`init` is upstream's idempotent operation: it creates missing files without
rewriting existing memories, summaries, or tuned configuration. A store that
disappears during a session is never silently recreated, including the default.

## Disable for a subagent (or any other session)

```sh
OPTMEM_DISABLED=1 pi ...
```

This returns before registering any hooks, tool, command, or memory guidance.
It performs no store checks, initialization, wake, or memory injection.
It does not change other extensions.

A future subagent spawner should set this variable **only in the child's
environment**. No particular subagent framework is required:

```ts
spawn("pi", args, {
  env: { ...process.env, OPTMEM_DISABLED: "1" },
});
```

Only the exact value `1` disables the extension. This is an integration opt-out,
**not a filesystem sandbox**: a child with bash can still run the standalone CLI.
Do not leave old `AGENTS.md` instructions telling disabled sessions to run memo.

## Commands

| Command | Purpose |
| --- | --- |
| `/optmem` or `/optmem status` | Show the store and context status |
| `/optmem init` | Deliberately initialize the selected store |
| `/optmem wake` | Refresh memory for the next model request |
| `/optmem config` | Show upstream size settings |
| `/optmem config WAKE_LINES=120` | Change the reading budget |
| `/optmem config WAKE_LINES=` | Restore the upstream default |

The current upstream default is **96 wake lines**. This is a reading budget,
not a storage limit. The engine limits notes and summaries to **280 UTF-8
bytes**, even though schema string lengths are measured in characters.

The agent's structured `optmem` tool provides:

| Action | Parameters |
| --- | --- |
| `note` | `text` |
| `nap` | No parameters to request work; `block` + `text` to submit a summary |
| `recall` | `query`, a case-insensitive Python regex |
| `zoom` | `block`, e.g. `16-31` |
| `forget` | `block`; drops summaries, **not the original memories** |
| `wake` | Refresh all pages; optional `part` + `snapshot` to read a specific page |

The bundled CLI is still available for inspection:

```sh
python3 /path/to/pi-optmem/memo config
python3 /path/to/pi-optmem/memo recall 'project name'
```

Set `MEMORY_DIR` for these commands too if you use a non-default store.
Set `OPTMEM_PYTHON` to an executable name or path if Python is not available as
`python3` (`python` on Windows). It is an executable, not a shell command.

## How context works

- At session startup, wake reads a bounded snapshot. The extension collects
  continuation pages itself, using the same printed snapshot count on each page.
- Before every model request, pi's `context` hook includes exactly one cached
  memory snapshot. It is request-local, not appended repeatedly to session history.
- Ordinary turns reuse the cache without re-reading the store. Newly noted facts
  are already in tool history.
- Successful compaction and tree navigation invalidate the cache. The next
  request refreshes it, including automatic overflow retries that have no new
  `before_agent_start` event.
- If wake needs missing summaries, the agent receives the compression request.
  After its nap submissions, blocked memory is refreshed.
- Guidance is provided through pi's tool prompt guidelines, without replacing
  the system prompt.

There is no background synchronization. Use `/optmem wake` to pick up changes
from another session immediately. Model-directed `wake` results remain ordinary
tool history, so an explicit wake can also leave historical output in a transcript;
the extension itself inserts only one current snapshot.

Subprocesses have a **30-second timeout**, cancellation, and a **128 KiB**
output ceiling. Accumulated wake context is also capped at 128 KiB and 256 pages.
Excessive output fails visibly instead of silently dropping continuation
instructions. Tune `WAKE_LINES`, `PART_CHARS`, or `PART_LINES` if necessary.

## Privacy and storage

```text
~/.optmem/memory/
  LOG.txt     append-only original memories
  TREE/       rebuildable summaries
  config      upstream size settings
```

The extension and engine make no network calls. **Injected memory is sent to
the model provider through pi**, just like normal conversation context. Memory
tool results can be saved in pi session history. Stores are shared across
projects unless you choose separate `MEMORY_DIR` paths; choose those paths with
privacy and project isolation in mind.

Back up the store before switching integrations. Do not edit `LOG.txt` or
`TREE/` manually.

## Development and tests

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

All integration tests use temporary stores. None use your personal memories
or call an LLM provider. The suites are deliberately separated:

- `npm test`: named TypeScript integration tests for initialization, exclusion,
  lifecycle/context restoration, paging, validation, subprocess safety,
  cancellation, timeouts, concurrency, and actual pi loading/event dispatch.
- `npm run test:upstream`: Victor's unchanged Python invariant script. Its
  large “passed” count is looped checks, **not distinct test cases**.
- `npm run typecheck`: check the adapter against pi's extension types.

CI runs integration tests on Linux, macOS, and Windows. The inherited Python
suite runs on Linux/macOS because some of its checks assume POSIX permissions.
Local testing was on macOS; cross-platform CI results are authoritative.

Runtime host packages are peers, not bundled copies of pi. A production-only
audit is clean. The pinned development SDK currently shrinkwraps
`brace-expansion@5.0.9`, which has upstream DoS advisories; a full `npm audit`
reports that development-only dependency. Update the SDK when its shrinkwrap is
fixed rather than hiding the finding.
