# Offline Inter build prerequisite

AZO-969 supplied the build prerequisite on PR #17, based on PR #16
`903676f00c08a0c97342288e976b1d184387ae95`. Upstream remains
`v0.5.112` / `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`.
AZO-950 completed PR17 offline requalification; the final results follow the
historical failure/remediation record below. That evidence does **not** qualify
an AZO-998 modification, a container image, master integration or production deployment.
The later **AZO-1073 exact-head qualification and Criteria A3** section records
PR19 results and the accepted three product divergences. Historical results
below do not replace that checkpoint, qualify another head or clear release gates.

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
instance creations plus loader-utils, llhttp and parser WASM creations. The counters
do not measure simultaneous liveness, GC or exact reservation ownership.
A dummy-data probe using the real bundled hash implementation measured exactly
**4 GiB additional VA per held xxhash64 or md4 hash instance**, despite
`--disable-wasm-trap-handler`. Thus the earlier theory that hundreds of gzip
streams alone caused the pressure was not supported: six 100 MiB gzip allocations
were observed, not a census of all streams/native allocations. Large buffers compete with the existing
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
(largest 64,544,960 bytes, below FSIZE 128 MiB). The observed peak reduction is
10,897,056 KiB (about 10.4 GiB), consistent with the predicted mitigation, not a
direct measurement of exactly 12 GiB freed. Diagnostic wrappers add synchronous
logging, stacks and sampling: they are not timing-neutral. Build 9 on final head
`8c277666` passed cold without wrappers; warm build 10 still failed `EMFILE` when
writing `routes-manifest.json`. Diagnostic builds 11–12 succeeded but do not erase
that failure. Fresh AZO-980 review therefore required FD remediation before acceptance.

## Bounded tracing reads

Next 16.4.3 supplies NFT a custom `readFile` that bypasses NFT's own cached and
semaphored reader. Diagnostic logs observed 1,357 reads in flight and 1,022 open
descriptors, including 842 simultaneous opens of the same `.next/package.json`.
Read requests and actual open descriptors are distinct measurements.

`npm run build` now enters `scripts/build-next.cjs`, which installs a build-only
adapter for Next's bundled NFT module before loading the normal Next CLI.
`scripts/build-trace-io.cjs` wraps only caller-provided tracing reads: coalesce
identical in-flight string paths, bound distinct reads to 64 per trace invocation,
and remove entries on success or failure. No result or negative cache persists;
a subsequent read sees changed bytes. Buffer/string/error semantics and all
tracing inputs, inclusion rules and outputs remain unchanged. The adapter does
not patch global fs, write installed dependencies, omit traces, swallow errors,
raise NOFILE or add retries.

This is an explicit overlay on an internal Next interface. On a Next upgrade,
review the seam and run the real NFT parity fixture plus cold/warm qualification.
Direct `next build`, `build:bun`, dev and start bypass it; only the standard Node
`npm run build` path is qualified here. The package script changes, but dependency
ranges, lock data and the exact qualification dependency kit are unchanged.
The first behavioral RED run observed 200 duplicate reads instead of 1 and peak
40 distinct reads instead of 4. Tests then exercise real temporary files,
mutation/error cleanup, bounded concurrency, real NFT file/reason parity and CLI
version passthrough.

Code commit `22590821772fab8e7090a5480ebd81887568edc0` then passed cold build 13
in 37.03 seconds and warm build 14 in 23.22 seconds, without diagnostic wrappers,
with empty stderr. Both emitted the exact vendored Inter bytes (SHA-256
`693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`),
byte-equal public license and standalone server/custom-server. The warm build
opened all three cache indexes; atime evidence establishes opening, not cache hits.

