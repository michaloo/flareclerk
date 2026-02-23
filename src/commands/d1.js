import { getConfig, listD1Databases, cfGraphQL } from "../lib/cf.js";
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
  rowsRead: { included: 25_000_000_000, rate: 0.001 / 1_000_000 },
  rowsWritten: { included: 50_000_000, rate: 1.00 / 1_000_000 },
  storageGb: { included: 5, rate: 0.75 },
};

// --- GraphQL ---

var queriesGQL = `query D1Queries($accountTag: string!, $filter: AccountD1QueriesAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1QueriesAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { databaseId }
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

var storageGQL = `query D1Storage($accountTag: string!, $filter: AccountD1StorageAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1StorageAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { databaseId }
        max { databaseSizeBytes }
      }
    }
  }
}`;

// --- Main command ---

export async function d1(name, options) {
  var config = getConfig();
  var range = parseDateRange(options.since);
  var prorata = daysFraction(range);

  phase("Listing D1 databases");
  var dbList;
  try {
    dbList = await listD1Databases(config);
  } catch (e) {
    fatal("Could not list D1 databases.", e.message);
  }
  if (dbList.length === 0) {
    fatal("No D1 databases found on this account.");
  }
  status(
    `Found ${dbList.length} database${dbList.length > 1 ? "s" : ""}`
  );

  // Build name map (uuid → name)
  var nameMap = {};
  for (var db of dbList) {
    nameMap[db.uuid] = db.name;
  }

  phase("Fetching analytics");
  var filter = {
    date_geq: range.sinceDate,
    date_leq: range.untilDate,
  };

  var [queriesData, storageData] = await Promise.all([
    cfGraphQL(config, queriesGQL, {
      accountTag: config.accountId,
      filter,
    }),
    cfGraphQL(config, storageGQL, {
      accountTag: config.accountId,
      filter,
    }),
  ]);

  var queryRows =
    queriesData?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups || [];
  var storageRows =
    storageData?.viewer?.accounts?.[0]?.d1StorageAdaptiveGroups || [];

  // Aggregate queries by databaseId
  var queryByDb = {};
  for (var row of queryRows) {
    var id = row.dimensions.databaseId;
    if (!queryByDb[id]) queryByDb[id] = { rowsRead: 0, rowsWritten: 0 };
    queryByDb[id].rowsRead += row.sum?.rowsRead || 0;
    queryByDb[id].rowsWritten += row.sum?.rowsWritten || 0;
  }

  // Aggregate storage by databaseId (max bytes)
  var storageByDb = {};
  for (var row of storageRows) {
    var id = row.dimensions.databaseId;
    var bytes = row.max?.databaseSizeBytes || 0;
    if (!storageByDb[id] || bytes > storageByDb[id]) {
      storageByDb[id] = bytes;
    }
  }

  // Build items
  var items = dbList.map((db) => {
    var q = queryByDb[db.uuid] || { rowsRead: 0, rowsWritten: 0 };
    var storageBytes = storageByDb[db.uuid] || 0;
    var storageGb = storageBytes / 1_000_000_000;

    return {
      name: db.name,
      storageBytes,
      usage: {
        rowsRead: q.rowsRead,
        rowsWritten: q.rowsWritten,
        storageGb: storageGb * prorata,
      },
    };
  });

  var fleet = applyFreeTier(
    items,
    ["rowsRead", "rowsWritten", "storageGb"],
    PRICING
  );

  // Detail mode
  if (name) {
    var item = fleet.items.find((i) => i.name === name);
    if (!item) {
      fatal(
        `Database ${fmt.app(name)} not found.`,
        `Available: ${fleet.items.map((i) => i.name).join(", ")}`
      );
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            database: item.name,
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            usage: {
              rowsRead: item.usage.rowsRead,
              rowsWritten: item.usage.rowsWritten,
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
      { label: "Rows read", usage: fmtUsage(item.usage.rowsRead, "rows"), cost: fmtCost(item.costs.rowsRead) },
      { label: "Rows written", usage: fmtUsage(item.usage.rowsWritten, "rows"), cost: fmtCost(item.costs.rowsWritten) },
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
          databases: fleet.items.map((item) => ({
            name: item.name,
            usage: {
              rowsRead: item.usage.rowsRead,
              rowsWritten: item.usage.rowsWritten,
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
    `  ${fmt.bold("D1 estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["DATABASE", "ROWS READ", "ROWS WRITTEN", "STORAGE", "COST"];
  var tableRows = fleet.items.map((item) => [
    fmt.app(item.name),
    fmtUsage(item.usage.rowsRead, "rows"),
    fmtUsage(item.usage.rowsWritten, "rows"),
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
