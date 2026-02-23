import { fatal, fmt } from "./output.js";

// --- Date range parsing ---

export function parseDateRange(since) {
  var now = new Date();
  var until = now;
  var start;

  if (!since) {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (/^\d+d$/.test(since)) {
    var days = parseInt(since);
    start = new Date(now.getTime() - days * 86400_000);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    start = new Date(since + "T00:00:00Z");
    if (isNaN(start.getTime())) {
      fatal(`Invalid date: ${since}`, "Use YYYY-MM-DD or Nd (e.g. 7d)");
    }
  } else {
    fatal(
      `Invalid --since value: ${since}`,
      "Use YYYY-MM-DD or Nd (e.g. 7d, 30d)"
    );
  }

  var sinceISO = start.toISOString().slice(0, 19) + "Z";
  var untilISO = until.toISOString().slice(0, 19) + "Z";
  var sinceDate = start.toISOString().slice(0, 10);
  var untilDate = until.toISOString().slice(0, 10);

  var label = formatDateRange(start, until);
  return { sinceISO, untilISO, sinceDate, untilDate, sinceDateObj: start, untilDateObj: until, label };
}

export function formatDateRange(start, end) {
  var opts = { month: "short", day: "numeric" };
  var s = start.toLocaleDateString("en-US", opts);
  var e = end.toLocaleDateString("en-US", opts);
  return `${s} \u2013 ${e}`;
}

// --- Formatting helpers ---

export function fmtCost(n) {
  return "$" + n.toFixed(2);
}

export function fmtUsage(n, unit) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B " + unit;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M " + unit;
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K " + unit;
  return n.toLocaleString("en-US") + " " + unit;
}

export function fmtStorage(bytes) {
  if (bytes >= 1_000_000_000_000) return (bytes / 1_000_000_000_000).toFixed(1) + " TB";
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + " GB";
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + " MB";
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + " KB";
  return bytes + " B";
}

// --- Storage proration ---

export function daysFraction(range) {
  var ms = range.untilDateObj.getTime() - range.sinceDateObj.getTime();
  return ms / (30 * 86400_000);
}

// --- Detail view renderer ---

export function renderDetail(name, metrics, totals, range) {
  console.log("");
  console.log(`  ${fmt.bold(name)} ${fmt.dim(`(${range.label})`)}`);
  console.log("");

  var header = "  METRIC         USAGE                 ESTIMATED COST";
  var sep = "  " + "\u2500".repeat(50);

  console.log(fmt.bold(header));
  console.log(fmt.dim(sep));

  for (var row of metrics) {
    var label = row.label ? fmt.bold(row.label.padEnd(14)) : " ".repeat(14);
    var usage = row.usage.padEnd(22);
    console.log(`  ${label} ${usage} ${row.cost}`);
  }

  console.log(fmt.dim(sep));
  console.log(
    `  ${" ".repeat(14)} ${"".padEnd(22)} ${fmt.bold(fmtCost(totals.grossTotal))}`
  );

  if (totals.freeTierDiscount > 0) {
    console.log(
      `  ${" ".repeat(14)} ${fmt.dim("Free tier".padEnd(22))} ${fmt.dim("-" + fmtCost(totals.freeTierDiscount))}`
    );
    console.log(
      `  ${" ".repeat(14)} ${fmt.bold("Net".padEnd(22))} ${fmt.bold(fmtCost(totals.netTotal))}`
    );
  }

  console.log("");
  console.log(
    fmt.dim("  Estimates based on Cloudflare Workers Paid plan pricing.")
  );
  console.log("");
}

// --- Generic free tier application ---

export function applyFreeTier(items, metrics, pricing) {
  // Sum usage across all items
  var totals = {};
  for (var key of metrics) totals[key] = 0;
  for (var item of items) {
    for (var key of metrics) {
      totals[key] += item.usage[key];
    }
  }

  // Compute fleet overage per metric
  var fleetOverage = {};
  for (var key of metrics) {
    var included = pricing[key].included;
    var overageUsage = Math.max(0, totals[key] - included);
    fleetOverage[key] = overageUsage * pricing[key].rate;
  }

  // Compute gross costs per item
  var grossFleetTotal = 0;
  for (var item of items) {
    var costs = {};
    for (var key of metrics) {
      costs[key] = item.usage[key] * pricing[key].rate;
    }
    item.costs = costs;
    item.grossTotal = Object.values(costs).reduce((a, b) => a + b, 0);
    grossFleetTotal += item.grossTotal;
  }

  var netFleetTotal = Object.values(fleetOverage).reduce((a, b) => a + b, 0);
  var freeTierDiscount = grossFleetTotal - netFleetTotal;

  // Distribute discount proportionally
  for (var item of items) {
    if (grossFleetTotal > 0) {
      var share = item.grossTotal / grossFleetTotal;
      item.freeTierDiscount = freeTierDiscount * share;
    } else {
      item.freeTierDiscount = 0;
    }
    item.netTotal = Math.max(0, item.grossTotal - item.freeTierDiscount);
  }

  return { items, freeTierDiscount, netFleetTotal, grossFleetTotal };
}
