/** Classify fixed Fake historical differences. No migration execution. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";
import { fitsDecimal } from "./values.mjs";
function equal(a, b) {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== typeof b ||
    typeof a !== "object"
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
}
export function validateHistory(spec, context, prefix) {
  const history = context.business?.history;
  if (!history) return [];
  const old = history.previous_spec,
    errors = [];
  const add = (code, path) =>
    errors.push(
      diagnostic(code, (prefix && prefix !== "$" ? prefix + "." : "") + path),
    );
  if (spec.schema_code !== old.schema_code)
    add("SCHEMA_CODE_INVALID", "schema_code");
  const before = new Map(old.fields.map((f) => [f.field_code, f])),
    after = new Map(spec.fields.map((f) => [f.field_code, f]));
  // Logical omission, used data, and an explicitly known identity change differ.
  const removed = new Set(
    [...before.keys()].filter((code) => !after.has(code)),
  );
  const renamed = new Map(
    (history.field_identity_changes ?? [])
      .filter(
        (item) =>
          removed.has(item.previous_code) && after.has(item.current_code),
      )
      .map((item) => [item.previous_code, item.current_code]),
  );
  const used = new Set(history.used_fields ?? []);
  if ([...removed].some((code) => used.has(code)))
    add("BREAKING_CHANGE_FORBIDDEN", "fields");
  else if ([...removed].some((code) => !renamed.has(code)))
    add("MIGRATION_REQUIRED", "fields");
  const deleted = new Set(history.deleted_field_codes ?? []);
  spec.fields.forEach((f, i) => {
    const p = `fields[${i}]`,
      code = f.field_code,
      prior = before.get(code);
    if (deleted.has(code) || [...renamed.values()].includes(code))
      add("FIELD_CODE_INVALID", p + ".field_code");
    if (!prior) {
      if (f.required) add("MIGRATION_REQUIRED", p);
      return;
    }
    if (f.type !== prior.type) {
      add("BREAKING_CHANGE_FORBIDDEN", p + ".type");
      return;
    }
    let migration = ["required", "nullable", "write_policy"].some(
        (k) => f[k] !== prior[k],
      ),
      breaking = false;
    if (
      Object.hasOwn(f, "default") !== Object.hasOwn(prior, "default") ||
      !equal(f.default, prior.default)
    )
      migration = true;
    const kind = f.type,
      oldlim = prior.constraints ?? {},
      newlim = f.constraints ?? {},
      oldcfg = prior.type_config ?? {},
      newcfg = f.type_config ?? {};
    const samples = Object.hasOwn(history.value_samples ?? {}, code)
      ? history.value_samples[code]
      : [];
    if (["short_text", "long_text"].includes(kind)) {
      const fallback = kind === "short_text" ? 255 : 5000,
        maximum = newlim.max_length ?? fallback;
      if (maximum < (oldlim.max_length ?? fallback)) {
        migration = true;
        breaking = samples.some(
          (v) => typeof v === "string" && [...v].length > maximum,
        );
      }
    }
    if (kind === "decimal") {
      const op = [oldcfg.precision ?? 18, oldcfg.scale ?? 2],
        np = [newcfg.precision ?? 18, newcfg.scale ?? 2];
      if (!equal(op, np)) {
        migration = true;
        breaking = samples.some((v) => v !== null && !fitsDecimal(v, ...np));
      }
    }
    if (kind === "money" && !equal(oldcfg, newcfg)) breaking = true;
    if (["single_select", "multi_select"].includes(kind)) {
      const newopts = new Set(newcfg.options.map((o) => o.code)),
        removed = oldcfg.options
          .map((o) => o.code)
          .filter((c) => !newopts.has(c));
      const used = new Set(
        Object.hasOwn(history.used_options ?? {}, code)
          ? history.used_options[code]
          : [],
      );
      if (removed.some((c) => used.has(c)))
        add("BREAKING_CHANGE_FORBIDDEN", p + ".type_config.options");
      else if (removed.length) migration = true;
    }
    for (const key of new Set([
      ...Object.keys(oldlim),
      ...Object.keys(newlim),
    ])) {
      if (
        kind === "short_text" &&
        key === "min_length" &&
        (oldlim[key] ?? 0) === (newlim[key] ?? 0)
      )
        continue;
      if (key === "max_length" && ["short_text", "long_text"].includes(kind))
        continue;
      if (
        kind === "multi_select" &&
        key === "max_items" &&
        (oldlim[key] ?? 20) === (newlim[key] ?? 20)
      )
        continue;
      if (
        kind === "short_text" &&
        key === "trim" &&
        (oldlim[key] ?? false) === (newlim[key] ?? false)
      )
        continue;
      if (!equal(oldlim[key], newlim[key])) migration = true;
    }
    if (breaking) add("BREAKING_CHANGE_FORBIDDEN", p);
    else if (migration) add("MIGRATION_REQUIRED", p);
  });
  const priorIndexes = new Map(
    (old.indexes ?? []).map((i) => [i.index_code, i]),
  );
  (spec.indexes ?? []).forEach((index, i) => {
    if (
      index.kind === "UNIQUE" &&
      !equal(priorIndexes.get(index.index_code), index)
    )
      add("MIGRATION_REQUIRED", `indexes[${i}]`);
  });
  return sortedUnique(errors);
}
