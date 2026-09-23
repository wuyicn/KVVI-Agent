/** Shared typed operands; the caller controls Business versus View AST keys. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";
import { SORTABLE, validTypedValue } from "./values.mjs";
export function businessBudgetErrors(spec, prefix) {
  if (!spec || !Array.isArray(spec.record_rules)) return [];
  const errors = [];
  spec.record_rules.forEach((rule, i) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return;
    const path =
      (prefix && prefix !== "$" ? prefix + "." : "") + `record_rules[${i}]`;
    let count = 0;
    for (const key of ["when", "assert"]) {
      if (count > 20) break;
      if (!Object.hasOwn(rule, key)) continue;
      const stack = [[rule[key], 1]];
      let deep = false;
      while (stack.length && count <= 20) {
        const [node, depth] = stack.pop();
        if (depth > 3) {
          deep = true;
          break;
        }
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;
        // Shape exclusivity has not been established: scan every recursive slot.
        if (Object.hasOwn(node, "field")) count++;
        for (const slot of ["all", "any"]) {
          const children = Object.hasOwn(node, slot) ? node[slot] : undefined;
          if (Array.isArray(children)) {
            if (children.length > 20) {
              count = 21;
              break;
            }
            children.forEach((child) => stack.push([child, depth + 1]));
          }
        }
        if (Object.hasOwn(node, "not")) stack.push([node.not, depth + 1]);
      }
      if (deep)
        errors.push(diagnostic("CONSTRAINT_INCOMPATIBLE", path + "." + key));
    }
    if (count > 20) errors.push(diagnostic("CONSTRAINT_INCOMPATIBLE", path));
  });
  return sortedUnique(errors);
}
export function validateOperand(
  field,
  operator,
  value,
  context,
  hasValue = true,
) {
  if (["is_empty", "not_empty"].includes(operator)) return !hasValue;
  if (!hasValue) return false;
  if (["gt", "gte", "lt", "lte"].includes(operator))
    return (
      SORTABLE.has(field.type) &&
      value !== null &&
      validTypedValue(field, value, context, { constraints: false })
    );
  if (["eq", "ne"].includes(operator))
    return validTypedValue(field, value, context, { constraints: false });
  if (["in", "not_in"].includes(operator))
    return (
      Array.isArray(value) &&
      value.every((v) =>
        validTypedValue(field, v, context, { constraints: false }),
      )
    );
  return false;
}
export function validateExpressions(roots, fields, context, rulePath) {
  const errors = [];
  let leaves = 0;
  for (const [root, path] of roots) {
    const stack = [[root, path, 1]];
    let tooDeep = false;
    while (stack.length) {
      const [expr, current, depth] = stack.pop();
      if (depth > 3) {
        tooDeep = true;
        continue;
      }
      if (Object.hasOwn(expr, "all") || Object.hasOwn(expr, "any")) {
        const key = Object.hasOwn(expr, "all") ? "all" : "any";
        expr[key].forEach((child, i) =>
          stack.push([child, `${current}.${key}[${i}]`, depth + 1]),
        );
      } else if (Object.hasOwn(expr, "not"))
        stack.push([expr.not, current + ".not", depth + 1]);
      else {
        leaves++;
        const field = fields.get(expr.field);
        if (!field)
          errors.push(
            diagnostic("CONSTRAINT_INCOMPATIBLE", current + ".field"),
          );
        else if (
          !validateOperand(
            field,
            expr.operator,
            expr.value,
            context,
            Object.hasOwn(expr, "value"),
          )
        )
          errors.push(diagnostic("CONSTRAINT_INCOMPATIBLE", current));
      }
    }
    if (tooDeep) errors.push(diagnostic("CONSTRAINT_INCOMPATIBLE", path));
  }
  if (leaves > 20) errors.push(diagnostic("CONSTRAINT_INCOMPATIBLE", rulePath));
  return sortedUnique(errors);
}
