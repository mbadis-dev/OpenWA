/**
 * The stored shape of an automation flow: a graph of steps the dashboard's flow builder draws and the
 * flow engine walks. Nodes and edges follow the React Flow shape (`id`, `type`, `position`, `data`;
 * `source`, `sourceHandle`, `target`) so the editor can load and save it without a translation layer.
 *
 * A node's outputs are named handles. An edge leaves one handle and enters a node:
 *  - `trigger`: `next`
 *  - `message`: `next` when it has no choices, otherwise one handle per choice, named by the choice id
 *  - `collect`: `next`
 *  - `condition`: `yes` and `no`
 *  - `handoff`: none, it ends the flow
 * A handle with no edge ends the flow there.
 */

export const FLOW_NODE_TYPES = ['trigger', 'message', 'collect', 'handoff', 'condition'] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

export interface FlowPosition {
  x: number;
  y: number;
}

export interface TriggerData {
  /** `any` starts on any message from a chat that is not in a flow; `keywords` only on a matching one. */
  match: 'any' | 'keywords';
  /** Whole words or phrases, matched case-insensitively. A keyword match also restarts a running flow. */
  keywords: string[];
}

export interface FlowChoice {
  /** Handle name and button id. */
  id: string;
  label: string;
  /** Extra words that pick this choice, besides its number and label. */
  keywords: string[];
}

export interface MessageData {
  text: string;
  /** With choices the flow waits for a reply; without, it moves on at once. */
  choices: FlowChoice[];
  /** Send the choices as WhatsApp buttons (Baileys only, at most 3); otherwise as a numbered list. */
  useButtons: boolean;
  /** Sent before the message is repeated when a reply matches no choice. */
  invalidText: string;
}

export interface CollectData {
  text: string;
  /** The reply is saved under this name and can be used as `{{name}}` in later steps. */
  variable: string;
}

export interface HandoffData {
  /** Sent to the customer; may be empty. */
  text: string;
  /** The bot stays silent in this chat for this long. */
  durationMinutes: number;
  /** A chat (phone number, `@c.us` or `@g.us`) told about the handoff; empty for none. */
  notifyChatId: string;
  notifyText: string;
}

export interface ConditionData {
  kind: 'hours' | 'keywords';
  /** `keywords`: matched against the message that reached this step. */
  keywords: string[];
  /** `hours`: an IANA zone such as `Asia/Riyadh`. */
  timezone: string;
  /** `hours`: 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** `hours`: `HH:MM`, 24-hour. An end before the start spans midnight. */
  start: string;
  end: string;
}

interface NodeOf<T extends FlowNodeType, D> {
  id: string;
  type: T;
  position: FlowPosition;
  data: D;
}

export type TriggerNode = NodeOf<'trigger', TriggerData>;
export type MessageNode = NodeOf<'message', MessageData>;
export type CollectNode = NodeOf<'collect', CollectData>;
export type HandoffNode = NodeOf<'handoff', HandoffData>;
export type ConditionNode = NodeOf<'condition', ConditionData>;
export type FlowNode = TriggerNode | MessageNode | CollectNode | HandoffNode | ConditionNode;

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const FLOW_MAX_NODES = 100;
export const FLOW_MAX_EDGES = 300;
export const FLOW_TEXT_MAX_LENGTH = 4096;
export const FLOW_MAX_CHOICES = 10;
export const FLOW_CHOICE_LABEL_MAX_LENGTH = 100;
export const FLOW_MAX_BUTTONS = 3;
export const FLOW_BUTTON_LABEL_MAX_LENGTH = 25;
export const FLOW_BUTTONS_BODY_MAX_LENGTH = 1024;
export const FLOW_MAX_KEYWORDS = 20;
export const FLOW_KEYWORD_MAX_LENGTH = 100;
export const FLOW_HANDOFF_MAX_MINUTES = 10080;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CHAT_ID_PATTERN = /^(\d{5,20}|\d{5,20}@c\.us|[\d-]{5,40}@g\.us)$/;

/** The output handles a node offers, in display order. */
export function outputHandles(node: FlowNode): string[] {
  switch (node.type) {
    case 'trigger':
    case 'collect':
      return ['next'];
    case 'message':
      return node.data.choices.length > 0 ? node.data.choices.map(choice => choice.id) : ['next'];
    case 'condition':
      return ['yes', 'no'];
    case 'handoff':
      return [];
  }
}

