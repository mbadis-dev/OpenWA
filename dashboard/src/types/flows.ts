// The flow graph as the gateway stores it (src/modules/automation/flows/flow-definition.ts). Nodes and
// edges are in the React Flow shape, so the editor loads and saves them as they are.

export type FlowNodeType = 'trigger' | 'message' | 'collect' | 'handoff' | 'condition';

export interface TriggerData {
  match: 'any' | 'keywords';
  keywords: string[];
}

export interface FlowChoice {
  id: string;
  label: string;
  keywords: string[];
}

export interface MessageData {
  text: string;
  choices: FlowChoice[];
  useButtons: boolean;
  invalidText: string;
}

export interface CollectData {
  text: string;
  variable: string;
}

export interface HandoffData {
  text: string;
  durationMinutes: number;
  notifyChatId: string;
  notifyText: string;
}

export interface ConditionData {
  kind: 'hours' | 'keywords';
  keywords: string[];
  timezone: string;
  days: number[];
  start: string;
  end: string;
}

export interface FlowDataByType {
  trigger: TriggerData;
  message: MessageData;
  collect: CollectData;
  handoff: HandoffData;
  condition: ConditionData;
}

export type FlowNodeOf<T extends FlowNodeType> = {
  id: string;
  type: T;
  position: { x: number; y: number };
  data: FlowDataByType[T];
};

export type FlowNode = { [T in FlowNodeType]: FlowNodeOf<T> }[FlowNodeType];

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

export interface AutomationFlow {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  definition: FlowDefinition;
  timeoutMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationFlowPayload {
  name: string;
  definition: FlowDefinition;
  enabled: boolean;
  timeoutMinutes: number;
}

// Limits the gateway enforces, mirrored so the editor can warn before a save is refused.
export const FLOW_MAX_BUTTONS = 3;
export const FLOW_BUTTON_LABEL_MAX_LENGTH = 25;
export const FLOW_MAX_CHOICES = 10;
