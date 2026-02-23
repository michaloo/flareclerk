import kleur from "kleur";

export function phase(msg) {
  process.stderr.write(`\n${kleur.bold().cyan("==>")} ${kleur.bold(msg)}\n`);
}

export function status(msg) {
  process.stderr.write(`    ${msg}\n`);
}

export function error(msg, fix) {
  process.stderr.write(`\n${kleur.red("Error:")} ${msg}\n`);
  if (fix) process.stderr.write(`  ${fix}\n`);
}

export function fatal(msg, fix) {
  error(msg, fix);
  process.exit(1);
}

export function success(msg) {
  process.stderr.write(`\n${kleur.green("-->")} ${msg}\n`);
}

export function hint(label, msg) {
  process.stderr.write(`\n${kleur.dim(label + ":")} ${msg}\n`);
}

export var fmt = {
  app: (name) => kleur.cyan(name),
  cmd: (cmd) => kleur.bold().cyan(cmd),
  key: (k) => kleur.green(k),
  val: (v) => kleur.yellow(v),
  dim: (t) => kleur.dim(t),
  bold: (t) => kleur.bold(t),
  url: (u) => kleur.underline().cyan(u),
};

function stripAnsi(str) {
  return String(str).replace(/\x1B\[[0-9;]*m/g, "");
}

function padEnd(str, len) {
  var visible = stripAnsi(str).length;
  return str + " ".repeat(Math.max(0, len - visible));
}

export function table(headers, rows) {
  if (rows.length === 0) return "";

  var allRows = [headers, ...rows];
  var widths = [];
  for (var row of allRows) {
    for (var i = 0; i < row.length; i++) {
      var len = stripAnsi(String(row[i] || "")).length;
      if (!widths[i] || len > widths[i]) widths[i] = len;
    }
  }

  var lines = [];
  lines.push(
    headers
      .map((h, i) => kleur.bold(padEnd(String(h), widths[i] + 2)))
      .join("")
  );
  lines.push(kleur.dim(widths.map((w) => "─".repeat(w)).join("  ")));
  for (var row of rows) {
    lines.push(
      row.map((cell, i) => padEnd(String(cell || ""), widths[i] + 2)).join("")
    );
  }

  return lines.join("\n");
}
