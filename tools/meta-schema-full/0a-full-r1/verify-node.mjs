/** Batch structural checker. No network retrieval, coercion, defaults or mutation. */
import fs from 'node:fs';
import Ajv2020 from '../../meta-schema/node/node_modules/ajv/dist/2020.js';
import addFormats from '../../meta-schema/node/node_modules/ajv-formats/dist/index.js';
import { validDate, validDatetime } from '../../meta-schema/node/values.mjs';
import { businessBudgetErrors } from '../../meta-schema/node/expressions.mjs';
import { viewPreflight, walk, isObject, isI18nPath } from '../../meta-schema/node/view_safety.mjs';

const { schemas, cases } = JSON.parse(fs.readFileSync(0, 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false,
  useDefaults: false, removeAdditional: false, validateFormats: true });
addFormats(ajv);
// The full suite fixes UUID syntax instead of inheriting ajv-formats' URN extension.
ajv.addFormat('uuid', { type: 'string', validate: value => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![\s\S])/.test(value) });
ajv.addFormat('date', { type: 'string', validate: validDate });
ajv.addFormat('date-time', { type: 'string', validate: validDatetime });
for (const schema of Object.values(schemas)) ajv.addSchema(schema);
const escaped = s => s.replaceAll('~', '~0').replaceAll('/', '~1');
function compileDefinitions(schema, id, path = '') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  for (const [key, child] of Object.entries(schema)) {
    if (['$defs', 'properties', 'patternProperties', 'dependentSchemas'].includes(key)) {
      for (const [name, node] of Object.entries(child)) {
        const sub = `${path}/${key}/${escaped(name)}`;
        if (key === '$defs' && !ajv.getSchema(`${id}#${sub}`)) throw new Error('unavailable definition');
        compileDefinitions(node, id, sub);
      }
    } else if (['items', 'contains', 'not', 'if', 'then', 'else', 'additionalProperties', 'unevaluatedProperties', 'propertyNames'].includes(key)) {
      compileDefinitions(child, id, `${path}/${key}`);
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      child.forEach((node, index) => compileDefinitions(node, id, `${path}/${key}/${index}`));
    }
  }
}
for (const schema of Object.values(schemas)) {
  if (!ajv.getSchema(schema.$id)) throw new Error('unavailable root');
  compileDefinitions(schema, schema.$id);
}
const entries = { spec: 'Spec', 'compiled-draft': 'CompiledDraft', registered: 'RegisteredContract' };
const before = JSON.stringify(cases);
const result = cases.map(test => {
  const id = schemas[test.schema].$id + (entries[test.entry] ? `#/$defs/${entries[test.entry]}` : '');
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error('unknown schema entry');
  const spec = test.entry === 'spec' ? test.value : test.value?.spec;
  const prefix = test.entry === 'spec' ? '' : 'spec';
  // Match the migrated core protocol's established structural preflight. This
  // does not add a general depth limit or treat engine exceptions as rejection.
  let preflight = [];
  if (test.schema === 'business-schema.v1.schema.json')
    preflight = businessBudgetErrors(spec, prefix);
  else if (test.schema === 'view-schema.lce-safe-v1.schema.json')
    preflight = viewPreflight(spec, prefix);
  let valid = preflight.length === 0 && Boolean(validate(test.value));
  if (valid && test.schema === 'view-schema.lce-safe-v1.schema.json') {
    const kinds = new Set(['FieldRef', 'I18nRef', 'SafeExpression', 'ActionRef', 'DataQueryRef', 'DataBindingRef']);
    for (const [item, path] of walk(test.value)) {
      if (isObject(item) && !isI18nPath(path) && kinds.has(item.type)) {
        const local = ajv.getSchema(`${schemas[test.schema].$id}#/$defs/${item.type}`);
        if (!local) throw new Error('unavailable typed View definition');
        if (!local(item)) { valid = false; break; }
      }
    }
  }
  return { id: test.id, valid };
});
if (before !== JSON.stringify(cases)) throw new Error('Node validation modified inputs');
process.stdout.write(JSON.stringify(result));
