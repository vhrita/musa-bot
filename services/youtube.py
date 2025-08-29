import asyncio
import contextlib
import urllib.request
import yt_dlp
from config import COOKIES_PATH, YTDLP_PROXY
from utils.logging import log_event

@contextlib.contextmanager
def temporary_proxy_opener():
    """
    A context manager that temporarily installs a proxy opener for urllib
    and restores the original opener upon exit.
    """
    if not YTDLP_PROXY:
        yield
        return

    log_event("installing_proxy_opener")
    original_opener = urllib.request._opener
    
    proxy_handler = urllib.request.ProxyHandler({
        'http': YTDLP_PROXY,
        'https': YTDLP_PROXY,
    })
    
    opener = urllib.request.build_opener(proxy_handler)
    urllib.request.install_opener(opener)
    
    try:
        yield
    finally:
        log_event("restoring_original_opener")
        urllib.request.install_opener(original_opener)

def get_ydl_options():
    """Returns a dictionary with base yt-dlp options."""
    return {
        "format": "bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "ignore_no_formats_error": True,
        "geo_bypass": True,
        "retries": 2,
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "web", "tv"]
            }
        },
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://www.youtube.com/"
        }
    }

async def search_ytdlp_async(query, ydl_opts):
    loop = asyncio.get_running_loop()
    
    def _extract():
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(query, download=False)

    # O proxy é ativado apenas para esta chamada
    with temporary_proxy_opener():
        return await loop.run_in_executor(None, _extract)

async def extract_info(query: str):
    # Log de debug do ambiente
    log_event("debug_environment", 
             proxy_configured=bool(YTDLP_PROXY),
             proxy_value=YTDLP_PROXY[:50] + "..." if YTDLP_PROXY and len(YTDLP_PROXY) > 50 else YTDLP_PROXY,
             cookies_path=COOKIES_PATH)
    
    ydl_options = get_ydl_options()
    ydl_options.update({
        "noplaylist": True,  # Sempre uma música só
        "extract_flat": False,  # Extrair info completa
        "default_search": "ytsearch1",  # Apenas 1 resultado
    })

    if COOKIES_PATH:
        ydl_options["cookiefile"] = COOKIES_PATH
        log_event("youtube_cookies_loaded", path=COOKIES_PATH)
    else:
        log_event("youtube_cookies_not_found", path=COOKIES_PATH)

    search_query = query.strip()
    if not search_query.startswith(("http://", "https://")):
        search_query = f"ytsearch1:{search_query}"

    log_event("extract_info_start", query=search_query)

    try:
        with temporary_proxy_opener():
            log_event("extract_info_start", query=search_query)
            
            # Criar a instância do yt-dlp
            with yt_dlp.YoutubeDL(ydl_options) as ydl:
                result = ydl.extract_info(search_query, download=False)
                
                log_event("ytdlp_raw_result", 
                    has_results=bool(result),
                    result_type=type(result).__name__,
                    result_keys=list(result.keys()) if isinstance(result, dict) else None
                )
                
                # Se é resultado de busca (playlist), precisamos extrair info completa do primeiro vídeo
                if result and result.get('_type') == 'playlist' and 'entries' in result and result['entries']:
                    log_event("extract_info_playlist_found", entries_count=len(result['entries']))
                    first_entry = result['entries'][0]
                    
                    # Extrair informações completas do primeiro vídeo encontrado
                    if 'id' in first_entry:
                        video_id = first_entry['id']
                        log_event("extract_info_extracting_video", video_id=video_id)
                        
                        # Extrair info completa do vídeo específico com logs detalhados
                        try:
                            video_result = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
                            log_event("video_extraction_success", video_id=video_id, has_result=bool(video_result))
                        except Exception as video_error:
                            log_event("video_extraction_error", video_id=video_id, error=str(video_error))
                            video_result = None
                        
                        if video_result and 'formats' in video_result:
                            formats = video_result.get('formats', [])
                            log_event("ytdlp_formats_info",
                                formats_count=len(formats),
                                has_formats=bool(formats),
                                first_format_keys=list(formats[0].keys()) if formats else None
                            )
                            
                            log_event("ytdlp_video_info",
                                title=video_result.get('title'),
                                id=video_result.get('id'),
                                webpage_url=video_result.get('webpage_url'),
                                url=video_result.get('url')
                            )
                            
                            log_event("extract_info_video_complete")
                            final_result = [video_result]
                            log_event("extract_info_returning", count=len(final_result), type="video_complete")
                            return final_result
                        else:
                            log_event("video_extraction_no_formats", 
                                     has_video_result=bool(video_result),
                                     video_keys=list(video_result.keys()) if video_result else None)
                
                # Fallback para resultado direto
                if result and 'formats' in result:
                    formats = result.get('formats', [])
                    log_event("ytdlp_formats_info",
                        formats_count=len(formats),
                        has_formats=bool(formats),
                        first_format_keys=list(formats[0].keys()) if formats else None
                    )
                else:
                    log_event("ytdlp_formats_info",
                        formats_count=0,
                        has_formats=False,
                        first_format_keys=None
                    )
                
                log_event("ytdlp_video_info",
                    title=result.get('title') if result else None,
                    id=result.get('id') if result else None,
                    webpage_url=result.get('webpage_url') if result else None,
                    url=result.get('url') if result else None
                )
                
                if result and result.get('_type') == 'playlist' and 'entries' in result:
                    log_event("extract_info_single_result")
                    final_result = [result['entries'][0]] if result['entries'] else []
                    log_event("extract_info_returning", count=len(final_result), type="playlist_entry")
                    return final_result
                
                final_result = [result] if result else []
                log_event("extract_info_returning", count=len(final_result), type="direct_result")
                return final_result
    except Exception as e:
        log_event("extraction_error", error=str(e))
        return []

