import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Pencil, Plus, Trash2, Workflow } from 'lucide-react';
import type { AutomationFlow } from '../types/flows';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { useDeleteFlowMutation, useFlowsQuery, useSessionsQuery, useUpdateFlowMutation } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { FlowEditor } from './flows/FlowEditor';
import './Flows.css';

/** The editor's target: an existing flow, a new one (`null`), or none while the list shows. */
type Editing = { flow: AutomationFlow | null } | undefined;

export function Flows() {
  const { t } = useTranslation();
  useDocumentTitle(t('flows.title'));
  const { canWrite } = useRole();
  const toast = useToast();
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  const sessionsFailed = !!sessionsError && sessions.length === 0;
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [editing, setEditing] = useState<Editing>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<AutomationFlow | null>(null);

  // The flow routes are OPERATOR-only, so a key that cannot write is not sent them (see Templates).
  const {
    data: flows = [],
    isLoading: loadingFlows,
    error: flowsError,
  } = useFlowsQuery(selectedSessionId, canWrite && !!selectedSessionId);
  const updateMutation = useUpdateFlowMutation();
  const deleteMutation = useDeleteFlowMutation();

  // Select the first session, and again once the selected one is gone (the same reasoning as Templates).
  useEffect(() => {
    if (sessions.some(session => session.id === selectedSessionId)) return;
    const next = sessions[0]?.id ?? '';
    if (next !== selectedSessionId) {
      setSelectedSessionId(next);
      setEditing(undefined);
    }
  }, [selectedSessionId, sessions]);

  const toggleEnabled = async (flow: AutomationFlow) => {
    try {
      await updateMutation.mutateAsync({ sessionId: selectedSessionId, id: flow.id, data: { enabled: !flow.enabled } });
    } catch (err) {
      toast.error(t('flows.toasts.saveFailed'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: selectedSessionId, id: deleteTarget.id });
      toast.success(t('flows.toasts.deleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(t('flows.toasts.deleteFailed'), err instanceof Error ? err.message : undefined);
    }
  };

  if (loadingSessions) {
    return (
      <div className="flows-page flows-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  if (editing && selectedSessionId) {
    return (
      <div className="flows-page flows-page-editing">
        <FlowEditor
          key={editing.flow?.id ?? 'new'}
          sessionId={selectedSessionId}
          flow={editing.flow}
          canWrite={canWrite}
          onClose={() => setEditing(undefined)}
        />
      </div>
    );
  }

  const forbidden = !canWrite || (flowsError as { status?: number } | null)?.status === 403;

  return (
    <div className="flows-page">
      <PageHeader
        title={t('flows.title')}
        subtitle={t('flows.subtitle')}
        actions={
          <>
            <select
              className="flows-session-select"
              aria-label={t('flows.sessionSelect')}
              value={selectedSessionId}
              onChange={event => setSelectedSessionId(event.target.value)}
            >
              {sessions.length === 0 && (
                <option value="">{t(sessionsFailed ? 'dashboard.loadError' : 'flows.noSessions')}</option>
              )}
              {sessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.name}
                </option>
              ))}
            </select>
            {canWrite && sessions.length > 0 && (
              <button type="button" className="btn-primary" onClick={() => setEditing({ flow: null })}>
                <Plus size={16} />
                {t('flows.newFlow')}
              </button>
            )}
          </>
        }
      />

      {sessionsFailed ? (
        <div className="flows-empty" role="alert">
          <AlertCircle size={48} strokeWidth={1} />
          <h3>{t('dashboard.loadError')}</h3>
          <p>{sessionsError.message}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="flows-empty">
          <Workflow size={48} strokeWidth={1} />
          <h3>{t('flows.empty.noSessionsTitle')}</h3>
          <p>{t('flows.empty.noSessionsDesc')}</p>
        </div>
      ) : loadingFlows || !selectedSessionId ? (
        <div className="flows-empty">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : (flowsError || !canWrite) && flows.length === 0 ? (
        <div className="flows-empty" role="alert">
          <AlertCircle size={40} strokeWidth={1} />
          <h3>{t(forbidden ? 'flows.empty.forbiddenTitle' : 'flows.empty.loadErrorTitle')}</h3>
          <p>{forbidden ? t('flows.empty.forbiddenDesc') : flowsError?.message}</p>
        </div>
      ) : flows.length === 0 ? (
        <div className="flows-empty">
          <Workflow size={48} strokeWidth={1} />
          <h3>{t('flows.empty.title')}</h3>
          <p>{t('flows.empty.description')}</p>
          <button type="button" className="btn-primary" onClick={() => setEditing({ flow: null })}>
            <Plus size={16} />
            {t('flows.newFlow')}
          </button>
        </div>
      ) : (
        <>
          <p className="flows-intro">{t('flows.intro')}</p>
          <ul className="flows-list">
            {flows.map(flow => (
              <li key={flow.id} className="flows-card">
                <div className="flows-card-main">
                  <h3 dir="auto">{flow.name}</h3>
                  <p>
                    {t('flows.stepCount', { count: flow.definition.nodes.length })}
                    {' · '}
                    {t('flows.timeoutShort', { minutes: flow.timeoutMinutes })}
                  </p>
                </div>
                <div className="flow-checkbox">
                  <input
                    id={`flow-enabled-${flow.id}`}
                    type="checkbox"
                    checked={flow.enabled}
                    disabled={!canWrite || updateMutation.isPending}
                    onChange={() => void toggleEnabled(flow)}
                  />
                  <label htmlFor={`flow-enabled-${flow.id}`}>{t('flows.editor.enabled')}</label>
                </div>
                <div className="flows-card-actions">
                  <button type="button" className="btn-secondary" onClick={() => setEditing({ flow })}>
                    <Pencil size={14} />
                    {t('flows.edit')}
                  </button>
                  {canWrite && (
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={t('flows.deleteFlow', { name: flow.name })}
                      title={t('common.delete')}
                      onClick={() => setDeleteTarget(flow)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {deleteTarget && (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={t('flows.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn-danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('flows.deleteConfirm', { name: deleteTarget.name })}</p>
        </Modal>
      )}
    </div>
  );
}
