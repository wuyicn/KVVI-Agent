/** Linear matching of a parsed safe subset. User patterns never reach RegExp. */
export const SPACES = new Set([
  ..."\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
]);
const ESCAPED = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["f", "\f"],
  ["v", "\v"],
]);
export function parseSafePattern(pattern) {
  if (typeof pattern !== "string" || [...pattern].length > 200)
    return { valid: false };
  const chars = [...pattern],
    atoms = [];
  let i = 0,
    start = chars[0] === "^",
    end = false;
  if (start) i++;
  function escape() {
    if (i >= chars.length) throw Error();
    const c = chars[i++];
    if ("dDwWsS".includes(c)) return ["set", c];
    if (ESCAPED.has(c)) return ["literal", ESCAPED.get(c)];
    if ("\\.^$[]{}()*+?|-/".includes(c)) return ["literal", c];
    throw Error();
  }
  function decimal() {
    const begin = i;
    while (i < chars.length && chars[i] >= "0" && chars[i] <= "9") i++;
    if (i === begin) throw Error();
    return BigInt(chars.slice(begin, i).join(""));
  }
  try {
    while (i < chars.length) {
      const c = chars[i++];
      let atom;
      if (c === "$" && i === chars.length) {
        end = true;
        break;
      }
      if (c === "\\") atom = escape();
      else if (c === "[") {
        const neg = chars[i] === "^";
        if (neg) i++;
        const members = [];
        while (i < chars.length && chars[i] !== "]") {
          let first = chars[i++];
          first = first === "\\" ? escape() : ["literal", first];
          if (
            chars[i] === "-" &&
            i + 1 < chars.length &&
            chars[i + 1] !== "]"
          ) {
            i++;
            let last = chars[i++];
            last = last === "\\" ? escape() : ["literal", last];
            if (
              first[0] !== "literal" ||
              last[0] !== "literal" ||
              first[1].codePointAt(0) > last[1].codePointAt(0)
            )
              throw Error();
            members.push(["range", [first[1], last[1]]]);
          } else members.push(first);
        }
        if (!members.length || i >= chars.length) throw Error();
        i++;
        atom = ["class", [neg, members]];
      } else if (c === ".") atom = ["dot", null];
      else if ("^$]()|*+?{}".includes(c)) throw Error();
      else atom = ["literal", c];
      let low = 1n,
        high = 1n;
      if (i < chars.length && "?*+".includes(chars[i])) {
        const q = chars[i++];
        low = q === "+" ? 1n : 0n;
        high = q === "?" ? 1n : null;
      } else if (chars[i] === "{") {
        i++;
        low = decimal();
        high = low;
        if (chars[i] === ",") {
          i++;
          high = decimal();
        }
        if (chars[i++] !== "}" || low > high) throw Error();
      }
      atoms.push([atom, low, high]);
    }
    return { valid: true, atoms, start, end };
  } catch {
    return { valid: false };
  }
}

function matches([kind, v], c) {
  if (kind === "literal") return c === v;
  if (kind === "dot") return !"\n\r\u2028\u2029".includes(c);
  if (kind === "range")
    return (
      c.codePointAt(0) >= v[0].codePointAt(0) &&
      c.codePointAt(0) <= v[1].codePointAt(0)
    );
  if (kind === "class") {
    const hit = v[1].some((member) => matches(member, c));
    return v[0] ? !hit : hit;
  }
  const base = v.toLowerCase();
  const hit =
    base === "d"
      ? c >= "0" && c <= "9"
      : base === "s"
        ? SPACES.has(c)
        : (c >= "a" && c <= "z") ||
          (c >= "A" && c <= "Z") ||
          (c >= "0" && c <= "9") ||
          c === "_";
  return base === v ? hit : !hit;
}

export function matchSafePattern(parsed, text) {
  if (!parsed.valid) return false;
  const chars = [...text],
    n = chars.length,
    cap = BigInt(n + 1);
  let positions = Array.from(
    { length: n + 1 },
    (_, j) => !parsed.start || j === 0,
  );
  for (const [atom, min, max] of parsed.atoms) {
    const low = Number(min > cap ? cap : min),
      high = Number(max === null || max > cap ? cap : max);
    const prefix = [0];
    for (const yes of positions) prefix.push(prefix.at(-1) + Number(yes));
    const next = Array(n + 1).fill(false);
    let streak = 0;
    for (let end = 0; end <= n; end++) {
      if (end) streak = matches(atom, chars[end - 1]) ? streak + 1 : 0;
      const left = Math.max(0, end - high, end - streak),
        right = end - low;
      if (right >= left) next[end] = prefix[right + 1] > prefix[left];
    }
    positions = next;
  }
  return parsed.end ? positions[n] : positions.some(Boolean);
}
