// Flow CRUD is scoped to the URL :sessionId and refuses invalid graphs; the inbound path carries the
// conversation contract: start on a trigger, answer the step a chat waits at, stay silent during a
// handoff, rate-limit (re)starts, and never let a failure escape into the receive path. Runs against a
// real in-memory DB so the persisted progress is exercised end to end.
import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { AutomationFlowsService, FLOW_RESTART_COOLDOWN_MS, FLOW_START_COOLDOWN_MS } from './automation-flows.service';
import { AutomationFlow } from './entities/automation-flow.entity';
import { AutomationFlowState } from './entities/automation-flow-state.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import type { FlowDefinition } from './flows/flow-definition';

const CHAT = '628111@c.us';
const at = { x: 0, y: 0 };

function menuFlow(trigger: { match: 'any' | 'keywords'; keywords: string[] } = { match: 'any', keywords: [] }) {
  return {
    nodes: [
      { id: 'start', type: 'trigger', position: at, data: trigger },
      {
        id: 'menu',
        type: 'message',
        position: at,
        data: {
          text: 'Menu',
          useButtons: true,
          invalidText: '',
          choices: [
            { id: 'info', label: 'Info', keywords: [] },
            { id: 'human', label: 'Human', keywords: [] },
          ],
        },
      },
      {
        id: 'info',
        type: 'message',
        position: at,
        data: { text: 'Info text', useButtons: false, invalidText: '', choices: [] },
      },
      {
        id: 'human',
        type: 'handoff',
        position: at,
        data: { text: 'A person will reply', durationMinutes: 30, notifyChatId: '', notifyText: '' },
      },
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'menu' },
      { id: 'e2', source: 'menu', sourceHandle: 'info', target: 'info' },
      { id: 'e3', source: 'menu', sourceHandle: 'human', target: 'human' },
    ],
  } as FlowDefinition;
}

type Sent = { kind: 'text' | 'buttons'; chatId: string; text: string };

