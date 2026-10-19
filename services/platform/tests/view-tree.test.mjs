import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readInstalledComponentCatalog } from '../../../tools/meta-schema/node/component_catalog.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const localPython = join(root, '.local-remediation-evidence/schema-venv/bin/python');
const python = process.env.KVVI_SCHEMA_PYTHON ?? (existsSync(localPython) ? localPython : 'python3');
const catalog = readInstalledComponentCatalog();
const modelFields = [{ field_code: 'title', type: 'short_text' }, { field_code: 'amount', type: 'money' }];
const modelRef = { scope_type: 'TENANT', scope_id: '11111111-1111-4111-8111-111111111111', app_id: '22222222-2222-4222-8222-222222222222', module_id: '33333333-3333-4333-8333-333333333333', asset_type: 'BUSINESS_SCHEMA', asset_id: 'general_item', version: 1, digest: `sha256:${'1'.repeat(64)}` };
function spec() {
  return { view_code: 'example_form', name: 'Example', view_type: 'FORM', businessSchemaRef: modelRef, componentRegistryRef: catalog.ref,
    componentsTree: [{ id: 'root_page', componentName: 'FormPage', children: [{ id: 'main_section', componentName: 'Section', props: { title: 'Details' }, children: [
      { id: 'title_field', componentName: 'ShortTextField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } } },
      { id: 'amount_field', componentName: 'MoneyField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'amount' } } },
    ] }] }] };
}

async function both(value, deletedNodeIds = [], allowInstalledRoot = true, fields = modelFields) {
  const { checkViewTree } = await import('../../../tools/meta-schema/node/view_tree.mjs');
  const before = JSON.stringify(value);
  const errors = checkViewTree(value, { components: catalog.content.components, modelFields: fields, deletedNodeIds,
    ...(allowInstalledRoot ? { allowRoot: definition => definition.allowedParents.includes('$root') } : {}) });
  const run = spawnSync(python, ['-c', `import json,sys\nsys.path.insert(0,${JSON.stringify(join(root, 'tools/meta-schema/python'))})\nfrom view_tree import check_view_tree\nfrom component_catalog import read_installed_component_catalog\nx=json.load(sys.stdin)\nc=read_installed_component_catalog()['content']['components']\nkw={'allow_root':lambda d:'$root' in d['allowedParents']} if x['allowRoot'] else {}\nprint(json.dumps(check_view_tree(x['spec'],components=c,model_fields=x['fields'],deleted_node_ids=x['deleted'],**kw)))`],
    { input: JSON.stringify({ spec: value, fields, deleted: deletedNodeIds, allowRoot: allowInstalledRoot }), encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), errors);
  assert.equal(JSON.stringify(value), before);
  return errors;
}

test('shared static tree checks accept the actual installed root convention without granting reference trust', async () => {
  assert.deepEqual(await both(spec()), []);
  assert.ok((await both(spec(), [], false)).some(e => e.code === 'VIEW_CHILD_NOT_ALLOWED'));
  // These syntactically shaped refs are deliberately not resolved by this core.
  // It proves tree rules only, not publication, model identity or authorization.
});

test('all eighteen declared components pass the shared rules in their actual page and field types', async () => {
  const fieldNames = ['ShortTextField', 'LongTextField', 'BooleanField', 'IntegerField', 'DecimalField', 'MoneyField', 'DateField', 'DateTimeField', 'SingleSelectField', 'MultiSelectField'];
  const types = ['short_text', 'long_text', 'boolean', 'integer', 'decimal', 'money', 'date', 'datetime', 'single_select', 'multi_select'];
  const fields = types.map((type, i) => ({ field_code: `field_${i}`, type }));
  for (const [viewType, rootName] of [['FORM', 'FormPage'], ['LIST', 'ListPage'], ['DETAIL', 'DetailPage']]) {
    const value = spec(); value.view_type = viewType;
    value.componentsTree = [{ id: 'root_page', componentName: rootName, children: [{ id: 'main_section', componentName: 'Section', props: { title: 'Details' }, children: [{ id: 'main_grid', componentName: 'Grid', children: [
      ...fieldNames.map((componentName, i) => ({ id: `node_${i}`, componentName, props: { fieldBinding: { type: 'FieldRef', fieldRef: `field_${i}` } } })),
      { id: 'literal_text', componentName: 'Text', props: { text: 'Hello' } },
      { id: 'value_description', componentName: 'Description', props: { value: { type: 'FieldRef', fieldRef: 'field_0' } } },
      { id: 'value_badge', componentName: 'StatusBadge', props: { value: { type: 'FieldRef', fieldRef: 'field_0' } } },
    ] }] }] }];
    assert.deepEqual(await both(value, [], true, fields), []);
  }
});

test('shared checks refuse wrong field identity, type and ignored props identically', async () => {
  const unknown = spec(); unknown.componentsTree[0].children[0].children[0].props.fieldBinding.fieldRef = 'missing';
  assert.ok((await both(unknown)).some(e => e.code === 'VIEW_FIELD_REF_INVALID'));
  const wrongType = spec(); wrongType.componentsTree[0].children[0].children[0].props.fieldBinding.fieldRef = 'amount';
  assert.ok((await both(wrongType)).some(e => e.code === 'VIEW_FIELD_REF_INVALID'));
  const ignored = spec(); ignored.componentsTree[0].children[0].props.columns = 3;
  assert.ok((await both(ignored)).some(e => e.code === 'VIEW_PROP_INVALID'));
});

test('shared checks enforce registered parents, page type, unknown components and deleted node ids', async () => {
  const parent = spec(); parent.componentsTree[0].children[0].children[0].children = [{ id: 'nested_section', componentName: 'Section' }];
  assert.ok((await both(parent)).some(e => e.code === 'VIEW_CHILD_NOT_ALLOWED'));
  const wrongPage = spec(); wrongPage.view_type = 'LIST';
  assert.ok((await both(wrongPage)).some(e => e.code === 'VIEW_COMPONENT_UNREGISTERED'));
  const unsupported = spec(); unsupported.componentsTree[0].children[0].children[0].componentName = 'SubmitButton';
  assert.ok((await both(unsupported)).some(e => e.code === 'VIEW_COMPONENT_UNREGISTERED'));
  assert.ok((await both(spec(), ['title_field'])).some(e => e.code === 'VIEW_NODE_ID_DUPLICATE'));
  const duplicate = spec(); duplicate.componentsTree[0].children[0].children[1].id = 'title_field';
  assert.ok((await both(duplicate)).some(e => e.code === 'VIEW_NODE_ID_DUPLICATE'));
});

test('direct shared entry preserves structure preflight and budgets instead of descending malformed trees', async () => {
  assert.ok((await both({})).length > 0);
  const tooMany = spec();
  tooMany.componentsTree[0].children = Array.from({ length: 501 }, (_, i) => ({ id: `node_${i}`, componentName: 'Text', props: { text: 'word' } }));
  assert.ok((await both(tooMany)).some(e => e.code === 'VIEW_LIMIT_EXCEEDED'));
});

test('Fake wrapper preserves its locale-error precedence before dynamic field-reference traversal', async () => {
  const { validateView } = await import('../../../tools/meta-schema/node/view.mjs');
  const value = JSON.parse(readFileSync(join(root, 'tests/meta-schema/0a-core-r1/inputs/view-page-FORM.json')));
  const context = JSON.parse(readFileSync(join(root, 'tests/meta-schema/0a-core-r1/contexts/view-a005c4c2a8e72849.json')));
  value.i18n = { 'bad_tag!': {} };
  value.componentsTree[0].children = [{ id: 'unknown_field', componentName: 'ShortTextField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'missing' } } }];
  const errors = validateView(value, context, '');
  assert.ok(errors.some(e => e.code === 'VIEW_PROP_INVALID'));
  assert.equal(errors.some(e => e.code === 'VIEW_FIELD_REF_INVALID'), false);
  const run = spawnSync(python, ['-c', `import json,sys\nsys.path.insert(0,${JSON.stringify(join(root, 'tools/meta-schema/python'))})\nfrom view import validate_view\nx=json.load(sys.stdin)\nprint(json.dumps(validate_view(x['spec'],x['context'],'')))`],
    { input: JSON.stringify({ spec: value, context }), encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), errors);
});
