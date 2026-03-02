#!/usr/bin/env node

import { Command } from "commander";
import { auth } from "./commands/auth.js";
import { workers } from "./commands/workers.js";
import { r2 } from "./commands/r2.js";
import { d1 } from "./commands/d1.js";
import { kv } from "./commands/kv.js";
import { queues } from "./commands/queues.js";
import { ai } from "./commands/ai.js";

var program = new Command();

program
  .name("flareclerk")
  .description("Cloudflare analytics — resource usage and cost estimation")
  .version("0.1.0");

program
  .command("auth")
  .description("Save Cloudflare API token and account ID")
  .action(auth);

program
  .command("workers [name]")
  .description("Workers + DO + Containers + D1 + KV usage and cost")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(workers);

program
  .command("ai [model]")
  .description("Workers AI inference costs: neurons per model")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(ai);

program
  .command("r2 [bucket]")
  .description("R2 bucket costs: Class A/B ops + storage")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(r2);

program
  .command("d1 [database]")
  .description("D1 database costs: rows read/written + storage")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(d1);

program
  .command("kv [namespace]")
  .description("KV namespace costs: reads, writes + storage")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(kv);

program
  .command("queues [queue]")
  .description("Queues costs: billable operations")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(queues);

program.parse();
