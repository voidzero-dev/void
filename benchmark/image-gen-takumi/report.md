# image-gen-takumi benchmark report

Successful run: **2026-11-20T07:23:34.097Z**

Source measurements: [report.json](report.json).

<details>
<summary>Show context and workload</summary>

## Context

| Field                                 | Value                                                            |
| ------------------------------------- | ---------------------------------------------------------------- |
| Run started (UTC)                     | 2026-11-20T06:35:05.770Z                                         |
| Run finished (UTC)                    | 2026-11-20T07:23:34.097Z                                         |
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

### small-image

| Field                                                       | Value                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| URL                                                         | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/run?width=64&height=64 |
| Method                                                      | GET                                                                                           |
| Expected status                                             | 200                                                                                           |
| Expected body size per response                             | Not constrained                                                                               |
| Measured requests per round                                 | 250                                                                                           |
| Latency rounds                                              | 10                                                                                            |
| Total measured requests                                     | 2500                                                                                          |
| Duration limit per round                                    | None                                                                                          |
| Connections                                                 | 1                                                                                             |
| Rate limit                                                  | None                                                                                          |
| Request timeout                                             | 30s                                                                                           |
| HTTP version                                                | 1.1                                                                                           |
| Keep-alive                                                  | true                                                                                          |
| Warmup requests per round (excluded from client statistics) | 50                                                                                            |
| Access authentication                                       | temporary-login                                                                               |
| HTTP response counts                                        | 200: 2,500                                                                                    |

### og-image

| Field                                                       | Value                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| URL                                                         | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/run?width=1200&height=630 |
| Method                                                      | GET                                                                                              |
| Expected status                                             | 200                                                                                              |
| Expected body size per response                             | Not constrained                                                                                  |
| Measured requests per round                                 | 50                                                                                               |
| Latency rounds                                              | 10                                                                                               |
| Total measured requests                                     | 500                                                                                              |
| Duration limit per round                                    | None                                                                                             |
| Connections                                                 | 1                                                                                                |
| Rate limit                                                  | None                                                                                             |
| Request timeout                                             | 30s                                                                                              |
| HTTP version                                                | 1.1                                                                                              |
| Keep-alive                                                  | true                                                                                             |
| Warmup requests per round (excluded from client statistics) | 50                                                                                               |
| Access authentication                                       | temporary-login                                                                                  |
| HTTP response counts                                        | 200: 500                                                                                         |

### emoji-image

| Field                                                       | Value                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                                                         | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/run?width=1200&height=630&text=Hello%20%F0%9F%91%8B%20%F0%9F%8C%8D%20%F0%9F%9A%80&emoji=twemoji |
| Method                                                      | GET                                                                                                                                                                    |
| Expected status                                             | 200                                                                                                                                                                    |
| Expected body size per response                             | Not constrained                                                                                                                                                        |
| Measured requests per round                                 | 50                                                                                                                                                                     |
| Latency rounds                                              | 10                                                                                                                                                                     |
| Total measured requests                                     | 500                                                                                                                                                                    |
| Duration limit per round                                    | None                                                                                                                                                                   |
| Connections                                                 | 1                                                                                                                                                                      |
| Rate limit                                                  | None                                                                                                                                                                   |
| Request timeout                                             | 30s                                                                                                                                                                    |
| HTTP version                                                | 1.1                                                                                                                                                                    |
| Keep-alive                                                  | true                                                                                                                                                                   |
| Warmup requests per round (excluded from client statistics) | 50                                                                                                                                                                     |
| Access authentication                                       | temporary-login                                                                                                                                                        |
| HTTP response counts                                        | 200: 500                                                                                                                                                               |

</details>

## Build & deployment

### Bundle size

| Format | Size (Median)   |
| ------ | --------------- |
| Raw    | 5,140,131 bytes |
| Gzip   | 2,297,860 bytes |

### Timing summary

| Phase          | Mean          | Mean 95% CI                 | Median       |
| -------------- | ------------- | --------------------------- | ------------ |
| Build          | 241.867 ms    | [220.067, 273.034] ms       | 218.5 ms     |
| Upload         | 8,579.667 ms  | [8,461.667, 8,720] ms       | 8,515 ms     |
| Worker startup | 4.5 ms        | [3.933, 5.167] ms           | 4 ms         |
| `cf deploy`    | 14,711.211 ms | [14,575.711, 14,868.228] ms | 14,626.99 ms |

### Details

<details>
<summary>Show details</summary>

#### Deployment details

