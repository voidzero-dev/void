# baseline-workers benchmark report

Successful run: **2026-11-17T03:04:55.867Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context
 
| Field | Value |
| --- | --- |
| Run started (UTC) | 2026-11-17T02:52:00.397Z |
| Run finished (UTC) | 2026-11-17T03:04:55.867Z |
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


### latency


| Field | Value |
| --- | --- |
| URL | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev/ |
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
| Raw | 187 bytes |
| Gzip | 161 bytes |


### Timing summary

| Phase | Mean | Mean 95% CI | Median |
| --- | --- | --- | --- |
| Build | 8.833 ms | [8.533, 9.133] ms | 9 ms |
| Upload | 4,930.333 ms | [4,613, 5,157] ms | 5,095 ms |
| Worker startup | 2.167 ms | [1.767, 2.6] ms | 2 ms |
| `cf deploy` | 8,411.52 ms | [8,004.325, 8,703.58] ms | 8,604.935 ms |


### Details

<details>
<summary>Show details</summary>


#### Deployment details

| Field | Value |
| --- | --- |
| Worker | void-perf-baseline-workers |
| Worker ID | 4f1d26c4641a43588ec1eb090de69ae0 |
| Version ID | 2b10aa01-dc36-4b6d-beb5-6385ba47697b |
| Origin | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing) | 2,953.764 ms |
| Final run workflow wall time (includes cleanup, lookup, Access) | 13,056.736 ms |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.



#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range |
| --- | --- | --- |
| Raw | 187 bytes | 187–187 bytes |
| Gzip | 161 bytes | 161–161 bytes |

Bundle-size variation: None observed.


#### Full timing statistics

| Phase | Valid / missing | Mean | Mean 95% CI | Median | Median 95% CI | Sample SD | IQR | Min–max | Mean CI half-width / mean | ±5% target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Build | 30 / 0 | 8.833 ms | [8.533, 9.133] ms | 9 ms | [9, 9] ms | 0.834 ms | 0.75 ms | 7–11 ms | 3.4% | Met |
| Upload | 30 / 0 | 4,930.333 ms | [4,613, 5,157] ms | 5,095 ms | [4,995, 5,160] ms | 788.742 ms | 252.5 ms | 2,010–5,650 ms | 5.52% | Not met |
| Deploy triggers | 30 / 0 | 1,795.333 ms | [1,704.992, 1,855.333] ms | 1,820 ms | [1,790, 1,850] ms | 223.634 ms | 87.5 ms | 690–2,100 ms | 4.19% | Met |
| Worker startup | 30 / 0 | 2.167 ms | [1.767, 2.6] ms | 2 ms | [1.5, 2.5] ms | 1.177 ms | 2 ms | 1–6 ms | 19.23% | Not met |
| `cf deploy` | 30 / 0 | 8,411.52 ms | [8,004.325, 8,703.58] ms | 8,604.935 ms | [8,530.238, 8,766.785] ms | 1,011.409 ms | 355.61 ms | 4,478.936–9,091.123 ms | 4.16% | Met |
| Local preparation + cleanup | 30 / 0 | 1.376 ms | [1.309, 1.433] ms | 1.407 ms | [1.347, 1.433] ms | 0.177 ms | 0.121 ms | 0.731–1.718 ms | 4.52% | Met |
| Worker lookup | 30 / 0 | 1,325.029 ms | [1,286.596, 1,369.92] ms | 1,296.716 ms | [1,278.732, 1,312.573] ms | 119.078 ms | 72.101 ms | 1,157.156–1,718.386 ms | 3.14% | Met |

#### Batch context

