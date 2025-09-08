# Plano do Comando `/playlist` — Itens Restantes

Resumo: implementação principal concluída (detecção de providers, ingestão YouTube/Spotify, primeiro flush imediato, lotes configuráveis, dedupe opcional, fallback “playlist cheia”, progresso com debounce, thumbnails nas buscas e preferência YT Music auto‑desativável quando não suportada pelo yt-dlp). Abaixo, apenas o que falta ou é opcional.

## Melhorias Opcionais

- Ordem avançada (playOrder):
  - Implementado: `queueId` estável por item e suporte a restaurar ordem original.
  - Novo: `/shuffle mode:on|off` — `on` embaralha as “não tocadas”; `off` restaura a ordem original.
  - Compatível com Announcer e prefetch (usam a ordem atual da fila).

- Dedupe mais amplo (opcional):
  - Hoje o dedupe atua na ingestão corrente; opção para dedupe global contra itens já presentes na fila.

- Observabilidade e métricas:
  - Contadores para “primeiro flush”, “playlist cheia”, “near‑expire refresh”, “429 Spotify”, etc.
  - Logs agregados de tempo por etapa (ingestão total, resolução média por faixa).

- Admin/Runtime tuning (opcional):
  - Comandos de admin para ajustar `YT_PLAYLIST_BATCH`, `SPOTIFY_PLAYLIST_BATCH`, `SPOTIFY_RESOLVE_CONCURRENCY`, `DEDUPE_PLAYLIST` sem reinício.

- Testes automatizados:
  - Unit: parser de URLs (incluindo Spotify com locale), heurísticas do `TrackResolver`, normalização de títulos.
  - Integração: ingestão YouTube/Spotify pequenas, primeiro flush, fallback playlist cheia.
  - Smoke: playlists médias (100–300), validação do “Continuar” via offset/limit.

## Documentação

- Manter README/docs atualizados ao evoluir valores padrão e exemplos.

---

Valores atuais recomendados:
- `YT_PLAYLIST_BATCH=100`, `SPOTIFY_PLAYLIST_BATCH=50`
- `SPOTIFY_RESOLVE_CONCURRENCY=4`
- `DEDUPE_PLAYLIST=true`
  - Revalidação automática quando `expiresAt` < 5min e o item está dentro da janela `preload`.
  - Telemetria: contador de hits/misses de cache e tempos de resolução.

## Mensagens ao Usuário

- Início: “Carregando playlist do <provider>…”.
- Progresso: “Lidos 100/532…”, “Adicionados 100 à fila…”.
- Resultado: título, total, quantas adicionadas, “Próximas N: …”.
- Spotify: avisar discretamente “stream via YouTube” ao final.

## Performance e Limites

- Processamento em lotes (50–100); publicar progresso incremental.
- Cache persistente para resoluções Spotify→YouTube (TTL por dias/semanas).
- Evitar pré-carregar toda a playlist; manter janela móvel `preload`.
- Debounce de updates para evitar flood no chat.
- Playlists gigantes (5k+): impor `--limit` padrão (ex.: 500) com aviso e opção de ampliar.

## Tratamento de Erros e Bordas

- Playlist privada/indisponível: mensagem clara; não alterar fila.
- Itens privados/removidos (YouTube): pular e contar como “ignorados”.
- Matching com baixa confiança: tentar próximos candidatos; se persistir, marcar como “baixa confiança” (exibir ✳︎).
- Region lock / age restricted: tentar fallback; se falhar, marcar como não tocável.
- Duplicados: opção de deduplicar por assinatura (configurável).
- Lives/streams contínuos: ignorar por padrão; permitir com flag específica.

## Testes

- Unitários: parser de URLs, lógica de shuffle, janela de prefetch, heurísticas de matching, cache hit/miss.
- Integração: playlist pequena YouTube e Spotify; verificar anúncio de “próximas músicas”.
- Stress: playlist grande (≥1k) com `--limit`; medir tempo de carga e número de requests.
- Regressão: alternar shuffle on/off durante reprodução e checar atualização de mensagem.

