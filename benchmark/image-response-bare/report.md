# image-response-bare benchmark report

Successful run: **2026-11-17T04:18:13.658Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context
 
| Field | Value |
| --- | --- |
| Run started (UTC) | 2026-11-17T03:51:40.606Z |
| Run finished (UTC) | 2026-11-17T04:18:13.658Z |
| Platform | darwin |
| OS release | 25.6.0 |
| Node.js | v24.22.1 |
| oha | oha 1.17.0 |
| CPU | Apple M5 Pro |
| Architecture | arm64 |
| Logical cores / available parallelism | 18 / 18 |
| Network type / interface | ethernet / en7 |
| Hostname SHA-256 | ac84d7c6ed5458a31e79a25f931f16b87220758dc1677e9cdf9022505db370aa |

Network information describes the local default route, not a verified end-to-end path.



## Workload


### baseline


| Field | Value |
| --- | --- |
| URL | https://void-perf-image-response-bare.cloudflare-internal-11e.workers.dev/ |
| Method | GET |
| Expected status | 200 |
| Expected body size per response | 0 bytes |
| Measured requests per round | 500 |
| Latency rounds | 10 |
| Total measured requests | 5000 |
| Duration limit per round | None |
| Connections | 1 |
| Rate limit | None |
| Request timeout | 30s |
| HTTP version | 1.1 |
| Keep-alive | true |
| Warmup requests per round (excluded from client statistics) | 50 |
| Access authentication | temporary-login |
| HTTP response counts | 200: 5,000 |

### render


| Field | Value |
| --- | --- |
| URL | https://void-perf-image-response-bare.cloudflare-internal-11e.workers.dev/run |
| Method | GET |
| Expected status | 200 |
| Expected body size per response | Not constrained |
| Measured requests per round | 500 |
| Latency rounds | 10 |
| Total measured requests | 5000 |
| Duration limit per round | None |
| Connections | 1 |
| Rate limit | None |
| Request timeout | 30s |
| HTTP version | 1.1 |
| Keep-alive | true |
| Warmup requests per round (excluded from client statistics) | 50 |
| Access authentication | temporary-login |
| HTTP response counts | 200: 5,000 |


</details>

## Build & deployment

### Bundle size

| Format | Size (Median) |
| --- | --- |
| Raw | 5,076,039 bytes |
| Gzip | 2,341,931 bytes |


### Timing summary

| Phase | Mean | Mean 95% CI | Median |
| --- | --- | --- | --- |
| Build | 203.867 ms | [198.499, 210.733] ms | 197 ms |
| Upload | 8,592.333 ms | [8,469.325, 8,719.675] ms | 8,580 ms |
| Worker startup | 4.433 ms | [3.867, 5.133] ms | 4 ms |
| `cf deploy` | 14,963.854 ms | [14,848.516, 15,083.137] ms | 14,921.902 ms |


### Details

<details>
<summary>Show details</summary>


#### Deployment details

| Field | Value |
| --- | --- |
| Worker | void-perf-image-response-bare |
| Worker ID | 7ef22bfba71a4a76b924befcf34fa68d |
| Version ID | 082f7b52-2165-4ca7-97a9-c9bf3cd3139e |
| Origin | https://void-perf-image-response-bare.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing) | 7,764.651 ms |
| Final run workflow wall time (includes cleanup, lookup, Access) | 24,012.857 ms |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.



#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range |
| --- | --- | --- |
| Raw | 5,076,039 bytes | 5,076,039–5,076,039 bytes |
| Gzip | 2,341,931 bytes | 2,341,931–2,341,931 bytes |

Bundle-size variation: None observed.


#### Full timing statistics

