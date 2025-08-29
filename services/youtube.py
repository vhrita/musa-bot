import asyncio
import yt_dlp
from config import COOKIES_PATH
from utils.logging import log_event

async def search_ytdlp_async(query, ydl_opts):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: _extract(query, ydl_opts))

def _extract(query, ydl_opts):
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(query, download=False)

async def extract_info(query: str):
    is_playlist = "list=" in query and query.strip().startswith(("http://", "https://"))
    
    ydl_options = {
        "format": "bestaudio/best",
        "noplaylist": not is_playlist,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": is_playlist,
        "default_search": "ytsearch1",
        "ignore_no_formats_error": True,
        "geo_bypass": True,
        "source_address": "0.0.0.0",
        "retries": 2,
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "web", "tv"]
            }
        },
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        }
    }
    if COOKIES_PATH:
        ydl_options["cookiefile"] = COOKIES_PATH
        log_event("youtube_cookies_loaded", path=COOKIES_PATH)
    else:
        log_event("youtube_cookies_not_found", path=COOKIES_PATH)

    search_query = query.strip()
    if not search_query.startswith(("http://", "https://")):
        search_query = f"ytsearch1:{search_query}"

    try:
        results = await search_ytdlp_async(search_query, ydl_options)
    except Exception as e:
        log_event("extraction_error", error=str(e))
        return []

    if not results:
        return []

    if is_playlist and "entries" in results:
        return results["entries"]
    else:
        return [results]

async def resolve_song(song_info: dict):
    ydl_options = {
        "format": "bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "ignore_no_formats_error": True,
        "geo_bypass": True,
        "source_address": "0.0.0.0",
        "retries": 2,
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "web", "tv"]
            }
        },
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        }
    }
    if COOKIES_PATH:
        ydl_options["cookiefile"] = COOKIES_PATH

    try:
        track_url = song_info.get("url") or song_info.get("webpage_url")
        if not track_url:
            return None
        
        track = await search_ytdlp_async(track_url, ydl_options)
    except Exception as e:
        log_event("resolve_error", error=str(e), song_info=song_info)
        return None

    title = track.get("title") or track.get("webpage_url") or "Untitled"
    duration = track.get("duration")
    thumbnail = track.get("thumbnail")
    audio_url = None
    fmts = track.get("formats") or []

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
        for f in best:
            if f.get("vcodec") in (None, "none") and f.get("url"):
                audio_url = f["url"]
                break

    if not audio_url:
        candidate = track.get("url")
        if candidate and "youtube.com/watch" not in candidate:
            audio_url = candidate

    if audio_url and not any(x in audio_url for x in ["googleusercontent.com/thumbnail", "storyboard"]):
        return {
            "url": audio_url, 
            "title": title, 
            "duration": duration, 
            "thumbnail": thumbnail,
            "original_info": song_info
        }
    else:
        log_event("no_playable_stream", title=title)
        return None