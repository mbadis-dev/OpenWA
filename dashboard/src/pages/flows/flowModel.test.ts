import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowEdge, FlowNode } from '../../types/flows';
import {
  availableVariables,
  connect,
  createNode,
  freeSpot,
  outputHandles,
  parseKeywords,
  pruneEdges,
  starterFlow,
  toDefinition,
  type StepDefaults,
} from './flowModel.ts';

const defaults: StepDefaults = {
  message: 'Hello',
  collect: 'Your answer?',
  handoff: 'A person will reply',
  notify: 'New chat',
  choice: n => `Option ${n}`,
};

const at = { x: 0, y: 0 };

test('a new flow is a start step wired to a menu with two choices', () => {
  const flow = starterFlow(defaults);
  const [trigger, menu] = flow.nodes;
  assert.equal(trigger.type, 'trigger');
  assert.equal(menu.type, 'message');
  assert.deepEqual(
    outputHandles(menu),
    (menu.data as { choices: { id: string }[] }).choices.map(c => c.id),
  );
  assert.deepEqual(
    flow.edges.map(e => [e.source, e.sourceHandle, e.target]),
    [[trigger.id, 'next', menu.id]],
  );
});

test('each step type offers the outputs the gateway expects', () => {
  assert.deepEqual(outputHandles(createNode('trigger', at, defaults)), ['next']);
  assert.deepEqual(outputHandles(createNode('message', at, defaults)), ['next']);
  assert.deepEqual(outputHandles(createNode('collect', at, defaults)), ['next']);
  assert.deepEqual(outputHandles(createNode('condition', at, defaults)), ['yes', 'no']);
  assert.deepEqual(outputHandles(createNode('handoff', at, defaults)), []);
});

test('connecting an output replaces what it led to before', () => {
  const a = createNode('message', at, defaults);
  const b = createNode('message', at, defaults);
  const c = createNode('message', at, defaults);
  const nodes = [a, b, c];
  let edges: FlowEdge[] = connect(nodes, [], { source: a.id, sourceHandle: 'next', target: b.id });
  edges = connect(nodes, edges, { source: a.id, sourceHandle: 'next', target: c.id });
  assert.deepEqual(
    edges.map(e => e.target),
    [c.id],
  );
});

test('a step cannot connect to itself or into the start step', () => {
  const trigger = createNode('trigger', at, defaults);
  const a = createNode('message', at, defaults);
  const nodes = [trigger, a];
  assert.deepEqual(connect(nodes, [], { source: a.id, sourceHandle: 'next', target: a.id }), []);
  assert.deepEqual(connect(nodes, [], { source: a.id, sourceHandle: 'next', target: trigger.id }), []);
});

test('removing a choice or a step drops the connections that used it', () => {
  const flow = starterFlow(defaults);
  const menu = flow.nodes[1] as Extract<FlowNode, { type: 'message' }>;
  const after = createNode('message', at, defaults);
  const nodes: FlowNode[] = [...flow.nodes, after];
  const [first, second] = menu.data.choices;
  let edges = connect(nodes, flow.edges, { source: menu.id, sourceHandle: first.id, target: after.id });
  edges = connect(nodes, edges, { source: menu.id, sourceHandle: second.id, target: after.id });
  assert.equal(edges.length, 3);

  menu.data.choices = [second];
  assert.equal(pruneEdges(nodes, edges).length, 2);
  assert.equal(
    pruneEdges(
      nodes.filter(n => n.id !== after.id),
      edges,
    ).length,
    1,
  );
});

test('keywords are split on commas, Arabic commas and lines, without blanks or repeats', () => {
  assert.deepEqual(parseKeywords(' hi, Hello ,hi\nمرحبا، ,  '), ['hi', 'Hello', 'مرحبا']);
});

test('toDefinition keeps only the stored fields and rounds positions', () => {
  const node = { ...createNode('collect', { x: 10.6, y: -3.2 }, defaults), selected: true, measured: { width: 1 } };
  const definition = toDefinition([node], [{ id: 'e', source: 'a', sourceHandle: null, target: 'b' }]);
  assert.deepEqual(Object.keys(definition.nodes[0]).sort(), ['data', 'id', 'position', 'type']);
  assert.deepEqual(definition.nodes[0].position, { x: 11, y: -3 });
  assert.equal(definition.edges[0].sourceHandle, '');
});

test('variables list the built-ins and every collected answer once', () => {
  const ask = createNode('collect', at, defaults);
  ask.data.variable = 'city';
  assert.deepEqual(availableVariables([ask, createNode('message', at, defaults)]), ['chatId', 'phone', 'city']);
});

test('a new step lands below the steps it would cover, and stays put on an empty canvas', () => {
  assert.deepEqual(freeSpot({ x: 0, y: 0 }, []), { x: 0, y: 0 });
  const spot = freeSpot({ x: 10, y: 10 }, [{ position: { x: 0, y: 0 } }, { position: { x: 0, y: 174 } }]);
  assert.equal(spot.x, 10);
  assert.ok(spot.y >= 174 + 150, `expected below both steps, got ${spot.y}`);
  // A step far to the side does not push it down.
  assert.deepEqual(freeSpot({ x: 0, y: 0 }, [{ position: { x: 600, y: 0 } }]), { x: 0, y: 0 });
});
