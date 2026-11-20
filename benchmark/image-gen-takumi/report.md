# image-gen-takumi benchmark report

Successful run: **2026-11-19T02:33:30.849Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-19T02:23:14.418Z                                         |
| Run finished (UTC)                    | 2026-11-19T02:33:30.849Z                                         |
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
| URL                                                         | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/ |
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

| Format | Size (Median)   |
| ------ | --------------- |
| Raw    | 5,087,110 bytes |
| Gzip   | 2,345,981 bytes |

### Timing summary

| Phase          | Mean          | Mean 95% CI | Median        |
| -------------- | ------------- | ----------- | ------------- |
| Build          | 197 ms        | Unavailable | 197 ms        |
| Upload         | 8,880 ms      | Unavailable | 8,880 ms      |
| Worker startup | 3 ms          | Unavailable | 3 ms          |
| `cf deploy`    | 15,558.885 ms | Unavailable | 15,558.885 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker                                                          | void-perf-image-gen-takumi                                             |
| Worker ID                                                       | 2c1dcf4023ac49348e398b086b32f4b5                                       |
| Version ID                                                      | d0fc7d05-7a7f-4242-8bb2-14dd7744ddcc                                   |
| Origin                                                          | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 2,911.394 ms                                                           |
| Final run workflow wall time (includes cleanup, lookup, Access) | 19,795.263 ms                                                          |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range               |
| ------ | ---------------- | ------------------------- |
| Raw    | 5,087,110 bytes  | 5,087,110–5,087,110 bytes |
| Gzip   | 2,345,981 bytes  | 2,345,981–2,345,981 bytes |

Bundle-size variation: None observed.

#### Full timing statistics

| Phase                       | Valid / missing | Mean          | Mean 95% CI | Median        | Median 95% CI | Sample SD   | IQR  | Min–max                  | Mean CI half-width / mean | ±5% target  |
| --------------------------- | --------------- | ------------- | ----------- | ------------- | ------------- | ----------- | ---- | ------------------------ | ------------------------- | ----------- |
| Build                       | 1 / 0           | 197 ms        | Unavailable | 197 ms        | Unavailable   | Unavailable | 0 ms | 197–197 ms               | Unavailable               | Unavailable |
| Upload                      | 1 / 0           | 8,880 ms      | Unavailable | 8,880 ms      | Unavailable   | Unavailable | 0 ms | 8,880–8,880 ms           | Unavailable               | Unavailable |
| Deploy triggers             | 1 / 0           | 2,040 ms      | Unavailable | 2,040 ms      | Unavailable   | Unavailable | 0 ms | 2,040–2,040 ms           | Unavailable               | Unavailable |
| Worker startup              | 1 / 0           | 3 ms          | Unavailable | 3 ms          | Unavailable   | Unavailable | 0 ms | 3–3 ms                   | Unavailable               | Unavailable |
| `cf deploy`                 | 1 / 0           | 15,558.885 ms | Unavailable | 15,558.885 ms | Unavailable   | Unavailable | 0 ms | 15,558.885–15,558.885 ms | Unavailable               | Unavailable |
| Local preparation + cleanup | 1 / 0           | 4.749 ms      | Unavailable | 4.749 ms      | Unavailable   | Unavailable | 0 ms | 4.749–4.749 ms           | Unavailable               | Unavailable |
| Worker lookup               | 1 / 0           | 1,318.865 ms  | Unavailable | 1,318.865 ms  | Unavailable   | Unavailable | 0 ms | 1,318.865–1,318.865 ms   | Unavailable               | Unavailable |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 1 / 1 / 0 / 0                                       |
| Batch start / finish (UTC)               | 2026-11-19T02:23:14.520Z / 2026-11-19T02:23:34.317Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build  | Upload   | Deploy triggers | `cf deploy`   | Raw / gzip                        | Version                              |
| --------- | ------- | ------------------------ | ------ | -------- | --------------- | ------------- | --------------------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-19T02:23:14.521Z | 197 ms | 8,880 ms | 2,040 ms        | 15,558.885 ms | 5,087,110 bytes / 2,345,981 bytes | d0fc7d05-7a7f-4242-8bb2-14dd7744ddcc |

</details>

## Latency workload summary

| Workload | URL                                                                     | Mean      | P50       | P95       |
| -------- | ----------------------------------------------------------------------- | --------- | --------- | --------- |
| baseline | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/ | 28.316 ms | 26.077 ms | 36.965 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency

Empty response with image code present in the deployment

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 28.316 ms    |
| Minimum           | 17.844 ms    |
| P50               | 26.077 ms    |
| P95               | 36.965 ms    |
| P99               | 84.278 ms    |
| Maximum           | 235.584 ms   |
| Throughput        | 35.291 req/s |
| Measured duration | 283.359 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 10,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate  | 95% CI              | CI half-width / estimate | ±5% target |
| ----------- | --------- | ------------------- | ------------------------ | ---------- |
| Mean        | 28.316 ms | [27.717, 29.07] ms  | 2.39%                    | Met        |
| P50         | 26.077 ms | [25.725, 26.439] ms | 1.37%                    | Met        |
| P95         | 36.965 ms | [35.689, 38.635] ms | 3.98%                    | Met        |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 1,000             | 2026-11-19T02:23:58.318Z |
| 2     | success | 1,000             | 2026-11-19T02:24:28.100Z |
| 3     | success | 1,000             | 2026-11-19T02:24:57.735Z |
| 4     | success | 1,000             | 2026-11-19T02:25:30.733Z |
| 5     | success | 1,000             | 2026-11-19T02:26:01.423Z |
| 6     | success | 1,000             | 2026-11-19T02:26:30.808Z |
| 7     | success | 1,000             | 2026-11-19T02:26:59.976Z |
| 8     | success | 1,000             | 2026-11-19T02:27:30.091Z |
| 9     | success | 1,000             | 2026-11-19T02:28:00.245Z |
| 10    | success | 1,000             | 2026-11-19T02:28:31.005Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 10,498   | 0      | 0           |

| Measurement    | P50       | P90       | P99       | P99.9     |
| -------------- | --------- | --------- | --------- | --------- |
| CPU            | 400 µs    | 626 µs    | 1,230 µs  | 4,701 µs  |
| Wall time      | 950 µs    | 1,526 µs  | 3,312 µs  | 7,622 µs  |
| Isolate memory | 6.181 MiB | 6.931 MiB | 7.931 MiB | 8.181 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-19T02:23:56.336Z |
| Measurement end (UTC)                | 2026-11-19T02:28:59.056Z |
| Query start, inclusive (UTC)         | 2026-11-19T02:22:26.000Z |
| Query end, inclusive (UTC)           | 2026-11-19T02:30:30.000Z |
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
