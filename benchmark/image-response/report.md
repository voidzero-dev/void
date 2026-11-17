# image-response benchmark report

Successful run: **2026-11-17T06:59:17.908Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context
 
| Field | Value |
| --- | --- |
| Run started (UTC) | 2026-11-17T06:04:00.273Z |
| Run finished (UTC) | 2026-11-17T06:59:17.908Z |
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
| URL | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/ |
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

### small-image


| Field | Value |
| --- | --- |
| URL | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/run?width=64&height=64 |
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

### og-image


| Field | Value |
| --- | --- |
| URL | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/run?width=1200&height=630 |
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

### emoji-image


| Field | Value |
| --- | --- |
| URL | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/run?width=1200&height=630&text=Hello%20%F0%9F%91%8B%20%F0%9F%8C%8D%20%F0%9F%9A%80&emoji=twemoji |
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
| Raw | 5,077,982 bytes |
| Gzip | 2,342,532 bytes |


### Timing summary

| Phase | Mean | Mean 95% CI | Median |
| --- | --- | --- | --- |
| Build | 211.167 ms | [204.3, 219.6] ms | 203.5 ms |
| Upload | 8,795.667 ms | [8,653.992, 8,960.342] ms | 8,735 ms |
| Worker startup | 5.4 ms | [4.333, 6.7] ms | 4 ms |
| `cf deploy` | 15,283.349 ms | [15,076.338, 15,523.757] ms | 15,123.016 ms |


### Details

<details>
<summary>Show details</summary>


#### Deployment details

| Field | Value |
| --- | --- |
| Worker | void-perf-image-response |
| Worker ID | ef02bb4ab3844007bb3fc155a87e3178 |
| Version ID | 90aebd3f-3290-492a-b0e4-fed7a0b8a759 |
| Origin | https://void-perf-image-response.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing) | 2,722.095 ms |
| Final run workflow wall time (includes cleanup, lookup, Access) | 19,323.068 ms |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.



#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range |
| --- | --- | --- |
| Raw | 5,077,982 bytes | 5,077,982–5,077,982 bytes |
| Gzip | 2,342,532 bytes | 2,342,532–2,342,532 bytes |

Bundle-size variation: None observed.


#### Full timing statistics

| Phase | Valid / missing | Mean | Mean 95% CI | Median | Median 95% CI | Sample SD | IQR | Min–max | Mean CI half-width / mean | ±5% target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Build | 30 / 0 | 211.167 ms | [204.3, 219.6] ms | 203.5 ms | [197, 217] ms | 21.675 ms | 28.75 ms | 194–300 ms | 3.62% | Met |
| Upload | 30 / 0 | 8,795.667 ms | [8,653.992, 8,960.342] ms | 8,735 ms | [8,570, 8,875] ms | 433.173 ms | 482.5 ms | 8,290–10,370 ms | 1.74% | Met |
| Deploy triggers | 30 / 0 | 1,876.667 ms | [1,845.667, 1,907.333] ms | 1,865 ms | [1,830, 1,905] ms | 86.556 ms | 120 ms | 1,720–2,050 ms | 1.64% | Met |
| Worker startup | 30 / 0 | 5.4 ms | [4.333, 6.7] ms | 4 ms | [3.5, 5.5] ms | 3.338 ms | 3 ms | 3–18 ms | 21.91% | Not met |
| `cf deploy` | 30 / 0 | 15,283.349 ms | [15,076.338, 15,523.757] ms | 15,123.016 ms | [14,996.439, 15,256.868] ms | 634.015 ms | 601.983 ms | 14,531.391–17,444.573 ms | 1.46% | Met |
| Local preparation + cleanup | 30 / 0 | 9.639 ms | [8.944, 10.299] ms | 10.017 ms | [8.707, 10.694] ms | 1.918 ms | 2.764 ms | 5.799–13.573 ms | 7.03% | Not met |
| Worker lookup | 30 / 0 | 1,363.836 ms | [1,315.61, 1,440.693] ms | 1,318.165 ms | [1,304.557, 1,336.893] ms | 186.99 ms | 76.449 ms | 1,245.179–2,302.653 ms | 4.59% | Met |

#### Batch context

