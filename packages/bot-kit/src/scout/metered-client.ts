import type { ScoutClient } from "./client.js";
import type { ScoutCallMeter } from "./budget.js";

/**
 * Binding condition D2: at most 10 Scout calls and 20 s of Scout time per
 * request. The meter only means anything if it sees the calls, so wrap the
 * client the tools actually use: refuse the call that would breach the cap,
 * and record real elapsed time for every call, including failed ones.
 */
export function meteredScoutClient(
  client: ScoutClient,
  meter: ScoutCallMeter,
  now: () => number = () => Date.now(),
): ScoutClient {
  const metered: ScoutClient = Object.create(client);
  metered.query = async (opts: Parameters<ScoutClient["query"]>[0]) => {
    meter.reserve();
    const started = now();
    try {
      return await client.query(opts);
    } finally {
      meter.record(now() - started);
      // A call that crosses the cumulative cap fails closed after settlement.
      // If the upstream call stayed within budget, its original error wins.
      meter.assertBudget();
    }
  };
  return metered;
}