## Roadmap de Implementação

1) Esqueleto e UX do comando
- Parser de flags; detecção de provider; mensagens básicas de progresso.

2) Provider YouTube/YouTube Music
- Listagem via `yt-dlp` (`--flat-playlist`).
- Enfileirar itens; anunciar próximas N (sem prefetch novo).

3) Provider Spotify (Web API)
- Autenticação Client Credentials; fetch paginado de tracks.
- Mapear para `Track` com `lookupQuery` pronto.

4) AudioResolver com prioridade YT Music
- Busca `ytmusicsearch`→`ytsearch` com heurísticas e cache.
- Interface de resolução retornando `ytVideoId`, `confidence` e, sob demanda, `streamUrl`.

5) Integração com Prefetch existente
- Usar `preload=2` por padrão; respeitar janela baseada em `currentOrder`.
- Revalidação próximo da expiração.

6) Shuffle e Ordem de Reprodução
- Implementar `originalOrder/currentOrder` com `queueId` estável.
- Atualizar anúncio e acionar refresh do prefetch no toggle.

7) Robustez, limites e métricas
- Rate limiting/backoff; telemetria; mensagens de erro refinadas.

8) Polimento e flags finais
- `--limit`, `--announce`, `--preload`, `--source`; UX final.

## Valores Padrão Recomendados

- `--announce 5`: boa visibilidade sem poluir.
- `--preload 2`: consistente com o prefetch atual e custo baixo.
- `--limit 500`: proteção contra playlists gigantes; mensagem indicando como ampliar.
- `maxConcurrentPrefetch 2`: evita esquentar demais e reduz risco de rate limit.

---

Caso queira, posso complementar com contratos de interface (TypeScript/JS) para `PlaylistProvider`, `AudioResolver` e estrutura de `QueueState`, já adaptados ao seu código atual.

---

## Estado Atual (código mapeado)

- `src/services/MusicManager.ts:558`: possui prefetch de URLs (reagendado no shuffle) e usa `guildData.queue.slice(0, count)` como janela de próximas músicas. O prefetch é acionado em `addToQueue` e em `shuffleQueue`.
- `src/commands/shuffle.ts`: embaralha in-place `guildData.queue` e chama `musicManager.shuffleQueue(...)` que por sua vez agenda prefetch e atualiza o status.
- `src/services/Announcer.ts`: constrói a mensagem principal e exibe “Próximas músicas” a partir de `data.queue.slice(0, 6)`.
- `src/services/MultiSourceManager.ts`: agrega serviços e encaminha `search(query)`. Hoje suporta YouTube (direto ou via resolver), Internet Archive e rádio.
- `src/services/YouTubeService.ts`: faz `yt-dlp` com `ytsearchN:` e extrai stream por `--get-url`.
- `src/services/ResolverYouTubeService.ts`: usa `RESOLVER_URL` quando disponível; fallback para `yt-dlp`. Também usa `ytsearchN:`.

Conclusão: a arquitetura atual já atende prefetch e atualização de “próximas músicas” baseada em queue. Precisamos adicionar o comando `/playlist`, os providers (YT/Spotify) e priorizar “YouTube Music → YouTube” na busca. Para grandes inserções, é recomendável adicionar um método de inserção em lote na queue.

## Mudanças Necessárias (precisas no repo)

1) Priorizar YT Music nas buscas YouTube
- Alterar YouTube search para tentar `ytmusicsearchN:` primeiro, fallback para `ytsearchN:`.
  - `src/services/YouTubeService.ts`: substituir a construção do `searchQuery` por uma rotina que:
    - Rode `yt-dlp -j --quiet "ytmusicsearch${maxResults}:<QUERY>"`.
    - Se nenhum resultado válido, rode `ytsearch${maxResults}:<QUERY>`.
  - `src/services/ResolverYouTubeService.ts` (fallback direto via yt-dlp): mesma lógica acima no método de busca direta.
  - Opcional (fortemente recomendado): atualizar o servidor em `youtube-resolver/server.js` para usar YT Music primeiro ao atender `POST /search` (compatível com `ResolverYouTubeService`).

