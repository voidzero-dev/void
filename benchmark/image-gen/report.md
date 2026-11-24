# image-gen benchmark report

Successful run: **2026-11-20T03:50:21.711Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-20T02:38:58.666Z                                         |
| Run finished (UTC)                    | 2026-11-20T03:50:21.711Z                                         |
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

| Field                                                       | Value                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| URL                                                         | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/ |
| Method                                                      | GET                                                              |
| Expected status                                             | 200                                                              |
| Expected body size per response                             | 0 bytes                                                          |
| Measured requests per round                                 | 1000                                                             |
| Latency rounds                                              | 10                                                               |
| Total measured requests                                     | 10000                                                            |
| Duration limit per round                                    | None                                                             |
| Connections                                                 | 1                                                                |
| Rate limit                                                  | None                                                             |
| Request timeout                                             | 30s                                                              |
| HTTP version                                                | 1.1                                                              |
| Keep-alive                                                  | true                                                             |
| Warmup requests per round (excluded from client statistics) | 50                                                               |
| Access authentication                                       | temporary-login                                                  |
| HTTP response counts                                        | 200: 10,000                                                      |

### small-image

| Field                                                       | Value                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| URL                                                         | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/run?width=64&height=64 |
| Method                                                      | GET                                                                                    |
| Expected status                                             | 200                                                                                    |
| Expected body size per response                             | Not constrained                                                                        |
| Measured requests per round                                 | 250                                                                                    |
| Latency rounds                                              | 10                                                                                     |
| Total measured requests                                     | 2500                                                                                   |
| Duration limit per round                                    | None                                                                                   |
| Connections                                                 | 1                                                                                      |
| Rate limit                                                  | None                                                                                   |
| Request timeout                                             | 30s                                                                                    |
| HTTP version                                                | 1.1                                                                                    |
| Keep-alive                                                  | true                                                                                   |
| Warmup requests per round (excluded from client statistics) | 50                                                                                     |
| Access authentication                                       | temporary-login                                                                        |
| HTTP response counts                                        | 200: 2,500                                                                             |

### og-image

| Field                                                       | Value                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| URL                                                         | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/run?width=1200&height=630 |
| Method                                                      | GET                                                                                       |
| Expected status                                             | 200                                                                                       |
| Expected body size per response                             | Not constrained                                                                           |
| Measured requests per round                                 | 50                                                                                        |
| Latency rounds                                              | 10                                                                                        |
| Total measured requests                                     | 500                                                                                       |
| Duration limit per round                                    | None                                                                                      |
| Connections                                                 | 1                                                                                         |
| Rate limit                                                  | None                                                                                      |
| Request timeout                                             | 30s                                                                                       |
| HTTP version                                                | 1.1                                                                                       |
| Keep-alive                                                  | true                                                                                      |
| Warmup requests per round (excluded from client statistics) | 50                                                                                        |
| Access authentication                                       | temporary-login                                                                           |
| HTTP response counts                                        | 200: 500                                                                                  |

### emoji-image

| Field                                                       | Value                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                                                         | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/run?width=1200&height=630&text=Hello%20%F0%9F%91%8B%20%F0%9F%8C%8D%20%F0%9F%9A%80 |
| Method                                                      | GET                                                                                                                                               |
| Expected status                                             | 200                                                                                                                                               |
| Expected body size per response                             | Not constrained                                                                                                                                   |
| Measured requests per round                                 | 50                                                                                                                                                |
| Latency rounds                                              | 10                                                                                                                                                |
| Total measured requests                                     | 500                                                                                                                                               |
| Duration limit per round                                    | None                                                                                                                                              |
| Connections                                                 | 1                                                                                                                                                 |
| Rate limit                                                  | None                                                                                                                                              |
| Request timeout                                             | 30s                                                                                                                                               |
| HTTP version                                                | 1.1                                                                                                                                               |
| Keep-alive                                                  | true                                                                                                                                              |
| Warmup requests per round (excluded from client statistics) | 50                                                                                                                                                |
| Access authentication                                       | temporary-login                                                                                                                                   |
| HTTP response counts                                        | 200: 500                                                                                                                                          |

</details>

## Build & deployment

### Bundle size

| Format | Size (Median) |
| ------ | ------------- |
| Raw    | 181,859 bytes |
| Gzip   | 51,209 bytes  |