| Field | Value |
| --- | --- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0 |
| Batch start / finish (UTC) | 2026-11-17T02:52:00.824Z / 2026-11-17T02:56:55.942Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run | Outcome | Started (UTC) | Build | Upload | Deploy triggers | `cf deploy` | Raw / gzip | Version |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (first) | success | 2026-11-17T02:52:00.825Z | 8 ms | 5,320 ms | 1,880 ms | 8,977.62 ms | 187 bytes / 161 bytes | dcc618a1-85c6-4127-b2ba-9008dddc3218 |
| 2 | success | 2026-11-17T02:52:11.129Z | 8 ms | 2,190 ms | 1,860 ms | 5,101.934 ms | 187 bytes / 161 bytes | b4bae9d1-6d59-4fe5-9d88-93c1c2db3aff |
| 3 | success | 2026-11-17T02:52:17.491Z | 9 ms | 2,010 ms | 690 ms | 4,478.936 ms | 187 bytes / 161 bytes | fb0aad4a-7051-4192-b992-a35cf26cf65c |
| 4 | success | 2026-11-17T02:52:23.270Z | 9 ms | 5,110 ms | 1,820 ms | 8,672.192 ms | 187 bytes / 161 bytes | e2a781b9-0371-4e2b-9f87-2171029142e2 |
| 5 | success | 2026-11-17T02:52:33.516Z | 9 ms | 5,130 ms | 1,770 ms | 8,595.575 ms | 187 bytes / 161 bytes | 38da602a-04f1-43c7-89c0-d45e51a5817b |
| 6 | success | 2026-11-17T02:52:43.409Z | 9 ms | 4,990 ms | 1,720 ms | 8,454.532 ms | 187 bytes / 161 bytes | eac65b13-3e20-41c6-8ce5-eebdce329da5 |
| 7 | success | 2026-11-17T02:52:53.350Z | 9 ms | 5,460 ms | 1,920 ms | 9,091.123 ms | 187 bytes / 161 bytes | 3b2c4f2e-98cc-4721-8fb2-d3aa558e791d |
| 8 | success | 2026-11-17T02:53:03.679Z | 10 ms | 5,050 ms | 1,830 ms | 8,600.596 ms | 187 bytes / 161 bytes | 457e558e-af0a-41b8-a39a-a9467df1578e |
| 9 | success | 2026-11-17T02:53:13.493Z | 9 ms | 5,240 ms | 1,850 ms | 8,801.463 ms | 187 bytes / 161 bytes | 5be7bafa-a108-438e-8d68-c0d37d5029fd |
| 10 | success | 2026-11-17T02:53:23.888Z | 9 ms | 5,120 ms | 1,880 ms | 8,823.873 ms | 187 bytes / 161 bytes | ffaa62a4-ced8-4f7d-a5c5-aa714a6fc178 |
| 11 | success | 2026-11-17T02:53:34.048Z | 8 ms | 4,980 ms | 1,860 ms | 8,609.274 ms | 187 bytes / 161 bytes | 335f6178-5a52-4eb4-a828-dc067c7d6cf6 |
| 12 | success | 2026-11-17T02:53:43.906Z | 9 ms | 4,950 ms | 1,770 ms | 8,418.072 ms | 187 bytes / 161 bytes | 163da4ab-2b06-445b-8651-aef91d12d76c |
| 13 | success | 2026-11-17T02:53:53.622Z | 10 ms | 5,000 ms | 1,790 ms | 8,562.075 ms | 187 bytes / 161 bytes | 35679c23-e027-4b09-a51d-cfad8304bd3b |
| 14 | success | 2026-11-17T02:54:03.481Z | 9 ms | 5,290 ms | 1,800 ms | 8,886.919 ms | 187 bytes / 161 bytes | acdd97af-6a8b-4ab9-8b1a-c8799e74062b |
| 15 | success | 2026-11-17T02:54:13.730Z | 9 ms | 4,990 ms | 1,750 ms | 8,421.29 ms | 187 bytes / 161 bytes | bdbb69b6-ee02-40ce-afcb-9251029dae49 |
| 16 | success | 2026-11-17T02:54:23.310Z | 8 ms | 4,960 ms | 1,740 ms | 8,315.405 ms | 187 bytes / 161 bytes | c7240413-2064-4254-88b9-9ddb0bb8dcf2 |
| 17 | success | 2026-11-17T02:54:32.920Z | 9 ms | 5,170 ms | 2,000 ms | 8,903.633 ms | 187 bytes / 161 bytes | 9d43aa20-7011-4bc3-b9e2-14fe7699bcbf |
| 18 | success | 2026-11-17T02:54:43.544Z | 11 ms | 5,150 ms | 1,750 ms | 8,651.868 ms | 187 bytes / 161 bytes | 06319d99-f4ef-4e31-884e-724e694068ab |
| 19 | success | 2026-11-17T02:54:53.460Z | 9 ms | 5,290 ms | 2,100 ms | 9,029.032 ms | 187 bytes / 161 bytes | bb6e9095-24ff-4494-83b6-737bd687ac3e |
| 20 | success | 2026-11-17T02:55:03.739Z | 7 ms | 4,900 ms | 1,740 ms | 8,286.382 ms | 187 bytes / 161 bytes | ef75bf78-3887-41cd-9e1b-8547d7dbb6d3 |
| 21 | success | 2026-11-17T02:55:13.367Z | 9 ms | 5,080 ms | 1,810 ms | 8,558.351 ms | 187 bytes / 161 bytes | 5d516126-6a6b-4129-b69e-34730004a1c6 |
| 22 | success | 2026-11-17T02:55:23.203Z | 9 ms | 5,290 ms | 1,790 ms | 8,732.106 ms | 187 bytes / 161 bytes | 9eb35c03-4d1a-49bf-81ad-ffd329522f71 |
| 23 | success | 2026-11-17T02:55:33.238Z | 8 ms | 5,010 ms | 1,800 ms | 8,430.395 ms | 187 bytes / 161 bytes | f77e99b1-026e-4fe3-8792-382925048adb |
| 24 | success | 2026-11-17T02:55:43.038Z | 9 ms | 5,120 ms | 1,850 ms | 8,677.632 ms | 187 bytes / 161 bytes | 4db19e8f-fbe2-45fd-bb5b-ccb8a703f417 |
| 25 | success | 2026-11-17T02:55:53.038Z | 9 ms | 4,980 ms | 1,820 ms | 8,469.701 ms | 187 bytes / 161 bytes | 19884c48-fbd7-432a-8ec3-eb3d129b4bf2 |
| 26 | success | 2026-11-17T02:56:02.811Z | 10 ms | 5,040 ms | 1,830 ms | 8,586.185 ms | 187 bytes / 161 bytes | e02197e6-553d-4da3-869e-b80de4bad02f |
| 27 | success | 2026-11-17T02:56:12.657Z | 7 ms | 5,330 ms | 1,850 ms | 8,815.229 ms | 187 bytes / 161 bytes | 24415002-1f74-4ab0-b66e-4e2c1163b1f7 |
| 28 | success | 2026-11-17T02:56:22.691Z | 8 ms | 5,650 ms | 1,780 ms | 9,082.044 ms | 187 bytes / 161 bytes | 4fbc4078-ccaf-43f8-ae09-bee379a502f6 |
| 29 | success | 2026-11-17T02:56:33.075Z | 9 ms | 4,890 ms | 1,880 ms | 8,502.125 ms | 187 bytes / 161 bytes | 7f777ce9-c533-4e2f-8216-17ae2ae5c891 |
| 30 | success | 2026-11-17T02:56:42.885Z | 9 ms | 5,220 ms | 1,930 ms | 8,810.05 ms | 187 bytes / 161 bytes | 2b10aa01-dc36-4b6d-beb5-6385ba47697b |