| Field                                                           | Value                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker                                                          | void-perf-image-gen-takumi                                             |
| Worker ID                                                       | 2c1dcf4023ac49348e398b086b32f4b5                                       |
| Version ID                                                      | 6d7e54fe-5d4b-49cf-8a6c-2643985ab544                                   |
| Origin                                                          | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev |
| Final run Access setup/check (excluded from command timing)     | 2,899.62 ms                                                            |
| Final run workflow wall time (includes cleanup, lookup, Access) | 19,001.152 ms                                                          |

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range               |
| ------ | ---------------- | ------------------------- |
| Raw    | 5,140,131 bytes  | 5,140,131–5,140,131 bytes |
| Gzip   | 2,297,860 bytes  | 2,297,860–2,297,860 bytes |

Bundle-size variation: None observed.

#### Full timing statistics

| Phase                       | Valid / missing | Mean          | Mean 95% CI                 | Median       | Median 95% CI               | Sample SD  | IQR        | Min–max                  | Mean CI half-width / mean | ±5% target |
| --------------------------- | --------------- | ------------- | --------------------------- | ------------ | --------------------------- | ---------- | ---------- | ------------------------ | ------------------------- | ---------- |
| Build                       | 30 / 0          | 241.867 ms    | [220.067, 273.034] ms       | 218.5 ms     | [205.5, 234.5] ms           | 76.003 ms  | 40 ms      | 197–600 ms               | 10.95%                    | Not met    |
| Upload                      | 30 / 0          | 8,579.667 ms  | [8,461.667, 8,720] ms       | 8,515 ms     | [8,419.875, 8,605] ms       | 368.187 ms | 335 ms     | 8,200–9,850 ms           | 1.51%                     | Met        |
| Deploy triggers             | 30 / 0          | 1,900 ms      | [1,868.333, 1,934] ms       | 1,885 ms     | [1,860, 1,910] ms           | 93.218 ms  | 67.5 ms    | 1,770–2,150 ms           | 1.73%                     | Met        |
| Worker startup              | 30 / 0          | 4.5 ms        | [3.933, 5.167] ms           | 4 ms         | [3.5, 4] ms                 | 1.757 ms   | 2.75 ms    | 3–10 ms                  | 13.7%                     | Not met    |
| `cf deploy`                 | 30 / 0          | 14,711.211 ms | [14,575.711, 14,868.228] ms | 14,626.99 ms | [14,556.315, 14,697.151] ms | 415.415 ms | 313.577 ms | 14,175.445–16,173.492 ms | 0.99%                     | Met        |
| Local preparation + cleanup | 30 / 0          | 8.228 ms      | [7.719, 8.706] ms           | 8.191 ms     | [7.767, 8.933] ms           | 1.408 ms   | 1.588 ms   | 4.867–10.699 ms          | 6%                        | Not met    |
| Worker lookup               | 30 / 0          | 1,344.296 ms  | [1,308.106, 1,389.98] ms    | 1,311.467 ms | [1,292.187, 1,350.749] ms   | 116.886 ms | 92.771 ms  | 1,231.358–1,809.227 ms   | 3.05%                     | Met        |

#### Batch context