Separate diagnostic builds 15–16 observed main-process FD peaks of 241 instead
of the earlier 1,022, and read requests in flight of 211 instead of 1,357. The
prediction of at most 128 outstanding requests was falsified: instrumentation
counts requests waiting in queues as well as active reads, and other filesystem
readers remain. The per-trace limit of 64 is a distinct contract verified by the
real-file tests. These diagnostic runs support reduced FD pressure, not a
claim of timing neutrality or a replacement for plain cold/warm qualification.
The exact final source/documentation head must also have its own evidence on
AZO-969 before aggregate requalification; the earlier warm-build failure remains
part of the history.

No resource limit was raised. No network exception, font mock, disabled webpack
check or relaxed assertion is part of this change. Upstream's red baseline stays
red. Do not merge, release, build a production image or deploy on this evidence.

## Completed AZO-950 aggregate qualification

PR17 head `cf82bec52b9f7e65a64d1019eb8569e925f716b7` passed plain cold
build 17 (35.98 seconds) and warm build 18 (22.61 seconds), both exit 0 in the
unchanged envelope above. These later results do not erase the earlier failures.
The qualified kit contains Node 22.23.4 (ABI 127), npm 10.9.9, Next 16.4.3,
Vitest 4.1.12, AJV 8.20.0 and better-sqlite3 12.11.1 (SQLite 3.53.2).

Generated qualification lockfile SHA-256 values (not tracked in PR17):

- Root: `467a653e975305130ae64844825429fe744c656a3acdfeb58e9ac00b32aa601d`.
- Tests: `177728cca604687358f026e351d5348bf93bc301e0eff3c506b2168443a811d6`.

| Full-suite result | Clean v0.5.112 | PR17 candidate |
| --- | ---: | ---: |
| Exit code | 1 | 1 |
| Total assertions | 4367 | 4480 |
| JSON passed count, including expected failures | 4230 | 4339 |
| Ordinary passes | 4215 | 4324 |
| Expected failures counted as passed | 15 | 15 |
| Assertion failures | 38 | 42 |
| Skipped | 98 | 98 |
| Todo | 1 | 1 |
| Collection errors | 2 | 2 |
| Unmatched snapshots | 17 | 17 |

All 38 common failure identities/messages match. The four candidate-only
failures in this historical run are three classified assistant-prefill policy
conflicts and one `updatedAt` tie in DB reorder parity. Classification at that
time was not a criterion exception or release approval. The later Criteria A3
decision is narrowly bound to the AZO-1073 evidence below, not a retroactive
claim that this historical suite passed. Missing `lowdb` and the absent
`cloud/src/handlers/embeddings.js` cause the two collection errors on each side;
neither was installed, hidden or excluded to manufacture a green result.
Node owning tests passed 18/18; migration/access tests passed 94/94. A combined
focused run passed 250/251, retaining its shared offline-fetch failure.

## AZO-998 version preparation

The proposed immutable release tag is `v0.5.112-azox.1`; both root and CLI
package versions are `0.5.112-azox.1`. No tag has been created. The unchanged
publishing validator requires exact equality and leaves `latest` unchanged for
this prerelease on tag push. A manual `promote_latest` input still explicitly
overrides that existing policy; no workflow was dispatched.

```sh
node --test tests/unit/release-version.node-test.js
```

This runs the actual workflow validator with isolated package/Git fixtures and
no network. It rejected the original bare package versions, then passed after
alignment. The same tests exercise both actual update comparators: stripping
the AZOX suffix prevents `Number('112-azox')` from hiding later upstream patch
versions. Comparisons remain upstream-core comparisons, not full SemVer ordering.

AZO-998 local source tree `eac50e80263bb4c8fa166d7a6ea35a21a3eadd9a`
passed 30/30 Node owning tests, 162/162 focused contract tests and standard
`npm run build` (build 19, exit 0, 36.75 seconds, Node 22.23.4 / Next 16.4.3).
Build stderr was empty; stdout retained the expected cold-cache warning.
The full suite remained red: 4480 total, 4325 ordinary passes, 15 expected
failures, 41 assertion failures, 98 skipped, 1 todo, 2 collection errors and
17 unmatched snapshots. All 41 failure identities/messages match PR17;
its equal-timestamp DB reorder failure did not recur in that run; it recurred
in AZO-1001 below. This is not a DB fix.
All 38 upstream failures remain, with the same messages; the three extra failures
are the existing assistant-prefill policy conflicts. Nothing was excluded.
Focused stderr contains expected swallowed-error fixture diagnostics.

