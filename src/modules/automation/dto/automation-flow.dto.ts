import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsObject, IsString, Max, Min, ValidateIf } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import { AutomationFlow } from '../entities/automation-flow.entity';
import type { FlowDefinition } from '../flows/flow-definition';

/** Longest a chat may stay idle mid-flow before it starts over: one week. */
export const AUTOMATION_FLOW_TIMEOUT_MAX_MINUTES = 10_080;

const DEFINITION_DESCRIPTION =
  'The flow graph: `{ nodes, edges }` in the React Flow shape. Node types are `trigger` (exactly one), ' +
  '`message`, `collect`, `handoff` and `condition`; see docs/06 for each type’s settings and outputs. ' +
  'The whole graph is checked on save and refused with the list of problems.';

const TIMEOUT_DESCRIPTION =
  'Minutes a chat may stay silent mid-flow; after that its next message starts the flow over instead ' +
  'of answering the old question. Default 60.';

export class CreateAutomationFlowDto {
  @ApiProperty({ description: 'Display name for the flow', example: 'Welcome menu', maxLength: 100 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(100)
  @NoNulCharacter()
  name!: string;

  @ApiProperty({ description: DEFINITION_DESCRIPTION, type: 'object', additionalProperties: true })
  @IsObject()
  definition!: FlowDefinition;

  @ApiPropertyOptional({
    description: TIMEOUT_DESCRIPTION,
    default: 60,
    minimum: 1,
    maximum: AUTOMATION_FLOW_TIMEOUT_MAX_MINUTES,
  })
  @ValidateIf((o: CreateAutomationFlowDto) => o.timeoutMinutes !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(AUTOMATION_FLOW_TIMEOUT_MAX_MINUTES)
  timeoutMinutes?: number;

  @ApiPropertyOptional({ description: 'Whether the flow is active', default: true })
  @ValidateIf((o: CreateAutomationFlowDto) => o.enabled !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAutomationFlowDto {
  @ApiPropertyOptional({ description: 'Display name for the flow', maxLength: 100 })
  // Not @IsOptional on the NOT NULL columns: that also skips null, which then reaches the update as a 500.
  @ValidateIf((o: UpdateAutomationFlowDto) => o.name !== undefined)
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(100)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({ description: DEFINITION_DESCRIPTION, type: 'object', additionalProperties: true })
  @ValidateIf((o: UpdateAutomationFlowDto) => o.definition !== undefined)
  @IsObject()
  definition?: FlowDefinition;

  @ApiPropertyOptional({ description: TIMEOUT_DESCRIPTION, minimum: 1, maximum: AUTOMATION_FLOW_TIMEOUT_MAX_MINUTES })
  @ValidateIf((o: UpdateAutomationFlowDto) => o.timeoutMinutes !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(AUTOMATION_FLOW_TIMEOUT_MAX_MINUTES)
  timeoutMinutes?: number;

  @ApiPropertyOptional({ description: 'Whether the flow is active' })
  @ValidateIf((o: UpdateAutomationFlowDto) => o.enabled !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class AutomationFlowResponseDto {
  @ApiProperty()
  @Expose()
  id!: string;

  @ApiProperty()
  @Expose()
  sessionId!: string;

  @ApiProperty()
  @Expose()
  name!: string;

  @ApiProperty()
  @Expose()
  enabled!: boolean;

  @ApiProperty({ description: DEFINITION_DESCRIPTION, type: 'object', additionalProperties: true })
  @Expose()
  definition!: FlowDefinition;

  @ApiProperty({ description: TIMEOUT_DESCRIPTION })
  @Expose()
  timeoutMinutes!: number;

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;

  static fromEntity(flow: AutomationFlow): AutomationFlowResponseDto {
    return plainToInstance(AutomationFlowResponseDto, flow, { excludeExtraneousValues: true });
  }
}
