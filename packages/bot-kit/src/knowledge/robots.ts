export interface RobotsRules {
  disallow: string[];
  allow: string[];
}

function parseGroup(text: string, ua: string): RobotsRules {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  const groups: Array<{ agents: string[]; rules: RobotsRules }> = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  const flush = () => {
    if (current) groups.push(current);
    current = null;
  };
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.disallow.length || current.rules.allow.length) {
        flush();
        current = { agents: [value.toLowerCase()], rules: { disallow: [], allow: [] } };
      } else {
        current.agents.push(value.toLowerCase());
      }
    } else if (key === "disallow" && current) {
      current.rules.disallow.push(value);
    } else if (key === "allow" && current) {
      current.rules.allow.push(value);
    }
  }
  flush();
  const want = ua.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a === want));
  const star = groups.find((g) => g.agents.includes("*"));
  return specific?.rules ?? star?.rules ?? { disallow: [], allow: [] };
}

export function pathAllowedByRobots(pathname: string, rules: RobotsRules): boolean {
  const matchLen = (prefixes: string[]): number => {
    let best = -1;
    for (const p of prefixes) {
      if (p === "") continue;
      if (pathname.startsWith(p) && p.length > best) best = p.length;
    }
    return best;
  };
  const d = matchLen(rules.disallow);
  const a = matchLen(rules.allow);
  if (d < 0) return true;
  return a > d;
}

export function parseRobotsTxt(text: string, userAgent: string): RobotsRules {
  return parseGroup(text, userAgent);
}
