# baseline-void benchmark report

Successful run: **2026-11-19T09:06:47.086Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-19T08:49:50.309Z                                         |
| Run finished (UTC)                    | 2026-11-19T09:06:47.086Z                                         |
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

| Field                                                       | Value                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| URL                                                         | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev/ |
| Method                                                      | GET                                                                  |
| Expected status                                             | 200                                                                  |
| Expected body size per response                             | 0 bytes                                                              |
| Measured requests per round                                 | 1000                                                                 |
| Latency rounds                                              | 10                                                                   |
| Total measured requests                                     | 10000                                                                |
| Duration limit per round                                    | None                                                                 |
| Connections                                                 | 1                                                                    |
| Rate limit                                                  | None                                                                 |
| Request timeout                                             | 30s                                                                  |
| HTTP version                                                | 1.1                                                                  |
| Keep-alive                                                  | true                                                                 |
| Warmup requests per round (excluded from client statistics) | 50                                                                   |
| Access authentication                                       | temporary-login                                                      |
| HTTP response counts                                        | 200: 10,000                                                          |

</details>

## Build & deployment

### Bundle size

| Format | Size (Median) |
| ------ | ------------- |
| Raw    | 143,638 bytes |
| Gzip   | 40,206 bytes  |

### Timing summary

| Phase          | Mean          | Mean 95% CI                 | Median        |
| -------------- | ------------- | --------------------------- | ------------- |
| Build          | 154.333 ms    | [143.733, 166.667] ms       | 141.5 ms      |
| Upload         | 7,713.333 ms  | [7,332.333, 8,004.008] ms   | 7,685 ms      |
| Worker startup | 3.667 ms      | [3.267, 4.133] ms           | 3 ms          |
| `cf deploy`    | 14,281.199 ms | [13,746.388, 14,652.424] ms | 14,382.012 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Worker                                                          | void-perf-baseline-void                                             |
| Worker ID                                                       | 564710ff32b14cbdb179ca5ea82f80f4                                    |
| Version ID                                                      | 1a50310e-fb3e-47a1-ac36-1e7fa16024cc                                |
| Origin                                                          | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 3,129.261 ms                                                        |
| Final run workflow wall time (includes cleanup, lookup, Access) | 18,496.843 ms                                                       |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range           |
| ------ | ---------------- | --------------------- |
| Raw    | 143,638 bytes    | 143,638–143,638 bytes |
| Gzip   | 40,206 bytes     | 40,206–40,206 bytes   |

Bundle-size variation: None observed.

#### Full timing statistics

