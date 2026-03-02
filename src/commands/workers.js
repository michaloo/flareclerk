import {
  getConfig,
  discoverWorker,
  listWorkerScripts,
  listContainerApps,
  listD1Databases,
  listKVNamespaces,
  getWorkerSettings,
  cfApi,
  cfGraphQL,
} from "../lib/cf.js";
import { phase, status, fatal, fmt, table } from "../lib/output.js";
import { parseDateRange, fmtCost, fmtUsage, fmtStorage, daysFraction } from "../lib/cost-utils.js";
import kleur from "kleur";

// --- Pricing (Workers Paid plan, $5/mo) ---

var PRICING = {
  workerRequests: { included: 10_000_000, rate: 0.30 / 1_000_000 },
  workerCpuMs: { included: 30_000_000, rate: 0.02 / 1_000_000 },
  doRequests: { included: 1_000_000, rate: 0.15 / 1_000_000 },
  doGbSeconds: { included: 400_000, rate: 12.50 / 1_000_000 },
  containerVcpuSec: { included: 375 * 60, rate: 0.000020 },
  containerMemGibSec: { included: 25 * 3600, rate: 0.0000025 },
  containerDiskGbSec: { included: 200 * 3600, rate: 0.00000007 },
  containerEgressGb: { included: 0, rate: 0.025 },
  d1RowsRead: { included: 25_000_000_000, rate: 0.001 / 1_000_000 },
  d1RowsWritten: { included: 50_000_000, rate: 1.00 / 1_000_000 },
  d1StorageGb: { included: 5, rate: 0.75 },
  kvReads: { included: 10_000_000, rate: 0.50 / 1_000_000 },
  kvWrites: { included: 1_000_000, rate: 5.00 / 1_000_000 },
  kvStorageGb: { included: 1, rate: 0.50 },
  platform: 5.0,
};

var METRIC_KEYS = [
  "workerRequests",
  "workerCpuMs",
  "doRequests",
  "doGbSeconds",
  "containerVcpuSec",
  "containerMemGibSec",
  "containerDiskGbSec",
  "containerEgressGb",
  "d1RowsRead",
  "d1RowsWritten",
  "d1StorageGb",
  "kvReads",
  "kvWrites",
  "kvStorageGb",
];

// --- GraphQL query strings ---

var workersGQL = `query Workers($accountTag: string!, $filter: WorkersInvocationsAdaptiveFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 10000, filter: $filter) {
        dimensions { scriptName }
        sum { requests cpuTimeUs }
        avg { sampleInterval }
      }
    }
  }
}`;

var doRequestsGQL = `query DORequests($accountTag: string!, $filter: DurableObjectsInvocationsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId }
        sum { requests }
        avg { sampleInterval }
      }
    }
  }
}`;

var doDurationGQL = `query DODuration($accountTag: string!, $filter: DurableObjectsPeriodicGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId }
        sum { activeTime inboundWebsocketMsgCount }
      }
    }
  }
}`;

var containersGQL = `query Containers($accountTag: string!, $filter: AccountContainersMetricsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersMetricsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { applicationId }
        sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
      }
    }
  }
}`;

