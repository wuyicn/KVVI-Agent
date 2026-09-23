/** Fixed offline resource policy. JSON grammar and Schema evaluation stay with real engines. */
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const IDS = {
  'common.schema.json': 'common',
  'business-schema.v1.schema.json': 'business-schema-v1',
  'view-schema.lce-safe-v1.schema.json': 'view-schema-lce-safe-v1',
  'app-spec.v1alpha1.schema.json': 'app-spec-v1alpha1',
};
const VERSIONS = {'business-schema.v1.schema.json':'business-schema/v1','view-schema.lce-safe-v1.schema.json':'view-schema/lce-safe-v1','app-spec.v1alpha1.schema.json':'app-spec/v1alpha1'};
const SOURCES = {
  baseline: ['docs/PRD-AI无代码平台设计-v1.11.md', 'd517617a0c500713897e7d6c88b5894d4c802e6362ecf68631ba88776750993b'],
  design: ['docs/superpowers/specs/2026-09-08-0a-meta-schema-core-design.md', '6b3f0eea5a0cd8874c2d509bf446edb0402513efb6c3c6b00c26674fdecbe4c0'],
};
const known = new Set('$schema $id $ref $defs $comment title description default examples type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern format maxItems minItems uniqueItems maxContains minContains maxProperties minProperties required dependentRequired properties patternProperties additionalProperties unevaluatedProperties propertyNames items prefixItems contains dependentSchemas allOf anyOf oneOf not if then else readOnly writeOnly deprecated contentEncoding contentMediaType contentSchema'.split(' '));
const maps = ['$defs','properties','patternProperties','dependentSchemas'];
const singles = ['additionalProperties','unevaluatedProperties','propertyNames','items','contains','not','if','then','else','contentSchema'];
const lists = ['prefixItems','allOf','anyOf','oneOf'];
const fail = () => { throw new Error('invalid offline bundle'); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, want) => object(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...want].sort());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function strictJSON(bytes) {
  const text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
  const parsed = JSON.parse(text); // Grammar/non-finite tokens/garbage are rejected here.
  // Independently retain each object's raw keys; JSON.parse alone silently overwrites duplicates.
  const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu) ?? [];
  let index = 0;
  function value() {
    const token = tokens[index++];
    if (token === '{') {
      const seen = new Set();
      if (tokens[index] !== '}') do {
        const key = JSON.parse(tokens[index++]);
        if (seen.has(key)) fail();
        seen.add(key); index++; value();
      } while (tokens[index++] === ',');
      else index++;
    } else if (token === '[') {
      if (tokens[index] !== ']') do { value(); } while (tokens[index++] === ',');
      else index++;
    } else if (!token.startsWith('"') && !['true','false','null'].includes(token) && !Number.isFinite(Number(token))) fail();
  }
  value();
  return parsed;
}

function safeFile(root, name) {
  const file = join(root, name), rel = relative(realpathSync(root), realpathSync(file));
  if (lstatSync(file).isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel)) fail();
  return file;
}

export function readBundle(bundleDir, root) {
  const manifest = strictJSON(readFileSync(safeFile(bundleDir, 'manifest.json')));
  if (!keys(manifest, ['suite_revision','schema_dialect','baseline','design','resources']) || manifest.suite_revision !== '0a-core-r1' || manifest.schema_dialect !== DIALECT || !keys(manifest.resources, Object.keys(IDS))) fail();
  const schemas = new Map(), byID = new Map();
  for (const [name, suffix] of Object.entries(IDS)) {
    const record = manifest.resources[name];
    if (!keys(record, ['id','sha256','dependencies', ...(VERSIONS[name] ? ['contract_version'] : [])]) || record.id !== 'urn:kvvi:meta-schema:0a-core-r1:' + suffix || !/^[0-9a-f]{64}$/u.test(record.sha256) || (VERSIONS[name] && record.contract_version !== VERSIONS[name]) || JSON.stringify(record.dependencies) !== JSON.stringify(name === 'common.schema.json' ? [] : ['urn:kvvi:meta-schema:0a-core-r1:common'])) fail();
    const bytes = readFileSync(safeFile(bundleDir, name));
    if (hash(bytes) !== record.sha256) fail();
    const schema = strictJSON(bytes);
    if (!object(schema) || schema.$schema !== DIALECT || schema.$id !== record.id || byID.has(schema.$id)) fail();
    schemas.set(name, schema); byID.set(schema.$id, schema);
  }
  for (const [key, [name, sha]] of Object.entries(SOURCES)) {
    const record = manifest[key];
    if (!keys(record, ['path','sha256']) || record.path !== name || record.sha256 !== sha || hash(readFileSync(safeFile(root, name))) !== sha) fail();
  }
  const definitionRefs = [];
  const pointerKey = key => encodeURIComponent(key.replace(/~/g,'~0').replace(/\//g,'~1'));
  function visit(schema, owner, pointer = '') {
    if (typeof schema === 'boolean') return;
    if (!object(schema) || Object.keys(schema).some(k => !known.has(k))) fail();
    if (schema.format !== undefined && !['date-time','uuid'].includes(schema.format)) fail();
    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== 'string') fail();
      const separator = schema.$ref.indexOf('#');
      const id = separator < 0 ? schema.$ref : schema.$ref.slice(0, separator);
      const fragment = separator < 0 ? '' : schema.$ref.slice(separator + 1);
      let target = byID.get(id || owner.$id);
      if (target === undefined || (fragment && !fragment.startsWith('/'))) fail();
      for (const part of fragment.split('/').slice(1)) {
        const key = part.replace(/~1/g,'/').replace(/~0/g,'~');
        if (!object(target) || !Object.hasOwn(target, key)) fail();
        target = target[key];
      }
      if (typeof target !== 'boolean' && !object(target)) fail();
    }
    for (const key of maps) if (schema[key] !== undefined) {
      if (!object(schema[key])) fail();
      for (const [name, child] of Object.entries(schema[key])) {
        const childPointer = `${pointer}/${key}/${pointerKey(name)}`;
        if (key === '$defs') definitionRefs.push(owner.$id + '#' + childPointer);
        visit(child, owner, childPointer);
      }
    }
    for (const key of singles) if (schema[key] !== undefined) visit(schema[key], owner, `${pointer}/${key}`);
    for (const key of lists) if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key])) fail();
      schema[key].forEach((child, index) => visit(child, owner, `${pointer}/${key}/${index}`));
    }
  }
  for (const schema of schemas.values()) visit(schema, schema);
  return {schemas, definitionRefs};
}
