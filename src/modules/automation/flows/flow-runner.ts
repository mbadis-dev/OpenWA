import {
  FLOW_BUTTONS_BODY_MAX_LENGTH,
  FLOW_MAX_BUTTONS,
  type ConditionData,
  type FlowDefinition,
  type FlowNode,
  type MessageNode,
  triggerOf,
} from './flow-definition';

/**
 * The flow engine's pure core: given a flow, where a chat is in it and the message that just arrived,
 * it returns what to send and where the chat is now. It does no I/O, so the service around it owns
 * persistence, locking and the actual sends.
 */

/** Where one chat is in a flow. `nodeId` is the step waiting for a reply, or null once the flow ended. */
export interface FlowProgress {
  nodeId: string | null;
  variables: Record<string, string>;
  /** Unrecognised replies in the current window, and when the last one came. */
  invalidCount: number;
  lastInvalidAt: number | null;
}

export type FlowAction =
  | { kind: 'text'; chatId: string; text: string }
  | { kind: 'buttons'; chatId: string; body: string; buttons: { id: string; text: string }[] };

export interface FlowStepResult {
  actions: FlowAction[];
  progress: FlowProgress;
  /** Set when the flow handed the chat to a person: the bot stays silent this many minutes. */
  handoffMinutes: number | null;
}

export interface FlowContext {
  chatId: string;
  /** The message body, `''` for media without a caption. */
  text: string;
  /** The id of the tapped button, when the message is a button reply. */
  buttonId?: string;
  now: Date;
}

/** A step that loops straight back to itself (or a cycle of steps that never waits) stops here. */
export const FLOW_MAX_STEPS_PER_MESSAGE = 25;
/** Replies to unrecognised input at most this often per window, so another bot cannot keep the flow talking. */
export const FLOW_MAX_INVALID_REPLIES = 2;
export const FLOW_INVALID_WINDOW_MS = 60 * 60 * 1000;
/** Collected answers are cut to this length before they are stored. */
export const FLOW_VARIABLE_MAX_LENGTH = 1024;

const KEYCAP = /[️⃣]/g;
const ARABIC_DIGIT = /[٠-٩]/g;
const PERSIAN_DIGIT = /[۰-۹]/g;
const EDGE_PUNCTUATION = /^[\s!.,،؟?:;'"()-]+|[\s!.,،؟?:;'"()-]+$/gu;

/** Lower-case, Western digits, no keycap marks or edge punctuation: what a reply is compared as. */
export function normalizeReply(text: string): string {
  return text
    .replace(ARABIC_DIGIT, d => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGIT, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(KEYCAP, '')
    .toLowerCase()
    .replace(EDGE_PUNCTUATION, '')
    .replace(/\s+/g, ' ');
}

/** True when the text contains one of the keywords as a whole word or phrase. */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  const padded = ` ${normalizeReply(text)
    .replace(/[!.,،؟?:;'"()]/gu, ' ')
    .replace(/\s+/g, ' ')} `;
  return keywords.some(keyword => {
    const word = normalizeReply(keyword);
    return word !== '' && padded.includes(` ${word} `);
  });
}

/** Replace `{{name}}` with a collected answer or a built-in (`chatId`, `phone`); unknown names become ''. */
export function fillVariables(text: string, variables: Record<string, string>, chatId: string): string {
  const builtIns: Record<string, string> = {
    chatId,
    phone: chatId.endsWith('@c.us') ? chatId.slice(0, -'@c.us'.length) : '',
  };
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) =>
    Object.hasOwn(variables, name) ? variables[name] : (builtIns[name] ?? ''),
  );
}

/** A bare phone number becomes `<number>@c.us`; anything else is used as given. */
export function toChatId(target: string): string {
  return /^\d+$/.test(target) ? `${target}@c.us` : target;
}