Later workflow edits are work in progress, not covered by build 19: source and
recipe now come from the same validated commit; BuildKit exports an OCI archive
with provenance and SBOM enabled. Local smoke imports only the runtime platform,
uses `--pull=never` and a loopback-only health port, and precedes registry login
and publication. The original archive is reserved for publication with all
attestations. Manifest validation distinguishes the two runtime platforms from
linked BuildKit attestation descriptors and rejects missing/orphan descriptors.
Actual shell-step fixtures failed before these changes and then passed.
They double Docker, skopeo and health endpoints; they do not prove real OCI
transport, digest preservation, provenance/SBOM contents or container health.

AZO-1001 recipe remediation: the base image is pinned to the official
`node:22.23.4-alpine` index digest verified against registry response bytes;
the root install is `npm ci --ignore-scripts` from the committed qualified lock;
better-sqlite3 is rebuilt from locked source and the Next build runs with
`--network=none`; lazy runtime packages are copied from the same locked install.
Docker is still unqualified as an image: nothing was built or run, Alpine `apk`
packages remain unpinned, musl/arm64 native behavior and the base image's
`/usr/local` Node header layout are unverified, and skipping the dev-only
`unrs-resolver` postinstall has not been exercised inside Docker.

AZO-1001 local qualification ran in the same no-network, read-only-toolchain
sandbox and exact Node 22.23.4 / Next 16.4.3 offline kit, against staged source
tree `313b79477d397b836df7b9bd206a01af1a098612` (PR17 head
`cf82bec52b9f7e65a64d1019eb8569e925f716b7` plus the recipe/lock/workflow
changes):

| Check | Result |
|---|---|
| Lock regression (RED without committed lock, then GREEN) | offline `npm ci --dry-run` exits 0; a changed `next` spec fails with `ENOTCACHED` (npm attempts registry resolution, no fetch succeeds) |
| Node unit tests | 41/41 passed |
| Focused contract tests (14 files) | 163/163 passed; expected swallowed-error fixture diagnostics retained |
| Build20 | standard `npm run build` exit 0 in 36.13s, empty stderr |
| Candidate full suite | exit 1: 4480 total, 4339 passed, 42 failed, 98 skipped, 1 todo, 17 unmatched snapshots, 2 collection errors (`db-benchmark`, `embeddings.cloud`) |
| Fresh PR17 baseline full suite (tree `e2658009b13bd7be220d30a0fa2c5a6df6884207`) | exit 1: 4480 total, 4340 passed, 41 failed, same skips, snapshots and collection errors |

