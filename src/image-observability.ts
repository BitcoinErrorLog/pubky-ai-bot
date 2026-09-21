import { log } from "./log.js";
import {
  metrics,
  type ImageEventOutcome,
  type ImageEventStage,
} from "./metrics.js";

type ImageEventName =
  | "image_discovery"
  | "image_reservation"
  | "image_model_completion"
  | "image_model_failure"
  | "image_settlement";

type SafeImageFields = Readonly<Record<string, number | string>>;

/**
 * Observability is best-effort and must never change image processing,
 * reservation, provider, or settlement outcomes.
 */
export function emitImageEvent(
  level: "info" | "warn" | "error",
  stage: ImageEventStage,
  event: ImageEventName,
  outcome: ImageEventOutcome,
  fields: SafeImageFields,
  message: string,
): void {
  try {
    log[level]({ event, ...fields, outcome }, message);
  } catch {
    // Logging is non-authoritative.
  }
  try {
    metrics.incrementImageEvent(stage, outcome);
  } catch {
    // Metrics are non-authoritative and never mask product work.
  }
}
