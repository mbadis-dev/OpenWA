import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { chatKind } from '../../engine/identity/wa-id';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { Session } from '../session/entities/session.entity';
import { AutomationFlow } from './entities/automation-flow.entity';
import { AutomationFlowState } from './entities/automation-flow-state.entity';
import { CreateAutomationFlowDto, UpdateAutomationFlowDto } from './dto/automation-flow.dto';
import { triggerOf, validateFlowDefinition } from './flows/flow-definition';
import { type FlowAction, type FlowStepResult, continueFlow, matchesKeywords, startFlow } from './flows/flow-runner';

/** Same freshness gate as the automation rules: a reconnect's backlog gets no automated answers. */
const MAX_MESSAGE_AGE_SECONDS = 300;

/**
 * A flow does not start again in a chat within this window after it last started, so two bots that
 * answer everything cannot greet each other forever.
 */
export const FLOW_START_COOLDOWN_MS = 60 * 1000;

/** A trigger keyword restarts a running flow at most this often, for the same reason. */
export const FLOW_RESTART_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The send surface the flow engine needs. PLUGIN_MESSAGE_PORT is bound to MessageService itself
 * (`useExisting` in MessageModule), which also has sendButtons; the plugin-facing port type does not
 * list it, so it is optional here and a missing one falls back to text.
 */
type FlowMessagePort = PluginMessagePort & {
  sendButtons?: (
    sessionId: string,
    dto: { chatId: string; body: string; buttons: { id: string; text: string }[] },
  ) => Promise<unknown>;
};

/**
 * Multi-step autoreply flows drawn in the dashboard's flow builder.
 *
 * Evaluated before the automation rules on every inbound message from a one-to-one chat. A chat that
 * is inside a flow, or handed to a person, is "handled" and gets no rule reply. Where each chat is
 * lives in automation_flow_states so a restart does not drop it. Messages of one chat are processed
 * one at a time (per-process lock), so two quick replies cannot both answer the same question.
 *
 * Replies go through the ordinary send path, resolved lazily for the same module-cycle reason as in
 * AutomationRulesService.
 */
@Injectable()
export class AutomationFlowsService {
  private readonly logger = createLogger('AutomationFlowsService');
  private readonly chatLocks = new Map<string, Promise<unknown>>();
  private messagePort?: FlowMessagePort;

