# Desktop release timing

The target is a tagged release in under 35 minutes when validated collectors
are available for the same build inputs. Measure from workflow creation to
completion and report the cold path and runner queue separately.

## Formal release baseline

GitHub Actions reported **84:07** for v0.36.1 and **96:43** for v0.36.2 from
workflow creation to completed status. The publish jobs finished after
**84:06** and **96:42**, respectively. Both runs were triggered by tag pushes
and completed on their first attempt.
[v0.36.1 run](https://github.com/starroyhq/agentkib/actions/runs/45947307091) · [v0.36.2 run](https://github.com/starroyhq/agentkib/actions/runs/46021885877)

Times below are minutes and seconds from the Actions jobs API. Queue starts
at the job's `created_at` and ends when its `Set up job` step starts.
Execution ends at the job's `completed_at`. Dependencies can delay job
creation, and parallel jobs overlap.

| Job | v0.36.1 queue | v0.36.1 execution | v0.36.2 queue | v0.36.2 execution |
| --- | ---: | ---: | ---: | ---: |
| Validate selected revision | 4:26 | 15:18 | 2:26 | 13:56 |
| Release workflow helpers | 13:13 | 0:29 | 3:03 | 0:46 |
| Collector · macOS arm64 | 6:59 | 43:30 | 7:37 | 50:00 |
| Collector · macOS x64 | 7:56 | 9:14 | 2:06 | 12:54 |
| Collector · Linux x64 | 7:11 | 13:00 | 5:26 | 10:32 |
| Collector · Linux arm64 | 8:18 | 11:41 | 10:06 | 12:22 |
| Collector · Windows x64 | 0:24 | 13:15 | 0:57 | 11:13 |
| Package · macOS arm64 | 5:10 | 4:40 | 1:50 | 4:14 |
| Package · macOS x64 | 3:54 | 8:54 | 2:56 | 5:50 |
| Package · Windows x64 | 1:43 | 4:07 | 7:28 | 3:38 |
| Package · Windows arm64 Preview | 5:27 | 6:32 | 1:46 | 6:21 |
| Package · Ubuntu x64 | 1:22 | 5:15 | 6:59 | 5:42 |
| Package · Ubuntu arm64 Preview | 3:27 | 5:44 | 0:57 | 6:04 |
| Package · Fedora x64 | 5:00 | 4:35 | 2:56 | 4:43 |
| Publish GitHub Release | 0:02 | 1:02 | 8:53 | 1:07 |

## Why the collector was on the critical path

The release waited for validation before it started all collector builds.
All platform packages then waited for the entire collector matrix. In
v0.36.1 the macOS arm64 collector took **50:29** from job creation through
completion, including **6:59** queued. In v0.36.2 it took **57:37**,
including **7:37** queued. The normal frontend tests within release
validation also took **13:47** and **12:17**, respectively.

The macOS arm64 collector runs a production `swift build` and then a
separate debug `swift test -j 2 --filter …`. SwiftPM compiles the test
target and its dependencies before it runs the filtered tests. In the
v0.36.1 and v0.36.2 logs, production compilation took **656.84** and
**761.77** seconds, and debug test compilation took **1,845.65** and
**2,122.78** seconds. The same 32 tests ran in **0.067** and **0.085**
seconds. The Xcode selection steps took 9 and 8 seconds.
[v0.36.1 collector logs](https://github.com/starroyhq/agentkib/actions/runs/45947307091/job/140340921465) · [v0.36.2 collector logs](https://github.com/starroyhq/agentkib/actions/runs/46021885877/job/140591833285)

## Warm path

Use collector outputs from a trusted, successful published release when the
collector build inputs match. Resolve the source release and artifact under
the repository's release workflow. Verify the artifact against the pinned
collector manifest and file checksums when staging it for the target
architecture. When a matching, usable artifact is unavailable, prepare
the collector from the pinned sources and run the existing checks, including
the macOS arm64 source regressions. Select artifacts with more than an hour
left before expiry so the package runners have time to start. Successful
warm releases retain the verified files for later releases for up to 30
days. The 35-minute target applies to the warm path.

Run revision validation in parallel with package preparation once the
release commit is resolved. Publication still requires the release
validation and every platform build to succeed. Retain the signed macOS
identity and team checks, notarization and Gatekeeper checks, native
startup smoke, installer checks, checksum and updater manifest validation,
and final GitHub asset verification. Publisher permissions and signing
credentials follow the existing release workflow.

To measure the new path, record the workflow run, collector source run or
cold build for each target, runner queue and execution times, and time to
publication. Apple notarization and runner availability can affect elapsed
time independently of collector reuse.
