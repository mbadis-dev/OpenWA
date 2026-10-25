import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import {
  FLOW_BUTTON_LABEL_MAX_LENGTH,
  FLOW_MAX_BUTTONS,
  FLOW_MAX_CHOICES,
  type FlowDataByType,
  type FlowNode,
  type FlowNodeType,
} from '../../types/flows';
import { newId, parseKeywords } from './flowModel';
import { STEP_ICONS } from './stepIcons';

interface FlowInspectorProps {
  node: FlowNode | undefined;
  variables: string[];
  canWrite: boolean;
  onChange: (id: string, data: FlowDataByType[FlowNodeType]) => void;
  onDelete: (id: string) => void;
}

/** A comma-separated keyword field that keeps what is typed (a trailing comma) while storing a clean list. */
function KeywordsInput({
  id,
  value,
  disabled,
  onChange,
  placeholder,
  ariaLabel,
}: {
  id: string;
  value: string[];
  disabled: boolean;
  onChange: (keywords: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value.join(', '));
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      dir="auto"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={event => {
        setDraft(event.target.value);
        onChange(parseKeywords(event.target.value));
      }}
    />
  );
}

/** Weekday names in the operator's language, Sunday first (0 = Sunday, as the gateway counts). */
function useWeekdays(language: string): string[] {
  return useMemo(() => {
    const sunday = new Date(Date.UTC(2026, 9, 25, 12));
    const format = new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, day) => format.format(new Date(sunday.getTime() + day * 86_400_000)));
  }, [language]);
}

