/** Offline Ajv Draft 2020-12 loading and structural validation. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validDate, validDatetime } from "./values.mjs";
import { readBundle } from './bundle-policy.mjs';

import {
  appendProperty,
  diagnostic,
  pointerPath,
  sortedUnique,
} from "./diagnostics.mjs";
import { businessBudgetErrors } from "./expressions.mjs";
import {
  viewPreflight,
  childPath,
  walk,
  isObject,
  isI18nPath,
} from "./view_safety.mjs";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const DEFAULT_BUNDLE = join(ROOT, "contracts/meta-schemas/0a-core-r1");
const CONTRACT_FILES = new Map([
  ["business-schema/v1", "business-schema.v1.schema.json"],
  ["view-schema/lce-safe-v1", "view-schema.lce-safe-v1.schema.json"],
  ["app-spec/v1alpha1", "app-spec.v1alpha1.schema.json"],
]);
const ENTRY_DEFS = new Map([
  ["compiled-draft", "CompiledDraft"],
  ["spec", "Spec"],
  ["registered", "RegisteredContract"],
]);
const REGISTERED_BASE_PROPERTIES = new Set([
  "scope_type",
  "scope_id",
  "version",
  "base_version",
  "lifecycle",
  "canonicalization_profile",
  "checksum",
  "audit",
]);
const REGISTERED_PROPERTIES = new Map([
  [
    "business-schema/v1",
    new Set([
      ...REGISTERED_BASE_PROPERTIES,
      "contract_version",
      "schema_id",
      "source_ref",
      "spec",
    ]),
  ],
  [
    "view-schema/lce-safe-v1",
    new Set([
      ...REGISTERED_BASE_PROPERTIES,
      "contract_version",
      "view_id",
      "spec",
    ]),
  ],
  [
    "app-spec/v1alpha1",
    new Set([
      ...REGISTERED_BASE_PROPERTIES,
      "contract_version",
      "app_id",
      "spec",
    ]),
  ],
]);

export class BundleLoadError extends Error {}

let session = null;
export function bundleSession(validate) {
  const previous = session;
  session = new Map();
  try { return validate(); } finally { session = previous; }
}

// Private auxiliary engines share only the current synchronous invocation lifetime.
// Outside a session every caller receives a fresh resource, never a module cache.
export function invocationResource(key, create) {
  if (session?.has(key)) return session.get(key);
  const result = create();
  if (session) session.set(key, result);
  return result;
}

function strictEngine(schemas, definitionRefs) {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: true,
  });
  addFormats(ajv);
  // D03 profile: real calendar dates, no leap seconds; Audit additionally needs Z.
  ajv.addFormat("date", { type: "string", validate: validDate });
  ajv.addFormat("date-time", { type: "string", validate: validDatetime });
  for (const schema of schemas.values()) ajv.addSchema(schema);
  for (const schema of schemas.values()) ajv.getSchema(schema.$id);
  // Roots need not reference every $defs member. Compile each reusable definition,
  // retaining its entire schema (including conditional type context) in the engine.
  for (const reference of definitionRefs) {
    if (!ajv.getSchema(reference)) throw new BundleLoadError('bundle definition unavailable');
  }
  return ajv;
}

export function loadBundle(bundleDir = DEFAULT_BUNDLE, isolated = false) {
  if (isolated) {
    // Read/hash/strictly validate the public resources through the invocation gate;
    // each projection engine is still independent of the primary validator.
    const { schemas, definitionRefs } = loadBundle(bundleDir);
    return { schemas, definitionRefs, ajv: strictEngine(schemas, definitionRefs) };
  }
  return invocationResource(bundleDir, () => {
    let schemas, definitionRefs;
    try { ({schemas, definitionRefs} = readBundle(bundleDir, ROOT)); }
    catch (error) { throw new BundleLoadError('bundle validation failed', {cause:error}); }
    return { schemas, definitionRefs, ajv: strictEngine(schemas, definitionRefs) };
  });
}

function errorCode(error, definition) {
  if (
    error.keyword === "additionalProperties" ||
    error.keyword === "unevaluatedProperties"
  )
    return "UNKNOWN_PROPERTY";
  if (pointerPath(error.instancePath) === "contract_version")
    return "CONTRACT_VERSION_UNSUPPORTED";
  if (definition === "AssetRef") return "REFERENCE_INVALID";
  if (definition === "CapabilityRef") return "VIEW_CAPABILITY_REF_INVALID";
  if(definition==='App') {
    const parts=error.instancePath.split('/');
    if(parts.includes('navigation') && parts.some(p=>['path','route_code'].includes(p))) return 'APPSPEC_INVALID';
    if(parts.includes('viewRef') || ['businessSchemaRefs','viewRefs','workflowRefs','permissionRefs'].some(slot=>parts.includes(slot) && parts.length>parts.indexOf(slot)+1)) return 'REFERENCE_INVALID';
  }
  if (definition === "View") {
    const parts = error.instancePath.split("/").slice(1);
    if (parts.some((p) => ["actionRef", "queryRef"].includes(p)))
      return "VIEW_CAPABILITY_REF_INVALID";
    if (
      parts.some((p) =>
        ["businessSchemaRef", "componentRegistryRef"].includes(p),
      )
    )
      return "REFERENCE_INVALID";
    if (parts.includes("condition")) return "VIEW_EXPRESSION_UNSAFE";
    if (
      ["maxLength", "maxItems", "maximum", "minimum"].includes(error.keyword) &&
      parts.some((p) => ["i18n", "queries", "maxItems"].includes(p))
    )
      return "VIEW_LIMIT_EXCEEDED";
  }
  if (definition === "Business") {
    const parts = error.instancePath.split("/").slice(1);
    if (
      parts.some((p) =>
        ["field_type_registry_ref", "sequence_policy_ref"].includes(p),
      )
    )
      return "REFERENCE_INVALID";
    if (error.keyword !== "required") {
      if (parts.at(-1) === "schema_code") return "SCHEMA_CODE_INVALID";
      if (parts.at(-1) === "field_code") return "FIELD_CODE_INVALID";
      if (parts.includes("fields") && parts.at(-1) === "type")
        return "FIELD_TYPE_UNREGISTERED";
      if (
        parts.includes("fields") &&
        parts.some((p) => ["constraints", "type_config", "default"].includes(p))
      )
        return "CONSTRAINT_INCOMPATIBLE";
    }
    if (
      parts.includes("record_rules") &&
      parts.some((p) => ["assert", "when"].includes(p))
    )
      return "ARBITRARY_EXPRESSION_FORBIDDEN";
  }
  return "CONTRACT_SHAPE_INVALID";
}

function isDescendantPath(parent, child) {
  if (parent === "$") return child !== "$";
  return child.startsWith(`${parent}.`) || child.startsWith(`${parent}[`);
}

function mapErrors(
  errors,
  definition,
  evaluatedProperties = null,
  engineValid = true,
  instance,
) {
  const mapped = [];
  for (const error of errors ?? []) {
    if (error.keyword === "if") continue;
    if (/\/(?:oneOf|anyOf)\/\d+\//u.test(error.schemaPath)) continue;
    if (
      error.keyword === "unevaluatedProperties" &&
      error.instancePath === "" &&
      evaluatedProperties?.has(error.params.unevaluatedProperty)
    )
      continue;
    let path = pointerPath(error.instancePath, instance, definition === "View");
    const dynamic =
      definition === "View" &&
      (/\/(props|actions|input|params)$/u.test(error.instancePath) ||
        /\/i18n(?:\/[^/]+)?$/u.test(error.instancePath));
    const aggregate = error.keyword === "oneOf" || error.keyword === "anyOf";
    if (error.keyword === "required")
      path = appendProperty(path, error.params.missingProperty, dynamic);
    if (
      error.keyword === "additionalProperties" ||
      error.keyword === "unevaluatedProperties"
    ) {
      const property =
        error.params.additionalProperty ?? error.params.unevaluatedProperty;
      path = appendProperty(path, property, dynamic);
    }
    if (
      definition === "Business" &&
      !["additionalProperties", "unevaluatedProperties", "required"].includes(
        error.keyword,
      )
    ) {
      const match = /^(.*fields\[\d+\]\.default)(?:\.|\[)/u.exec(path);
      if (match) path = match[1];
    }
    mapped.push({
      aggregate,
      error: diagnostic(errorCode(error, definition), path),
    });
  }
  const withoutCascades = mapped.filter(
    ({ aggregate, error }) =>
      !aggregate ||
      !mapped.some(
        (candidate) =>
          (!candidate.aggregate || definition === "View") &&
          isDescendantPath(error.path, candidate.error.path),
      ),
  );
  const normalized = sortedUnique(withoutCascades.map((item) => item.error));
  if (!engineValid && normalized.length === 0) {
    const fallback =
      errors?.find((error) => error.keyword !== "if") ?? errors?.[0];
    const path = fallback
      ? pointerPath(fallback.instancePath, instance, definition === "View")
      : "$";
    return [
      diagnostic(
        fallback ? errorCode(fallback, definition) : "CONTRACT_SHAPE_INVALID",
        path,
      ),
    ];
  }
  return normalized;
}

function validateReference(
  schemaRef,
  value,
  bundleDir,
  definition,
  evaluatedProperties = null,
) {
  const { ajv } = loadBundle(bundleDir);
  let validate;
  try {
    validate = ajv.compile({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: schemaRef,
    });
  } catch (error) {
    throw new BundleLoadError("schema compilation failed", { cause: error });
  }
  const engineValid = validate(value);
  return mapErrors(
    validate.errors,
    definition,
    evaluatedProperties,
    engineValid,
    value,
  );
}

export function validateStructure(
  contract,
  entry,
  value,
  bundleDir = DEFAULT_BUNDLE,
) {
  const filename = CONTRACT_FILES.get(contract);
  const definition = ENTRY_DEFS.get(entry);
  if (!filename || !definition)
    throw new BundleLoadError("unsupported contract or entry");
  const { schemas } = loadBundle(bundleDir);
  if (contract === "business-schema/v1") {
    const errors = businessBudgetErrors(
      entry === "spec" ? value : value?.spec,
      entry === "spec" ? "" : "spec",
    );
    if (errors.length) return errors;
  }
  if (contract === "view-schema/lce-safe-v1") {
    const errors = viewPreflight(
      entry === "spec" ? value : value?.spec,
      entry === "spec" ? "" : "spec",
    );
    if (errors.length) return errors;
  }
  const evaluatedProperties =
    entry === "registered" ? REGISTERED_PROPERTIES.get(contract) : null;
  const schemaId = schemas.get(filename).$id;
  const errors = validateReference(
    `${schemaId}#/$defs/${definition}`,
    value,
    bundleDir,
    contract === "business-schema/v1"
      ? "Business"
      : contract === "view-schema/lce-safe-v1"
        ? "View"
        : 'App',
    evaluatedProperties,
  );
  if (contract === 'business-schema/v1') {
    const prefix = entry === 'spec' ? '' : 'spec.';
    const forbidden = new Set(['tenant_id', 'role_permissions', 'user_permissions',
      'authorization', 'data_scope', 'approvers'].map(key => prefix + key));
    for (let i = 0; i < errors.length; i++) {
      if (errors[i].code === 'UNKNOWN_PROPERTY' && forbidden.has(errors[i].path))
        errors[i] = diagnostic('PERMISSION_DECLARATION_FORBIDDEN', errors[i].path);
    }
  }
  if (contract === "view-schema/lce-safe-v1" && !errors.length) {
    const kinds = new Set([
      "FieldRef",
      "I18nRef",
      "SafeExpression",
      "ActionRef",
      "DataQueryRef",
      "DataBindingRef",
    ]);
    for (const [item, path] of walk(value)) {
      if (isObject(item) && !isI18nPath(path) && kinds.has(item.type)) {
        const local = validateReference(
          `${schemaId}#/$defs/${item.type}`,
          item,
          bundleDir,
          "View",
        );
        errors.push(
          ...local.map((error) => ({
            ...error,
            path:
              error.path === "$"
                ? path
                : path + (error.path.startsWith("[") ? "" : ".") + error.path,
          })),
        );
      }
    }
  }
  return sortedUnique(errors);
}

export function validateDefinition(
  definition,
  value,
  bundleDir = DEFAULT_BUNDLE,
) {
  if (!["AssetRef", "CapabilityRef", "RegisteredBase"].includes(definition))
    throw new Error("unsupported exported definition");
  return validateReference(
    `urn:kvvi:meta-schema:0a-core-r1:common#/$defs/${definition}`,
    value,
    bundleDir,
    definition,
  );
}

export function validateRegisteredSchema(schema, value, prefix, code) {
  const { ajv } = loadBundle();
  const validator = ajv.compile(schema);
  const valid = validator(value);
  return sortedUnique(
    mapErrors(validator.errors, "View", null, valid, value).map((error) => {
      const suffix = error.path;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/su.exec(suffix);
      const path =
        suffix === "$"
          ? prefix
          : match
            ? childPath(prefix, match[1], true)
            : prefix + suffix;
      return diagnostic(code, path);
    }),
  );
}