| Field                                    | Value                                               |
| ---------------------------------------- | --------------------------------------------------- |
| Requested / completed / failed / not run | 30 / 30 / 0 / 0                                     |
| Batch start / finish (UTC)               | 2026-11-20T06:35:06.239Z / 2026-11-20T06:43:11.095Z |

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use 10,000 resamples, seed 1987012964, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run       | Outcome | Started (UTC)            | Build  | Upload   | Deploy triggers | `cf deploy`   | Raw / gzip                        | Version                              |
| --------- | ------- | ------------------------ | ------ | -------- | --------------- | ------------- | --------------------------------- | ------------------------------------ |
| 1 (first) | success | 2026-11-20T06:35:06.240Z | 308 ms | 8,710 ms | 1,910 ms        | 15,137.264 ms | 5,140,131 bytes / 2,297,860 bytes | 772572cb-0185-4f31-9c10-3a067870af12 |
| 2         | success | 2026-11-20T06:35:22.646Z | 216 ms | 8,340 ms | 1,920 ms        | 14,572.799 ms | 5,140,131 bytes / 2,297,860 bytes | 9fe02d90-9a8a-46b0-be61-80bc82ecfdd9 |
| 3         | success | 2026-11-20T06:35:38.538Z | 201 ms | 8,320 ms | 1,890 ms        | 14,262.154 ms | 5,140,131 bytes / 2,297,860 bytes | 01b142e2-2314-4fb6-bc7f-a107b9a93ea6 |
| 4         | success | 2026-11-20T06:35:54.067Z | 220 ms | 8,390 ms | 1,840 ms        | 14,708.125 ms | 5,140,131 bytes / 2,297,860 bytes | 0568460d-b2cb-4d2b-89ce-fbb3f0efe6a9 |
| 5         | success | 2026-11-20T06:36:10.403Z | 204 ms | 8,310 ms | 1,810 ms        | 14,175.445 ms | 5,140,131 bytes / 2,297,860 bytes | ca1bea44-757f-4123-bdc9-9c2485ac494b |
| 6         | success | 2026-11-20T06:36:25.963Z | 217 ms | 8,790 ms | 2,130 ms        | 15,071.259 ms | 5,140,131 bytes / 2,297,860 bytes | 2d9fec3b-fa5f-420e-9028-53863981e192 |
| 7         | success | 2026-11-20T06:36:42.362Z | 202 ms | 8,240 ms | 1,900 ms        | 14,264.427 ms | 5,140,131 bytes / 2,297,860 bytes | db0cbc67-97ed-4941-8f10-2ca634e0bb31 |
| 8         | success | 2026-11-20T06:36:57.981Z | 200 ms | 9,560 ms | 1,980 ms        | 15,601.424 ms | 5,140,131 bytes / 2,297,860 bytes | b2e0ae35-d274-4958-b14e-5602fc0d6513 |
| 9         | success | 2026-11-20T06:37:14.954Z | 284 ms | 8,660 ms | 1,890 ms        | 14,824.024 ms | 5,140,131 bytes / 2,297,860 bytes | fa8ee676-7fea-4840-bb5c-02574389e03f |
| 10        | success | 2026-11-20T06:37:31.247Z | 247 ms | 8,200 ms | 1,850 ms        | 14,230.612 ms | 5,140,131 bytes / 2,297,860 bytes | 13423aa0-dd73-447c-b7d1-00d5e8a73bbe |
| 11        | success | 2026-11-20T06:37:46.901Z | 230 ms | 8,670 ms | 1,870 ms        | 14,686.177 ms | 5,140,131 bytes / 2,297,860 bytes | 363739a2-e357-4de7-acb5-168fa2ef16e3 |
| 12        | success | 2026-11-20T06:38:02.931Z | 250 ms | 8,450 ms | 1,790 ms        | 14,533.353 ms | 5,140,131 bytes / 2,297,860 bytes | 656a0101-9928-429a-9f3e-a501c6efc321 |
| 13        | success | 2026-11-20T06:38:18.777Z | 236 ms | 8,210 ms | 1,770 ms        | 14,631.512 ms | 5,140,131 bytes / 2,297,860 bytes | 39bb87af-83e6-4555-b269-37cdd35752ea |
| 14        | success | 2026-11-20T06:38:34.682Z | 199 ms | 8,520 ms | 1,860 ms        | 14,515.706 ms | 5,140,131 bytes / 2,297,860 bytes | e476055c-6f3a-443a-b182-a0a2c20c539a |
| 15        | success | 2026-11-20T06:38:50.508Z | 199 ms | 8,620 ms | 1,950 ms        | 14,863.991 ms | 5,140,131 bytes / 2,297,860 bytes | b5cd51c8-e387-4e66-90a6-c3f40d207013 |
| 16        | success | 2026-11-20T06:39:06.756Z | 206 ms | 8,560 ms | 1,780 ms        | 14,440.746 ms | 5,140,131 bytes / 2,297,860 bytes | 79d1b707-9788-4409-8b76-a1ee049a5779 |
| 17        | success | 2026-11-20T06:39:23.012Z | 295 ms | 8,450 ms | 1,870 ms        | 14,664.145 ms | 5,140,131 bytes / 2,297,860 bytes | 4e8ecf22-921c-4a31-aa15-3e067bd555b1 |
| 18        | success | 2026-11-20T06:39:39.092Z | 224 ms | 8,220 ms | 1,860 ms        | 14,577.831 ms | 5,140,131 bytes / 2,297,860 bytes | f8951d04-1583-46b7-af52-32365cca48e0 |
| 19        | success | 2026-11-20T06:39:54.981Z | 206 ms | 9,850 ms | 2,060 ms        | 16,173.492 ms | 5,140,131 bytes / 2,297,860 bytes | 6a787d55-fb2f-4b3f-bdc8-f956b603623b |
| 20        | success | 2026-11-20T06:40:12.500Z | 298 ms | 8,590 ms | 1,860 ms        | 14,676.47 ms  | 5,140,131 bytes / 2,297,860 bytes | 27ae8452-e3a9-4f8b-9c4b-094610fdaa04 |
| 21        | success | 2026-11-20T06:40:28.479Z | 200 ms | 8,950 ms | 2,150 ms        | 15,229.51 ms  | 5,140,131 bytes / 2,297,860 bytes | c84df3b3-9be3-4222-87ed-dbfbeef1e9aa |
| 22        | success | 2026-11-20T06:40:45.072Z | 235 ms | 8,330 ms | 1,810 ms        | 14,259.676 ms | 5,140,131 bytes / 2,297,860 bytes | 858994f7-f2f3-4bf0-9843-edc8af85b780 |
| 23        | success | 2026-11-20T06:41:00.595Z | 197 ms | 8,540 ms | 1,940 ms        | 14,622.468 ms | 5,140,131 bytes / 2,297,860 bytes | 1b756298-1dfd-40d1-a2ff-694dad4a0f43 |
| 24        | success | 2026-11-20T06:41:16.497Z | 205 ms | 8,730 ms | 1,920 ms        | 14,848.33 ms  | 5,140,131 bytes / 2,297,860 bytes | d35e82d7-4168-4f16-b1f8-9734f65214d7 |
| 25        | success | 2026-11-20T06:41:32.700Z | 227 ms | 8,490 ms | 2,030 ms        | 14,539.832 ms | 5,140,131 bytes / 2,297,860 bytes | 84bf70e1-d0ff-4dc2-aaff-f24be3450b73 |
| 26        | success | 2026-11-20T06:41:48.503Z | 600 ms | 8,230 ms | 1,810 ms        | 14,675.176 ms | 5,140,131 bytes / 2,297,860 bytes | b0a24a15-ade2-47ff-bfa1-3e2f8c30be5f |
| 27        | success | 2026-11-20T06:42:04.553Z | 206 ms | 8,580 ms | 1,910 ms        | 14,613.78 ms  | 5,140,131 bytes / 2,297,860 bytes | 45e7472a-8937-44a5-be50-3dd16929198b |
| 28        | success | 2026-11-20T06:42:20.471Z | 305 ms | 8,460 ms | 1,860 ms        | 14,619.314 ms | 5,140,131 bytes / 2,297,860 bytes | 50c65b3d-9695-4888-a6b3-aea2bc3b4290 |
| 29        | success | 2026-11-20T06:42:36.331Z | 234 ms | 8,510 ms | 1,880 ms        | 14,480.364 ms | 5,140,131 bytes / 2,297,860 bytes | 2d046090-a72d-4790-9e71-9572a90e3dbd |
| 30        | success | 2026-11-20T06:42:52.093Z | 205 ms | 8,910 ms | 1,900 ms        | 14,836.918 ms | 5,140,131 bytes / 2,297,860 bytes | 6d7e54fe-5d4b-49cf-8a6c-2643985ab544 |

