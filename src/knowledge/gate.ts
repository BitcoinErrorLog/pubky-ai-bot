import {
  evaluateGate as kitEvaluateGate,
  logRefusal,
  refuseContent as kitRefuseContent,
  refusePath as kitRefusePath,
  type GateResult,
} from "../bot-kit/knowledge/gate.js";
import { JEB_GATE_RULES, type JebRefusalRule } from "./gate-rules.js";

export { logRefusal, type GateResult };
export type { JebRefusalRule as RefusalRule };

export function refusePath(filePath: string, confidentiality?: string): GateResult {
  return kitRefusePath(filePath, confidentiality, JEB_GATE_RULES);
}

export function refuseContent(text: string): GateResult {
  return kitRefuseContent(text, JEB_GATE_RULES);
}

export function evaluateGate(filePath: string, content: string | null, confidentiality?: string): GateResult {
  return kitEvaluateGate(filePath, content, confidentiality, JEB_GATE_RULES);
}
