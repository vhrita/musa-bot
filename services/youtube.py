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

def _has_formats(obj) -> bool:
    if isinstance(obj, dict):
        if obj.get("formats"):
            return True
        if obj.get("entries"):
            for e in obj["entries"]:
                if e and e.get("formats"):
                    return True
    return False

async def extract_audio(song_query: str):
    ydl_options = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
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

    log_event("ydl_options", options=ydl_options)

    is_url = song_query.strip().startswith(("http://", "https://"))
    if is_url:
        query = song_query.strip()
    else:
        query = f"ytmsearch1:{song_query}".strip()

    log_event("search_strategy", is_url=is_url, final_query=query)

    try:
        results = await search_ytdlp_async(query, ydl_options)
    except Exception:
        results = None

    if not results and not is_url:
        try:
            results = await search_ytdlp_async(f"ytsearch1:{song_query}", ydl_options)
        except Exception:
            results = None

    if not results and is_url:
        try:
            results = await search_ytdlp_async(song_query.strip(), ydl_options)
        except Exception:
            results = None

    has_entries = bool(isinstance(results, dict) and results.get("entries"))
    has_formats_top = bool(isinstance(results, dict) and results.get("formats"))
    log_event("extraction_result", has_entries=has_entries, has_formats_top=has_formats_top)

    if not _has_formats(results):
        try:
            ytm_opts = dict(ydl_options)
            ytm_opts["default_search"] = "ytmsearch1"
            results = await search_ytdlp_async(f"ytmsearch1:{song_query}", ytm_opts)
        except Exception:
            pass
    log_event("post_formats_check", has_formats=_has_formats(results))

    tracks = []
    if isinstance(results, dict) and results.get("entries"):
        tracks = [e for e in results["entries"] if e]
    elif results:
        tracks = [results]

    log_event("tracks_parsed", tracks_count=len(tracks))

    if not tracks:
        return None, None

    first = tracks[0] or {}
    title = first.get("title") or first.get("webpage_url") or "Untitled"

    fmts = first.get("formats") or []
    if not fmts and first.get("webpage_url"):
        try:
            detail = await search_ytdlp_async(first["webpage_url"], ydl_options)
            if isinstance(detail, dict):
                first = detail
                fmts = first.get("formats") or []
        except Exception:
            pass
    log_event("reextract_detail", fmts_count=len(fmts), used_webpage_url=bool(first.get("webpage_url")))

    audio_url = None
    fmts = first.get("formats") or []
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
                log_event("format_chosen", format_id=f.get("format_id"), ext=f.get("ext"), acodec=f.get("acodec"), abr=f.get("abr"), protocol=f.get("protocol"))
                break

    if not audio_url:
        candidate = first.get("url") or ""
        if candidate and "youtube.com/watch" not in candidate:
            audio_url = candidate
            log_event("format_fallback_url_used", candidate=candidate)

    if not audio_url:
        log_event("no_playable_stream", title=title)
        return None, title

    if (
        "googleusercontent.com/thumbnail" in audio_url
        or "storyboard" in audio_url
        or "youtube.com/watch" in audio_url
    ):
        log_event("rejected_stream_url", audio_url=audio_url)
        return None, title

    return audio_url, title
