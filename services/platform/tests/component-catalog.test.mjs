import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalizeJson } from '../../../tools/meta-schema/node/canonical.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const moduleUrl = new URL('../../../tools/meta-schema/node/component_catalog.mjs', import.meta.url);
const localPython = join(root, '.local-remediation-evidence/schema-venv/bin/python');
const python = process.env.KVVI_SCHEMA_PYTHON ?? (existsSync(localPython) ? localPython : 'python3');
const fieldTypes = ['short_text', 'long_text', 'boolean', 'integer', 'decimal', 'money', 'date', 'datetime', 'single_select', 'multi_select'];
const expectedNames = ['FormPage', 'ListPage', 'DetailPage', 'Section', 'Grid', 'ShortTextField', 'LongTextField', 'BooleanField', 'IntegerField', 'DecimalField', 'MoneyField', 'DateField', 'DateTimeField', 'SingleSelectField', 'MultiSelectField', 'Text', 'Description', 'StatusBadge'];
const bytes = () => readFileSync(join(root, 'contracts/component-catalog/v1/catalog.json'));
const rehash = document => {
  document.ref.digest = canonicalizeJson(JSON.stringify(document.content)).digest;
  return Buffer.from(JSON.stringify(document));
};

function pythonProbe(script, input, installRoot = root) {
  const run = spawnSync(python, ['-c', `import sys,json\nsys.path.insert(0, ${JSON.stringify(join(installRoot, 'tools/meta-schema/python'))})\nfrom component_catalog import *\n${script}`],
    { input, encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('installed catalog has an exact production ref and only implemented static capabilities', async () => {
  const { readInstalledComponentCatalog, resolveComponentCatalog } = await import(moduleUrl);
  const catalog = readInstalledComponentCatalog();
  assert.deepEqual(Object.keys(catalog.ref).sort(), ['scope_type', 'scope_id', 'app_id', 'module_id', 'asset_type', 'asset_id', 'version', 'digest'].sort());
  assert.equal(catalog.ref.scope_type, 'PLATFORM_CONTROL');
  assert.equal(catalog.ref.scope_id, 'kvvi-platform');
  assert.equal(catalog.ref.app_id, null);
  assert.equal(catalog.ref.module_id, null);
  assert.equal(catalog.ref.asset_type, 'COMPONENT_REGISTRY');
  assert.equal(catalog.ref.asset_id, 'kvvi_react_core');
  assert.equal(catalog.ref.digest, canonicalizeJson(JSON.stringify(catalog.content)).digest);
  assert.deepEqual(catalog.content.components.map(c => c.componentName).sort(), [...expectedNames].sort());
  assert.equal(catalog.content.adapter.framework, 'react');
  assert.equal(catalog.content.adapter.evidenceBoundary, 'explicit-source-inventory-only');
  assert.deepEqual(catalog.content.unsupported, ['Table', 'SaveDraftButton', 'SubmitButton', 'CancelButton', 'OpenRecordLink', 'condition', 'loop', 'actions', 'queries', 'i18n']);
  assert.deepEqual(resolveComponentCatalog(catalog.ref), catalog.content);
  assert.throws(() => { catalog.content.components[0].viewTypes.push('OTHER'); }, TypeError);
  assert.equal(resolveComponentCatalog(catalog.ref).components[0].viewTypes.length, 1);
  for (const [key, value] of [['asset_id', 'vue_element_approved'], ['version', 999], ['digest', `sha256:${'0'.repeat(64)}`], ['app_id', 'foreign']]) {
    assert.throws(() => resolveComponentCatalog({ ...catalog.ref, [key]: value }), { code: 'CATALOG_REFERENCE_MISMATCH' });
  }
  const missing = { ...catalog.ref }; delete missing.module_id;
  assert.throws(() => resolveComponentCatalog(missing), { code: 'CATALOG_REFERENCE_MISMATCH' });
  assert.throws(() => resolveComponentCatalog({ ...catalog.ref, latest: true }), { code: 'CATALOG_REFERENCE_MISMATCH' });
});

test('malformed raw bytes and reference values return the same catalog error contract in both languages', async () => {
  const { validateCatalogDocument, resolveComponentCatalog, readInstalledComponentCatalog } = await import(moduleUrl);
  for (const raw of [Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), Buffer.from('{"x":1,"x":2}'), Buffer.from('1.00000000000000001')]) {
    assert.throws(() => validateCatalogDocument(raw), { code: 'CATALOG_DOCUMENT_INVALID' });
    assert.equal(pythonProbe(`try:\n validate_catalog_document(sys.stdin.buffer.read())\n print(json.dumps({'code':'accepted'}))\nexcept Exception as e:\n print(json.dumps({'code':getattr(e,'code',None)}))`, raw).code, 'CATALOG_DOCUMENT_INVALID');
  }
  const reference = { ...readInstalledComponentCatalog().ref, version: NaN };
  assert.throws(() => resolveComponentCatalog(reference), { code: 'CATALOG_REFERENCE_MISMATCH' });
  assert.equal(pythonProbe(`reference=read_installed_component_catalog()['ref']\nreference['version']=object()\ntry:\n resolve_component_catalog(reference)\n print(json.dumps({'code':'accepted'}))\nexcept Exception as e:\n print(json.dumps({'code':getattr(e,'code',None)}))`).code, 'CATALOG_REFERENCE_MISMATCH');
});

test('catalog integrity rejects altered content, Fake metadata and undeclared components in both languages', async () => {
  const { validateCatalogDocument } = await import(moduleUrl);
  const doc = JSON.parse(bytes());
  const altered = structuredClone(doc); altered.content.components[0].maxChildren = 1;
  assert.throws(() => validateCatalogDocument(Buffer.from(JSON.stringify(altered))), { code: 'CATALOG_DIGEST_MISMATCH' });
  const invalid = [];
  const fake = structuredClone(doc); fake.content.fixture = true; invalid.push(rehash(fake));
  const adapter = structuredClone(doc); adapter.content.adapter.implementation = 'no-renderer'; invalid.push(rehash(adapter));
  const table = structuredClone(doc); table.content.components[0].componentName = 'Table'; invalid.push(rehash(table));
  const duplicate = structuredClone(doc); duplicate.content.components[1] = duplicate.content.components[0]; invalid.push(rehash(duplicate));
  const unsafePath = structuredClone(doc); unsafePath.content.adapter.sourceFiles[0].path = '../outside'; invalid.push(rehash(unsafePath));
  const propsKeyword = structuredClone(doc); propsKeyword.content.components[0].propsSchema.ignoredKeyword = true; invalid.push(rehash(propsKeyword));
  invalid.push(Buffer.from('{"ref":{},"ref":{}}'));
  for (const raw of invalid) {
    assert.throws(() => validateCatalogDocument(raw));
    assert.equal(pythonProbe(`try:\n validate_catalog_document(sys.stdin.buffer.read())\n print(json.dumps({'accepted':True}))\nexcept Exception:\n print(json.dumps({'accepted':False}))`, raw).accepted, false);
  }
});

test('Node and Python load the same immutable identity and source capability declarations', async () => {
  const { readInstalledComponentCatalog } = await import(moduleUrl);
  assert.deepEqual(pythonProbe('print(json.dumps(read_installed_component_catalog()))'), readInstalledComponentCatalog());
  assert.equal(pythonProbe('first=read_installed_component_catalog()\nfirst["content"]["components"].clear()\nprint(json.dumps({"freshCount":len(read_installed_component_catalog()["content"]["components"])}))').freshCount, 18);
  const badRef = { ...readInstalledComponentCatalog().ref, scope_id: 'some-company' };
  assert.equal(pythonProbe(`try:\n resolve_component_catalog(json.load(sys.stdin))\n print(json.dumps({'accepted':True}))\nexcept Exception:\n print(json.dumps({'accepted':False}))`, JSON.stringify(badRef)).accepted, false);
});

test('published props schemas express implemented field bindings rather than ignored layout/action props', async () => {
  const { readInstalledComponentCatalog } = await import(moduleUrl);
  const { default: Ajv } = await import('../../../tools/meta-schema/node/node_modules/ajv/dist/2020.js');
  const ajv = new Ajv({ strict: true });
  const components = readInstalledComponentCatalog().content.components;
  const fieldNames = ['ShortTextField', 'LongTextField', 'BooleanField', 'IntegerField', 'DecimalField', 'MoneyField', 'DateField', 'DateTimeField', 'SingleSelectField', 'MultiSelectField'];
  for (let i = 0; i < fieldNames.length; i++) {
    const component = components.find(c => c.componentName === fieldNames[i]);
    assert.deepEqual(component.fieldTypes, [fieldTypes[i]]);
    const validate = ajv.compile(component.propsSchema);
    assert.equal(validate({ fieldBinding: { type: 'FieldRef', fieldRef: 'quantity' } }), true);
    for (const value of [{}, { fieldBinding: { type: 'FieldRef', fieldRef: 'quantity' }, disabled: true }, { fieldBinding: { fieldRef: 'quantity' } }]) assert.equal(validate(value), false);
  }
  const section = ajv.compile(components.find(c => c.componentName === 'Section').propsSchema);
  assert.equal(section({ title: 'Details' }), true);
  assert.equal(section({ columns: 3 }), false);
  assert.equal(section({ title: { type: 'I18nRef', key: 'secret' } }), false);
  const grid = ajv.compile(components.find(c => c.componentName === 'Grid').propsSchema);
  assert.equal(grid({}), true);
  assert.equal(grid({ title: 'ignored by Grid' }), false);
});

test('source qualification detects changed, missing and symlinked inventory files without claiming bundle identity', async () => {
  const { readInstalledComponentCatalog, qualifyComponentAdapter } = await import(moduleUrl);
  const catalog = readInstalledComponentCatalog();
  const temp = mkdtempSync(join(tmpdir(), 'kvvi-catalog-source-'));
  try {
    const entries = [...catalog.content.adapter.sourceFiles, ...catalog.content.adapter.integrationWitnesses];
    for (const entry of entries) {
      const target = join(temp, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, 'forks/dsh/变更', entry.path), target);
    }
    const qualified = qualifyComponentAdapter(temp);
    assert.equal(qualified.catalogDigest, catalog.ref.digest);
    assert.equal(qualified.sourceFiles, entries.length);
    assert.equal(qualified.evidenceBoundary, 'explicit-source-inventory-only');
    assert.equal(Object.hasOwn(qualified, 'bundleDigest'), false);
    assert.deepEqual(pythonProbe(`print(json.dumps(qualify_component_adapter(${JSON.stringify(temp)})))`), qualified);
    const target = join(temp, entries[0].path);
    writeFileSync(target, 'old renderer');
    assert.throws(() => qualifyComponentAdapter(temp), { code: 'CATALOG_SOURCE_MISMATCH' });
    assert.equal(pythonProbe(`try:\n qualify_component_adapter(${JSON.stringify(temp)})\n print(json.dumps({'accepted':True}))\nexcept Exception:\n print(json.dumps({'accepted':False}))`).accepted, false);
    rmSync(target);
    assert.throws(() => qualifyComponentAdapter(temp), { code: 'CATALOG_SOURCE_UNAVAILABLE' });
    symlinkSync(join(root, 'forks/dsh/变更', entries[0].path), target);
    assert.throws(() => qualifyComponentAdapter(temp), { code: 'CATALOG_SOURCE_UNAVAILABLE' });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('installed loading refuses missing, symlinked and oversized catalog files from an owned installation fixture', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kvvi-installed-catalog-'));
  try {
    const nodeDir = join(temp, 'tools/meta-schema/node');
    const catalogDir = join(temp, 'contracts/component-catalog/v1');
    mkdirSync(nodeDir, { recursive: true }); mkdirSync(catalogDir, { recursive: true });
    mkdirSync(join(temp, 'tools/meta-schema/python'), { recursive: true });
    copyFileSync(join(root, 'tools/meta-schema/python/component_catalog.py'), join(temp, 'tools/meta-schema/python/component_catalog.py'));
    const reference = 'protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/python/kvvi_json_c14n.py';
    mkdirSync(dirname(join(temp, reference)), { recursive: true });
    copyFileSync(join(root, reference), join(temp, reference));
    const pythonLoad = () => pythonProbe(`try:\n read_installed_component_catalog()\n print(json.dumps({'code':'accepted'}))\nexcept Exception as e:\n print(json.dumps({'code':getattr(e,'code',None)}))`, undefined, temp).code;
    for (const name of ['component_catalog.mjs', 'canonical.mjs']) copyFileSync(join(root, 'tools/meta-schema/node', name), join(nodeDir, name));
    symlinkSync(join(root, 'tools/meta-schema/node/node_modules'), join(nodeDir, 'node_modules'));
    copyFileSync(join(root, 'contracts/component-catalog/v1/catalog.schema.json'), join(catalogDir, 'catalog.schema.json'));
    const { readInstalledComponentCatalog } = await import(new URL(`file://${join(nodeDir, 'component_catalog.mjs')}`));
    assert.throws(() => readInstalledComponentCatalog(), { code: 'CATALOG_UNAVAILABLE' });
    assert.equal(pythonLoad(), 'CATALOG_UNAVAILABLE');
    const target = join(catalogDir, 'catalog.json');
    symlinkSync(join(root, 'contracts/component-catalog/v1/catalog.json'), target);
    assert.throws(() => readInstalledComponentCatalog(), { code: 'CATALOG_UNAVAILABLE' });
    assert.equal(pythonLoad(), 'CATALOG_UNAVAILABLE');
    rmSync(target);
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    assert.throws(() => readInstalledComponentCatalog(), { code: 'CATALOG_UNAVAILABLE' });
    assert.equal(pythonLoad(), 'CATALOG_UNAVAILABLE');
    writeFileSync(target, bytes());
    assert.equal(readInstalledComponentCatalog().content.components.length, 18);
    assert.equal(pythonLoad(), 'accepted');
    rmSync(join(catalogDir, 'catalog.schema.json'));
    symlinkSync(join(root, 'contracts/component-catalog/v1/catalog.schema.json'), join(catalogDir, 'catalog.schema.json'));
    assert.throws(() => readInstalledComponentCatalog(), { code: 'CATALOG_UNAVAILABLE' });
    assert.equal(pythonLoad(), 'CATALOG_UNAVAILABLE');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