| Field | Value |
| --- | --- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0 |
| Batch start / finish (UTC) | 2026-11-17T06:04:00.717Z / 2026-11-17T06:12:23.177Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run | Outcome | Started (UTC) | Build | Upload | Deploy triggers | `cf deploy` | Raw / gzip | Version |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (first) | success | 2026-11-17T06:04:00.718Z | 197 ms | 9,060 ms | 2,010 ms | 15,925.148 ms | 5,077,982 bytes / 2,342,532 bytes | c33b7294-e336-46e4-9063-bb77e1d7e908 |
| 2 | success | 2026-11-17T06:04:18.074Z | 196 ms | 8,900 ms | 1,820 ms | 15,201.929 ms | 5,077,982 bytes / 2,342,532 bytes | 8b77389c-cf6f-4205-a567-cfc68b1e33d2 |
| 3 | success | 2026-11-17T06:04:34.602Z | 196 ms | 8,540 ms | 1,950 ms | 15,099.509 ms | 5,077,982 bytes / 2,342,532 bytes | 93cd598e-18ec-4f92-8c46-46aa310cf5a3 |
| 4 | success | 2026-11-17T06:04:51.016Z | 227 ms | 9,010 ms | 1,990 ms | 17,444.573 ms | 5,077,982 bytes / 2,342,532 bytes | 0cf2804e-cab7-4a70-be65-8b5c4c07209c |
| 5 | success | 2026-11-17T06:05:09.776Z | 231 ms | 8,850 ms | 1,970 ms | 15,392.676 ms | 5,077,982 bytes / 2,342,532 bytes | 265aef77-0653-4607-b685-ca29f71057e8 |
| 6 | success | 2026-11-17T06:05:26.456Z | 225 ms | 8,500 ms | 1,820 ms | 14,849.727 ms | 5,077,982 bytes / 2,342,532 bytes | 001c102e-f324-4f00-9a98-13696f900d00 |
| 7 | success | 2026-11-17T06:05:42.659Z | 195 ms | 8,740 ms | 1,980 ms | 15,254.697 ms | 5,077,982 bytes / 2,342,532 bytes | cb594869-61b9-4002-b545-3ce7d16cc5cf |
| 8 | success | 2026-11-17T06:05:59.213Z | 198 ms | 8,680 ms | 1,910 ms | 15,211.937 ms | 5,077,982 bytes / 2,342,532 bytes | 56cd2bba-9aa3-4cfa-ab23-ea43745bb893 |
| 9 | success | 2026-11-17T06:06:15.781Z | 197 ms | 10,370 ms | 1,900 ms | 16,748.958 ms | 5,077,982 bytes / 2,342,532 bytes | 44bee191-1491-4758-b2da-27e26f51bf9c |
| 10 | success | 2026-11-17T06:06:33.823Z | 211 ms | 8,380 ms | 1,720 ms | 14,531.391 ms | 5,077,982 bytes / 2,342,532 bytes | 328adac2-d10f-4eae-9489-8b29b5e4283f |
| 11 | success | 2026-11-17T06:06:49.639Z | 198 ms | 9,300 ms | 1,830 ms | 15,633.723 ms | 5,077,982 bytes / 2,342,532 bytes | cb7e53be-ad40-4bd7-8923-0e94d128346e |
| 12 | success | 2026-11-17T06:07:06.591Z | 195 ms | 9,010 ms | 1,870 ms | 15,487.738 ms | 5,077,982 bytes / 2,342,532 bytes | cfd6e2ea-8e69-4920-b480-7487c8fff539 |
| 13 | success | 2026-11-17T06:07:23.405Z | 204 ms | 8,380 ms | 1,800 ms | 14,734.591 ms | 5,077,982 bytes / 2,342,532 bytes | 166da198-52b9-486a-a3d8-049d58d16887 |
| 14 | success | 2026-11-17T06:07:39.484Z | 219 ms | 8,730 ms | 1,900 ms | 15,107.439 ms | 5,077,982 bytes / 2,342,532 bytes | 368b1af0-defe-464c-944f-5faa679a11ac |
| 15 | success | 2026-11-17T06:07:55.936Z | 195 ms | 8,600 ms | 1,910 ms | 14,950.453 ms | 5,077,982 bytes / 2,342,532 bytes | 7b39af8c-ebdd-4005-9d63-f41fa39aa3dc |
| 16 | success | 2026-11-17T06:08:12.159Z | 196 ms | 8,780 ms | 1,840 ms | 15,096.873 ms | 5,077,982 bytes / 2,342,532 bytes | 4f48fef2-2704-487d-9158-d4e920f5ca9a |
| 17 | success | 2026-11-17T06:08:28.585Z | 194 ms | 8,850 ms | 1,890 ms | 15,246.338 ms | 5,077,982 bytes / 2,342,532 bytes | d96c7e2a-b2a0-47b4-89d5-ffb12eada4a0 |
| 18 | success | 2026-11-17T06:08:45.109Z | 197 ms | 8,450 ms | 1,830 ms | 14,709.473 ms | 5,077,982 bytes / 2,342,532 bytes | e35db400-06be-4e84-9a16-aa87d9aa6762 |
| 19 | success | 2026-11-17T06:09:01.106Z | 207 ms | 8,910 ms | 1,990 ms | 15,494.859 ms | 5,077,982 bytes / 2,342,532 bytes | 013babfd-b460-4e6f-bd58-f285860e859e |
| 20 | success | 2026-11-17T06:09:17.950Z | 215 ms | 8,360 ms | 1,820 ms | 14,785.209 ms | 5,077,982 bytes / 2,342,532 bytes | 0f5bd827-a576-4165-84b0-750f06aa7589 |
| 21 | success | 2026-11-17T06:09:34.078Z | 228 ms | 8,630 ms | 1,880 ms | 15,138.593 ms | 5,077,982 bytes / 2,342,532 bytes | 97b9e815-e383-4f42-8b58-6238685adc2c |
| 22 | success | 2026-11-17T06:09:50.642Z | 227 ms | 9,390 ms | 2,000 ms | 15,930.191 ms | 5,077,982 bytes / 2,342,532 bytes | 47b00990-3b7d-46af-ba82-6cebf7f20071 |
| 23 | success | 2026-11-17T06:10:08.034Z | 204 ms | 9,470 ms | 2,050 ms | 16,100.225 ms | 5,077,982 bytes / 2,342,532 bytes | 26631906-c30c-42f6-9af3-e65fa51f0665 |
| 24 | success | 2026-11-17T06:10:25.515Z | 198 ms | 8,510 ms | 1,860 ms | 14,803.318 ms | 5,077,982 bytes / 2,342,532 bytes | 110f4d8f-1e83-45ff-b8b3-e8e63fe1ec59 |
| 25 | success | 2026-11-17T06:10:41.623Z | 225 ms | 8,400 ms | 1,850 ms | 14,728.631 ms | 5,077,982 bytes / 2,342,532 bytes | 2b77e763-b37f-4027-acc6-1fd78a6d9a17 |
| 26 | success | 2026-11-17T06:10:57.609Z | 226 ms | 9,020 ms | 1,830 ms | 15,259.039 ms | 5,077,982 bytes / 2,342,532 bytes | b3674a59-4a9d-426a-a6a5-696704b902f5 |
| 27 | success | 2026-11-17T06:11:15.180Z | 196 ms | 8,640 ms | 1,820 ms | 14,898.775 ms | 5,077,982 bytes / 2,342,532 bytes | 10139e53-a786-47a6-bbbf-fc4e744911c9 |
| 28 | success | 2026-11-17T06:11:31.400Z | 300 ms | 8,300 ms | 1,790 ms | 15,042.426 ms | 5,077,982 bytes / 2,342,532 bytes | 9b1de0af-dbf3-4d87-9aa0-f4c54eb28bbb |
| 29 | success | 2026-11-17T06:11:47.838Z | 203 ms | 8,290 ms | 1,750 ms | 14,606.166 ms | 5,077,982 bytes / 2,342,532 bytes | d3057fbe-d14c-40d9-ae30-6bfd301ec663 |
| 30 | success | 2026-11-17T06:12:03.853Z | 235 ms | 8,820 ms | 1,720 ms | 15,085.874 ms | 5,077,982 bytes / 2,342,532 bytes | 90aebd3f-3290-492a-b0e4-fed7a0b8a759 |



