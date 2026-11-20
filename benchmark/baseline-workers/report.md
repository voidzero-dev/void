# baseline-workers benchmark report

Successful run: **2026-11-20T08:33:20.371Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-20T08:13:43.926Z                                         |
| Run finished (UTC)                    | 2026-11-20T08:33:20.371Z                                         |
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
| Build          | 7.9 ms       | [7.6, 8.233] ms           | 8 ms         |
| Upload         | 5,075 ms     | [4,777.333, 5,286.667] ms | 5,215 ms     |
| Worker startup | 1.333 ms     | [1.133, 1.567] ms         | 1 ms         |
| `cf deploy`    | 8,671.097 ms | [8,203.864, 9,005.706] ms | 8,894.724 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker                                                          | void-perf-baseline-workers                                             |
| Worker ID                                                       | 4f1d26c4641a43588ec1eb090de69ae0                                       |
| Version ID                                                      | 8bc5c60c-27a9-4727-ab79-ae0cb6a5ff74                                   |
| Origin                                                          | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 6,373.865 ms                                                           |
| Final run workflow wall time (includes cleanup, lookup, Access) | 16,842.384 ms                                                          |

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

| Phase                       | Valid / missing | Mean         | Mean 95% CI               | Median       | Median 95% CI             | Sample SD    | IQR        | Min–max               | Mean CI half-width / mean | ±5% target |
| --------------------------- | --------------- | ------------ | ------------------------- | ------------ | ------------------------- | ------------ | ---------- | --------------------- | ------------------------- | ---------- |
| Build                       | 30 / 0          | 7.9 ms       | [7.6, 8.233] ms           | 8 ms         | [7.5, 8] ms               | 0.923 ms     | 1 ms       | 7–11 ms               | 4.01%                     | Met        |
| Upload                      | 30 / 0          | 5,075 ms     | [4,777.333, 5,286.667] ms | 5,215 ms     | [5,120, 5,280] ms         | 734.118 ms   | 207.5 ms   | 2,140–5,710 ms        | 5.02%                     | Not met    |
| Deploy triggers             | 30 / 0          | 1,800.333 ms | [1,674.325, 1,892.667] ms | 1,865 ms     | [1,820, 1,890] ms         | 314.22 ms    | 112.5 ms   | 660–2,200 ms          | 6.06%                     | Not met    |
| Worker startup              | 30 / 0          | 1.333 ms     | [1.133, 1.567] ms         | 1 ms         | [1, 1] ms                 | 0.606 ms     | 0.75 ms    | 1–3 ms                | 16.25%                    | Not met    |
| `cf deploy`                 | 30 / 0          | 8,671.097 ms | [8,203.864, 9,005.706] ms | 8,894.724 ms | [8,717.794, 8,984.126] ms | 1,160.715 ms | 331.644 ms | 3,888.986–9,993.87 ms | 4.62%                     | Met        |
| Local preparation + cleanup | 30 / 0          | 1.617 ms     | [1.487, 1.745] ms         | 1.65 ms      | [1.507, 1.735] ms         | 0.366 ms     | 0.325 ms   | 0.742–2.6 ms          | 7.97%                     | Not met    |
| Worker lookup               | 30 / 0          | 1,251.338 ms | [1,180.199, 1,309.651] ms | 1,296.73 ms  | [1,280.322, 1,317.061] ms | 186.586 ms   | 47.637 ms  | 652.748–1,410.66 ms   | 5.17%                     | Not met    |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0                                     |
| Batch start / finish (UTC)               | 2026-11-20T08:13:44.388Z / 2026-11-20T08:18:48.526Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build | Upload   | Deploy triggers | `cf deploy`  | Raw / gzip            | Version                              |
| --------- | ------- | ------------------------ | ----- | -------- | --------------- | ------------ | --------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-20T08:13:44.389Z | 8 ms  | 5,710 ms | 1,890 ms        | 9,503.075 ms | 187 bytes / 161 bytes | 6826b0c9-9210-4aec-a252-00af390abfb4 |
| 2         | success | 2026-11-20T08:13:54.707Z | 8 ms  | 5,220 ms | 1,880 ms        | 8,908.069 ms | 187 bytes / 161 bytes | 3d230aa2-9578-4883-8e3f-6317eec45709 |
| 3         | success | 2026-11-20T08:14:04.940Z | 9 ms  | 5,420 ms | 1,940 ms        | 9,106.686 ms | 187 bytes / 161 bytes | 01174f0b-b8de-4384-83c3-5b5ff95f528b |
| 4         | success | 2026-11-20T08:14:15.412Z | 8 ms  | 2,140 ms | 660 ms          | 3,888.986 ms | 187 bytes / 161 bytes | a4c2a72b-143c-417f-8a54-53a13781c12f |
| 5         | success | 2026-11-20T08:14:20.600Z | 8 ms  | 5,310 ms | 2,200 ms        | 9,331.251 ms | 187 bytes / 161 bytes | 66d45954-0af0-4470-8781-b74685660ce0 |
| 6         | success | 2026-11-20T08:14:31.185Z | 7 ms  | 5,200 ms | 1,760 ms        | 8,682.739 ms | 187 bytes / 161 bytes | 1075ced5-d5eb-4be6-85b7-5b2307b2af3e |
| 7         | success | 2026-11-20T08:14:40.560Z | 8 ms  | 5,400 ms | 1,800 ms        | 8,926.047 ms | 187 bytes / 161 bytes | 77e814aa-6ecc-48c5-ab31-3a517b7cd3ab |
| 8         | success | 2026-11-20T08:14:50.814Z | 8 ms  | 5,210 ms | 1,930 ms        | 8,779.976 ms | 187 bytes / 161 bytes | 9dd1e08a-9a60-4c6b-ae29-18733816170a |
| 9         | success | 2026-11-20T08:15:00.847Z | 8 ms  | 5,660 ms | 2,000 ms        | 9,421.303 ms | 187 bytes / 161 bytes | 08d8c4e3-b56d-4df1-bf7e-90c37090f0d8 |
| 10        | success | 2026-11-20T08:15:11.568Z | 8 ms  | 5,090 ms | 1,840 ms        | 8,672.73 ms  | 187 bytes / 161 bytes | ab919734-e444-46b2-ac88-0f9f129c56f5 |
| 11        | success | 2026-11-20T08:15:21.521Z | 11 ms | 5,650 ms | 1,890 ms        | 9,425.344 ms | 187 bytes / 161 bytes | 41b646ec-9842-41e2-b93f-4c1d3d3c42cb |
| 12        | success | 2026-11-20T08:15:32.320Z | 7 ms  | 5,110 ms | 1,790 ms        | 8,619.668 ms | 187 bytes / 161 bytes | dfe10c8a-4c08-482f-91da-fa5856dcb91a |
| 13        | success | 2026-11-20T08:15:42.217Z | 8 ms  | 5,220 ms | 1,890 ms        | 8,951.16 ms  | 187 bytes / 161 bytes | ea5ef3a7-213e-44cf-9188-80f9192542cc |
| 14        | success | 2026-11-20T08:15:52.460Z | 8 ms  | 5,320 ms | 1,780 ms        | 8,827.835 ms | 187 bytes / 161 bytes | c5d98523-5a4c-4c6d-9f49-eb882650fe24 |
| 15        | success | 2026-11-20T08:16:02.595Z | 10 ms | 5,340 ms | 1,920 ms        | 8,992.49 ms  | 187 bytes / 161 bytes | f6a76631-b9f1-42a6-892e-2a1e2ac77735 |
| 16        | success | 2026-11-20T08:16:12.849Z | 8 ms  | 5,050 ms | 1,850 ms        | 8,625.2 ms   | 187 bytes / 161 bytes | 280f66a3-f1eb-4b15-9bd2-987297bcf9c0 |
| 17        | success | 2026-11-20T08:16:22.759Z | 8 ms  | 5,120 ms | 1,920 ms        | 8,853.764 ms | 187 bytes / 161 bytes | 23bbbcde-8093-420f-a809-080a7cb3492e |
| 18        | success | 2026-11-20T08:16:32.922Z | 7 ms  | 5,270 ms | 1,980 ms        | 9,011.671 ms | 187 bytes / 161 bytes | 261af6d6-75bc-4044-aeac-71d8ef31e962 |
| 19        | success | 2026-11-20T08:16:43.342Z | 7 ms  | 5,290 ms | 1,870 ms        | 8,932.902 ms | 187 bytes / 161 bytes | 8f3e5eaf-64d2-4cb6-b386-8dbb6677876b |
| 20        | success | 2026-11-20T08:16:53.562Z | 7 ms  | 5,000 ms | 1,880 ms        | 8,725.608 ms | 187 bytes / 161 bytes | 84ed497c-5956-4a7e-a18d-e374e3b75c04 |
| 21        | success | 2026-11-20T08:17:03.607Z | 8 ms  | 5,100 ms | 1,800 ms        | 8,596.324 ms | 187 bytes / 161 bytes | b602374f-a1e5-4689-8d7a-65dc8196351c |
| 22        | success | 2026-11-20T08:17:13.484Z | 7 ms  | 2,810 ms | 720 ms          | 5,356.07 ms  | 187 bytes / 161 bytes | 326be124-cb00-4641-9ae7-caf18fbf1d09 |
| 23        | success | 2026-11-20T08:17:20.181Z | 7 ms  | 5,240 ms | 1,810 ms        | 9,993.87 ms  | 187 bytes / 161 bytes | 11fb2227-eb45-4bf3-af04-19dd3ba40c4e |
| 24        | success | 2026-11-20T08:17:31.588Z | 9 ms  | 5,240 ms | 1,850 ms        | 8,986.702 ms | 187 bytes / 161 bytes | 9bdc86c9-fb7f-4c74-b4e3-17d860f158b0 |
| 25        | success | 2026-11-20T08:17:41.870Z | 7 ms  | 5,120 ms | 1,800 ms        | 8,650.796 ms | 187 bytes / 161 bytes | c596efa2-e377-4156-b3e2-080f054a8ed4 |
| 26        | success | 2026-11-20T08:17:51.175Z | 7 ms  | 5,110 ms | 1,990 ms        | 8,881.38 ms  | 187 bytes / 161 bytes | 9c959e8d-3c44-452a-a52d-a94865c79e57 |
| 27        | success | 2026-11-20T08:18:01.368Z | 7 ms  | 5,060 ms | 1,790 ms        | 8,670.737 ms | 187 bytes / 161 bytes | 060e7655-306d-4cc5-9749-0e453829fff4 |
| 28        | success | 2026-11-20T08:18:11.358Z | 8 ms  | 5,180 ms | 1,830 ms        | 8,709.98 ms  | 187 bytes / 161 bytes | ce1d9543-fdc7-416d-bd24-4989ae23c70b |
| 29        | success | 2026-11-20T08:18:21.343Z | 8 ms  | 5,210 ms | 1,860 ms        | 8,981.549 ms | 187 bytes / 161 bytes | 366870a2-94f7-4923-afd5-abef933f846b |
| 30        | success | 2026-11-20T08:18:31.683Z | 8 ms  | 5,450 ms | 1,890 ms        | 9,118.984 ms | 187 bytes / 161 bytes | 8bc5c60c-27a9-4727-ab79-ae0cb6a5ff74 |