### Timing summary

| Phase          | Mean          | Mean 95% CI                | Median        |
| -------------- | ------------- | -------------------------- | ------------- |
| Build          | 159.067 ms    | [146.699, 174.3] ms        | 143.5 ms      |
| Upload         | 7,276 ms      | [6,868.667, 7,569.667] ms  | 7,475 ms      |
| Worker startup | 5.667 ms      | [4.8, 6.533] ms            | 5 ms          |
| `cf deploy`    | 14,595.889 ms | [13,943.51, 15,058.333] ms | 14,989.639 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| Worker                                                          | void-perf-image-gen                                             |
| Worker ID                                                       | d8f97940421f45128c32c93db782c266                                |
| Version ID                                                      | 8534e565-cec4-467a-8f0c-0f85c848b12c                            |
| Origin                                                          | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 3,233.553 ms                                                    |
| Final run workflow wall time (includes cleanup, lookup, Access) | 19,549.826 ms                                                   |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range           |
| ------ | ---------------- | --------------------- |
| Raw    | 181,859 bytes    | 181,859–181,859 bytes |
| Gzip   | 51,209 bytes     | 51,209–51,209 bytes   |

Bundle-size variation: None observed.

#### Full timing statistics

| Phase                       | Valid / missing | Mean          | Mean 95% CI                | Median        | Median 95% CI               | Sample SD    | IQR        | Min–max                 | Mean CI half-width / mean | ±5% target |
| --------------------------- | --------------- | ------------- | -------------------------- | ------------- | --------------------------- | ------------ | ---------- | ----------------------- | ------------------------- | ---------- |
| Build                       | 30 / 0          | 159.067 ms    | [146.699, 174.3] ms        | 143.5 ms      | [139.5, 151.5] ms           | 39.377 ms    | 16 ms      | 134–299 ms              | 8.68%                     | Not met    |
| Upload                      | 30 / 0          | 7,276 ms      | [6,868.667, 7,569.667] ms  | 7,475 ms      | [7,400, 7,560] ms           | 1,010.567 ms | 247.5 ms   | 3,570–8,300 ms          | 4.82%                     | Met        |
| Deploy triggers             | 30 / 0          | 1,805.333 ms  | [1,675.658, 1,900] ms      | 1,875 ms      | [1,839.875, 1,895] ms       | 323.363 ms   | 107.5 ms   | 610–2,200 ms            | 6.21%                     | Not met    |
| Worker startup              | 30 / 0          | 5.667 ms      | [4.8, 6.533] ms            | 5 ms          | [4, 7] ms                   | 2.454 ms     | 3 ms       | 2–11 ms                 | 15.29%                    | Not met    |
| `cf deploy`                 | 30 / 0          | 14,595.889 ms | [13,943.51, 15,058.333] ms | 14,989.639 ms | [14,825.732, 15,110.517] ms | 1,623.544 ms | 468.472 ms | 8,442.354–15,674.968 ms | 3.82%                     | Met        |
| Local preparation + cleanup | 30 / 0          | 6.799 ms      | [6.253, 7.353] ms          | 6.714 ms      | [6.365, 7.223] ms           | 1.55 ms      | 1.272 ms   | 4.391–10.733 ms         | 8.09%                     | Not met    |
| Worker lookup               | 30 / 0          | 1,301.3 ms    | [1,269.916, 1,349.949] ms  | 1,268.297 ms  | [1,259.628, 1,291.391] ms   | 117.36 ms    | 48.12 ms   | 1,215.771–1,884.188 ms  | 3.08%                     | Met        |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0                                     |
| Batch start / finish (UTC)               | 2026-11-20T02:38:59.741Z / 2026-11-20T02:47:00.069Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build  | Upload   | Deploy triggers | `cf deploy`   | Raw / gzip                   | Version                              |
| --------- | ------- | ------------------------ | ------ | -------- | --------------- | ------------- | ---------------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-20T02:38:59.742Z | 134 ms | 7,770 ms | 1,850 ms        | 15,547.049 ms | 181,859 bytes / 51,209 bytes | 24a46f6f-772d-46cd-abfc-c5c221ca7b32 |
| 2         | success | 2026-11-20T02:39:16.568Z | 144 ms | 7,460 ms | 1,970 ms        | 14,998.961 ms | 181,859 bytes / 51,209 bytes | 81364881-2e9b-4850-81bc-ed5f1c3f0e07 |
| 3         | success | 2026-11-20T02:39:32.876Z | 137 ms | 7,310 ms | 1,920 ms        | 14,621.917 ms | 181,859 bytes / 51,209 bytes | 2e8801a9-6041-440c-9fe5-c56c0e93946f |
| 4         | success | 2026-11-20T02:39:48.744Z | 134 ms | 7,730 ms | 2,200 ms        | 15,467.654 ms | 181,859 bytes / 51,209 bytes | f244235e-2c14-4ce2-8d50-2ec3cee6d374 |
| 5         | success | 2026-11-20T02:40:06.071Z | 138 ms | 8,300 ms | 1,830 ms        | 15,674.968 ms | 181,859 bytes / 51,209 bytes | b5da641e-caa9-4644-b373-941b9b456f28 |
| 6         | success | 2026-11-20T02:40:23.068Z | 173 ms | 7,370 ms | 1,890 ms        | 15,112.348 ms | 181,859 bytes / 51,209 bytes | 4f4e1675-bade-4549-aaa2-0170fe9d9889 |
| 7         | success | 2026-11-20T02:40:39.441Z | 154 ms | 7,610 ms | 1,900 ms        | 15,205.043 ms | 181,859 bytes / 51,209 bytes | 02a64a2f-b097-45e7-bf78-c01592860f58 |
| 8         | success | 2026-11-20T02:40:56.026Z | 172 ms | 7,630 ms | 1,870 ms        | 14,980.316 ms | 181,859 bytes / 51,209 bytes | 89d9df22-4c5b-427f-b5ac-917f66251dc3 |
| 9         | success | 2026-11-20T02:41:12.230Z | 140 ms | 7,490 ms | 1,770 ms        | 14,676.46 ms  | 181,859 bytes / 51,209 bytes | 0597e2c8-92dd-4ba1-b32d-b9de74ef49e7 |
| 10        | success | 2026-11-20T02:41:28.133Z | 136 ms | 7,930 ms | 1,890 ms        | 15,189.733 ms | 181,859 bytes / 51,209 bytes | bdd0c078-5ea0-4002-bb8a-0df41c9303ed |
| 11        | success | 2026-11-20T02:41:44.585Z | 137 ms | 7,480 ms | 1,790 ms        | 14,730.39 ms  | 181,859 bytes / 51,209 bytes | dbd93d49-f214-49fe-b896-3e6014713b64 |
| 12        | success | 2026-11-20T02:42:00.676Z | 299 ms | 7,270 ms | 1,780 ms        | 14,889.323 ms | 181,859 bytes / 51,209 bytes | 081e878c-1af8-4b76-aca2-7833d2cae3de |
| 13        | success | 2026-11-20T02:42:16.843Z | 139 ms | 7,460 ms | 1,930 ms        | 14,921.167 ms | 181,859 bytes / 51,209 bytes | 60bbc782-30df-4157-ad90-d0b9ccf244ae |
| 14        | success | 2026-11-20T02:42:33.079Z | 154 ms | 7,090 ms | 1,790 ms        | 14,707.487 ms | 181,859 bytes / 51,209 bytes | da53e28e-3308-43df-8323-eb363f987dec |
| 15        | success | 2026-11-20T02:42:49.058Z | 142 ms | 3,790 ms | 610 ms          | 9,002.98 ms   | 181,859 bytes / 51,209 bytes | d99d0648-a1e0-46eb-9bb7-90fbb15f37dd |
| 16        | success | 2026-11-20T02:42:59.328Z | 136 ms | 7,530 ms | 1,850 ms        | 14,833.608 ms | 181,859 bytes / 51,209 bytes | 663c949d-443f-417c-a27a-0499fc8b2e75 |
| 17        | success | 2026-11-20T02:43:15.428Z | 140 ms | 7,350 ms | 1,910 ms        | 14,660.988 ms | 181,859 bytes / 51,209 bytes | db35c140-81c2-46ee-9100-e1aeb1d63730 |
| 18        | success | 2026-11-20T02:43:31.334Z | 214 ms | 7,470 ms | 1,880 ms        | 15,260.595 ms | 181,859 bytes / 51,209 bytes | 319f8279-3dad-496f-9f6c-f86ae94a5960 |
| 19        | success | 2026-11-20T02:43:47.942Z | 149 ms | 7,370 ms | 1,810 ms        | 14,622.824 ms | 181,859 bytes / 51,209 bytes | d4df7348-3e63-49fd-9850-9cf66e918872 |
| 20        | success | 2026-11-20T02:44:03.855Z | 143 ms | 7,550 ms | 1,970 ms        | 15,021.93 ms  | 181,859 bytes / 51,209 bytes | c9238e76-3008-493a-aa29-922757c6dad8 |
| 21        | success | 2026-11-20T02:44:20.147Z | 167 ms | 7,450 ms | 1,890 ms        | 15,108.685 ms | 181,859 bytes / 51,209 bytes | c0a092a6-7048-4ac0-beb3-3347ba20768c |
| 22        | success | 2026-11-20T02:44:36.530Z | 138 ms | 3,570 ms | 710 ms          | 8,442.354 ms  | 181,859 bytes / 51,209 bytes | e5eae2e8-cad0-44d8-9a3d-c96ad1e6b5c8 |
| 23        | success | 2026-11-20T02:44:46.236Z | 220 ms | 7,040 ms | 1,980 ms        | 14,584.436 ms | 181,859 bytes / 51,209 bytes | 82602628-e674-4ef4-95c9-6577748913b5 |
| 24        | success | 2026-11-20T02:45:02.180Z | 141 ms | 7,680 ms | 2,020 ms        | 15,100.887 ms | 181,859 bytes / 51,209 bytes | a896700d-fb60-4fc8-a645-2a8bbade6c31 |
| 25        | success | 2026-11-20T02:45:18.559Z | 135 ms | 7,520 ms | 1,800 ms        | 14,817.856 ms | 181,859 bytes / 51,209 bytes | a3469921-749a-4745-a4d4-dc434040895c |
| 26        | success | 2026-11-20T02:45:34.732Z | 147 ms | 7,570 ms | 1,890 ms        | 15,213.686 ms | 181,859 bytes / 51,209 bytes | 1db28e32-1edb-4b12-97fa-c794d306a1ac |
| 27        | success | 2026-11-20T02:45:51.235Z | 147 ms | 8,070 ms | 1,860 ms        | 15,460.15 ms  | 181,859 bytes / 51,209 bytes | 3ae6d5c3-cc40-46b6-af65-bb70037638d5 |
| 28        | success | 2026-11-20T02:46:07.962Z | 154 ms | 7,390 ms | 1,850 ms        | 14,855.963 ms | 181,859 bytes / 51,209 bytes | 823b430f-c3f1-4899-b3ef-17a75dc67668 |
| 29        | success | 2026-11-20T02:46:24.075Z | 262 ms | 7,620 ms | 1,810 ms        | 15,157.539 ms | 181,859 bytes / 51,209 bytes | bf2063f0-8c65-4d25-af5b-e29b9f800a55 |
| 30        | success | 2026-11-20T02:46:40.519Z | 146 ms | 7,410 ms | 1,940 ms        | 15,009.377 ms | 181,859 bytes / 51,209 bytes | 8534e565-cec4-467a-8f0c-0f85c848b12c |

