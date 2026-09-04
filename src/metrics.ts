import client from "prom-client";

export class MetricsService {
  private readonly registry: client.Registry;
  private readonly mentionsTotal: client.Counter<string>;
  private readonly actionsTotal: client.Counter<string>;
  private readonly repliesTotal: client.Counter<string>;
  private readonly actionDuration: client.Histogram<string>;
  private readonly authFailed: client.Counter<string>;
  private readonly securityEvents: client.Counter<string>;

  constructor() {
    this.registry = new client.Registry();
    this.mentionsTotal = new client.Counter({
      name: "jeb_mentions_total",
      help: "Mentions processed",
      labelNames: ["status"],
      registers: [this.registry],
    });
    this.actionsTotal = new client.Counter({
      name: "jeb_actions_total",
      help: "Actions executed",
      labelNames: ["action", "status"],
      registers: [this.registry],
    });
    this.repliesTotal = new client.Counter({
      name: "jeb_replies_total",
      help: "Replies published",
      labelNames: ["action"],
      registers: [this.registry],
    });
    this.actionDuration = new client.Histogram({
      name: "jeb_action_duration_seconds",
      help: "Action execution time",
      labelNames: ["action"],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });
    this.authFailed = new client.Counter({
      name: "jeb_publisher_auth_failed_total",
      help: "Publisher auth failures after re-signin",
      registers: [this.registry],
    });
    this.securityEvents = new client.Counter({
      name: "jeb_security_events_total",
      help: "Secret-scrubber and extraction-guard detections (rule id only, never matched text)",
      labelNames: ["rule"],
      registers: [this.registry],
    });
    client.collectDefaultMetrics({ register: this.registry });
  }

  incrementMentions(status: "received" | "processed" | "failed"): void {
    this.mentionsTotal.inc({ status });
  }

  incrementActions(action: string, status: string): void {
    this.actionsTotal.inc({ action, status });
  }

  incrementReplies(action: string): void {
    this.repliesTotal.inc({ action });
  }

  incrementAuthFailed(): void {
    this.authFailed.inc();
  }

  incrementSecurityEvent(rule: string): void {
    this.securityEvents.inc({ rule });
  }

  startActionTimer(action: string): () => void {
    const start = Date.now();
    return () => {
      this.actionDuration.observe({ action }, (Date.now() - start) / 1000);
    };
  }

  /** Internal exposition: includes the per-rule security-event breakdown. */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Public exposition (the /metrics HTTP surface): identical to getMetrics
   * except the security-event counter is collapsed into a single UNLABELED
   * total. The rule-id breakdown would give an attacker a whole-value
   * confirmation oracle (env_secret vs hex64 vs key_material), so it stays
   * internal-only.
   */
  async getPublicMetrics(): Promise<string> {
    const raw = await this.registry.metrics();
    const lines = raw.split("\n");
    let total = 0;
    for (const line of lines) {
      if (!line.startsWith("jeb_security_events_total{")) continue;
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (Number.isFinite(v)) total += v;
    }
    const out: string[] = [];
    let emitted = false;
    for (const line of lines) {
      if (line.startsWith("jeb_security_events_total{")) continue;
      out.push(line);
      if (!emitted && line.startsWith("# TYPE jeb_security_events_total")) {
        out.push(`jeb_security_events_total ${total}`);
        emitted = true;
      }
    }
    return out.join("\n");
  }
}

export const metrics = new MetricsService();