describe('AutomationFlowsService', () => {
  let ds: DataSource;
  let service: AutomationFlowsService;
  let sent: Sent[];
  let buttonsRefused: boolean;
  let clock: number;

  const moduleRefStub = {
    get: () => ({
      sendText: (_sessionId: string, dto: { chatId: string; text: string }) => {
        sent.push({ kind: 'text', chatId: dto.chatId, text: dto.text });
        return Promise.resolve({});
      },
      sendButtons: (_sessionId: string, dto: { chatId: string; body: string }) => {
        if (buttonsRefused) return Promise.reject(new Error('501 not supported'));
        sent.push({ kind: 'buttons', chatId: dto.chatId, text: dto.body });
        return Promise.resolve({});
      },
    }),
  } as unknown as ModuleRef;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, AutomationFlow, AutomationFlowState],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    for (const id of ['sessA', 'sessB']) {
      await sessions.save(sessions.create({ id, name: id, status: SessionStatus.READY, config: {} }));
    }
    sent = [];
    buttonsRefused = false;
    clock = new Date('2026-10-25T10:00:00Z').getTime();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    service = new AutomationFlowsService(
      ds.getRepository(AutomationFlow),
      ds.getRepository(AutomationFlowState),
      ds.getRepository(Session),
      moduleRefStub,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  const inbound = (body: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    chatId: CHAT,
    body,
    fromMe: false,
    kind: 'individual',
    timestamp: Math.floor(clock / 1000),
    ...over,
  });

  const later = (ms: number) => {
    clock += ms;
  };

  describe('CRUD', () => {
    it('refuses an invalid graph with the list of problems', async () => {
      const error: unknown = await service
        .create('sessA', { name: 'bad', definition: { nodes: [], edges: [] } })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((error as BadRequestException).getResponse())).toContain('exactly one start step');
    });

    it('404s for a missing session and keeps flows inside their own session', async () => {
      await expect(service.create('nope', { name: 'x', definition: menuFlow() })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const flow = await service.create('sessA', { name: 'Menu', definition: menuFlow() });

      await expect(service.findOne('sessB', flow.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.update('sessB', flow.id, { enabled: false })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.remove('sessB', flow.id)).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.findAll('sessA')).map(f => f.name)).toEqual(['Menu']);
    });

    it('stores the definition as sent and validates it again on update', async () => {
      const flow = await service.create('sessA', { name: 'Menu', definition: menuFlow(), timeoutMinutes: 15 });
      expect((await service.findOne('sessA', flow.id)).definition).toEqual(menuFlow());
      expect(flow.timeoutMinutes).toBe(15);

      await expect(service.update('sessA', flow.id, { definition: { nodes: [], edges: [] } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('inbound', () => {
    it('does nothing and reports unhandled when the session has no flows', async () => {
      expect(await service.handleInbound('sessA', inbound('hi'))).toBe(false);
      expect(sent).toEqual([]);
    });

    it('starts the flow, then answers the step the chat waits at', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });

      expect(await service.handleInbound('sessA', inbound('hi'))).toBe(true);
      expect(sent).toEqual([{ kind: 'buttons', chatId: CHAT, text: 'Menu\n\n1. Info\n2. Human' }]);

      expect(await service.handleInbound('sessA', inbound('1'))).toBe(true);
      expect(sent[1]).toEqual({ kind: 'text', chatId: CHAT, text: 'Info text' });
    });

    it('sends the prompt as text when the engine refuses buttons', async () => {
      buttonsRefused = true;
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });

      await service.handleInbound('sessA', inbound('hi'));

      expect(sent).toEqual([{ kind: 'text', chatId: CHAT, text: 'Menu\n\n1. Info\n2. Human' }]);
    });

    it('stays silent, and handled, during a handoff, then starts over once it ends', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });
      await service.handleInbound('sessA', inbound('hi'));
      await service.handleInbound('sessA', inbound('2'));
      expect(sent.at(-1)).toEqual({ kind: 'text', chatId: CHAT, text: 'A person will reply' });

      later(10 * 60_000);
      expect(await service.handleInbound('sessA', inbound('hello?'))).toBe(true);
      expect(sent).toHaveLength(2);

      later(25 * 60_000);
      expect(await service.handleInbound('sessA', inbound('hello?'))).toBe(true);
      expect(sent).toHaveLength(3);
      expect(sent.at(-1)?.kind).toBe('buttons');
    });

    it('resetChat ends a handoff at once', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });
      await service.handleInbound('sessA', inbound('hi'));
      await service.handleInbound('sessA', inbound('2'));
      later(FLOW_START_COOLDOWN_MS);

      await service.resetChat('sessA', CHAT);
      await service.handleInbound('sessA', inbound('back'));

      expect(sent.at(-1)?.kind).toBe('buttons');
    });

    it('does not start again in a chat within the start cooldown', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });
      await service.handleInbound('sessA', inbound('hi'));
      await service.handleInbound('sessA', inbound('1')); // flow ends

      later(FLOW_START_COOLDOWN_MS - 1000);
      expect(await service.handleInbound('sessA', inbound('thanks'))).toBe(true);
      expect(sent).toHaveLength(2);

      later(2000);
      await service.handleInbound('sessA', inbound('thanks'));
      expect(sent).toHaveLength(3);
    });

    it('starts over after the flow timeout instead of answering the old question', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow(), timeoutMinutes: 10 });
      await service.handleInbound('sessA', inbound('hi'));

      later(11 * 60_000);
      await service.handleInbound('sessA', inbound('1'));

      expect(sent.map(s => s.kind)).toEqual(['buttons', 'buttons']);
    });

    it('restarts a running flow on a trigger keyword, at most once per restart cooldown', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow({ match: 'keywords', keywords: ['menu'] }) });
      await service.handleInbound('sessA', inbound('menu'));
      later(FLOW_START_COOLDOWN_MS);

      // Within the restart cooldown the keyword is just an unrecognised reply to the waiting step.
      await service.handleInbound('sessA', inbound('menu'));
      expect(sent).toHaveLength(2);
      expect(sent[1].kind).toBe('buttons');

      later(FLOW_RESTART_COOLDOWN_MS);
      await service.handleInbound('sessA', inbound('menu'));
      expect(sent).toHaveLength(3);
    });

    it('leaves non-matching messages to the rules when the trigger needs keywords', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow({ match: 'keywords', keywords: ['menu'] }) });

      expect(await service.handleInbound('sessA', inbound('hello'))).toBe(false);
      expect(sent).toEqual([]);
    });

    it.each([
      ['its own messages', { fromMe: true }],
      ['a group', { kind: 'group', chatId: '1203630@g.us' }],
      ['a stale message', { timestamp: Math.floor(new Date('2026-10-25T09:00:00Z').getTime() / 1000) }],
    ])('ignores %s', async (_case, over) => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });

      expect(await service.handleInbound('sessA', inbound('hi', over))).toBe(false);
      expect(sent).toEqual([]);
    });

    it('skips a disabled flow', async () => {
      const flow = await service.create('sessA', { name: 'Menu', definition: menuFlow() });
      await service.update('sessA', flow.id, { enabled: false });

      expect(await service.handleInbound('sessA', inbound('hi'))).toBe(false);
    });

    it('never rejects, and reports unhandled, when storage fails', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });
      jest.spyOn(ds.getRepository(AutomationFlowState), 'findOne').mockRejectedValue(new Error('db down'));
      const broken = new AutomationFlowsService(
        ds.getRepository(AutomationFlow),
        ds.getRepository(AutomationFlowState),
        ds.getRepository(Session),
        moduleRefStub,
      );

      await expect(broken.handleInbound('sessA', inbound('hi'))).resolves.toBe(false);
    });

    it('handles one chat’s messages in order, so two quick replies cannot both answer one question', async () => {
      await service.create('sessA', { name: 'Menu', definition: menuFlow() });
      await service.handleInbound('sessA', inbound('hi'));

      await Promise.all([service.handleInbound('sessA', inbound('1')), service.handleInbound('sessA', inbound('1'))]);

      // The first "1" ends the flow; the second arrives inside the start cooldown and is held back.
      expect(sent.filter(s => s.text === 'Info text')).toHaveLength(1);
    });
  });
});
