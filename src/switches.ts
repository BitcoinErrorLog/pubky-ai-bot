export type SwitchName = "consumption" | "generation" | "replies" | "scout" | "web" | "proactive";

export const ALL_SWITCHES: SwitchName[] = [
  "consumption",
  "generation",
  "replies",
  "scout",
  "web",
  "proactive",
];

export function envSwitchOn(name: SwitchName | "global"): boolean {
  if (process.env.JEB_DISABLED === "1") return true;
  if (process.env.JEB_SWITCH_GLOBAL === "1") return true;
  const key = `JEB_SWITCH_${name.toUpperCase()}`;
  return process.env[key] === "1";
}
