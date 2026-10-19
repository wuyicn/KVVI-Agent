import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, cpSync, appendFileSync, symlinkSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readInstalledComponentCatalog } from '../../../tools/meta-schema/node/component_catalog.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const localPython = join(root, '.local-remediation-evidence/schema-venv/bin/python');
const python = process.env.KVVI_SCHEMA_PYTHON ?? (existsSync(localPython) ? localPython : 'python3');
const frozen = JSON.parse(readFileSync(join(root, 'tests/meta-schema/0a-core-r1/contexts/integration-cd7a0d103e13ade3.json')));
const base = frozen.snapshots.find(s => s.ref.asset_type === 'BUSINESS_SCHEMA');
const keys = ['scope_type', 'scope_id', 'app_id', 'module_id', 'asset_type', 'asset_id'];
const identity = ref => Object.fromEntries(keys.map(k => [k, ref[k]]));
function fixture() {
  const ref = structuredClone(base.ref);
  const registered = structuredClone(base.registered);
  const snapshot = { ref, registered,
    registration: { identity: identity(ref), schema_id: registered.schema_id, schema_code: registered.spec.schema_code },
    publication: { reference: structuredClone(ref), schema_id: registered.schema_id, schema_code: registered.spec.schema_code,
      published_record_id: 'test-publication-1', approved_record_id: 'test-approval-1' } };
  const context = { sourceIdentity: { ...identity(ref), asset_type: 'VIEW_SCHEMA', asset_id: 'new_form' },
    expectedBusinessRef: structuredClone(ref), deletedNodeIds: [] };
  const view = { view_code: 'new_form', name: 'New form', view_type: 'FORM', businessSchemaRef: structuredClone(ref),
    componentRegistryRef: structuredClone(readInstalledComponentCatalog().ref),
    componentsTree: [{ id: 'root_page', componentName: 'FormPage', children: [{ id: 'title_field', componentName: 'ShortTextField',
      props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } } }] }] };
  return { snapshot, context, view };
}
const raw = view => Buffer.from(JSON.stringify(view));

async function both(input, mode = 'snapshot') {
  const { createProductionViewChecker } = await import('../../../tools/meta-schema/node/production_view.mjs');
  const result = await createProductionViewChecker({ resolvePublishedBusiness: async () => {
    if (mode === 'unavailable') throw Error('private SQL detail');
    return mode === 'missing' ? null : input.snapshot;
  } }).check(raw(input.view), input.context);
  const run = spawnSync(python, ['-c', `import json,sys\nsys.path.insert(0,${JSON.stringify(join(root, 'tools/meta-schema/python'))})\nfrom production_view import create_production_view_checker\nx=json.load(sys.stdin)\ndef resolve(ref):\n if x['mode']=='unavailable': raise RuntimeError('private SQL detail')\n return None if x['mode']=='missing' else x['input']['snapshot']\nf=x['input']\nprint(json.dumps(create_production_view_checker(resolve_published_business=resolve).check(json.dumps(f['view']).encode(),f['context'])))`],
    { input: JSON.stringify({ input, mode }), encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), result);
  assert.equal(result.releaseApproved, false);
  assert.equal(result.validationScope, 'STATIC_VIEW_AND_REFERENCE');
  assert.equal(JSON.stringify(result).includes('private SQL detail'), false);
  return result;
}
const code = (report, wanted) => report.errors.some(e => e.code === wanted);

test('internal resolver contract binds actual directory and exact registered model, while approval remains separate', async () => {
  const input = fixture();
  const result = await both(input);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.dependencies, [input.view.componentRegistryRef, input.view.businessSchemaRef]);
  const differentStableId = fixture();
  differentStableId.snapshot.ref.asset_id = 'stable-business-42';
  differentStableId.snapshot.registration.identity = identity(differentStableId.snapshot.ref);
  differentStableId.snapshot.publication.reference = structuredClone(differentStableId.snapshot.ref);
  differentStableId.view.businessSchemaRef = structuredClone(differentStableId.snapshot.ref);
  differentStableId.context.expectedBusinessRef = structuredClone(differentStableId.snapshot.ref);
  assert.equal((await both(differentStableId)).valid, true);
});

test('same asset name cannot cross company, app or module and old model versions cannot replace the expected active one', async () => {
  for (const key of ['scope_id', 'app_id', 'module_id']) {
    const input = fixture(); input.view.businessSchemaRef[key] = 'different-identity';
    assert.ok(code(await both(input), 'ASSET_REF_OUT_OF_SCOPE'));
  }
  const old = fixture(); old.context.expectedBusinessRef.version = 2;
  assert.ok(code(await both(old), 'VIEW_REFERENCE_VERSION_CONFLICT'));
  const digest = fixture(); digest.view.businessSchemaRef.digest = `sha256:${'0'.repeat(64)}`;
  assert.ok(code(await both(digest), 'ASSET_DIGEST_MISMATCH'));
});

