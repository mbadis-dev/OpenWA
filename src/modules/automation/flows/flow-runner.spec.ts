import type { FlowDefinition, FlowNode } from './flow-definition';
import {
  FLOW_MAX_INVALID_REPLIES,
  continueFlow,
  fillVariables,
  matchesKeywords,
  normalizeReply,
  startFlow,
  withinHours,
} from './flow-runner';

const CHAT = '628111@c.us';
const NOW = new Date('2026-10-25T10:00:00Z'); // Sunday, 13:00 in Riyadh

const at = (x = 0, y = 0) => ({ x, y });

function menuFlow(extra: { nodes?: FlowNode[]; edges?: FlowDefinition['edges'] } = {}): FlowDefinition {
  return {
    nodes: [
      { id: 'start', type: 'trigger', position: at(), data: { match: 'any', keywords: [] } },
      {
        id: 'menu',
        type: 'message',
        position: at(),
        data: {
          text: 'How can we help?',
          useButtons: true,
          invalidText: 'Please pick an option.',
          choices: [
            { id: 'hours', label: 'Opening hours', keywords: ['time'] },
            { id: 'ask', label: 'Ask a question', keywords: [] },
          ],
        },
      },
      {
        id: 'hoursMsg',
        type: 'message',
        position: at(),
        data: { text: 'Open 12 to 6.', useButtons: false, invalidText: '', choices: [] },
      },
      { id: 'askName', type: 'collect', position: at(), data: { text: 'Your question?', variable: 'question' } },
      {
        id: 'thanks',
        type: 'message',
        position: at(),
        data: { text: 'Got it: {{question}} (from {{phone}})', useButtons: false, invalidText: '', choices: [] },
      },
      ...(extra.nodes ?? []),
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'menu' },
      { id: 'e2', source: 'menu', sourceHandle: 'hours', target: 'hoursMsg' },
      { id: 'e3', source: 'menu', sourceHandle: 'ask', target: 'askName' },
      { id: 'e4', source: 'askName', sourceHandle: 'next', target: 'thanks' },
      ...(extra.edges ?? []),
    ],
  };
}

const ctx = (text: string, extra: { buttonId?: string; now?: Date } = {}) => ({
  chatId: CHAT,
  text,
  now: NOW,
  ...extra,
});
const waitingAt = (nodeId: string) => ({ nodeId, variables: {}, invalidCount: 0, lastInvalidAt: null });

