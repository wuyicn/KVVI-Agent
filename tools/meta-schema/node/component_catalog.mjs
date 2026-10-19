/** Installed static React component metadata. This does not load a DSH plugin. */
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalizeBytes, canonicalizeJson } from './canonical.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CATALOG_DIR = 'contracts/component-catalog/v1';
const MAX_BYTES = 2 * 1024 * 1024;
function fail(code) { throw Object.assign(new Error(code), { code }); }

/** Selected roots are administrator-controlled. No links below that root. */
function regularBytes(root, relative, code) {
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) fail(code);
  try {
    let path = resolve(root);
    const rootStat = lstatSync(path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(code);
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail(code);
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) fail(code);
      const bytes = readFileSync(fd);
      if (bytes.length > MAX_BYTES) fail(code);
      return bytes;
    } finally { closeSync(fd); }
  } catch { fail(code); }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Integrity only. Uploaded bytes never become an installed/trusted catalog. */
export function validateCatalogDocument(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) fail('CATALOG_DOCUMENT_INVALID');
  let document;
  try { document = JSON.parse(canonicalizeBytes(bytes).canonical); }
  catch { fail('CATALOG_DOCUMENT_INVALID'); }
  const schema = JSON.parse(regularBytes(ROOT, `${CATALOG_DIR}/catalog.schema.json`, 'CATALOG_UNAVAILABLE'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  if (!ajv.compile(schema)(document)) fail('CATALOG_DOCUMENT_INVALID');
  if (canonicalizeJson(JSON.stringify(document.content)).digest !== document.ref.digest) fail('CATALOG_DIGEST_MISMATCH');
  const names = document.content.components.map(c => c.componentName);
  if (new Set(names).size !== names.length) fail('CATALOG_DOCUMENT_INVALID');
  for (const slot of ['sourceFiles', 'integrationWitnesses']) {
    const paths = document.content.adapter[slot].map(f => f.path);
    if (new Set(paths).size !== paths.length) fail('CATALOG_DOCUMENT_INVALID');
  }
  for (const component of document.content.components) {
    // Definitions are offline schemas, with no imported or remote resources.
    const stack = [component.propsSchema];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (Object.hasOwn(value, '$ref') || Object.hasOwn(value, '$dynamicRef')) fail('CATALOG_DOCUMENT_INVALID');
      stack.push(...Object.values(value));
    }
    // Shared catalog schema restricts the supported offline keyword subset.
    // Validate JSON Schema semantics without Ajv-only strict-mode extensions,
    // which Python Draft202012Validator does not implement.
    try { new Ajv2020({ strict: false }).compile(component.propsSchema); } catch { fail('CATALOG_DOCUMENT_INVALID'); }
  }
  return deepFreeze(document);
}

export function readInstalledComponentCatalog() {
  return validateCatalogDocument(regularBytes(ROOT, `${CATALOG_DIR}/catalog.json`, 'CATALOG_UNAVAILABLE'));
}

export function resolveComponentCatalog(reference) {
  const catalog = readInstalledComponentCatalog();
  if (!isDeepStrictEqual(reference, catalog.ref)) fail('CATALOG_REFERENCE_MISMATCH');
  return catalog.content;
}

/** Checks the declared inventory, not transitive dependencies or built output. */
export function qualifyComponentAdapter(runtimeRoot) {
  const catalog = readInstalledComponentCatalog();
  const entries = [...catalog.content.adapter.sourceFiles, ...catalog.content.adapter.integrationWitnesses];
  for (const entry of entries) {
    const bytes = regularBytes(runtimeRoot, entry.path, 'CATALOG_SOURCE_UNAVAILABLE');
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) fail('CATALOG_SOURCE_MISMATCH');
  }
  return { catalogDigest: catalog.ref.digest, sourceFiles: entries.length,
    evidenceBoundary: 'explicit-source-inventory-only' };
}
