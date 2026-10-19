/** Shared static component tree rules. No asset resolution or publication authority. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";
import { validateStructure, validateRegisteredSchema } from "./structure.mjs";
import { childPath, isObject } from "./view_safety.mjs";
import { validateSecrets } from "./secret_safety.mjs";
import { validLocale } from "./view_locale.mjs";
import { fieldReferenceErrors } from "./view_bindings.mjs";

export function checkViewTree(spec, {
  components: definitions, modelFields, deletedNodeIds = [],
  allowRoot = definition => definition.allowedParents.length === 0, prefix = "",
}) {
  const shape = validateStructure("view-schema/lce-safe-v1", "spec", spec);
  if (shape.length) {
    const base = ["", "$"].includes(prefix) ? "" : prefix;
    return shape.map((e) => ({
      ...e,
      path:
        base +
          (e.path === "$"
            ? ""
            : (e.path.startsWith("[") || !base ? "" : ".") + e.path) || "$",
    }));
  }
  const fields = new Map(modelFields.map((f) => [f.field_code, f]));
  const components = new Map(
    definitions.map((c) => [c.componentName, c]),
  );
  const errors = validateSecrets(spec, prefix),
    seen = new Set(deletedNodeIds);
  const stack = spec.componentsTree.map((n, i) => [
    n,
    childPath(childPath(prefix, "componentsTree"), i),
    null,
  ]);
  while (stack.length) {
    const [node, path, parent] = stack.pop();
    if (seen.has(node.id))
      errors.push(diagnostic("VIEW_NODE_ID_DUPLICATE", childPath(path, "id")));
    seen.add(node.id);
    const definition = components.get(node.componentName);
    if (
      !definition ||
      definition.state !== "PUBLISHED" ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1 ||
      !definition.viewTypes.includes(spec.view_type)
    ) {
      errors.push(
        diagnostic(
          "VIEW_COMPONENT_UNREGISTERED",
          childPath(path, "componentName"),
        ),
      );
      continue;
    }
    if (
      (parent === null && !allowRoot(definition)) ||
      (parent !== null && !definition.allowedParents.includes(parent))
    )
      errors.push(diagnostic("VIEW_CHILD_NOT_ALLOWED", path));
    const props = node.props ?? {};
    errors.push(
      ...validateRegisteredSchema(
        definition.propsSchema,
        props,
        childPath(path, "props"),
        "VIEW_PROP_INVALID",
      ),
    );
    for (const [prop, value] of Object.entries(props)) {
      if (
        isObject(value) &&
        Object.hasOwn(value, "type") &&
        !(
          Object.hasOwn(definition.bindingPositions, prop)
            ? definition.bindingPositions[prop]
            : []
        ).includes(value.type)
      )
        errors.push(
          diagnostic(
            "VIEW_PROP_INVALID",
            childPath(childPath(path, "props"), prop, true),
          ),
        );
    }
    if (
      isObject(props.fieldBinding) &&
      props.fieldBinding.type === "FieldRef"
    ) {
      const field = fields.get(props.fieldBinding.fieldRef);
      if (field && !definition.fieldTypes.includes(field.type))
        errors.push(
          diagnostic(
            "VIEW_FIELD_REF_INVALID",
            childPath(childPath(path, "props"), "fieldBinding", true),
          ),
        );
    }
    if (Object.hasOwn(node, "loopArgs") && !Object.hasOwn(node, "loop"))
      errors.push(diagnostic("VIEW_PROP_INVALID", childPath(path, "loopArgs")));
    if (Object.hasOwn(node, "loop") && !definition.loopSupported)
      errors.push(diagnostic("VIEW_PROP_INVALID", childPath(path, "loop")));
    for (const [event, action] of Object.entries(node.actions ?? {})) {
      const eventPath = childPath(childPath(path, "actions"), event, true);
      if (!Object.hasOwn(definition.events, event))
        errors.push(diagnostic("VIEW_ACTION_FORBIDDEN", eventPath));
      else if (
        !definition.events[event].includes(action.actionRef.capability_code)
      )
        errors.push(
          diagnostic(
            "VIEW_ACTION_FORBIDDEN",
            childPath(eventPath, "actionRef"),
          ),
        );
    }
    const children = node.children ?? [];
    if (
      children.length > definition.maxChildren ||
      children.some(
        (c) =>
          components.has(c.componentName) &&
          !definition.allowedChildren.includes(c.componentName),
      )
    )
      errors.push(
        diagnostic("VIEW_CHILD_NOT_ALLOWED", childPath(path, "children")),
      );
    else
      for (let i = children.length - 1; i >= 0; i--)
        stack.push([
          children[i],
          childPath(childPath(path, "children"), i),
          node.componentName,
        ]);
  }
  for (const locale of Object.keys(spec.i18n ?? {}))
    if (!validLocale(locale))
      errors.push(
        diagnostic(
          "VIEW_PROP_INVALID",
          childPath(childPath(prefix, "i18n"), locale, true),
        ),
      );
  if (!errors.some(e => e.code === "VIEW_PROP_INVALID"))
    errors.push(...fieldReferenceErrors(spec, fields, prefix));
  return sortedUnique(errors);
}
