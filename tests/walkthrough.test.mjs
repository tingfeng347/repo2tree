import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Player } from '../web/engine.js';
import { buildPresentation } from '../web/presentation.js';

// Read the shipped snapshot only; never import or execute the shop application.
const graph = JSON.parse(readFileSync(new URL('../examples/demo.project.json', import.meta.url), 'utf8'));
function finish(player) {
  for (let i = 0; i < 300 && player.status !== 'done'; i++) {
    const event = player.current;
    const model = buildPresentation(graph, player);
    assert(model.guidance.title);
    if (event.type === 'choice') {
      assert.equal(model.guidance.action, null);
      // Teaching scenario: non-error branches, one loop iteration, explicit
      // callback/scheduling/target confirmations. No expression evaluation.
      player.choose(event.choiceKind === 'if' ? 1 : event.choiceKind === 'loop' && event.iterations ? 1 : 0);
    } else {
      assert(model.guidance.action);
      player.step();
    }
  }
  assert.equal(player.status, 'done', 'walkthrough must terminate within the scenario bound');
}

test('shipped frontend scenario reaches the API, nested function, cleanup and recap', () => {
  const p = new Player(graph); p.start(graph.entries.find(e => e.kind === 'frontend').id); finish(p);
  assert.equal(p.current.outcome, 'completed');
  const names = p.history.filter(e => e.type === 'enter').map(e => p.nodes.get(e.symbol).name);
  for (const name of ['OrderPage', 'submitOrder', 'create_order', 'reserve', 'build_id', 'audit']) assert(names.includes(name), name);
  assert(p.history.some(e => e.type === 'finally'));
  const recap = buildPresentation(graph, p);
  assert.equal(recap.guidance.action, null); assert.equal(recap.summary.calls, 13);
  const restored = new Player(graph); restored.import(p.export({quantity: 1}, 'Single item'));
  assert.deepEqual(buildPresentation(graph, restored).summary, recap.summary);
});

test('a failing API scenario can rewind its original choice and become a successful path', () => {
  const p = new Player(graph); p.start(graph.entries.find(e => e.label === 'POST /api/orders').id);
  for (let i = 0; i < 30 && p.current.type !== 'choice'; i++) p.step();
  assert.match(p.current.choices[0], /quantity <= 0/);
  const choice = p.cursor; p.choose(0); finish(p);
  assert.equal(p.current.outcome, 'raise');
  const original = buildPresentation(graph, p).decisions.find(d => d.choiceIndex === choice);
  assert(original);
  p.seek(original.choiceIndex);
  assert.equal(p.current.type, 'choice'); assert.equal(buildPresentation(graph, p).summary.decisions, 0);
  p.choose(1); finish(p);
  assert.equal(p.current.outcome, 'completed');
  assert(!p.history.some(e => e.type === 'raise' && /quantity must be positive/.test(e.text)));
});
