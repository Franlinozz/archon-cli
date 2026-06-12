#!/usr/bin/env node
// archon-scan — Archon audits from the terminal (zero dependencies, Node >= 18).
//
//   archon-scan scan <file|dir|address> [--gas] [--json] [--fail-on <sev>]
//
// Talks to Archon's public API: creates a scan, streams stage progress, prints
// the findings table (and the L2-vs-DA gas split with --gas), and exits
// nonzero when --fail-on is breached — composable in any CI, not just the
// GitHub Action. Read-only: it never deploys, signs, or moves anything.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const VERSION = "0.1.0";
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const DEPTHS = ["quick", "deep", "gas-cost", "full-report"];
const PROTOCOLS = ["mETH", "cmETH", "USDY", "Aave V3", "Merchant Moe", "Agni"];
const MAX_FILES = 80;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `[${code}m${text}[0m` : String(text));
const bold = paint("1"); const dim = paint("2"); const red = paint("31"); const yellow = paint("33");
const green = paint("32"); const cyan = paint("36"); const magenta = paint("35");
const sevColor = { critical: (t) => bold(red(t)), high: red, medium: yellow, low: cyan, info: dim };

const HELP = `archon-scan v${VERSION} — Archon audits for Mantle, from your terminal.

Usage:
  archon-scan scan <file.sol | directory | 0xAddress> [options]

Options:
  --gas                 Also run a gas report (receipt-calibrated L2/DA split)
  --json                Print machine-readable JSON to stdout (progress -> stderr)
  --fail-on <sev>       Exit 2 if any finding is at/above: critical|high|medium|low
  --depth <depth>       Scan depth: ${DEPTHS.join("|")} (default: quick)
  --protocols <list>    Comma-separated coverage targets (default: mETH)
  --label <name>        Contract label shown in the workspace
  --api <url>           API base (default: $ARCHON_API or https://archonaudit.xyz)
  --timeout <seconds>   Max wait for completion (default: 900)
  -h, --help            Show this help
  -v, --version         Show version

Exit codes: 0 ok · 1 operational error · 2 --fail-on threshold breached

Examples:
  archon-scan scan contracts/Vault.sol --fail-on high
  archon-scan scan ./src --gas --json > archon.json
  archon-scan scan 0xe7043e2ec95eF357FbBa3359BA2f1edb10cEAD2a --depth deep`;

function fail(message) { console.error(red(`error: ${message}`)); process.exit(1); }

function parseArgs(argv) {
  const args = { protocols: ["mETH"], depth: "quick", api: process.env.ARCHON_API || "https://archonaudit.xyz", timeout: 900 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) fail(`${arg} requires a value`); return v; };
    if (arg === "-h" || arg === "--help") { console.log(HELP); process.exit(0); }
    else if (arg === "-v" || arg === "--version") { console.log(VERSION); process.exit(0); }
    else if (arg === "--gas") args.gas = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--fail-on") { args.failOn = next().toLowerCase(); if (!SEVERITIES.slice(0, 4).includes(args.failOn)) fail(`--fail-on must be one of ${SEVERITIES.slice(0, 4).join("|")}`); }
    else if (arg === "--depth") { args.depth = next(); if (!DEPTHS.includes(args.depth)) fail(`--depth must be one of ${DEPTHS.join("|")}`); }
    else if (arg === "--protocols") { args.protocols = next().split(",").map((p) => p.trim()).filter(Boolean); const bad = args.protocols.find((p) => !PROTOCOLS.includes(p)); if (bad) fail(`unknown protocol "${bad}" (valid: ${PROTOCOLS.join(", ")})`); }
    else if (arg === "--label") args.label = next();
    else if (arg === "--api") args.api = next().replace(/\/$/, "");
    else if (arg === "--timeout") { args.timeout = Number(next()); if (!Number.isFinite(args.timeout) || args.timeout <= 0) fail("--timeout must be a positive number of seconds"); }
    else if (arg.startsWith("-")) fail(`unknown option ${arg} (see --help)`);
    else rest.push(arg);
  }
  return { args, rest };
}