</details>

## Latency workload summary

| Workload    | URL                                                                                                                                                                    | Mean       | P50        | P95        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ---------- |
| baseline    | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/                                                                                                | 61.772 ms  | 54.568 ms  | 109.848 ms |
| small-image | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/run?width=64&height=64                                                                          | 85.630 ms  | 75.928 ms  | 148.773 ms |
| og-image    | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/run?width=1200&height=630                                                                       | 104.485 ms | 91.385 ms  | 181.048 ms |
| emoji-image | https://void-perf-image-gen-takumi.cloudflare-internal-11e.workers.dev/run?width=1200&height=630&text=Hello%20%F0%9F%91%8B%20%F0%9F%8C%8D%20%F0%9F%9A%80&emoji=twemoji | 131.823 ms | 122.896 ms | 198.965 ms |

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>

## Latency - baseline

Empty response with image code and Takumi runtime present in the deployment

### Client latency

| Measurement       | Value        |
| ----------------- | ------------ |
| Mean              | 61.772 ms    |
| Minimum           | 28.799 ms    |
| P50               | 54.568 ms    |
| P95               | 109.848 ms   |
| P99               | 180.87 ms    |
| Maximum           | 425.892 ms   |
| Throughput        | 16.183 req/s |
| Measured duration | 617.945 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 10,000 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 61.772 ms  | [58.826, 65.096] ms   | 5.07%                    | Not met    |
| P50         | 54.568 ms  | [52.011, 57.877] ms   | 5.37%                    | Not met    |
| P95         | 109.848 ms | [103.009, 117.611] ms | 6.65%                    | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 1,000             | 2026-11-20T06:43:21.490Z |
| 2     | success | 1,000             | 2026-11-20T06:44:22.975Z |
| 3     | success | 1,000             | 2026-11-20T06:45:21.493Z |
| 4     | success | 1,000             | 2026-11-20T06:46:38.092Z |
| 5     | success | 1,000             | 2026-11-20T06:47:42.598Z |
| 6     | success | 1,000             | 2026-11-20T06:48:48.307Z |
| 7     | success | 1,000             | 2026-11-20T06:49:49.836Z |
| 8     | success | 1,000             | 2026-11-20T06:50:51.438Z |
| 9     | success | 1,000             | 2026-11-20T06:51:54.266Z |
| 10    | success | 1,000             | 2026-11-20T06:53:03.257Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 10,520   | 0      | 0           |

