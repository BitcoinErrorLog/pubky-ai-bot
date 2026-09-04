export function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replaceAll("\\", "/");
  let re = "^";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        const slash = norm[i + 2] === "/" ? 1 : 0;
        re += slash ? "(?:.*/)?" : ".*";
        i += 1 + slash;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+{}[]()|.".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re, "i");
}

export function matchAny(relPath: string, patterns: string[], opts?: { basename?: boolean }): boolean {
  const norm = relPath.replaceAll("\\", "/");
  const base = norm.split("/").pop() ?? "";
  return patterns.some((p) => {
    const re = globToRegExp(p);
    if (re.test(norm)) return true;
    if (opts?.basename && re.test(base)) return true;
    return false;
  });
}

export function selectedByGlobs(relPath: string, include: string[], exclude: string[]): boolean {
  if (include.length === 0) return false;
  if (!matchAny(relPath, include)) return false;
  if (exclude.length > 0 && matchAny(relPath, exclude, { basename: true })) return false;
  return true;
}
