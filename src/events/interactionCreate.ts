import { Events, Interaction, GuildMember } from 'discord.js';
import { logEvent, logError } from '../utils/logger';
import { createMusaEmbed, safeReply, MusaColors, MusaEmojis } from '../utils/discord';
import { MusicManager } from '../services/MusicManager';

// ─── Slash command cooldown ───────────────────────────────────────────────────

// In-memory cooldown map — scoped to this module, no globals
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 2000;

// ─── Button cooldown ──────────────────────────────────────────────────────────

const buttonCooldowns = new Map<string, number>();
const BUTTON_COOLDOWN_MS = 1500;

// ─── Handler ──────────────────────────────────────────────────────────────────

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction, musicManager: MusicManager) {
    // ── Button interactions ─────────────────────────────────────────────────
    if (interaction.isButton()) {
      const [ns, action] = interaction.customId.split(':');

      // Only handle Musa buttons
      if (ns !== 'musa' || !action) return;

      const guildId = interaction.guildId;
      if (!guildId) return;

      const member = interaction.member as GuildMember | null;
      const userId = interaction.user.id;
      const userTag = interaction.user.tag;

      // Voice channel guard: user must be in the same VC as the bot
      const botConnection = musicManager.getVoiceConnection(guildId);
      const userVoice = member?.voice;
      if (!botConnection || !userVoice?.channel) {
        await interaction.reply({
          content: `${MusaEmojis.warning} Você precisa estar no canal de voz do bot para usar os botões!`,
          ephemeral: true,
        });
        return;
      }

      // Per-button cooldown: userId:btn:action → last use timestamp
      const btnCooldownKey = `${userId}:btn:${action}`;
      const now = Date.now();
      const lastBtnUse = buttonCooldowns.get(btnCooldownKey) ?? 0;
      if (now - lastBtnUse < BUTTON_COOLDOWN_MS) {
        await interaction.reply({
          content: 'Aguarde um momento antes de usar este botão novamente.',
          ephemeral: true,
        });
        return;
      }
      buttonCooldowns.set(btnCooldownKey, now);

      // Acknowledge immediately — we'll do the action, status auto-updates
      await interaction.deferUpdate();

      logEvent('button_interaction', { action, userId, userTag, guildId });

      try {
        switch (action) {
          case 'playpause': {
            const guildData = musicManager.getGuildMusicData(guildId);
            if (guildData.isPaused) {
              const resumed = musicManager.resume(guildId);
              logEvent('button_resume', { userId, userTag, guildId, success: resumed });
            } else {
              const paused = musicManager.pause(guildId);
              logEvent('button_pause', { userId, userTag, guildId, success: paused });
            }
            break;
          }
          case 'skip': {
            musicManager.skip(guildId, userTag, userId);
            logEvent('button_skip', { userId, userTag, guildId });
            break;
          }
          case 'shuffle': {
            musicManager.shuffleQueue(guildId, userTag, userId);
            logEvent('button_shuffle', { userId, userTag, guildId });
            break;
          }
          case 'stop': {
            musicManager.stop(guildId);
            await musicManager.leaveVoiceChannel(guildId);
            logEvent('button_stop', { userId, userTag, guildId });
            break;
          }
          default: {
            logEvent('button_unknown_action', { action, userId, guildId });
          }
        }
      } catch (error) {
        logError('button_action_failed', error as Error, { action, userId, guildId });
      }

      return;
    }

    // ── Slash command interactions ──────────────────────────────────────────
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands?.get(interaction.commandName);
    const cmdMusicManager = interaction.client.musicManager;

    // Cooldown check: rate-limit per user+command to prevent spam
    const cooldownKey = `${interaction.user.id}:${interaction.commandName}`;
    const cmdNow = Date.now();
    const lastUsed = cooldowns.get(cooldownKey) ?? 0;
    if (cmdNow - lastUsed < COOLDOWN_MS) {
      try {
        await interaction.reply({
          content: 'Aguarde um instante antes de usar este comando novamente.',
          ephemeral: true,
        });
      } catch {
        // ignore reply errors (interaction may have expired)
      }
      return;
    }
    cooldowns.set(cooldownKey, cmdNow);

    if (!command) {
      logError('Command not found', new Error(`Command ${interaction.commandName} not found`), {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      const embed = createMusaEmbed({
        title: 'Comando Não Encontrado',
        description: `${MusaEmojis.warning} Comando \`${interaction.commandName}\` não foi encontrado! ${MusaEmojis.notes}`,
        color: MusaColors.error,
      });

      await safeReply(interaction, { embeds: [embed] }, true);
      return;
    }

    try {
      logEvent('command_started', {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      await command.execute(interaction, cmdMusicManager);

      logEvent('command_completed', {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
    } catch (error) {
      logError('Command execution failed', error as Error, {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      const embed = createMusaEmbed({
        title: 'Erro no Comando',
        description: `${MusaEmojis.warning} Ops! Algo desafinou durante a execução do comando! Tente novamente! ${MusaEmojis.notes}`,
        color: MusaColors.error,
      });

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ embeds: [embed], ephemeral: true });
        } else {
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      } catch (replyError) {
        logError('Failed to send error message', replyError as Error, {
          commandName: interaction.commandName,
          userId: interaction.user.id,
          guildId: interaction.guildId,
        });
      }
    }
  },
};
