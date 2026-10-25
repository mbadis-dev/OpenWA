import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { jsonColumnType } from '../../../common/utils/column-types';
import type { FlowDefinition } from '../flows/flow-definition';

/**
 * A multi-step autoreply flow drawn in the dashboard's flow builder: a graph of messages, questions,
 * conditions and handoffs (see flows/flow-definition.ts). Flows answer before the single-message
 * automation rules, and a chat that is inside a flow or handed to a person gets no rule replies.
 */
@Entity('automation_flows')
export class AutomationFlow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Indexed because the evaluation path loads a session's flows on every inbound message.
  @Index('IDX_automation_flows_sessionId')
  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: jsonColumnType() })
  definition!: FlowDefinition;

  // A chat that has not replied for this long starts over instead of answering an old question.
  @Column({ type: 'int', default: 60 })
  timeoutMinutes!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
