"""
Internet Archive audio service for free music streaming.
Provides access to archive.org's music collection.
"""

import aiohttp
import asyncio
from typing import List, Dict, Optional
from services.base_service import AudioService
from utils.logging import log_event

class InternetArchiveService(AudioService):
    """
    Service for searching and streaming music from Internet Archive.
    Provides access to free and public domain music.
    """
    
    def __init__(self):
        super().__init__(name="internet_archive", enabled=True, priority=2)
        self.base_url = "https://archive.org"
        self.search_url = f"{self.base_url}/advancedsearch.php"
        
    async def search(self, query: str) -> List[Dict]:
        """Search for audio on Internet Archive."""
        self.log_service_event("search_start", query=query)
        
        try:
            # Search parameters for audio files with quality filters
            params = {
                'q': f'title:({query}) AND mediatype:audio AND format:MP3 AND NOT (ringtone OR sample OR preview OR loop OR instrumental)',
                'fl': 'identifier,title,creator,description,date,downloads,avg_rating',
                'rows': 20,  # Get more results to have better selection
                'page': 1,
                'output': 'json',
                'sort[]': 'downloads desc'  # Sort by popularity first
            }
            
            async with aiohttp.ClientSession() as session:
                async with session.get(self.search_url, params=params, timeout=10) as response:
                    if response.status == 200:
                        data = await response.json()
                        docs = data.get('response', {}).get('docs', [])
                        
                        results = []
                        for doc in docs:
                            # Get detailed metadata for each item
                            item_id = doc.get('identifier')
                            if item_id:
                                item_info = await self._get_item_details(item_id)
                                if item_info and self._is_quality_audio(item_info):
                                    results.append(item_info)
                        
                        # Sort results by quality score
                        results = self._sort_by_quality(results)
                        
                        self.log_service_event("search_success", 
                                             query=query, 
                                             results_count=len(results))
                        return results
                    else:
                        self.log_service_event("search_http_error", 
                                             query=query, 
                                             status=response.status)
                        return []
                        
        except Exception as e:
            self.log_service_event("search_error", 
                                 query=query, 
                                 error=str(e), 
                                 error_type=type(e).__name__)
            return []
    
    async def _get_item_details(self, item_id: str) -> Optional[Dict]:
        """Get detailed information about a specific Internet Archive item."""
        try:
            # Get item metadata
            metadata_url = f"{self.base_url}/metadata/{item_id}"
            files_url = f"{self.base_url}/download/{item_id}"
            
            async with aiohttp.ClientSession() as session:
                # Get metadata
                async with session.get(metadata_url, timeout=5) as response:
                    if response.status != 200:
                        return None
                    
                    metadata = await response.json()
                    
                    # Find MP3 files
                    files = metadata.get('files', [])
                    mp3_files = [f for f in files if f.get('format') == 'MP3' or f.get('name', '').endswith('.mp3')]
                    
                    if not mp3_files:
                        return None
                    
                    # Get the best quality MP3 file
                    best_file = max(mp3_files, key=lambda f: int(f.get('size', 0)))
                    
                    # Calculate duration if available
                    duration = None
                    if 'length' in best_file:
                        try:
                            # Length is in seconds format like "4:32"
                            length_str = best_file['length']
                            if ':' in length_str:
                                parts = length_str.split(':')
                                duration = int(parts[0]) * 60 + int(parts[1])
                        except (ValueError, IndexError):
                            pass
                    
                    item_metadata = metadata.get('metadata', {})
                    
                    return {
                        'service': self.name,
                        'id': item_id,
                        'title': item_metadata.get('title', f"Archive Item {item_id}"),
                        'creator': item_metadata.get('creator', 'Unknown Artist'),
                        'description': item_metadata.get('description', ''),
                        'date': item_metadata.get('date', ''),
                        'duration': duration,
                        'thumbnail': f"{self.base_url}/services/img/{item_id}",
                        'file_name': best_file.get('name'),
                        'file_size': best_file.get('size'),
                        'webpage_url': f"{self.base_url}/details/{item_id}",
                        'download_url': f"{files_url}/{best_file.get('name')}"
                    }
                    
        except Exception as e:
            self.log_service_event("item_details_error", 
                                 item_id=item_id, 
                                 error=str(e))
            return None
    
    async def resolve_url(self, song_info: Dict) -> Optional[Dict]:
        """Resolve Internet Archive song info to playable URL."""
        self.log_service_event("resolve_start", 
                             title=song_info.get('title'),
                             item_id=song_info.get('id'))
        
        try:
            # The download_url should be directly playable
            download_url = song_info.get('download_url')
            if not download_url:
                self.log_service_event("resolve_no_url", 
                                     title=song_info.get('title'))
                return None
            
            # Test if URL is accessible
            async with aiohttp.ClientSession() as session:
                async with session.head(download_url, timeout=5, allow_redirects=True) as response:
                    if response.status == 200:
                        # Use the final redirected URL if different
                        final_url = str(response.url) if response.url != download_url else download_url
                        self.log_service_event("resolve_success", 
                                             title=song_info.get('title'),
                                             original_url=download_url,
                                             final_url=final_url)
                        
                        return {
                            'url': final_url,
                            'title': f"{song_info.get('title')} - {song_info.get('creator', 'Unknown')}",
                            'duration': song_info.get('duration'),
                            'thumbnail': song_info.get('thumbnail'),
                            'service': self.name,
                            'original_info': song_info
                        }
                    else:
                        self.log_service_event("resolve_url_not_accessible", 
                                             title=song_info.get('title'),
                                             status=response.status)
                        return None
                        
        except Exception as e:
            self.log_service_event("resolve_error", 
                                 title=song_info.get('title'),
                                 error=str(e),
                                 error_type=type(e).__name__)
            return None
    
    async def is_available(self) -> bool:
        """Check if Internet Archive is accessible."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.base_url}/", timeout=5) as response:
                    available = response.status == 200
                    self.log_service_event("availability_check", available=available)
                    return available
        except Exception as e:
            self.log_service_event("availability_error", 
                                 error=str(e),
                                 error_type=type(e).__name__)
            return False
    
    def _is_quality_audio(self, item_info: Dict) -> bool:
        """Filter out low-quality audio files (ringtones, samples, etc.)."""
        title = item_info.get('title', '').lower()
        description = item_info.get('description', '').lower()
        file_size = int(item_info.get('file_size', 0))
        
        # Filter out obvious low-quality content
        bad_keywords = [
            'ringtone', 'sample', 'preview', 'loop', 'beat', 'instrumental',
            'remix', 'karaoke', 'playback', 'iphone', 'marimba', 'versi',
            'notification', 'alert', 'sound effect'
        ]
        
        for keyword in bad_keywords:
            if keyword in title or keyword in description:
                return False
        
        # Prefer larger files (complete songs vs. short clips)
        # Minimum 1MB for a decent quality song
        if file_size < 1000000:  # 1MB
            return False
            
        return True
    
    def _sort_by_quality(self, results: List[Dict]) -> List[Dict]:
        """Sort results by quality indicators."""
        def quality_score(item):
            score = 0
            
            # File size score (bigger = better, up to a point)
            file_size = int(item.get('file_size', 0))
            if file_size > 3000000:  # 3MB+
                score += 100
            elif file_size > 2000000:  # 2MB+
                score += 80
            elif file_size > 1000000:  # 1MB+
                score += 60
            
            # Creator score (known artists get bonus)
            creator = item.get('creator', '').lower()
            if creator and creator != 'unknown artist':
                score += 50
            
            # Title quality (prefer official-looking titles)
            title = item.get('title', '').lower()
            if 'official' in title:
                score += 30
            if 'studio' in title:
                score += 20
            if 'album' in title:
                score += 20
            
            # Duration score (prefer normal song length)
            duration = item.get('duration')
            if duration and isinstance(duration, (int, float)):
                if 120 <= duration <= 600:  # 2-10 minutes
                    score += 40
                elif 60 <= duration <= 120:  # 1-2 minutes
                    score += 20
            
            return score
        
        return sorted(results, key=quality_score, reverse=True)
