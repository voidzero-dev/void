# Workers performance benchmark

Benchmarks build and deployment performance, bundle sizes, and the latency of
deployed Cloudflare Workers. The apps compare direct Workers, Void, and
`@void/image`.

## Usage

Run a single benchmark from the repository root:

```sh
vp install
vp run build
vp run --filter ./benchmark benchmark baseline-workers
```

Available benchmarks: `baseline-workers`, `baseline-void`, `image-response-bare`,
and `image-response`.

Install `oha` and supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through
your environment or credential wrapper. The token needs Workers deployment,
Access Edit, and Account Analytics Read permissions. The package provides `cf`.
Protected requests open employee Access login unless `CF_ACCESS_TOKEN` is set.

The complete flow deploys, measures latency, retrieves Worker metrics, and writes:

- **`benchmark/<id>/report.md`** — readable results.
- **`benchmark/<id>/report.json`** — portable measurements used to generate the report.

Commit both files. Detailed local logs and request samples remain in the ignored
`benchmark/<id>/artifacts/` directory. Failed runs preserve the previous report.

Generate the cross-benchmark overview from saved reports:

```sh
vp run --filter ./benchmark compare
```

The overview is **[`benchmark/report.md`](./report.md)**, with Mermaid charts and
links to the individual reports. Commit it alongside the source reports.

An optional `benchmark/<id>/benchmark.json` configures deployment count and latency
workloads. Missing fields use defaults: 30 deployments, then 10 latency rounds of
500 requests with 50 warmup requests per round. CLI options override configuration;
`--path` selects one ad-hoc workload. Set `"latency": []` for deployment only.

## Scripts

All examples run from the repository root. Each command supports `-h` / `--help`,
except the `test` and `typecheck` package tasks.

### `benchmark`

Runs the complete benchmark. All latency workloads use the final deployment.

```sh
vp run --filter ./benchmark benchmark image-response
vp run --filter ./benchmark benchmark image-response --path '/run?width=64&height=64' --deploy-runs 5 -n 200
```

| Argument                    | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `<id>`                      | Benchmark directory name; required.                                |
| `--path <path>`             | Replace configured workloads with one app-relative path and query. |
| `--deploy-runs <n>`         | Deployment count, 1–1000; default 30.                              |
| `-n, --requests <n>`        | Measured requests per latency round; default 500.                  |
| `--latency-runs <n>`        | Latency rounds, 1–1000; default 10.                                |
| `--warmup-requests <n>`     | Warmup requests per round; default 50; 0 disables.                 |
| `-c, --connections <n>`     | Concurrent connections; default 1.                                 |
| `-z, --duration <time>`     | Duration per round instead of request count, e.g. `30s`.           |
| `-q, --rate <qps>`          | Optional rate limit in req/s.                                      |
| `-t, --timeout <time>`      | Request timeout; default `30s`.                                    |
| `--http-version <v>`        | `1.1` (default) or `2`.                                            |
| `--metrics-attempts <n>`    | Maximum queries per quiet/results phase; default 61.               |
| `--metrics-interval <time>` | Delay between queries; default `10s`.                              |
| `--metrics-padding <time>`  | Padding on each side of the measurement window; default `90s`.     |
| `--metrics-wait <time>`     | Ingestion wait after the padded window ends; default `3m`.         |

Defaults above apply when configuration does not override them. Workspace packages
must already be built. This command deploys real Workers and sends request traffic.

### `deploy`

Builds and deploys one app, recording timings and bundle sizes. Use benchmark mode
for repeated clean builds and deployments with statistical summaries.

```sh
vp run --filter ./benchmark deploy baseline-workers
vp run --filter ./benchmark deploy baseline-workers --benchmark --runs 30
```

| Argument      | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `<id>`        | Benchmark directory name; required.                          |
| `--benchmark` | Repeat clean build-and-deploy measurements; default 30 runs. |
| `--runs <n>`  | Deployment count, 1–1000; requires `--benchmark`.            |

Without `--benchmark`, deploys once. Results are saved under
`benchmark/<id>/artifacts/deploy/`.

### `latency`

Measures client latency with `oha`, using the saved deployment or an explicit URL.
Does not deploy or retrieve Cloudflare metrics.

```sh
vp run --filter ./benchmark latency image-response-bare --path /run
vp run --filter ./benchmark latency baseline-workers --url https://example.workers.dev -z 30s
```

