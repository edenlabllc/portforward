#!/usr/bin/env bun

import { existsSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

declare const PORTFORWARD_VERSION: string;
declare const PORTFORWARD_REPO: string;
const VERSION = typeof PORTFORWARD_VERSION !== "undefined" ? PORTFORWARD_VERSION : "dev";
const REPO = process.env.PORTFORWARD_REPO
  ?? (typeof PORTFORWARD_REPO !== "undefined" ? PORTFORWARD_REPO : "edenlabllc/portforward");

type ServiceConfig = {
  name: string;
  namespace: string;
  pod?: string;
  resource?: string;
  context?: string;
  localPort: number;
  remotePort: number;
};

type AppConfig = {
  name?: string;
  services: ServiceConfig[];
};

type Child = ReturnType<typeof Bun.spawn>;

const CONFIG_FILES = [
  "portforward.yaml",
  "portforward.yml",
  ".portforward.yaml",
  ".portforward.yml",
  ".workspace.yaml",
];

const running = new Set<Child>();
let stopping = false;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "start") {
    const configPath = getOption(args, "--config") ?? findConfigPath();
    if (!configPath) fail("No config found. Run `portforward init` first.");

    const config = await loadConfig(configPath);
    if (config.services.length === 0) fail(`No services configured in ${configPath}`);

    console.log(`portforward: ${config.name ?? configPath}`);
    console.log(`config: ${configPath}`);
    console.log(`services: ${config.services.map((service) => service.name).join(", ")}`);
    console.log("Press Ctrl+C to stop.");

    installSignalHandlers();
    await Promise.all(config.services.map((service) => keepAlive(service)));
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  if (command === "upgrade") {
    await upgrade();
    return;
  }

  if (command === "init") {
    const target = getOption(args, "--config") ?? "portforward.yaml";
    const force = args.includes("--force");
    await initConfig(target, force);
    return;
  }

  if (command === "check") {
    const configPath = getOption(args, "--config") ?? findConfigPath();
    if (!configPath) fail("No config found. Run `portforward init` first.");
    const config = await loadConfig(configPath);
    console.log(`config: ${configPath}`);
    for (const service of config.services) {
      const target = service.resource ?? `pod matching ${service.pod}`;
      const status = await isPortActive(service.localPort) ? "active" : "down";
      console.log(`${service.name}: ${status} ${service.namespace} ${target} ${service.localPort}:${service.remotePort}`);
    }
    return;
  }

  printHelp();
}

function printHelp() {
  console.log(`portforward

Usage:
  portforward init [--config portforward.yaml] [--force]
  portforward check [--config portforward.yaml]
  portforward start [--config portforward.yaml]
  portforward upgrade            download and install the latest release
  portforward version

Config files are searched in this order:
  ${CONFIG_FILES.join("\n  ")}
`);
}

function getOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function findConfigPath() {
  for (const file of CONFIG_FILES) {
    if (existsSync(file)) return file;
  }
  return undefined;
}

function detectPlatform() {
  const os = process.platform === "darwin" ? "darwin"
    : process.platform === "linux" ? "linux"
    : fail(`unsupported OS: ${process.platform}`);
  const arch = process.arch === "arm64" ? "arm64"
    : process.arch === "x64" ? "x64"
    : fail(`unsupported arch: ${process.arch}`);
  return { os, arch };
}

async function upgrade() {
  const target = process.execPath;
  const { os, arch } = detectPlatform();
  const asset = `portforward-${os}-${arch}`;
  const version = process.env.PORTFORWARD_VERSION ?? "latest";
  const url = version === "latest"
    ? `https://github.com/${REPO}/releases/latest/download/${asset}`
    : `https://github.com/${REPO}/releases/download/${version}/${asset}`;

  console.log(`portforward: downloading ${asset} (${version})...`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`download failed (${response.status}): ${url}`);

  const tmp = join(dirname(target), `.portforward.upgrade.${process.pid}`);
  await Bun.write(tmp, response);
  chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  console.log(`portforward: updated ${target}`);
}

async function initConfig(target: string, force: boolean) {
  const file = Bun.file(target);
  if ((await file.exists()) && !force) fail(`${target} already exists. Use --force to overwrite.`);

  await Bun.write(target, `name: local-dev

services:
  api:
    namespace: default
    pod: api
    localPort: 8080
    remotePort: 8080
  postgres:
    namespace: default
    pod: postgres
    localPort: 5432
    remotePort: 5432
`);

  console.log(`Created ${target}`);
}

async function loadConfig(path: string): Promise<AppConfig> {
  const text = await Bun.file(path).text();
  const parsed = parseConfig(text);
  finalizeConfig(parsed);
  validateConfig(parsed, path);
  return parsed;
}