def resolve_song(song_info: dict):
    log_event("resolve_song_start", 
             title=song_info.get("title"),
             has_formats=bool(song_info.get("formats")),
             formats_count=len(song_info.get("formats", [])))
    
    title = song_info.get("title") or song_info.get("webpage_url") or "Untitled"
    duration = song_info.get("duration")
    thumbnail = song_info.get("thumbnail")
    audio_url = None
    fmts = song_info.get("formats") or []

    log_event("resolve_song_formats_detail",
             formats_available=len(fmts),
             sample_format=fmts[0] if fmts else None)

    if fmts:
        def score(f):
            if f.get("vcodec") not in (None, "none"): return -1
            if not f.get("url"): return -1
            s = 0
            ac = (f.get("acodec") or "").lower()
            ext = (f.get("ext") or "").lower()
            proto = (f.get("protocol") or "")
            if ac.startswith(("opus", "vorbis")): s += 6
            if ac.startswith(("mp4a", "aac")): s += 5
            if ext in ("webm", "m4a"): s += 5
            if proto.startswith("https"): s += 3
            elif proto.startswith("http"): s += 1
            try: s += int(f.get("abr") or 0)
            except Exception: pass
            return s

        best = sorted(fmts, key=score, reverse=True)
        log_event("resolve_song_best_formats",
                 top_3_scores=[score(f) for f in best[:3]],
                 top_3_formats=[{
                     'format_id': f.get('format_id'),
                     'ext': f.get('ext'),
                     'acodec': f.get('acodec'),
                     'vcodec': f.get('vcodec'),
                     'url_available': bool(f.get('url'))
                 } for f in best[:3]])
        
        for f in best:
            if f.get("vcodec") in (None, "none") and f.get("url"):
                audio_url = f["url"]
                log_event("resolve_song_selected_format",
                         format_id=f.get("format_id"),
                         ext=f.get("ext"),
                         acodec=f.get("acodec"),
                         url_domain=audio_url.split('/')[2] if '/' in audio_url else None)
                break

    if not audio_url:
        candidate = song_info.get("url")
        if candidate and "youtube.com/watch" not in candidate:
            audio_url = candidate
            log_event("resolve_song_fallback_url", url_domain=candidate.split('/')[2] if '/' in candidate else None)

    if audio_url and not any(x in audio_url for x in ['''googleusercontent.com/thumbnail''', '''storyboard''']):
        log_event("resolve_song_success", 
                 title=title,
                 url_domain=audio_url.split('/')[2] if '/' in audio_url else None)
        return {
            "url": audio_url, 
            "title": title, 
            "duration": duration, 
            "thumbnail": thumbnail,
            "original_info": song_info
        }
    else:
        log_event("no_playable_stream", 
                 title=title,
                 audio_url_found=bool(audio_url),
                 audio_url_domain=audio_url.split('/')[2] if audio_url and '/' in audio_url else None)
        return None