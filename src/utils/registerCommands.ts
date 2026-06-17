import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { BotConfig } from '../types/music';
import { logger } from './logger';

/**
 * Loads all slash command JSON payloads from the commands directory.
 * Resolves both compiled (.js) and source (.ts) environments automatically.
 */
export function loadCommandPayloads(commandsDir: string): object[] {
  const isCompiled = __filename.endsWith('.js');
  const fileExtension = isCompiled ? '.js' : '.ts';
  const indexFile = 'index' + fileExtension;

  const commandFiles = fs
    .readdirSync(commandsDir)
    .filter((file) => file.endsWith(fileExtension) && file !== indexFile);

  const payloads: object[] = [];

  for (const file of commandFiles) {
    const filePath = path.join(commandsDir, file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const command = require(filePath);
    const commandData = command.default || command;

    if ('data' in commandData && 'execute' in commandData) {
      payloads.push(commandData.data.toJSON());
    } else {
      logger.warn('⚠️  registerCommands_skip', {
        file,
        reason: 'Missing required data or execute property',
      });
    }
  }

  return payloads;
}

export interface RegisterCommandsResult {
  count: number;
  mode: 'guild' | 'global';
  guildId?: string;
}

/**
 * Registers slash commands with the Discord API.
 *
 * - Guild mode  (instantaneous): when `config.guildId` is set.
 * - Global mode (up to 1 h lag): fallback when no guildId.
 *
 * Throws on API/network errors — callers decide whether to swallow or rethrow.
 */
export async function registerCommands(
  config: Pick<BotConfig, 'token' | 'clientId' | 'guildId'>,
  commandPayloads: object[],
): Promise<RegisterCommandsResult> {
  const rest = new REST().setToken(config.token);

  if (config.guildId) {
    const data = (await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
      body: commandPayloads,
    })) as object[];

    return { count: data.length, mode: 'guild', guildId: config.guildId };
  }

  const data = (await rest.put(Routes.applicationCommands(config.clientId), {
    body: commandPayloads,
  })) as object[];

  return { count: data.length, mode: 'global' };
}
