/** Static safe-reference validation. No capability is ever invoked. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";
import { validateOperand } from "./expressions.mjs";
import { validateRegisteredSchema } from "./structure.mjs";
import { resolveCapability } from "./view_registry.mjs";
import { childPath, walk, isObject, isI18nPath } from "./view_safety.mjs";

function checkCapability(value, context, path) {
  const action = value.type === "ActionRef";
  const key = action ? "actionRef" : "queryRef";
  const [content, status] = resolveCapability(value[key], context);
  if (status !== "ok")
    return [
      null,
      [
        diagnostic(
          status === "digest"
            ? "VIEW_CAPABILITY_DIGEST_MISMATCH"
            : "VIEW_CAPABILITY_REF_INVALID",
          childPath(path, key),
        ),
      ],
    ];
  const code = action ? "VIEW_ACTION_FORBIDDEN" : "VIEW_DATA_SOURCE_FORBIDDEN";
  if (content.category !== (action ? "ACTION" : "QUERY"))
    return [null, [diagnostic(code, childPath(path, key))]];
  const slot = action ? "input" : "params";
  const errors = validateRegisteredSchema(
    content.inputSchema,
    value[slot] ?? {},
    childPath(path, slot),
    code,
  );
  for (const schemaKey of ["outputSchema", "errorSchema"])
    validateRegisteredSchema(content[schemaKey], {}, "", code);
  return [content, errors];
}

function expressionErrors(expr, fields, context, path) {
  const errors = [],
    stack = [[expr, path]];
  while (stack.length) {
    const [node, current] = stack.pop();
    if (Object.hasOwn(node, "all") || Object.hasOwn(node, "any")) {
      const key = Object.hasOwn(node, "all") ? "all" : "any";
      node[key].forEach((child, i) =>
        stack.push([child, `${current}.${key}[${i}]`]),
      );
    } else if (Object.hasOwn(node, "not"))
      stack.push([node.not, childPath(current, "not")]);
    else {
      const field = fields.get(node.left.fieldRef);
      if (
        field &&
        !validateOperand(
          field,
          node.operator,
          node.right,
          context,
          Object.hasOwn(node, "right"),
        )
      )
        errors.push(diagnostic("VIEW_EXPRESSION_UNSAFE", current));
    }
  }
  return errors;
}

export function validateBindings(spec, context, prefix, fields) {
  const errors = [],
    queries = new Map();
  (spec.queries ?? []).forEach((entry, index) => {
    const path = childPath(childPath(prefix, "queries"), index);
    if (queries.has(entry.query_code))
      errors.push(
        diagnostic("VIEW_DATA_SOURCE_FORBIDDEN", childPath(path, "query_code")),
      );
    else
      queries.set(
        entry.query_code,
        checkCapability(entry.query, context, childPath(path, "query"))[0],
      );
  });
  for (const [value, path] of walk(spec, prefix)) {
    if (!isObject(value) || isI18nPath(path)) continue;
    if (value.type === "FieldRef" && !fields.has(value.fieldRef))
      errors.push(
        diagnostic("VIEW_FIELD_REF_INVALID", childPath(path, "fieldRef")),
      );
    else if (
      value.type === "I18nRef" &&
      !Object.values(spec.i18n ?? {}).some((messages) =>
        Object.hasOwn(messages, value.key),
      )
    )
      errors.push(diagnostic("VIEW_PROP_INVALID", childPath(path, "key")));
    else if (value.type === "SafeExpression")
      errors.push(...expressionErrors(value, fields, context, path));
    else if (["ActionRef", "DataQueryRef"].includes(value.type))
      errors.push(...checkCapability(value, context, path)[1]);
    else if (value.type === "DataBindingRef") {
      if (!queries.has(value.queryCode))
        errors.push(
          diagnostic(
            "VIEW_DATA_SOURCE_FORBIDDEN",
            childPath(path, "queryCode"),
          ),
        );
      else if (
        queries.get(value.queryCode) &&
        !queries.get(value.queryCode).itemKeys.includes(value.itemKey)
      )
        errors.push(
          diagnostic("VIEW_DATA_SOURCE_FORBIDDEN", childPath(path, "itemKey")),
        );
    }
  }
  return sortedUnique(errors);
}