</details>

## Latency workload summary

| Workload | URL                                                                     | Mean      | P50       | P95       |
| -------- | ----------------------------------------------------------------------- | --------- | --------- | --------- |
| baseline | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev/ | 55.328 ms | 48.647 ms | 96.258 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency

Empty Workers response

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 55.328 ms    |
| Minimum           | 27.52 ms     |
| P50               | 48.647 ms    |
| P95               | 96.258 ms    |
| P99               | 171.818 ms   |
| Maximum           | 618.029 ms   |
| Throughput        | 18.067 req/s |
| Measured duration | 553.508 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 10,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate  | 95% CI               | CI half-width / estimate | ±5% target |
| ----------- | --------- | -------------------- | ------------------------ | ---------- |
| Mean        | 55.328 ms | [52.547, 58.249] ms  | 5.15%                    | Not met    |
| P50         | 48.647 ms | [46.668, 50.718] ms  | 4.16%                    | Met        |
| P95         | 96.258 ms | [87.391, 103.455] ms | 8.34%                    | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 1,000             | 2026-11-20T08:19:03.802Z |
| 2     | success | 1,000             | 2026-11-20T08:20:06.851Z |
| 3     | success | 1,000             | 2026-11-20T08:21:10.927Z |
| 4     | success | 1,000             | 2026-11-20T08:22:17.060Z |
| 5     | success | 1,000             | 2026-11-20T08:23:20.482Z |
| 6     | success | 1,000             | 2026-11-20T08:24:17.424Z |
| 7     | success | 1,000             | 2026-11-20T08:25:12.881Z |
| 8     | success | 1,000             | 2026-11-20T08:26:08.773Z |
| 9     | success | 1,000             | 2026-11-20T08:27:03.420Z |
| 10    | success | 1,000             | 2026-11-20T08:27:54.521Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 10,983   | 0      | 0           |

| Measurement    | P50      | P90      | P99      | P99.9    |
| -------------- | -------- | -------- | -------- | -------- |
| CPU            | 269 µs   | 506 µs   | 816 µs   | 1,697 µs |
| Wall time      | 1,090 µs | 2,087 µs | 4,284 µs | 8,047 µs |
| Isolate memory | 1.75 MiB | 2 MiB    | 2.5 MiB  | 2.5 MiB  |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T08:18:59.500Z |
| Measurement end (UTC)                | 2026-11-20T08:28:48.271Z |
| Query start, inclusive (UTC)         | 2026-11-20T08:17:29.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T08:30:19.000Z |
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
