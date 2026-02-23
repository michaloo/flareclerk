# flareclerk

CLI reporting usage stats and cost estimates for Cloudflare compute and storage.

Covers Workers (Durable Objects & Containers), Workers AI, R2, D1, KV, and Queues. No wrangler required.

## Install

```
npm install -g flareclerk
```

## Setup

```
flareclerk auth
```

Saves your API token and account ID to `~/.flareclerk/config.json`.

## Commands

Every command follows the same pattern: run without arguments for a summary, or pass a resource name for a detailed breakdown.

```bash
# All workers: requests, CPU, DO, containers, cost
flareclerk workers

# Single worker: detailed cost breakdown + live containers stats
flareclerk workers <name>

# Workers AI inference costs (neurons per model)
flareclerk ai
flareclerk ai <model>

# R2 bucket costs (Class A/B ops + storage)
flareclerk r2
flareclerk r2 <bucket>

# D1 database costs (rows read/written + storage)
flareclerk d1
flareclerk d1 <database>

# KV namespace costs (reads, writes + storage)
flareclerk kv
flareclerk kv <namespace>

# Queues costs (billable operations)
flareclerk queues
flareclerk queues <queue>

# JSON output (all commands)
flareclerk workers --json
flareclerk workers <name> --json
flareclerk ai --json
flareclerk r2 --json
flareclerk d1 --json
flareclerk kv --json
flareclerk queues --json
```

All commands support `--since <period>` (e.g. `7d`, `30d`, `2025-01-01`) and `--json`.

## FAQ

**What API permissions do I need?**

Workers Scripts (read), Containers (read), R2 (read), D1 (read), Workers KV Storage (read), and Queues (read). The `flareclerk auth` command provides a pre-filled token creation link with all required permissions.

**Where does the data come from?**

Cloudflare's GraphQL Analytics API — `workersInvocationsAdaptive`, `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups`, `containersMetricsAdaptiveGroups`, `aiInferenceAdaptiveGroups`, `r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`, `d1QueriesAdaptiveGroups`, `d1StorageAdaptiveGroups`, `kvOperationsAdaptiveGroups`, `kvStorageAdaptiveGroups`, and `queueMessageOperationsAdaptiveGroups`.
