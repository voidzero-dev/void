# Workers benchmark comparison

Overview of the latest saved benchmark reports. Lower is better except throughput, where higher is better.

## Benchmarks

| Benchmark                                              | Measured (UTC)           | Data                                             |
| ------------------------------------------------------ | ------------------------ | ------------------------------------------------ |
| [baseline-void](./baseline-void/report.md)             | 2026-11-17T03:17:44.865Z | [report.json](./baseline-void/report.json)       |
| [baseline-workers](./baseline-workers/report.md)       | 2026-11-17T03:04:55.867Z | [report.json](./baseline-workers/report.json)    |
| [image-response](./image-response/report.md)           | 2026-11-17T06:59:17.908Z | [report.json](./image-response/report.json)      |
| [image-response-bare](./image-response-bare/report.md) | 2026-11-17T04:18:13.658Z | [report.json](./image-response-bare/report.json) |

## Bundle size

### Raw

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 268
---
xychart-beta horizontal
    x-axis ["baseline-void", "baseline-workers", "image-response", "image-response-bare"]
    y-axis "KB" 0 --> 5585.7802
    bar [142.649, 0.187, 5077.982, 5076.039]
```

### Gzip

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 268
---
xychart-beta horizontal
    x-axis ["baseline-void", "baseline-workers", "image-response", "image-response-bare"]
    y-axis "KB" 0 --> 2576.7852
    bar [39.872, 0.161, 2342.532, 2341.931]
```

### Details

<details>
<summary>Show details</summary>

#### Values

| Benchmark / workload | Raw          | Gzip         |
| -------------------- | ------------ | ------------ |
| baseline-void        | 142.649 KB   | 39.872 KB    |
| baseline-workers     | 0.187 KB     | 0.161 KB     |
| image-response       | 5,077.982 KB | 2,342.532 KB |
| image-response-bare  | 5,076.039 KB | 2,341.931 KB |

#### Methodology

Median raw and gzip sizes across successful deployments with recorded sizes, in KB (1 KB = 1,000 bytes). Historical single-deployment reports use the recorded size.

</details>

## Deployment timing

### Build

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 268
---
xychart-beta horizontal
    x-axis ["baseline-void", "baseline-workers", "image-response", "image-response-bare"]
    y-axis "ms" 0 --> 232.28333
    bar [139.2, 8.8333333, 211.16667, 203.86667]
```

### Upload

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 268
---
xychart-beta horizontal
    x-axis ["baseline-void", "baseline-workers", "image-response", "image-response-bare"]
    y-axis "ms" 0 --> 9675.2333
    bar [7543, 4930.3333, 8795.6667, 8592.3333]
```

### Worker startup

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 268
---
xychart-beta horizontal
    x-axis ["baseline-void", "baseline-workers", "image-response", "image-response-bare"]
    y-axis "ms" 0 --> 6.49
    bar [5.9, 2.1666667, 5.4, 4.4333333]
```

### `cf deploy`

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 268
---
xychart-beta horizontal
    x-axis ["baseline-void", "baseline-workers", "image-response", "image-response-bare"]
    y-axis "ms" 0 --> 16811.684
    bar [13680.044, 8411.5204, 15283.349, 14963.854]
```

### Details

<details>
<summary>Show details</summary>

#### Values

| Benchmark / workload | Build      | Upload       | Worker startup | `cf deploy`   |
| -------------------- | ---------- | ------------ | -------------- | ------------- |
| baseline-void        | 139.2 ms   | 7,543 ms     | 5.9 ms         | 13,680.044 ms |
| baseline-workers     | 8.833 ms   | 4,930.333 ms | 2.167 ms       | 8,411.52 ms   |
| image-response       | 211.167 ms | 8,795.667 ms | 5.4 ms         | 15,283.349 ms |
| image-response-bare  | 203.867 ms | 8,592.333 ms | 4.433 ms       | 14,963.854 ms |

#### Methodology

