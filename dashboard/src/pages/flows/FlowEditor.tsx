import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
  type Node,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertCircle, ArrowLeft, Loader2, Save } from 'lucide-react';
import type { AutomationFlow, FlowDataByType, FlowEdge, FlowNode, FlowNodeType } from '../../types/flows';
import { useTheme } from '../../hooks/useTheme';
import { useToast } from '../../hooks/useToast';
import { useCreateFlowMutation, useUpdateFlowMutation } from '../../hooks/queries';
import { Modal } from '../../components/Modal';
import { FlowStepNode } from './FlowStepNode';
import { STEP_ICONS } from './stepIcons';
import { FlowInspector } from './FlowInspector';
import {
  availableVariables,
  connect,
  createNode,
  freeSpot,
  pruneEdges,
  starterFlow,
  toDefinition,
  type StepDefaults,
} from './flowModel';

const nodeTypes: NodeTypes = {
  trigger: FlowStepNode,
  message: FlowStepNode,
  collect: FlowStepNode,
  handoff: FlowStepNode,
  condition: FlowStepNode,
};

const PALETTE: Exclude<FlowNodeType, 'trigger'>[] = ['message', 'collect', 'condition', 'handoff'];

// React Flow wants open records as node data; the step types stay exact everywhere else.
type CanvasNode = Node<Record<string, unknown>, FlowNodeType>;

const toCanvasNode = (node: FlowNode): CanvasNode =>
  ({
    ...node,
    data: node.data as unknown as Record<string, unknown>,
    deletable: node.type !== 'trigger',
  }) as CanvasNode;

interface FlowEditorProps {
  sessionId: string;
  /** The flow being edited, or null for a new one. */
  flow: AutomationFlow | null;
  canWrite: boolean;
  onClose: () => void;
}

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorCanvas {...props} />
    </ReactFlowProvider>
  );
}