| Phase | Valid / missing | Mean | Mean 95% CI | Median | Median 95% CI | Sample SD | IQR | Min–max | Mean CI half-width / mean | ±5% target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Build | 30 / 0 | 203.867 ms | [198.499, 210.733] ms | 197 ms | [194, 200.5] ms | 17.276 ms | 11 ms | 193–274 ms | 3% | Met |
| Upload | 30 / 0 | 8,592.333 ms | [8,469.325, 8,719.675] ms | 8,580 ms | [8,365, 8,720] ms | 354.008 ms | 472.5 ms | 8,110–9,410 ms | 1.46% | Met |
| Deploy triggers | 30 / 0 | 1,828.667 ms | [1,797.333, 1,865.333] ms | 1,805 ms | [1,785, 1,845] ms | 96.302 ms | 107.5 ms | 1,700–2,210 ms | 1.86% | Met |
| Worker startup | 30 / 0 | 4.433 ms | [3.867, 5.133] ms | 4 ms | [4, 4] ms | 1.813 ms | 0 ms | 3–12 ms | 14.29% | Not met |
| `cf deploy` | 30 / 0 | 14,963.854 ms | [14,848.516, 15,083.137] ms | 14,921.902 ms | [14,798.098, 15,121.613] ms | 330.744 ms | 431.828 ms | 14,402.698–15,765.508 ms | 0.78% | Met |
| Local preparation + cleanup | 30 / 0 | 7.013 ms | [6.404, 7.695] ms | 6.786 ms | [6.565, 7.014] ms | 1.844 ms | 0.801 ms | 3.833–12.372 ms | 9.21% | Not met |
| Worker lookup | 30 / 0 | 1,293.798 ms | [1,272.971, 1,318.444] ms | 1,290.379 ms | [1,267.458, 1,304.803] ms | 64.329 ms | 59.953 ms | 1,211.82–1,550.1 ms | 1.76% | Met |

#### Batch context

