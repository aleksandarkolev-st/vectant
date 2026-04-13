# Baseline Latency Report & Reference Budgets

## Reference Latency Budgets

These are the target latencies from the Compiled HMR Recovery Plan.
All measurements are on reference hardware at the p95 level.

| Metric | Budget | Description |
|--------|--------|-------------|
| Save acknowledgement | ≤ 250ms | UI shows "compiling" indicator after save |
| Warm-compatible reload | ≤ 2,500ms | End-to-end save → visible result for compatible edits |
| Managed / process-swap reload | ≤ 5,000ms | End-to-end for managed runtime or process swap |
| Cold reload | ≤ 5,000ms | Schema migration or larger invalidation |
| Full restart (session-preserving) | ≤ 10,000ms | Last-resort within preview session |

## Per-Phase Budget Breakdown

### Warm Reload Path (target ≤ 2,500ms total)

| Phase | Budget |
|-------|--------|
| Save detection → compile_requested | ≤ 50ms |
| compile_requested → compiling | ≤ 20ms |
| compiling → compile_finished (GUI-only) | ≤ 1,500ms |
| compile_finished → reload_planned | ≤ 20ms |
| reload_planned → reload_applying | ≤ 50ms |
| reload_applying → reload_applied | ≤ 500ms |
| Overhead margin | 360ms |

### Cold Reload Path (target ≤ 5,000ms total)

| Phase | Budget |
|-------|--------|
| Save detection → compile_requested | ≤ 50ms |
| Compile (broader invalidation) | ≤ 3,000ms |
| Planner + state migration | ≤ 500ms |
| Candidate load + health check | ≤ 1,000ms |
| Overhead margin | 450ms |

### Process Swap Path (target ≤ 5,000ms total)

| Phase | Budget |
|-------|--------|
| Save detection → compile_requested | ≤ 50ms |
| Compile candidate executable | ≤ 2,500ms |
| Snapshot export from old process | ≤ 500ms |
| Candidate startup + import | ≤ 1,000ms |
| Health check + ownership transfer | ≤ 500ms |
| Overhead margin | 450ms |

## Telemetry Collection Points

The `HmrTelemetry` struct (commit 007) instruments:

1. **compile_latency**: compile_requested → compile_finished
2. **reload_latency**: reload_planned → reload_applied
3. **rollback_reasons**: distribution of why reloads were rolled back
4. **decision_counts**: distribution of planner decisions (warm/cold/managed/etc.)

### Histogram Buckets

Latency histograms use these bucket boundaries (ms):
`[50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]`

### Key Percentile Targets

| Percentile | Compile Latency | Reload Latency |
|------------|-----------------|----------------|
| p50 | ≤ 500ms | ≤ 100ms |
| p90 | ≤ 1,500ms | ≤ 500ms |
| p95 | ≤ 2,500ms | ≤ 1,000ms |
| p99 | ≤ 5,000ms | ≤ 2,500ms |

## Rollback Reason Monitoring

High rollback rates on specific reason codes should trigger alerts:

| Reason Code | Action Threshold |
|-------------|-----------------|
| `abi_incompatible` | > 20% of reloads → check boundary stability |
| `candidate_crash` | > 5% of reloads → check health-check coverage |
| `schema_mismatch` | > 30% of reloads → review migration coverage |
| `symbol_missing` | > 10% of reloads → check export contracts |
| `health_timeout` | > 5% of reloads → tune timeout budgets |

## How to Access

Reports are available via `HmrTelemetry::report()` which produces a
serializable `TelemetryReport` struct. A future admin endpoint will
expose this at `/api/hmr/telemetry`.