The only extra candidate failure is the known equal-`updatedAt` reorder tie in
`tests/unit/db-sqlite-vs-lowdb.test.js` ("providerConnections: CRUD + reorder by
priority", expected 'a' to be 'c'); the same identity appears in the historical
PR17 aggregate. No baseline failure disappeared. The full suite is not green and
the flake is neither excluded nor fixed. Later documentation-only edits are
re-checked with the Node unit tests only; build and full-suite evidence stays
bound to the tree above.

Workflow review notes (Manager self-review, not independent; no workflow was
executed): each platform image is smoke-tested from its local OCI archive before
any registry login, pushed by `skopeo copy --all --preserve-digests` to a
per-run GHCR candidate tag, and the pushed raw manifest digest must equal the
archive digest. The version index is assembled only from those digests and
validated for exactly one `linux/amd64` and one `linux/arm64` runtime with
linked attestation descriptors; SBOM/provenance payload contents are not
inspected. Remaining caveats: skopeo comes from unpinned `apt-get`, actions and
`apk` packages are not pinned by digest, candidate tags are never cleaned up,
and the resolved-version smoke runs the mutable version tag on all interfaces
(`--publish 20128:20128`) on the runner. Real transport, digest preservation
and attestation behavior remain unverified until an authorized workflow run.

Obtaining the verified official base-image digest and publishing one draft
source PR are covered by exact AZO-1001 Scope grants; no image build, registry
push, merge, tag/release or deploy is implied. No release-readiness claim is
made. After AZO-1001 is accepted, AZO-999 must integrate from `master`, resolve
the recorded conflicts and requalify that new integration head before release
gates. PR17 and AZO-1001 results above must not be relabeled as evidence for
that future tree.

## AZO-1073 exact-head qualification and Criteria A3

This later checkpoint supersedes earlier qualification **for its exact source
only**; earlier failures and receipts above remain history. Upstream is pinned
v0.5.112 `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`, fork baseline master
`1f508bcfa7f2b0e76662be7aefd39d0087747aa5`, candidate PR19
`b42ab96096c495c53cdd29a399804c73b422955b`.
AZO-1073 report attachment: `01a199c4-d313-7414-85d7-0749d40064cc`.
AZO-1079 edits documentation only; no target tests or build ran in that docs
update. These results must not be relabeled as new-head passes.

| AZO-1073 invocation | Exit | Pass | Fail | Skip | Todo | Limit |
|---|---:|---:|---:|---:|---:|---|
| Clean upstream full Vitest | 1 | 4238 | 30 | 98 | 1 | 4367 assertions; cloud collection failure separate |
| Candidate full Vitest | 1 | 4557 | 27 | 98 | 1 | 4683 assertions; cloud collection failure separate |
| Candidate contracts, 24 files | 0 | 303 | 0 | 0 | 0 | Separate invocation, not a substitute for upstream failures |
| Candidate Node tests, 9 files | 0 | 43 | 0 | 0 | 0 | Mocks/source fixtures; not native musl/arm64 or OCI proof |
| Clean upstream `npm run build` | 134 | — | — | — | — | Google-font resolution error marker; no compile/postbuild/output |
| Candidate `npm run build` | 0 | — | — | — | — | Compile/postbuild, standalone server and BUILD_ID observed |

Both full suites remain red. Comparison uses identities, not subtraction:
24 common failed identities remain, exactly three common identities change
PASS to FAIL, zero candidate-only failing identity among discovered assertions,
and five same-identity golden header tests change FAIL to PASS. Candidate
snapshots: 179 matched, zero unmatched/added; upstream: 162 matched, five
unmatched, 12 added. Replacement of the upstream API-key source-string test by
behavioral tests is not a same-identity fix.
`unit/embeddings.cloud.test.js` fails collection on both trees because the cloud
worker is absent: zero collected assertions, not a pass. The 98 skips and one
todo remain visible, including five skipped DB benchmark cases. No retired
Responses/SSE response-conversion path is replayed for the reasoning todo.

Three earlier Node harness attempts remain charged: missing `.git` mountpoint
(exit1, target start unproved), missing `/dev/null` (28 pass/15 fail), then
read-only null O_RDWR denial (28 pass/15 fail). Terminal 43/43 uses a read-only
source Git fixture and scratch regular-file null emulation, not a native null
device. No test was changed to repair that harness. All candidate build output
was destroyed with scratch: **no retained immutable release artifact**.

### A3 accepts product divergence, not upstream compatibility

Requester/principal chose AZO-1078 option 1 at
`01a199fd-efe4-70b1-8693-12e56e980f38`, 2026-11-02T02:01:58Z;
record attachment `01a199f7-2fe4-745e-b28b-acd232e6c81c`.
Goal AZO-904 Criteria A3 accepts only these three failures as AZOX product
divergences in criterion 3:

| Unchanged upstream assertion | Disposition |
|---|---|
| `tests/unit/claude-trailing-user-turn-source-formats.test.js:18` (Gemini terminal model) | PASS upstream / FAIL candidate |
| Same file `:29` (Responses terminal assistant) | PASS upstream / FAIL candidate |
| `tests/unit/claude-trailing-user-turn.test.js:66` (intentional native Claude prefill) | PASS upstream / FAIL candidate; line67 not executed after line66 fails |

Upstream expects default roles `[user, assistant]`; AZOX preserves assistant
history and appends continuation, yielding `[user, assistant, user]`. Explicit
`x-9router-assistant-prefill: preserve` changes the input and cannot prove
default compatibility. All assertions and failures stay unchanged; separate
AZOX preserve coverage does not make native line67 pass. Earlier technical
classification alone was not approval. A3 is not a test waiver or release
approval, and grants no Git/merge/tag/image/deploy/Result authority.

Reuse A3 only within this Goal when fresh qualification and exact-head review
prove the same three assertions/default behavior and cause unchanged. Different
failures or changed behavior require the proper gate. C1 rights, budgets,
counters and all other criteria remain unchanged; no new target reservation
was made for AZO-1079 documentation validation.

### Remaining release work

AZO-1075 exact-head self-review (`independent_review: false`), report attachment
`01a199fe-5009-7588-97ca-69e0809e1c28`, remains **remediate**, not release
acceptance. A3 resolves only its narrow product requirement boundary.

- Third-party notices (AZO-1098): the root `package.json` declares `MIT`,
  matching `LICENSE`. `THIRD_PARTY_NOTICES.md` is generated by
  `node scripts/generate-third-party-notices.mjs` (check with `--check`) from
  the traced standalone closure snapshot
  `third_party/standalone-closure-glibc-x64.json` (59 packages), the
  Dockerfile's extra copies (node-forge, next, sql.js, node-machine-id,
  wreq-js/@wreq-js, playwright-core), `package-lock.json`, and original
  license/notice files copied from the hash-verified offline kit with SHA-256
  pins in `third_party/license-sources.json`. It covers the libvips/sharp
  LGPL-3.0-or-later obligations and library replacement method (full LGPLv3
  and GPLv3 texts in `third_party/licenses/`), CC-BY-4.0 attribution for
  caniuse-lite, and elects BSD-3-Clause for node-forge. The postbuild
  (`scripts/copy-standalone-assets.mjs`) copies `LICENSE`,
  `THIRD_PARTY_NOTICES.md` and `third_party/licenses/*` into
  `.next/standalone`, so the Dockerfile's existing standalone COPY places them
  at `/app` in the image; nothing reads them at runtime.
  `tests/unit/third-party-notices.node-test.js` checks all of this statically
  and offline. No build or image was run for this change.