function collectSolidity(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "out" || entry.name === "cache") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extname(entry.name) === ".sol") files.push(full);
      if (files.length > MAX_FILES) fail(`more than ${MAX_FILES} .sol files under ${dir}; point archon-scan at a smaller directory`);
    }
  };
  walk(dir);
  return files;
}

function buildSource(target) {
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) return { sourceKind: "address", sourceRef: target, display: target };
  const path = resolve(target);
  let stats;
  try { stats = statSync(path); } catch { fail(`${target} is not a file, directory, or 0x address`); }
  if (stats.isFile()) {
    const source = readFileSync(path, "utf8");
    return { sourceKind: "paste", sourceCode: source, label: basename(path, ".sol"), display: basename(path) };
  }
  const found = collectSolidity(path);
  if (!found.length) fail(`no .sol files found under ${target}`);
  const sourceFiles = found.map((file) => ({ path: relative(path, file), source: readFileSync(file, "utf8") }));
  // Entry file = the one declaring the most contracts (ties -> largest).
  const entry = [...sourceFiles].sort((a, b) => {
    const decls = (s) => (s.match(/(^|\s)(contract|library|interface)\s+[A-Za-z_]/g) ?? []).length;
    return decls(b.source) - decls(a.source) || b.source.length - a.source.length;
  })[0];
  return { sourceKind: "paste", sourceCode: entry.source, sourceFiles, label: basename(entry.path, ".sol"), display: `${sourceFiles.length} file(s) under ${basename(path)}/ (entry: ${entry.path})` };
}

async function api(base, path, init) {
  let response;
  try { response = await fetch(`${base}${path}`, init); } catch (error) { fail(`cannot reach ${base}: ${error.message}`); }
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
  if (!response.ok) {
    const issues = body.issues?.map((i) => `\n  - ${i.path ? `${i.path}: ` : ""}${i.message}`).join("") ?? "";
    fail(`${path} -> HTTP ${response.status}: ${body.error ?? "request failed"}${issues}`);
  }
  return body;
}

const log = (line) => process.stderr.write(`${line}\n`);
const stamp = () => dim(new Date().toISOString().slice(11, 19));

