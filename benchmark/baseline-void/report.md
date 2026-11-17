# baseline-void benchmark report

Successful run: **2026-11-17T03:17:44.865Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-17T03:01:59.221Z                                         |
| Run finished (UTC)                    | 2026-11-17T03:17:44.865Z                                         |
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

### latency

| Field                                                       | Value                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| URL                                                         | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev/ |
| Method                                                      | GET                                                                  |
| Expected status                                             | 200                                                                  |
| Expected body size per response                             | Not constrained                                                      |
| Measured requests per round                                 | 500                                                                  |
| Latency rounds                                              | 10                                                                   |
| Total measured requests                                     | 5000                                                                 |
| Duration limit per round                                    | None                                                                 |
| Connections                                                 | 1                                                                    |
| Rate limit                                                  | None                                                                 |
| Request timeout                                             | 30s                                                                  |
| HTTP version                                                | 1.1                                                                  |
| Keep-alive                                                  | true                                                                 |
| Warmup requests per round (excluded from client statistics) | 50                                                                   |
| Access authentication                                       | temporary-login                                                      |
| HTTP response counts                                        | 200: 5,000                                                           |

</details>

## Build & deployment

### Bundle size

| Format | Size (Median) |
| ------ | ------------- |
| Raw    | 142,649 bytes |
| Gzip   | 39,872 bytes  |

### Timing summary

| Phase          | Mean          | Mean 95% CI                 | Median        |
| -------------- | ------------- | --------------------------- | ------------- |
| Build          | 139.2 ms      | [134.333, 144.233] ms       | 131 ms        |
| Upload         | 7,543 ms      | [7,216, 7,763] ms           | 7,675 ms      |
| Worker startup | 5.9 ms        | [4.233, 8.733] ms           | 4 ms          |
| `cf deploy`    | 13,680.044 ms | [13,222.609, 13,975.676] ms | 13,863.893 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Worker                                                          | void-perf-baseline-void                                             |
| Worker ID                                                       | 564710ff32b14cbdb179ca5ea82f80f4                                    |
| Version ID                                                      | 341b139a-c4f4-4c0f-8e0b-efb55bff1334                                |
| Origin                                                          | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 2,798.936 ms                                                        |
| Final run workflow wall time (includes cleanup, lookup, Access) | 17,726.218 ms                                                       |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range           |
| ------ | ---------------- | --------------------- |
| Raw    | 142,649 bytes    | 142,649–142,649 bytes |
| Gzip   | 39,872 bytes     | 39,872–39,872 bytes   |

Bundle-size variation: None observed.

#### Full timing statistics

