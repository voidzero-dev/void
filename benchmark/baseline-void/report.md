# baseline-void benchmark report

Successful run: **2026-11-20T07:51:38.075Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-20T07:27:48.795Z                                         |
| Run finished (UTC)                    | 2026-11-20T07:51:38.075Z                                         |
| Platform                              | darwin                                                           |
| OS release                            | 25.6.0                                                           |
| Node.js                               | v24.22.1                                                         |
| oha                                   | oha 1.17.0                                                       |
| CPU                                   | Apple M5 Pro                                                     |
| Architecture                          | arm64                                                            |
| Logical cores / available parallelism | 18 / 18                                                          |
| Network type / interface              | ethernet / en7                                                   |
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
| Raw    | 143,403 bytes |
| Gzip   | 40,150 bytes  |

### Timing summary

| Phase          | Mean          | Mean 95% CI                | Median        |
| -------------- | ------------- | -------------------------- | ------------- |
| Build          | 162.967 ms    | [151.567, 175.068] ms      | 151 ms        |
| Upload         | 7,304.333 ms  | [6,879.992, 7,614] ms      | 7,540 ms      |
| Worker startup | 3.7 ms        | [3.3, 4.167] ms            | 3.5 ms        |
| `cf deploy`    | 13,234.209 ms | [12,667.17, 13,646.146] ms | 13,459.425 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Worker                                                          | void-perf-baseline-void                                             |
| Worker ID                                                       | 564710ff32b14cbdb179ca5ea82f80f4                                    |
| Version ID                                                      | 4eb37fe2-21f6-49c4-a4be-53135a8f3cbc                                |
| Origin                                                          | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 4,250.229 ms                                                        |
| Final run workflow wall time (includes cleanup, lookup, Access) | 19,373.64 ms                                                        |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range           |
| ------ | ---------------- | --------------------- |
| Raw    | 143,403 bytes    | 143,403–143,403 bytes |
| Gzip   | 40,150 bytes     | 40,150–40,150 bytes   |

Bundle-size variation: None observed.

#### Full timing statistics

