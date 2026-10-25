// The flow editor's pure model: building steps, wiring outputs and keeping the graph consistent as
// steps change. No React here, so the rules are tested without rendering a canvas.
import type { FlowDataByType, FlowDefinition, FlowEdge, FlowNode, FlowNodeOf, FlowNodeType } from '../../types/flows';

/** A short random id in the gateway's id alphabet (letters, digits, `_`, `-`). */
export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** The output handles a step offers, in display order (mirrors the gateway's outputHandles). */
export function outputHandles(node: Pick<FlowNode, 'type' | 'data'>): string[] {
  switch (node.type) {
    case 'trigger':
    case 'collect':
      return ['next'];
    case 'message': {
      const { choices } = node.data as FlowDataByType['message'];
      return choices.length > 0 ? choices.map(choice => choice.id) : ['next'];
    }
    case 'condition':
      return ['yes', 'no'];
    case 'handoff':
      return [];
  }
}

/** Text the new steps start with, in the operator's language. */
export interface StepDefaults {
  message: string;
  collect: string;
  handoff: string;
  notify: string;
  choice: (n: number) => string;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultData<T extends FlowNodeType>(type: T, defaults: StepDefaults): FlowDataByType[T] {
  const byType: FlowDataByType = {
    trigger: { match: 'any', keywords: [] },
    message: { text: defaults.message, choices: [], useButtons: false, invalidText: '' },
    collect: { text: defaults.collect, variable: 'answer' },
    handoff: { text: defaults.handoff, durationMinutes: 60, notifyChatId: '', notifyText: defaults.notify },
    condition: {
      kind: 'hours',
      keywords: [],
      timezone: browserTimeZone(),
      days: [0, 1, 2, 3, 4],
      start: '09:00',
      end: '17:00',
    },
  };
  return byType[type];
}

export function createNode<T extends FlowNodeType>(
  type: T,
  position: { x: number; y: number },
  defaults: StepDefaults,
): FlowNodeOf<T> {
  return { id: newId(type), type, position, data: defaultData(type, defaults) } as FlowNodeOf<T>;
}

/** A new flow: a start step that sends one menu message with two choices. */
export function starterFlow(defaults: StepDefaults): FlowDefinition {
  const trigger = createNode('trigger', { x: 0, y: 0 }, defaults);
  const menu = createNode('message', { x: 0, y: 140 }, defaults);
  menu.data.choices = [
    { id: newId('c'), label: defaults.choice(1), keywords: [] },
    { id: newId('c'), label: defaults.choice(2), keywords: [] },
  ];
  return {
    nodes: [trigger, menu],
    edges: [{ id: newId('e'), source: trigger.id, sourceHandle: 'next', target: menu.id }],
  };
}

/**
 * Drop connections that no longer fit the steps: a removed step at either end, an output the step no
 * longer has (a deleted choice), a connection into the start step, and a second connection from one output.
 */
export function pruneEdges(nodes: Pick<FlowNode, 'id' | 'type' | 'data'>[], edges: FlowEdge[]): FlowEdge[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const used = new Set<string>();
  const kept: FlowEdge[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || target.type === 'trigger') continue;
    if (!outputHandles(source).includes(edge.sourceHandle)) continue;
    const key = `${edge.source}\u0000${edge.sourceHandle}`;
    if (used.has(key)) continue;
    used.add(key);
    kept.push(edge);
  }
  return kept;
}

/**
 * Connect an output to a step, replacing whatever that output led to before. Refuses (returns the edges
 * unchanged) a connection into the start step or from a step to itself.
 */
export function connect(
  nodes: Pick<FlowNode, 'id' | 'type' | 'data'>[],
  edges: FlowEdge[],
  link: { source: string; sourceHandle: string; target: string },
): FlowEdge[] {
  if (link.source === link.target) return edges;
  const target = nodes.find(node => node.id === link.target);
  if (!target || target.type === 'trigger') return edges;
  const others = edges.filter(edge => !(edge.source === link.source && edge.sourceHandle === link.sourceHandle));
  return pruneEdges(nodes, [...others, { id: newId('e'), ...link }]);
}

/** Comma- or line-separated keywords as a clean list: trimmed, no blanks, no repeats. */
export function parseKeywords(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n،]/)) {
    const word = raw.trim();
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
  }
  return out;
}

/** Only the stored fields, without what the canvas adds to nodes (selection, measured size, dragging). */
export function toDefinition(
  nodes: Array<Pick<FlowNode, 'id' | 'type' | 'position' | 'data'>>,
  edges: Array<Pick<FlowEdge, 'id' | 'source' | 'target'> & { sourceHandle?: string | null }>,
): FlowDefinition {
  return {
    nodes: nodes.map(node => ({
      id: node.id,
      type: node.type,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      data: node.data,
    })) as FlowNode[],
    edges: edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? '',
      target: edge.target,
    })),
  };
}

/** Variables a step can use: the built-ins and every collect step's variable. */
export function availableVariables(nodes: Array<Pick<FlowNode, 'type' | 'data'>>): string[] {
  const collected = nodes
    .filter(node => node.type === 'collect')
    .map(node => (node.data as FlowDataByType['collect']).variable)
    .filter(Boolean);
  return Array.from(new Set(['chatId', 'phone', ...collected]));
}

const STEP_WIDTH = 240;
const STEP_HEIGHT = 150;
const STEP_GAP = 24;

/**
 * The first spot at or below `start` that no step covers, so a step added from the palette does not land
 * on top of another one. Gives up after a screenful of tries and uses the last spot.
 */
export function freeSpot(
  start: { x: number; y: number },
  nodes: Array<{ position: { x: number; y: number } }>,
): { x: number; y: number } {
  let spot = start;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const covered = nodes.some(
      node =>
        Math.abs(node.position.x - spot.x) < STEP_WIDTH + STEP_GAP && Math.abs(node.position.y - spot.y) < STEP_HEIGHT,
    );
    if (!covered) return spot;
    spot = { x: spot.x, y: spot.y + STEP_HEIGHT + STEP_GAP };
  }
  return spot;
}