function localTime(now: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  return { day, minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Opening-hours check. The day is the local day of `now`; an end before the start spans midnight. */
export function withinHours(data: ConditionData, now: Date): boolean {
  const { day, minutes } = localTime(now, data.timezone);
  if (!data.days.includes(day)) return false;
  const start = toMinutes(data.start);
  const end = toMinutes(data.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

class Walk {
  readonly actions: FlowAction[] = [];
  handoffMinutes: number | null = null;
  private readonly nodes: Map<string, FlowNode>;
  private readonly edges: Map<string, string>;

  constructor(
    definition: FlowDefinition,
    private readonly ctx: FlowContext,
    readonly variables: Record<string, string>,
  ) {
    this.nodes = new Map(definition.nodes.map(node => [node.id, node]));
    this.edges = new Map(definition.edges.map(edge => [`${edge.source}\u0000${edge.sourceHandle}`, edge.target]));
  }

  node(id: string | null): FlowNode | undefined {
    return id === null ? undefined : this.nodes.get(id);
  }

  next(nodeId: string, handle: string): string | null {
    return this.edges.get(`${nodeId}\u0000${handle}`) ?? null;
  }

  fill(text: string): string {
    return fillVariables(text, this.variables, this.ctx.chatId);
  }

  say(text: string, chatId = this.ctx.chatId): void {
    if (text.trim()) this.actions.push({ kind: 'text', chatId, text });
  }

  /** Send a message step: its text, with its choices as a numbered list and, when asked, as buttons. */
  prompt(node: MessageNode): void {
    const { choices, useButtons } = node.data;
    const list = choices.map((choice, index) => `${index + 1}. ${choice.label}`).join('\n');
    const body = list ? `${this.fill(node.data.text)}\n\n${list}` : this.fill(node.data.text);
    if (
      useButtons &&
      choices.length > 0 &&
      choices.length <= FLOW_MAX_BUTTONS &&
      body.length <= FLOW_BUTTONS_BODY_MAX_LENGTH
    ) {
      this.actions.push({
        kind: 'buttons',
        chatId: this.ctx.chatId,
        body,
        buttons: choices.map(choice => ({ id: choice.id, text: choice.label })),
      });
    } else {
      this.say(body);
    }
  }

  /**
   * Run from `nodeId` until a step waits for a reply or the flow ends. Returns the waiting step's id,
   * or null when the flow ended.
   */
  run(nodeId: string | null): string | null {
    let current = nodeId;
    for (let steps = 0; current !== null && steps < FLOW_MAX_STEPS_PER_MESSAGE; steps += 1) {
      const node = this.nodes.get(current);
      if (!node) return null;
      switch (node.type) {
        case 'trigger':
          current = this.next(node.id, 'next');
          break;
        case 'message':
          this.prompt(node);
          if (node.data.choices.length > 0) return node.id;
          current = this.next(node.id, 'next');
          break;
        case 'collect':
          this.say(this.fill(node.data.text));
          return node.id;
        case 'condition': {
          const yes =
            node.data.kind === 'hours'
              ? withinHours(node.data, this.ctx.now)
              : matchesKeywords(this.ctx.text, node.data.keywords);
          current = this.next(node.id, yes ? 'yes' : 'no');
          break;
        }
        case 'handoff':
          this.say(this.fill(node.data.text));
          if (node.data.notifyChatId) this.say(this.fill(node.data.notifyText), toChatId(node.data.notifyChatId));
          this.handoffMinutes = node.data.durationMinutes;
          return null;
      }
    }
    return null;
  }
}

function choiceFor(node: MessageNode, ctx: FlowContext) {
  const { choices } = node.data;
  if (ctx.buttonId) {
    const tapped = choices.find(choice => choice.id === ctx.buttonId);
    if (tapped) return tapped;
  }
  const reply = normalizeReply(ctx.text);
  if (!reply) return undefined;
  const byNumber = /^\d+$/.test(reply) ? choices[Number(reply) - 1] : undefined;
  return (
    byNumber ??
    choices.find(choice => normalizeReply(choice.label) === reply) ??
    choices.find(choice => matchesKeywords(ctx.text, choice.keywords))
  );
}

/** Start a flow at its trigger. */
export function startFlow(definition: FlowDefinition, ctx: FlowContext): FlowStepResult {
  const walk = new Walk(definition, ctx, {});
  const nodeId = walk.run(triggerOf(definition)?.id ?? null);
  return {
    actions: walk.actions,
    progress: { nodeId, variables: walk.variables, invalidCount: 0, lastInvalidAt: null },
    handoffMinutes: walk.handoffMinutes,
  };
}

/** Feed a reply to the step the chat is waiting at. */
export function continueFlow(definition: FlowDefinition, progress: FlowProgress, ctx: FlowContext): FlowStepResult {
  const walk = new Walk(definition, ctx, { ...progress.variables });
  const node = walk.node(progress.nodeId);
  const done = (nodeId: string | null): FlowStepResult => ({
    actions: walk.actions,
    progress: { nodeId, variables: walk.variables, invalidCount: 0, lastInvalidAt: null },
    handoffMinutes: walk.handoffMinutes,
  });

  if (node?.type === 'collect') {
    walk.variables[node.data.variable] = ctx.text.trim().slice(0, FLOW_VARIABLE_MAX_LENGTH);
    return done(walk.run(walk.next(node.id, 'next')));
  }
  if (node?.type !== 'message' || node.data.choices.length === 0) {
    // The step was removed or changed since the chat reached it: the flow ends here.
    return done(null);
  }

  const choice = choiceFor(node, ctx);
  if (choice) return done(walk.run(walk.next(node.id, choice.id)));

  // No choice matched: repeat the question, but only a few times per window.
  const now = ctx.now.getTime();
  const recent = progress.lastInvalidAt !== null && now - progress.lastInvalidAt < FLOW_INVALID_WINDOW_MS;
  const invalidCount = (recent ? progress.invalidCount : 0) + 1;
  if (invalidCount <= FLOW_MAX_INVALID_REPLIES) {
    walk.say(walk.fill(node.data.invalidText));
    walk.prompt(node);
  }
  return {
    actions: walk.actions,
    progress: { nodeId: node.id, variables: walk.variables, invalidCount, lastInvalidAt: now },
    handoffMinutes: null,
  };
}