var d1QueriesGQL = `query D1Queries($accountTag: string!, $filter: AccountD1QueriesAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1QueriesAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { databaseId }
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

var d1StorageGQL = `query D1Storage($accountTag: string!, $filter: AccountD1StorageAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1StorageAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { databaseId }
        max { databaseSizeBytes }
      }
    }
  }
}`;

var kvOpsGQL = `query KVOps($accountTag: string!, $filter: AccountKvOperationsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvOperationsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId actionType }
        sum { requests }
      }
    }
  }
}`;

var kvStorageGQL = `query KVStorage($accountTag: string!, $filter: AccountKvStorageAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvStorageAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId }
        max { byteCount }
      }
    }
  }
}`;

var containerLiveGQL = `query($accountTag: string!, $filter: AccountContainersMetricsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersMetricsAdaptiveGroups(limit: 1000, filter: $filter) {
        dimensions { applicationId region active durableObjectId }
        avg { cpuLoad memory }
      }
    }
  }
}`;

// --- Fleet discovery ---

async function discoverFleet(config) {
  var [scripts, doNamespaces, containerApps, d1Databases, kvNamespaces] = await Promise.all([
    listWorkerScripts(config),
    cfApi(
      "GET",
      `/accounts/${config.accountId}/workers/durable_objects/namespaces`,
      null,
      config.apiToken
    ).then((r) => r.result || []),
    listContainerApps(config),
    listD1Databases(config),
    listKVNamespaces(config),
  ]);

  // Fetch settings for all workers to discover D1/KV bindings
  var settingsMap = {};
  await Promise.all(
    scripts.map(async (s) => {
      try {
        var settings = await getWorkerSettings(config, s.id);
        settingsMap[s.id] = settings?.bindings || [];
      } catch {
        settingsMap[s.id] = [];
      }
    })
  );

  // Map script → namespaceIds
  var nsByScript = {};
  for (var ns of doNamespaces) {
    if (!nsByScript[ns.script]) nsByScript[ns.script] = [];
    nsByScript[ns.script].push(ns.id);
  }

  // Map namespaceId → containerAppId
  var containerByNs = {};
  for (var ca of containerApps) {
    if (ca.durable_objects?.namespace_id) {
      containerByNs[ca.durable_objects.namespace_id] = ca.id;
    }
  }

  // Build worker list from all scripts
  var workers = scripts.map((s) => {
    var nsIds = nsByScript[s.id] || [];
    var containerAppId = null;
    var namespaceId = null;
    for (var nsId of nsIds) {
      if (containerByNs[nsId]) {
        containerAppId = containerByNs[nsId];
        namespaceId = nsId;
        break;
      }
    }
    // If no container, just use first namespace
    if (!namespaceId && nsIds.length > 0) namespaceId = nsIds[0];

    // D1/KV bindings from worker settings
    var bindings = settingsMap[s.id] || [];
    var d1DatabaseIds = bindings
      .filter((b) => b.type === "d1")
      .map((b) => b.id)
      .filter(Boolean);
    var kvNamespaceIds = bindings
      .filter((b) => b.type === "kv_namespace")
      .map((b) => b.namespace_id)
      .filter(Boolean);

    return {
      scriptName: s.id,
      namespaceId,
      containerAppId,
      d1DatabaseIds,
      kvNamespaceIds,
    };
  });

  return workers;
}

// --- Aggregate raw GraphQL results per worker ---

function aggregateResults(workers, analytics, prorata) {
  var { workersData, doReqData, doDurData, containersData, d1QueriesData, d1StorageData, kvOpsData, kvStorageData } = analytics;

  var workerRows =
    workersData?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  var workersByScript = {};
  for (var row of workerRows) {
    var sn = row.dimensions.scriptName;
    var si = row.avg?.sampleInterval || 1;
    if (!workersByScript[sn])
      workersByScript[sn] = { requests: 0, cpuMs: 0 };
    workersByScript[sn].requests += (row.sum?.requests || 0) * si;
    workersByScript[sn].cpuMs += ((row.sum?.cpuTimeUs || 0) / 1000) * si;
  }

  var doReqRows =
    doReqData?.viewer?.accounts?.[0]
      ?.durableObjectsInvocationsAdaptiveGroups || [];
  var doReqByNs = {};
  for (var row of doReqRows) {
    var ns = row.dimensions.namespaceId;
    var si = row.avg?.sampleInterval || 1;
    if (!doReqByNs[ns]) doReqByNs[ns] = 0;
    doReqByNs[ns] += (row.sum?.requests || 0) * si;
  }

  var doDurRows =
    doDurData?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups || [];
  var doDurByNs = {};
  for (var row of doDurRows) {
    var ns = row.dimensions.namespaceId;
    if (!doDurByNs[ns]) doDurByNs[ns] = { activeTime: 0, wsInbound: 0 };
    doDurByNs[ns].activeTime += row.sum?.activeTime || 0;
    doDurByNs[ns].wsInbound += row.sum?.inboundWebsocketMsgCount || 0;
  }

  var containerRows =
    containersData?.viewer?.accounts?.[0]
      ?.containersMetricsAdaptiveGroups || [];
  var containersByAppId = {};
  for (var row of containerRows) {
    var appId = row.dimensions.applicationId;
    if (!containersByAppId[appId]) {
      containersByAppId[appId] = {
        cpuTimeSec: 0,
        allocatedMemory: 0,
        allocatedDisk: 0,
        txBytes: 0,
      };
    }
    containersByAppId[appId].cpuTimeSec += row.sum?.cpuTimeSec || 0;
    containersByAppId[appId].allocatedMemory +=
      row.sum?.allocatedMemory || 0;
    containersByAppId[appId].allocatedDisk += row.sum?.allocatedDisk || 0;
    containersByAppId[appId].txBytes += row.sum?.txBytes || 0;
  }

  // D1 queries by databaseId
  var d1QueryRows =
    d1QueriesData?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups || [];
  var d1QueryByDb = {};
  for (var row of d1QueryRows) {
    var id = row.dimensions.databaseId;
    if (!d1QueryByDb[id]) d1QueryByDb[id] = { rowsRead: 0, rowsWritten: 0 };
    d1QueryByDb[id].rowsRead += row.sum?.rowsRead || 0;
    d1QueryByDb[id].rowsWritten += row.sum?.rowsWritten || 0;
  }

  // D1 storage by databaseId (max bytes)
  var d1StorageRows =
    d1StorageData?.viewer?.accounts?.[0]?.d1StorageAdaptiveGroups || [];
  var d1StorageByDb = {};
  for (var row of d1StorageRows) {
    var id = row.dimensions.databaseId;
    var bytes = row.max?.databaseSizeBytes || 0;
    if (!d1StorageByDb[id] || bytes > d1StorageByDb[id]) {
      d1StorageByDb[id] = bytes;
    }
  }

  // KV ops by namespaceId
  var kvOpsRows =
    kvOpsData?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups || [];
  var kvOpsByNs = {};
  for (var row of kvOpsRows) {
    var id = row.dimensions.namespaceId;
    if (!kvOpsByNs[id]) kvOpsByNs[id] = { reads: 0, writes: 0 };
    var reqs = row.sum?.requests || 0;
    if (row.dimensions.actionType === "read") {
      kvOpsByNs[id].reads += reqs;
    } else {
      kvOpsByNs[id].writes += reqs;
    }
  }

  // KV storage by namespaceId (max bytes)
  var kvStorageRows =
    kvStorageData?.viewer?.accounts?.[0]?.kvStorageAdaptiveGroups || [];
  var kvStorageByNs = {};
  for (var row of kvStorageRows) {
    var id = row.dimensions.namespaceId;
    var bytes = row.max?.byteCount || 0;
    if (!kvStorageByNs[id] || bytes > kvStorageByNs[id]) {
      kvStorageByNs[id] = bytes;
    }
  }

  return workers.map((w) => {
    var scriptName = w.scriptName;
    var wd = workersByScript[scriptName] || { requests: 0, cpuMs: 0 };
    var nsId = w.namespaceId;

    var doDuration = nsId ? doDurByNs[nsId] || {} : {};
    var doRequests =
      (nsId ? doReqByNs[nsId] || 0 : 0) +
      (doDuration.wsInbound || 0) / 20;

    var c = w.containerAppId
      ? containersByAppId[w.containerAppId] || {}
      : {};
    var containerVcpuSec = c.cpuTimeSec || 0;
    var containerMemGibSec =
      (c.allocatedMemory || 0) / (1024 * 1024 * 1024);
    var containerDiskGbSec = (c.allocatedDisk || 0) / 1_000_000_000;
    var containerEgressGb = (c.txBytes || 0) / 1_000_000_000;

    // D1: sum across all bound databases
    var d1RowsRead = 0, d1RowsWritten = 0, d1StorageBytes = 0;
    for (var dbId of w.d1DatabaseIds || []) {
      var dq = d1QueryByDb[dbId] || {};
      d1RowsRead += dq.rowsRead || 0;
      d1RowsWritten += dq.rowsWritten || 0;
      d1StorageBytes = Math.max(d1StorageBytes, d1StorageByDb[dbId] || 0);
    }
    var d1StorageGb = (d1StorageBytes / 1_000_000_000) * prorata;

    // KV: sum across all bound namespaces
    var kvReads = 0, kvWrites = 0, kvStorageBytes = 0;
    for (var kvNsId of w.kvNamespaceIds || []) {
      var ko = kvOpsByNs[kvNsId] || {};
      kvReads += ko.reads || 0;
      kvWrites += ko.writes || 0;
      kvStorageBytes = Math.max(kvStorageBytes, kvStorageByNs[kvNsId] || 0);
    }
    var kvStorageGb = (kvStorageBytes / 1_000_000_000) * prorata;

    return {
      name: scriptName,
      d1StorageBytes,
      kvStorageBytes,
      usage: {
        workerRequests: Math.round(wd.requests),
        workerCpuMs: Math.round(wd.cpuMs),
        doRequests: Math.round(doRequests),
        doWsMsgs: Math.round(doDuration.wsInbound || 0),
        doGbSeconds: Math.round(
          ((doDuration.activeTime || 0) / 1_000_000) * (128 / 1024)
        ),
        containerVcpuSec,
        containerMemGibSec,
        containerDiskGbSec,
        containerEgressGb,
        d1RowsRead,
        d1RowsWritten,
        d1StorageGb,
        kvReads,
        kvWrites,
        kvStorageGb,
      },
    };
  });
}

// --- Cost calculation + free tier (local, wraps 8 metric keys) ---

function calculateAppCosts(usage) {
  return {
    workerRequests: usage.workerRequests * PRICING.workerRequests.rate,
    workerCpuMs: usage.workerCpuMs * PRICING.workerCpuMs.rate,
    doRequests: usage.doRequests * PRICING.doRequests.rate,
    doGbSeconds: usage.doGbSeconds * PRICING.doGbSeconds.rate,
    containerVcpuSec:
      usage.containerVcpuSec * PRICING.containerVcpuSec.rate,
    containerMemGibSec:
      usage.containerMemGibSec * PRICING.containerMemGibSec.rate,
    containerDiskGbSec:
      usage.containerDiskGbSec * PRICING.containerDiskGbSec.rate,
    containerEgressGb:
      usage.containerEgressGb * PRICING.containerEgressGb.rate,
    d1RowsRead: usage.d1RowsRead * PRICING.d1RowsRead.rate,
    d1RowsWritten: usage.d1RowsWritten * PRICING.d1RowsWritten.rate,
    d1StorageGb: usage.d1StorageGb * PRICING.d1StorageGb.rate,
    kvReads: usage.kvReads * PRICING.kvReads.rate,
    kvWrites: usage.kvWrites * PRICING.kvWrites.rate,
    kvStorageGb: usage.kvStorageGb * PRICING.kvStorageGb.rate,
  };
}

function applyFreeTier(appResults) {
  var totals = {};
  for (var key of METRIC_KEYS) totals[key] = 0;
  for (var app of appResults) {
    for (var key of METRIC_KEYS) {
      totals[key] += app.usage[key];
    }
  }

  var fleetOverage = {};
  for (var key of METRIC_KEYS) {
    var included = PRICING[key].included;
    var overageUsage = Math.max(0, totals[key] - included);
    fleetOverage[key] = overageUsage * PRICING[key].rate;
  }

  var grossFleetTotal = 0;
  for (var app of appResults) {
    var costs = calculateAppCosts(app.usage);
    app.grossCosts = costs;
    var appGross = Object.values(costs).reduce((a, b) => a + b, 0);
    app.grossTotal = appGross;
    grossFleetTotal += appGross;
  }

  var netFleetTotal = Object.values(fleetOverage).reduce(
    (a, b) => a + b,
    0
  );
  var freeTierDiscount = grossFleetTotal - netFleetTotal;

  for (var app of appResults) {
    if (grossFleetTotal > 0) {
      var share = app.grossTotal / grossFleetTotal;
      app.freeTierDiscount = freeTierDiscount * share;
    } else {
      app.freeTierDiscount = 0;
    }
    app.netTotal = Math.max(0, app.grossTotal - app.freeTierDiscount);

    app.workersCost =
      app.grossCosts.workerRequests + app.grossCosts.workerCpuMs;
    app.doCost = app.grossCosts.doRequests + app.grossCosts.doGbSeconds;
    app.containerCost =
      app.grossCosts.containerVcpuSec +
      app.grossCosts.containerMemGibSec +
      app.grossCosts.containerDiskGbSec +
      app.grossCosts.containerEgressGb;
    app.d1Cost =
      app.grossCosts.d1RowsRead +
      app.grossCosts.d1RowsWritten +
      app.grossCosts.d1StorageGb;
    app.kvCost =
      app.grossCosts.kvReads +
      app.grossCosts.kvWrites +
      app.grossCosts.kvStorageGb;
  }

  return { appResults, freeTierDiscount, netFleetTotal, grossFleetTotal };
}

// --- Formatting helpers ---

function fmtDuration(seconds) {
  var hrs = seconds / 3600;
  if (hrs >= 1) return hrs.toFixed(1) + " vCPU-hrs";
  var mins = seconds / 60;
  return mins.toFixed(1) + " vCPU-min";
}

function fmtGibHours(gibSec) {
  var hrs = gibSec / 3600;
  if (hrs >= 1) return hrs.toFixed(1) + " GiB-hrs";
  var mins = gibSec / 60;
  return mins.toFixed(1) + " GiB-min";
}

function fmtGbHours(gbSec) {
  var hrs = gbSec / 3600;
  if (hrs >= 1) return hrs.toFixed(1) + " GB-hrs";
  var mins = gbSec / 60;
  return mins.toFixed(1) + " GB-min";
}

// --- Fetch historical analytics ---

async function fetchAnalytics(config, workers, range) {
  var scriptNames = workers.map((w) => w.scriptName);
  var namespaceIds = workers
    .map((w) => w.namespaceId)
    .filter(Boolean);
  var containerAppIds = workers
    .map((w) => w.containerAppId)
    .filter(Boolean);
  var d1DatabaseIds = [...new Set(workers.flatMap((w) => w.d1DatabaseIds || []))];
  var kvNamespaceIds = [...new Set(workers.flatMap((w) => w.kvNamespaceIds || []))];

  var queries = [];

  queries.push(
    cfGraphQL(config, workersGQL, {
      accountTag: config.accountId,
      filter: {
        datetimeHour_geq: range.sinceISO,
        datetimeHour_leq: range.untilISO,
        scriptName_in: scriptNames,
      },
    })
  );

  if (namespaceIds.length > 0) {
    var doFilter = {
      datetimeHour_geq: range.sinceISO,
      datetimeHour_leq: range.untilISO,
      namespaceId_in: namespaceIds,
    };
    queries.push(
      cfGraphQL(config, doRequestsGQL, {
        accountTag: config.accountId,
        filter: doFilter,
      })
    );
    queries.push(
      cfGraphQL(config, doDurationGQL, {
        accountTag: config.accountId,
        filter: doFilter,
      })
    );
  } else {
    queries.push(Promise.resolve(null), Promise.resolve(null));
  }

  if (containerAppIds.length > 0) {
    queries.push(
      cfGraphQL(config, containersGQL, {
        accountTag: config.accountId,
        filter: {
          datetimeHour_geq: range.sinceISO,
          datetimeHour_leq: range.untilISO,
          applicationId_in: containerAppIds,
        },
      })
    );
  } else {
    queries.push(Promise.resolve(null));
  }

  // D1 queries
  var dateFilter = {
    date_geq: range.sinceDate,
    date_leq: range.untilDate,
  };
  if (d1DatabaseIds.length > 0) {
    queries.push(
      cfGraphQL(config, d1QueriesGQL, {
        accountTag: config.accountId,
        filter: dateFilter,
      })
    );
    queries.push(
      cfGraphQL(config, d1StorageGQL, {
        accountTag: config.accountId,
        filter: dateFilter,
      })
    );
  } else {
    queries.push(Promise.resolve(null), Promise.resolve(null));
  }

  // KV queries
  if (kvNamespaceIds.length > 0) {
    queries.push(
      cfGraphQL(config, kvOpsGQL, {
        accountTag: config.accountId,
        filter: dateFilter,
      })
    );
    queries.push(
      cfGraphQL(config, kvStorageGQL, {
        accountTag: config.accountId,
        filter: dateFilter,
      })
    );
  } else {
    queries.push(Promise.resolve(null), Promise.resolve(null));
  }

  var [workersData, doReqData, doDurData, containersData, d1QueriesData, d1StorageData, kvOpsData, kvStorageData] =
    await Promise.all(queries);
  return { workersData, doReqData, doDurData, containersData, d1QueriesData, d1StorageData, kvOpsData, kvStorageData };
}

// --- Fetch live container metrics ---

async function fetchContainerMetrics(config, containerAppId) {
  if (!containerAppId) return [];
  var now = new Date();
  var since = new Date(now.getTime() - 15 * 60000);
  try {
    var data = await cfGraphQL(config, containerLiveGQL, {
      accountTag: config.accountId,
      filter: {
        datetimeFiveMinutes_geq: since.toISOString().slice(0, 19) + "Z",
        datetimeFiveMinutes_leq: now.toISOString().slice(0, 19) + "Z",
        applicationId_in: [containerAppId],
      },
    });
    return (
      data?.viewer?.accounts?.[0]?.containersMetricsAdaptiveGroups || []
    );
  } catch {
    return [];
  }
}

// --- Render fleet ---

function renderFleet(fleet, range) {
  console.log("");
  console.log(
    `  ${fmt.bold("Workers estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["NAME", "WORKERS", "DO", "CONTAINERS", "D1", "KV", "COST"];
  var rows = fleet.appResults.map((a) => [
    fmt.app(a.name),
    fmtCost(a.workersCost),
    fmtCost(a.doCost),
    fmtCost(a.containerCost),
    fmtCost(a.d1Cost),
    fmtCost(a.kvCost),
    fmtCost(a.grossTotal),
  ]);

  console.log(table(headers, rows));
  console.log("");

  var labelW = 60;
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
  console.log(
    "  " + fmt.dim("Platform".padEnd(labelW)) + fmtCost(PRICING.platform)
  );
  console.log("  " + fmt.dim("\u2500".repeat(labelW + 8)));
  console.log(
    "  " +
      fmt.bold("TOTAL".padEnd(labelW)) +
      fmt.bold(fmtCost(fleet.netFleetTotal + PRICING.platform))
  );
  console.log("");
  console.log(
    fmt.dim("  Estimates based on Cloudflare Workers Paid plan pricing.")
  );
  console.log("");
}

// --- Render single worker (detail) ---

function renderSingleWorker(app, range) {
  console.log("");
  console.log(
    `  ${fmt.app(app.name)} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var header = "  COMPONENT      USAGE                 ESTIMATED COST";
  var sep = "  " + "\u2500".repeat(50);

  console.log(fmt.bold(header));
  console.log(fmt.dim(sep));

  var rows = [
    [
      "Workers",
      fmtUsage(app.usage.workerRequests, "requests"),
      fmtCost(app.grossCosts.workerRequests),
    ],
    [
      "",
      fmtUsage(app.usage.workerCpuMs, "CPU-ms"),
      fmtCost(app.grossCosts.workerCpuMs),
    ],
    [
      "Durable Obj",
      fmtUsage(app.usage.doRequests, "requests"),
      fmtCost(app.grossCosts.doRequests),
    ],
    app.usage.doWsMsgs > 0
      ? [
          "",
          fmtUsage(app.usage.doWsMsgs, "WS msgs") + fmt.dim(" (20:1)"),
          "",
        ]
      : null,
    [
      "",
      fmtUsage(app.usage.doGbSeconds, "GB-s"),
      fmtCost(app.grossCosts.doGbSeconds),
    ],
    [
      "Containers",
      fmtDuration(app.usage.containerVcpuSec),
      fmtCost(app.grossCosts.containerVcpuSec),
    ],
    [
      "",
      fmtGibHours(app.usage.containerMemGibSec) + " mem",
      fmtCost(app.grossCosts.containerMemGibSec),
    ],
    [
      "",
      fmtGbHours(app.usage.containerDiskGbSec) + " disk",
      fmtCost(app.grossCosts.containerDiskGbSec),
    ],
    [
      "",
      fmtUsage(app.usage.containerEgressGb, "GB egress"),
      fmtCost(app.grossCosts.containerEgressGb),
    ],
    [
      "D1",
      fmtUsage(app.usage.d1RowsRead, "rows read"),
      fmtCost(app.grossCosts.d1RowsRead),
    ],
    [
      "",
      fmtUsage(app.usage.d1RowsWritten, "rows written"),
      fmtCost(app.grossCosts.d1RowsWritten),
    ],
    [
      "",
      fmtStorage(app.d1StorageBytes) + " storage",
      fmtCost(app.grossCosts.d1StorageGb),
    ],
    [
      "KV",
      fmtUsage(app.usage.kvReads, "reads"),
      fmtCost(app.grossCosts.kvReads),
    ],
    [
      "",
      fmtUsage(app.usage.kvWrites, "writes"),
      fmtCost(app.grossCosts.kvWrites),
    ],
    [
      "",
      fmtStorage(app.kvStorageBytes) + " storage",
      fmtCost(app.grossCosts.kvStorageGb),
    ],
  ];

  for (var row of rows.filter(Boolean)) {
    var comp = row[0] ? fmt.bold(row[0].padEnd(14)) : " ".repeat(14);
    var usage = row[1].padEnd(22);
    console.log(`  ${comp} ${usage} ${row[2]}`);
  }

  console.log(fmt.dim(sep));
  console.log(
    `  ${" ".repeat(14)} ${"".padEnd(22)} ${fmt.bold(fmtCost(app.grossTotal))}`
  );

  if (app.freeTierDiscount > 0) {
    console.log(
      `  ${" ".repeat(14)} ${fmt.dim("Free tier".padEnd(22))} ${fmt.dim("-" + fmtCost(app.freeTierDiscount))}`
    );
    console.log(
      `  ${" ".repeat(14)} ${fmt.bold("Net".padEnd(22))} ${fmt.bold(fmtCost(app.netTotal))}`
    );
  }
}

// --- Render live containers ---

function renderLiveContainers(containers) {
  console.log("");
  console.log(`  ${fmt.bold("Live containers:")}`);

  if (containers.length > 0) {
    var headers = ["", "REGION", "ID", "CPU", "MEMORY"];
    var rows = containers.map((c) => [
      kleur.green("\u25CF"),
      c.region,
      c.doId.slice(0, 8),
      (c.cpuLoad * 100).toFixed(1) + "%",
      (c.memory / 1024 / 1024).toFixed(0) + " MiB",
    ]);
    console.log(table(headers, rows));
  } else {
    console.log(fmt.dim("  No active containers (worker may be sleeping)"));
  }

  console.log("");
}

// --- Main command ---

export async function workers(name, options) {
  var config = getConfig();
  var range = parseDateRange(options.since);
  var prorata = daysFraction(range);

  if (name) {
    // --- Detail mode ---
    phase("Discovering worker");
    var worker;
    try {
      worker = await discoverWorker(config, name);
    } catch (e) {
      fatal(`Could not find worker ${fmt.app(name)}.`, e.message);
    }

    // Discover D1/KV bindings from worker settings
    try {
      var settings = await getWorkerSettings(config, name);
      var bindings = settings?.bindings || [];
      worker.d1DatabaseIds = bindings
        .filter((b) => b.type === "d1")
        .map((b) => b.id)
        .filter(Boolean);
      worker.kvNamespaceIds = bindings
        .filter((b) => b.type === "kv_namespace")
        .map((b) => b.namespace_id)
        .filter(Boolean);
    } catch {
      worker.d1DatabaseIds = [];
      worker.kvNamespaceIds = [];
    }
    status(`Worker: ${name}`);

    phase("Fetching analytics");
    var [analytics, liveMetrics] = await Promise.all([
      fetchAnalytics(config, [worker], range),
      fetchContainerMetrics(config, worker.containerAppId),
    ]);

    var appResults = aggregateResults([worker], analytics, prorata);
    var fleet = applyFreeTier(appResults);
    var app = fleet.appResults[0];

    // Aggregate live containers
    var containers = [];
    for (var row of liveMetrics) {
      var dim = row.dimensions;
      if (!dim.active) continue;
      var existing = containers.find(
        (c) => c.region === dim.region && c.doId === dim.durableObjectId
      );
      if (existing) {
        existing.cpuSamples++;
        existing.cpuLoad += row.avg?.cpuLoad || 0;
        existing.memory += row.avg?.memory || 0;
      } else {
        containers.push({
          region: dim.region,
          doId: dim.durableObjectId,
          cpuLoad: row.avg?.cpuLoad || 0,
          memory: row.avg?.memory || 0,
          cpuSamples: 1,
        });
      }
    }
    for (var c of containers) {
      c.cpuLoad = c.cpuLoad / c.cpuSamples;
      c.memory = c.memory / c.cpuSamples;
    }
    containers.sort(
      (a, b) =>
        a.region.localeCompare(b.region) || a.doId.localeCompare(b.doId)
    );

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            worker: app.name,
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            usage: app.usage,
            costs: app.grossCosts,
            grossTotal: app.grossTotal,
            freeTierDiscount: app.freeTierDiscount,
            netTotal: app.netTotal,
            liveContainers: containers.map((c) => ({
              region: c.region,
              id: c.doId,
              cpu: +(c.cpuLoad * 100).toFixed(1),
              memoryMiB: +(c.memory / 1024 / 1024).toFixed(0),
            })),
          },
          null,
          2
        )
      );
      return;
    }

    renderSingleWorker(app, range);
    if (worker.containerAppId) {
      renderLiveContainers(containers);
    } else {
      console.log("");
    }
  } else {
    // --- Fleet mode ---
    phase("Discovering workers");
    var fleetWorkers;
    try {
      fleetWorkers = await discoverFleet(config);
    } catch (e) {
      fatal("Could not list workers.", e.message);
    }
    if (fleetWorkers.length === 0) {
      fatal("No workers found on this account.");
    }
    status(
      `Found ${fleetWorkers.length} worker${fleetWorkers.length > 1 ? "s" : ""}`
    );
    fleetWorkers.sort((a, b) => a.scriptName.localeCompare(b.scriptName));

    phase("Fetching analytics");
    status(
      `Querying ${fleetWorkers.length} worker${fleetWorkers.length > 1 ? "s" : ""}...`
    );

    var analytics = await fetchAnalytics(config, fleetWorkers, range);
    var appResults = aggregateResults(fleetWorkers, analytics, prorata);
    var fleet = applyFreeTier(appResults);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            workers: fleet.appResults.map((a) => ({
              name: a.name,
              usage: a.usage,
              costs: a.grossCosts,
              grossTotal: a.grossTotal,
              freeTierDiscount: a.freeTierDiscount,
              netTotal: a.netTotal,
            })),
            grossFleetTotal: fleet.grossFleetTotal,
            freeTierDiscount: fleet.freeTierDiscount,
            netFleetTotal: fleet.netFleetTotal,
            platform: PRICING.platform,
            total: fleet.netFleetTotal + PRICING.platform,
          },
          null,
          2
        )
      );
      return;
    }

    renderFleet(fleet, range);
  }
}
