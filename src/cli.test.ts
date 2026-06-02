import { describe, expect, test } from "bun:test";
import {
  finalizeConfig,
  isBenignForwardError,
  nextReconnectDelay,
  parseConfig,
  selectServices,
  validateConfig,
  type ServiceConfig,
} from "./cli.ts";

function service(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return { name: "api", namespace: "default", pod: "api", localPort: 8080, remotePort: 8080, ...overrides };
}

describe("parseConfig", () => {
  test("parses the preferred services mapping", () => {
    const config = parseConfig(`name: local-dev
services:
  api:
    namespace: default
    localPort: 8080
    remotePort: 8080
  postgres:
    namespace: default
    localPort: 5432
    remotePort: 5432
`);
    finalizeConfig(config);

    expect(config.name).toBe("local-dev");
    expect(config.services).toHaveLength(2);
    expect(config.services[0]).toMatchObject({ name: "api", namespace: "default", localPort: 8080, remotePort: 8080 });
    // pod defaults to the service key when omitted
    expect(config.services[0]!.pod).toBe("api");
  });

  test("normalizes `service:` to a service/ resource", () => {
    const config = parseConfig(`services:
  api:
    namespace: default
    service: api-svc
    localPort: 80
    remotePort: 80
`);
    expect(config.services[0]!.resource).toBe("service/api-svc");
  });

  test("supports legacy portforwards arrays", () => {
    const config = parseConfig(`name: legacy
portforwards:
  - name: api
    namespace: default
    pod: api
    localPort: 8080
    remotePort: 8080
`);
    expect(config.services).toHaveLength(1);
    expect(config.services[0]).toMatchObject({ name: "api", pod: "api", localPort: 8080 });
  });

  test("parses JSON config", () => {
    const config = parseConfig(`{"name":"j","services":{"api":{"namespace":"default","pod":"api","localPort":1,"remotePort":2}}}`);
    expect(config.name).toBe("j");
    expect(config.services[0]).toMatchObject({ name: "api", localPort: 1, remotePort: 2 });
  });

  test("strips inline comments but keeps `#` inside quotes", () => {
    const config = parseConfig(`services:
  api:
    namespace: default # forwarded api
    pod: "a#b"
    localPort: 80
    remotePort: 80
`);
    expect(config.services[0]!.namespace).toBe("default");
    expect(config.services[0]!.pod).toBe("a#b");
  });
});

describe("selectServices", () => {
  const services = [
    service({ name: "minio" }),
    service({ name: "postgres-cluster-pooler" }),
    service({ name: "clickhouse-http" }),
    service({ name: "clickhouse-native" }),
  ];

  test("returns all when no terms given", () => {
    expect(selectServices(services, [])).toHaveLength(4);
  });

  test("matches by case-insensitive substring", () => {
    const picked = selectServices(services, ["postgres", "MINIO"]).map((s) => s.name);
    expect(picked).toEqual(["minio", "postgres-cluster-pooler"]);
  });

  test("a single term can select a group", () => {
    const picked = selectServices(services, ["clickhouse"]).map((s) => s.name);
    expect(picked).toEqual(["clickhouse-http", "clickhouse-native"]);
  });

  test("throws on a term that matches nothing", () => {
    expect(() => selectServices(services, ["nope"])).toThrow(/no service matches: nope/);
  });
});

describe("validateConfig", () => {
  test("accepts a complete service", () => {
    expect(() => validateConfig({ services: [service()] }, "cfg")).not.toThrow();
  });

  test("requires namespace", () => {
    expect(() => validateConfig({ services: [service({ namespace: undefined as unknown as string })] }, "cfg"))
      .toThrow(/namespace is required/);
  });

  test("requires a pod or resource", () => {
    expect(() => validateConfig({ services: [service({ pod: undefined, resource: undefined })] }, "cfg"))
      .toThrow(/pod or .*resource is required/);
  });

  test("requires integer ports", () => {
    expect(() => validateConfig({ services: [service({ localPort: NaN })] }, "cfg"))
      .toThrow(/localPort is required/);
  });
});

describe("nextReconnectDelay", () => {
  test("doubles up to a 30s ceiling", () => {
    expect(nextReconnectDelay(2000)).toBe(4000);
    expect(nextReconnectDelay(16000)).toBe(30000);
    expect(nextReconnectDelay(30000)).toBe(30000);
  });
});

describe("isBenignForwardError", () => {
  test("flags per-connection copy resets", () => {
    expect(isBenignForwardError("E0602 ... error copying from local connection to remote stream: ... reset by peer")).toBe(true);
  });

  test("keeps real errors visible", () => {
    expect(isBenignForwardError("error: lost connection to pod")).toBe(false);
  });
});