function finalizeConfig(config: AppConfig) {
  for (const service of config.services) {
    service.pod ??= service.name;
  }
}

function parseConfig(text: string): AppConfig {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return parseJsonConfig(trimmed);
  return parseYamlConfig(text);
}

function parseJsonConfig(text: string): AppConfig {
  const raw = JSON.parse(text);
  return normalizeRawConfig(raw);
}

function parseYamlConfig(text: string): AppConfig {
  const config: AppConfig = { services: [] };
  const serviceMap = new Map<string, Partial<ServiceConfig> & { name: string }>();
  const legacy: Array<Partial<ServiceConfig> & { name?: string }> = [];
  let section: "services" | "portforwards" | undefined;
  let currentService: (Partial<ServiceConfig> & { name: string }) | undefined;
  let currentLegacy: (Partial<ServiceConfig> & { name?: string }) | undefined;

  for (const rawLine of text.replaceAll("\r\n", "\n").split("\n")) {
    const line = stripInlineComment(rawLine);
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      currentService = undefined;
      currentLegacy = undefined;

      const top = readPair(trimmed);
      if (!top) continue;

      if (top.key === "name") config.name = String(parseScalar(top.value));
      else if (top.key === "services") section = "services";
      else if (top.key === "portforwards") section = "portforwards";
      else section = undefined;

      continue;
    }

    if (section === "services") {
      if (indent === 2 && trimmed.endsWith(":")) {
        const name = trimmed.slice(0, -1).trim();
        currentService = { name };
        serviceMap.set(name, currentService);
        continue;
      }

      if (indent >= 4 && currentService) {
        const pair = readPair(trimmed);
        if (pair) assignServiceValue(currentService, pair.key, pair.value);
      }
    }

    if (section === "portforwards") {
      if (indent >= 2 && trimmed.startsWith("- ")) {
        currentLegacy = {};
        legacy.push(currentLegacy);
        const rest = trimmed.slice(2).trim();
        const pair = readPair(rest);
        if (pair) assignServiceValue(currentLegacy, pair.key, pair.value);
        continue;
      }

      if (indent >= 4 && currentLegacy) {
        const pair = readPair(trimmed);
        if (pair) assignServiceValue(currentLegacy, pair.key, pair.value);
      }
    }
  }

  config.services.push(...Array.from(serviceMap.values()).filter(isForwardLike).map((service) => service as ServiceConfig));
  config.services.push(...legacy.map((service, index) => ({ ...service, name: service.name ?? service.pod ?? service.resource ?? `portforward-${index + 1}` }) as ServiceConfig));
  return config;
}

function isForwardLike(service: Partial<ServiceConfig>) {
  return Boolean(service.namespace || service.resource || service.pod || service.localPort || service.remotePort);
}

function normalizeRawConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") fail("Config must be an object.");

  const obj = raw as Record<string, unknown>;
  const services: ServiceConfig[] = [];

  if (obj.services && typeof obj.services === "object" && !Array.isArray(obj.services)) {
    for (const [name, value] of Object.entries(obj.services as Record<string, unknown>)) {
      services.push({ ...(value as Omit<ServiceConfig, "name">), name } as ServiceConfig);
    }
  }

  if (Array.isArray(obj.portforwards)) {
    for (const [index, value] of obj.portforwards.entries()) {
      const service = value as Partial<ServiceConfig>;
      services.push({ ...service, name: service.name ?? service.pod ?? service.resource ?? `portforward-${index + 1}` } as ServiceConfig);
    }
  }

  return { name: typeof obj.name === "string" ? obj.name : undefined, services };
}

