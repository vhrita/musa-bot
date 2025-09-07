# 🎵 Musa Bot - The Music Fairy

<div align="center">
  <img src="musa.png" alt="Musa - Fairy of Music" width="300">
  <br>
  <em>Musa, the Fairy of Music from Winx Club</em>
</div>

## 💫 About Musa

Musa is inspired by the music fairy from Winx Club, bringing magical musical experiences to Discord servers. Originally created for the **WINX** Discord channel (established in 2016), Musa has been the soundtrack companion for a tight-knit gaming community of friends for nearly a decade.

Named after the fairy of music herself, Musa embodies the spirit of bringing people together through the power of music, just like how the WINX server has connected friends through gaming and conversation since 2016.

> **📜 Legacy Version**: The original Python implementation has been preserved in the [`legacy`](https://github.com/vhrita/musa-bot/tree/legacy) branch for historical reference.

## ✨ Modern Architecture & Features

### 🎯 Built with TypeScript
- **Type Safety**: Full TypeScript implementation for robust development
- **Modern Node.js**: Latest practices and ES2022+ features
- **Enhanced Performance**: Optimized memory management and async processing
- **Scalable Design**: Modular architecture with proper separation of concerns

### 🔄 Advanced Capabilities
- **Multi-Source Architecture**: Intelligent music source prioritization and fallback
- **Advanced Voice Management**: Robust connection handling with automatic recovery
- **Rich Discord Integration**: Beautiful themed embeds with Musa's musical personality
- **Comprehensive Logging**: Detailed event tracking and structured error handling
- **Configuration Management**: Flexible environment-based configuration system
- **Docker Support**: Full containerization with optimized production builds

## 🏗️ Technical Architecture

### 🎼 Intelligent Multi-Source Music System
- **🎵 YouTube** (Priority 1) - Vast music library with advanced search
- **📻 Radio Stations** (Priority 2) - Live streaming for continuous music
- **📚 Internet Archive** (Priority 3) - High-quality audio archives

### 🛡️ Smart Quality Filtering
- Intelligent file size analysis and validation
- Creator validation to avoid low-quality uploads
- Duration optimization for optimal listening experience
- Automatic filtering of non-music content

### 🎨 Musa's Musical Personality
- **Purple Theme**: Consistent purple color scheme (🟣 #8B5DBC)
- **Musical Language**: Commands respond with rhythm and music metaphors
- **Fairy Magic**: Sparkles, notes, and magical elements throughout
- **Warm Personality**: Friendly, encouraging responses with musical flair

## 🚀 Quick Start

### 📋 Prerequisites
- Node.js 18+ 
- npm or yarn
- Discord Bot Token
- FFmpeg (for audio processing)

### 🛠️ Installation

1. **Clone the repository**:
```bash
git clone https://github.com/vhrita/musa-bot.git
cd musa-bot
```

2. **Install dependencies**:
```bash
npm install
```

3. **Configure environment**:
```bash
cp .env.template .env
# Edit .env with your Discord token and preferences
```

4. **Build and start**:
```bash
# Development mode
npm run dev

# Production build
npm run build
npm start
```

### 🐳 Docker Deployment (Recommended)

#### Production Deployment
```bash
# Using docker-compose (recommended)
docker-compose up -d

# Or build and run manually
docker build -t musa-bot .
docker run -d --name musa-bot-container --env-file .env musa-bot
```

#### Development with Debugging
```bash
# Build debug image
docker build -f Dockerfile.debug -t musa-bot-debug .

# Run with debugging enabled (port 9229)
docker run --rm -p 9229:9229 --env-file .env -v $(pwd)/logs:/app/logs musa-bot-debug
```

## 📁 Project Structure

```
musa-bot/
├── 🎭 src/
│   ├── commands/           # Slash commands
│   ├── events/            # Discord event handlers
│   ├── services/          # Music services & management
│   ├── types/             # TypeScript type definitions
│   ├── utils/             # Utility functions
│   ├── config/            # Configuration management
│   └── index.ts           # Main application entry
├── 🏗️ dist/               # Compiled JavaScript (generated)
├── 🔧 .env                # Environment configuration
├── 📊 logs/               # Application logs
├── 🍪 cookies/            # YT-DLP cookies (if using YouTube)
├── 📦 package.json        # Dependencies & scripts
├── ⚙️ tsconfig.json       # TypeScript configuration
├── 🐳 Dockerfile          # Production container
├── 🧪 Dockerfile.debug    # Development container
└── 🐙 docker-compose.yml  # Production orchestration
```

## 🎵 Commands Overview

### 🎼 Music Commands
- `/play <query|url>`
  - Query: searches across sources (YouTube/YouTube Music) and adds the best match
  - URL YouTube/YouTube Music: plays the video directly (with rich metadata)
  - URL Spotify (track): fetches metadata via Spotify API and plays the matching version on YouTube
- `/playlist <url> [limit] [offset] [source]`
  - Adds an entire playlist from YouTube/YouTube Music/Spotify
  - Immediate first‑track flush: playback starts as soon as the first resolved item is added
  - Batch ingestion (tunable), dedupe optional, progress updates and “continue” hint with offset
- `/radio <genre>` - Add curated radio stations by genre  
- `/queue` - Display current playlist with rich UI (now + next tracks)
- `/skip` - Skip to next track
- `/pause` / `/resume` - Playback control
- `/stop` - Stop music and clear queue
- `/shuffle` - Randomize playlist order (re-evaluates prefetch)

### 🎨 Visual Features
- **Purple Embeds**: Musa's signature color scheme
- **Musical Emojis**: Notes, instruments, and fairy elements
- **Service Icons**: Visual indicators for different music sources
- **Rich Information**: Duration, artist, queue position, and more

## ⚙️ Configuration

The bot follows 12‑factor config with a validated schema (Zod). See full, up‑to‑date configuration and defaults here:

- docs/BOT_CONFIG.md
- youtube-resolver/README.md (for the Raspberry Pi resolver)

Key highlights (new):
- Spotify
  - `ENABLE_SPOTIFY=true`
  - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (Client Credentials)
  - `SPOTIFY_TIMEOUT_SECONDS` (default 12), `SPOTIFY_MARKET` (default `US`)
- Playlist ingestion tuning
  - `YT_PLAYLIST_BATCH` (default 100)
  - `SPOTIFY_PLAYLIST_BATCH` (default 50)
  - `SPOTIFY_RESOLVE_CONCURRENCY` (default 4)
  - `DEDUPE_PLAYLIST` (default true)
- Resolver/YouTube
  - `RESOLVER_URL` to use the external resolver
  - `COOKIES_PATH`/`YTDLP_COOKIES` to enable age-restricted access and richer metadata (thumbnails)

## 🎯 Gaming Community Legacy

Since 2016, Musa has been the musical heartbeat of the WINX Discord server, providing:
- **Ambient Gaming Music**: Perfect background tracks for gaming sessions
- **Community Bonding**: Shared musical experiences that bring friends together
- **Nostalgia Factor**: Soundtrack to countless memories and adventures
- **Reliability**: Nearly a decade of faithful service to the gaming community

## 🔮 Continuous Evolution

Musa continues to evolve while maintaining her core mission: bringing friends together through music. Built with modern TypeScript architecture, she's designed for reliability, performance, and extensibility.

Whether it's providing the perfect soundtrack for an epic gaming session or discovering new music together, Musa remains the magical musical companion for the WINX community and beyond.

> **🎵 Fun Fact**: Nearly a decade of faithful service to the gaming community, now with modern technology ensuring many more years of magical musical experiences!

## 🛠️ Development

### 📚 Tech Stack
- **TypeScript** - Type-safe development
- **Discord.js v14** - Discord API wrapper
- **@discordjs/voice** - Voice connection handling
- **Winston** - Logging framework
- **Axios** - HTTP client for API calls
- **ESLint** - Code linting and formatting

### 🧪 Development Scripts
```bash
npm run dev        # Development with hot reload
npm run build      # Production build
npm run start      # Start production build
npm run lint       # Run ESLint
npm run lint:fix   # Fix linting issues
npm test           # Run tests (when implemented)
```

## 📚 Additional Docs

- docs/BOT_CONFIG.md — Bot environment variables, defaults and behavior
- youtube-resolver/README.md — Resolver usage, security and configuration
- docs/TODO.md — Backlog and follow‑ups

## 🧩 Resolver Notes (YouTube)

- The resolver prefers YouTube Music when supported by `yt-dlp`. If the installed `yt-dlp` doesn't support the `ytmusicsearchN:` pseudo-URL, the resolver automatically disables this preference and falls back to `ytsearch` (YouTube) without spamming errors.
- For richer metadata (including thumbnails) the resolver avoids `--flat-playlist` for searches, and supports cookies via `COOKIES_PATH`.

## 🎛️ Playlist Ingestion UX

- The first track is flushed immediately for quick playback start; subsequent items are added in batches (see env tuning above).
- When the queue hits `MAX_QUEUE_SIZE`, the bot shows a friendly message with how to continue using `/playlist` and the suggested `offset`.
- Dedupe option avoids adding duplicates within the same ingestion when enabled.

### 🐳 Docker Development
```bash
# Production testing
docker-compose up --build

# Debug mode
docker build -f Dockerfile.debug -t musa-bot-debug .
docker run --rm -p 9229:9229 --env-file .env musa-bot-debug
```

### 🤝 Contributing
1. Fork the repository
2. Create a feature branch
3. Follow TypeScript and ESLint conventions
4. Test your changes thoroughly
5. Submit a pull request

---

<div align="center">
  <img src="musa.png" alt="Musa - Fairy of Music" width="200">
  <br>
  <em>"In the power of music, we find the magic that connects us all"</em>
  <br>
  <strong>- Inspired by Musa, Fairy of Music 🎵✨</strong>
  <br><br>
  <strong>Built with ❤️ in TypeScript</strong>
</div>