  constructor(
    @InjectRepository(AutomationFlow, 'data')
    private readonly flowRepository: Repository<AutomationFlow>,
    @InjectRepository(AutomationFlowState, 'data')
    private readonly stateRepository: Repository<AutomationFlowState>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async create(sessionId: string, dto: CreateAutomationFlowDto): Promise<AutomationFlow> {
    if (!(await this.sessionRepository.exists({ where: { id: sessionId } }))) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
    this.assertValidDefinition(dto.definition);
    // Shares the rules' per-session cap: every flow is checked on every inbound message.
    const maxPerSession = this.configService?.get<number>('automation.maxPerSession', 32) ?? 32;
    if (maxPerSession > 0) {
      const existing = await this.flowRepository.count({ where: { sessionId } });
      if (existing >= maxPerSession) {
        throw new BadRequestException(
          `Automation flow limit reached for this session (${existing}/${maxPerSession}); delete one before adding another`,
        );
      }
    }
    const flow = this.flowRepository.create({
      sessionId,
      name: dto.name,
      definition: dto.definition,
      timeoutMinutes: dto.timeoutMinutes ?? 60,
      enabled: dto.enabled ?? true,
    });
    // No transaction of its own, for the same SQLite reason as AutomationRulesService.create.
    return this.flowRepository.save(flow, { transaction: false });
  }

  async findAll(sessionId: string): Promise<AutomationFlow[]> {
    return this.flowRepository.find({ where: { sessionId }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async findOne(sessionId: string, id: string): Promise<AutomationFlow> {
    const flow = await this.flowRepository.findOne({ where: { id, sessionId } });
    if (!flow) throw new NotFoundException(`Automation flow ${id} not found`);
    return flow;
  }

  async update(sessionId: string, id: string, dto: UpdateAutomationFlowDto): Promise<AutomationFlow> {
    const flow = await this.findOne(sessionId, id);
    const patch: Partial<Pick<AutomationFlow, 'name' | 'definition' | 'timeoutMinutes' | 'enabled'>> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.definition !== undefined) {
      this.assertValidDefinition(dto.definition);
      patch.definition = dto.definition;
    }
    if (dto.timeoutMinutes !== undefined) patch.timeoutMinutes = dto.timeoutMinutes;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (Object.keys(patch).length === 0) return flow;
    // A conditional UPDATE of the carried fields, as AutomationRulesService.update does and for the same reasons.
    const result = await this.flowRepository.update({ id, sessionId }, patch);
    if (!result.affected) throw new NotFoundException(`Automation flow ${id} not found`);
    return this.findOne(sessionId, id);
  }

  async remove(sessionId: string, id: string): Promise<void> {
    const flow = await this.findOne(sessionId, id);
    await this.flowRepository.remove(flow);
  }

  /** Forget where a chat is in the flows, ending a handoff: the chat's next message starts fresh. */
  async resetChat(sessionId: string, chatId: string): Promise<void> {
    await this.stateRepository.delete({ sessionId, chatId });
  }

  private assertValidDefinition(definition: unknown): void {
    const problems = validateFlowDefinition(definition);
    if (problems.length > 0) throw new BadRequestException(problems);
  }

  /**
   * Run one inbound message through the session's flows. Resolves true when a flow handled it (it
   * answered, or the chat is in a flow or handed to a person), so the caller skips the rules.
   *
   * Called fire-and-forget from the projector's at-most-once dispatch, like the rules. Never rejects:
   * a broken flow or a dead DB must not reach the receive path, and then reports false so the rules
   * still get their turn.
   */
  async handleInbound(sessionId: string, message: Record<string, unknown>): Promise<boolean> {
    if (message.fromMe === true) return false;
    const chatId = typeof message.chatId === 'string' ? message.chatId : null;
    if (!chatId) return false;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    if (timestamp !== null && Date.now() / 1000 - timestamp > MAX_MESSAGE_AGE_SECONDS) return false;
    // Flows hold a conversation with one person; a group, channel or status has none.
    const kind = typeof message.kind === 'string' && message.kind ? message.kind : chatKind(chatId);
    if (kind !== 'individual') return false;

    try {
      return await this.withChatLock(`${sessionId}\u0000${chatId}`, () => this.process(sessionId, chatId, message));
    } catch (error) {
      this.logger.warn('Automation flow failed', {
        sessionId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async process(sessionId: string, chatId: string, message: Record<string, unknown>): Promise<boolean> {
    const state = await this.stateRepository.findOne({ where: { sessionId, chatId } });
    const now = Date.now();
    if (state?.handoffUntil != null && state.handoffUntil > now) return true;

    const flows = (
      await this.flowRepository.find({ where: { sessionId, enabled: true }, order: { createdAt: 'ASC', id: 'ASC' } })
    ).filter(flow => this.isRunnable(flow));
    if (flows.length === 0) return false;

    const button = message.button as { id?: unknown } | undefined;
    const ctx = {
      chatId,
      text: typeof message.body === 'string' ? message.body : '',
      buttonId: typeof button?.id === 'string' ? button.id : undefined,
      now: new Date(now),
    };

    const current = state?.flowId && state.nodeId ? flows.find(flow => flow.id === state.flowId) : undefined;
    const active =
      current && state?.lastMessageAt != null && state.lastMessageAt + current.timeoutMinutes * 60_000 > now
        ? current
        : undefined;
    const keywordFlow = flows.find(flow => {
      const trigger = triggerOf(flow.definition);
      return trigger?.data.match === 'keywords' && matchesKeywords(ctx.text, trigger.data.keywords);
    });
    const sinceStart = state?.startedAt != null ? now - state.startedAt : Infinity;

    let flow: AutomationFlow;
    let result: FlowStepResult;
    let started = false;
    if (active && !(keywordFlow && sinceStart >= FLOW_RESTART_COOLDOWN_MS)) {
      flow = active;
      result = continueFlow(
        flow.definition,
        {
          nodeId: state!.nodeId,
          variables: state!.variables ?? {},
          invalidCount: state!.invalidCount,
          lastInvalidAt: state!.lastInvalidAt,
        },
        ctx,
      );
    } else {
      const starter = keywordFlow ?? flows.find(candidate => triggerOf(candidate.definition)?.data.match === 'any');
      if (!starter) return false;
      // Quiet rather than unhandled: the rules would otherwise answer the message the cooldown held back.
      if (sinceStart < FLOW_START_COOLDOWN_MS) return true;
      flow = starter;
      result = startFlow(flow.definition, ctx);
      started = true;
    }

    // Recorded before the sends, as the rules enter their cooldown first: a message that arrives while
    // the replies are in flight must see where this one left the chat.
    await this.stateRepository.save({
      sessionId,
      chatId,
      flowId: result.progress.nodeId ? flow.id : null,
      nodeId: result.progress.nodeId,
      variables: result.progress.variables,
      invalidCount: result.progress.invalidCount,
      lastInvalidAt: result.progress.lastInvalidAt,
      lastMessageAt: now,
      startedAt: started ? now : (state?.startedAt ?? null),
      handoffUntil: result.handoffMinutes !== null ? now + result.handoffMinutes * 60_000 : null,
    });
    await this.send(sessionId, flow.id, result.actions);
    return true;
  }

  /** A stored flow that no longer validates (a restore bypasses the API) is skipped on its own. */
  private isRunnable(flow: AutomationFlow): boolean {
    const problems = validateFlowDefinition(flow.definition);
    if (problems.length === 0) return true;
    this.logger.warn('Skipping automation flow with an invalid definition', {
      flowId: flow.id,
      problem: problems[0],
    });
    return false;
  }

  /** Send in order. One failed send is logged and the rest still go out. */
  private async send(sessionId: string, flowId: string, actions: FlowAction[]): Promise<void> {
    const port = this.resolveMessagePort();
    if (!port) return;
    for (const action of actions) {
      try {
        if (action.kind === 'buttons') {
          await this.sendButtons(port, sessionId, action);
        } else {
          await port.sendText(sessionId, { chatId: action.chatId, text: action.text });
        }
      } catch (error) {
        this.logger.warn('Automation flow reply failed', {
          sessionId,
          flowId,
          chatId: action.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Buttons where the engine sends them; the same prompt as text where it does not (whatsapp-web.js answers 501). */
  private async sendButtons(
    port: FlowMessagePort,
    sessionId: string,
    action: Extract<FlowAction, { kind: 'buttons' }>,
  ): Promise<void> {
    if (port.sendButtons) {
      try {
        await port.sendButtons(sessionId, { chatId: action.chatId, body: action.body, buttons: action.buttons });
        return;
      } catch (error) {
        this.logger.debug('Buttons refused, sending the prompt as text', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await port.sendText(sessionId, { chatId: action.chatId, text: action.body });
  }

  private resolveMessagePort(): FlowMessagePort | undefined {
    if (!this.messagePort) {
      try {
        this.messagePort = this.moduleRef?.get<typeof PLUGIN_MESSAGE_PORT, FlowMessagePort>(PLUGIN_MESSAGE_PORT, {
          strict: false,
        });
      } catch (error) {
        this.logger.warn('MessageService is not resolvable; automation flow replies are disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }
    return this.messagePort;
  }

  /** Run `work` after every earlier task for the same key, so one chat's messages are handled in order. */
  private withChatLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chatLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.catch(() => undefined);
    this.chatLocks.set(key, settled);
    void settled.then(() => {
      if (this.chatLocks.get(key) === settled) this.chatLocks.delete(key);
    });
    return next;
  }
}