async function poll(base, path, isDone, describe, timeoutSeconds) {
  const startedAt = Date.now();
  let lastStage = "";
  for (;;) {
    const body = await api(base, path);
    const stage = describe(body);
    if (stage && stage !== lastStage) { log(`${stamp()} ${cyan("▸")} ${stage}`); lastStage = stage; }
    const done = isDone(body);
    if (done) return body;
    if ((Date.now() - startedAt) / 1000 > timeoutSeconds) fail(`timed out after ${timeoutSeconds}s waiting on ${path}`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

function formatMnt(wei) {
  try {
    const value = BigInt(wei);
    const whole = value / 10n ** 18n;
    const frac = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return `${whole}${frac ? `.${frac.slice(0, 9)}` : ""} MNT`;
  } catch { return `${wei} wei`; }
}

function printFindings(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  log("");
  log(bold("Findings ") + dim(`(${findings.length} total)`) + "  " + SEVERITIES.filter((s) => counts[s]).map((s) => sevColor[s](`${counts[s]} ${s}`)).join(dim(" · ")));
  const width = Math.min(process.stdout.columns || 110, 110);
  const ordered = [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  for (const finding of ordered.slice(0, 40)) {
    const location = `${finding.file ?? "?"}${finding.lineStart ? `:${finding.lineStart}` : ""}`;
    const sev = sevColor[finding.severity]?.(finding.severity.toUpperCase().padEnd(8)) ?? finding.severity;
    const title = finding.title.length > width - 40 ? `${finding.title.slice(0, width - 43)}…` : finding.title;
    log(`  ${sev} ${title} ${dim(location)}`);
  }
  if (ordered.length > 40) log(dim(`  … ${ordered.length - 40} more (use --json for the full list)`));
  return counts;
}

async function main() {
  const { args, rest } = parseArgs(process.argv.slice(2));
  if (rest[0] !== "scan" || !rest[1]) { console.log(HELP); process.exit(rest.length ? 1 : 0); }
  const source = buildSource(rest[1]);

  log(`${stamp()} ${magenta("Archon")} scanning ${bold(source.display)} ${dim(`(depth: ${args.depth}, api: ${args.api})`)}`);
  const created = await api(args.api, "/api/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceKind: source.sourceKind,
      sourceCode: source.sourceCode,
      sourceFiles: source.sourceFiles,
      sourceRef: source.sourceKind === "address" ? source.sourceRef : undefined,
      contractLabel: args.label ?? source.label,
      scanDepth: args.depth,
      protocols: args.protocols,
    }),
  });
  log(`${stamp()} ${cyan("▸")} scan ${created.scanId} queued`);

  const result = await poll(
    args.api,
    `/api/scans/${created.scanId}`,
    (body) => ["done", "failed"].includes(body.scan?.status),
    (body) => body.scan?.currentStage ? `${body.scan.currentStage} ${dim(`(${body.scan.progress ?? 0}%)`)}` : "",
    args.timeout,
  );
  if (result.scan.status === "failed") fail(`scan failed: ${result.scan.error ?? "unknown error"}`);

  if (!args.json) {
    printFindings(result.findings ?? []);
    log("");
    if (result.report) {
      log(`${bold("Risk score")} ${result.report.riskScore}/100   ${bold("Report hash")} ${dim(result.report.reportHash ?? "—")}`);
      log(`${bold("Report")} ${args.api}/r/${result.report.id}`);
    }
  }

  // Gas runs after audit results are already shown: a gas hiccup degrades to a
  // warning instead of hiding the findings. /api/gas/reports wraps its payload
  // as { report, optimizations }.
  let gas = null;
  if (args.gas) {
    log("");
    log(`${stamp()} ${cyan("▸")} starting gas report`);
    try {
      const gasCreated = await api(args.api, "/api/gas/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKind: source.sourceKind, sourceCode: source.sourceCode, sourceFiles: source.sourceFiles, sourceRef: source.sourceKind === "address" ? source.sourceRef : undefined, contractLabel: args.label ?? source.label }),
      });
      const gasBody = await poll(
        args.api,
        `/api/gas/reports/${gasCreated.gasReportId}`,
        (body) => ["done", "failed"].includes((body.report ?? body).status),
        (body) => { const r = body.report ?? body; return r.currentStage ? `gas: ${r.currentStage} ${dim(`(${r.progress ?? 0}%)`)}` : ""; },
        args.timeout,
      );
      gas = { report: gasBody.report ?? gasBody, optimizations: gasBody.optimizations ?? [] };
    } catch (error) {
      log(`${stamp()} ${yellow("gas report unavailable:")} ${error?.message ?? error} ${dim("(audit results above are unaffected)")}`);
    }
    const gasReport = gas?.report;
    if (gasReport?.status === "failed") log(`${stamp()} ${yellow("gas report failed:")} ${gasReport.error ?? "unknown error"} ${dim("(audit results above are unaffected)")}`);
    if (!args.json && gasReport?.status === "done" && gasReport.totals?.split) {
      log("");
      log(bold("Gas (per call, receipt-calibrated)"));
      log(`  L2 execution  ${green(formatMnt(gasReport.totals.split.l2WeiPerCall ?? "0"))}`);
      log(`  DA            ${green(formatMnt(gasReport.totals.split.l1DaWeiPerCall ?? "0"))} ${dim("— priced from Mantle receipt ground truth (l1Fee)")}`);
      log(`  Opportunities ${gas.optimizations.length} ${dim(`· ${args.api}/app/gas/${gasReport.id}`)}`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanId: created.scanId, scan: result.scan, report: result.report, findings: result.findings, gas }, null, 2));
  }

  if (args.failOn) {
    const threshold = SEVERITIES.indexOf(args.failOn);
    const breaches = (result.findings ?? []).filter((f) => SEVERITIES.indexOf(f.severity) <= threshold);
    if (breaches.length) {
      log("");
      log(red(bold(`✖ ${breaches.length} finding(s) at or above "${args.failOn}" — failing (exit 2)`)));
      process.exit(2);
    }
    log("");
    log(green(`✔ no findings at or above "${args.failOn}"`));
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