</details>

## Latency workload summary

| Workload    | URL                                                                                                                                               | Mean       | P50        | P95        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ---------- |
| baseline    | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/                                                                                  | 40.833 ms  | 38.231 ms  | 55.756 ms  |
| small-image | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/run?width=64&height=64                                                            | 414.551 ms | 358.687 ms | 704.080 ms |
| og-image    | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/run?width=1200&height=630                                                         | 482.197 ms | 406.730 ms | 754.211 ms |
| emoji-image | https://void-perf-image-gen.cloudflare-internal-11e.workers.dev/run?width=1200&height=630&text=Hello%20%F0%9F%91%8B%20%F0%9F%8C%8D%20%F0%9F%9A%80 | 524.903 ms | 440.607 ms | 774.262 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency - baseline

Empty response with image code present in the deployment

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 40.833 ms    |
| Minimum           | 25.538 ms    |
| P50               | 38.231 ms    |
| P95               | 55.756 ms    |
| P99               | 94.999 ms    |
| Maximum           | 410.408 ms   |
| Throughput        | 24.478 req/s |
| Measured duration | 408.529 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 10,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate  | 95% CI              | CI half-width / estimate | ±5% target |
| ----------- | --------- | ------------------- | ------------------------ | ---------- |
| Mean        | 40.833 ms | [39.588, 42.539] ms | 3.61%                    | Met        |
| P50         | 38.231 ms | [37.221, 40.259] ms | 3.97%                    | Met        |
| P95         | 55.756 ms | [52.826, 58.478] ms | 5.07%                    | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 1,000             | 2026-11-20T02:47:18.090Z |
| 2     | success | 1,000             | 2026-11-20T02:48:01.595Z |
| 3     | success | 1,000             | 2026-11-20T02:48:43.055Z |
| 4     | success | 1,000             | 2026-11-20T02:49:26.667Z |
| 5     | success | 1,000             | 2026-11-20T02:50:08.273Z |
| 6     | success | 1,000             | 2026-11-20T02:50:49.351Z |
| 7     | success | 1,000             | 2026-11-20T02:51:39.181Z |
| 8     | success | 1,000             | 2026-11-20T02:52:21.075Z |
| 9     | success | 1,000             | 2026-11-20T02:53:03.254Z |
| 10    | success | 1,000             | 2026-11-20T02:53:47.763Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 10,720   | 0      | 0           |

