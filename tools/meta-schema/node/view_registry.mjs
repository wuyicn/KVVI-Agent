/** Private exact Fake lookup; centralized scope/history validation follows in T4. */
import { isDeepStrictEqual } from "node:util";
import { isObject } from "./view_safety.mjs";
import { canonicalizeJson } from "./canonical.mjs";

const digestCache = new Map();
export function contentDigest(content) {
  // Existing Fake context values are already JSON objects. Production ingress
  // must canonicalize original bytes before parsing; this is not that boundary.
  const raw = JSON.stringify(content);
  if (digestCache.has(raw)) return digestCache.get(raw);
  const digest = canonicalizeJson(raw).digest;
  if (digestCache.size >= 256) digestCache.clear();
  digestCache.set(raw, digest);
  return digest;
}

export function resolveAsset(reference, context) {
  if (!isObject(reference)) return [null, "missing"];
  const identity = Object.fromEntries(
    Object.entries(reference).filter(([k]) => k !== "digest"),
  );
  const found = (context.fake_assets ?? []).filter(
    (a) =>
      isObject(a) &&
      isDeepStrictEqual(
        Object.fromEntries(
          Object.entries(a.ref ?? {}).filter(([k]) => k !== "digest"),
        ),
        identity,
      ),
  );
  if (found.length !== 1) return [null, "missing"];
  const record = found[0];
  if (
    reference.digest !== record.ref.digest ||
    contentDigest(record.content) !== reference.digest
  )
    return [null, "digest"];
  return [record.content, "ok"];
}

export function resolveCapability(reference, context) {
  const [content, status] = resolveAsset(reference, context);
  if (status !== "ok") return [null, status];
  const registryRef = context.view?.capability_registry_ref;
  if (
    !isObject(registryRef) ||
    registryRef.asset_type !== "CAPABILITY_REGISTRY"
  )
    return [null, "missing"];
  const [registry, registryStatus] = resolveAsset(registryRef, context);
  if (
    registryStatus !== "ok" ||
    registry.fixture !== true ||
    registry.version !== registryRef.version ||
    registry.state !== "PUBLISHED"
  )
    return [null, "missing"];
  const identity = Object.fromEntries(
    Object.entries(reference).filter(([key]) => key !== "digest"),
  );
  const members = (registry.members ?? []).filter((member) =>
    isDeepStrictEqual(
      Object.fromEntries(
        Object.entries(member).filter(([key]) => key !== "digest"),
      ),
      identity,
    ),
  );
  if (members.length !== 1) return [null, "missing"];
  if (members[0].digest !== reference.digest) return [null, "digest"];
  const required = [
    "fixture",
    "capability_code",
    "version",
    "state",
    "category",
    "inputSchema",
    "outputSchema",
    "errorSchema",
    "authorization",
    "scope",
    "sideEffects",
    "idempotency",
    "retry",
    "runtimeDigest",
    "timeoutMs",
    "rateLimit",
    "maxResults",
    "itemKeys",
    "recovery",
    "auditEvents",
  ];
  if (
    !required.every((k) => Object.hasOwn(content, k)) ||
    content.fixture !== true ||
    content.state !== "PUBLISHED" ||
    content.capability_code !== reference.capability_code ||
    content.version !== reference.version
  )
    return [null, "missing"];
  for (const key of ["inputSchema", "outputSchema", "errorSchema"])
    if (
      !isObject(content[key]) ||
      content[key].type !== "object" ||
      content[key].additionalProperties !== false
    )
      return [null, "missing"];
  return [content, "ok"];
}