Means across successful deployment runs; historical single-deployment reports use the recorded timing. These phases overlap: do not add them. `cf deploy` includes build but excludes later Worker lookup and Access setup. Worker startup is runtime initialization, not cold-request latency.

</details>

## Latency

### Mean

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "ms" 0 --> 118.71042
    bar [38.18344, 35.121264, 50.327996, 65.315251, 81.366649, 107.91856, 42.476913, 53.556033]
```

### Minimum

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "ms" 0 --> 74.94575
    bar [23.777375, 21.83075, 26.7835, 39.3675, 50.247583, 68.1325, 25.370375, 33.281791]
```

### P50

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "ms" 0 --> 113.03279
    bar [34.899521, 32.608521, 46.007625, 60.355854, 76.304563, 102.75708, 39.187209, 50.10598]
```

### P95

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "ms" 0 --> 162.74449
    bar [52.354332, 45.886533, 77.235383, 93.154694, 112.69053, 147.94954, 61.128887, 71.704312]
```

### P99

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "ms" 0 --> 211.89561
    bar [104.19998, 85.975953, 125.64489, 136.81833, 168.15415, 192.63237, 91.509532, 111.6145]
```

### Maximum

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "ms" 0 --> 1693.0186
    bar [1256.6248, 1282.3021, 936.56929, 1539.1078, 1484.7663, 1287.1514, 1517.0315, 1245.4018]
```

### Throughput

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "req/s" 0 --> 31.300356
    bar [26.174257, 28.454869, 19.858394, 15.303167, 12.284791, 9.2635246, 23.527894, 18.662025]
```

### Details

<details>
<summary>Show details</summary>

#### Values

| Benchmark / workload           | Mean       | Minimum   | P50        | P95        | P99        | Maximum      | Throughput   |
| ------------------------------ | ---------- | --------- | ---------- | ---------- | ---------- | ------------ | ------------ |
| baseline-void / latency        | 38.183 ms  | 23.777 ms | 34.9 ms    | 52.354 ms  | 104.2 ms   | 1,256.625 ms | 26.174 req/s |
| baseline-workers / latency     | 35.121 ms  | 21.831 ms | 32.609 ms  | 45.887 ms  | 85.976 ms  | 1,282.302 ms | 28.455 req/s |
| image-response / baseline      | 50.328 ms  | 26.783 ms | 46.008 ms  | 77.235 ms  | 125.645 ms | 936.569 ms   | 19.858 req/s |
| image-response / small-image   | 65.315 ms  | 39.368 ms | 60.356 ms  | 93.155 ms  | 136.818 ms | 1,539.108 ms | 15.303 req/s |
| image-response / og-image      | 81.367 ms  | 50.248 ms | 76.305 ms  | 112.691 ms | 168.154 ms | 1,484.766 ms | 12.285 req/s |
| image-response / emoji-image   | 107.919 ms | 68.133 ms | 102.757 ms | 147.95 ms  | 192.632 ms | 1,287.151 ms | 9.264 req/s  |
| image-response-bare / baseline | 42.477 ms  | 25.37 ms  | 39.187 ms  | 61.129 ms  | 91.51 ms   | 1,517.031 ms | 23.528 req/s |
| image-response-bare / render   | 53.556 ms  | 33.282 ms | 50.106 ms  | 71.704 ms  | 111.615 ms | 1,245.402 ms | 18.662 req/s |

#### Methodology

Client latency includes network and Access overhead. Values describe pooled requests where available; throughput at the recorded concurrency is not capacity. Different routes, payloads, connection counts, or request settings are not equivalent workloads.

#### Workload context

| Benchmark / workload           | Request                                                                                                          | Rounds | Requests / duration per round | Connections | Rate limit |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------- | ----------- | ---------- |
| baseline-void / latency        | GET /                                                                                                            | 10     | 500                           | 1           | None       |
| baseline-workers / latency     | GET /                                                                                                            | 10     | 500                           | 1           | None       |
| image-response / baseline      | GET /                                                                                                            | 10     | 500                           | 1           | None       |
| image-response / small-image   | GET /run?width=64&amp;height=64                                                                                  | 10     | 500                           | 1           | None       |
| image-response / og-image      | GET /run?width=1200&amp;height=630                                                                               | 10     | 500                           | 1           | None       |
| image-response / emoji-image   | GET /run?width=1200&amp;height=630&amp;text=Hello%20%F0%9F%91%8B%20%F0%9F%8C%8D%20%F0%9F%9A%80&amp;emoji=twemoji | 10     | 500                           | 1           | None       |
| image-response-bare / baseline | GET /                                                                                                            | 10     | 500                           | 1           | None       |
| image-response-bare / render   | GET /run                                                                                                         | 10     | 500                           | 1           | None       |

</details>

## Worker metrics (P50)

### CPU

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 36095.4
    bar [391, 210, 446, 2984, 16137, 32814, 404, 1961]
```