</details>

## Latency workload summary

| Workload | URL | Mean | P50 | P95 |
| --- | --- | --- | --- | --- |
| baseline | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/ | 50.328 ms | 46.008 ms | 77.235 ms |
| small-image | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/run?width=64&height=64 | 65.315 ms | 60.356 ms | 93.155 ms |
| og-image | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/run?width=1200&height=630 | 81.367 ms | 76.305 ms | 112.691 ms |
| emoji-image | https://void-perf-image-response.cloudflare-internal-11e.workers.dev/run?width=1200&height=630&text=Hello%20%F0%9F%91%8B%20%F0%9F%8C%8D%20%F0%9F%9A%80&emoji=twemoji | 107.919 ms | 102.757 ms | 147.950 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency - baseline

Empty response with image code present in the deployment

### Client latency

| Measurement | Value |
| --- | --- |
| Mean | 50.328 ms |
| Minimum | 26.783 ms |
| P50 | 46.008 ms |
| P95 | 77.235 ms |
| P99 | 125.645 ms |
| Maximum | 936.569 ms |
| Throughput | 19.858 req/s |
| Measured duration | 251.783 s |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
| Mean | 50.328 ms | [48.837, 51.787] ms | 2.93% | Met |
| P50 | 46.008 ms | [44.935, 47.007] ms | 2.25% | Met |
| P95 | 77.235 ms | [74.168, 81.897] ms | 5% | Not met |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
| 1 | success | 500 | 2026-11-17T06:12:32.688Z |
| 2 | success | 500 | 2026-11-17T06:13:00.313Z |
| 3 | success | 500 | 2026-11-17T06:13:28.532Z |
| 4 | success | 500 | 2026-11-17T06:13:58.711Z |
| 5 | success | 500 | 2026-11-17T06:14:27.355Z |
| 6 | success | 500 | 2026-11-17T06:14:54.860Z |
| 7 | success | 500 | 2026-11-17T06:15:24.443Z |
| 8 | success | 500 | 2026-11-17T06:15:53.229Z |
| 9 | success | 500 | 2026-11-17T06:16:20.847Z |
| 10 | success | 500 | 2026-11-17T06:16:46.687Z |


Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| 5,340 | 0 | 0 |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
| CPU | 446 µs | 833 µs | 1,832 µs | 5,053 µs |
| Wall time | 1,110 µs | 1,981 µs | 3,883 µs | 9,128 µs |
| Isolate memory | 5.427 MiB | 6.427 MiB | 6.927 MiB | 6.927 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field | Value |
| --- | --- |
| Measurement start (UTC) | 2026-11-17T06:12:29.665Z |
| Measurement end (UTC) | 2026-11-17T06:17:11.164Z |
| Query start, inclusive (UTC) | 2026-11-17T06:10:59.000Z |
| Query end, inclusive (UTC) | 2026-11-17T06:18:42.000Z |
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