| Argument                | Description                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `<id>`                  | Benchmark directory name; required.                                                                             |
| `--path <path>`         | App-relative path and query; default `/`.                                                                       |
| `--request-json <json>` | Object containing `request: { path, method?, headers?, body? }` and optional `expect: { status?, bodyBytes? }`. |
| `-n, --requests <n>`    | Measured requests per round; default 500.                                                                       |
| `--latency-runs <n>`    | Measured rounds, 1–1000; default 10.                                                                            |
| `--warmup-requests <n>` | Warmup requests per round; default 50; 0 disables.                                                              |
| `-c, --connections <n>` | Concurrent connections; default 1.                                                                              |
| `-z, --duration <time>` | Duration per round instead of request count, e.g. `30s`.                                                        |
| `-q, --rate <qps>`      | Optional rate limit in req/s.                                                                                   |
| `-t, --timeout <time>`  | Request timeout; default `30s`.                                                                                 |
| `--http-version <v>`    | `1.1` (default) or `2`; keep-alive enabled.                                                                     |
| `--url <origin>`        | Override the saved deployment URL; no Access authentication by default.                                         |
| `--access`              | Authenticate an explicit `--url` through employee Access.                                                       |

Use either `--requests` or `--duration`, not both. This standalone script uses its
own arguments, not `benchmark.json`. Results are saved under
`benchmark/<id>/artifacts/latency/`.

### `metrics`

Retrieves Worker request counts and CPU, wall-time, and memory percentiles from
Cloudflare's read-only GraphQL Analytics API. Does not send benchmark traffic.

```sh
vp run --filter ./benchmark metrics baseline-workers
vp run --filter ./benchmark metrics baseline-workers \
  --start 2026-11-17T01:00:00Z --end 2026-11-17T01:05:00Z
```

| Argument              | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `<id>`                | Benchmark directory name; required.                                         |
| `--latency <file>`    | Saved latency stats; default `benchmark/<id>/artifacts/latency/stats.json`. |
| `--padding <time>`    | Pad each side of a latency-derived window; default `90s`.                   |
| `--start <timestamp>` | Explicit ISO timestamp with timezone; requires `--end`.                     |
| `--end <timestamp>`   | End of the explicit window; cannot combine with `--latency`.                |
| `--worker <name>`     | Override the Worker name; requires an explicit window.                      |

`--padding` applies only to latency-derived windows. Explicit relative file paths
are resolved from the working directory. Requires `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` with Account Analytics Read. Results are saved under
`benchmark/<id>/artifacts/metrics/`.

### `report`

Generates `report.md` and `report.json` from saved measurements, without deploying,
sending requests, or querying Cloudflare.

```sh
vp run --filter ./benchmark report baseline-workers
vp run --filter ./benchmark report baseline-workers \
  --input benchmark/baseline-workers/artifacts/benchmark/<run>/stats.json
```

| Argument         | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `<id>`           | Benchmark directory name; required.                           |
| `--input <file>` | A portable `report.json` or successful combined `stats.json`. |

By default, uses `benchmark/<id>/report.json`, falling back to the latest successful
combined artifacts if no snapshot exists. The snapshot reproduces the report
without local artifacts; it contains summaries, not individual request samples.

### `compare`

Reads every `benchmark/*/report.json` and writes `benchmark/report.md` with Mermaid
bar charts comparing bundle sizes, deployment timings, client latency, throughput,
and Worker CPU, wall time, and memory. Includes every recorded workload.

```sh
vp run --filter ./benchmark compare
```

No arguments other than `-h` / `--help`. Worker charts show P50; P90/P99/P99.9
charts, exact values, and comparison context are under Details. Missing measurements
are unavailable, not zero. Reports with no latency workloads contribute deployment
measurements only.

The command uses only saved snapshots: no build, deployment, request traffic,
credentials, or Cloudflare query is needed. Source reports are not modified.

### `access-token`

Prints an employee Access JWT to stdout. Uses `CF_ACCESS_TOKEN` when supplied;
otherwise opens browser login and removes temporary credentials afterward.

```sh
vp run --filter ./benchmark access-token https://example.workers.dev
```

Argument: one HTTPS origin, without a path, query, or credentials. Treat stdout as
a secret; do not commit or save it in reports.

### `machine`

Prints local machine context as JSON: platform, CPU, core counts, network
type/interface, and a hashed hostname.

```sh
vp run --filter ./benchmark machine
```

No arguments other than `-h` / `--help`.

### `test`

Runs the benchmark tooling's automated tests.

```sh
vp run --filter ./benchmark test
```

No benchmark-specific arguments.

### `typecheck`

Checks the benchmark scripts with TypeScript without emitting files.

```sh
vp run --filter ./benchmark typecheck
```

No benchmark-specific arguments.
