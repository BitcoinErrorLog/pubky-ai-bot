import { describe, expect, it } from "vitest";
import { MetricsService } from "./metrics.js";

describe("public metrics surface (oracle hygiene)", () => {
  it("exposes security events only as an unlabeled total", async () => {
    const m = new MetricsService();
    m.incrementSecurityEvent("env_secret");
    m.incrementSecurityEvent("env_secret");
    m.incrementSecurityEvent("key_material");
    const pub = await m.getPublicMetrics();
    expect(pub).not.toContain('rule="');
    expect(pub).toMatch(/^jeb_security_events_total 3$/m);
    expect(pub).toContain("# TYPE jeb_security_events_total counter");
  });

  it("keeps the per-rule breakdown on the internal exposition", async () => {
    const m = new MetricsService();
    m.incrementSecurityEvent("env_secret");
    const internal = await m.getMetrics();
    expect(internal).toContain('jeb_security_events_total{rule="env_secret"} 1');
  });

  it("reports a zero total when no security events fired", async () => {
    const m = new MetricsService();
    const pub = await m.getPublicMetrics();
    expect(pub).toMatch(/^jeb_security_events_total 0$/m);
  });
});
