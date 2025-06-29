import { Scope } from '@nestjs/common';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { TwentyORMManager } from 'src/engine/twenty-orm/twenty-orm.manager';
import { ConnectedAccountRefreshAccessTokenExceptionCode } from 'src/modules/connected-account/refresh-tokens-manager/exceptions/connected-account-refresh-tokens.exception';
import { ConnectedAccountRefreshTokensService } from 'src/modules/connected-account/refresh-tokens-manager/services/connected-account-refresh-tokens.service';
import { isThrottled } from 'src/modules/connected-account/utils/is-throttled';
import {
  MessageChannelSyncStage,
  MessageChannelWorkspaceEntity,
} from 'src/modules/messaging/common/standard-objects/message-channel.workspace-entity';
import {
  MessageImportDriverException,
  MessageImportDriverExceptionCode,
} from 'src/modules/messaging/message-import-manager/drivers/exceptions/message-import-driver.exception';
import { MessagingFullMessageListFetchService } from 'src/modules/messaging/message-import-manager/services/messaging-full-message-list-fetch.service';
import {
  MessageImportExceptionHandlerService,
  MessageImportSyncStep,
} from 'src/modules/messaging/message-import-manager/services/messaging-import-exception-handler.service';
import { MessagingPartialMessageListFetchService } from 'src/modules/messaging/message-import-manager/services/messaging-partial-message-list-fetch.service';
import { MessagingMonitoringService } from 'src/modules/messaging/monitoring/services/messaging-monitoring.service';

export type MessagingMessageListFetchJobData = {
  messageChannelId: string;
  workspaceId: string;
};

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class MessagingMessageListFetchJob {
  constructor(
    private readonly messagingFullMessageListFetchService: MessagingFullMessageListFetchService,
    private readonly messagingPartialMessageListFetchService: MessagingPartialMessageListFetchService,
    private readonly messagingMonitoringService: MessagingMonitoringService,
    private readonly twentyORMManager: TwentyORMManager,
    private readonly connectedAccountRefreshTokensService: ConnectedAccountRefreshTokensService,
    private readonly messageImportErrorHandlerService: MessageImportExceptionHandlerService,
  ) {}

  @Process(MessagingMessageListFetchJob.name)
  async handle(data: MessagingMessageListFetchJobData): Promise<void> {
    const { messageChannelId, workspaceId } = data;

    await this.messagingMonitoringService.track({
      eventName: 'message_list_fetch_job.triggered',
      messageChannelId,
      workspaceId,
    });

    const messageChannelRepository =
      await this.twentyORMManager.getRepository<MessageChannelWorkspaceEntity>(
        'messageChannel',
      );

    const messageChannel = await messageChannelRepository.findOne({
      where: {
        id: messageChannelId,
      },
      relations: ['connectedAccount', 'messageFolders'],
    });

    if (!messageChannel) {
      await this.messagingMonitoringService.track({
        eventName: 'message_list_fetch_job.error.message_channel_not_found',
        messageChannelId,
        workspaceId,
      });

      return;
    }

    try {
      if (
        isThrottled(
          messageChannel.syncStageStartedAt,
          messageChannel.throttleFailureCount,
        )
      ) {
        return;
      }

      try {
        messageChannel.connectedAccount.accessToken =
          await this.connectedAccountRefreshTokensService.refreshAndSaveTokens(
            messageChannel.connectedAccount,
            workspaceId,
          );
      } catch (error) {
        switch (error.code) {
          case ConnectedAccountRefreshAccessTokenExceptionCode.TEMPORARY_NETWORK_ERROR:
            throw new MessageImportDriverException(
              error.message,
              MessageImportDriverExceptionCode.TEMPORARY_ERROR,
            );
          case ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_ACCESS_TOKEN_FAILED:
          case ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND:
            await this.messagingMonitoringService.track({
              eventName: `refresh_token.error.insufficient_permissions`,
              workspaceId,
              connectedAccountId: messageChannel.connectedAccountId,
              messageChannelId: messageChannel.id,
              message: `${error.code}: ${error.reason ?? ''}`,
            });
            throw new MessageImportDriverException(
              error.message,
              MessageImportDriverExceptionCode.INSUFFICIENT_PERMISSIONS,
            );
          case ConnectedAccountRefreshAccessTokenExceptionCode.PROVIDER_NOT_SUPPORTED:
            throw new MessageImportDriverException(
              error.message,
              MessageImportDriverExceptionCode.PROVIDER_NOT_SUPPORTED,
            );
          default:
            throw error;
        }
      }

      switch (messageChannel.syncStage) {
        case MessageChannelSyncStage.PARTIAL_MESSAGE_LIST_FETCH_PENDING:
          await this.messagingMonitoringService.track({
            eventName: 'partial_message_list_fetch.started',
            workspaceId,
            connectedAccountId: messageChannel.connectedAccount.id,
            messageChannelId: messageChannel.id,
          });

          await this.messagingPartialMessageListFetchService.processMessageListFetch(
            messageChannel,
            messageChannel.connectedAccount,
            workspaceId,
          );

          await this.messagingMonitoringService.track({
            eventName: 'partial_message_list_fetch.completed',
            workspaceId,
            connectedAccountId: messageChannel.connectedAccount.id,
            messageChannelId: messageChannel.id,
          });

          break;

        case MessageChannelSyncStage.FULL_MESSAGE_LIST_FETCH_PENDING:
          await this.messagingMonitoringService.track({
            eventName: 'full_message_list_fetch.started',
            workspaceId,
            connectedAccountId: messageChannel.connectedAccount.id,
            messageChannelId: messageChannel.id,
          });

          await this.messagingFullMessageListFetchService.processMessageListFetch(
            messageChannel,
            workspaceId,
          );

          await this.messagingMonitoringService.track({
            eventName: 'full_message_list_fetch.completed',
            workspaceId,
            connectedAccountId: messageChannel.connectedAccount.id,
            messageChannelId: messageChannel.id,
          });

          break;

        default:
          break;
      }
    } catch (error) {
      await this.messageImportErrorHandlerService.handleDriverException(
        error,
        MessageImportSyncStep.FULL_OR_PARTIAL_MESSAGE_LIST_FETCH,
        messageChannel,
        workspaceId,
      );
    }
  }
}