## Latency - small-image

Generate a 64 × 64 PNG

### Client latency

| Measurement | Value |
| --- | --- |
| Mean | 65.315 ms |
| Minimum | 39.368 ms |
| P50 | 60.356 ms |
| P95 | 93.155 ms |
| P99 | 136.818 ms |
| Maximum | 1,539.108 ms |
| Throughput | 15.303 req/s |
| Measured duration | 326.73 s |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
| Mean | 65.315 ms | [64.106, 66.688] ms | 1.98% | Met |
| P50 | 60.356 ms | [59.391, 61.632] ms | 1.86% | Met |
| P95 | 93.155 ms | [91.025, 94.92] ms | 2.09% | Met |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
| 1 | success | 500 | 2026-11-17T06:21:52.956Z |
| 2 | success | 500 | 2026-11-17T06:22:30.985Z |
| 3 | success | 500 | 2026-11-17T06:23:08.111Z |
| 4 | success | 500 | 2026-11-17T06:23:44.733Z |
| 5 | success | 500 | 2026-11-17T06:24:19.791Z |
| 6 | success | 500 | 2026-11-17T06:24:56.290Z |
| 7 | success | 500 | 2026-11-17T06:25:33.433Z |
| 8 | success | 500 | 2026-11-17T06:26:10.036Z |
| 9 | success | 500 | 2026-11-17T06:26:48.068Z |
| 10 | success | 500 | 2026-11-17T06:27:23.982Z |


Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| 5,499 | 0 | 0 |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
| CPU | 2,984 µs | 5,077 µs | 7,813 µs | 11,758 µs |
| Wall time | 3,932 µs | 7,033 µs | 11,751 µs | 35,738 µs |
| Isolate memory | 13.967 MiB | 14.719 MiB | 15.22 MiB | 15.97 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field | Value |
| --- | --- |
| Measurement start (UTC) | 2026-11-17T06:21:49.204Z |
| Measurement end (UTC) | 2026-11-17T06:27:55.439Z |
| Query start, inclusive (UTC) | 2026-11-17T06:20:19.000Z |
| Query end, inclusive (UTC) | 2026-11-17T06:29:26.000Z |
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

