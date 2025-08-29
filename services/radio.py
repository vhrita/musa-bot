"""
Radio streaming service for free internet radio stations.
Provides access to various online radio streams.
"""

import aiohttp
import asyncio
from typing import List, Dict, Optional
from services.base_service import AudioService
from utils.logging import log_event
from utils.stream_resolver import UniversalStreamResolver

class RadioService(AudioService):
    """
    Service for streaming internet radio stations.
    Provides access to free radio streams from various genres.
    """
    
    def __init__(self):
        super().__init__(name="radio", enabled=True, priority=3)
        # Initialize universal stream resolver with service logging
        self.stream_resolver = UniversalStreamResolver(logger_service=self)
        # Popular radio stations with reliable stream URLs
        self.radio_stations = {
            "lofi": {
                "name": "LoFi Hip Hop Radio 24/7",
                "url": "https://streams.ilovemusic.de/iloveradio17.mp3",
                "genre": "lofi",
                "description": "Chill lofi hip hop beats"
            },
            "jazz": {
                "name": "Smooth Jazz Radio",
                "url": "https://live.wostreaming.net/direct/ppmedia-smoothjazzflorida",
                "genre": "jazz", 
                "description": "Smooth jazz and contemporary instrumentals"
            },
            "electronic": {
                "name": "Electronic Radio",
                "url": "https://streams.ilovemusic.de/iloveradio2.mp3",
                "genre": "electronic",
                "description": "Electronic and dance music"
            },
            "classical": {
                "name": "Classical Radio",
                "url": "https://live.wostreaming.net/direct/classicalfm",
                "genre": "classical",
                "description": "Classical music and orchestral pieces"
            },
            "rock": {
                "name": "Classic Rock Radio",
                "url": "https://streams.ilovemusic.de/iloveradio3.mp3",
                "genre": "rock",
                "description": "Classic rock hits from the 70s-90s"
            },
            "pop": {
                "name": "Pop Radio",
                "url": "https://streams.ilovemusic.de/iloveradio1.mp3",
                "genre": "pop",
                "description": "Contemporary pop music"
            },
            "chill": {
                "name": "Chillout Radio",
                "url": "https://live.wostreaming.net/direct/lounge-radio",
                "genre": "chill",
                "description": "Relaxing ambient and chillout music"
            },
            "indie": {
                "name": "Indie Radio",
                "url": "https://live.wostreaming.net/direct/indierock",
                "genre": "indie",
                "description": "Independent and alternative music"
            }
        }
        
    async def search(self, query: str) -> List[Dict]:
        """Search for radio stations based on query."""
        self.log_service_event("search_start", query=query)
        
        query_lower = query.lower()
        results = []
        
        # Search through station names, genres, and descriptions
        for station_id, station_info in self.radio_stations.items():
            if self._station_matches_query(query_lower, station_info):
                station_result = await self._create_station_result(station_id, station_info)
                if station_result:
                    results.append(station_result)
        
        # If no specific matches, suggest popular stations
        if not results and len(query_lower) > 0:
            results = await self._get_popular_stations_fallback()
        
        self.log_service_event("search_success", 
                             query=query, 
                             results_count=len(results))
        return results
    
    def _station_matches_query(self, query_lower: str, station_info: Dict) -> bool:
        """Check if a station matches the search query."""
        return (query_lower in station_info["name"].lower() or 
                query_lower in station_info["genre"].lower() or
                query_lower in station_info["description"].lower() or
                any(word in station_info["genre"].lower() for word in query_lower.split()))
    
    async def _create_station_result(self, station_id: str, station_info: Dict) -> Optional[Dict]:
        """Create a station result dictionary if the station is available."""
        if await self._check_station_availability(station_info["url"]):
            return {
                'service': self.name,
                'id': station_id,
                'title': station_info["name"],
                'genre': station_info["genre"],
                'description': station_info["description"],
                'stream_url': station_info["url"],
                'duration': None,  # Radio streams are continuous
                'thumbnail': f"https://via.placeholder.com/320x180/1e1e1e/ffffff?text={station_info['genre'].title()}+Radio",
                'webpage_url': None,
                'is_live_stream': True
            }
        return None
    
    async def _get_popular_stations_fallback(self) -> List[Dict]:
        """Get popular stations as fallback when no matches found."""
        results = []
        popular_stations = ["lofi", "jazz", "chill"]
        
        for station_id in popular_stations:
            if station_id in self.radio_stations:
                station_info = self.radio_stations[station_id]
                station_result = await self._create_station_result(station_id, station_info)
                if station_result:
                    station_result['title'] = f"{station_info['name']} (Suggested)"
                    results.append(station_result)
        
        return results
    
    async def _check_station_availability(self, stream_url: str) -> bool:
        """Check if a radio station stream is available."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.head(stream_url, timeout=3) as response:
                    # Accept various status codes that indicate streaming is available
                    return response.status in [200, 302, 301, 206]
        except Exception:
            return False
    
    async def resolve_url(self, song_info: Dict) -> Optional[Dict]:
        """Resolve radio station info to playable URL with universal stream detection."""
        self.log_service_event("resolve_start", 
                             title=song_info.get('title'),
                             station_id=song_info.get('id'))
        
        try:
            stream_url = song_info.get('stream_url')
            if not stream_url:
                self.log_service_event("resolve_no_url", 
                                     title=song_info.get('title'))
                return None
            
            # Use universal stream resolver
            final_stream_url = await self.stream_resolver.resolve_stream_url(stream_url)
            
            if not final_stream_url:
                self.log_service_event("resolve_no_valid_stream", 
                                     original_url=stream_url,
                                     title=song_info.get('title'))
                return None
            
            self.log_service_event("resolve_success", 
                                 title=song_info.get('title'),
                                 original_url=stream_url,
                                 final_url=final_stream_url)
            
            return {
                'url': final_stream_url,
                'title': f"🔴 LIVE: {song_info.get('title')}",
                'duration': None,  # Live streams don't have duration
                'thumbnail': song_info.get('thumbnail'),
                'service': self.name,
                'is_live_stream': True,
                'original_info': song_info
            }
                
        except Exception as e:
            self.log_service_event("resolve_error", 
                                 title=song_info.get('title'),
                                 error=str(e),
                                 error_type=type(e).__name__)
            return None

    async def is_available(self) -> bool:
        """Check if radio service is available by testing a few stations."""
        try:
            # Test availability of a few key stations
            test_stations = ["lofi", "jazz"]
            available_count = 0
            
            for station_id in test_stations:
                if station_id in self.radio_stations:
                    station_url = self.radio_stations[station_id]["url"]
                    resolved_url = await self.stream_resolver.resolve_stream_url(station_url)
                    if resolved_url:
                        available_count += 1
            
            # Consider service available if at least one station works
            available = available_count > 0
            self.log_service_event("availability_check", 
                                 available=available,
                                 tested_stations=len(test_stations),
                                 available_stations=available_count)
            return available
            
        except Exception as e:
            self.log_service_event("availability_error", 
                                 error=str(e),
                                 error_type=type(e).__name__)
            return False