| Phase                       | Valid / missing | Mean          | Mean 95% CI                 | Median        | Median 95% CI               | Sample SD    | IQR        | Min–max                 | Mean CI half-width / mean | ±5% target |
| --------------------------- | --------------- | ------------- | --------------------------- | ------------- | --------------------------- | ------------ | ---------- | ----------------------- | ------------------------- | ---------- |
| Build                       | 30 / 0          | 139.2 ms      | [134.333, 144.233] ms       | 131 ms        | [131, 145.5] ms             | 13.902 ms    | 27 ms      | 124–161 ms              | 3.56%                     | Met        |
| Upload                      | 30 / 0          | 7,543 ms      | [7,216, 7,763] ms           | 7,675 ms      | [7,470, 7,765] ms           | 809.151 ms   | 402.5 ms   | 3,600–8,390 ms          | 3.63%                     | Met        |
| Deploy triggers             | 30 / 0          | 1,759.333 ms  | [1,619.667, 1,875.008] ms   | 1,830 ms      | [1,815, 1,885] ms           | 370.032 ms   | 122.5 ms   | 600–2,250 ms            | 7.26%                     | Not met    |
| Worker startup              | 30 / 0          | 5.9 ms        | [4.233, 8.733] ms           | 4 ms          | [4, 5] ms                   | 6.88 ms      | 1.75 ms    | 3–41 ms                 | 38.14%                    | Not met    |
| `cf deploy`                 | 30 / 0          | 13,680.044 ms | [13,222.609, 13,975.676] ms | 13,863.893 ms | [13,700.961, 14,056.177] ms | 1,142.409 ms | 588.536 ms | 7,954.279–14,594.311 ms | 2.75%                     | Met        |
| Local preparation + cleanup | 30 / 0          | 5.306 ms      | [5.082, 5.511] ms           | 5.386 ms      | [5.293, 5.523] ms           | 0.613 ms     | 0.464 ms   | 3.319–7.028 ms          | 4.04%                     | Met        |
| Worker lookup               | 30 / 0          | 1,237.484 ms  | [1,162.88, 1,299.116] ms    | 1,269.37 ms   | [1,250.6, 1,302.809] ms     | 196.736 ms   | 74.99 ms   | 634.468–1,520.627 ms    | 5.5%                      | Not met    |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0                                     |
| Batch start / finish (UTC)               | 2026-11-17T03:01:59.735Z / 2026-11-17T03:09:30.257Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build  | Upload   | Deploy triggers | `cf deploy`   | Raw / gzip                   | Version                              |
| --------- | ------- | ------------------------ | ------ | -------- | --------------- | ------------- | ---------------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-17T03:01:59.736Z | 132 ms | 8,390 ms | 730 ms          | 14,250.457 ms | 142,649 bytes / 39,872 bytes | 1f40ecec-f323-4d6f-97e4-cfbf53d4695a |
| 2         | success | 2026-11-17T03:02:15.238Z | 127 ms | 3,600 ms | 600 ms          | 7,954.279 ms  | 142,649 bytes / 39,872 bytes | 080974a4-97e4-4313-a873-5ab84ddd2b29 |
| 3         | success | 2026-11-17T03:02:24.719Z | 125 ms | 7,820 ms | 1,830 ms        | 13,970.38 ms  | 142,649 bytes / 39,872 bytes | b3f4bd43-61f8-45c4-a507-1e6c8a84243e |
| 4         | success | 2026-11-17T03:02:40.066Z | 131 ms | 7,890 ms | 1,840 ms        | 14,083.013 ms | 142,649 bytes / 39,872 bytes | ed3e6a69-6916-4932-bc20-034d67c374eb |
| 5         | success | 2026-11-17T03:02:55.441Z | 158 ms | 7,600 ms | 1,760 ms        | 13,762.63 ms  | 142,649 bytes / 39,872 bytes | 9d699a18-0536-40fb-9ffb-d49d979c6d01 |
| 6         | success | 2026-11-17T03:03:10.476Z | 157 ms | 8,020 ms | 1,830 ms        | 14,264.785 ms | 142,649 bytes / 39,872 bytes | ba616f0e-8960-4197-871d-edfe4aefdc03 |
| 7         | success | 2026-11-17T03:03:25.996Z | 158 ms | 7,430 ms | 1,920 ms        | 13,670.326 ms | 142,649 bytes / 39,872 bytes | 1c6df054-cdc7-4c67-8d34-fc4be744f208 |
| 8         | success | 2026-11-17T03:03:40.868Z | 135 ms | 7,770 ms | 1,850 ms        | 13,976.799 ms | 142,649 bytes / 39,872 bytes | b901c919-57d9-4015-a0f6-61ddd95e935b |
| 9         | success | 2026-11-17T03:03:56.069Z | 133 ms | 8,280 ms | 1,920 ms        | 14,594.311 ms | 142,649 bytes / 39,872 bytes | 64a9b1ca-0fa1-48d9-be5f-89fd7d857a1d |
| 10        | success | 2026-11-17T03:04:11.437Z | 130 ms | 8,240 ms | 1,790 ms        | 14,370.236 ms | 142,649 bytes / 39,872 bytes | f6b282ae-f0a4-4d30-b0b7-0bee47beb99a |
| 11        | success | 2026-11-17T03:04:26.449Z | 128 ms | 7,370 ms | 1,890 ms        | 13,527.501 ms | 142,649 bytes / 39,872 bytes | 8a69163a-3bcd-483d-b82c-9c6a689f9942 |
| 12        | success | 2026-11-17T03:04:40.661Z | 131 ms | 7,660 ms | 1,830 ms        | 13,798.904 ms | 142,649 bytes / 39,872 bytes | dc12ae4b-e124-4c30-9533-7289fb10cb22 |
| 13        | success | 2026-11-17T03:04:55.791Z | 161 ms | 8,040 ms | 2,000 ms        | 14,370.998 ms | 142,649 bytes / 39,872 bytes | 645eda39-14b2-45dd-9e2c-8a87b48fa9dd |
| 14        | success | 2026-11-17T03:05:11.475Z | 130 ms | 7,700 ms | 2,250 ms        | 14,332.762 ms | 142,649 bytes / 39,872 bytes | 2be9e738-658f-4e36-857f-74394ec14536 |
| 15        | success | 2026-11-17T03:05:27.072Z | 158 ms | 7,710 ms | 1,960 ms        | 14,029.34 ms  | 142,649 bytes / 39,872 bytes | f1312d9d-ac5a-4548-bd6f-b8b256af8388 |
| 16        | success | 2026-11-17T03:05:42.366Z | 157 ms | 7,300 ms | 1,850 ms        | 13,498.981 ms | 142,649 bytes / 39,872 bytes | 28a5ad71-6b2e-4608-921f-06bafa47a994 |
| 17        | success | 2026-11-17T03:05:57.124Z | 131 ms | 7,840 ms | 810 ms          | 13,020.949 ms | 142,649 bytes / 39,872 bytes | c58adaac-88e5-4da6-8643-975f5f4a7acf |
| 18        | success | 2026-11-17T03:06:11.397Z | 156 ms | 7,210 ms | 1,880 ms        | 13,427.027 ms | 142,649 bytes / 39,872 bytes | 190f0f9a-b885-4e4f-b5bc-34be90e4df73 |
| 19        | success | 2026-11-17T03:06:26.103Z | 130 ms | 7,760 ms | 1,820 ms        | 14,151.63 ms  | 142,649 bytes / 39,872 bytes | 649daef6-2c5f-4097-8c77-e2e90e09ade3 |
| 20        | success | 2026-11-17T03:06:41.672Z | 131 ms | 7,500 ms | 1,800 ms        | 13,731.597 ms | 142,649 bytes / 39,872 bytes | c38c5902-90a9-42bd-9335-321c12f1343b |
| 21        | success | 2026-11-17T03:06:56.775Z | 127 ms | 7,750 ms | 2,080 ms        | 14,226.475 ms | 142,649 bytes / 39,872 bytes | 1aa7484e-fb26-45de-b06a-cea2322e2343 |
| 22        | success | 2026-11-17T03:07:12.373Z | 131 ms | 7,950 ms | 1,810 ms        | 14,171.121 ms | 142,649 bytes / 39,872 bytes | d007caef-7fa4-4cb4-bddb-fa9b99255e17 |
| 23        | success | 2026-11-17T03:07:27.792Z | 161 ms | 7,140 ms | 1,820 ms        | 13,332.642 ms | 142,649 bytes / 39,872 bytes | 735b208b-3edf-46ca-a3ab-fdea3cdf8de8 |
| 24        | success | 2026-11-17T03:07:42.377Z | 124 ms | 7,490 ms | 1,950 ms        | 13,763.161 ms | 142,649 bytes / 39,872 bytes | 0cc28536-9922-46ab-8299-d7b9fd7cce88 |
| 25        | success | 2026-11-17T03:07:57.497Z | 158 ms | 7,620 ms | 1,900 ms        | 13,891.158 ms | 142,649 bytes / 39,872 bytes | e06cd849-c4d4-4373-87c6-bb67d057ebf8 |
| 26        | success | 2026-11-17T03:08:12.691Z | 131 ms | 7,450 ms | 1,830 ms        | 13,609.765 ms | 142,649 bytes / 39,872 bytes | 9eeb1b3f-e287-461e-9ec6-2b12d5c97ee3 |
| 27        | success | 2026-11-17T03:08:27.565Z | 158 ms | 7,200 ms | 1,770 ms        | 13,325.278 ms | 142,649 bytes / 39,872 bytes | 80fd781b-8c2b-4bbf-bfe4-820e06f18e27 |
| 28        | success | 2026-11-17T03:08:42.208Z | 131 ms | 7,690 ms | 1,760 ms        | 13,870.145 ms | 142,649 bytes / 39,872 bytes | c3b703eb-6cb0-4778-ba5d-3e7188bb05cb |
| 29        | success | 2026-11-17T03:08:57.367Z | 132 ms | 7,430 ms | 1,930 ms        | 13,857.641 ms | 142,649 bytes / 39,872 bytes | 498c3952-5d93-4a2e-9a78-d77fc392410b |
| 30        | success | 2026-11-17T03:09:12.531Z | 124 ms | 7,440 ms | 1,770 ms        | 13,567.029 ms | 142,649 bytes / 39,872 bytes | 341b139a-c4f4-4c0f-8e0b-efb55bff1334 |

