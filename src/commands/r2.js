import { getConfig, listR2Buckets, cfGraphQL } from "../lib/cf.js";
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
  classAOps: { included: 1_000_000, rate: 4.50 / 1_000_000 },
  classBOps: { included: 10_000_000, rate: 0.36 / 1_000_000 },
  storageGb: { included: 10, rate: 0.015 },
};

// Class A (mutating) action types
var CLASS_A_ACTIONS = new Set([
  "PutObject",
  "CopyObject",
  "DeleteObject",
  "DeleteObjects",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "UploadPart",
  "UploadPartCopy",
  "PutBucketLifecycleConfiguration",
  "PutBucketCors",
  "ListMultipartUploads",
  "ListParts",
  "ListBuckets",
  "ListObjects",
  "ListObjectsV2",
]);

// --- GraphQL ---

var opsGQL = `query R2Ops($accountTag: string!, $filter: AccountR2OperationsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { bucketName actionType }
        sum { requests }
      }
    }
  }
}`;

var storageGQL = `query R2Storage($accountTag: string!, $filter: AccountR2StorageAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2StorageAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { bucketName }
        max { payloadSize metadataSize }
      }
    }
  }
}`;

// --- Main command ---

export async function r2(name, options) {
  var config = getConfig();
  var range = parseDateRange(options.since);
  var prorata = daysFraction(range);

  phase("Listing R2 buckets");
  var bucketList;
  try {
    bucketList = await listR2Buckets(config);
  } catch (e) {
    fatal("Could not list R2 buckets.", e.message);
  }
  if (bucketList.length === 0) {
    fatal("No R2 buckets found on this account.");
  }
  status(
    `Found ${bucketList.length} bucket${bucketList.length > 1 ? "s" : ""}`
  );

  phase("Fetching analytics");
  var filter = {
    datetime_geq: range.sinceISO,
    datetime_leq: range.untilISO,
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
    opsData?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups || [];
  var storageRows =
    storageData?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups || [];

  // Aggregate ops by bucket
  var opsByBucket = {};
  for (var row of opsRows) {
    var bname = row.dimensions.bucketName;
    if (!opsByBucket[bname]) opsByBucket[bname] = { classA: 0, classB: 0 };
    var reqs = row.sum?.requests || 0;
    if (CLASS_A_ACTIONS.has(row.dimensions.actionType)) {
      opsByBucket[bname].classA += reqs;
    } else {
      opsByBucket[bname].classB += reqs;
    }
  }

  // Aggregate storage by bucket (max bytes)
  var storageByBucket = {};
  for (var row of storageRows) {
    var bname = row.dimensions.bucketName;
    var bytes = (row.max?.payloadSize || 0) + (row.max?.metadataSize || 0);
    if (!storageByBucket[bname] || bytes > storageByBucket[bname]) {
      storageByBucket[bname] = bytes;
    }
  }

  // Build items
  var bucketNames = new Set(bucketList.map((b) => b.name));
  for (var key of Object.keys(opsByBucket)) bucketNames.add(key);
  for (var key of Object.keys(storageByBucket)) bucketNames.add(key);

  var items = [...bucketNames].map((bname) => {
    var ops = opsByBucket[bname] || { classA: 0, classB: 0 };
    var storageBytes = storageByBucket[bname] || 0;
    var storageGb = storageBytes / 1_000_000_000;

    return {
      name: bname,
      storageBytes,
      usage: {
        classAOps: ops.classA,
        classBOps: ops.classB,
        storageGb: storageGb * prorata,
      },
    };
  });

  var fleet = applyFreeTier(items, ["classAOps", "classBOps", "storageGb"], PRICING);

  // Detail mode
  if (name) {
    var item = fleet.items.find((i) => i.name === name);
    if (!item) {
      fatal(
        `Bucket ${fmt.app(name)} not found.`,
        `Available: ${fleet.items.map((i) => i.name).join(", ")}`
      );
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            bucket: item.name,
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            usage: {
              classAOps: item.usage.classAOps,
              classBOps: item.usage.classBOps,
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
      { label: "Class A ops", usage: fmtUsage(item.usage.classAOps, "ops"), cost: fmtCost(item.costs.classAOps) },
      { label: "Class B ops", usage: fmtUsage(item.usage.classBOps, "ops"), cost: fmtCost(item.costs.classBOps) },
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
          buckets: fleet.items.map((item) => ({
            name: item.name,
            usage: {
              classAOps: item.usage.classAOps,
              classBOps: item.usage.classBOps,
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
    `  ${fmt.bold("R2 estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["BUCKET", "CLASS A OPS", "CLASS B OPS", "STORAGE", "COST"];
  var tableRows = fleet.items.map((item) => [
    fmt.app(item.name),
    fmtUsage(item.usage.classAOps, "ops"),
    fmtUsage(item.usage.classBOps, "ops"),
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
