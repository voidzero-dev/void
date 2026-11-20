# baseline-workers benchmark report

Successful run: **2026-11-19T08:30:31.073Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-19T08:15:46.355Z                                         |
| Run finished (UTC)                    | 2026-11-19T08:30:31.073Z                                         |
| Platform                              | darwin                                                           |
| OS release                            | 25.6.0                                                           |
| Node.js                               | v24.22.1                                                         |
| oha                                   | oha 1.17.0                                                       |
| CPU                                   | Apple M5 Pro                                                     |
| Architecture                          | arm64                                                            |
| Logical cores / available parallelism | 18 / 18                                                          |
| Network type / interface              | wifi / en0                                                       |
| Hostname SHA-256                      | ac84d7c6ed5458a31e79a25f931f16b87220758dc1677e9cdf9022505db370aa |

Network information describes the local default route, not a verified end-to-end path.

## Workload

### baseline

| Field                                                       | Value                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| URL                                                         | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev/ |
| Method                                                      | GET                                                                     |
| Expected status                                             | 200                                                                     |
| Expected body size per response                             | 0 bytes                                                                 |
| Measured requests per round                                 | 1000                                                                    |
| Latency rounds                                              | 10                                                                      |
| Total measured requests                                     | 10000                                                                   |
| Duration limit per round                                    | None                                                                    |
| Connections                                                 | 1                                                                       |
| Rate limit                                                  | None                                                                    |
| Request timeout                                             | 30s                                                                     |
| HTTP version                                                | 1.1                                                                     |
| Keep-alive                                                  | true                                                                    |
| Warmup requests per round (excluded from client statistics) | 50                                                                      |
| Access authentication                                       | temporary-login                                                         |
| HTTP response counts                                        | 200: 10,000                                                             |

</details>

## Build & deployment

### Bundle size

| Format | Size (Median) |
| ------ | ------------- |
| Raw    | 187 bytes     |
| Gzip   | 161 bytes     |

### Timing summary

| Phase          | Mean         | Mean 95% CI               | Median       |
| -------------- | ------------ | ------------------------- | ------------ |
| Build          | 7.8 ms       | [7.5, 8.167] ms           | 8 ms         |
| Upload         | 5,313.333 ms | [5,070.992, 5,478] ms     | 5,360 ms     |
| Worker startup | 1.233 ms     | [1.067, 1.433] ms         | 1 ms         |
| `cf deploy`    | 8,953.367 ms | [8,594.954, 9,191.197] ms | 9,005.076 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker                                                          | void-perf-baseline-workers                                             |
| Worker ID                                                       | 4f1d26c4641a43588ec1eb090de69ae0                                       |
| Version ID                                                      | bd1eeb2a-e9ec-4adc-a0e6-1b19bbde601a                                   |
| Origin                                                          | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 3,954.38 ms                                                            |
| Final run workflow wall time (includes cleanup, lookup, Access) | 14,683.238 ms                                                          |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range   |
| ------ | ---------------- | ------------- |
| Raw    | 187 bytes        | 187–187 bytes |
| Gzip   | 161 bytes        | 161–161 bytes |

Bundle-size variation: None observed.

#### Full timing statistics

