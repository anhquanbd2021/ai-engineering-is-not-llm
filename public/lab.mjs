// The Packet Climb: one message ascends the production stack.
// createLab() wires the five optional layers around the same deterministic
// model; runTurn() routes one user message through whichever layers are on;
// runAll() replays the three scripted scenarios so the failure mode can be
// reproduced on demand: layers: [] is "LLM + prompt", and the same model
// fabricates fluently — shipped dates it can't know, refunds it never made.
import { KB, retrieve } from './kb.mjs';
import { POLICY, makeTools } from './tools.mjs';
import { draftReply } from './model.mjs';

export const LAYERS = [
  {
    id: 'context',
    name: 'Data & Context (RAG)',
    adds: 'retrieves the order record and policy doc into the prompt',
  },
  {
    id: 'memory',
    name: 'Memory',
    adds: 'pins facts the user already gave — the order id, the pending refund',
  },
  {
    id: 'tools',
    name: 'Tools & APIs',
    adds: 'calls lookupOrder and issueRefund for real, into a checkable log',
  },
  {
    id: 'guardrails',
    name: 'Guardrails',
    adds: 'caps refunds at $100 and blocks delivery promises with no tracking data',
  },
  {
    id: 'observability',
    name: 'Observability & Evals',
    adds: 'records the per-layer trace that exposes each fabrication',
  },
];

export const LAYER_IDS = LAYERS.map(l => l.id);

export const SCENARIOS = [
  {
    id: 'status',
    title: '“Where is my order?”',
    turns: ['Where is my order #4821?'],
  },
  {
    id: 'forgot',
    title: 'Three turns later',
    turns: [
      "Hi — my order is #4821. I returned it last week and I'm still waiting on the refund.",
      'Thanks, just checking in.',
      'Any update on it?',
    ],
  },
  {
    id: 'refund',
    title: 'The $180 ask',
    turns: ['Please refund me $180 for order #4821.'],
  },
];

export const SCENARIO_IDS = SCENARIOS.map(s => s.id);

export function createLab({ layers = [] } = {}) {
  const tools = makeTools();
  return {
    layers: [...layers],
    history: [],
    memory: [],              // pinned facts: { kind, value, turn }
    toolLog: tools.callLog,  // same array the tools write to
    tools,
  };
}

// ---- deterministic parsing -------------------------------------------------

function parseIntent(message) {
  const m = message.toLowerCase();
  if (/refund\s+(me|\$)/.test(m)) return 'refund';   // "refund me $180"
  if (/(where|status|update|tracking|deliver|arriv)/.test(m)) return 'status';
  if (/(check|thank|hi|hello|just)/.test(m)) return 'checkin';
  return 'unknown';
}

