# Upstream provenance

The files `memo` and `upstream-test.py` are unmodified copies of
Victor Taelin's [OptMem](https://github.com/VictorTaelin/OptMem), at commit
[`1fb164cf39028047781f72ac3bb1e5a691c1dcb0`](https://github.com/VictorTaelin/OptMem/commit/1fb164cf39028047781f72ac3bb1e5a691c1dcb0).
`upstream-test.py` is upstream's `test.py`, renamed to distinguish its engine
invariant checks from this package's integration tests.

The upstream snapshot defaults to 96 wake lines and uses 320-byte log records
and 288-byte summary records. No storage-format changes are made here.

## Updating

1. Review the upstream diff, particularly record widths, locking, commands,
   output protocol, and default budgets.
2. Copy `memo` and `test.py` (as `upstream-test.py`) from one pinned commit.
3. Preserve `memo`'s executable bit. Update this document and provenance tests.
4. Run `npm run check` and review the package contents with
   `npm pack --dry-run`. Do not run tests against a personal memory store.

Nothing downloads or updates the engine at runtime.

## Attribution and licensing

Memory design, engine, and engine tests: Victor Taelin and OptMem contributors.
Pi integration inspiration: Evan Verma's
[pi-pod/pi-optmem](https://github.com/pi-pod/pi-optmem).
The TypeScript integration in this repository is newly written.

The pinned upstream repository does not contain a LICENSE file. This repository
does not invent a license for that code or claim its authorship. The npm
manifest is marked `UNLICENSED`; public source availability is not a license
grant. Resolve licensing before publishing/distributing an npm release.
