import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

const epochMs = {
  to: (v: number | null) => v,
  from: (v: string | null) => (v == null ? null : Number(v)),
};

/**
 * Where one chat is in the session's automation flows, so a restart does not drop a customer halfway
 * through a menu. One row per (session, chat), kept after a flow ends to remember a handoff and when
 * the last flow started. `sessionId` is provenance rather than a foreign key, as on chat_states.
 * Times are epoch MILLISECONDS; the transformer keeps them numbers rather than the string a bigint
 * column otherwise reads back as.
 */
@Entity('automation_flow_states')
export class AutomationFlowState {
  @PrimaryColumn()
  sessionId!: string;

  @PrimaryColumn()
  chatId!: string;

  /** The flow the chat is in, or null once it ended. */
  @Column({ type: 'varchar', nullable: true })
  flowId!: string | null;

  /** The step waiting for the chat's reply, or null once the flow ended. */
  @Column({ type: 'varchar', nullable: true })
  nodeId!: string | null;

  /** Answers collected so far, by variable name. */
  @Column({ type: jsonColumnType(), nullable: true })
  variables!: Record<string, string> | null;

  @Column({ type: 'int', default: 0 })
  invalidCount!: number;

  @Column({ type: 'bigint', nullable: true, transformer: epochMs })
  lastInvalidAt!: number | null;

  /**
   * When the flow last handled a message from this chat; the flow timeout runs from here. Kept apart
   * from `updatedAt`, which SQLite stores without a zone and so cannot be compared with the clock.
   */
  @Column({ type: 'bigint', nullable: true, transformer: epochMs })
  lastMessageAt!: number | null;

  /** When a flow last started in this chat; restarts are rate-limited against it. */
  @Column({ type: 'bigint', nullable: true, transformer: epochMs })
  startedAt!: number | null;

  /** The bot stays silent in this chat until then. */
  @Column({ type: 'bigint', nullable: true, transformer: epochMs })
  handoffUntil!: number | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