export function FlowInspector({ node, variables, canWrite, onChange, onDelete }: FlowInspectorProps) {
  const { t, i18n } = useTranslation();
  const weekdays = useWeekdays(i18n.language);

  if (!node) {
    return (
      <aside className="flow-inspector flow-inspector-empty" aria-label={t('flows.inspector.title')}>
        <p>{t('flows.inspector.nothingSelected')}</p>
        <p className="flow-muted">{t('flows.inspector.howTo')}</p>
      </aside>
    );
  }

  const Icon = STEP_ICONS[node.type];
  const disabled = !canWrite;
  const field = (name: string) => `flow-${node.id}-${name}`;
  const variableHint = (
    <p className="flow-hint">
      {t('flows.inspector.variablesHint')}{' '}
      {variables.map(name => (
        <code key={name}>{`{{${name}}}`}</code>
      ))}
    </p>
  );

  const set = <T extends FlowNodeType>(patch: Partial<FlowDataByType[T]>) =>
    onChange(node.id, { ...node.data, ...patch } as FlowDataByType[T]);

  return (
    <aside className="flow-inspector" aria-label={t('flows.inspector.title')}>
      <div className="flow-inspector-header">
        <Icon size={16} aria-hidden="true" />
        <div>
          <h3>{t(`flows.types.${node.type}.title`)}</h3>
          <p>{t(`flows.types.${node.type}.description`)}</p>
        </div>
      </div>

      <div className="flow-inspector-body" key={node.id}>
        {node.type === 'trigger' && (
          <>
            <div className="form-group">
              <label htmlFor={field('match')}>{t('flows.inspector.startWhen')}</label>
              <select
                id={field('match')}
                className="flow-select"
                value={node.data.match}
                disabled={disabled}
                onChange={event => set<'trigger'>({ match: event.target.value as 'any' | 'keywords' })}
              >
                <option value="any">{t('flows.inspector.matchAny')}</option>
                <option value="keywords">{t('flows.inspector.matchKeywords')}</option>
              </select>
            </div>
            {node.data.match === 'keywords' && (
              <div className="form-group">
                <label htmlFor={field('keywords')}>{t('flows.inspector.keywords')}</label>
                <KeywordsInput
                  id={field('keywords')}
                  value={node.data.keywords}
                  disabled={disabled}
                  placeholder={t('flows.inspector.keywordsPlaceholder')}
                  onChange={keywords => set<'trigger'>({ keywords })}
                />
                <p className="flow-hint">{t('flows.inspector.triggerKeywordsHint')}</p>
              </div>
            )}
          </>
        )}

        {node.type === 'message' && (
          <>
            <div className="form-group">
              <label htmlFor={field('text')}>{t('flows.inspector.messageText')}</label>
              <textarea
                id={field('text')}
                rows={5}
                dir="auto"
                value={node.data.text}
                disabled={disabled}
                onChange={event => set<'message'>({ text: event.target.value })}
              />
              {variableHint}
            </div>

            <fieldset className="flow-fieldset">
              <legend>{t('flows.inspector.choices')}</legend>
              <p className="flow-hint">{t('flows.inspector.choicesHint')}</p>
              {node.data.choices.map((choice, index) => (
                <div className="flow-choice" key={choice.id}>
                  <span className="flow-choice-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="flow-choice-fields">
                    <input
                      aria-label={t('flows.inspector.choiceLabel', { n: index + 1 })}
                      dir="auto"
                      value={choice.label}
                      disabled={disabled}
                      maxLength={100}
                      onChange={event =>
                        set<'message'>({
                          choices: node.data.choices.map(c =>
                            c.id === choice.id ? { ...c, label: event.target.value } : c,
                          ),
                        })
                      }
                    />
                    <KeywordsInput
                      id={field(`choice-${choice.id}`)}
                      value={choice.keywords}
                      disabled={disabled}
                      placeholder={t('flows.inspector.choiceKeywordsPlaceholder')}
                      ariaLabel={t('flows.inspector.choiceKeywords', { n: index + 1 })}
                      onChange={keywords =>
                        set<'message'>({
                          choices: node.data.choices.map(c => (c.id === choice.id ? { ...c, keywords } : c)),
                        })
                      }
                    />
                    {node.data.useButtons && choice.label.length > FLOW_BUTTON_LABEL_MAX_LENGTH && (
                      <p className="flow-warning">
                        {t('flows.inspector.buttonLabelTooLong', { max: FLOW_BUTTON_LABEL_MAX_LENGTH })}
                      </p>
                    )}
                  </div>
                  {canWrite && (
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={t('flows.inspector.removeChoice', { n: index + 1 })}
                      title={t('flows.inspector.removeChoice', { n: index + 1 })}
                      onClick={() => set<'message'>({ choices: node.data.choices.filter(c => c.id !== choice.id) })}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {canWrite && (
                <button
                  type="button"
                  className="btn-secondary flow-add-choice"
                  disabled={node.data.choices.length >= FLOW_MAX_CHOICES}
                  onClick={() =>
                    set<'message'>({
                      choices: [
                        ...node.data.choices,
                        {
                          id: newId('c'),
                          label: t('flows.defaults.choice', { n: node.data.choices.length + 1 }),
                          keywords: [],
                        },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  {t('flows.inspector.addChoice')}
                </button>
              )}
            </fieldset>

            {node.data.choices.length > 0 && (
              <>
                <div className="flow-checkbox">
                  <input
                    id={field('buttons')}
                    type="checkbox"
                    checked={node.data.useButtons}
                    disabled={disabled}
                    onChange={event => set<'message'>({ useButtons: event.target.checked })}
                  />
                  <label htmlFor={field('buttons')}>{t('flows.inspector.useButtons')}</label>
                </div>
                <p className="flow-hint">{t('flows.inspector.useButtonsHint', { max: FLOW_MAX_BUTTONS })}</p>
                {node.data.useButtons && node.data.choices.length > FLOW_MAX_BUTTONS && (
                  <p className="flow-warning">{t('flows.inspector.tooManyButtons', { max: FLOW_MAX_BUTTONS })}</p>
                )}
                <div className="form-group">
                  <label htmlFor={field('invalid')}>{t('flows.inspector.invalidText')}</label>
                  <input
                    id={field('invalid')}
                    dir="auto"
                    value={node.data.invalidText}
                    disabled={disabled}
                    placeholder={t('flows.inspector.invalidTextPlaceholder')}
                    onChange={event => set<'message'>({ invalidText: event.target.value })}
                  />
                </div>
              </>
            )}
          </>
        )}

        {node.type === 'collect' && (
          <>
            <div className="form-group">
              <label htmlFor={field('text')}>{t('flows.inspector.question')}</label>
              <textarea
                id={field('text')}
                rows={4}
                dir="auto"
                value={node.data.text}
                disabled={disabled}
                onChange={event => set<'collect'>({ text: event.target.value })}
              />
              {variableHint}
            </div>
            <div className="form-group">
              <label htmlFor={field('variable')}>{t('flows.inspector.variable')}</label>
              <input
                id={field('variable')}
                dir="ltr"
                value={node.data.variable}
                disabled={disabled}
                maxLength={32}
                onChange={event => set<'collect'>({ variable: event.target.value.replace(/[^A-Za-z0-9_]/g, '') })}
              />
              <p className="flow-hint">
                {t('flows.inspector.variableHint', { name: `{{${node.data.variable || 'answer'}}}` })}
              </p>
            </div>
          </>
        )}

        {node.type === 'condition' && (
          <>
            <div className="form-group">
              <label htmlFor={field('kind')}>{t('flows.inspector.checkWhat')}</label>
              <select
                id={field('kind')}
                className="flow-select"
                value={node.data.kind}
                disabled={disabled}
                onChange={event => set<'condition'>({ kind: event.target.value as 'hours' | 'keywords' })}
              >
                <option value="hours">{t('flows.inspector.kindHours')}</option>
                <option value="keywords">{t('flows.inspector.kindKeywords')}</option>
              </select>
            </div>
            {node.data.kind === 'keywords' ? (
              <div className="form-group">
                <label htmlFor={field('keywords')}>{t('flows.inspector.keywords')}</label>
                <KeywordsInput
                  id={field('keywords')}
                  value={node.data.keywords}
                  disabled={disabled}
                  placeholder={t('flows.inspector.keywordsPlaceholder')}
                  onChange={keywords => set<'condition'>({ keywords })}
                />
                <p className="flow-hint">{t('flows.inspector.conditionKeywordsHint')}</p>
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor={field('tz')}>{t('flows.inspector.timezone')}</label>
                  <input
                    id={field('tz')}
                    dir="ltr"
                    value={node.data.timezone}
                    disabled={disabled}
                    placeholder="Asia/Riyadh"
                    onChange={event => set<'condition'>({ timezone: event.target.value.trim() })}
                  />
                </div>
                <fieldset className="flow-fieldset">
                  <legend>{t('flows.inspector.days')}</legend>
                  <div className="flow-days">
                    {weekdays.map((name, day) => (
                      <div className="flow-checkbox" key={day}>
                        <input
                          id={field(`day-${day}`)}
                          type="checkbox"
                          checked={node.data.days.includes(day)}
                          disabled={disabled}
                          onChange={event =>
                            set<'condition'>({
                              days: event.target.checked
                                ? [...node.data.days, day].sort((a, b) => a - b)
                                : node.data.days.filter(d => d !== day),
                            })
                          }
                        />
                        <label htmlFor={field(`day-${day}`)}>{name}</label>
                      </div>
                    ))}
                  </div>
                </fieldset>
                <div className="flow-time-row">
                  <div className="form-group">
                    <label htmlFor={field('start')}>{t('flows.inspector.opens')}</label>
                    <input
                      id={field('start')}
                      type="time"
                      value={node.data.start}
                      disabled={disabled}
                      onChange={event => set<'condition'>({ start: event.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={field('end')}>{t('flows.inspector.closes')}</label>
                    <input
                      id={field('end')}
                      type="time"
                      value={node.data.end}
                      disabled={disabled}
                      onChange={event => set<'condition'>({ end: event.target.value })}
                    />
                  </div>
                </div>
                <p className="flow-hint">{t('flows.inspector.hoursHint')}</p>
              </>
            )}
          </>
        )}

        {node.type === 'handoff' && (
          <>
            <div className="form-group">
              <label htmlFor={field('text')}>{t('flows.inspector.handoffText')}</label>
              <textarea
                id={field('text')}
                rows={3}
                dir="auto"
                value={node.data.text}
                disabled={disabled}
                onChange={event => set<'handoff'>({ text: event.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor={field('minutes')}>{t('flows.inspector.silentFor')}</label>
              <input
                id={field('minutes')}
                type="number"
                min={1}
                max={10080}
                value={node.data.durationMinutes}
                disabled={disabled}
                onChange={event => set<'handoff'>({ durationMinutes: Math.round(Number(event.target.value)) || 1 })}
              />
              <p className="flow-hint">{t('flows.inspector.silentForHint')}</p>
            </div>
            <div className="form-group">
              <label htmlFor={field('notify')}>{t('flows.inspector.notifyChat')}</label>
              <input
                id={field('notify')}
                dir="ltr"
                value={node.data.notifyChatId}
                disabled={disabled}
                placeholder="966500000000"
                onChange={event => set<'handoff'>({ notifyChatId: event.target.value.trim() })}
              />
              <p className="flow-hint">{t('flows.inspector.notifyChatHint')}</p>
            </div>
            {node.data.notifyChatId && (
              <div className="form-group">
                <label htmlFor={field('notifyText')}>{t('flows.inspector.notifyText')}</label>
                <textarea
                  id={field('notifyText')}
                  rows={3}
                  dir="auto"
                  value={node.data.notifyText}
                  disabled={disabled}
                  onChange={event => set<'handoff'>({ notifyText: event.target.value })}
                />
                {variableHint}
              </div>
            )}
          </>
        )}
      </div>

      {canWrite && node.type !== 'trigger' && (
        <div className="flow-inspector-footer">
          <button type="button" className="btn-danger" onClick={() => onDelete(node.id)}>
            <Trash2 size={16} />
            {t('flows.inspector.deleteStep')}
          </button>
        </div>
      )}
    </aside>
  );
}
