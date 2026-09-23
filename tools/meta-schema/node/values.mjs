/** Exact decimal strings and pure type checking; no floating point amount math. */
import { SPACES, parseSafePattern, matchSafePattern } from "./safe_pattern.mjs";
export const SORTABLE = new Set([
  "boolean",
  "short_text",
  "integer",
  "decimal",
  "money",
  "date",
  "datetime",
  "single_select",
]);
export function decimalParts(value) {
  if (
    typeof value !== "string" ||
    !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$(?![\s\S])/u.test(value)
  )
    return null;
  const negative = value[0] === "-",
    body = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = body.split(".");
  return { negative, whole, fraction };
}
export function compareDecimal(left, right) {
  const a = decimalParts(left),
    b = decimalParts(right);
  if (!a || !b) throw Error("invalid decimal");
  const an = a.negative && /[1-9]/u.test(a.whole + a.fraction),
    bn = b.negative && /[1-9]/u.test(b.whole + b.fraction);
  if (an !== bn) return an ? -1 : 1;
  let order = 0;
  if (a.whole.length !== b.whole.length)
    order = a.whole.length > b.whole.length ? 1 : -1;
  else if (a.whole !== b.whole) order = a.whole > b.whole ? 1 : -1;
  else {
    const width = Math.max(a.fraction.length, b.fraction.length),
      av = a.fraction.padEnd(width, "0"),
      bv = b.fraction.padEnd(width, "0");
    order = av === bv ? 0 : av > bv ? 1 : -1;
  }
  return an ? -order : order;
}
export function fitsDecimal(value, precision, scale) {
  const p = decimalParts(value);
  return (
    !!p &&
    p.fraction.length <= scale &&
    p.whole.replace(/^0+/u, "").length <= precision - scale
  );
}
export function validDate(value) {
  if (typeof value !== "string") return false;
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$(?![\s\S])/u.exec(value);
  if (!m) return false;
  const y = Number(m[1]),
    month = Number(m[2]),
    day = Number(m[3]);
  if (y < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}
export function validDatetime(value) {
  if (typeof value !== "string") return false;
  const m =
    /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})$(?![\s\S])/u.exec(
      value,
    );
  return (
    !!m &&
    validDate(m[1]) &&
    Number(m[2]) <= 23 &&
    Number(m[3]) <= 59 &&
    Number(m[4]) <= 59 &&
    (m[6] === "Z" ||
      (Number(m[6].slice(1, 3)) <= 23 && Number(m[6].slice(4, 6)) <= 59))
  );
}
export function validTypedValue(
  field,
  value,
  context,
  { constraints = true } = {},
) {
  if (value === null) return field.nullable;
  const kind = field.type,
    cfg = field.type_config ?? {},
    limits = constraints ? (field.constraints ?? {}) : {};
  if (kind === "short_text" || kind === "long_text") {
    if (typeof value !== "string") return false;
    let text = value;
    if (limits.trim) {
      const chars = [...value];
      let start = 0,
        end = chars.length;
      while (start < end && SPACES.has(chars[start])) start++;
      while (end > start && SPACES.has(chars[end - 1])) end--;
      text = chars.slice(start, end).join("");
    }
    const size = [...text].length;
    if (
      constraints &&
      size > (limits.max_length ?? (kind === "short_text" ? 255 : 5000))
    )
      return false;
    if (size < (limits.min_length ?? 0)) return false;
    if (
      Object.hasOwn(limits, "pattern") &&
      !matchSafePattern(parseSafePattern(limits.pattern), text)
    )
      return false;
  } else if (kind === "boolean") return typeof value === "boolean";
  else if (kind === "integer") {
    if (!Number.isSafeInteger(value)) return false;
  } else if (kind === "decimal") {
    if (!fitsDecimal(value, cfg.precision ?? 18, cfg.scale ?? 2)) return false;
  } else if (kind === "money") {
    const rules = context.business?.money_rules ?? {},
      rule = Object.hasOwn(rules, cfg.currency) ? rules[cfg.currency] : null;
    if (
      !rule ||
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "amount,currency" ||
      value.currency !== cfg.currency
    )
      return false;
    if (!fitsDecimal(value.amount, rule.precision, rule.scale)) return false;
    value = value.amount;
  } else if (kind === "date") {
    if (!validDate(value)) return false;
  } else if (kind === "datetime") return validDatetime(value);
  else if (kind === "single_select" || kind === "multi_select") {
    const enabled = new Set(
      cfg.options.filter((o) => o.enabled || !constraints).map((o) => o.code),
    );
    if (kind === "single_select")
      return typeof value === "string" && enabled.has(value);
    return (
      Array.isArray(value) &&
      value.every((v) => typeof v === "string" && enabled.has(v)) &&
      new Set(value).size === value.length &&
      (!constraints || value.length <= (limits.max_items ?? 20))
    );
  } else return false;
  for (const [key, direction] of [
    ["minimum", -1],
    ["maximum", 1],
  ]) {
    if (!Object.hasOwn(limits, key)) continue;
    const cmp =
      kind === "decimal" || kind === "money"
        ? compareDecimal(value, limits[key])
        : value === limits[key]
          ? 0
          : value > limits[key]
            ? 1
            : -1;
    if (cmp === direction) return false;
  }
  return true;
}