| Phase                       | Valid / missing | Mean         | Mean 95% CI               | Median       | Median 95% CI             | Sample SD  | IQR        | Min–max               | Mean CI half-width / mean | ±5% target |
| --------------------------- | --------------- | ------------ | ------------------------- | ------------ | ------------------------- | ---------- | ---------- | --------------------- | ------------------------- | ---------- |
| Build                       | 30 / 0          | 7.8 ms       | [7.5, 8.167] ms           | 8 ms         | [7, 8] ms                 | 0.961 ms   | 1 ms       | 7–12 ms               | 4.27%                     | Met        |
| Upload                      | 30 / 0          | 5,313.333 ms | [5,070.992, 5,478] ms     | 5,360 ms     | [5,230, 5,425] ms         | 598.638 ms | 300 ms     | 2,410–6,140 ms        | 3.83%                     | Met        |
| Deploy triggers             | 30 / 0          | 1,911 ms     | [1,814.333, 1,977] ms     | 1,930 ms     | [1,900, 1,955] ms         | 237.826 ms | 92.5 ms    | 760–2,230 ms          | 4.26%                     | Met        |
| Worker startup              | 30 / 0          | 1.233 ms     | [1.067, 1.433] ms         | 1 ms         | [1, 1] ms                 | 0.504 ms   | 0 ms       | 1–3 ms                | 14.86%                    | Not met    |
| `cf deploy`                 | 30 / 0          | 8,953.367 ms | [8,594.954, 9,191.197] ms | 9,005.076 ms | [8,914.317, 9,223.398] ms | 886.422 ms | 488.225 ms | 4,579.592–9,901.67 ms | 3.33%                     | Met        |
| Local preparation + cleanup | 30 / 0          | 1.648 ms     | [1.52, 1.79] ms           | 1.503 ms     | [1.441, 1.712] ms         | 0.38 ms    | 0.346 ms   | 1.167–2.896 ms        | 8.21%                     | Not met    |
| Worker lookup               | 30 / 0          | 1,297.721 ms | [1,243.797, 1,338.887] ms | 1,307.12 ms  | [1,272.027, 1,335.74] ms  | 136.413 ms | 82.991 ms  | 680.572–1,616.105 ms  | 3.66%                     | Met        |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0                                     |
| Batch start / finish (UTC)               | 2026-11-19T08:15:46.753Z / 2026-11-19T08:20:58.320Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build | Upload   | Deploy triggers | `cf deploy`  | Raw / gzip            | Version                              |
| --------- | ------- | ------------------------ | ----- | -------- | --------------- | ------------ | --------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-19T08:15:46.754Z | 7 ms  | 5,390 ms | 2,230 ms        | 9,617.506 ms | 187 bytes / 161 bytes | c46a8310-32fc-429a-a9f5-2e8e93ac4528 |
| 2         | success | 2026-11-19T08:15:57.642Z | 8 ms  | 6,140 ms | 1,980 ms        | 9,901.67 ms  | 187 bytes / 161 bytes | e7b28a5c-394c-4fc0-af6d-57e46bd84bb9 |
| 3         | success | 2026-11-19T08:16:08.906Z | 8 ms  | 5,700 ms | 1,960 ms        | 9,389.469 ms | 187 bytes / 161 bytes | 9f785901-bdc6-4c71-952e-a49b7adfbb5a |
| 4         | success | 2026-11-19T08:16:19.637Z | 7 ms  | 5,800 ms | 1,950 ms        | 9,548.508 ms | 187 bytes / 161 bytes | 93526159-a00a-49c7-8e2f-c1bb8a1363e0 |
| 5         | success | 2026-11-19T08:16:30.493Z | 7 ms  | 5,350 ms | 1,900 ms        | 8,936.31 ms  | 187 bytes / 161 bytes | 66b47f98-a54e-4324-b6d9-fdf09666bc4a |
| 6         | success | 2026-11-19T08:16:40.795Z | 12 ms | 5,220 ms | 1,910 ms        | 9,062.713 ms | 187 bytes / 161 bytes | 301937f9-f578-4571-a69c-76cc6aec15b5 |
| 7         | success | 2026-11-19T08:16:51.124Z | 8 ms  | 5,390 ms | 1,960 ms        | 9,010.357 ms | 187 bytes / 161 bytes | 46c30667-ab93-4d08-a569-87bdaf7d5027 |
| 8         | success | 2026-11-19T08:17:01.402Z | 8 ms  | 5,540 ms | 1,920 ms        | 9,212.156 ms | 187 bytes / 161 bytes | 3cfd9d72-553e-4887-8aeb-3a2eecebba68 |
| 9         | success | 2026-11-19T08:17:11.878Z | 8 ms  | 5,730 ms | 2,000 ms        | 9,385.024 ms | 187 bytes / 161 bytes | 101c685f-3eb2-44d1-891b-d029b060728e |
| 10        | success | 2026-11-19T08:17:22.574Z | 8 ms  | 5,620 ms | 1,950 ms        | 9,294.535 ms | 187 bytes / 161 bytes | 10a61185-31be-4071-ba90-8ee301cbda74 |
| 11        | success | 2026-11-19T08:17:33.122Z | 8 ms  | 5,210 ms | 1,950 ms        | 8,892.323 ms | 187 bytes / 161 bytes | 151ef8c2-e3d4-43f1-bf6b-44e2f0e231c1 |
| 12        | success | 2026-11-19T08:17:43.335Z | 8 ms  | 5,460 ms | 1,900 ms        | 9,082.033 ms | 187 bytes / 161 bytes | 486eb672-e4ea-45b4-a78a-626000bc761d |
| 13        | success | 2026-11-19T08:17:53.746Z | 7 ms  | 5,600 ms | 2,050 ms        | 9,385.108 ms | 187 bytes / 161 bytes | 0ed58bcc-2627-4ae3-8306-86781aacc995 |
| 14        | success | 2026-11-19T08:18:04.410Z | 7 ms  | 5,220 ms | 1,870 ms        | 8,730.124 ms | 187 bytes / 161 bytes | ffe90a34-154b-4d92-93cc-ba7e9162a493 |
| 15        | success | 2026-11-19T08:18:14.492Z | 7 ms  | 5,220 ms | 1,880 ms        | 8,712.392 ms | 187 bytes / 161 bytes | 83dd5cc4-d502-4fba-b1cc-54ab8da52acd |
| 16        | success | 2026-11-19T08:18:24.460Z | 7 ms  | 5,060 ms | 1,810 ms        | 8,519.561 ms | 187 bytes / 161 bytes | af16ee1b-8c27-4e98-ad94-2ffb1f9bb8f2 |
| 17        | success | 2026-11-19T08:18:34.273Z | 7 ms  | 5,430 ms | 1,980 ms        | 9,234.639 ms | 187 bytes / 161 bytes | 7bd07670-f2d7-4e20-8826-79938b2ae19a |
| 18        | success | 2026-11-19T08:18:44.754Z | 8 ms  | 5,220 ms | 1,830 ms        | 8,792.255 ms | 187 bytes / 161 bytes | 6de86c09-eefc-4203-947d-db4e4a7c393f |
| 19        | success | 2026-11-19T08:18:54.809Z | 9 ms  | 5,180 ms | 1,890 ms        | 8,831.594 ms | 187 bytes / 161 bytes | 2dec1d07-ff76-48b8-a09c-9001922bf331 |
| 20        | success | 2026-11-19T08:19:05.041Z | 8 ms  | 5,370 ms | 1,910 ms        | 8,992.12 ms  | 187 bytes / 161 bytes | db17cd56-ebda-434b-808e-d23d3690b684 |
| 21        | success | 2026-11-19T08:19:15.293Z | 8 ms  | 5,160 ms | 1,860 ms        | 8,729.258 ms | 187 bytes / 161 bytes | 03295c86-0207-4ab9-a9ab-48faaf10de24 |
| 22        | success | 2026-11-19T08:19:25.358Z | 8 ms  | 5,240 ms | 1,850 ms        | 8,831.544 ms | 187 bytes / 161 bytes | ce6ab70e-1110-4931-a4ca-ec97c21d82f1 |
| 23        | success | 2026-11-19T08:19:35.535Z | 8 ms  | 5,330 ms | 1,880 ms        | 8,981.805 ms | 187 bytes / 161 bytes | 7f955f5c-ac43-415b-ae35-99855a4b9431 |
| 24        | success | 2026-11-19T08:19:45.847Z | 8 ms  | 5,340 ms | 1,920 ms        | 8,999.794 ms | 187 bytes / 161 bytes | 9a80a7fa-e20e-48d3-b3b7-5d1bfdb0bd36 |
| 25        | success | 2026-11-19T08:19:56.135Z | 7 ms  | 5,810 ms | 2,130 ms        | 9,668.428 ms | 187 bytes / 161 bytes | 13cc3014-33ea-4754-b00e-4f1756b7a202 |
| 26        | success | 2026-11-19T08:20:07.099Z | 8 ms  | 2,410 ms | 760 ms          | 4,579.592 ms | 187 bytes / 161 bytes | f5fa4753-72e4-4c23-968e-76494067eec6 |
| 27        | success | 2026-11-19T08:20:12.361Z | 7 ms  | 5,420 ms | 1,950 ms        | 9,113.381 ms | 187 bytes / 161 bytes | 97057094-b59a-4aae-ac03-3cd099b7132f |
| 28        | success | 2026-11-19T08:20:23.094Z | 7 ms  | 5,170 ms | 2,020 ms        | 8,873.658 ms | 187 bytes / 161 bytes | 40f65ea9-55e5-410a-990f-3381d1366a80 |
| 29        | success | 2026-11-19T08:20:33.323Z | 8 ms  | 5,290 ms | 1,940 ms        | 8,950.878 ms | 187 bytes / 161 bytes | 9b13ab86-8300-47b2-8c3b-e66d7c91ba42 |
| 30        | success | 2026-11-19T08:20:43.637Z | 8 ms  | 5,380 ms | 2,190 ms        | 9,342.269 ms | 187 bytes / 161 bytes | bd1eeb2a-e9ec-4adc-a0e6-1b19bbde601a |

