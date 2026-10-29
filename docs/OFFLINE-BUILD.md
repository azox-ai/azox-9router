# Offline Inter build prerequisite

AZO-969 is a focused draft stacked on PR #16, base
`903676f00c08a0c97342288e976b1d184387ae95`. Upstream remains
`v0.5.112` / `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`.
This font change does **not** qualify the production build or authorize release.

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
node --test tests/unit/offline-inter.node-test.js
```

The test reads the layout's actual font options, invokes the installed Next local
font loader with the real font, checks emitted local CSS/preload/fallback metrics,
parses the real variable font/glyph coverage, and verifies the vendored hashes
and OFL license. It does not import application bootstrap or make network calls.
The original production layout failed these checks; the font candidate passes
3/3. The local loader check is not a substitute for a successful production build.

## Remaining allocation blocker

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
AZO-969 fresh original, AZO-969 font candidate). No fourth build, increased bounds,
font mocks, disabled assertions or network exception is part of this change.
A later source revision must receive fresh exact-head build evidence after the
retry gate is explicitly resolved. Upstream's red baseline stays red; draft stack
must not merge, release, build a production image or deploy on this evidence.