</details>

## Latency workload summary

| Workload | URL                                                                  | Mean      | P50       | P95       |
| -------- | -------------------------------------------------------------------- | --------- | --------- | --------- |
| latency  | https://void-perf-baseline-void.cloudflare-internal-11e.workers.dev/ | 38.183 ms | 34.900 ms | 52.354 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency

Recorded latency workload

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 38.183 ms    |
| Minimum           | 23.777 ms    |
| P50               | 34.9 ms      |
| P95               | 52.354 ms    |
| P99               | 104.2 ms     |
| Maximum           | 1,256.625 ms |
| Throughput        | 26.174 req/s |
| Measured duration | 191.027 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate  | 95% CI              | CI half-width / estimate | ±5% target |
| ----------- | --------- | ------------------- | ------------------------ | ---------- |
| Mean        | 38.183 ms | [36.487, 40.097] ms | 4.73%                    | Met        |
| P50         | 34.9 ms   | [33.632, 37.141] ms | 5.03%                    | Not met    |
| P95         | 52.354 ms | [47.471, 55.373] ms | 7.55%                    | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 500               | 2026-11-17T03:09:40.840Z |
| 2     | success | 500               | 2026-11-17T03:10:01.020Z |
| 3     | success | 500               | 2026-11-17T03:10:23.726Z |
| 4     | success | 500               | 2026-11-17T03:10:47.097Z |
| 5     | success | 500               | 2026-11-17T03:11:06.758Z |
| 6     | success | 500               | 2026-11-17T03:11:27.300Z |
| 7     | success | 500               | 2026-11-17T03:11:48.374Z |
| 8     | success | 500               | 2026-11-17T03:12:08.925Z |
| 9     | success | 500               | 2026-11-17T03:12:30.381Z |
| 10    | success | 500               | 2026-11-17T03:12:50.625Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 5,500    | 0      | 0           |

| Measurement    | P50       | P90       | P99       | P99.9     |
| -------------- | --------- | --------- | --------- | --------- |
| CPU            | 391 µs    | 629 µs    | 1,211 µs  | 4,437 µs  |
| Wall time      | 971 µs    | 1,542 µs  | 3,252 µs  | 6,724 µs  |
| Isolate memory | 3.004 MiB | 3.754 MiB | 4.254 MiB | 4.504 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-17T03:09:38.707Z |
| Measurement end (UTC)                | 2026-11-17T03:13:13.101Z |
| Query start, inclusive (UTC)         | 2026-11-17T03:08:08.000Z |
| Query end, inclusive (UTC)           | 2026-11-17T03:14:44.000Z |
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