</details>

## Latency workload summary

| Workload | URL                                                                     | Mean      | P50       | P95       |
| -------- | ----------------------------------------------------------------------- | --------- | --------- | --------- |
| baseline | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev/ | 27.561 ms | 21.368 ms | 57.096 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency

Empty Workers response

### Client latency

| Measurement       | Value       |
| ----------------- | ----------- |
| Mean              | 27.561 ms   |
| Minimum           | 14.82 ms    |
| P50               | 21.368 ms   |
| P95               | 57.096 ms   |
| P99               | 87.798 ms   |
| Maximum           | 259.76 ms   |
| Throughput        | 36.26 req/s |
| Measured duration | 275.783 s   |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 10,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate  | 95% CI              | CI half-width / estimate | ±5% target |
| ----------- | --------- | ------------------- | ------------------------ | ---------- |
| Mean        | 27.561 ms | [24.607, 30.584] ms | 10.84%                   | Not met    |
| P50         | 21.368 ms | [20.57, 23.08] ms   | 5.87%                    | Not met    |
| P95         | 57.096 ms | [48.4, 63.07] ms    | 12.85%                   | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 1,000             | 2026-11-19T08:21:07.384Z |
| 2     | success | 1,000             | 2026-11-19T08:21:39.276Z |
| 3     | success | 1,000             | 2026-11-19T08:22:18.113Z |
| 4     | success | 1,000             | 2026-11-19T08:22:47.563Z |
| 5     | success | 1,000             | 2026-11-19T08:23:16.626Z |
| 6     | success | 1,000             | 2026-11-19T08:23:40.902Z |
| 7     | success | 1,000             | 2026-11-19T08:24:14.687Z |
| 8     | success | 1,000             | 2026-11-19T08:24:49.490Z |
| 9     | success | 1,000             | 2026-11-19T08:25:13.608Z |
| 10    | success | 1,000             | 2026-11-19T08:25:36.404Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 10,500   | 0      | 0           |

