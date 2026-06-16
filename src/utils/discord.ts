import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  ColorResolvable,
  InteractionResponse,
  Message,
} from 'discord.js';
import MusaPhrasesJson from '../assets/phrases.json';
import { ServiceType } from '../types/music';

// Cores da Musa (tons de roxo)
export const MusaColors = {
  primary: '#8B5DBC' as ColorResolvable, // Roxo principal da Musa
  success: '#9B7FBD' as ColorResolvable, // Roxo claro para sucesso
  warning: '#A15BBF' as ColorResolvable, // Roxo médio para avisos
  error: '#7A4BB8' as ColorResolvable, // Roxo escuro para erros
  queue: '#8E65C4' as ColorResolvable, // Roxo para queue
  nowPlaying: '#9F72C7' as ColorResolvable, // Roxo para "tocando agora"
} as const;

// Emojis musicais da Musa
export const MusaEmojis = {
  note: '🎵',
  notes: '🎶',
  microphone: '🎤',
  headphones: '🎧',
  speaker: '🔊',
  radio: '📻',
  cd: '💿',
  vinyl: '📀',
  guitar: '🎸',
  piano: '🎹',
  trumpet: '🎺',
  violin: '🎻',
  drums: '🥁',
  play: '▶️',
  pause: '⏸️',
  stop: '⏹️',
  skip: '⏭️',
  previous: '⏮️',
  shuffle: '🔀',
  repeat: '🔁',
  volume: '🔉',
  mute: '🔇',
  live: '🔴',
  queue: '📜',
  add: '➕',
  remove: '➖',
  clear: '🗑️',
  search: '🔍',
  star: '⭐',
  heart: '💜',
  fire: '🔥',
  sparkles: '✨',
  magic: '🪄',
  fairy: '🧚‍♀️',
  warning: '⚠️',
} as const;

export const getServiceEmoji = (service: ServiceType): string => {
  switch (service) {
    case 'youtube':
      return '🔴';
    case 'internet_archive':
      return '📚';
    case 'radio':
      return '📻';
    case 'spotify':
      return '🟢';
    case 'soundcloud':
      return '🟠';
    default:
      return '🎵';
  }
};

export const createMusaEmbed = (options: {
  title: string;
  description?: string;
  color?: ColorResolvable;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
  footerIconUrl?: string;
  thumbnail?: string;
  image?: string;
  timestamp?: boolean;
}): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setTitle(`${MusaEmojis.fairy} ${options.title}`)
    .setColor(options.color || MusaColors.primary);

  if (options.description) {
    embed.setDescription(options.description);
  }

  if (options.fields) {
    embed.addFields(options.fields);
  }

  if (options.footer) {
    const footer: any = { text: `${MusaEmojis.notes} ${options.footer}` };
    if (options.footerIconUrl) footer.iconURL = options.footerIconUrl;
    embed.setFooter(footer);
  }

  if (options.thumbnail) {
    embed.setThumbnail(options.thumbnail);
  }

  if (options.image) {
    embed.setImage(options.image);
  }

  if (options.timestamp) {
    embed.setTimestamp();
  }

  return embed;
};

export const safeReply = async (
  interaction: ChatInputCommandInteraction,
  content: string | { embeds: EmbedBuilder[] },
  _ephemeral = true,
): Promise<InteractionResponse<boolean> | Message<boolean> | null> => {
  try {
    // For policy: always ephemeral. Ignore provided flag.
    const options =
      typeof content === 'string' ? { content, ephemeral: true } : { ...content, ephemeral: true };

    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(options);
    } else {
      return await interaction.reply(options);
    }
  } catch (error) {
    console.error('🎵💥 Erro ao responder interação:', error);
    return null;
  }
};

export const formatDuration = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return '00:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength - 3)}...`;
};

// Frases musicais da Musa centralizadas em JSON
export const MusaPhrases = MusaPhrasesJson as unknown as Record<string, string[]>;

export const getRandomPhrase = (category: keyof typeof MusaPhrases | string): string => {
  const phrases = (MusaPhrases as any)[category] as string[] | undefined;
  const list = phrases && phrases.length > 0 ? phrases : [''];
  const randomIndex = Math.floor(Math.random() * list.length);
  return list[randomIndex] ?? list[0] ?? '';
};