## Latency - og-image

Generate a 1200 × 630 Open Graph PNG

### Client latency

| Measurement | Value |
| --- | --- |
| Mean | 81.367 ms |
| Minimum | 50.248 ms |
| P50 | 76.305 ms |
| P95 | 112.691 ms |
| P99 | 168.154 ms |
| Maximum | 1,484.766 ms |
| Throughput | 12.285 req/s |
| Measured duration | 407.007 s |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
| Mean | 81.367 ms | [80.155, 82.643] ms | 1.53% | Met |
| P50 | 76.305 ms | [75.079, 77.696] ms | 1.71% | Met |
| P95 | 112.691 ms | [110.13, 116.131] ms | 2.66% | Met |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
| 1 | success | 500 | 2026-11-17T06:32:38.926Z |
| 2 | success | 500 | 2026-11-17T06:33:26.664Z |
| 3 | success | 500 | 2026-11-17T06:34:12.640Z |
| 4 | success | 500 | 2026-11-17T06:34:58.243Z |
| 5 | success | 500 | 2026-11-17T06:35:44.357Z |
| 6 | success | 500 | 2026-11-17T06:36:28.449Z |
| 7 | success | 500 | 2026-11-17T06:37:12.784Z |
| 8 | success | 500 | 2026-11-17T06:37:57.673Z |
| 9 | success | 500 | 2026-11-17T06:38:41.573Z |
| 10 | success | 500 | 2026-11-17T06:39:27.362Z |


Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| 5,500 | 0 | 0 |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
| CPU | 16,137 µs | 26,801 µs | 33,733 µs | 41,315 µs |
| Wall time | 17,531 µs | 29,541 µs | 38,438 µs | 52,201 µs |
| Isolate memory | 16.715 MiB | 17.465 MiB | 18.22 MiB | 18.715 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field | Value |
| --- | --- |
| Measurement start (UTC) | 2026-11-17T06:32:33.156Z |
| Measurement end (UTC) | 2026-11-17T06:40:07.139Z |
| Query start, inclusive (UTC) | 2026-11-17T06:31:03.000Z |
| Query end, inclusive (UTC) | 2026-11-17T06:41:38.000Z |
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

## Latency - emoji-image

Generate a 1200 × 630 PNG with Hello 👋 🌍 🚀 using Twemoji

### Client latency

| Measurement | Value |
| --- | --- |
| Mean | 107.919 ms |
| Minimum | 68.133 ms |
| P50 | 102.757 ms |
| P95 | 147.95 ms |
| P99 | 192.632 ms |
| Maximum | 1,287.151 ms |
| Throughput | 9.264 req/s |
| Measured duration | 539.751 s |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
| Mean | 107.919 ms | [104.102, 112.743] ms | 4% | Met |
| P50 | 102.757 ms | [99.109, 107.118] ms | 3.9% | Met |
| P95 | 147.95 ms | [137.939, 154.499] ms | 5.6% | Not met |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
| 1 | success | 500 | 2026-11-17T06:44:51.921Z |
| 2 | success | 500 | 2026-11-17T06:45:58.907Z |
| 3 | success | 500 | 2026-11-17T06:46:56.738Z |
| 4 | success | 500 | 2026-11-17T06:47:55.984Z |
| 5 | success | 500 | 2026-11-17T06:48:56.396Z |
| 6 | success | 500 | 2026-11-17T06:49:54.647Z |
| 7 | success | 500 | 2026-11-17T06:50:52.754Z |
| 8 | success | 500 | 2026-11-17T06:51:49.811Z |
| 9 | success | 500 | 2026-11-17T06:52:46.560Z |
| 10 | success | 500 | 2026-11-17T06:53:45.966Z |


Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| 5,499 | 0 | 3 |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
| CPU | 32,814 µs | 54,208 µs | 65,703 µs | 78,241 µs |
| Wall time | 34,667 µs | 57,758 µs | 73,909 µs | 92,433 µs |
| Isolate memory | 16.709 MiB | 17.366 MiB | 17.877 MiB | 18.387 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field | Value |
| --- | --- |
| Measurement start (UTC) | 2026-11-17T06:44:45.543Z |
| Measurement end (UTC) | 2026-11-17T06:54:46.197Z |
| Query start, inclusive (UTC) | 2026-11-17T06:43:15.000Z |
| Query end, inclusive (UTC) | 2026-11-17T06:56:17.000Z |
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
