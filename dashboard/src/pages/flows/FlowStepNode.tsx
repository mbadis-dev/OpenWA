import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowDataByType, FlowNodeType } from '../../types/flows';
import { outputHandles } from './flowModel';
import { STEP_ICONS } from './stepIcons';

type AnyStepData = FlowDataByType[FlowNodeType];

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim()) ?? '';
}

/** One step on the canvas: its type, a one-line summary and a labelled connector per output. */
function FlowStepNodeView({ type, data, selected }: NodeProps & { type: string; data: AnyStepData }) {
  const { t } = useTranslation();
  const stepType = type as FlowNodeType;
  const Icon = STEP_ICONS[stepType];
  const step = { type: stepType, data } as Parameters<typeof outputHandles>[0];

  let summary = '';
  switch (stepType) {
    case 'trigger': {
      const trigger = data as FlowDataByType['trigger'];
      summary =
        trigger.match === 'any'
          ? t('flows.summary.anyMessage')
          : t('flows.summary.keywords', { keywords: trigger.keywords.join(', ') });
      break;
    }
    case 'message':
    case 'collect':
    case 'handoff':
      summary = firstLine((data as { text: string }).text);
      break;
    case 'condition': {
      const condition = data as FlowDataByType['condition'];
      summary =
        condition.kind === 'hours'
          ? t('flows.summary.hours', { start: condition.start, end: condition.end })
          : t('flows.summary.keywords', { keywords: condition.keywords.join(', ') });
      break;
    }
  }

  const outputLabel = (handle: string): string => {
    if (stepType === 'message' && handle !== 'next') {
      const choices = (data as FlowDataByType['message']).choices;
      const index = choices.findIndex(choice => choice.id === handle);
      return `${index + 1}. ${choices[index]?.label ?? ''}`;
    }
    return t(`flows.outputs.${handle}`);
  };

  return (
    <div className={`flow-node flow-node-${stepType}${selected ? ' selected' : ''}`}>
      {stepType !== 'trigger' && <Handle type="target" position={Position.Top} className="flow-handle-in" />}
      <div className="flow-node-header">
        <Icon size={14} aria-hidden="true" />
        <span>{t(`flows.types.${stepType}.title`)}</span>
      </div>
      <div className="flow-node-summary" dir="auto">
        {summary || t('flows.summary.empty')}
      </div>
      {stepType === 'handoff' ? (
        <div className="flow-node-end">{t('flows.summary.ends')}</div>
      ) : (
        <ul className="flow-node-outputs">
          {outputHandles(step).map(handle => (
            <li key={handle} dir="auto">
              <span>{outputLabel(handle)}</span>
              <Handle type="source" id={handle} position={Position.Right} className="flow-handle-out" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const FlowStepNode = memo(FlowStepNodeView);