### Wall time

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 38133.7
    bar [971, 816, 1110, 3932, 17531, 34667, 996, 2691]
```

### Isolate memory

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "MiB" 0 --> 18.38705
    bar [3.0039177, 2.0000114, 5.4272728, 13.966643, 16.7155, 16.708805, 5.6733665, 13.963451]
```

### Details

<details>
<summary>Show details</summary>

#### Values

| Benchmark / workload           | CPU       | Wall time | Isolate memory |
| ------------------------------ | --------- | --------- | -------------- |
| baseline-void / latency        | 391 µs    | 971 µs    | 3.004 MiB      |
| baseline-workers / latency     | 210 µs    | 816 µs    | 2 MiB          |
| image-response / baseline      | 446 µs    | 1,110 µs  | 5.427 MiB      |
| image-response / small-image   | 2,984 µs  | 3,932 µs  | 13.967 MiB     |
| image-response / og-image      | 16,137 µs | 17,531 µs | 16.715 MiB     |
| image-response / emoji-image   | 32,814 µs | 34,667 µs | 16.709 MiB     |
| image-response-bare / baseline | 404 µs    | 996 µs    | 5.673 MiB      |
| image-response-bare / render   | 1,961 µs  | 2,691 µs  | 13.963 MiB     |

#### Methodology

CPU excludes time waiting on I/O. Wall time includes I/O waits and `waitUntil()` work, not client response time. Memory is shared isolate usage, not per-request allocation or peak memory. Quantiles are sampled across each Worker and its padded measurement window, including warmups. Raw CPU and wall-time quantiles are microseconds; memory bytes are converted to MiB.

#### P90

##### CPU

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 59628.8
    bar [629, 337, 833, 5077, 26801, 54208, 653, 3173]
```

##### Wall time

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 63533.8
    bar [1542, 1285, 1981, 7033, 29541, 57758, 1667, 4427]
```

##### Isolate memory

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "MiB" 0 --> 19.21205
    bar [3.7539177, 2.2500114, 6.4272728, 14.718846, 17.4655, 17.366219, 6.4233665, 14.964092]
```

| Benchmark / workload           | CPU       | Wall time | Isolate memory |
| ------------------------------ | --------- | --------- | -------------- |
| baseline-void / latency        | 629 µs    | 1,542 µs  | 3.754 MiB      |
| baseline-workers / latency     | 337 µs    | 1,285 µs  | 2.25 MiB       |
| image-response / baseline      | 833 µs    | 1,981 µs  | 6.427 MiB      |
| image-response / small-image   | 5,077 µs  | 7,033 µs  | 14.719 MiB     |
| image-response / og-image      | 26,801 µs | 29,541 µs | 17.465 MiB     |
| image-response / emoji-image   | 54,208 µs | 57,758 µs | 17.366 MiB     |
| image-response-bare / baseline | 653 µs    | 1,667 µs  | 6.423 MiB      |
| image-response-bare / render   | 3,173 µs  | 4,427 µs  | 14.964 MiB     |

#### P99

##### CPU

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 72273.3
    bar [1211, 717, 1832, 7813, 33733, 65703, 1585, 5030]
```

