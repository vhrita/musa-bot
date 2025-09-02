import { 
  ChatInputCommandInteraction, 
  EmbedBuilder, 
  ColorResolvable,
  InteractionResponse,
  Message
} from 'discord.js';
import { ServiceType } from '../types/music';

// Cores da Musa (tons de roxo)
export const MusaColors = {
  primary: '#8B5DBC' as ColorResolvable,      // Roxo principal da Musa
  success: '#9B7FBD' as ColorResolvable,      // Roxo claro para sucesso
  warning: '#A15BBF' as ColorResolvable,      // Roxo médio para avisos
  error: '#7A4BB8' as ColorResolvable,        // Roxo escuro para erros
  queue: '#8E65C4' as ColorResolvable,        // Roxo para queue
  nowPlaying: '#9F72C7' as ColorResolvable,   // Roxo para "tocando agora"
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
  thumbnail?: string;
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
    embed.setFooter({ text: `${MusaEmojis.notes} ${options.footer}` });
  }

  if (options.thumbnail) {
    embed.setThumbnail(options.thumbnail);
  }

  if (options.timestamp) {
    embed.setTimestamp();
  }

  return embed;
};

export const safeReply = async (
  interaction: ChatInputCommandInteraction,
  content: string | { embeds: EmbedBuilder[] },
  ephemeral = false
): Promise<InteractionResponse<boolean> | Message<boolean> | null> => {
  try {
    const options = typeof content === 'string' 
      ? { content, ephemeral }
      : { ...content, ephemeral };

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

// Frases musicais da Musa
export const MusaPhrases = {
  ready: [
    "🎵 A sinfonia começa! Estou aqui para embalar nossos momentos com música! ✨",
    "🎶 Que a harmonia nos guie! Pronta para tocar as melodias dos nossos corações! 💜",
    "🎤 O palco está montado e eu estou afinada! Vamos fazer música juntos! 🎸"
  ],
  
  playing: [
    "🎵 Que essa melodia embale nossos corações no ritmo perfeito! ✨",
    "🎶 Deixe a música fluir como uma cascata de notas mágicas! 💜",
    "🎤 Agora tocando no teatro da nossa amizade musical! 🎭"
  ],
  
  added: [
    "🎵 Mais uma nota adicionada à nossa sinfonia! O show deve continuar! ✨",
    "🎶 Sua escolha foi afinada perfeitamente na nossa playlist! 💜",
    "🎤 Essa música vai fazer nossos corações baterem no mesmo compasso! 🥁"
  ],
  
  stopped: [
    "🎵 O último acorde foi tocado... até a próxima apresentação! ✨",
    "🎶 A cortina se fecha, mas a música permanece em nossos corações! 💜",
    "🎤 Silêncio... para que a próxima melodia soe ainda mais doce! 🎭"
  ],
  
  error: [
    "🎵 Ops! Parece que uma corda desafinou... vamos tentar novamente! 💫",
    "🎶 Uma pequena dissonância no ar... mas logo voltamos ao ritmo! 💜",
    "🎤 Até as melhores apresentações têm seus improvisos! Vamos lá! ✨"
  ]
} as const;

export const getRandomPhrase = (category: keyof typeof MusaPhrases): string => {
  const phrases = MusaPhrases[category];
  const randomIndex = Math.floor(Math.random() * phrases.length);
  return phrases[randomIndex] || phrases[0];
};