function FlowEditorCanvas({ sessionId, flow, canWrite, onClose }: FlowEditorProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedTheme } = useTheme();
  const { screenToFlowPosition, setCenter, getZoom } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const createMutation = useCreateFlowMutation();
  const updateMutation = useUpdateFlowMutation();

  const defaults: StepDefaults = useMemo(
    () => ({
      message: t('flows.defaults.message'),
      collect: t('flows.defaults.collect'),
      handoff: t('flows.defaults.handoff'),
      // {{phone}} is a flow variable for the gateway to fill, so it is handed through untouched.
      notify: t('flows.defaults.notify', { phone: '{{phone}}' }),
      choice: (n: number) => t('flows.defaults.choice', { n }),
    }),
    [t],
  );

  // Read once: the editor owns the graph from here until it closes.
  const [initial] = useState(() => flow?.definition ?? starterFlow(defaults));
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initial.nodes.map(toCanvasNode));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [name, setName] = useState(flow?.name ?? t('flows.defaults.name'));
  const [enabled, setEnabled] = useState(flow?.enabled ?? true);
  const [timeoutMinutes, setTimeoutMinutes] = useState(flow?.timeoutMinutes ?? 60);
  const [savedId, setSavedId] = useState<string | null>(flow?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const model = nodes as unknown as FlowNode[];
  const snapshot = JSON.stringify({ name, enabled, timeoutMinutes, definition: toDefinition(model, edges) });
  const [savedSnapshot, setSavedSnapshot] = useState(() => (flow ? snapshot : ''));
  const dirty = snapshot !== savedSnapshot;
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const selected = model.find(node => node.id === selectedId);
  const variables = useMemo(() => availableVariables(model), [model]);

  const onConnect = useCallback(
    (link: Connection) => {
      if (!link.sourceHandle) return;
      setEdges(current =>
        connect(model, current as FlowEdge[], {
          source: link.source,
          sourceHandle: link.sourceHandle!,
          target: link.target,
        }),
      );
    },
    [model, setEdges],
  );

  const isValidConnection: IsValidConnection = useCallback(
    link => link.source !== link.target && model.find(node => node.id === link.target)?.type !== 'trigger',
    [model],
  );

  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    setSelectedId(picked.length === 1 ? picked[0].id : null);
  }, []);

  const updateStep = useCallback(
    (id: string, data: FlowDataByType[FlowNodeType]) => {
      const next = nodes.map(node =>
        node.id === id ? { ...node, data: data as unknown as Record<string, unknown> } : node,
      );
      setNodes(next);
      // A removed choice takes its connection with it.
      setEdges(pruneEdges(next as unknown as FlowNode[], edges as FlowEdge[]));
    },
    [nodes, edges, setNodes, setEdges],
  );

  const deleteStep = useCallback(
    (id: string) => {
      const next = nodes.filter(node => node.id !== id);
      setNodes(next);
      setEdges(pruneEdges(next as unknown as FlowNode[], edges as FlowEdge[]));
      setSelectedId(null);
    },
    [nodes, edges, setNodes, setEdges],
  );

  const addStep = (type: Exclude<FlowNodeType, 'trigger'>) => {
    const box = canvasRef.current?.getBoundingClientRect();
    const center = box
      ? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
      : { x: 0, y: 0 };
    const position = freeSpot({ x: Math.round(center.x - 120), y: Math.round(center.y - 60) }, nodes);
    const node = toCanvasNode(createNode(type, position, defaults) as FlowNode);
    setNodes([...nodes.map(n => ({ ...n, selected: false })), { ...node, selected: true }]);
    setSelectedId(node.id);
    // The free spot can be below the visible part of the canvas; bring the new step into view.
    void setCenter(position.x + 120, position.y + 60, { zoom: getZoom(), duration: 250 });
  };

  /** Select a step and centre the canvas on it (a problem in the save banner points at one). */
  const focusStep = (id: string) => {
    const target = nodes.find(node => node.id === id);
    if (!target) return;
    setNodes(nodes.map(node => ({ ...node, selected: node.id === id })));
    setSelectedId(id);
    void setCenter(target.position.x + 120, target.position.y + 60, { zoom: getZoom(), duration: 250 });
  };

  // The gateway names steps by id; the banner names them by type and links to them.
  const describeProblem = (problem: string): { text: string; stepId?: string } => {
    const match = /"([A-Za-z0-9_-]+)"/.exec(problem);
    const step = match ? model.find(node => node.id === match[1]) : undefined;
    if (!match || !step) return { text: problem };
    return { text: problem.replace(match[0], `"${t(`flows.types.${step.type}.title`)}"`), stepId: step.id };
  };

  const save = async () => {
    const payload = { name: name.trim(), enabled, timeoutMinutes, definition: toDefinition(model, edges) };
    const sentSnapshot = snapshot;
    try {
      const saved = savedId
        ? await updateMutation.mutateAsync({ sessionId, id: savedId, data: payload })
        : await createMutation.mutateAsync({ sessionId, data: payload });
      setSavedId(saved.id);
      setSavedSnapshot(sentSnapshot);
      setProblems([]);
      toast.success(t('flows.toasts.saved'));
    } catch (err) {
      const details = (err as { details?: string[] }).details;
      setProblems(details?.length ? details : [err instanceof Error ? err.message : t('common.unknownError')]);
      toast.error(t('flows.toasts.saveFailed'));
    }
  };

  const leave = () => (dirty && canWrite ? setConfirmLeave(true) : onClose());

  return (
    <div className="flow-editor">
      <div className="flow-toolbar">
        <button type="button" className="btn-secondary" onClick={leave}>
          <ArrowLeft size={16} />
          {t('flows.editor.back')}
        </button>
        <div className="form-group flow-name-field">
          <label htmlFor="flow-name">{t('common.name')}</label>
          <input
            id="flow-name"
            dir="auto"
            value={name}
            maxLength={100}
            disabled={!canWrite}
            onChange={event => setName(event.target.value)}
          />
        </div>
        <div className="form-group flow-timeout-field">
          <label htmlFor="flow-timeout">{t('flows.editor.timeout')}</label>
          <input
            id="flow-timeout"
            type="number"
            min={1}
            max={10080}
            value={timeoutMinutes}
            disabled={!canWrite}
            onChange={event => setTimeoutMinutes(Math.round(Number(event.target.value)) || 1)}
          />
        </div>
        <div className="flow-checkbox flow-enabled-field">
          <input
            id="flow-enabled"
            type="checkbox"
            checked={enabled}
            disabled={!canWrite}
            onChange={event => setEnabled(event.target.checked)}
          />
          <label htmlFor="flow-enabled">{t('flows.editor.enabled')}</label>
        </div>
        <div className="flow-toolbar-end">
          {dirty && canWrite && <span className="flow-unsaved">{t('flows.editor.unsaved')}</span>}
          {canWrite && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void save()}
              disabled={isSaving || !name.trim() || !dirty}
            >
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {t('flows.editor.save')}
            </button>
          )}
        </div>
      </div>

      {problems.length > 0 && (
        <div className="flow-problems" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <strong>{t('flows.editor.problemsTitle')}</strong>
            <ul>
              {problems.map(problem => {
                const { text, stepId } = describeProblem(problem);
                return (
                  <li key={problem}>
                    {stepId ? (
                      <button type="button" className="flow-problem-link" onClick={() => focusStep(stepId)}>
                        {text}
                      </button>
                    ) : (
                      text
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <div className="flow-workspace">
        {canWrite && (
          <nav className="flow-palette" aria-label={t('flows.editor.addStep')}>
            <h3>{t('flows.editor.addStep')}</h3>
            {PALETTE.map(type => {
              const Icon = STEP_ICONS[type];
              return (
                <button key={type} type="button" className="flow-palette-item" onClick={() => addStep(type)}>
                  <Icon size={16} aria-hidden="true" />
                  <span>
                    <strong>{t(`flows.types.${type}.title`)}</strong>
                    <small>{t(`flows.types.${type}.description`)}</small>
                  </span>
                </button>
              );
            })}
          </nav>
        )}

        {/* The graph is laid out left to right (outputs on the right of each step) in every language;
            each step's own text still follows its script through dir="auto". */}
        <div className="flow-canvas" ref={canvasRef} dir="ltr">
          <ReactFlow<CanvasNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            isValidConnection={isValidConnection}
            nodesDraggable={canWrite}
            nodesConnectable={canWrite}
            elementsSelectable
            deleteKeyCode={canWrite ? ['Backspace', 'Delete'] : null}
            colorMode={resolvedTheme}
            defaultEdgeOptions={{ type: 'smoothstep' }}
            // Low enough for a large flow to fit the canvas when it opens.
            minZoom={0.15}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <FlowInspector
          node={selected}
          variables={variables}
          canWrite={canWrite}
          onChange={updateStep}
          onDelete={deleteStep}
        />
      </div>

      {confirmLeave && (
        <Modal
          open
          onClose={() => setConfirmLeave(false)}
          title={t('flows.editor.discardTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setConfirmLeave(false)}>
                {t('flows.editor.keepEditing')}
              </button>
              <button type="button" className="btn-danger" onClick={onClose}>
                {t('flows.editor.discard')}
              </button>
            </>
          }
        >
          <p>{t('flows.editor.discardConfirm')}</p>
        </Modal>
      )}
    </div>
  );
}
