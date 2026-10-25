import { GitBranch, Headset, MessageSquare, TextCursorInput, Zap, type LucideIcon } from 'lucide-react';
import type { FlowNodeType } from '../../types/flows';

export const STEP_ICONS: Record<FlowNodeType, LucideIcon> = {
  trigger: Zap,
  message: MessageSquare,
  collect: TextCursorInput,
  handoff: Headset,
  condition: GitBranch,
};
