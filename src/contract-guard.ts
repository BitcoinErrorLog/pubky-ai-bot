export function assertContractGuard(nexusUrl: string, mode = process.env.JEB_CONTRACT_MODE): void {
  if (mode !== "1") throw new Error("contract adapter requires JEB_CONTRACT_MODE=1");
  let host: string;
  try {
    host = new URL(nexusUrl).hostname;
  } catch {
    throw new Error("contract adapter requires a loopback Nexus URL");
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("contract adapter only talks to loopback Nexus");
  }
}