2) Novo comando `/playlist`
- Criar `src/commands/playlist.ts` com opções: `url` (obrigatória), `--limit`, `--offset`, `--announce`, `--preload`, `--source`.
- Fluxo:
  1. Validar canal de voz e permissões (reutilizar `play.ts` → `validatePlayRequest`).
  2. Detectar provider pela URL (YouTube/YouTube Music/Spotify).
  3. Buscar itens da playlist em lotes (50–100) com providers dedicados (abaixo).
  4. Resolver URLs de stream somente conforme necessário:
     - YouTube/YouTube Music: já teremos `videoId`/URL — não precisa resolver agora.
     - Spotify: montar `lookupQuery` e usar busca YT Music→YouTube para mapear para vídeo do YouTube.
  5. Adicionar à fila em lote (novo método `addManyToQueue`) e publicar progresso e resumo.

3) Providers de Playlist
- Criar pasta `src/services/providers/` com:
  - `YouTubePlaylistProvider.ts`: lista itens via `yt-dlp --flat-playlist` e retorna `{ title, url, creator?, duration? }` quando possível. Para flat-playlist, construir URL `https://www.youtube.com/watch?v=<id>`.
  - `SpotifyPlaylistProvider.ts`: usa Spotify Web API (Client Credentials) para listar faixas com `{ title, artists[], durationMs, isrc?, album?, external_urls.spotify }`.
- Criar `src/utils/providers.ts` com `detectProvider(url: string): 'youtube'|'ytm'|'spotify'|'unknown'`.

4) Resolvedor/Matcher para Spotify → YouTube
- Criar `src/services/TrackResolver.ts`:
  - `resolveToYouTube(candidate: { title: string; artists: string[]; durationMs?: number }): Promise<{ url: string; confidence: number; title: string; creator?: string; duration?: number }>`
  - Usa `MultiSourceManager.getService('youtube')?.search(query, N)` com query normalizada; preferência YT Music.
  - Score por duração ±5–7s, canal “Topic”, “Provided to YouTube”, penalizar “live/cover/sped up/nightcore”.
  - Cache leve em memória por assinatura (título|artista|duração) com TTL (minutos/horas) para reduzir chamadas.

5) Inserção em lote na fila (para performance)
- Adicionar em `src/services/MusicManager.ts` um método:
  - `addManyToQueue(guildId: string, songs: QueuedSong[], requestedById?: string): Promise<void>`
  - Empurrar todas as músicas, atualizar `lastAdded` com o último item, disparar um único `schedulePrefetch(guildId)` e uma única atualização de status via `Announcer.updateGuildStatus`.
- Motivo: evitar editar a mensagem e reagendar prefetch centenas de vezes ao adicionar playlists grandes.

6) Ajustes de Configuração (.env)
- Atualizar `src/config/schema.ts` para incluir credenciais Spotify (Client Credentials):
  - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`.
  - Opcional: `SPOTIFY_TIMEOUT_SECONDS` (default 10–15s).
- Incluir na `README.md` e `.env.template` as novas variáveis.

7) Opcional: playOrder (original vs atual)
- Fase opcional caso queira alternar shuffle on/off mantendo ordem original:
  - Adicionar em `GuildMusicData` campos `originalOrder?: QueuedSong[]` e `orderVersion?: number` ou estruturar com `queueId` estável e arrays `originalOrder`/`currentOrder`.
  - Alterar `shuffleQueue` para embaralhar apenas a subsequência “ainda não tocada”, preservando atual e já tocadas.
  - Atualizar Announcer e prefetch para usar `currentOrder` (mantendo compatibilidade com a janela de próximas músicas).
  - Observação: a abordagem atual (embaralhar `queue` in-place) funciona e pode ser mantida inicialmente.

## Contratos de Interface (propostos)

1) Providers
```ts
// src/services/providers/types.ts
export interface PlaylistItemCandidate {
  title: string;
  artists?: string[];
  creator?: string;
  durationMs?: number;
  provider: 'youtube'|'ytm'|'spotify';
  providerUrl: string; // URL da playlist ou da faixa (canonical)
  youtubeVideoUrl?: string; // preenchido quando já houver (YT/YTM)
}