##### Wall time

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 81299.9
    bar [3252, 2133, 3883, 11751, 38438, 73909, 3111, 7294]
```

##### Isolate memory

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "MiB" 0 --> 20.041957
    bar [4.2539177, 2.5000114, 6.9272728, 15.22042, 18.219961, 17.876713, 6.6733665, 15.715374]
```

| Benchmark / workload           | CPU       | Wall time | Isolate memory |
| ------------------------------ | --------- | --------- | -------------- |
| baseline-void / latency        | 1,211 µs  | 3,252 µs  | 4.254 MiB      |
| baseline-workers / latency     | 717 µs    | 2,133 µs  | 2.5 MiB        |
| image-response / baseline      | 1,832 µs  | 3,883 µs  | 6.927 MiB      |
| image-response / small-image   | 7,813 µs  | 11,751 µs | 15.22 MiB      |
| image-response / og-image      | 33,733 µs | 38,438 µs | 18.22 MiB      |
| image-response / emoji-image   | 65,703 µs | 73,909 µs | 17.877 MiB     |
| image-response-bare / baseline | 1,585 µs  | 3,111 µs  | 6.673 MiB      |
| image-response-bare / render   | 5,030 µs  | 7,294 µs  | 15.715 MiB     |

#### P99.9

##### CPU

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 86065.1
    bar [4437, 1007, 5053, 11758, 41315, 78241, 5054, 8779]
```

##### Wall time

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "µs" 0 --> 101676.3
    bar [6724, 5342, 9128, 35738, 52201, 92433, 8555, 15791]
```

##### Isolate memory

```mermaid
---
config:
  xyChart:
    width: 1100
    height: 436
---
xychart-beta horizontal
    x-axis ["baseline-void / latency", "baseline-workers / latency", "image-response / baseline", "image-response / small-image", "image-response / og-image", "image-response / emoji-image", "image-response-bare / baseline", "image-response-bare / render"]
    y-axis "MiB" 0 --> 20.58705
    bar [4.5039177, 2.5000114, 6.9272728, 15.97042, 18.7155, 18.387207, 6.6733665, 16.212811]
```

| Benchmark / workload           | CPU       | Wall time | Isolate memory |
| ------------------------------ | --------- | --------- | -------------- |
| baseline-void / latency        | 4,437 µs  | 6,724 µs  | 4.504 MiB      |
| baseline-workers / latency     | 1,007 µs  | 5,342 µs  | 2.5 MiB        |
| image-response / baseline      | 5,053 µs  | 9,128 µs  | 6.927 MiB      |
| image-response / small-image   | 11,758 µs | 35,738 µs | 15.97 MiB      |
| image-response / og-image      | 41,315 µs | 52,201 µs | 18.715 MiB     |
| image-response / emoji-image   | 78,241 µs | 92,433 µs | 18.387 MiB     |
| image-response-bare / baseline | 5,054 µs  | 8,555 µs  | 6.673 MiB      |
| image-response-bare / render   | 8,779 µs  | 15,791 µs | 16.213 MiB     |

</details>

## Details

<details>
<summary>Show details</summary>

### Comparison context

Reports may have been collected at different times, on different machines, or with different workloads and settings. Shared caches, network conditions, and Cloudflare load affect results. These charts are descriptive comparisons, not statistical significance tests or performance rankings.

Missing measurements are omitted from charts and shown as Unavailable in the value tables, never plotted as zero. See each linked report for confidence intervals, environment context, and full methodology. Deployment-only snapshots contribute only bundle sizes and deployment timings.

Regenerate from the repository root with `vp run --filter ./benchmark compare`. Only adjacent saved report snapshots are read; no private artifacts or live services are needed.

</details>