| Measurement    | P50       | P90       | P99        | P99.9      |
| -------------- | --------- | --------- | ---------- | ---------- |
| CPU            | 549 µs    | 906 µs    | 2,048 µs   | 8,316 µs   |
| Wall time      | 1,356 µs  | 2,330 µs  | 5,587 µs   | 13,502 µs  |
| Isolate memory | 5.225 MiB | 6.725 MiB | 12.643 MiB | 12.893 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T06:43:17.782Z |
| Measurement end (UTC)                | 2026-11-20T06:54:11.620Z |
| Query start, inclusive (UTC)         | 2026-11-20T06:41:47.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T06:55:42.000Z |
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
| Mean              | 85.63 ms     |
| Minimum           | 42.933 ms    |
| P50               | 75.928 ms    |
| P95               | 148.773 ms   |
| P99               | 235.851 ms   |
| Maximum           | 735.927 ms   |
| Throughput        | 11.674 req/s |
| Measured duration | 214.156 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 2,500 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 85.63 ms   | [81.885, 89.586] ms   | 4.5%                     | Met        |
| P50         | 75.928 ms  | [72.709, 79.303] ms   | 4.34%                    | Met        |
| P95         | 148.773 ms | [135.121, 163.832] ms | 9.65%                    | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 250               | 2026-11-20T06:58:54.748Z |
| 2     | success | 250               | 2026-11-20T06:59:18.259Z |
| 3     | success | 250               | 2026-11-20T06:59:44.075Z |
| 4     | success | 250               | 2026-11-20T07:00:10.749Z |
| 5     | success | 250               | 2026-11-20T07:00:37.176Z |
| 6     | success | 250               | 2026-11-20T07:01:04.568Z |
| 7     | success | 250               | 2026-11-20T07:01:28.658Z |
| 8     | success | 250               | 2026-11-20T07:01:56.412Z |
| 9     | success | 250               | 2026-11-20T07:02:21.767Z |
| 10    | success | 250               | 2026-11-20T07:02:50.104Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 3,015    | 0      | 0           |

| Measurement    | P50        | P90        | P99        | P99.9      |
| -------------- | ---------- | ---------- | ---------- | ---------- |
| CPU            | 4,298 µs   | 6,512 µs   | 9,828 µs   | 16,665 µs  |
| Wall time      | 5,642 µs   | 8,869 µs   | 14,415 µs  | 49,212 µs  |
| Isolate memory | 27.028 MiB | 28.277 MiB | 40.363 MiB | 40.863 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T06:58:49.509Z |
| Measurement end (UTC)                | 2026-11-20T07:03:10.516Z |
| Query start, inclusive (UTC)         | 2026-11-20T06:57:19.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T07:04:41.000Z |
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

| Measurement       | Value       |
| ----------------- | ----------- |
| Mean              | 104.485 ms  |
| Minimum           | 53.594 ms   |
| P50               | 91.385 ms   |
| P95               | 181.048 ms  |
| P99               | 301.303 ms  |
| Maximum           | 636.011 ms  |
| Throughput        | 9.566 req/s |
| Measured duration | 52.268 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 500 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 104.485 ms | [98.081, 111.019] ms  | 6.19%                    | Not met    |
| P50         | 91.385 ms  | [87.518, 95.802] ms   | 4.53%                    | Met        |
| P95         | 181.048 ms | [160.703, 222.965] ms | 17.19%                   | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 50                | 2026-11-20T07:10:26.968Z |
| 2     | success | 50                | 2026-11-20T07:10:37.805Z |
| 3     | success | 50                | 2026-11-20T07:10:49.335Z |
| 4     | success | 50                | 2026-11-20T07:10:59.976Z |
| 5     | success | 50                | 2026-11-20T07:11:09.475Z |
| 6     | success | 50                | 2026-11-20T07:11:18.850Z |
| 7     | success | 50                | 2026-11-20T07:11:28.631Z |
| 8     | success | 50                | 2026-11-20T07:11:39.364Z |
| 9     | success | 50                | 2026-11-20T07:11:50.033Z |
| 10    | success | 50                | 2026-11-20T07:12:00.415Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 1,032    | 0      | 0           |

