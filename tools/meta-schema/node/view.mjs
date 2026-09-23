/** Content-bound Fake component checks; no renderer or permission runtime. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";
import { validateStructure, validateRegisteredSchema } from "./structure.mjs";
import { validateBindings } from "./view_bindings.mjs";
import { validLocale } from "./view_locale.mjs";
import { resolveAsset } from "./view_registry.mjs";
import { childPath, isObject } from "./view_safety.mjs";
import { validateSecrets } from "./secret_safety.mjs";

export function validateView(spec, context, prefix) {
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
  const [registry, registryStatus] = resolveAsset(
    spec.componentRegistryRef,
    context,
  );
  if (
    registryStatus !== "ok" ||
    registry.fixture !== true ||
    registry.state !== "PUBLISHED" ||
    registry.version !== spec.componentRegistryRef.version
  )
    return [
      diagnostic(
        "VIEW_COMPONENT_UNREGISTERED",
        childPath(prefix, "componentRegistryRef"),
      ),
    ];
  const [business, businessStatus] = resolveAsset(
    spec.businessSchemaRef,
    context,
  );
  if (businessStatus !== "ok")
    return [
      diagnostic(
        "VIEW_REFERENCE_VERSION_CONFLICT",
        childPath(prefix, "businessSchemaRef"),
      ),
    ];
  const fields = new Map(business.fields.map((f) => [f.field_code, f]));
  const components = new Map(
    registry.components.map((c) => [c.componentName, c]),
  );
  const errors = validateSecrets(spec, prefix),
    seen = new Set(context.view?.deleted_node_ids ?? []);
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
      (parent === null && definition.allowedParents.length) ||
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
  if (!errors.some((e) => e.code === "VIEW_PROP_INVALID"))
    errors.push(...validateBindings(spec, context, prefix, fields));
  return sortedUnique(errors);
}
