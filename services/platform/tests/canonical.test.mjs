import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../../../tools/meta-schema/node/canonical.mjs', import.meta.url);
const vectorUrl = new URL('../../../protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/vectors.json', import.meta.url);
const vectors = JSON.parse(readFileSync(vectorUrl, 'utf8'));

test('canonical protocol is importable without stdin, stdout or process exit side effects', async () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.exitCode = 17;
    await import(${JSON.stringify(moduleUrl.href)});
    if (process.exitCode !== 17) throw Error('import changed exitCode');
    process.stdout.write('imported');
    process.exitCode = 0;
  `], { input: 'not JSON', encoding: 'utf8', timeout: 3000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'imported');
  assert.equal(run.stderr, '');
});

test('production canonical module matches all frozen protocol vectors', async (t) => {
  const { canonicalizeJson } = await import(moduleUrl);
  for (const item of vectors.positive) await t.test(item.id, () => {
    const actual = canonicalizeJson(item.input);
    assert.equal(actual.status, 'ok');
    assert.equal(actual.profile, vectors.profile);
    assert.equal(actual.canonical, item.canonical);
    assert.equal(actual.canonical_utf8_hex, item.canonical_utf8_hex);
    assert.equal(actual.digest, `sha256:${item.sha256}`);
  });
  for (const item of vectors.negative) await t.test(item.id, () => {
    assert.throws(() => canonicalizeJson(item.input, item.profile ?? vectors.profile),
      { errorCode: item.error_code });
  });
});

test('raw JSON preserves numeric and duplicate-key rejection before JSON.parse loses information', async () => {
  const { canonicalizeJson } = await import(moduleUrl);
  for (const raw of ['1.0000000000000001', '1e-9999999999999999999999999']) {
    assert.throws(() => canonicalizeJson(raw), { errorCode: 'CANON_NUMBER_UNSUPPORTED' });
  }
  assert.throws(() => canonicalizeJson('9007199254740993'), { errorCode: 'CANON_NUMBER_OUT_OF_RANGE' });
  assert.throws(() => canonicalizeJson('{"nested":{"a":1,"\\u0061":2}}'), { errorCode: 'CANON_DUPLICATE_KEY' });
  assert.equal(canonicalizeJson('{"__proto__":{"constructor":1}}').canonical, '{"__proto__":{"constructor":1}}');
  assert.equal(canonicalizeJson('-9007199254740991').canonical, '-9007199254740991');
});

test('byte boundary rejects invalid UTF-8 and BOM before any replacement or stripping', async () => {
  const { canonicalizeBytes, canonicalizeJson } = await import(moduleUrl);
  for (const raw of [Buffer.from([0x22, 0xc0, 0xaf, 0x22]), Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22])]) {
    assert.throws(() => canonicalizeBytes(raw), { errorCode: 'CANON_INVALID_UNICODE' });
  }
  assert.throws(() => canonicalizeBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), { errorCode: 'CANON_JSON_INVALID' });
  assert.throws(() => canonicalizeJson({ a: 1 }), { errorCode: 'CANON_JSON_INVALID' });
  assert.throws(() => canonicalizeBytes('{}'), { errorCode: 'CANON_JSON_INVALID' });
  assert.throws(() => canonicalizeBytes(Buffer.from('{}'), 'latest'), { errorCode: 'CANON_PROFILE_UNSUPPORTED' });
  assert.throws(() => canonicalizeBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'latest'), { errorCode: 'CANON_JSON_INVALID' });
  assert.throws(() => canonicalizeBytes(Buffer.from([0xff]), 'latest'), { errorCode: 'CANON_INVALID_UNICODE' });
  assert.deepEqual(canonicalizeBytes(new Uint8Array(Buffer.from(vectors.positive[4].input))), canonicalizeJson(vectors.positive[4].input));
});

test('existing Fake resolver digest remains protocol compatible without changing fixture trust', async () => {
  const { contentDigest, resolveAsset } = await import('../../../tools/meta-schema/node/view_registry.mjs');
  assert.equal(contentDigest({ '😀': 1, 'דּ': 2 }), 'sha256:96c4e1b26f2ef1f5f03e115d3128f9306830bf5eaf2d523c0f7551d3424e4937');
  const content = { a: 1, b: 2 };
  const ref = { asset_id: 'fake-only', version: 1, digest: 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777' };
  assert.deepEqual(resolveAsset(ref, { fake_assets: [{ ref, content }] }), [content, 'ok']);
  assert.deepEqual(resolveAsset({ ...ref, digest: 'sha256:wrong' }, { fake_assets: [{ ref, content }] }), [null, 'digest']);
});