| Field | Value |
| --- | --- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0 |
| Batch start / finish (UTC) | 2026-11-17T03:51:41.000Z / 2026-11-17T03:59:56.717Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run | Outcome | Started (UTC) | Build | Upload | Deploy triggers | `cf deploy` | Raw / gzip | Version |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (first) | success | 2026-11-17T03:51:41.001Z | 197 ms | 8,800 ms | 1,800 ms | 15,101.418 ms | 5,076,039 bytes / 2,341,931 bytes | 46987cd4-cd16-4e87-9826-429eb5ee35c6 |
| 2 | success | 2026-11-17T03:51:57.317Z | 222 ms | 9,410 ms | 1,780 ms | 15,765.508 ms | 5,076,039 bytes / 2,341,931 bytes | a437ab2b-3995-4c59-9c17-3cce6f92d5d3 |
| 3 | success | 2026-11-17T03:52:14.370Z | 223 ms | 8,780 ms | 1,830 ms | 15,171.586 ms | 5,076,039 bytes / 2,341,931 bytes | 2bb8ab03-f115-4372-b017-60d0fb3f3e2f |
| 4 | success | 2026-11-17T03:52:30.866Z | 198 ms | 8,160 ms | 1,810 ms | 14,545.381 ms | 5,076,039 bytes / 2,341,931 bytes | ca43c46f-fe45-4942-9266-9ceb270d264d |
| 5 | success | 2026-11-17T03:52:46.660Z | 194 ms | 8,690 ms | 1,760 ms | 14,940.469 ms | 5,076,039 bytes / 2,341,931 bytes | 8ca3fa97-bac8-4aa2-83c8-f2703a4fbf37 |
| 6 | success | 2026-11-17T03:53:02.892Z | 193 ms | 8,610 ms | 1,930 ms | 15,093.711 ms | 5,076,039 bytes / 2,341,931 bytes | 2bf9bbc2-c8d3-43fd-abe0-4d07cbee342f |
| 7 | success | 2026-11-17T03:53:19.282Z | 193 ms | 9,060 ms | 1,720 ms | 15,210.033 ms | 5,076,039 bytes / 2,341,931 bytes | 04a09532-ee4e-4abb-b921-7748fbbb8a17 |
| 8 | success | 2026-11-17T03:53:35.791Z | 206 ms | 8,390 ms | 1,770 ms | 14,799.202 ms | 5,076,039 bytes / 2,341,931 bytes | 459034e9-981c-41a4-a8f7-2a9a219e2ed1 |
| 9 | success | 2026-11-17T03:53:51.943Z | 200 ms | 8,640 ms | 1,770 ms | 14,866.936 ms | 5,076,039 bytes / 2,341,931 bytes | 54cd5b44-ec68-4bec-bd5d-6af9df3c8ac1 |
| 10 | success | 2026-11-17T03:54:08.130Z | 195 ms | 8,250 ms | 1,830 ms | 14,585.933 ms | 5,076,039 bytes / 2,341,931 bytes | 1433181a-dda5-4d73-804b-317601deb107 |
| 11 | success | 2026-11-17T03:54:23.943Z | 233 ms | 9,070 ms | 1,780 ms | 15,318.928 ms | 5,076,039 bytes / 2,341,931 bytes | 51ef027f-b807-4c15-a2c8-eec09f2d4d1b |
| 12 | success | 2026-11-17T03:54:40.479Z | 201 ms | 8,920 ms | 1,700 ms | 15,165.486 ms | 5,076,039 bytes / 2,341,931 bytes | df7f4ed5-7477-408f-b096-b3e9413ed265 |
| 13 | success | 2026-11-17T03:54:56.869Z | 202 ms | 8,830 ms | 1,900 ms | 15,229.167 ms | 5,076,039 bytes / 2,341,931 bytes | 324eb08c-30b0-4ab8-848b-a9311922ee1d |
| 14 | success | 2026-11-17T03:55:13.412Z | 194 ms | 8,310 ms | 1,880 ms | 14,732.378 ms | 5,076,039 bytes / 2,341,931 bytes | 6ef0e6ee-1c90-4e63-9eb0-88760de18619 |
| 15 | success | 2026-11-17T03:55:29.451Z | 194 ms | 8,920 ms | 1,910 ms | 15,330.535 ms | 5,076,039 bytes / 2,341,931 bytes | e2a5184f-9e6d-44f3-bff9-f7837aa1cb17 |
| 16 | success | 2026-11-17T03:55:46.073Z | 194 ms | 8,130 ms | 1,790 ms | 14,436.751 ms | 5,076,039 bytes / 2,341,931 bytes | eb08e633-57e3-4ee7-985c-22a09882c2d8 |
| 17 | success | 2026-11-17T03:56:01.775Z | 194 ms | 8,550 ms | 2,210 ms | 15,295.295 ms | 5,076,039 bytes / 2,341,931 bytes | f06c48e7-e635-4b62-9a3c-ebefe4ab0537 |
| 18 | success | 2026-11-17T03:56:18.412Z | 194 ms | 8,680 ms | 1,810 ms | 14,937.623 ms | 5,076,039 bytes / 2,341,931 bytes | 67553ff9-46b1-48dd-91c1-0fe24f6f857c |
| 19 | success | 2026-11-17T03:56:34.726Z | 195 ms | 8,750 ms | 1,890 ms | 15,141.809 ms | 5,076,039 bytes / 2,341,931 bytes | edf8e64a-cf35-48f0-9db8-edd4db6d4b80 |
| 20 | success | 2026-11-17T03:56:51.143Z | 227 ms | 9,410 ms | 1,790 ms | 15,685.934 ms | 5,076,039 bytes / 2,341,931 bytes | 38fe37a8-6934-47a9-9fdb-bcd802f258ef |
| 21 | success | 2026-11-17T03:57:08.386Z | 194 ms | 8,280 ms | 1,840 ms | 14,667.85 ms | 5,076,039 bytes / 2,341,931 bytes | be5854e6-e101-49c1-ae15-7b863db38428 |
| 22 | success | 2026-11-17T03:57:24.316Z | 193 ms | 8,360 ms | 1,880 ms | 14,796.993 ms | 5,076,039 bytes / 2,341,931 bytes | 947e6375-4ce6-4005-a9f8-3dc2927c2393 |
| 23 | success | 2026-11-17T03:57:40.479Z | 194 ms | 8,110 ms | 1,740 ms | 14,402.698 ms | 5,076,039 bytes / 2,341,931 bytes | a18dea1c-1f39-4558-a4ed-d11f87a6c0f5 |
| 24 | success | 2026-11-17T03:57:56.192Z | 200 ms | 8,650 ms | 1,730 ms | 14,926.208 ms | 5,076,039 bytes / 2,341,931 bytes | 0a38e133-1afe-4027-bad8-a9e77230ff6b |
| 25 | success | 2026-11-17T03:58:12.365Z | 196 ms | 8,360 ms | 1,910 ms | 14,907.736 ms | 5,076,039 bytes / 2,341,931 bytes | 13b3a5f2-db7e-4833-9b88-12e19b939038 |
| 26 | success | 2026-11-17T03:58:28.608Z | 199 ms | 8,210 ms | 1,920 ms | 14,668.692 ms | 5,076,039 bytes / 2,341,931 bytes | cd007b3b-2b9c-4497-a9b7-5be846e16b4a |
| 27 | success | 2026-11-17T03:58:44.592Z | 274 ms | 8,380 ms | 1,850 ms | 14,851.604 ms | 5,076,039 bytes / 2,341,931 bytes | 8b50780f-c06e-408e-ba3d-5c49e6ff6fc7 |
| 28 | success | 2026-11-17T03:59:00.745Z | 197 ms | 8,370 ms | 1,790 ms | 14,755.799 ms | 5,076,039 bytes / 2,341,931 bytes | fc6ac19f-2290-4af6-aa73-79d0883c2533 |
| 29 | success | 2026-11-17T03:59:16.780Z | 206 ms | 8,270 ms | 1,800 ms | 14,666.362 ms | 5,076,039 bytes / 2,341,931 bytes | 24569bc2-5958-46ce-9041-547e711fafa0 |
| 30 | success | 2026-11-17T03:59:32.704Z | 214 ms | 8,420 ms | 1,740 ms | 14,917.596 ms | 5,076,039 bytes / 2,341,931 bytes | 082f7b52-2165-4ca7-97a9-c9bf3cd3139e |



