# Offline Inter build prerequisite

AZO-969 is a focused draft stacked on PR #16, base
`903676f00c08a0c97342288e976b1d184387ae95`. Upstream remains
`v0.5.112` / `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`.
This change does **not** qualify the release or authorize merge, image build or deploy;
AZO-950 owns requalification.

## Font source and behavior

`src/app/layout.js` uses `next/font/local` with an unmodified full Inter normal
variable WOFF2 from `inter-ui@4.1.0`. The existing `--font-inter` variable,
`font-sans antialiased` body classes, 100–900 weight range, normal style,
`display: swap`, preload and automatic metric-adjusted fallback remain.
The full font retains Latin, Vietnamese, Greek and other original glyph coverage;
no Latin-only subset is introduced. Google font service output was not pinned,
so byte-for-byte visual parity with its historical changing responses is not claimed.

Exact registry manifest, tarball URL, SHA-512 registry integrity, tarball SHA-256
and per-file SHA-256 values are recorded in
`src/app/fonts/inter/PROVENANCE.json`. Font and license bytes were copied unchanged
from the verified tarball. Only this exact public-npm package was acquired, in an
isolated credential-free process. Package scripts were reviewed but never run;
no installation, transitive resolution or npm manifest/lock change was needed.

The original OFL-1.1 copyright and license ship beside the source font and at
`public/fonts/inter-LICENSE.txt`, for inclusion when distributing the public
assets with Next standalone output. Do not redistribute generated font assets
without that license. No external font CSS or runtime font fetch is introduced.
Existing Google Analytics behavior is unchanged; this is not a claim that the
whole application has no runtime network traffic.

## Regression check

With root dependencies available, run:

```sh
node --test tests/unit/offline-inter.node-test.js tests/unit/webpack-cache.node-test.js
```

The test reads the layout's actual font options, invokes the installed Next local
font loader with the real font, checks emitted local CSS/preload/fallback metrics,
parses the real variable font/glyph coverage, and verifies the vendored hashes
and OFL license. It does not import application bootstrap or make network calls.
The original production layout failed these checks; the font candidate passes
3/3. The local loader check is not a substitute for a successful production build.

## Allocation failure history

Both untouched upstream and original candidate failed offline builds in AZO-950:
Google Fonts DNS error followed by `RangeError: Array buffer allocation failed`.
A fresh original-head reproduction in AZO-969 confirmed the same sequence with
an empty build cache. Independent bounded Node ArrayBuffer allocations of
64, 128 and 256 MiB succeeded; this does not establish webpack's allocation cause.

The font candidate `79d63daa3271b4d46396ecb48fdbdbc5faf1bde7` no longer reports
Google font DNS retries, but `npm run build` still exits 1 after 14.48 seconds:

```text
RangeError: Array buffer allocation failed
    at createUnsafeBuffer (node:internal/buffer:1089:25)
    at allocate (node:buffer:448:10)
    at Function.allocUnsafe (node:buffer:413:10)
    at Function.concat (node:buffer:599:25)
    at node:internal/fs/streams:473:36
```

The diagnostic uncaught-exception monitor recorded RSS 1,410,342,912 bytes,
heap used 646,386,432 bytes and array buffers 357,169,800 bytes. The failing
allocation size and underlying address-space/capacity cause remain unproven.
Do not infer memory exhaustion from RSS alone, blame font parsing without
proof, or count removal of the Google fetch as a successful compile.

Exact supported kit: Node 22.23.4, Next 16.4.3, AJV 8.20.0, native
better-sqlite3; dependency artifact SHA-256
`e7761625c111fde4c5c6042e0d43b56a4cbb8ba8a3a32c05f698e8e366704722`.
Runs used no-network bwrap, empty allowlisted environment, read-only toolchain
and dependencies, source archive read-only then disposable scratch copy,
8 GiB scratch, CPUs 0–3, per-process AS 32 GiB, V8 heap 4 GiB, CPU 420 seconds,
NPROC 512, FSIZE 128 MiB, NOFILE 1024, command 390 seconds and outer 510/530 seconds.
RLIMIT values are per-process, not aggregate cgroup guarantees. Cache mounts are
bounded scratch-only; no host home, credentials, sockets or live data are exposed.

Three cumulative attempts reached the same allocation failure (AZO-950 original,
AZO-969 fresh original, AZO-969 font candidate).

## Webpack cache fix and fourth build

AZO-971 raised the cumulative limit from three to four builds, with no other
bound changed. Before the fourth build, static inspection and synthetic probes
traced the crash path:

- Node 22.23.4 `internal/fs/streams` line 473: after a partial `writev`,
  `Buffer.concat(buffers)` copies the **whole** original batch before slicing
  off the written prefix, so a large batch briefly needs a second full copy.
- Next 16.4.3 production builds set webpack `cache.compression: false`. The bundled
  webpack serializer queues uncompressed cache-pack chunks in batches up to about
  2 GiB on one `fs.WriteStream`.
- With the sandbox FSIZE limit of 128 MiB, a dummy 160 MiB batch on a plain
  `fs.WriteStream` writes exactly 134,217,728 bytes, allocates another full-batch
  copy, then fails with `EFBIG`. The real bundled webpack file serializer with the
  same dummy 160 MiB payload fails the same way uncompressed and succeeds as a
  732,144-byte gzip pack.

`next.config.mjs` therefore sets `cache.compression = "gzip"` for any webpack
filesystem cache. Webpack caching stays enabled. `tests/unit/webpack-cache.node-test.js`
failed before the change (`false !== 'gzip'`) and passes after it.

The fourth build (the limit then in effect), exact commit
`f35ddcfae4b898c901946ac159aeb9111478214b`, exited 0 in 36.64 seconds with no
Google font DNS retry and produced standalone output. Webpack still logged one
non-fatal warning:

```text
<w> [webpack.cache.PackFileCacheStrategy] Caching failed for pack: RangeError: Array buffer allocation failed
```

So the persistent cache pack was not saved in this sandbox. A dummy-buffer probe
under the same limits allocated 31,744 MiB before the same RangeError, which fits
the per-process 32 GiB address-space limit. The build's exact address-space usage
at that moment was not measured, so the remaining cache allocation cause is
inferred, not proved. This change turns the fatal crash into a non-fatal cache
miss; it does not prove cache reuse.

## Native hashing and the remaining address-space pressure

AZO-975 principal approval raised the cumulative build ceiling to 100, keeping
all sandbox bounds unchanged. Diagnostic builds 5–7 used exact head `abe21486`.
The cache warning was intermittent: builds 5 and 7 wrote all six gzip cache files;
build 6 wrote them but failed later with `EMFILE`. Build 5 logged one
`SQLITE_BUSY` during concurrent page-data initialization. Neither transient error
is hidden or treated as a clean pass.

The important measurement was virtual address space, not RSS. Build 5 reached
VmPeak **33,554,308 KiB**, just 124 KiB below the 32 GiB AS limit, while RSS was
about 1.2–1.5 GiB. Build 6's maps showed about **29,951 MiB of anonymous PROT_NONE
reservations**, including 4 GiB regions. Build 7 recorded three webpack WasmHash
instances plus loader-utils, llhttp and parser WASM instances in the build process.
A dummy-data probe using the real bundled hash implementation measured exactly
**4 GiB additional VA per held xxhash64 or md4 hash instance**, despite
`--disable-wasm-trap-handler`. Thus the earlier theory that hundreds of gzip
streams alone caused the pressure was refuted: only six 100 MiB gzip allocations
were observed in a cold build. Large gzip buffers then compete with the existing
WASM reservations at the AS ceiling. The original build-4 caught-error stack was
not captured; no exact original allocation site is claimed retroactively.

`next.config.mjs` now selects native crypto **SHA-256 for production webpack
output hashing**, replacing Next's WASM xxhash64 pool. Development hashing is
unchanged. This affects generated build/cache hash names, not request routing,
credentials, auth, database schema or runtime behavior. Cache compression remains
enabled; no limits, tests or assertions are removed. The new production-hash test
failed before the fix (`xxhash64 !== sha256`), then all four cache/hash tests passed.

Diagnostic build 8 on code commit `8fdabe5fd93dac882ae2b5ab2260f725ebdd02fa`
exited 0 in 36.45 seconds with empty stderr. It recorded **zero webpack WasmHash
instances**, VmPeak **22,657,252 KiB**, and all six persistent cache files
(largest 64,544,960 bytes, below FSIZE 128 MiB). This verifies the prediction that
native hashing removes about 12 GiB of address-space reservation. Qualification
must still build the exact final documentation/source head without diagnostic
wrappers and re-run owning contracts; code-build evidence is not final-head proof.

No resource limit was raised. No network exception, font mock, disabled webpack
check or relaxed assertion is part of this change. Upstream's red baseline stays
red. AZO-950 owns aggregate requalification; do not merge, release, build a
production image or deploy on this evidence.
