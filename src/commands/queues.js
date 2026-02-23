import { getConfig, listQueues, cfGraphQL } from "../lib/cf.js";
import { phase, status, fatal, fmt, table } from "../lib/output.js";
import {
  parseDateRange,
  fmtCost,
  fmtUsage,
  applyFreeTier,
  renderDetail,
} from "../lib/cost-utils.js";

// --- Pricing ---

var PRICING = {
  operations: { included: 1_000_000, rate: 0.40 / 1_000_000 },
};

// --- GraphQL ---

var queuesGQL = `query Queues($accountTag: string!, $filter: AccountQueueMessageOperationsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      queueMessageOperationsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { queueId }
        sum { billableOperations }
      }
    }
  }
}`;

// --- Main command ---

export async function queues(name, options) {
  var config = getConfig();
  var range = parseDateRange(options.since);

  phase("Listing queues");
  var queueList;
  try {
    queueList = await listQueues(config);
  } catch (e) {
    fatal("Could not list queues.", e.message);
  }
  if (queueList.length === 0) {
    fatal("No queues found on this account.");
  }
  status(`Found ${queueList.length} queue${queueList.length > 1 ? "s" : ""}`);

  // Build name map
  var nameMap = {};
  for (var q of queueList) {
    nameMap[q.queue_id] = q.queue_name;
  }

  phase("Fetching analytics");
  var data = await cfGraphQL(config, queuesGQL, {
    accountTag: config.accountId,
    filter: {
      datetime_geq: range.sinceISO,
      datetime_leq: range.untilISO,
    },
  });

  var rows =
    data?.viewer?.accounts?.[0]?.queueMessageOperationsAdaptiveGroups || [];

  // Aggregate by queueId
  var byQueue = {};
  for (var row of rows) {
    var id = row.dimensions.queueId;
    if (!byQueue[id]) byQueue[id] = 0;
    byQueue[id] += row.sum?.billableOperations || 0;
  }

  // Build items (include queues with zero usage)
  var items = queueList.map((q) => ({
    name: q.queue_name,
    usage: { operations: byQueue[q.queue_id] || 0 },
  }));

  var fleet = applyFreeTier(items, ["operations"], PRICING);

  // Detail mode
  if (name) {
    var item = fleet.items.find((i) => i.name === name);
    if (!item) {
      fatal(
        `Queue ${fmt.app(name)} not found.`,
        `Available: ${fleet.items.map((i) => i.name).join(", ")}`
      );
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            queue: item.name,
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            usage: item.usage,
            costs: item.costs,
            grossTotal: item.grossTotal,
            freeTierDiscount: item.freeTierDiscount,
            netTotal: item.netTotal,
          },
          null,
          2
        )
      );
      return;
    }

    var metrics = [
      { label: "Operations", usage: fmtUsage(item.usage.operations, "ops"), cost: fmtCost(item.costs.operations) },
    ];
    renderDetail(item.name, metrics, item, range);
    return;
  }

  // Fleet mode
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          period: range.label,
          since: range.sinceISO,
          until: range.untilISO,
          queues: fleet.items.map((item) => ({
            name: item.name,
            usage: item.usage,
            costs: item.costs,
            grossTotal: item.grossTotal,
            freeTierDiscount: item.freeTierDiscount,
            netTotal: item.netTotal,
          })),
          grossTotal: fleet.grossFleetTotal,
          freeTierDiscount: fleet.freeTierDiscount,
          netTotal: fleet.netFleetTotal,
        },
        null,
        2
      )
    );
    return;
  }

  // Human output
  console.log("");
  console.log(
    `  ${fmt.bold("Queues estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["QUEUE", "OPERATIONS", "COST"];
  var tableRows = fleet.items.map((item) => [
    fmt.app(item.name),
    fmtUsage(item.usage.operations, "ops"),
    fmtCost(item.grossTotal),
  ]);

  console.log(table(headers, tableRows));
  console.log("");

  var labelW = 36;
  console.log(
    "  " +
      fmt.dim("Subtotal".padEnd(labelW)) +
      fmtCost(fleet.grossFleetTotal)
  );
  if (fleet.freeTierDiscount > 0) {
    console.log(
      "  " +
        fmt.dim("Free tier".padEnd(labelW)) +
        fmt.dim("-" + fmtCost(fleet.freeTierDiscount))
    );
  }
  console.log("  " + fmt.dim("\u2500".repeat(labelW + 8)));
  console.log(
    "  " +
      fmt.bold("TOTAL".padEnd(labelW)) +
      fmt.bold(fmtCost(fleet.netFleetTotal))
  );
  console.log("");
  console.log(
    fmt.dim("  Estimates based on Cloudflare Workers Paid plan pricing.")
  );
  console.log("");
}