| Measurement    | P50       | P90       | P99       | P99.9     |
| -------------- | --------- | --------- | --------- | --------- |
| CPU            | 464 µs    | 768 µs    | 1,551 µs  | 5,737 µs  |
| Wall time      | 1,117 µs  | 1,736 µs  | 3,527 µs  | 9,130 µs  |
| Isolate memory | 3.004 MiB | 4.004 MiB | 4.754 MiB | 5.004 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T02:47:15.126Z |
| Measurement end (UTC)                | 2026-11-20T02:54:29.264Z |
| Query start, inclusive (UTC)         | 2026-11-20T02:45:45.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T02:56:00.000Z |
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

## Latency - small-image

Generate a 64 × 64 PNG

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 414.551 ms   |
| Minimum           | 193.138 ms   |
| P50               | 358.687 ms   |
| P95               | 704.08 ms    |
| P99               | 833.676 ms   |
| Maximum           | 3,590.542 ms |
| Throughput        | 2.412 req/s  |
| Measured duration | 1,036.462 s  |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 2,500 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 414.551 ms | [397.929, 435.383] ms | 4.52%                    | Met        |
| P50         | 358.687 ms | [345.438, 380.546] ms | 4.89%                    | Met        |
| P95         | 704.08 ms  | [681.144, 719.556] ms | 2.73%                    | Met        |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 250               | 2026-11-20T02:59:34.324Z |
| 2     | success | 250               | 2026-11-20T03:02:00.462Z |
| 3     | success | 250               | 2026-11-20T03:04:13.086Z |
| 4     | success | 250               | 2026-11-20T03:06:21.697Z |
| 5     | success | 250               | 2026-11-20T03:08:27.014Z |
| 6     | success | 250               | 2026-11-20T03:10:22.729Z |
| 7     | success | 250               | 2026-11-20T03:12:19.928Z |
| 8     | success | 250               | 2026-11-20T03:14:19.947Z |
| 9     | success | 250               | 2026-11-20T03:16:30.376Z |
| 10    | success | 250               | 2026-11-20T03:18:29.582Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 3,004    | 0      | 3,004       |

