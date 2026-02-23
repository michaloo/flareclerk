import { getConfig, cfGraphQL } from "../lib/cf.js";
import { phase, status, fatal, fmt, table } from "../lib/output.js";
import {
  parseDateRange,
  fmtCost,
  fmtUsage,
  renderDetail,
} from "../lib/cost-utils.js";

// --- Pricing ---

var RATE = 0.011 / 1000; // $0.011 per 1,000 neurons
var FREE_NEURONS_PER_DAY = 10_000;

// --- GraphQL ---

// Fleet: per model totals (no date grouping needed for display,
// but we need per-date grouping internally for daily free tier)
var neuronsPerDayGQL = `query AINeurons($accountTag: string!, $filter: AccountAiInferenceAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aiInferenceAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { modelId date }
        sum { totalNeurons totalInputTokens totalOutputTokens totalProcessedTiles totalAudioSeconds }
        count
      }
    }
  }
}`;

// --- Daily free tier calculation ---
// Free tier: 10K neurons/day shared across ALL models.
// We sum neurons per day, subtract 10K, clamp to 0, then sum overages.
// Discount is distributed proportionally across models.

function applyDailyFreeTier(items, dailyTotals) {
  // dailyTotals: { date -> totalNeurons }
  var grossFleetTotal = 0;
  for (var item of items) {
    item.costs = { neurons: item.usage.neurons * RATE };
    item.grossTotal = item.costs.neurons;
    grossFleetTotal += item.grossTotal;
  }

  // Sum daily overages
  var totalOverageNeurons = 0;
  for (var date of Object.keys(dailyTotals)) {
    totalOverageNeurons += Math.max(0, dailyTotals[date] - FREE_NEURONS_PER_DAY);
  }
  var netFleetTotal = totalOverageNeurons * RATE;
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

// --- Main command ---

export async function ai(name, options) {
  var config = getConfig();
  var range = parseDateRange(options.since);

  phase("Fetching AI inference analytics");
  var data;
  try {
    data = await cfGraphQL(config, neuronsPerDayGQL, {
      accountTag: config.accountId,
      filter: {
        datetimeHour_geq: range.sinceISO,
        datetimeHour_leq: range.untilISO,
      },
    });
  } catch (e) {
    fatal("Could not fetch AI inference data.", e.message);
  }

  var rows =
    data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];

  if (rows.length === 0) {
    fatal("No AI inference usage found for this period.");
  }

  // Aggregate per model + track daily totals for free tier
  var byModel = {};
  var dailyTotals = {};

  for (var row of rows) {
    var model = row.dimensions.modelId;
    var date = row.dimensions.date;
    var neurons = row.sum?.totalNeurons || 0;

    if (!byModel[model]) {
      byModel[model] = {
        neurons: 0,
        inputTokens: 0,
        outputTokens: 0,
        tiles: 0,
        audioSeconds: 0,
        requests: 0,
      };
    }
    byModel[model].neurons += neurons;
    byModel[model].inputTokens += row.sum?.totalInputTokens || 0;
    byModel[model].outputTokens += row.sum?.totalOutputTokens || 0;
    byModel[model].tiles += row.sum?.totalProcessedTiles || 0;
    byModel[model].audioSeconds += row.sum?.totalAudioSeconds || 0;
    byModel[model].requests += row.count || 0;

    if (!dailyTotals[date]) dailyTotals[date] = 0;
    dailyTotals[date] += neurons;
  }

  status(`Found ${Object.keys(byModel).length} model${Object.keys(byModel).length > 1 ? "s" : ""}`);

  // Build items sorted by neurons desc
  var items = Object.entries(byModel)
    .map(([model, u]) => ({
      name: model,
      usage: u,
    }))
    .sort((a, b) => b.usage.neurons - a.usage.neurons);

  var fleet = applyDailyFreeTier(items, dailyTotals);

  // Detail mode
  if (name) {
    var item = fleet.items.find((i) => i.name === name);
    if (!item) {
      fatal(
        `Model ${fmt.app(name)} not found.`,
        `Run ${fmt.cmd("flareclerk ai")} to see all models with usage.`
      );
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            model: item.name,
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

    // Build metrics rows — only show non-zero secondary metrics
    var metrics = [
      { label: "Neurons", usage: fmtUsage(item.usage.neurons, "neurons"), cost: fmtCost(item.costs.neurons) },
    ];
    if (item.usage.requests > 0) {
      metrics.push({ label: "Requests", usage: fmtUsage(item.usage.requests, "reqs"), cost: "" });
    }
    if (item.usage.inputTokens > 0) {
      metrics.push({ label: "Input tokens", usage: fmtUsage(item.usage.inputTokens, "tokens"), cost: "" });
    }
    if (item.usage.outputTokens > 0) {
      metrics.push({ label: "Output tokens", usage: fmtUsage(item.usage.outputTokens, "tokens"), cost: "" });
    }
    if (item.usage.tiles > 0) {
      metrics.push({ label: "Tiles", usage: fmtUsage(item.usage.tiles, "tiles"), cost: "" });
    }
    if (item.usage.audioSeconds > 0) {
      metrics.push({ label: "Audio", usage: fmtUsage(item.usage.audioSeconds, "seconds"), cost: "" });
    }

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
          models: fleet.items.map((item) => ({
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
    `  ${fmt.bold("Workers AI estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["MODEL", "NEURONS", "REQUESTS", "COST"];
  var tableRows = fleet.items.map((item) => [
    fmt.app(item.name),
    fmtUsage(item.usage.neurons, ""),
    fmtUsage(item.usage.requests, ""),
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
        fmt.dim("Free tier (10K neurons/day)".padEnd(labelW)) +
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
    fmt.dim("  Free tier: 10,000 neurons/day. Overage: $0.011/1K neurons.")
  );
  console.log("");
}