| Phase                       | Valid / missing | Mean          | Mean 95% CI                | Median        | Median 95% CI               | Sample SD    | IQR        | Min–max                 | Mean CI half-width / mean | ±5% target |
| --------------------------- | --------------- | ------------- | -------------------------- | ------------- | --------------------------- | ------------ | ---------- | ----------------------- | ------------------------- | ---------- |
| Build                       | 30 / 0          | 162.967 ms    | [151.567, 175.068] ms      | 151 ms        | [143.5, 161] ms             | 33.345 ms    | 25.75 ms   | 130–235 ms              | 7.21%                     | Not met    |
| Upload                      | 30 / 0          | 7,304.333 ms  | [6,879.992, 7,614] ms      | 7,540 ms      | [7,385, 7,575] ms           | 1,055.399 ms | 272.5 ms   | 3,540–8,180 ms          | 5.02%                     | Not met    |
| Deploy triggers             | 30 / 0          | 1,852.667 ms  | [1,725.658, 1,947.333] ms  | 1,895 ms      | [1,860, 1,915] ms           | 319.395 ms   | 165 ms     | 730–2,270 ms            | 5.98%                     | Not met    |
| Worker startup              | 30 / 0          | 3.7 ms        | [3.3, 4.167] ms            | 3.5 ms        | [3, 4] ms                   | 1.236 ms     | 1 ms       | 2–8 ms                  | 11.71%                    | Not met    |
| `cf deploy`                 | 30 / 0          | 13,234.209 ms | [12,667.17, 13,646.146] ms | 13,459.425 ms | [13,359.256, 13,636.894] ms | 1,405.411 ms | 392.755 ms | 7,886.582–14,296.407 ms | 3.7%                      | Met        |
| Local preparation + cleanup | 30 / 0          | 6.753 ms      | [6.327, 7.176] ms          | 6.875 ms      | [6.053, 7.126] ms           | 1.202 ms     | 1.632 ms   | 3.999–9.532 ms          | 6.28%                     | Not met    |
| Worker lookup               | 30 / 0          | 1,269.413 ms  | [1,210.297, 1,317.958] ms  | 1,318.19 ms   | [1,286.105, 1,332.46] ms    | 155.733 ms   | 71.456 ms  | 776.002–1,405.234 ms    | 4.24%                     | Met        |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0                                     |
| Batch start / finish (UTC)               | 2026-11-20T07:27:49.251Z / 2026-11-20T07:35:08.859Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build  | Upload   | Deploy triggers | `cf deploy`   | Raw / gzip                   | Version                              |
| --------- | ------- | ------------------------ | ------ | -------- | --------------- | ------------- | ---------------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-20T07:27:49.252Z | 161 ms | 3,540 ms | 760 ms          | 7,886.582 ms  | 143,403 bytes / 40,150 bytes | 5ced7d21-b188-4689-a82c-e7def63e3589 |
| 2         | success | 2026-11-20T07:27:58.468Z | 225 ms | 8,000 ms | 2,030 ms        | 14,155.359 ms | 143,403 bytes / 40,150 bytes | 4439ca5e-9c0e-4fdc-a052-68fd6887e194 |
| 3         | success | 2026-11-20T07:28:14.016Z | 148 ms | 7,420 ms | 1,880 ms        | 13,377.069 ms | 143,403 bytes / 40,150 bytes | 62e33a12-5fa5-43b3-a532-d878e6580f80 |
| 4         | success | 2026-11-20T07:28:28.720Z | 161 ms | 7,610 ms | 1,820 ms        | 13,446.115 ms | 143,403 bytes / 40,150 bytes | e2b7aa68-d7aa-4f49-b44c-66dbfdbbf5cd |
| 5         | success | 2026-11-20T07:28:43.474Z | 165 ms | 7,400 ms | 1,910 ms        | 13,256.584 ms | 143,403 bytes / 40,150 bytes | baabfb1b-cd72-4e32-88e7-c1285e5d2387 |
| 6         | success | 2026-11-20T07:28:57.564Z | 130 ms | 7,220 ms | 2,270 ms        | 13,694.957 ms | 143,403 bytes / 40,150 bytes | 3268c11d-f26d-4b66-b093-2d7517f74647 |
| 7         | success | 2026-11-20T07:29:12.509Z | 235 ms | 7,330 ms | 1,900 ms        | 13,384.741 ms | 143,403 bytes / 40,150 bytes | 828a8d4f-337d-42dd-8426-0fe340c0dd72 |
| 8         | success | 2026-11-20T07:29:27.181Z | 131 ms | 7,130 ms | 1,990 ms        | 12,974.609 ms | 143,403 bytes / 40,150 bytes | 15388944-a1c2-4f81-93b5-e24559ffc28b |
| 9         | success | 2026-11-20T07:29:41.441Z | 146 ms | 7,500 ms | 1,840 ms        | 13,371.394 ms | 143,403 bytes / 40,150 bytes | 1b7f7dc2-6b4b-4000-b633-c6afe5969962 |
| 10        | success | 2026-11-20T07:29:56.113Z | 226 ms | 8,170 ms | 1,910 ms        | 14,296.407 ms | 143,403 bytes / 40,150 bytes | 5daed7b0-0f2f-4357-86cd-2258e7239671 |
| 11        | success | 2026-11-20T07:30:11.790Z | 169 ms | 7,960 ms | 2,130 ms        | 14,106.083 ms | 143,403 bytes / 40,150 bytes | 5e4a7738-1b02-4a07-8542-4ace766d0452 |
| 12        | success | 2026-11-20T07:30:27.160Z | 133 ms | 7,540 ms | 1,920 ms        | 13,312.955 ms | 143,403 bytes / 40,150 bytes | 5d97b9c0-87f2-4235-b90c-a38ab2e29c8a |
| 13        | success | 2026-11-20T07:30:41.787Z | 140 ms | 8,180 ms | 2,050 ms        | 14,201.55 ms  | 143,403 bytes / 40,150 bytes | 05d5e88e-d339-42a7-93f4-fb7c60285b18 |
| 14        | success | 2026-11-20T07:30:57.290Z | 134 ms | 7,770 ms | 1,820 ms        | 13,592.811 ms | 143,403 bytes / 40,150 bytes | e85bdbc3-3451-4971-a1a9-edc9ff010987 |
| 15        | success | 2026-11-20T07:31:12.149Z | 160 ms | 7,490 ms | 1,910 ms        | 13,272.64 ms  | 143,403 bytes / 40,150 bytes | 27d741fb-bbdf-4ecb-818c-5f9c091aece9 |
| 16        | success | 2026-11-20T07:31:26.205Z | 136 ms | 7,300 ms | 1,890 ms        | 13,205.794 ms | 143,403 bytes / 40,150 bytes | 5e155aa5-cf86-405a-ae32-f3a166e93aa0 |
| 17        | success | 2026-11-20T07:31:40.301Z | 151 ms | 7,210 ms | 1,840 ms        | 13,236.522 ms | 143,403 bytes / 40,150 bytes | befe2ff9-5ffb-40ba-a306-2444336a2778 |
| 18        | success | 2026-11-20T07:31:54.873Z | 158 ms | 7,560 ms | 1,830 ms        | 13,942.501 ms | 143,403 bytes / 40,150 bytes | 4cb73c73-ac9c-4208-aac0-ff751bfe9892 |
| 19        | success | 2026-11-20T07:32:10.090Z | 211 ms | 7,760 ms | 1,870 ms        | 13,851.067 ms | 143,403 bytes / 40,150 bytes | 53e26eab-4980-4ae2-a4f4-e046e7f52d7e |
| 20        | success | 2026-11-20T07:32:25.301Z | 157 ms | 3,580 ms | 730 ms          | 8,579.562 ms  | 143,403 bytes / 40,150 bytes | b0ccd8dd-f1f5-44e1-a70e-2f24bd366f7c |
| 21        | success | 2026-11-20T07:32:35.224Z | 149 ms | 7,540 ms | 1,860 ms        | 13,472.734 ms | 143,403 bytes / 40,150 bytes | cf9dc635-90b9-4005-8f9a-f1fbde7115b3 |
| 22        | success | 2026-11-20T07:32:50.065Z | 132 ms | 7,570 ms | 1,890 ms        | 13,680.978 ms | 143,403 bytes / 40,150 bytes | 2af22499-9280-43ae-8741-ab39cf1057ff |
| 23        | success | 2026-11-20T07:33:05.158Z | 134 ms | 7,540 ms | 1,860 ms        | 13,546.092 ms | 143,403 bytes / 40,150 bytes | a7f8e76e-be0d-4794-a702-5a90fe80dcac |
| 24        | success | 2026-11-20T07:33:20.037Z | 223 ms | 7,370 ms | 2,010 ms        | 13,437.095 ms | 143,403 bytes / 40,150 bytes | ca6be30e-9c82-414b-9fff-88204d04bc26 |
| 25        | success | 2026-11-20T07:33:34.832Z | 227 ms | 7,540 ms | 1,830 ms        | 13,493.989 ms | 143,403 bytes / 40,150 bytes | c6ee4f7e-a7a0-4c56-8654-129cbde3ddd0 |
| 26        | success | 2026-11-20T07:33:49.666Z | 166 ms | 7,340 ms | 1,900 ms        | 13,347.118 ms | 143,403 bytes / 40,150 bytes | c1c57ebb-fbcd-45a2-b753-b116deaf50ec |
| 27        | success | 2026-11-20T07:34:04.364Z | 149 ms | 7,280 ms | 2,020 ms        | 13,338.451 ms | 143,403 bytes / 40,150 bytes | 9eeaeb1e-3eb0-4b22-96fa-382a0ef757e2 |
| 28        | success | 2026-11-20T07:34:19.031Z | 151 ms | 7,590 ms | 1,800 ms        | 13,556.823 ms | 143,403 bytes / 40,150 bytes | a9ccf99c-f745-4a60-84f4-c34e308c56c3 |
| 29        | success | 2026-11-20T07:34:33.855Z | 140 ms | 8,110 ms | 2,060 ms        | 14,289.903 ms | 143,403 bytes / 40,150 bytes | 0e695a97-2df1-4241-bb36-312c714476a6 |
| 30        | success | 2026-11-20T07:34:49.485Z | 141 ms | 7,580 ms | 2,050 ms        | 13,717.794 ms | 143,403 bytes / 40,150 bytes | 4eb37fe2-21f6-49c4-a4be-53135a8f3cbc |

