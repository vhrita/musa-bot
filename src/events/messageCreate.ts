import { Events, Message } from 'discord.js';
import { botConfig } from '../config';
import { logEvent, logError } from '../utils/logger';

export default {
  name: Events.MessageCreate,
  once: false,
  async execute(message: Message) {
    try {
      const musaChannelId = botConfig.musaChannelId;
      if (!musaChannelId) return;

      // Only act on the configured Musa channel
      if (message.channelId !== musaChannelId) return;

      // Ignore bot messages (includes our own status message)
      if (message.author?.bot) return;

      // Attempt to delete the message to keep the channel clean
      if (message.deletable) {
        await message.delete();
        logEvent('user_message_deleted_in_musa_channel', {
          messageId: message.id,
          authorId: message.author?.id,
          channelId: message.channelId
        });
      } else {
        // Fallback: try channel-based deletion
        try {
          await message.channel?.messages?.delete(message.id);
          logEvent('user_message_deleted_via_channel_in_musa_channel', {
            messageId: message.id,
            authorId: message.author?.id,
            channelId: message.channelId
          });
        } catch (e) {
          logError('failed_to_delete_user_message_in_musa_channel', e as Error, {
            messageId: message.id,
            authorId: message.author?.id,
            channelId: message.channelId,
            deletable: message.deletable
          });
        }
      }
    } catch (error) {
      logError('message_create_handler_error', error as Error, {
        channelId: message.channelId,
        authorId: message.author?.id
      });
    }
  }
};
