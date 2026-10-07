import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStaticServer } from '../app/server.js';
import { runAll, LAYER_IDS, SCENARIO_IDS } from '../public/lab.mjs';

async function withServer(fn) {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('/health and /version respond; the Lab page ships the nav', async () => {
  await withServer(async base => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`${base}/version`);
    assert.equal(version.status, 200);
    const body = await version.json();
    assert.equal(body.name, 'ai-engineering-is-not-llm-demo');
    assert.ok(body.commit);

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Packet Climb/);
    assert.match(html, /<nav aria-label="Primary">/);
    assert.match(html, /href="\/guide\.html"/);
    assert.match(html, /anhquanbd2021\/ai-engineering-is-not-llm/);
  });
});

test('guide page and every served module come back 200', async () => {
  await withServer(async base => {
    const guide = await fetch(`${base}/guide.html`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /aria-current="page" href="\/guide\.html"/);
    for (const path of [
      '/app.js', '/lab.mjs', '/model.mjs', '/kb.mjs', '/tools.mjs',
      '/examples.mjs', '/styles.css', '/pb-shell.css', '/pb-back.css',
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
    }
  });
});

test('unknown paths and traversal return 404; HEAD works', async () => {
  await withServer(async base => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/app/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});

test('POST /api/run drives the same lab the browser imports', async () => {
  await withServer(async base => {
    // LLM + prompt: the fabrication, served over HTTP.
    const bare = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layers: [], scenario: 'status' }),
    });
    assert.equal(bare.status, 200);
    const bareResult = await bare.json();
    assert.equal(bareResult.verdict, 'hallucinated');
    assert.match(bareResult.turns[0].reply, /arriving Tuesday/);

    // Full stack on the refund scenario: capped, receipted, grounded.
    const full = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layers: LAYER_IDS, scenario: 'refund' }),
    });
    const fullResult = await full.json();
    assert.equal(fullResult.verdict, 'grounded');
    assert.match(fullResult.turns[0].reply, /\$100 refunded/);

    // No scenario runs all three; a bad scenario is a 400.
    const all = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layers: LAYER_IDS }),
    });
    const allResult = await all.json();
    assert.deepEqual(allResult.misses, []);
    const bad = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layers: [], scenario: 'nope' }),
    });
    assert.equal(bad.status, 400);
  });
});

test('full-lab e2e: every scenario grounded with all layers on', () => {
  const { results, misses } = runAll({ layers: LAYER_IDS });
  assert.deepEqual(misses, []);
  for (const id of SCENARIO_IDS) {
    assert.equal(results[id].verdict, 'grounded', id);
  }
});