| Measurement    | P50        | P90        | P99        | P99.9        |
| -------------- | ---------- | ---------- | ---------- | ------------ |
| CPU            | 1,740 µs   | 2,540 µs   | 6,053 µs   | 11,001 µs    |
| Wall time      | 314,355 µs | 593,117 µs | 841,615 µs | 3,410,177 µs |
| Isolate memory | 3.263 MiB  | 4.521 MiB  | 5.527 MiB  | 5.779 MiB    |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T02:59:06.794Z |
| Measurement end (UTC)                | 2026-11-20T03:20:10.545Z |
| Query start, inclusive (UTC)         | 2026-11-20T02:57:36.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T03:21:41.000Z |
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

## Latency - og-image

Generate a 1200 × 630 Open Graph PNG

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 482.197 ms   |
| Minimum           | 238.653 ms   |
| P50               | 406.73 ms    |
| P95               | 754.211 ms   |
| P99               | 1,217.993 ms |
| Maximum           | 6,731.583 ms |
| Throughput        | 2.074 req/s  |
| Measured duration | 241.125 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 500 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 482.197 ms | [449.835, 519.944] ms | 7.27%                    | Not met    |
| P50         | 406.73 ms  | [382.777, 429.964] ms | 5.8%                     | Not met    |
| P95         | 754.211 ms | [743.019, 796.673] ms | 3.56%                    | Met        |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 50                | 2026-11-20T03:25:14.923Z |
| 2     | success | 50                | 2026-11-20T03:25:59.010Z |
| 3     | success | 50                | 2026-11-20T03:26:49.919Z |
| 4     | success | 50                | 2026-11-20T03:27:37.180Z |
| 5     | success | 50                | 2026-11-20T03:28:27.720Z |
| 6     | success | 50                | 2026-11-20T03:29:13.463Z |
| 7     | success | 50                | 2026-11-20T03:29:55.817Z |
| 8     | success | 50                | 2026-11-20T03:30:49.963Z |
| 9     | success | 50                | 2026-11-20T03:31:37.999Z |
| 10    | success | 50                | 2026-11-20T03:32:19.988Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 1,007    | 0      | 1,007       |

