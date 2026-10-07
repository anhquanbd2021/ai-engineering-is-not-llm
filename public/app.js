import { LAYERS, SCENARIOS, createLab, runScenario, runAll } from '/lab.mjs';

const $ = sel => document.querySelector(sel);
const lanesEl = $('#lanes');
const transcript = $('#transcript');
const toolLog = $('#tool-log');
const toolLogEmpty = $('#tool-log-empty');
const traceRail = $('#trace-rail');
const verdictBadge = $('#verdict-badge');
const stackState = $('#stack-state');
const packet = $('#packet');
const scenarioResults = $('#scenario-results');

const VERDICT_CLASS = { grounded: 'pass', hallucinated: 'fail', blocked: 'warn', partial: 'warn' };
const VERDICT_LABEL = { grounded: 'grounded', hallucinated: 'hallucinated', blocked: 'blocked by policy', partial: 'real but off-policy' };

// ---- build the lane toggles + the climb --------------------------------------

function renderToggles() {
  const box = $('#layer-toggles');
  for (const layer of LAYERS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'layer';
    input.value = layer.id;
    input.addEventListener('change', () => {
      document.querySelectorAll('input[name="preset"]').forEach(r => { r.checked = false; });
      paintStackState();
    });
    const span = document.createElement('span');
    span.innerHTML = `<strong>${layer.name}</strong> — ${layer.adds}`;
    label.append(input, span);
    box.appendChild(label);
  }
}

function renderLanes() {
  // Top of the stack first: the packet climbs from context up to the model.
  for (const layer of [...LAYERS].reverse()) {
    const li = document.createElement('li');
    li.className = 'lane off';
    li.id = `lane-${layer.id}`;
    li.innerHTML = `
      <div class="lane-head"><strong>${layer.name}</strong><span class="lane-adds muted">${layer.adds}</span></div>
      <div class="lane-stamps" id="stamps-${layer.id}" aria-label="${layer.name} contribution"></div>`;
    lanesEl.appendChild(li);
  }
}

function currentLayers() {
  return [...document.querySelectorAll('input[name="layer"]:checked')].map(i => i.value);
}

function paintStackState() {
  const n = currentLayers().length;
  stackState.textContent = n === 0 ? 'no lanes lit' : `${n} lane${n === 1 ? '' : 's'} lit`;
  stackState.className = `badge ${n === 0 ? 'warn' : n === LAYERS.length ? 'pass' : ''}`;
  for (const layer of LAYERS) {
    $(`#lane-${layer.id}`).classList.toggle('off', !currentLayers().includes(layer.id));
    $(`#lane-${layer.id}`).classList.toggle('on', currentLayers().includes(layer.id));
  }
}

// ---- the packet climb ---------------------------------------------------------

function climbPacket() {
  const climb = $('#climb');
  const model = $('#model-box');
  const distance = packet.getBoundingClientRect().top - model.getBoundingClientRect().top
    + packet.offsetHeight / 2;
  packet.style.setProperty('--climb', `${distance}px`);
  packet.classList.remove('climbed');
  void packet.offsetWidth; // restart the transition
  packet.classList.add('climbed');
  climb.classList.add('in-flight');
  setTimeout(() => climb.classList.remove('in-flight'), 900);
}

// ---- render the reply, the log, the trace --------------------------------------

function segmentSpan(seg) {
  const span = document.createElement('span');
  span.textContent = seg.text;
  if (seg.mark !== 'plain') span.className = `mark-${seg.mark}`;
  return span;
}

function renderTranscript(turns) {
  transcript.innerHTML = '';
  turns.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'exchange';
    const user = document.createElement('p');
    user.className = 'msg user';
    user.innerHTML = `<span class="who">user</span>`;
    const userText = document.createElement('span');
    userText.textContent = t.message;
    user.appendChild(userText);
    const agent = document.createElement('p');
    agent.className = 'msg agent';
    agent.innerHTML = `<span class="who">agent <em class="turn-verdict ${VERDICT_CLASS[t.verdict]}">${VERDICT_LABEL[t.verdict]}</em></span>`;
    const reply = document.createElement('span');
    for (const seg of t.segments) reply.appendChild(segmentSpan(seg));
    agent.appendChild(reply);
    li.append(user, agent);
    if (turns.length > 1) li.insertAdjacentHTML('afterbegin', `<span class="turn-no">turn ${i + 1}</span>`);
    transcript.appendChild(li);
  });
}

function renderToolLog(turns) {
  toolLog.innerHTML = '';
  const calls = turns.flatMap(t => t.calls);
  toolLogEmpty.hidden = calls.length > 0;
  for (const call of calls) {
    const li = document.createElement('li');
    li.className = 'call';
    const args = Object.entries(call.args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
    li.textContent = `${call.tool}(${args}) → ${JSON.stringify(call.result)}`;
    toolLog.appendChild(li);
  }
}

function renderTrace(trace) {
  traceRail.innerHTML = '';
  for (const entry of trace) {
    const li = document.createElement('li');
    li.className = `trace-entry ${entry.on ? 'on' : 'off'}`;
    const name = LAYERS.find(l => l.id === entry.layer)?.name ?? entry.layer;
    li.innerHTML = `<strong>${name}</strong><span>${entry.note}</span>`;
    traceRail.appendChild(li);
  }
}

// ---- run ------------------------------------------------------------------------

function runOne(scenarioId) {
  const layers = currentLayers();
  const result = runScenario(createLab({ layers }), scenarioId);
  const last = result.turns.at(-1);

  for (const layer of LAYERS) {
    const stamps = $(`#stamps-${layer.id}`);
    stamps.innerHTML = '';
    if (layers.includes(layer.id)) {
      const entry = last.trace.find(t => t.layer === layer.id);
      const chip = document.createElement('span');
      chip.className = 'stamp';
      chip.textContent = entry ? entry.note : 'active';
      stamps.appendChild(chip);
    }
  }

  renderTranscript(result.turns);
  renderToolLog(result.turns);
  renderTrace(last.trace);

  verdictBadge.textContent = VERDICT_LABEL[result.verdict];
  verdictBadge.className = `badge ${VERDICT_CLASS[result.verdict]}`;
  climbPacket();
}

function runSweep() {
  const layers = currentLayers();
  const { results } = runAll({ layers });
  scenarioResults.innerHTML = '';
  for (const s of SCENARIOS) {
    const r = results[s.id];
    const li = document.createElement('li');
    li.className = `scenario-result ${VERDICT_CLASS[r.verdict]}`;
    li.innerHTML = `<strong>${s.title}</strong><span class="badge ${VERDICT_CLASS[r.verdict]}">${VERDICT_LABEL[r.verdict]}</span><span class="muted">${r.turns.at(-1).reply}</span>`;
    scenarioResults.appendChild(li);
  }
  climbPacket();
}

// ---- wiring ---------------------------------------------------------------------

for (const r of document.querySelectorAll('input[name="preset"]')) {
  r.addEventListener('change', () => {
    const full = r.value === 'full';
    document.querySelectorAll('input[name="layer"]').forEach(i => { i.checked = full; });
    paintStackState();
  });
}

$('#run-scenario').addEventListener('click', () => {
  runOne(document.querySelector('input[name="scenario"]:checked').value);
});
$('#run-all').addEventListener('click', runSweep);

renderToggles();
renderLanes();
paintStackState();