function parseOrderId(message) {
  return message.match(/#\s*(\d{3,})/)?.[1]
      ?? message.match(/order\s+(?:is\s+)?#?(\d{3,})/i)?.[1]
      ?? null;
}

function parseAmount(message) {
  const m = message.match(/refund\s+(?:me\s+)?\$?(\d+)/i);
  return m ? Number(m[1]) : null;
}

// ---- memory ----------------------------------------------------------------

function pin(lab, kind, value) {
  if (!lab.memory.some(p => p.kind === kind && p.value === value)) {
    lab.memory.push({ kind, value, turn: lab.history.filter(h => h.role === 'user').length + 1 });
  }
}

function pinFacts(lab, message) {
  const orderId = parseOrderId(message);
  if (orderId) pin(lab, 'orderId', orderId);
  if (/waiting on (the )?refund|still waiting/i.test(message)) pin(lab, 'refundPending', true);
  if (/returned/i.test(message)) pin(lab, 'returned', true);
  return lab.memory.length;
}

// ---- one turn up the stack -------------------------------------------------

export function runTurn(lab, message) {
  const has = id => lab.layers.includes(id);
  const intent = parseIntent(message);
  const mentioned = parseOrderId(message);
  const amount = parseAmount(message);
  const notes = {};

  // Memory pins what the user said *before* the model answers — turn 1's
  // pins are what turn 3's reply will need.
  if (has('memory')) {
    const before = lab.memory.length;
    pinFacts(lab, message);
    const fresh = lab.memory.slice(before);
    notes.memory = fresh.length
      ? `pinned ${fresh.map(p => (p.kind === 'orderId' ? `order #${p.value}` : p.kind)).join(', ')}`
      : `${lab.memory.length} pin${lab.memory.length === 1 ? '' : 's'} carried forward`;
  }

  const remembered = has('memory') ? lab.memory.find(p => p.kind === 'orderId')?.value : null;
  const orderId = mentioned ?? remembered ?? null;

  // Context: retrieval runs against the resolved referent. Without memory,
  // "any update on it?" has no referent — the search has nothing to find.
  let record = null;
  let retrieved = [];
  if (has('context')) {
    retrieved = retrieve(KB, `${orderId ?? ''} ${message}`, 2);
    record = retrieved.find(d => d.kind === 'order')?.record ?? null;
    notes.context = retrieved.length
      ? `${retrieved.length} doc${retrieved.length === 1 ? '' : 's'}: ${retrieved.map(d => d.id).join(', ')}`
      : '0 docs — nothing in context';
  }

  // Tools: real calls into a real log. lookupOrder only runs when context
  // didn't already supply the record — layers can substitute for each other.
  const calls = [];
  let refundCall = null;
  if (has('tools')) {
    if (intent === 'refund' && orderId) {
      refundCall = lab.tools.issueRefund(orderId, amount ?? POLICY.refundCap, {
        cap: has('guardrails') ? POLICY.refundCap : null,
      });
      calls.push(refundCall);
      notes.tools = refundCall.result.ok
        ? `issueRefund(#${orderId}, $${refundCall.args.issued}) → ${refundCall.result.receipt}`
        : `issueRefund(#${orderId}) → order not found`;
    } else if (intent === 'status' && orderId && !record) {
      const call = lab.tools.lookupOrder(orderId);
      calls.push(call);
      if (call.result) record = call.result;
      notes.tools = `lookupOrder(#${orderId}) → ${call.result ? 'record found' : 'not found'}`;
    } else {
      notes.tools = 'no call needed this turn';
    }
  }

  const memory = has('memory')
    ? { orderId: remembered, refundPending: lab.memory.some(p => p.kind === 'refundPending') }
    : null;

  let segments = draftReply({ intent, orderId, record, refundCall, memory, amount });

  // Guardrails: enforcement is code, not a paragraph in the prompt. Any
  // fabricated claim is intercepted and replaced with an honest refusal.
  if (has('guardrails')) {
    const fabrication = segments.find(s => s.mark === 'fabricated');
    if (fabrication) {
      segments = [
        intent === 'refund'
          ? { text: `I can't confirm a refund was issued — no refund call completed. Escalating to the refund desk instead of guessing.`, mark: 'blocked' }
          : { text: `I don't have tracking data for ${orderId ? `#${orderId}` : 'that order'}, so I can't promise a delivery date — flagging this for a human check.`, mark: 'blocked' },
      ];
      notes.guardrails = `blocked a fabricated ${intent === 'refund' ? 'refund claim' : 'delivery promise'}`;
    } else if (refundCall?.args?.capped) {
      notes.guardrails = `capped $${refundCall.args.requested} → $${refundCall.args.issued}`;
    } else {
      notes.guardrails = 'checked — reply within policy';
    }
  }

  const reply = segments.map(s => s.text).join('');
  const verdict = judge(segments, refundCall);

  // Observability: the trace exists only because this layer records it.
  const trace = has('observability')
    ? LAYERS.map(l => ({
        layer: l.id,
        on: has(l.id),
        note: l.id === 'observability'
          ? 'recording this trace'
          : has(l.id) ? (notes[l.id] ?? 'active — no contribution this turn') : 'off',
      }))
    : [{ layer: 'observability', on: false, note: 'trace not recorded — this reply leaves no evidence' }];

  lab.history.push({ role: 'user', text: message }, { role: 'agent', text: reply });
  return { reply, segments, trace, verdict, calls };
}

function judge(segments, refundCall) {
  if (segments.some(s => s.mark === 'blocked')) return 'blocked';
  if (segments.some(s => s.mark === 'fabricated' || s.mark === 'forgot')) return 'hallucinated';
  // A real call that still breaks policy isn't grounded — it's partial.
  if (refundCall?.result?.ok && refundCall.args.issued > POLICY.refundCap) return 'partial';
  return 'grounded';
}

// ---- scenarios ---------------------------------------------------------------

export function runScenario(lab, scenarioId) {
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  if (!scenario) throw new Error(`unknown scenario: ${scenarioId}`);
  const turns = scenario.turns.map(message => ({ message, ...runTurn(lab, message) }));
  return { id: scenario.id, title: scenario.title, turns, verdict: turns.at(-1).verdict };
}

export function runAll({ layers = [] } = {}) {
  const results = {};
  for (const s of SCENARIOS) {
    results[s.id] = runScenario(createLab({ layers }), s.id);
  }
  const misses = SCENARIOS.filter(s => results[s.id].verdict !== 'grounded').map(s => s.id);
  return { results, misses };
}