</details>

## Latency workload summary

| Workload | URL | Mean | P50 | P95 |
| --- | --- | --- | --- | --- |
| latency | https://void-perf-baseline-workers.cloudflare-internal-11e.workers.dev/ | 35.121 ms | 32.609 ms | 45.887 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency

Recorded latency workload

### Client latency

| Measurement | Value |
| --- | --- |
| Mean | 35.121 ms |
| Minimum | 21.831 ms |
| P50 | 32.609 ms |
| P95 | 45.887 ms |
| P99 | 85.976 ms |
| Maximum | 1,282.302 ms |
| Throughput | 28.455 req/s |
| Measured duration | 175.717 s |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 5,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
| Mean | 35.121 ms | [34.096, 36.482] ms | 3.4% | Met |
| P50 | 32.609 ms | [31.768, 34.268] ms | 3.83% | Met |
| P95 | 45.887 ms | [44.42, 47.576] ms | 3.44% | Met |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
| 1 | success | 500 | 2026-11-17T02:57:09.308Z |
| 2 | success | 500 | 2026-11-17T02:57:28.193Z |
| 3 | success | 500 | 2026-11-17T02:57:47.547Z |
| 4 | success | 500 | 2026-11-17T02:58:06.951Z |
| 5 | success | 500 | 2026-11-17T02:58:26.700Z |
| 6 | success | 500 | 2026-11-17T02:58:45.119Z |
| 7 | success | 500 | 2026-11-17T02:59:04.752Z |
| 8 | success | 500 | 2026-11-17T02:59:25.034Z |
| 9 | success | 500 | 2026-11-17T02:59:47.245Z |
| 10 | success | 500 | 2026-11-17T03:00:06.629Z |


Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| 5,500 | 0 | 0 |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
| CPU | 210 µs | 337 µs | 717 µs | 1,007 µs |
| Wall time | 816 µs | 1,285 µs | 2,133 µs | 5,342 µs |
| Isolate memory | 2 MiB | 2.25 MiB | 2.5 MiB | 2.5 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field | Value |
| --- | --- |
| Measurement start (UTC) | 2026-11-17T02:57:06.444Z |
| Measurement end (UTC) | 2026-11-17T03:00:24.607Z |
| Query start, inclusive (UTC) | 2026-11-17T02:55:36.000Z |
| Query end, inclusive (UTC) | 2026-11-17T03:01:55.000Z |
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