- Remaining license limits: the closure is Linux x64 glibc while the image is
  Alpine musl amd64/arm64, so the image's platform packages are not proven.
  apk `su-exec`, `ffmpeg`, their dependencies and the Node Alpine base image
  have no license claim until an image SBOM exists (OCI gate closed). Code
  bundled into `.next` chunks (for example dompurify
  `(MPL-2.0 OR Apache-2.0)` via monaco-editor), `next/dist/compiled`, and the
  noble-hashes-derived `open-sse/lib/deepseek-pow-hash.js` still need
  attribution review. Dependency advisory review also remains open.
- Preserve native line67, cloud collection, skip/todo gaps; obtain separate
  native musl/arm64 and OCI runtime evidence when authorized.
- Retain an immutable artifact with exact source/image provenance only after
  qualification/security gates. No image was built/run/pushed by these checks.
- Resolve inherited master-to-candidate whitespace at
  `tests/unit/gemini-contents-normalization.test.js:196` (new blank line at EOF),
  as a separate source output; docs-only changes do not fix it.
- Qualify and review changed heads with counters reserved before target launch;
  never copy b42 results as new-head PASS. Honor repository linear history and
  enforced checks; empty PR checks are not CI passed.
- Before rollout, separately meet isolated migration/backup/rollback,
  direct/LiteLLM smoke and exact live identity conditions. No release, deploy
  or Result is authorized by AZO-1079.
