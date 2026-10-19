/** Content-bound Fake component checks; no renderer or permission runtime. */
import { diagnostic, sortedUnique } from "./diagnostics.mjs";
import { validateStructure } from "./structure.mjs";
import { validateBindings } from "./view_bindings.mjs";
import { resolveAsset } from "./view_registry.mjs";
import { childPath } from "./view_safety.mjs";
import { checkViewTree } from "./view_tree.mjs";

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
  const errors = checkViewTree(spec, {
    components: registry.components, modelFields: business.fields,
    deletedNodeIds: context.view?.deleted_node_ids ?? [], prefix,
  });
  if (!errors.some((e) => e.code === "VIEW_PROP_INVALID"))
    errors.push(...validateBindings(spec, context, prefix, fields));
  return sortedUnique(errors);
}
