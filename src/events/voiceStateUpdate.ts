import { Events, VoiceState } from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { logEvent } from '../utils/logger';

export default {
  name: Events.VoiceStateUpdate,
  
  async execute(oldState: VoiceState, newState: VoiceState, musicManager: MusicManager): Promise<void> {
    // Only handle voice state changes for guilds where the bot is connected
    const guildId = newState.guild.id;
    const botConnection = musicManager.getVoiceConnection(guildId);
    
    if (!botConnection) {
      return; // Bot not connected to this guild
    }

    const botChannelId = botConnection.joinConfig.channelId;
    if (!botChannelId) {
      return;
    }

    // Check if the user joined or left the bot's channel
    const userLeftBotChannel = oldState.channelId === botChannelId && newState.channelId !== botChannelId;
    const userJoinedBotChannel = oldState.channelId !== botChannelId && newState.channelId === botChannelId;

    if (userLeftBotChannel || userJoinedBotChannel) {
      // Get the current voice channel and count non-bot members
      const voiceChannel = newState.guild.channels.cache.get(botChannelId);
      
      if (voiceChannel?.isVoiceBased()) {
        const nonBotMembers = voiceChannel.members.filter(member => !member.user.bot);
        const isChannelEmpty = nonBotMembers.size === 0;

        logEvent('voice_state_change_detected', {
          guildId,
          channelId: botChannelId,
          userId: newState.id,
          userLeft: userLeftBotChannel,
          userJoined: userJoinedBotChannel,
          nonBotMembers: nonBotMembers.size,
          isChannelEmpty
        });

        if (isChannelEmpty) {
          musicManager.handleVoiceChannelEmpty(guildId);
        } else {
          musicManager.handleVoiceChannelOccupied(guildId);
        }
      }
    }
  },
};
