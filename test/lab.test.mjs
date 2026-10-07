import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LAYERS, LAYER_IDS, SCENARIOS, SCENARIO_IDS,
  createLab, runTurn, runScenario, runAll,
} from '../public/lab.mjs';
import { KB, retrieve } from '../public/kb.mjs';
import { POLICY, makeTools } from '../public/tools.mjs';
import { PROMPT_ONLY_SOURCE, FULL_STACK_SOURCE } from '../public/examples.mjs';

// ---- catalog ---------------------------------------------------------------

test('five layers, in stack order', () => {
  assert.deepEqual(LAYER_IDS, ['context', 'memory', 'tools', 'guardrails', 'observability']);
  for (const layer of LAYERS) {
    assert.ok(layer.name && layer.adds, `${layer.id} needs a name and a contribution`);
  }
});

test('three scripted scenarios', () => {
  assert.deepEqual(SCENARIO_IDS, ['status', 'forgot', 'refund']);
  assert.equal(SCENARIOS.find(s => s.id === 'forgot').turns.length, 3);
});

// ---- the failure mode, reproduced on demand ---------------------------------

test('LLM + prompt only: status and refund are hallucinated', () => {
  const { results, misses } = runAll({ layers: [] });
  assert.equal(results.status.verdict, 'hallucinated');
  assert.equal(results.refund.verdict, 'hallucinated');
  assert.equal(results.forgot.verdict, 'hallucinated');
  assert.deepEqual(misses.sort(), ['forgot', 'refund', 'status']);

  // The fabrications are the exact claims the article cites.
  assert.match(results.status.turns[0].reply, /arriving Tuesday/);
  assert.match(results.refund.turns[0].reply, /\$180 refunded/);

  // And the refund never happened — the tool log is empty.
  const lab = createLab({ layers: [] });
  runTurn(lab, 'Please refund me $180 for order #4821.');
  assert.equal(lab.toolLog.length, 0);
});

test('without memory, turn 3 re-asks a fact the user already gave', () => {
  const lab = createLab({ layers: [] });
  const { turns, verdict } = runScenario(lab, 'forgot');
  assert.equal(verdict, 'hallucinated');
  assert.match(turns[2].reply, /order number/);
  assert.equal(turns[2].segments[0].mark, 'forgot');
});

// ---- layers flip specific failures -------------------------------------------

test('context grounds the status reply with the real record', () => {
  const { results } = runAll({ layers: ['context'] });
  assert.equal(results.status.verdict, 'grounded');
  assert.match(results.status.turns[0].reply, /delivered Oct 1/);
  assert.match(results.status.turns[0].reply, /returned Oct 3/);
  // Context can't resolve "it" in turn 3 — forgot still fails.
  assert.equal(results.forgot.verdict, 'hallucinated');
});

test('memory stops the re-ask: turn 3 remembers #4821', () => {
  const { results } = runAll({ layers: ['memory'] });
  assert.equal(results.forgot.verdict, 'grounded');
  assert.match(results.forgot.turns[2].reply, /#4821/);
  assert.match(results.forgot.turns[2].reply, /refund/);
  // But memory alone knows nothing about the record — status still fabricates.
  assert.equal(results.status.verdict, 'hallucinated');
});

test('tools make the refund real — a call and a receipt, still over cap', () => {
  const lab = createLab({ layers: ['tools'] });
  const { reply, verdict, calls } = runTurn(lab, 'Please refund me $180 for order #4821.');
  assert.equal(verdict, 'partial'); // real action, policy violated
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'issueRefund');
  assert.equal(calls[0].args.issued, 180);
  assert.ok(calls[0].result.receipt);
  assert.match(reply, /Receipt R-4821-001/);
  assert.equal(lab.toolLog.length, 1); // the log is the evidence
});