| Measurement    | P50        | P90        | P99        | P99.9        |
| -------------- | ---------- | ---------- | ---------- | ------------ |
| CPU            | 1,850 µs   | 2,680 µs   | 6,008 µs   | 11,576 µs    |
| Wall time      | 338,346 µs | 623,319 µs | 879,069 µs | 5,871,945 µs |
| Isolate memory | 3.295 MiB  | 4.647 MiB  | 5.451 MiB  | 5.478 MiB    |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T03:24:48.923Z |
| Measurement end (UTC)                | 2026-11-20T03:32:42.504Z |
| Query start, inclusive (UTC)         | 2026-11-20T03:23:18.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T03:34:13.000Z |
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

## Latency - emoji-image

Generate a 1200 × 630 PNG with Hello 👋 🌍 🚀 using browser-native emoji

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 524.903 ms   |
| Minimum           | 248.042 ms   |
| P50               | 440.607 ms   |
| P95               | 774.262 ms   |
| P99               | 996.846 ms   |
| Maximum           | 9,686.835 ms |
| Throughput        | 1.905 req/s  |
| Measured duration | 262.476 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 500 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 524.903 ms | [476.127, 581.907] ms | 10.08%                   | Not met    |
| P50         | 440.607 ms | [407.174, 466.528] ms | 6.74%                    | Not met    |
| P95         | 774.262 ms | [741.689, 808.578] ms | 4.32%                    | Met        |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 50                | 2026-11-20T03:37:44.491Z |
| 2     | success | 50                | 2026-11-20T03:38:38.089Z |
| 3     | success | 50                | 2026-11-20T03:39:26.504Z |
| 4     | success | 50                | 2026-11-20T03:40:19.580Z |
| 5     | success | 50                | 2026-11-20T03:41:11.447Z |
| 6     | success | 50                | 2026-11-20T03:42:09.001Z |
| 7     | success | 50                | 2026-11-20T03:42:57.625Z |
| 8     | success | 50                | 2026-11-20T03:43:54.052Z |
| 9     | success | 50                | 2026-11-20T03:44:41.678Z |
| 10    | success | 50                | 2026-11-20T03:45:28.551Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 1,005    | 0      | 1,005       |

| Measurement    | P50        | P90        | P99        | P99.9        |
| -------------- | ---------- | ---------- | ---------- | ------------ |
| CPU            | 1,923 µs   | 2,729 µs   | 6,493 µs   | 11,843 µs    |
| Wall time      | 378,420 µs | 653,603 µs | 854,029 µs | 8,987,287 µs |
| Isolate memory | 4.135 MiB  | 5.567 MiB  | 6.355 MiB  | 6.511 MiB    |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T03:37:20.132Z |
| Measurement end (UTC)                | 2026-11-20T03:45:49.019Z |
| Query start, inclusive (UTC)         | 2026-11-20T03:35:50.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T03:47:20.000Z |
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