/** True when the zone is one the runtime can format dates in. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

class Problems {
  readonly list: string[] = [];
  add(message: string): void {
    // A broken import can produce thousands; the first few are enough to fix it.
    if (this.list.length < 50) this.list.push(message);
  }
}

function checkText(problems: Problems, where: string, value: unknown, required: boolean, max = FLOW_TEXT_MAX_LENGTH) {
  if (!isString(value)) return problems.add(`${where} must be text`);
  if (required && !value.trim()) problems.add(`${where} is required`);
  if (value.length > max) problems.add(`${where} is longer than ${max} characters`);
}

function checkKeywords(problems: Problems, where: string, value: unknown, required: boolean) {
  if (!Array.isArray(value)) return problems.add(`${where} must be a list`);
  if (required && value.length === 0) problems.add(`${where} needs at least one keyword`);
  if (value.length > FLOW_MAX_KEYWORDS) problems.add(`${where} has more than ${FLOW_MAX_KEYWORDS} keywords`);
  for (const keyword of value) {
    if (!isString(keyword) || !keyword.trim()) problems.add(`${where} has an empty keyword`);
    else if (keyword.length > FLOW_KEYWORD_MAX_LENGTH)
      problems.add(`${where} has a keyword longer than ${FLOW_KEYWORD_MAX_LENGTH} characters`);
  }
}

function checkNodeData(problems: Problems, node: { id: string; type: FlowNodeType; data: Record<string, unknown> }) {
  const where = `Step "${node.id}"`;
  const data = node.data;
  switch (node.type) {
    case 'trigger': {
      if (data.match !== 'any' && data.match !== 'keywords')
        problems.add(`${where}: match must be "any" or "keywords"`);
      checkKeywords(problems, `${where} keywords`, data.keywords, data.match === 'keywords');
      return;
    }
    case 'message': {
      checkText(problems, `${where} text`, data.text, true);
      checkText(problems, `${where} invalid-reply text`, data.invalidText, false);
      if (typeof data.useButtons !== 'boolean') problems.add(`${where}: useButtons must be true or false`);
      if (!Array.isArray(data.choices)) return problems.add(`${where} choices must be a list`);
      if (data.choices.length > FLOW_MAX_CHOICES) problems.add(`${where} has more than ${FLOW_MAX_CHOICES} choices`);
      const ids = new Set<string>();
      for (const choice of data.choices as unknown[]) {
        if (!isRecord(choice)) {
          problems.add(`${where} has a malformed choice`);
          continue;
        }
        if (!isString(choice.id) || !ID_PATTERN.test(choice.id)) problems.add(`${where} has a choice with a bad id`);
        else if (ids.has(choice.id) || choice.id === 'next')
          problems.add(`${where} has a duplicate choice id "${choice.id}"`);
        else ids.add(choice.id);
        checkText(problems, `${where} choice label`, choice.label, true, FLOW_CHOICE_LABEL_MAX_LENGTH);
        checkKeywords(problems, `${where} choice keywords`, choice.keywords, false);
        if (data.useButtons === true && isString(choice.label) && choice.label.length > FLOW_BUTTON_LABEL_MAX_LENGTH)
          problems.add(`${where}: button labels can be at most ${FLOW_BUTTON_LABEL_MAX_LENGTH} characters`);
      }
      if (data.useButtons === true && data.choices.length > FLOW_MAX_BUTTONS)
        problems.add(`${where}: buttons allow at most ${FLOW_MAX_BUTTONS} choices`);
      if (data.useButtons === true && data.choices.length === 0)
        problems.add(`${where}: buttons need at least one choice`);
      return;
    }
    case 'collect': {
      checkText(problems, `${where} text`, data.text, true);
      if (!isString(data.variable) || !VARIABLE_PATTERN.test(data.variable))
        problems.add(`${where}: the variable name must start with a letter and use only letters, digits and _`);
      return;
    }
    case 'handoff': {
      checkText(problems, `${where} text`, data.text, false);
      checkText(problems, `${where} notification text`, data.notifyText, false);
      if (
        typeof data.durationMinutes !== 'number' ||
        !Number.isInteger(data.durationMinutes) ||
        data.durationMinutes < 1 ||
        data.durationMinutes > FLOW_HANDOFF_MAX_MINUTES
      )
        problems.add(`${where}: duration must be 1 to ${FLOW_HANDOFF_MAX_MINUTES} minutes`);
      if (!isString(data.notifyChatId)) problems.add(`${where}: notify chat must be text`);
      else if (data.notifyChatId && !CHAT_ID_PATTERN.test(data.notifyChatId))
        problems.add(`${where}: notify chat must be a phone number, <number>@c.us or <id>@g.us`);
      else if (data.notifyChatId && !(isString(data.notifyText) && data.notifyText.trim()))
        problems.add(`${where}: a notify chat needs a notification text`);
      return;
    }
    case 'condition': {
      if (data.kind !== 'hours' && data.kind !== 'keywords')
        problems.add(`${where}: kind must be "hours" or "keywords"`);
      checkKeywords(problems, `${where} keywords`, data.keywords, data.kind === 'keywords');
      if (data.kind !== 'hours') return;
      if (!isString(data.timezone) || !isValidTimeZone(data.timezone))
        problems.add(`${where}: unknown time zone "${String(data.timezone)}"`);
      if (
        !Array.isArray(data.days) ||
        data.days.length === 0 ||
        data.days.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)
      )
        problems.add(`${where}: pick at least one day`);
      if (!isString(data.start) || !TIME_PATTERN.test(data.start)) problems.add(`${where}: start must be HH:MM`);
      if (!isString(data.end) || !TIME_PATTERN.test(data.end)) problems.add(`${where}: end must be HH:MM`);
      return;
    }
  }
}

/**
 * Check a flow definition from an untrusted source (the API, an import). Returns the problems in plain
 * language, empty when the definition is valid. The dashboard shows them as they are.
 */
