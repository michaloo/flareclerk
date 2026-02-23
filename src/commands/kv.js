import { getConfig, listKVNamespaces, cfGraphQL } from "../lib/cf.js";
import { phase, status, fatal, fmt, table } from "../lib/output.js";
import {
  parseDateRange,
  fmtCost,
  fmtUsage,
  fmtStorage,
  daysFraction,
  applyFreeTier,
  renderDetail,
} from "../lib/cost-utils.js";

// --- Pricing ---

var PRICING = {
  reads: { included: 10_000_000, rate: 0.50 / 1_000_000 },
  writes: { included: 1_000_000, rate: 5.00 / 1_000_000 },
  storageGb: { included: 1, rate: 0.50 },
};

// --- GraphQL ---

var opsGQL = `query KVOps($accountTag: string!, $filter: AccountKvOperationsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvOperationsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId actionType }
        sum { requests }
      }
    }
  }
}`;

var storageGQL = `query KVStorage($accountTag: string!, $filter: AccountKvStorageAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvStorageAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId }
        max { byteCount }
      }
    }
  }
}`;

// --- Main command ---

export async function kv(name, options) {
  var config = getConfig();
  var range = parseDateRange(options.since);
  var prorata = daysFraction(range);

  phase("Listing KV namespaces");
  var nsList;
  try {
    nsList = await listKVNamespaces(config);
  } catch (e) {
    fatal("Could not list KV namespaces.", e.message);
  }
  if (nsList.length === 0) {
    fatal("No KV namespaces found on this account.");
  }
  status(
    `Found ${nsList.length} namespace${nsList.length > 1 ? "s" : ""}`
  );

  // Build name map (id → title)
  var nameMap = {};
  for (var ns of nsList) {
    nameMap[ns.id] = ns.title;
  }

  phase("Fetching analytics");
  var filter = {
    date_geq: range.sinceDate,
    date_leq: range.untilDate,
  };

  var [opsData, storageData] = await Promise.all([
    cfGraphQL(config, opsGQL, {
      accountTag: config.accountId,
      filter,
    }),
    cfGraphQL(config, storageGQL, {
      accountTag: config.accountId,
      filter,
    }),
  ]);

  var opsRows =
    opsData?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups || [];
  var storageRows =
    storageData?.viewer?.accounts?.[0]?.kvStorageAdaptiveGroups || [];

  // Aggregate ops by namespace
  var opsByNs = {};
  for (var row of opsRows) {
    var id = row.dimensions.namespaceId;
    if (!opsByNs[id]) opsByNs[id] = { reads: 0, writes: 0 };
    var reqs = row.sum?.requests || 0;
    var action = row.dimensions.actionType;
    if (action === "read") {
      opsByNs[id].reads += reqs;
    } else {
      opsByNs[id].writes += reqs;
    }
  }

  // Aggregate storage by namespace (max bytes)
  var storageByNs = {};
  for (var row of storageRows) {
    var id = row.dimensions.namespaceId;
    var bytes = row.max?.byteCount || 0;
    if (!storageByNs[id] || bytes > storageByNs[id]) {
      storageByNs[id] = bytes;
    }
  }

  // Build items
  var items = nsList.map((ns) => {
    var ops = opsByNs[ns.id] || { reads: 0, writes: 0 };
    var storageBytes = storageByNs[ns.id] || 0;
    var storageGb = storageBytes / 1_000_000_000;

    return {
      name: ns.title,
      storageBytes,
      usage: {
        reads: ops.reads,
        writes: ops.writes,
        storageGb: storageGb * prorata,
      },
    };
  });

  var fleet = applyFreeTier(items, ["reads", "writes", "storageGb"], PRICING);

  // Detail mode
  if (name) {
    var item = fleet.items.find((i) => i.name === name);
    if (!item) {
      fatal(
        `Namespace ${fmt.app(name)} not found.`,
        `Available: ${fleet.items.map((i) => i.name).join(", ")}`
      );
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            namespace: item.name,
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            usage: {
              reads: item.usage.reads,
              writes: item.usage.writes,
              storageBytes: item.storageBytes,
            },
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
      { label: "Reads", usage: fmtUsage(item.usage.reads, "reads"), cost: fmtCost(item.costs.reads) },
      { label: "Writes", usage: fmtUsage(item.usage.writes, "writes"), cost: fmtCost(item.costs.writes) },
      { label: "Storage", usage: fmtStorage(item.storageBytes), cost: fmtCost(item.costs.storageGb) },
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
          namespaces: fleet.items.map((item) => ({
            name: item.name,
            usage: {
              reads: item.usage.reads,
              writes: item.usage.writes,
              storageBytes: item.storageBytes,
            },
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
    `  ${fmt.bold("KV estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["NAMESPACE", "READS", "WRITES", "STORAGE", "COST"];
  var tableRows = fleet.items.map((item) => [
    fmt.app(item.name),
    fmtUsage(item.usage.reads, "reads"),
    fmtUsage(item.usage.writes, "writes"),
    fmtStorage(item.storageBytes),
    fmtCost(item.grossTotal),
  ]);

  console.log(table(headers, tableRows));
  console.log("");

  var labelW = 56;
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