</details>

## Latency workload summary

| Workload | URL                                                                  | Mean      | P50       | P95        |
| -------- | -------------------------------------------------------------------- | --------- | --------- | ---------- |
| baseline | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev/ | 66.643 ms | 57.787 ms | 118.306 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency

Empty Void response

### Client latency

| Measurement       | Value      |
| ----------------- | ---------- |
| Mean              | 66.643 ms  |
| Minimum           | 28.384 ms  |
| P50               | 57.787 ms  |
| P95               | 118.306 ms |
| P99               | 206.603 ms |
| Maximum           | 923.248 ms |
| Throughput        | 15 req/s   |
| Measured duration | 666.668 s  |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 10,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 66.643 ms  | [64.888, 68.267] ms   | 2.54%                    | Met        |
| P50         | 57.787 ms  | [56.093, 59.454] ms   | 2.91%                    | Met        |
| P95         | 118.306 ms | [112.779, 122.736] ms | 4.21%                    | Met        |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 1,000             | 2026-11-20T07:35:22.186Z |
| 2     | success | 1,000             | 2026-11-20T07:36:31.983Z |
| 3     | success | 1,000             | 2026-11-20T07:37:44.908Z |
| 4     | success | 1,000             | 2026-11-20T07:38:59.185Z |
| 5     | success | 1,000             | 2026-11-20T07:40:11.042Z |
| 6     | success | 1,000             | 2026-11-20T07:41:26.784Z |
| 7     | success | 1,000             | 2026-11-20T07:42:34.866Z |
| 8     | success | 1,000             | 2026-11-20T07:43:39.739Z |
| 9     | success | 1,000             | 2026-11-20T07:44:47.058Z |
| 10    | success | 1,000             | 2026-11-20T07:46:00.951Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 10,586   | 0      | 0           |

| Measurement    | P50       | P90        | P99        | P99.9      |
| -------------- | --------- | ---------- | ---------- | ---------- |
| CPU            | 501 µs    | 914 µs     | 1,826 µs   | 8,771 µs   |
| Wall time      | 1,325 µs  | 2,729 µs   | 6,093 µs   | 13,021 µs  |
| Isolate memory | 7.008 MiB | 10.758 MiB | 12.508 MiB | 12.758 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T07:35:18.540Z |
| Measurement end (UTC)                | 2026-11-20T07:47:06.602Z |
| Query start, inclusive (UTC)         | 2026-11-20T07:33:48.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T07:48:37.000Z |
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