export function validateFlowDefinition(definition: unknown): string[] {
  const problems = new Problems();
  if (!isRecord(definition) || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
    return ['The flow must have a nodes list and an edges list'];
  }
  if (definition.nodes.length > FLOW_MAX_NODES) problems.add(`A flow can have at most ${FLOW_MAX_NODES} steps`);
  if (definition.edges.length > FLOW_MAX_EDGES) problems.add(`A flow can have at most ${FLOW_MAX_EDGES} connections`);

  const nodes = new Map<string, FlowNode>();
  let triggers = 0;
  for (const raw of definition.nodes as unknown[]) {
    if (!isRecord(raw) || !isString(raw.id) || !ID_PATTERN.test(raw.id)) {
      problems.add('A step has a missing or malformed id');
      continue;
    }
    if (nodes.has(raw.id)) {
      problems.add(`Two steps share the id "${raw.id}"`);
      continue;
    }
    if (!FLOW_NODE_TYPES.includes(raw.type as FlowNodeType)) {
      problems.add(`Step "${raw.id}" has an unknown type "${String(raw.type)}"`);
      continue;
    }
    const position = raw.position;
    if (!isRecord(position) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      problems.add(`Step "${raw.id}" has no position`);
    }
    if (!isRecord(raw.data)) {
      problems.add(`Step "${raw.id}" has no settings`);
      continue;
    }
    const type = raw.type as FlowNodeType;
    if (type === 'trigger') triggers += 1;
    checkNodeData(problems, { id: raw.id, type, data: raw.data });
    nodes.set(raw.id, raw as unknown as FlowNode);
  }
  if (triggers !== 1) problems.add('A flow needs exactly one start step');

  const usedHandles = new Set<string>();
  const edgeIds = new Set<string>();
  for (const raw of definition.edges as unknown[]) {
    if (!isRecord(raw) || !isString(raw.id) || !ID_PATTERN.test(raw.id)) {
      problems.add('A connection has a missing or malformed id');
      continue;
    }
    if (edgeIds.has(raw.id)) problems.add(`Two connections share the id "${raw.id}"`);
    edgeIds.add(raw.id);
    const source = isString(raw.source) ? nodes.get(raw.source) : undefined;
    const target = isString(raw.target) ? nodes.get(raw.target) : undefined;
    if (!source || !target) {
      problems.add(`Connection "${raw.id}" points at a step that does not exist`);
      continue;
    }
    if (target.type === 'trigger') problems.add(`Connection "${raw.id}" leads into the start step`);
    if (!isString(raw.sourceHandle) || !outputHandles(source).includes(raw.sourceHandle)) {
      problems.add(`Connection "${raw.id}" leaves step "${source.id}" from an output it does not have`);
      continue;
    }
    const handleKey = `${source.id}\u0000${raw.sourceHandle}`;
    if (usedHandles.has(handleKey))
      problems.add(`Step "${source.id}" output "${raw.sourceHandle}" is connected more than once`);
    usedHandles.add(handleKey);
  }
  return problems.list;
}

/** The trigger node of a valid definition. */
export function triggerOf(definition: FlowDefinition): TriggerNode | undefined {
  return definition.nodes.find((node): node is TriggerNode => node.type === 'trigger');
}
