import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AutomationFlowsService } from './automation-flows.service';
import { AutomationFlowResponseDto, CreateAutomationFlowDto, UpdateAutomationFlowDto } from './dto/automation-flow.dto';

@ApiTags('automation')
@Controller('sessions/:sessionId/automation-flows')
export class AutomationFlowController {
  constructor(private readonly automationFlows: AutomationFlowsService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create an autoreply flow' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Flow created.', type: AutomationFlowResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid flow (the message lists every problem in the graph), or the per-session limit is reached.',
  })
  @ApiResponse({ status: 404, description: 'No session with this id.' })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateAutomationFlowDto,
  ): Promise<AutomationFlowResponseDto> {
    return AutomationFlowResponseDto.fromEntity(await this.automationFlows.create(sessionId, dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the session’s autoreply flows' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Flows in evaluation order: creation time, id as the same-second tiebreak.',
    type: AutomationFlowResponseDto,
    isArray: true,
  })
  async findAll(@Param('sessionId') sessionId: string): Promise<AutomationFlowResponseDto[]> {
    return (await this.automationFlows.findAll(sessionId)).map(flow => AutomationFlowResponseDto.fromEntity(flow));
  }

  @Get(':flowId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one autoreply flow' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'flowId', description: 'Flow ID' })
  @ApiResponse({ status: 200, description: 'The flow.', type: AutomationFlowResponseDto })
  @ApiResponse({ status: 404, description: 'No such flow in this session.' })
  async findOne(
    @Param('sessionId') sessionId: string,
    @Param('flowId') flowId: string,
  ): Promise<AutomationFlowResponseDto> {
    return AutomationFlowResponseDto.fromEntity(await this.automationFlows.findOne(sessionId, flowId));
  }

  @Put(':flowId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update an autoreply flow' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'flowId', description: 'Flow ID' })
  @ApiResponse({ status: 200, description: 'Updated flow.', type: AutomationFlowResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid flow (the message lists every problem in the graph).' })
  @ApiResponse({ status: 404, description: 'No such flow in this session.' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('flowId') flowId: string,
    @Body() dto: UpdateAutomationFlowDto,
  ): Promise<AutomationFlowResponseDto> {
    return AutomationFlowResponseDto.fromEntity(await this.automationFlows.update(sessionId, flowId, dto));
  }

  @Delete(':flowId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an autoreply flow' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'flowId', description: 'Flow ID' })
  @ApiResponse({ status: 204, description: 'Flow deleted.' })
  @ApiResponse({ status: 404, description: 'No such flow in this session.' })
  async remove(@Param('sessionId') sessionId: string, @Param('flowId') flowId: string): Promise<void> {
    await this.automationFlows.remove(sessionId, flowId);
  }

  @Delete('chats/:chatId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Reset a chat’s flow progress',
    description:
      'Forgets where the chat is in the session’s flows and ends a handoff, so the bot answers its next ' +
      'message as a new conversation. Succeeds when there is nothing to reset.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID, e.g. 628123456789@c.us' })
  @ApiResponse({ status: 204, description: 'Progress reset.' })
  async resetChat(@Param('sessionId') sessionId: string, @Param('chatId') chatId: string): Promise<void> {
    await this.automationFlows.resetChat(sessionId, chatId);
  }
}