| Phase                       | Valid / missing | Mean          | Mean 95% CI                 | Median        | Median 95% CI               | Sample SD    | IQR        | Min–max                 | Mean CI half-width / mean | ±5% target |
| --------------------------- | --------------- | ------------- | --------------------------- | ------------- | --------------------------- | ------------ | ---------- | ----------------------- | ------------------------- | ---------- |
| Build                       | 30 / 0          | 154.333 ms    | [143.733, 166.667] ms       | 141.5 ms      | [136, 149] ms               | 32.715 ms    | 25 ms      | 129–248 ms              | 7.43%                     | Not met    |
| Upload                      | 30 / 0          | 7,713.333 ms  | [7,332.333, 8,004.008] ms   | 7,685 ms      | [7,615, 7,920] ms           | 959.275 ms   | 447.5 ms   | 3,350–9,980 ms          | 4.35%                     | Met        |
| Deploy triggers             | 30 / 0          | 1,950 ms      | [1,848.992, 2,015.333] ms   | 2,005 ms      | [1,925, 2,030] ms           | 249.883 ms   | 130 ms     | 700–2,200 ms            | 4.27%                     | Met        |
| Worker startup              | 30 / 0          | 3.667 ms      | [3.267, 4.133] ms           | 3 ms          | [3, 4] ms                   | 1.241 ms     | 1 ms       | 2–8 ms                  | 11.82%                    | Not met    |
| `cf deploy`                 | 30 / 0          | 14,281.199 ms | [13,746.388, 14,652.424] ms | 14,382.012 ms | [14,150.336, 14,604.754] ms | 1,330.089 ms | 554.862 ms | 7,888.365–16,601.707 ms | 3.17%                     | Met        |
| Local preparation + cleanup | 30 / 0          | 6.158 ms      | [5.602, 6.715] ms           | 5.767 ms      | [5.323, 6.644] ms           | 1.582 ms     | 1.857 ms   | 2.137–9.421 ms          | 9.03%                     | Not met    |
| Worker lookup               | 30 / 0          | 1,287.398 ms  | [1,233.948, 1,327.11] ms    | 1,312.844 ms  | [1,281.368, 1,329.946] ms   | 134.982 ms   | 73.095 ms  | 719.494–1,421.36 ms     | 3.62%                     | Met        |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0                                     |
| Batch start / finish (UTC)               | 2026-11-19T08:49:50.808Z / 2026-11-19T08:57:41.208Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build  | Upload   | Deploy triggers | `cf deploy`   | Raw / gzip                   | Version                              |
| --------- | ------- | ------------------------ | ------ | -------- | --------------- | ------------- | ---------------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-19T08:49:50.809Z | 132 ms | 8,420 ms | 1,870 ms        | 15,344.609 ms | 143,638 bytes / 40,206 bytes | 671785ff-302a-4431-91fa-38af9e6c768f |
| 2         | success | 2026-11-19T08:50:07.494Z | 138 ms | 8,250 ms | 1,950 ms        | 14,851.455 ms | 143,638 bytes / 40,206 bytes | 4a928e5e-adc9-4c55-9eeb-57ea3ac35cee |
| 3         | success | 2026-11-19T08:50:23.778Z | 135 ms | 8,280 ms | 2,080 ms        | 15,070.249 ms | 143,638 bytes / 40,206 bytes | 35dc9a7b-1879-47b2-b172-037805049522 |
| 4         | success | 2026-11-19T08:50:40.182Z | 157 ms | 7,980 ms | 1,900 ms        | 14,639.596 ms | 143,638 bytes / 40,206 bytes | f32754a8-015d-49ae-a973-4c842d232396 |
| 5         | success | 2026-11-19T08:50:56.089Z | 224 ms | 8,160 ms | 2,200 ms        | 14,904.893 ms | 143,638 bytes / 40,206 bytes | 7c754971-7770-4eab-af8a-c49418df60fa |
| 6         | success | 2026-11-19T08:51:12.424Z | 145 ms | 7,670 ms | 2,040 ms        | 14,276.85 ms  | 143,638 bytes / 40,206 bytes | 6979ec15-3522-46e2-bd63-67944a7ee3a8 |
| 7         | success | 2026-11-19T08:51:27.972Z | 144 ms | 7,610 ms | 1,890 ms        | 14,332.135 ms | 143,638 bytes / 40,206 bytes | 3306952f-c942-4b8e-b907-fa80a5ea2c2f |
| 8         | success | 2026-11-19T08:51:43.633Z | 146 ms | 7,740 ms | 2,040 ms        | 15,014.597 ms | 143,638 bytes / 40,206 bytes | 43520863-cce0-4205-b68f-b59f091e7b8b |
| 9         | success | 2026-11-19T08:51:59.916Z | 136 ms | 8,020 ms | 2,020 ms        | 14,633.246 ms | 143,638 bytes / 40,206 bytes | da99a9cb-ccb4-4880-a9ba-6b8936ae946e |
| 10        | success | 2026-11-19T08:52:15.908Z | 151 ms | 7,320 ms | 1,890 ms        | 14,061.896 ms | 143,638 bytes / 40,206 bytes | 9b5a4685-076f-411f-8a2e-ec746770dda3 |
| 11        | success | 2026-11-19T08:52:31.257Z | 161 ms | 7,650 ms | 2,020 ms        | 14,614.094 ms | 143,638 bytes / 40,206 bytes | ca4d5bb2-7720-4f67-939e-e94868a45041 |
| 12        | success | 2026-11-19T08:52:47.210Z | 235 ms | 7,670 ms | 2,030 ms        | 14,497.686 ms | 143,638 bytes / 40,206 bytes | 4f6c0964-1f8d-486a-8390-f0ad93c231d9 |
| 13        | success | 2026-11-19T08:53:03.072Z | 248 ms | 7,700 ms | 1,930 ms        | 14,552.758 ms | 143,638 bytes / 40,206 bytes | 060b7f9f-88df-4016-b9c4-9675efebb4e0 |
| 14        | success | 2026-11-19T08:53:18.975Z | 135 ms | 7,620 ms | 1,950 ms        | 14,107.775 ms | 143,638 bytes / 40,206 bytes | 293cf258-302a-43b9-b24e-d15576c17876 |
| 15        | success | 2026-11-19T08:53:34.456Z | 134 ms | 7,560 ms | 2,070 ms        | 14,079.904 ms | 143,638 bytes / 40,206 bytes | d5d8e766-ff91-4936-af6f-2aa2f1e8e788 |
| 16        | success | 2026-11-19T08:53:49.937Z | 161 ms | 7,650 ms | 2,030 ms        | 14,259.676 ms | 143,638 bytes / 40,206 bytes | 8d873254-09c5-4298-b44d-924640090cf9 |
| 17        | success | 2026-11-19T08:54:05.530Z | 133 ms | 7,490 ms | 2,160 ms        | 14,092.871 ms | 143,638 bytes / 40,206 bytes | 496d4db8-1174-44f0-8582-53c76ba9968a |
| 18        | success | 2026-11-19T08:54:20.925Z | 161 ms | 8,100 ms | 2,050 ms        | 14,595.413 ms | 143,638 bytes / 40,206 bytes | d151ae8c-11da-4a17-8a28-47960c592b70 |
| 19        | success | 2026-11-19T08:54:36.829Z | 133 ms | 7,330 ms | 1,920 ms        | 13,633.289 ms | 143,638 bytes / 40,206 bytes | 88a3dba2-1349-43d4-8d13-2a7b7f912de5 |
| 20        | success | 2026-11-19T08:54:51.778Z | 147 ms | 9,980 ms | 1,990 ms        | 16,601.707 ms | 143,638 bytes / 40,206 bytes | b2880be5-4d2e-4c48-a30c-8d667de0901f |
| 21        | success | 2026-11-19T08:55:09.647Z | 162 ms | 7,580 ms | 1,910 ms        | 13,966.048 ms | 143,638 bytes / 40,206 bytes | fe661e07-8a24-40f6-a793-626ef352ef28 |
| 22        | success | 2026-11-19T08:55:24.584Z | 133 ms | 8,200 ms | 2,060 ms        | 14,957.056 ms | 143,638 bytes / 40,206 bytes | 7a7b62eb-1156-4e59-9404-949071e6328e |
| 23        | success | 2026-11-19T08:55:40.970Z | 133 ms | 8,030 ms | 2,030 ms        | 14,511.095 ms | 143,638 bytes / 40,206 bytes | 29b1301c-4744-4168-8c37-c57f1e01da4d |
| 24        | success | 2026-11-19T08:55:56.778Z | 221 ms | 7,860 ms | 1,910 ms        | 14,347.625 ms | 143,638 bytes / 40,206 bytes | 8ab987de-1001-46d6-b5fa-c5a39d735044 |
| 25        | success | 2026-11-19T08:56:11.853Z | 129 ms | 3,350 ms | 700 ms          | 7,888.365 ms  | 143,638 bytes / 40,206 bytes | cb7cf2dc-bb07-470e-ad97-61a47b2e33e7 |
| 26        | success | 2026-11-19T08:56:21.065Z | 136 ms | 7,550 ms | 1,900 ms        | 13,937.211 ms | 143,638 bytes / 40,206 bytes | 13fa5950-65b4-42a9-8ace-7ed8b03d0001 |
| 27        | success | 2026-11-19T08:56:36.281Z | 137 ms | 7,790 ms | 1,970 ms        | 14,192.898 ms | 143,638 bytes / 40,206 bytes | 1d27a3ae-9916-4002-ba2d-1c567f50e101 |
| 28        | success | 2026-11-19T08:56:51.720Z | 146 ms | 7,770 ms | 2,030 ms        | 14,416.4 ms   | 143,638 bytes / 40,206 bytes | 0f68cd6e-deee-455e-855f-b5062d3ca0a2 |
| 29        | success | 2026-11-19T08:57:07.404Z | 138 ms | 7,580 ms | 1,910 ms        | 14,019.232 ms | 143,638 bytes / 40,206 bytes | 7637d68a-21c5-477f-9ccd-c7d42e578c35 |
| 30        | success | 2026-11-19T08:57:22.711Z | 139 ms | 7,490 ms | 2,050 ms        | 14,035.333 ms | 143,638 bytes / 40,206 bytes | 1a50310e-fb3e-47a1-ac36-1e7fa16024cc |