export interface PlaylistProvider {
  supports(url: string): boolean;
  getMeta(url: string): Promise<{ id: string; title?: string; total?: number } | null>;
  fetchItems(url: string, opts?: { limit?: number; offset?: number }): AsyncGenerator<PlaylistItemCandidate>;
}
```

2) Track Resolver (Spotify → YouTube)
```ts
// src/services/TrackResolver.ts
export interface TrackResolverResult {
  url: string; // YouTube video URL
  confidence: number; // 0..1
  title: string;
  creator?: string;
  duration?: number; // seconds
}

export class TrackResolver {
  constructor(private multi: MultiSourceManager) {}
  resolveToYouTube(candidate: { title: string; artists: string[]; durationMs?: number }): Promise<TrackResolverResult | null>;
}
```

3) Método de inserção em lote
```ts
// src/services/MusicManager.ts
async addManyToQueue(guildId: string, songs: QueuedSong[], requestedById?: string): Promise<void>;
```

## Fluxo do Comando `/playlist`

1) Parse e validação
- Reutilizar `validatePlayRequest` de `src/commands/play.ts`.
- Determinar `provider = detectProvider(url)`; se `--source` presente, sobrepor.

2) Carregamento da playlist (em lotes)
- YouTube/YT Music: `YouTubePlaylistProvider.fetchItems` via `yt-dlp --flat-playlist` (paginado com `--playlist-start/--playlist-end` se preciso).
- Spotify: `SpotifyPlaylistProvider.fetchItems` via Web API (`GET /v1/playlists/{id}/tracks`), paginado (limit=100).

3) Transformação em `QueuedSong[]`
- YT/YTM: cada item já tem `youtubeVideoUrl` ⇒ criar `QueuedSong` com `service: 'youtube'`, `url`, `title`, `creator?`, `duration?` (se disponível), `requestedBy`.
- Spotify: montar `lookupQuery` `"<artist principal> - <title>"`, chamar `TrackResolver.resolveToYouTube`, e criar `QueuedSong` com `service: 'youtube'`, `url` do YouTube, metadados herdados.

4) Inserção e progressos
- Acumular em lotes de 50–100; a cada lote, chamar `musicManager.addManyToQueue(guildId, lote, member.id)`.
- Atualizar a resposta ephemera: “Lidos X/Y… Adicionados Z… Próximas N: …”.
- Ao final, enviar resumo com título e total da playlist.

5) Prefetch
- Já será acionado pelo `addManyToQueue` (um único `schedulePrefetch`). O prefetch vigente já usa as 2 próximas (`botConfig.music.prefetchCount`).

## Heurísticas de Matching (Spotify → YouTube)

- Busca: YT Music (top 5) → fallback YouTube (top 5).
- Score: duração (±5–7s), canal “Topic”/“Provided to YouTube”, penalizar `live/cover/sped up/nightcore`. Preferir “Official Audio/Video”.
- Normalização do query: remover sufixos “(Official Video)”, “(Audio)”, padronizar `feat.`/`ft.`.
- Cache: chave `hash(title|artists|durationMs)` ⇒ `{ videoUrl, confidence, ts }` com TTL (ex.: 7 dias).

## Concurrency e Rate Limiting

- Limitar concorrência de buscas de matching (ex.: 3 promessas simultâneas) para reduzir 429/timeouts.
- `yt-dlp` de playlists roda uma vez por página/lote; economiza chamadas.
- Backoff exponencial simples (200ms, 500ms, 1s) em falhas transitórias.

## Alterações Pontuais (arquivos)

- `src/services/YouTubeService.ts`: preferir YT Music na busca (ver seção “Mudanças Necessárias 1”).
- `src/services/ResolverYouTubeService.ts`: ajustar fallback direto (yt-dlp) para YT Music → YouTube; opcionalmente enviar `preferYtMusic` ao resolver.
- `youtube-resolver/server.js`: ajustar o endpoint `/search` para YT Music primeiro.
- `src/commands/playlist.ts`: novo comando com fluxo descrito.
- `src/services/providers/YouTubePlaylistProvider.ts`: listar itens de playlists YouTube/YT Music.
- `src/services/providers/SpotifyPlaylistProvider.ts`: consumir Spotify Web API e produzir candidatos.
- `src/services/TrackResolver.ts`: resolver Spotify → YouTube com cache leve.
- `src/utils/providers.ts`: `detectProvider(url)`.
- `src/services/MusicManager.ts`: adicionar `addManyToQueue` e usá-lo no comando `/playlist` (chamadas bateladas).
- `src/config/schema.ts`: incluir `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` (Client Credentials), com validação básica.
- `.env.template`: adicionar as variáveis Spotify e breve instrução.

## Observações de Compatibilidade

- Manter `QueuedSong.service = 'youtube'` para itens mapeados do Spotify (o pipeline atual só pré-carrega YouTube: `src/services/MusicManager.ts:585`). Para UX, podemos exibir no texto final “stream via YouTube”.
- Shuffle atual (in-place) já reativa o prefetch e atualiza o embed; a melhoria `playOrder` é opcional.
- Announcer atual edita a mesma mensagem; a inserção em lote evita spam de atualizações.

## Checklist de Implementação (resumido)

1. Ajustar buscas YouTube para YT Music → YouTube.
2. Criar comando `/playlist` e detecção de provider.
3. Implementar providers YT/YTM e Spotify.
4. Implementar `TrackResolver` (Spotify → YouTube) com cache e limites de concorrência.
5. Adicionar `addManyToQueue` no `MusicManager` e usar no comando.
6. Atualizar `.env.template` e `schema.ts` com credenciais Spotify.
7. (Opcional) Atualizar `youtube-resolver` para YT Music primeiro.
8. Testes: unitários de parser/matching e integração com playlists pequenas.

---

Apontadores úteis no código para integração:
- `src/services/MusicManager.ts:559` agenda e `src/services/MusicManager.ts:575` executa o prefetch das próximas.
- `src/services/Announcer.ts` monta “Próximas Músicas” a partir da queue (6 itens) e já lida com edição de mensagem.
- `src/commands/play.ts` traz validação e padrão de resposta reusáveis no `/playlist`.

Pronto para iniciar a codificação com este plano? Se quiser, posso abrir os stubs dos arquivos citados para acelerar o bootstrap.

---

## Etapas para o Início do Desenvolvimento

Etapa 1 — Preparação e ajustes de base
- Conferir/env: `.env`, `.env.template` (YTDLP_COOKIES/PROXY, RESOLVER_URL, MUSA_CHANNEL_ID).
- Schema: adicionar `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` em `src/config/schema.ts` (client credentials) e mapear em `BotConfig`.
- Habilitar serviço YouTube em env (`ENABLE_YOUTUBE=true`) e revisar prioridades.
- Utilitário: criar `src/utils/providers.ts` com `detectProvider(url)` (youtube|ytm|spotify|unknown).

Etapa 2 — YouTube: priorizar YouTube Music na busca
- `src/services/YouTubeService.ts`: no `search`, tentar `ytmusicsearchN:` (top N) e, se vazio, `ytsearchN:`.
- `src/services/ResolverYouTubeService.ts`: no fallback direto (yt-dlp), mesma lógica de YT Music → YouTube.
- `youtube-resolver/server.js` (opcional, recomendado): alterar `/search` para priorizar YT Music.

Etapa 3 — Provider: Playlists YouTube/YT Music
- Criar `src/services/providers/YouTubePlaylistProvider.ts` com listagem via `yt-dlp --flat-playlist` (NDJSON).
- Implementar paginação (`--playlist-start/--playlist-end`) e `getMeta` (título/total) quando possível.
- Normalizar items para `{ title, youtubeVideoUrl, providerUrl, duration?, creator? }`.

Etapa 4 — Inserção em lote na fila
- `src/services/MusicManager.ts`: adicionar `addManyToQueue(guildId, songs[], requestedById?)`.
- Empurrar todos os itens, atualizar `lastAdded` (do último), chamar `schedulePrefetch(guildId)` uma vez.
- Uma única chamada a `Announcer.updateGuildStatus` com payload consolidado.

Etapa 5 — Comando `/playlist` (esqueleto + caminho YouTube)
- Criar `src/commands/playlist.ts` com opções: `url` (obrigatória), `--limit`, `--offset`, `--announce`, `--preload`, `--source`.
- Reutilizar `validatePlayRequest` de `src/commands/play.ts`.
- Detectar provider (YouTube/YTM): iterar `YouTubePlaylistProvider.fetchItems` em lotes (50–100), mapear para `QueuedSong` e chamar `addManyToQueue` por lote.
- Feedback: progresso ephemera (“Lidos X/Y… Adicionados Z…”) e resumo.

Etapa 6 — TrackResolver (Spotify → YouTube)
- Criar `src/services/TrackResolver.ts` usando `MultiSourceManager.getService('youtube')?.search`.
- Normalização de query (`"<artist> - <title>"`), heurísticas (duração ±5–7s, Topic/Provided, penalidades live/cover/sped up), cálculo de `confidence`.
- Cache in-memory por assinatura (título|artistas|duração) com TTL (dias) para reduzir chamadas.

Etapa 7 — Provider: Playlists Spotify (Web API)
- Cliente: autenticação Client Credentials, `GET /v1/playlists/{id}` e `/tracks?limit=100&offset=…`.
- Extrair `title`, `artists[]`, `durationMs`, `isrc?`, `thumbnails`, `external_urls.spotify`.
- Para cada faixa, chamar `TrackResolver` (com limite de concorrência global, ex.: 3–5).
- Agrupar em lotes e alimentar a fila via `addManyToQueue` com progresso.

Etapa 8 — Integração completa do `/playlist`
- Unificar a rota do comando: YouTube/YTM e Spotify sob o mesmo fluxo (detecção + provider + lote + inserção).
- `--limit`/`--offset` respeitados em ambos os providers; `--source` para forçar provider se necessário.
- Mensagem final inclui “stream via YouTube” quando a origem é Spotify.

Etapa 9 — Prefetch e robustez
- Validar integração: prefetch atual reage a `addManyToQueue` e `shuffle` (já existente em `src/services/MusicManager.ts:559`).
- Revalidação: se `expiresAt` (quando disponível) < 5min e item na janela, re-resolver.
- Tratamento de bordas: itens privados/removidos, age-restricted, low-confidence (marcar e seguir), deduplicação opcional.

Etapa 10 — Observabilidade e limites
- Logs: adicionar eventos chave nas novas rotas (providers, resolver, playlist command).
- Rate-limit/backoff: limitar concorrência para resolver Spotify→YouTube e reintentar com backoff exponencial leve.
- Métricas: contadores de acerto de cache, tempo por etapa, falhas.

Etapa 11 — Documentação e env
- Atualizar `.env.template` com credenciais Spotify e flags do `/playlist`.
- README: seção de uso do `/playlist`, exemplos e notas sobre limites (`--limit` default 500).

Etapa 12 (Opcional) — Ordem avançada (playOrder)
- Introduzir `originalOrder/currentOrder` (ou `queueId` estável) mantendo compatibilidade com Announcer e prefetch.
- Embaralhar apenas o trecho “não tocado”, preservar atual e já tocadas.
- Marcar como melhoria futura; não bloquear o release.