</details>

## Latency workload summary

| Workload | URL | Mean | P50 | P95 |
| --- | --- | --- | --- | --- |
| baseline | https://void-perf-image-response-bare.cloudflare-internal-11e.workers.dev/ | 42.477 ms | 39.187 ms | 61.129 ms |
| render | https://void-perf-image-response-bare.cloudflare-internal-11e.workers.dev/run | 53.556 ms | 50.106 ms | 71.704 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency - baseline

Empty response with the minimal image renderer deployed

### Client latency

| Measurement | Value |
| --- | --- |
| Mean | 42.477 ms |
| Minimum | 25.37 ms |
| P50 | 39.187 ms |
| P95 | 61.129 ms |
| P99 | 91.51 ms |
| Maximum | 1,517.031 ms |
| Throughput | 23.528 req/s |
| Measured duration | 212.514 s |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
| Mean | 42.477 ms | [40.05, 45.444] ms | 6.35% | Not met |
| P50 | 39.187 ms | [37.518, 41.892] ms | 5.58% | Not met |
| P95 | 61.129 ms | [54.095, 68.917] ms | 12.12% | Not met |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
| 1 | success | 500 | 2026-11-17T04:00:08.864Z |
| 2 | success | 500 | 2026-11-17T04:00:31.752Z |
| 3 | success | 500 | 2026-11-17T04:00:52.645Z |
| 4 | success | 500 | 2026-11-17T04:01:17.276Z |
| 5 | success | 500 | 2026-11-17T04:01:41.370Z |
| 6 | success | 500 | 2026-11-17T04:02:03.757Z |
| 7 | success | 500 | 2026-11-17T04:02:28.685Z |
| 8 | success | 500 | 2026-11-17T04:02:58.078Z |
| 9 | success | 500 | 2026-11-17T04:03:22.050Z |
| 10 | success | 500 | 2026-11-17T04:03:44.757Z |


Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| 5,497 | 0 | 0 |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
| CPU | 404 µs | 653 µs | 1,585 µs | 5,054 µs |
| Wall time | 996 µs | 1,667 µs | 3,111 µs | 8,555 µs |
| Isolate memory | 5.673 MiB | 6.423 MiB | 6.673 MiB | 6.673 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field | Value |
| --- | --- |
| Measurement start (UTC) | 2026-11-17T04:00:04.519Z |
| Measurement end (UTC) | 2026-11-17T04:04:04.814Z |
| Query start, inclusive (UTC) | 2026-11-17T03:58:34.000Z |
| Query end, inclusive (UTC) | 2026-11-17T04:05:35.000Z |
| Padding per side | 90 s |
| Ingestion wait after query end | 180 s |
| Retry interval | 10 s |
| Quiet-window checks / result queries | 1 / 1 |

##### Worker metrics methodology

CPU is time actively executing code, excluding time waiting on I/O. Wall time is the lifetime of the invocation's JavaScript context, including I/O waits and `waitUntil()` work; it is not client response latency. Memory is shared isolate usage at invocation time, not per-request allocation or peak memory. An isolate can serve concurrent requests.

CPU and wall-time quantiles are returned in microseconds; memory is returned in bytes and displayed in MiB (1 MiB = 1,048,576 bytes). These percentiles use reservoir sampling. P50 is the median; P90, P99, and P99.9 describe the corresponding upper percentiles.

