import { validateFlowDefinition } from './flow-definition';

const at = { x: 0, y: 0 };

function valid() {
  return {
    nodes: [
      { id: 'start', type: 'trigger', position: at, data: { match: 'any', keywords: [] } },
      {
        id: 'menu',
        type: 'message',
        position: at,
        data: {
          text: 'Pick one',
          useButtons: true,
          invalidText: '',
          choices: [
            { id: 'a', label: 'First', keywords: [] },
            { id: 'b', label: 'Second', keywords: ['two'] },
          ],
        },
      },
      { id: 'ask', type: 'collect', position: at, data: { text: 'Name?', variable: 'name' } },
      {
        id: 'human',
        type: 'handoff',
        position: at,
        data: { text: '', durationMinutes: 30, notifyChatId: '628999@c.us', notifyText: 'New chat' },
      },
      {
        id: 'open',
        type: 'condition',
        position: at,
        data: { kind: 'hours', keywords: [], timezone: 'Asia/Riyadh', days: [0, 1], start: '09:00', end: '17:00' },
      },
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'open' },
      { id: 'e2', source: 'open', sourceHandle: 'yes', target: 'menu' },
      { id: 'e3', source: 'open', sourceHandle: 'no', target: 'human' },
      { id: 'e4', source: 'menu', sourceHandle: 'a', target: 'ask' },
      { id: 'e5', source: 'menu', sourceHandle: 'b', target: 'human' },
      { id: 'e6', source: 'ask', sourceHandle: 'next', target: 'menu' },
    ],
  };
}

type Def = ReturnType<typeof valid>;
const node = (def: Def, id: string) => def.nodes.find(n => n.id === id)! as { data: Record<string, unknown> };

describe('validateFlowDefinition', () => {
  it('accepts a flow using every step type, loops included', () => {
    expect(validateFlowDefinition(valid())).toEqual([]);
  });

  it.each([
    ['not an object', null, 'nodes list'],
    ['no start step', { nodes: [], edges: [] }, 'exactly one start step'],
  ])('refuses %s', (_case, definition, problem) => {
    expect(validateFlowDefinition(definition).join('\n')).toContain(problem);
  });

  it.each<[string, (def: Def) => void, string]>([
    ['two start steps', d => d.nodes.push({ ...d.nodes[0], id: 'start2' }), 'exactly one start step'],
    ['an unknown step type', d => d.nodes.push({ ...d.nodes[0], id: 'x', type: 'teleport' }), 'unknown type'],
    ['duplicate step ids', d => d.nodes.push({ ...d.nodes[2] }), 'share the id'],
    ['a connection to nowhere', d => (d.edges[0].target = 'missing'), 'does not exist'],
    ['a connection from an output the step lacks', d => (d.edges[3].sourceHandle = 'zzz'), 'does not have'],
    ['an output connected twice', d => d.edges.push({ ...d.edges[3], id: 'dup' }), 'more than once'],
    ['a connection into the start step', d => (d.edges[5].target = 'start'), 'into the start step'],
    [
      'more than three buttons',
      d => {
        const data = node(d, 'menu').data as { choices: unknown[] };
        data.choices.push({ id: 'c', label: 'Third', keywords: [] }, { id: 'd', label: 'Fourth', keywords: [] });
      },
      'at most 3 choices',
    ],
    [
      'a button label over 25 characters',
      d => {
        (node(d, 'menu').data as { choices: { label: string }[] }).choices[0].label = 'x'.repeat(26);
      },
      'at most 25 characters',
    ],
    ['an empty message', d => (node(d, 'menu').data.text = '  '), 'text is required'],
    ['a bad variable name', d => (node(d, 'ask').data.variable = '1st name'), 'variable name'],
    ['a zero-minute handoff', d => (node(d, 'human').data.durationMinutes = 0), 'duration'],
    ['a notify chat without a message', d => (node(d, 'human').data.notifyText = ''), 'notification text'],
    ['a malformed notify chat', d => (node(d, 'human').data.notifyChatId = 'boss'), 'phone number'],
    ['an unknown time zone', d => (node(d, 'open').data.timezone = 'Mars/Olympus'), 'unknown time zone'],
    ['no days', d => (node(d, 'open').data.days = []), 'at least one day'],
    ['a bad time', d => (node(d, 'open').data.start = '9am'), 'HH:MM'],
    ['a keyword trigger without keywords', d => (node(d, 'start').data.match = 'keywords'), 'at least one keyword'],
  ])('refuses %s', (_case, breakIt, problem) => {
    const def = valid();
    breakIt(def);
    expect(validateFlowDefinition(def).join('\n')).toContain(problem);
  });

  it('caps the problem list', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, type: 'nope', position: at, data: {} }));
    expect(validateFlowDefinition({ nodes, edges: [] }).length).toBeLessThanOrEqual(50);
  });
});