function readPair(line: string) {
  const index = line.indexOf(":");
  if (index === -1) return undefined;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

function assignServiceValue(service: Partial<ServiceConfig>, key: string, rawValue: string) {
  const value = parseScalar(rawValue);

  if (key === "name") service.name = String(value);
  if (key === "namespace") service.namespace = String(value);
  if (key === "pod") service.pod = String(value);
  if (key === "service") service.resource = `service/${value}`;
  if (key === "resource") service.resource = String(value);
  if (key === "context") service.context = String(value);
  if (key === "localPort") service.localPort = Number(value);
  if (key === "remotePort") service.remotePort = Number(value);
}

function parseScalar(value: string): string | number | boolean | undefined {
  if (value === "") return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function stripInlineComment(line: string) {
  let quote: string | undefined;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const previous = line[index - 1];

    if ((char === '"' || char === "'") && previous !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }

    if (char === "#" && !quote && (index === 0 || /\s/.test(previous))) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line.trimEnd();
}

function validateConfig(config: AppConfig, path: string) {
  for (const service of config.services) {
    if (!service.name) fail(`Invalid config ${path}: service without name.`);
    if (!service.namespace) fail(`Invalid config ${path}: ${service.name}.namespace is required.`);
    if (!service.pod && !service.resource) fail(`Invalid config ${path}: ${service.name}.pod or ${service.name}.resource is required.`);
    if (!Number.isInteger(service.localPort)) fail(`Invalid config ${path}: ${service.name}.localPort is required.`);
    if (!Number.isInteger(service.remotePort)) fail(`Invalid config ${path}: ${service.name}.remotePort is required.`);
  }
}

async function keepAlive(service: ServiceConfig) {
  let connectedOnce = false;
  let reconnectDelay = 2000;

  while (!stopping) {
    try {
      if (await isPortActive(service.localPort)) {
        if (connectedOnce) {
          await sleep(2000);
          continue;
        }

        log(service, `port ${service.localPort} already in use, attempting to reclaim`);
        await killStalePortForward(service.localPort);
        await waitForPortReleased(service.localPort);

        if (await isPortActive(service.localPort)) {
          log(service, `port ${service.localPort} is still in use, retry in ${reconnectDelay / 1000}s`);
          await sleep(reconnectDelay);
          reconnectDelay = nextReconnectDelay(reconnectDelay);
          continue;
        }
      }

      if (connectedOnce) log(service, "connection lost, reconnecting");

      const target = service.resource ?? await resolvePodResource(service);
      if (!target) {
        log(service, `no matching pod, retry in 3s`);
        await sleep(3000);
        continue;
      }

      const port = `${service.localPort}:${service.remotePort}`;
      const args = kubectlArgs(service, ["port-forward", "-n", service.namespace, target, port]);
      log(service, `kubectl ${args.join(" ")}`);

      const child = Bun.spawn(["kubectl", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      running.add(child);
      void child.exited.then(() => running.delete(child));
      streamLines(child.stdout, (line) => log(service, line));
      streamLines(child.stderr, (line) => log(service, `[err] ${line}`));

      if (await waitForPortActive(service.localPort)) {
        log(service, `localhost:${service.localPort} -> ${target}:${service.remotePort}`);
        connectedOnce = true;
        reconnectDelay = 2000;
        await sleep(2000);
        continue;
      }

      child.kill();
      running.delete(child);
      log(service, `failed to connect, retry in ${reconnectDelay / 1000}s`);
      await sleep(reconnectDelay);
      reconnectDelay = nextReconnectDelay(reconnectDelay);
    } catch (error) {
      log(service, `error: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(reconnectDelay);
      reconnectDelay = nextReconnectDelay(reconnectDelay);
    }
  }
}

async function resolvePodResource(service: ServiceConfig) {
  if (!service.pod) return undefined;

  const args = kubectlArgs(service, ["get", "pods", "-n", service.namespace, "-o", "name"]);
  const result = await runCapture("kubectl", args);

  if (result.exitCode !== 0) {
    log(service, `kubectl get pods failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return undefined;
  }

  const pods = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("pod/"))
    .map((line) => line.slice(4));

  const match = pods.find((pod) => pod === service.pod)
    ?? pods.find((pod) => pod.startsWith(service.pod!))
    ?? pods.find((pod) => pod.includes(service.pod!));

  if (!match) {
    log(service, `no pod matching ${service.pod}. available: ${pods.join(", ") || "none"}`);
    return undefined;
  }

  return `pod/${match}`;
}

function kubectlArgs(service: ServiceConfig, args: string[]) {
  if (!service.context) return args;
  return ["--context", service.context, ...args];
}

async function runCapture(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    child.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function isPortActive(port: number) {
  const result = await runCapture("lsof", ["-i", `:${port}`]);
  return result.exitCode === 0;
}

async function killStalePortForward(port: number) {
  await runCapture("pkill", ["-f", `kubectl port-forward.*${port}:`]).catch(() => undefined);
}

async function waitForPortReleased(port: number) {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!await isPortActive(port)) return true;
    await sleep(200);
  }
  return false;
}

async function waitForPortActive(port: number) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await isPortActive(port)) return true;
    await sleep(300);
  }
  return false;
}

async function readStream(stream: ReadableStream | null) {
  if (!stream) return "";
  return await new Response(stream).text();
}

async function streamLines(stream: ReadableStream | null, onLine: (line: string) => void) {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
      }
    }

    const rest = buffer.trim();
    if (rest) onLine(rest);
  } catch {
  }
}

function nextReconnectDelay(current: number) {
  return Math.min(current * 2, 30000);
}

function installSignalHandlers() {
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\nstopping port-forwards...");
    for (const child of running) child.kill();
    setTimeout(() => process.exit(0), 250).unref();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function log(service: ServiceConfig, message: string) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] [${service.name}] ${message}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message: string): never {
  console.error(`portforward: ${message}`);
  process.exit(1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