test('model and catalog references require every identity field and an installed non-Fake version', async () => {
  const missing = fixture(); delete missing.view.businessSchemaRef.module_id;
  assert.equal((await both(missing)).valid, false);
  const fake = fixture(); fake.view.componentRegistryRef.asset_id = 'vue_element_approved';
  assert.ok(code(await both(fake), 'VIEW_COMPONENT_UNREGISTERED'));
  const uuidAlias = fixture(); uuidAlias.view.businessSchemaRef.asset_id = uuidAlias.snapshot.registered.schema_id;
  assert.ok(code(await both(uuidAlias), 'ASSET_NOT_FOUND'));
});

test('published-looking uploads and legacy rows cannot supply absent registration or publication provenance', async () => {
  const input = fixture();
  assert.ok(code(await both(input, 'missing'), 'ASSET_NOT_FOUND'));
  for (const slot of ['registration', 'publication']) {
    const legacy = fixture(); delete legacy.snapshot[slot];
    assert.ok(code(await both(legacy), 'ASSET_REGISTRATION_UNAVAILABLE'));
  }
  const drift = fixture(); drift.snapshot.registration.schema_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.ok(code(await both(drift), 'ASSET_REGISTRATION_UNAVAILABLE'));
  const codeDrift = fixture(); codeDrift.snapshot.registration.schema_code = 'other_code';
  assert.ok(code(await both(codeDrift), 'ASSET_REGISTRATION_UNAVAILABLE'));
});

test('DRAFT, different exact-version lookup and tampered content fail despite a self-reported checksum', async () => {
  const draft = fixture(); draft.snapshot.registered.lifecycle = 'DRAFT';
  assert.ok(code(await both(draft), 'ASSET_NOT_PUBLISHED'));
  const version = fixture(); version.snapshot.ref.version = 2;
  assert.ok(code(await both(version), 'ASSET_NOT_FOUND'));
  const tampered = fixture(); tampered.snapshot.registered.spec.name = 'Changed';
  assert.ok(code(await both(tampered), 'ASSET_DIGEST_MISMATCH'));
  const profile = fixture(); profile.snapshot.registered.canonicalization_profile = 'latest';
  assert.equal((await both(profile)).valid, false);
});

test('resolver metadata compares protocol scalar types exactly instead of treating true as version one', async () => {
  const wrongLookup = fixture(); wrongLookup.snapshot.ref.version = true;
  assert.ok(code(await both(wrongLookup), 'ASSET_NOT_FOUND'));
  const wrongPublication = fixture(); wrongPublication.snapshot.publication.reference.version = true;
  assert.ok(code(await both(wrongPublication), 'ASSET_REGISTRATION_UNAVAILABLE'));
});

test('unknown node history, unsupported execution features and resolver outages stay closed', async () => {
  const history = fixture(); history.context.deletedNodeIds = null;
  assert.ok(code(await both(history), 'TRUSTED_HISTORY_REQUIRED'));
  const deleted = fixture(); deleted.context.deletedNodeIds = ['title_field'];
  assert.ok(code(await both(deleted), 'VIEW_NODE_ID_DUPLICATE'));
  for (const key of ['queries', 'i18n']) {
    const feature = fixture(); feature.view[key] = key === 'queries' ? [] : {};
    assert.ok(code(await both(feature), 'VIEW_FEATURE_UNSUPPORTED'));
  }
  const actions = fixture(); actions.view.componentsTree[0].actions = {};
  assert.ok(code(await both(actions), 'VIEW_FEATURE_UNSUPPORTED'));
  assert.ok(code(await both(fixture(), 'unavailable'), 'DEPENDENCY_VALIDATOR_UNAVAILABLE'));
});

test('raw JSON bytes are validated before duplicate keys or noninteger numeric tokens are lost', async () => {
  const { createProductionViewChecker } = await import('../../../tools/meta-schema/node/production_view.mjs');
  const input = fixture();
  const checker = createProductionViewChecker({ resolvePublishedBusiness: async () => { throw Error('must not resolve'); } });
  for (const bytes of [Buffer.from('{"a":1,"a":2}'), Buffer.from('1.00000000000000001'), Buffer.from([0xff])]) {
    const report = await checker.check(bytes, input.context);
    assert.equal(report.valid, false);
    assert.equal(report.releaseApproved, false);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].code, /^CANON_/);
    const run = spawnSync(python, ['-c', `import json,sys\nsys.path.insert(0,${JSON.stringify(join(root, 'tools/meta-schema/python'))})\nfrom production_view import create_production_view_checker\ncontext=json.loads(${JSON.stringify(JSON.stringify(input.context))})\ndef resolve(ref): raise RuntimeError('must not resolve')\nprint(json.dumps(create_production_view_checker(resolve_published_business=resolve).check(sys.stdin.buffer.read(),context)))`],
      { input: bytes, encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), report);
  }
});