</details>

## Latency workload summary

| Workload | URL                                                                  | Mean      | P50       | P95       |
| -------- | -------------------------------------------------------------------- | --------- | --------- | --------- |
| baseline | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev/ | 24.933 ms | 21.655 ms | 43.513 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency

Empty Void response

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 24.933 ms    |
| Minimum           | 16.059 ms    |
| P50               | 21.655 ms    |
| P95               | 43.513 ms    |
| P99               | 79.275 ms    |
| Maximum           | 346.467 ms   |
| Throughput        | 40.082 req/s |
| Measured duration | 249.491 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 10,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate  | 95% CI              | CI half-width / estimate | ±5% target |
| ----------- | --------- | ------------------- | ------------------------ | ---------- |
| Mean        | 24.933 ms | [22.97, 27.477] ms  | 9.04%                    | Not met    |
| P50         | 21.655 ms | [21.358, 22.139] ms | 1.8%                     | Met        |
| P95         | 43.513 ms | [29.224, 53.849] ms | 28.3%                    | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 1,000             | 2026-11-19T08:57:50.715Z |
| 2     | success | 1,000             | 2026-11-19T08:58:14.670Z |
| 3     | success | 1,000             | 2026-11-19T08:58:38.799Z |
| 4     | success | 1,000             | 2026-11-19T08:59:12.951Z |
| 5     | success | 1,000             | 2026-11-19T08:59:47.263Z |
| 6     | success | 1,000             | 2026-11-19T09:00:12.421Z |
| 7     | success | 1,000             | 2026-11-19T09:00:36.848Z |
| 8     | success | 1,000             | 2026-11-19T09:01:00.631Z |
| 9     | success | 1,000             | 2026-11-19T09:01:27.060Z |
| 10    | success | 1,000             | 2026-11-19T09:01:52.962Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 10,492   | 0      | 0           |

| Measurement    | P50       | P90       | P99       | P99.9     |
| -------------- | --------- | --------- | --------- | --------- |
| CPU            | 235 µs    | 359 µs    | 1,201 µs  | 3,483 µs  |
| Wall time      | 541 µs    | 896 µs    | 2,103 µs  | 4,758 µs  |
| Isolate memory | 3.508 MiB | 4.508 MiB | 5.008 MiB | 5.258 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-19T08:57:49.199Z |
| Measurement end (UTC)                | 2026-11-19T09:02:15.859Z |
| Query start, inclusive (UTC)         | 2026-11-19T08:56:19.000Z |
| Query end, inclusive (UTC)           | 2026-11-19T09:03:46.000Z |
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