Sources: [Cloudflare metric definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), and [GraphQL field descriptions (public schema mirror)](https://pages.johnspurlock.com/graphql-schema-docs/cloudflare.html#AccountWorkersInvocationsAdaptiveQuantiles).

Analytics are aggregated/sampled across the whole Worker and padded window, not filtered by route or version. An empty preflight check is best-effort: ingestion delays can hide recent traffic. Avoid unrelated traffic; counts need not match oha exactly.
The analytics window spans all latency rounds, including warmup requests and inter-round gaps. Worker CPU/wall-time/memory percentiles therefore include warmup traffic and have no round-bootstrap confidence intervals.

</details>

## Latency - render

Generate a fixed 64 × 64 orange PNG

### Client latency

| Measurement | Value |
| --- | --- |
| Mean | 53.556 ms |
| Minimum | 33.282 ms |
| P50 | 50.106 ms |
| P95 | 71.704 ms |
| P99 | 111.615 ms |
| Maximum | 1,245.402 ms |
| Throughput | 18.662 req/s |
| Measured duration | 267.924 s |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
| Mean | 53.556 ms | [52.753, 54.378] ms | 1.52% | Met |
| P50 | 50.106 ms | [49.452, 50.765] ms | 1.31% | Met |
| P95 | 71.704 ms | [69.131, 74.676] ms | 3.87% | Met |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
| 1 | success | 500 | 2026-11-17T04:08:46.193Z |
| 2 | success | 500 | 2026-11-17T04:09:15.388Z |
| 3 | success | 500 | 2026-11-17T04:09:45.550Z |
| 4 | success | 500 | 2026-11-17T04:10:15.884Z |
| 5 | success | 500 | 2026-11-17T04:10:45.712Z |
| 6 | success | 500 | 2026-11-17T04:11:14.458Z |
| 7 | success | 500 | 2026-11-17T04:11:43.847Z |
| 8 | success | 500 | 2026-11-17T04:12:12.853Z |
| 9 | success | 500 | 2026-11-17T04:12:43.051Z |
| 10 | success | 500 | 2026-11-17T04:13:12.961Z |


Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| 5,543 | 0 | 0 |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
| CPU | 1,961 µs | 3,173 µs | 5,030 µs | 8,779 µs |
| Wall time | 2,691 µs | 4,427 µs | 7,294 µs | 15,791 µs |
| Isolate memory | 13.963 MiB | 14.964 MiB | 15.715 MiB | 16.213 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field | Value |
| --- | --- |
| Measurement start (UTC) | 2026-11-17T04:08:42.694Z |
| Measurement end (UTC) | 2026-11-17T04:13:41.231Z |
| Query start, inclusive (UTC) | 2026-11-17T04:07:12.000Z |
| Query end, inclusive (UTC) | 2026-11-17T04:15:12.000Z |
| Padding per side | 90 s |
| Ingestion wait after query end | 180 s |
| Retry interval | 10 s |
| Quiet-window checks / result queries | 1 / 1 |

##### Worker metrics methodology

CPU is time actively executing code, excluding time waiting on I/O. Wall time is the lifetime of the invocation's JavaScript context, including I/O waits and `waitUntil()` work; it is not client response latency. Memory is shared isolate usage at invocation time, not per-request allocation or peak memory. An isolate can serve concurrent requests.

CPU and wall-time quantiles are returned in microseconds; memory is returned in bytes and displayed in MiB (1 MiB = 1,048,576 bytes). These percentiles use reservoir sampling. P50 is the median; P90, P99, and P99.9 describe the corresponding upper percentiles.

Sources: [Cloudflare metric definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), and [GraphQL field descriptions (public schema mirror)](https://pages.johnspurlock.com/graphql-schema-docs/cloudflare.html#AccountWorkersInvocationsAdaptiveQuantiles).

Analytics are aggregated/sampled across the whole Worker and padded window, not filtered by route or version. An empty preflight check is best-effort: ingestion delays can hide recent traffic. Avoid unrelated traffic; counts need not match oha exactly.
The analytics window spans all latency rounds, including warmup requests and inter-round gaps. Worker CPU/wall-time/memory percentiles therefore include warmup traffic and have no round-bootstrap confidence intervals.

</details>
