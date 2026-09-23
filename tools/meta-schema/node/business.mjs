/** Static Business linter. Only consumes already structurally validated specs. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";
import { compareDecimal, validDate, validTypedValue } from "./values.mjs";
import { parseSafePattern } from "./safe_pattern.mjs";
import { validateExpressions } from "./expressions.mjs";
import { validateHistory } from "./business_history.mjs";
import { validateSecrets } from "./secret_safety.mjs";
const PLATFORM = new Set([
  "id",
  "tenant_id",
  "form_code",
  "schema_version",
  "status",
  "owner_id",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at",
]);
const RESERVED = new Set([...PLATFORM, "data", "record_no"]);
export function validateBusiness(spec, context, prefix) {
  const errors = validateSecrets(spec, prefix),
    path = (p) => (prefix && prefix !== "$" ? prefix + "." : "") + p;
  const add = (p, code = "CONSTRAINT_INCOMPATIBLE") =>
    errors.push(diagnostic(code, path(p)));
  const textCheck = (text, p) => {
    if (/<\/?[A-Za-z][A-Za-z0-9:-]*(?:[ \t\r\n/>])|<![A-Za-z-]/u.test(text))
      add(p, "ARBITRARY_EXPRESSION_FORBIDDEN");
  };
  if (Object.hasOwn(spec, "description"))
    textCheck(spec.description, "description");
  const config = context.business;
  if (!config) return [diagnostic("DEPENDENCY_VALIDATOR_UNAVAILABLE", prefix)];
  const fields = new Map(),
    numbering = spec.record_number?.field_code;
  if (
    PLATFORM.has(numbering) ||
    numbering === "data" ||
    numbering?.startsWith("_platform_")
  )
    add("record_number.field_code", "FIELD_CODE_INVALID");
  spec.fields.forEach((f, i) => {
    const p = `fields[${i}]`,
      code = f.field_code,
      kind = f.type,
      cfg = f.type_config ?? {},
      limits = f.constraints ?? {};
    if (Object.hasOwn(f, "description"))
      textCheck(f.description, p + ".description");
    if (
      RESERVED.has(code) ||
      code.startsWith("_platform_") ||
      code === numbering
    )
      add(p + ".field_code", "FIELD_CODE_INVALID");
    if (fields.has(code)) add(p + ".field_code", "FIELD_CODE_DUPLICATE");
    fields.set(code, f);
    if (!(config.enabled_types ?? []).includes(kind))
      add(p + ".type", "FIELD_TYPE_UNREGISTERED");
    if (f.required && f.nullable) add(p + ".nullable");
    if (
      f.write_policy === "SYSTEM" &&
      !(config.generators ?? []).some(
        (g) =>
          g.schema_code === spec.schema_code &&
          g.field_code === code &&
          g.type === kind,
      )
    )
      add(p + ".write_policy");
    if (
      f.query.searchable &&
      !["short_text", "long_text", "single_select", "multi_select"].includes(
        kind,
      )
    )
      add(p + ".query.searchable");
    if (f.query.sortable && ["long_text", "multi_select"].includes(kind))
      add(p + ".query.sortable");
    let validLimits = true;
    if (kind === "short_text") {
      if ((limits.min_length ?? 0) > (limits.max_length ?? 255)) {
        add(p + ".constraints");
        validLimits = false;
      }
      if (
        Object.hasOwn(limits, "pattern") &&
        !parseSafePattern(limits.pattern).valid
      ) {
        add(p + ".constraints.pattern");
        validLimits = false;
      }
    }
    if (kind === "decimal" && (cfg.scale ?? 2) > (cfg.precision ?? 18)) {
      add(p + ".type_config");
      validLimits = false;
    }
    if (
      kind === "money" &&
      !Object.hasOwn(config.money_rules ?? {}, cfg.currency)
    ) {
      add(p + ".type_config", "DEPENDENCY_VALIDATOR_UNAVAILABLE");
      validLimits = false;
    }
    if (["single_select", "multi_select"].includes(kind)) {
      const seen = new Set();
      cfg.options.forEach((o, j) => {
        if (seen.has(o.code)) add(p + `.type_config.options[${j}].code`);
        seen.add(o.code);
      });
    }
    if (kind === "date")
      for (const key of ["minimum", "maximum"])
        if (Object.hasOwn(limits, key) && !validDate(limits[key])) {
          add(p + ".constraints." + key);
          validLimits = false;
        }
    if (
      validLimits &&
      Object.hasOwn(limits, "minimum") &&
      Object.hasOwn(limits, "maximum")
    ) {
      const reverse = ["decimal", "money"].includes(kind)
        ? compareDecimal(limits.minimum, limits.maximum) > 0
        : limits.minimum > limits.maximum;
      if (reverse) {
        add(p + ".constraints");
        validLimits = false;
      }
    }
    if (
      validLimits &&
      Object.hasOwn(f, "default") &&
      !validTypedValue(f, f.default, context)
    )
      add(p + ".default");
  });
  const indexCodes = new Set();
  (spec.indexes ?? []).forEach((index, i) => {
    const p = `indexes[${i}]`;
    if (indexCodes.has(index.index_code)) add(p + ".index_code");
    indexCodes.add(index.index_code);
    const seen = new Set();
    index.fields.forEach((code, j) => {
      const f = fields.get(code);
      if (
        seen.has(code) ||
        (!f && code !== numbering) ||
        (f && f.type === "long_text" && index.kind === "UNIQUE")
      )
        add(p + `.fields[${j}]`);
      if (f) {
        const table = config.index_capabilities ?? {};
        if (!Object.hasOwn(table, f.type))
          add(p + `.fields[${j}]`, "DEPENDENCY_VALIDATOR_UNAVAILABLE");
        else if (!table[f.type].includes(index.kind)) add(p + `.fields[${j}]`);
      }
      seen.add(code);
    });
  });
  const used = new Set(),
    sections = new Set();
  (spec.layout?.sections ?? []).forEach((s, i) => {
    const p = `layout.sections[${i}]`;
    if (sections.has(s.section_code)) add(p + ".section_code");
    sections.add(s.section_code);
    textCheck(s.title, p + ".title");
    if (Object.hasOwn(s, "description"))
      textCheck(s.description, p + ".description");
    s.items.forEach((item, j) => {
      if (item.kind !== "field") {
        textCheck(item.text, p + `.items[${j}].text`);
        return;
      }
      const ip = p + `.items[${j}]`,
        code = item.field_code;
      if (!fields.has(code) && !PLATFORM.has(code) && code !== numbering)
        add(ip + ".field_code");
      if (fields.has(code) && used.has(code)) add(ip + ".field_code");
      if (item.col_span > s.columns) add(ip + ".col_span");
      used.add(code);
    });
  });
  const rules = new Set();
  (spec.record_rules ?? []).forEach((r, i) => {
    const p = `record_rules[${i}]`;
    if (rules.has(r.rule_code)) add(p + ".rule_code");
    rules.add(r.rule_code);
    const roots = ["when", "assert"]
      .filter((k) => Object.hasOwn(r, k))
      .map((k) => [r[k], path(p + "." + k)]);
    errors.push(...validateExpressions(roots, fields, context, path(p)));
  });
  errors.push(...validateHistory(spec, context, prefix));
  return sortedUnique(errors);
}