test('tools can substitute for retrieval on the status question', () => {
  const lab = createLab({ layers: ['tools'] });
  const { verdict, calls } = runTurn(lab, 'Where is my order #4821?');
  assert.equal(verdict, 'grounded');
  assert.equal(calls[0].tool, 'lookupOrder');
});

test('guardrails cap the refund at the $100 policy limit', () => {
  const lab = createLab({ layers: ['tools', 'guardrails'] });
  const { reply, verdict, calls } = runTurn(lab, 'Please refund me $180 for order #4821.');
  assert.equal(verdict, 'grounded');
  assert.equal(calls[0].args.requested, 180);
  assert.equal(calls[0].args.issued, POLICY.refundCap);
  assert.equal(calls[0].args.capped, true);
  assert.match(reply, /\$100 refunded/);
});

test('guardrails alone block fabrications — but cannot ground them', () => {
  const { results } = runAll({ layers: ['guardrails'] });
  assert.equal(results.status.verdict, 'blocked');
  assert.equal(results.refund.verdict, 'blocked');
  assert.match(results.status.turns[0].reply, /can't promise a delivery date/);
  assert.match(results.refund.turns[0].reply, /no refund call completed/);
});

test('observability emits the per-layer trace', () => {
  const lab = createLab({ layers: ['context', 'observability'] });
  const { trace } = runTurn(lab, 'Where is my order #4821?');
  assert.equal(trace.length, LAYERS.length);
  const contextEntry = trace.find(t => t.layer === 'context');
  assert.equal(contextEntry.on, true);
  assert.match(contextEntry.note, /order-4821/);
  const toolsEntry = trace.find(t => t.layer === 'tools');
  assert.equal(toolsEntry.on, false);
});

test('no observability, no trace — the reply leaves no evidence', () => {
  const lab = createLab({ layers: [] });
  const { trace } = runTurn(lab, 'Where is my order #4821?');
  assert.equal(trace.length, 1);
  assert.equal(trace[0].layer, 'observability');
  assert.equal(trace[0].on, false);
  assert.match(trace[0].note, /not recorded/);
});

// ---- the full stack -----------------------------------------------------------

test('all layers on: every scenario grounded', () => {
  const { results, misses } = runAll({ layers: LAYER_IDS });
  assert.deepEqual(misses, []);
  for (const id of SCENARIO_IDS) {
    assert.equal(results[id].verdict, 'grounded', id);
  }
});

test('runTurn returns reply, segments, trace, verdict, calls', () => {
  const lab = createLab({ layers: LAYER_IDS });
  const turn = runTurn(lab, 'Where is my order #4821?');
  for (const key of ['reply', 'segments', 'trace', 'verdict', 'calls']) {
    assert.ok(key in turn, key);
  }
  assert.equal(lab.history.length, 2); // user + agent
});

// ---- fixtures ------------------------------------------------------------------

const readFixture = name =>
  readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('example fixtures match the files on disk', () => {
  assert.equal(readFixture('prompt-only.mjs'), PROMPT_ONLY_SOURCE);
  assert.equal(readFixture('full-stack.mjs'), FULL_STACK_SOURCE);
});

// ---- kb + tools units ------------------------------------------------------------

test('retrieve scores keywords and drops zero-hit docs', () => {
  const docs = retrieve(KB, 'where is order 4821', 2);
  assert.equal(docs[0].id, 'order-4821');
  const none = retrieve(KB, 'unrelated question about the weather', 2);
  assert.equal(none.length, 0);
});

test('makeTools: issueRefund honors the cap and logs every call', () => {
  const { issueRefund, lookupOrder, callLog } = makeTools();
  const capped = issueRefund('4821', 180, { cap: 100 });
  assert.equal(capped.args.issued, 100);
  assert.equal(capped.args.capped, true);
  const uncapped = issueRefund('4821', 180);
  assert.equal(uncapped.args.issued, 180);
  lookupOrder('4821');
  assert.equal(callLog.length, 3);
  assert.equal(lookupOrder('9999').result, null);
});
