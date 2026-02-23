import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

var CONFIG_DIR = join(homedir(), ".flareclerk");
var CONFIG_PATH = join(CONFIG_DIR, "config.json");

var CF_API = "https://api.cloudflare.com/client/v4";

// --- Auth config (~/.flareclerk/config.json) ---

export function getConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(
      "Not authenticated. Run `flareclerk auth` first."
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- CF API base ---

export async function cfApi(method, path, body, apiToken) {
  if (!apiToken) {
    var config = getConfig();
    apiToken = config.apiToken;
  }

  var headers = {
    Authorization: `Bearer ${apiToken}`,
  };

  if (body && typeof body === "object") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  var res = await fetch(`${CF_API}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`CF API ${method} ${path}: ${res.status} ${text}`);
  }

  var ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

// --- CF GraphQL Analytics API ---

export async function cfGraphQL(config, query, variables) {
  var res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`CF GraphQL: ${res.status} ${text}`);
  }

  var json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `CF GraphQL: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }
  return json.data;
}

// --- Discovery helpers ---

export async function getWorkerSettings(config, scriptName) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/scripts/${scriptName}/settings`,
    null,
    config.apiToken
  );
  return res.result;
}

export async function getDONamespaceId(config, scriptName, className) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/durable_objects/namespaces`,
    null,
    config.apiToken
  );
  var namespaces = res.result || [];
  var ns = namespaces.find(
    (n) => n.script === scriptName && n.class === className
  );
  return ns ? ns.id : null;
}

export async function listContainerApps(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/containers/applications`,
    null,
    config.apiToken
  );
  return res.result || [];
}

export async function listWorkerScripts(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/scripts`,
    null,
    config.apiToken
  );
  return res.result || [];
}

// --- Resource listing helpers ---

export async function listR2Buckets(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/r2/buckets`,
    null,
    config.apiToken
  );
  return res.result?.buckets || res.buckets || res.result || [];
}

export async function listD1Databases(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/d1/database`,
    null,
    config.apiToken
  );
  return res.result || [];
}

export async function listKVNamespaces(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/storage/kv/namespaces`,
    null,
    config.apiToken
  );
  return res.result || [];
}

export async function listQueues(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/queues`,
    null,
    config.apiToken
  );
  return res.result || [];
}

// --- Worker discovery: given a bare script name, find DO class, namespace ID, container app ID ---

export async function discoverWorker(config, scriptName) {
  // 1. Get worker settings to find DO binding + class_name
  var settings = await getWorkerSettings(config, scriptName);
  var bindings = settings?.bindings || [];
  var doBinding = bindings.find((b) => b.type === "durable_object_namespace");
  if (!doBinding) {
    return { scriptName, className: null, namespaceId: null, containerAppId: null };
  }
  var className = doBinding.class_name;

  // 2-3. In parallel: get DO namespace ID + find container app
  var [namespaceId, containerApps] = await Promise.all([
    getDONamespaceId(config, scriptName, className),
    listContainerApps(config),
  ]);

  var containerApp =
    containerApps.find((a) => a.durable_objects?.namespace_id === namespaceId) ||
    null;

  return {
    scriptName,
    className,
    namespaceId,
    containerAppId: containerApp?.id || null,
  };
}

// --- Discover all workers that have container bindings ---

export async function discoverAllContainerWorkers(config) {
  var [scripts, containerApps, doNamespaces] = await Promise.all([
    listWorkerScripts(config),
    listContainerApps(config),
    cfApi(
      "GET",
      `/accounts/${config.accountId}/workers/durable_objects/namespaces`,
      null,
      config.apiToken
    ).then((r) => r.result || []),
  ]);

  // Build set of DO namespace IDs that have a container app
  var containerNsIds = new Set();
  for (var ca of containerApps) {
    if (ca.durable_objects?.namespace_id) {
      containerNsIds.add(ca.durable_objects.namespace_id);
    }
  }

  // Find scripts that own a DO namespace backed by a container app
  var scriptSet = new Set(scripts.map((s) => s.id));
  var containerWorkers = [];
  for (var ns of doNamespaces) {
    if (containerNsIds.has(ns.id) && scriptSet.has(ns.script)) {
      containerWorkers.push(ns.script);
    }
  }

  if (containerWorkers.length === 0) return [];

  // Discover each worker in parallel
  var workers = await Promise.all(
    containerWorkers.map(async (scriptName) => {
      try {
        return await discoverWorker(config, scriptName);
      } catch {
        return null;
      }
    })
  );

  return workers.filter(Boolean);
}
