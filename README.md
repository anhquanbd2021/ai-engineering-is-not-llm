# Packet Climb — companion demo

Interactive lab for the article *AI Engineering Is Not "LLM + Prompt" — the
Model Is the Easy Part*. One deterministic model stub, one scripted Refund
Desk scenario, five switchable layers — the only variable is which parts of
the surrounding system are switched on.

Zero dependencies — Node 24+ only. The lab, the model stub, the knowledge
base, and the tools are plain ES modules shared by the browser UI, the CLI,
the API endpoint, and the test suite.

## What it proves

A model answers from whatever the surrounding system gives it. With no
system — `layers: []`, "LLM + prompt" — the same model:

- answers "Order #4821 ships tomorrow — arriving Tuesday" when the record
  says *delivered Oct 1, returned Oct 3, refund pending*;
- re-asks "what's your order number?" two turns after the user gave it;
- says "Done — $180 refunded" with an empty tool log and a $100 policy cap.

Toggle layers on one at a time and watch specific failures flip: `context`
grounds the status reply, `memory` stops the re-ask, `tools` puts a real
`issueRefund` call (and a receipt) in the log, `guardrails` cap it at $100
and block delivery promises, `observability` emits the per-layer trace that
exposes each fabrication.

## Run it

```text
npm start        # serve the lab on http://localhost:3000
npm test         # domain model + failure mode + server e2e
npm run lab      # CLI: scenario × layer verdict table
npm run check    # tests
```

`node scripts/lab.mjs --full` runs every scenario with all layers on and
prints the annotated transcript.

## Layout

- `public/lab.mjs` — the lab: `LAYERS`, `SCENARIOS`, `createLab`, `runTurn`,
  `runScenario`, `runAll`
- `public/model.mjs` — `draftReply`, the deterministic template model
- `public/kb.mjs` — `KB`, `retrieve` (keyword-scored stand-in for a vector DB)
- `public/tools.mjs` — `POLICY`, `makeTools` → `lookupOrder`, `issueRefund`,
  `callLog`
- `examples/` — the two preset fixtures: `prompt-only`, `full-stack`
- `scripts/lab.mjs` — the CLI verdict table + annotated transcript
- `app/server.js` — zero-dep static host, `/health`, `/version`, `POST /api/run`
- `test/` — `node --test "test/*.test.mjs"`

## Honest limits

- The "model" is a template drafter, not an LLM — real models fabricate more
  creatively, which strengthens the point rather than weakening it.
- `retrieve` scores keywords; a real vector DB embeds and ranks. The
  contract — query in, relevant docs out — is what the layer proves.
- Memory pins two fact shapes (order id, pending refund); production memory
  needs retention, compaction, and privacy policy.
- Guardrails here intercept fabricated claims only; real policy enforcement
  also scans inputs, tool args, and chained calls.

This is an educational model, not production infrastructure.

Repo: https://github.com/anhquanbd2021/ai-engineering-is-not-llm
