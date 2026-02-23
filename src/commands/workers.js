import {
  getConfig,
  discoverWorker,
  listWorkerScripts,
  listContainerApps,
  cfApi,
  cfGraphQL,
} from "../lib/cf.js";
import { phase, status, fatal, fmt, table } from "../lib/output.js";
import { parseDateRange, fmtCost, fmtUsage } from "../lib/cost-utils.js";
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
  var [scripts, doNamespaces, containerApps] = await Promise.all([
    listWorkerScripts(config),
    cfApi(
      "GET",
      `/accounts/${config.accountId}/workers/durable_objects/namespaces`,
      null,
      config.apiToken
    ).then((r) => r.result || []),
    listContainerApps(config),
  ]);

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

    return {
      scriptName: s.id,
      namespaceId,
      containerAppId,
    };
  });

  return workers;
}

// --- Aggregate raw GraphQL results per worker ---

function aggregateResults(workers, analytics) {
  var { workersData, doReqData, doDurData, containersData } = analytics;

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

    return {
      name: scriptName,
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

  var [workersData, doReqData, doDurData, containersData] =
    await Promise.all(queries);
  return { workersData, doReqData, doDurData, containersData };
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

  var headers = ["NAME", "WORKERS", "DO", "CONTAINERS", "COST"];
  var rows = fleet.appResults.map((a) => [
    fmt.app(a.name),
    fmtCost(a.workersCost),
    fmtCost(a.doCost),
    fmtCost(a.containerCost),
    fmtCost(a.grossTotal),
  ]);

  console.log(table(headers, rows));
  console.log("");

  var labelW = 44;
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

  if (name) {
    // --- Detail mode ---
    phase("Discovering worker");
    var worker;
    try {
      worker = await discoverWorker(config, name);
    } catch (e) {
      fatal(`Could not find worker ${fmt.app(name)}.`, e.message);
    }
    status(`Worker: ${name}`);

    phase("Fetching analytics");
    var [analytics, liveMetrics] = await Promise.all([
      fetchAnalytics(config, [worker], range),
      fetchContainerMetrics(config, worker.containerAppId),
    ]);

    var appResults = aggregateResults([worker], analytics);
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
    var appResults = aggregateResults(fleetWorkers, analytics);
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