| Measurement    | P50        | P90        | P99        | P99.9      |
| -------------- | ---------- | ---------- | ---------- | ---------- |
| CPU            | 13,582 µs  | 20,080 µs  | 23,882 µs  | 30,641 µs  |
| Wall time      | 15,505 µs  | 22,787 µs  | 31,415 µs  | 40,709 µs  |
| Isolate memory | 26.556 MiB | 27.806 MiB | 40.399 MiB | 40.408 MiB |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T07:10:21.138Z |
| Measurement end (UTC)                | 2026-11-20T07:12:05.613Z |
| Query start, inclusive (UTC)         | 2026-11-20T07:08:51.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T07:13:36.000Z |
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

Generate a 1200 × 630 PNG with Hello 👋 🌍 🚀 using Twemoji

### Client latency

| Measurement       | Value       |
| ----------------- | ----------- |
| Mean              | 131.823 ms  |
| Minimum           | 79.939 ms   |
| P50               | 122.896 ms  |
| P95               | 198.965 ms  |
| P99               | 267.004 ms  |
| Maximum           | 327.05 ms   |
| Throughput        | 7.583 req/s |
| Measured duration | 65.935 s    |

#### Details

<details>
<summary>Show details</summary>

##### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.

##### Latency uncertainty

10 rounds; 500 measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate   | 95% CI                | CI half-width / estimate | ±5% target |
| ----------- | ---------- | --------------------- | ------------------------ | ---------- |
| Mean        | 131.823 ms | [126.193, 138.058] ms | 4.5%                     | Met        |
| P50         | 122.896 ms | [118.3, 126.169] ms   | 3.2%                     | Met        |
| P95         | 198.965 ms | [186.695, 225.539] ms | 9.76%                    | Not met    |

95% percentile cluster-bootstrap intervals use 10,000 resamples and seed 1987012964. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

##### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC)  |
| ----- | ------- | ----------------- | ------------------------ |
| 1     | success | 50                | 2026-11-20T07:16:50.939Z |
| 2     | success | 50                | 2026-11-20T07:17:05.253Z |
| 3     | success | 50                | 2026-11-20T07:17:17.630Z |
| 4     | success | 50                | 2026-11-20T07:17:33.202Z |
| 5     | success | 50                | 2026-11-20T07:17:46.929Z |
| 6     | success | 50                | 2026-11-20T07:18:00.372Z |
| 7     | success | 50                | 2026-11-20T07:18:14.459Z |
| 8     | success | 50                | 2026-11-20T07:18:28.155Z |
| 9     | success | 50                | 2026-11-20T07:18:41.688Z |
| 10    | success | 50                | 2026-11-20T07:18:55.532Z |

Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.

</details>

### Worker metrics

| Requests | Errors | Subrequests |
| -------- | ------ | ----------- |
| 997      | 0      | 6           |

| Measurement    | P50        | P90        | P99        | P99.9      |
| -------------- | ---------- | ---------- | ---------- | ---------- |
| CPU            | 30,878 µs  | 46,562 µs  | 57,405 µs  | 112,576 µs |
| Wall time      | 34,039 µs  | 51,482 µs  | 70,609 µs  | 131,008 µs |
| Isolate memory | 26.798 MiB | 27.714 MiB | 40.758 MiB | 41.04 MiB  |

#### Details

<details>
<summary>Show details</summary>

##### Analytics window

| Field                                | Value                    |
| ------------------------------------ | ------------------------ |
| Measurement start (UTC)              | 2026-11-20T07:16:44.607Z |
| Measurement end (UTC)                | 2026-11-20T07:19:02.736Z |
| Query start, inclusive (UTC)         | 2026-11-20T07:15:14.000Z |
| Query end, inclusive (UTC)           | 2026-11-20T07:20:33.000Z |
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