describe('flow runner', () => {
  it('starts at the trigger and stops at the first question, sent as buttons with a numbered list', () => {
    const result = startFlow(menuFlow(), ctx('hello'));

    expect(result.progress.nodeId).toBe('menu');
    expect(result.actions).toEqual([
      {
        kind: 'buttons',
        chatId: CHAT,
        body: 'How can we help?\n\n1. Opening hours\n2. Ask a question',
        buttons: [
          { id: 'hours', text: 'Opening hours' },
          { id: 'ask', text: 'Ask a question' },
        ],
      },
    ]);
  });

  it('sends the choices as text when buttons are off', () => {
    const flow = menuFlow();
    (flow.nodes[1] as Extract<FlowNode, { type: 'message' }>).data.useButtons = false;

    const result = startFlow(flow, ctx('hello'));

    expect(result.actions).toEqual([
      { kind: 'text', chatId: CHAT, text: 'How can we help?\n\n1. Opening hours\n2. Ask a question' },
    ]);
  });

  it.each([
    ['its number', ctx('1')],
    ['an Arabic-Indic digit', ctx('١')],
    ['a keycap emoji', ctx('1️⃣')],
    ['its label, in any case', ctx('opening HOURS')],
    ['one of its keywords', ctx('what time do you open?')],
    ['a tapped button', ctx('anything', { buttonId: 'hours' })],
  ])('picks a choice by %s and ends after a message with no choices', (_how, reply) => {
    const result = continueFlow(menuFlow(), waitingAt('menu'), reply);

    expect(result.actions).toEqual([{ kind: 'text', chatId: CHAT, text: 'Open 12 to 6.' }]);
    expect(result.progress.nodeId).toBeNull();
  });

  it('repeats the question after an unrecognised reply, then goes quiet', () => {
    let progress = waitingAt('menu') as ReturnType<typeof waitingAt> & {
      invalidCount: number;
      lastInvalidAt: number | null;
    };
    for (let attempt = 1; attempt <= FLOW_MAX_INVALID_REPLIES; attempt += 1) {
      const result = continueFlow(menuFlow(), progress, ctx('banana'));
      expect(result.actions.map(action => action.kind)).toEqual(['text', 'buttons']);
      expect(result.actions[0]).toEqual({ kind: 'text', chatId: CHAT, text: 'Please pick an option.' });
      expect(result.progress.nodeId).toBe('menu');
      progress = result.progress as typeof progress;
    }

    const quiet = continueFlow(menuFlow(), progress, ctx('banana'));

    expect(quiet.actions).toEqual([]);
    expect(quiet.progress.nodeId).toBe('menu');
  });

  it('answers unrecognised replies again once the window has passed', () => {
    const progress = { nodeId: 'menu', variables: {}, invalidCount: 5, lastInvalidAt: NOW.getTime() - 2 * 3600_000 };

    const result = continueFlow(menuFlow(), progress, ctx('banana'));

    expect(result.actions).toHaveLength(2);
    expect(result.progress.invalidCount).toBe(1);
  });

  it('collects a free-text answer and fills it into later steps', () => {
    const asked = continueFlow(menuFlow(), waitingAt('menu'), ctx('2'));
    expect(asked.actions).toEqual([{ kind: 'text', chatId: CHAT, text: 'Your question?' }]);
    expect(asked.progress.nodeId).toBe('askName');

    const answered = continueFlow(menuFlow(), asked.progress, ctx('  Do you ship to Jeddah?  '));

    expect(answered.progress.variables).toEqual({ question: 'Do you ship to Jeddah?' });
    expect(answered.actions).toEqual([
      { kind: 'text', chatId: CHAT, text: 'Got it: Do you ship to Jeddah? (from 628111)' },
    ]);
  });

  it('hands off: tells the customer, notifies the team and reports the silence period', () => {
    const flow = menuFlow({
      nodes: [
        {
          id: 'human',
          type: 'handoff',
          position: at(),
          data: {
            text: 'Someone will reply.',
            durationMinutes: 90,
            notifyChatId: '628999',
            notifyText: 'Chat {{chatId}} needs you',
          },
        },
      ],
      edges: [{ id: 'e5', source: 'thanks', sourceHandle: 'next', target: 'human' }],
    });

    const result = continueFlow(flow, { ...waitingAt('askName') }, ctx('Hi'));

    expect(result.handoffMinutes).toBe(90);
    expect(result.progress.nodeId).toBeNull();
    expect(result.actions.slice(1)).toEqual([
      { kind: 'text', chatId: CHAT, text: 'Someone will reply.' },
      { kind: 'text', chatId: '628999@c.us', text: `Chat ${CHAT} needs you` },
    ]);
  });

  it('branches on opening hours in the configured time zone', () => {
    const flow: FlowDefinition = {
      nodes: [
        { id: 'start', type: 'trigger', position: at(), data: { match: 'any', keywords: [] } },
        {
          id: 'open',
          type: 'condition',
          position: at(),
          data: {
            kind: 'hours',
            keywords: [],
            timezone: 'Asia/Riyadh',
            days: [0, 1, 2, 3, 4],
            start: '12:00',
            end: '18:00',
          },
        },
        {
          id: 'yes',
          type: 'message',
          position: at(),
          data: { text: 'open', useButtons: false, invalidText: '', choices: [] },
        },
        {
          id: 'no',
          type: 'message',
          position: at(),
          data: { text: 'closed', useButtons: false, invalidText: '', choices: [] },
        },
      ],
      edges: [
        { id: 'a', source: 'start', sourceHandle: 'next', target: 'open' },
        { id: 'b', source: 'open', sourceHandle: 'yes', target: 'yes' },
        { id: 'c', source: 'open', sourceHandle: 'no', target: 'no' },
      ],
    };

    expect(startFlow(flow, ctx('hi')).actions).toEqual([{ kind: 'text', chatId: CHAT, text: 'open' }]);
    // Friday 13:00 in Riyadh: not a working day.
    const friday = new Date('2026-10-30T10:00:00Z');
    expect(startFlow(flow, ctx('hi', { now: friday })).actions).toEqual([
      { kind: 'text', chatId: CHAT, text: 'closed' },
    ]);
  });

  it('stops a loop that never waits instead of spinning', () => {
    const flow: FlowDefinition = {
      nodes: [
        { id: 'start', type: 'trigger', position: at(), data: { match: 'any', keywords: [] } },
        {
          id: 'a',
          type: 'message',
          position: at(),
          data: { text: 'again', useButtons: false, invalidText: '', choices: [] },
        },
      ],
      edges: [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' },
        { id: 'e2', source: 'a', sourceHandle: 'next', target: 'a' },
      ],
    };

    const result = startFlow(flow, ctx('hi'));

    expect(result.actions.length).toBeLessThan(30);
    expect(result.progress.nodeId).toBeNull();
  });

  it('ends quietly when the step the chat waited at was removed', () => {
    const result = continueFlow(menuFlow(), waitingAt('gone'), ctx('1'));

    expect(result).toEqual({
      actions: [],
      progress: { nodeId: null, variables: {}, invalidCount: 0, lastInvalidAt: null },
      handoffMinutes: null,
    });
  });
});

describe('flow runner helpers', () => {
  it('normalizes replies for comparison', () => {
    expect(normalizeReply('  ٢️⃣!  ')).toBe('2');
    expect(normalizeReply('Hello,   World?')).toBe('hello, world');
  });

  it('matches keywords as whole words or phrases only', () => {
    expect(matchesKeywords('Hi there!', ['hi'])).toBe(true);
    expect(matchesKeywords('this is fine', ['hi'])).toBe(false);
    expect(matchesKeywords('السلام عليكم ورحمة الله', ['السلام عليكم'])).toBe(true);
    expect(matchesKeywords('anything', [])).toBe(false);
  });

  it('fills variables and built-ins, blanking unknown names', () => {
    expect(fillVariables('{{ name }} / {{phone}} / {{nope}}', { name: 'Ali' }, '628111@c.us')).toBe('Ali / 628111 / ');
  });

  it('handles opening hours that span midnight', () => {
    const night = {
      kind: 'hours' as const,
      keywords: [],
      timezone: 'UTC',
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '22:00',
      end: '02:00',
    };
    expect(withinHours(night, new Date('2026-10-25T23:30:00Z'))).toBe(true);
    expect(withinHours(night, new Date('2026-10-25T01:30:00Z'))).toBe(true);
    expect(withinHours(night, new Date('2026-10-25T12:00:00Z'))).toBe(false);
  });
});