| Measurement    | P50    | P90     | P99      | P99.9    |
| -------------- | ------ | ------- | -------- | -------- |
| CPU            | 95 µs  | 144 µs  | 294 µs   | 1,031 µs |
| Wall time      | 354 µs | 541 µs  | 1,036 µs | 2,533 µs |
| Isolate memory | 2 MiB  | 2.5 MiB | 2.5 MiB  | 2.5 MiB  |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-19T08:21:05.809Z |
| Measurement end (UTC)                | 2026-11-19T08:25:59.463Z |
| Query start, inclusive (UTC)         | 2026-11-19T08:19:35.000Z |
| Query end, inclusive (UTC)           | 2026-11-19T08:27:30.000Z |
| Padding per side                     | 90 s                     |
| Ingestion wait after query end       | 180 s                    |
| Retry interval                       | 10 s                     |
| Quiet-window checks / result queries | 1 / 1                    |

##### Worker metrics methodology

CPU is time actively executing code, excluding time waiting on I/O. Wall time is the lifetime of the invocation's JavaScript context, including I/O waits and `waitUntil()` work; it is not client response latency. Memory is shared isolate usage at invocation time, not per-request allocation or peak memory. An isolate can serve concurrent requests.

CPU and wall-time quantiles are returned in microseconds; memory is returned in bytes and displayed in MiB (1 MiB = 1,048,576 bytes). These percentiles use reservoir sampling. P50 is the median; P90, P99, and P99.9 describe the corresponding upper percentiles.

Sources: [Cloudflare metric definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), and [GraphQL field descriptions (public schema mirror)](https://pages.johnspurlock.com/graphql-schema-docs/cloudflare.html#AccountWorkersInvocationsAdaptiveQuantiles).

Analytics are aggregated/sampled across the whole Worker and padded window, not filtered by route or version. An empty preflight check is best-effort: ingestion delays can hide recent traffic. Avoid unrelated traffic; counts need not match oha exactly.
The analytics window spans all latency rounds, including warmup requests and inter-round gaps. Worker CPU/wall-time/memory percentiles therefore include warmup traffic and have no round-bootstrap confidence intervals.

</details>
