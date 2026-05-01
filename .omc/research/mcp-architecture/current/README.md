# §2 — Current implementation map

> *Editorial note: §2 of the original report. The file-by-file rundown is collected in [`file-map.md`](./file-map.md), and the gap-to-file table is broken out into [`gap-catalog.md`](./gap-catalog.md) so the gap numbers (#1–#20) can be cross-referenced from the [proposed architecture](../architecture/) and [migration plan](../migration.md).*

## Pages

- [file-map.md](./file-map.md) — every file we currently own (and a couple we don't), what it does, the spec sections it implements, and the deviations from spec.
- [gap-catalog.md](./gap-catalog.md) — the consolidated gap-to-file table (gaps #1–#20), each row pointing to the file responsible.

## Reading order

1. Start with [gap-catalog.md](./gap-catalog.md) for the 30-second tour of what's broken.
2. Drill into the relevant entry in [file-map.md](./file-map.md) for spec context and code pointers.
3. Cross-reference the [§1 spec inventory](../spec/) entry the file claims to implement.
