import client from "prom-client";

export class MetricsService {
  private readonly registry: client.Registry;
  private readonly mentionsTotal: client.Counter<string>;
  private readonly actionsTotal: client.Counter<string>;
  private readonly repliesTotal: client.Counter<string>;
  private readonly actionDuration: client.Histogram<string>;

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

  startActionTimer(action: string): () => void {
    const start = Date.now();
    return () => {
      this.actionDuration.observe({ action }, (Date.now() - start) / 1000);
    };
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}

export const metrics = new MetricsService();