test('history node IDs and private record IDs reject ambiguous Unicode whitespace identically', async () => {
  for (const whitespace of ['\u0085', '\ufeff']) {
    const history = fixture(); history.context.deletedNodeIds = [whitespace];
    assert.ok(code(await both(history), 'TRUSTED_HISTORY_REQUIRED'));
    for (const field of ['published_record_id', 'approved_record_id']) {
      const publication = fixture(); publication.snapshot.publication[field] = whitespace;
      assert.ok(code(await both(publication), 'ASSET_REGISTRATION_UNAVAILABLE'));
    }
  }
});

test('caller mutations while the internal resolver awaits cannot replace the frozen input identity or view', async () => {
  const { createProductionViewChecker } = await import('../../../tools/meta-schema/node/production_view.mjs');
  const input = fixture(), bytes = raw(input.view), expected = structuredClone(input.view.businessSchemaRef);
  let started, resume;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const checker = createProductionViewChecker({ resolvePublishedBusiness: async ref => {
    assert.deepEqual(ref, expected); started(); await gate; return input.snapshot;
  } });
  const pending = checker.check(bytes, input.context);
  await entered;
  input.context.sourceIdentity.scope_id = 'different-company';
  input.context.expectedBusinessRef.version = 99;
  input.context.deletedNodeIds.push('title_field');
  bytes.fill(0);
  resume();
  const result = await pending;
  assert.equal(result.valid, true);
  assert.equal(result.releaseApproved, false);
  assert.deepEqual(result.dependencies[1], expected);
  // The synchronous Python host boundary must also detach its context before
  // executing resolver code, which can mutate the caller's original object.
  const original = fixture();
  const run = spawnSync(python, ['-c', `import json,sys\nsys.path.insert(0,${JSON.stringify(join(root, 'tools/meta-schema/python'))})\nfrom production_view import create_production_view_checker\nx=json.load(sys.stdin)\ndef resolve(ref):\n x['context']['sourceIdentity']['scope_id']='different-company'\n x['context']['expectedBusinessRef']['version']=99\n x['context']['deletedNodeIds'].append('title_field')\n return x['snapshot']\nprint(json.dumps(create_production_view_checker(resolve_published_business=resolve).check(json.dumps(x['view']).encode(),x['context'])))`],
    { input: JSON.stringify(original), encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), result);
});

test('missing or tampered validator bundles return a closed report without installation paths', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kvvi-production-validator-'));
  try {
    for (const [language, extension] of [['node', '.mjs'], ['python', '.py']]) {
      const source = join(root, 'tools/meta-schema', language), target = join(temp, 'tools/meta-schema', language);
      mkdirSync(target, { recursive: true });
      for (const file of readdirSync(source).filter(name => name.endsWith(extension))) copyFileSync(join(source, file), join(target, file));
    }
    symlinkSync(join(root, 'tools/meta-schema/node/node_modules'), join(temp, 'tools/meta-schema/node/node_modules'));
    const files = ['tools/meta-schema/verify_bundle.py', 'protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/python/kvvi_json_c14n.py',
      'docs/PRD-AI无代码平台设计-v1.11.md', 'docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md'];
    for (const file of files) { mkdirSync(dirname(join(temp, file)), { recursive: true }); copyFileSync(join(root, file), join(temp, file)); }
    const bundle = 'contracts/meta-schemas/0a-core-r1';
    cpSync(join(root, bundle), join(temp, bundle), { recursive: true });
    const { createProductionViewChecker } = await import(pathToFileURL(join(temp, 'tools/meta-schema/node/production_view.mjs')));
    const checker = createProductionViewChecker({ resolvePublishedBusiness: async () => null });
    const pythonCheck = () => {
      const run = spawnSync(python, ['-c', `import json,sys\nsys.path.insert(0,${JSON.stringify(join(temp, 'tools/meta-schema/python'))})\nfrom production_view import create_production_view_checker\nprint(json.dumps(create_production_view_checker(resolve_published_business=lambda ref:None).check(b'{}',{})))`],
        { encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      assert.equal(run.status, 0, run.stderr); return JSON.parse(run.stdout);
    };
    assert.equal(code(await checker.check(Buffer.from('{}'), {}), 'DEPENDENCY_VALIDATOR_UNAVAILABLE'), false);
    assert.equal(code(pythonCheck(), 'DEPENDENCY_VALIDATOR_UNAVAILABLE'), false);
    for (const mode of ['missing', 'tampered']) {
      if (mode === 'missing') rmSync(join(temp, bundle), { recursive: true });
      else { cpSync(join(root, bundle), join(temp, bundle), { recursive: true }); appendFileSync(join(temp, bundle, 'common.schema.json'), '\n'); }
      const result = await checker.check(Buffer.from('{}'), {});
      assert.ok(code(result, 'DEPENDENCY_VALIDATOR_UNAVAILABLE'));
      assert.equal(result.releaseApproved, false);
      assert.equal(JSON.stringify(result).includes(temp), false);
      assert.deepEqual(pythonCheck(), result);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
