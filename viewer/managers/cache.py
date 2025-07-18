"""
Cache Manager for SentrySix.

This module provides intelligent caching functionality for thumbnails, metadata,
and frequently accessed data. Integrates with the consolidated directory structure
for organized cache management with automatic cleanup and size limits.
"""

import os
import json
import pickle
import hashlib
import time
from typing import Any, Dict, List, Optional, Union, Tuple
from pathlib import Path
from datetime import datetime, timedelta
from PyQt6.QtCore import QObject, pyqtSignal, QTimer
from PyQt6.QtGui import QPixmap

from .base import BaseManager


class CacheManagerSignals(QObject):
    """Signals for CacheManager communication with UI and other managers."""

    # Cache operation signals
    cache_hit = pyqtSignal(str, str)  # cache_type, key
    cache_miss = pyqtSignal(str, str)  # cache_type, key
    cache_stored = pyqtSignal(str, str, int)  # cache_type, key, size_bytes
    cache_evicted = pyqtSignal(str, str)  # cache_type, key

    # Cache management signals
    cache_cleanup_started = pyqtSignal()
    cache_cleanup_completed = pyqtSignal(int, int)  # files_removed, bytes_freed
    cache_size_warning = pyqtSignal(int, int)  # current_size_mb, limit_mb
    cache_full = pyqtSignal(str)  # cache_type

    # Performance signals
    cache_hit_rate_updated = pyqtSignal(str, float)  # cache_type, hit_rate
    cache_performance_report = pyqtSignal(dict)  # performance_stats


class CacheManager(BaseManager):
    """
    Manages intelligent caching for thumbnails, metadata, and frequently accessed data.

    Handles:
    - Thumbnail caching for video files with automatic generation
    - Metadata caching for file information and video properties
    - Frequently accessed data caching (settings, user preferences)
    - Intelligent cache eviction with LRU (Least Recently Used) policy
    - Cache size management with configurable limits
    - Automatic cleanup of expired and unused cache entries
    - Performance monitoring and hit rate tracking
    """

    # Cache types
    CACHE_TYPES = {
        'thumbnails': {'extension': '.thumb', 'max_size_mb': 256, 'ttl_days': 30},
        'metadata': {'extension': '.meta', 'max_size_mb': 64, 'ttl_days': 7},
        'video_info': {'extension': '.vinfo', 'max_size_mb': 32, 'ttl_days': 14},
        'user_data': {'extension': '.udata', 'max_size_mb': 16, 'ttl_days': 90},
        'temp': {'extension': '.tmp', 'max_size_mb': 128, 'ttl_days': 1}
    }

    def __init__(self, parent_widget, dependency_container):
        """Initialize the CacheManager."""
        super().__init__(parent_widget, dependency_container)

        # Initialize signals
        self.signals = CacheManagerSignals()

        # Cache configuration
        self.total_cache_limit_mb = 512  # Total cache size limit
        self.cleanup_interval_minutes = 30  # Cleanup interval
        self.hit_rate_window = 1000  # Number of operations for hit rate calculation

        # Cache directories
        self.cache_directory: Optional[Path] = None
        self.cache_subdirs: Dict[str, Path] = {}

        # In-memory cache for frequently accessed small data
        self.memory_cache: Dict[str, Dict[str, Any]] = {}
        self.memory_cache_access_times: Dict[str, Dict[str, float]] = {}
        self.memory_cache_limit = 100  # Max items per cache type in memory

        # Performance tracking
        self.cache_stats: Dict[str, Dict[str, int]] = {}
        self.recent_operations: Dict[str, List[bool]] = {}  # True for hit, False for miss

        # Cleanup timer
        self.cleanup_timer = QTimer()
        self.cleanup_timer.timeout.connect(self._perform_automatic_cleanup)

        self.logger.debug("CacheManager created")

    def initialize(self) -> bool:
        """
        Initialize cache manager.

        Returns:
            bool: True if initialization was successful
        """
        try:
            # Get cache directory from ConfigurationManager
            self._setup_cache_directories()

            # Load configuration from ConfigurationManager
            self._load_cache_configuration()

            # Initialize cache statistics
            self._initialize_cache_stats()

            # Initialize memory caches
            self._initialize_memory_caches()

            # Load existing cache metadata
            self._load_cache_metadata()

            # Start automatic cleanup timer
            self._start_cleanup_timer()

            # Perform initial cleanup
            self._perform_initial_cleanup()

            self.logger.info("CacheManager initialized successfully")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "CacheManager initialization")
            return False

    def cleanup(self) -> None:
        """Clean up cache resources."""
        try:
            self._mark_cleanup_started()

            # Stop cleanup timer
            if self.cleanup_timer.isActive():
                self.cleanup_timer.stop()

            # Save cache metadata
            self._save_cache_metadata()

            # Clear memory caches
            self.memory_cache.clear()
            self.memory_cache_access_times.clear()

            self.logger.info("CacheManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "CacheManager cleanup")

    # ========================================
    # Cache Operations
    # ========================================

    def get(self, cache_type: str, key: str, default: Any = None) -> Any:
        """
        Get an item from cache.

        Args:
            cache_type: Type of cache ('thumbnails', 'metadata', etc.)
            key: Cache key
            default: Default value if not found

        Returns:
            Cached value or default
        """
        try:
            if cache_type not in self.CACHE_TYPES:
                self.logger.warning(f"Unknown cache type: {cache_type}")
                return default

            # Check memory cache first
            memory_value = self._get_from_memory_cache(cache_type, key)
            if memory_value is not None:
                self._record_cache_hit(cache_type, key)
                return memory_value

            # Check disk cache
            disk_value = self._get_from_disk_cache(cache_type, key)
            if disk_value is not None:
                # Store in memory cache for faster access
                self._store_in_memory_cache(cache_type, key, disk_value)
                self._record_cache_hit(cache_type, key)
                return disk_value

            # Cache miss
            self._record_cache_miss(cache_type, key)
            return default

        except Exception as e:
            self.handle_error(e, f"get({cache_type}, {key})")
            return default

    def set(self, cache_type: str, key: str, value: Any, ttl_days: Optional[int] = None) -> bool:
        """
        Store an item in cache.

        Args:
            cache_type: Type of cache
            key: Cache key
            value: Value to cache
            ttl_days: Time to live in days (optional)

        Returns:
            bool: True if stored successfully
        """
        try:
            if cache_type not in self.CACHE_TYPES:
                self.logger.warning(f"Unknown cache type: {cache_type}")
                return False

            # Store in memory cache
            self._store_in_memory_cache(cache_type, key, value)

            # Store in disk cache
            success = self._store_in_disk_cache(cache_type, key, value, ttl_days)

            if success:
                # Calculate approximate size
                size_bytes = self._estimate_size(value)
                self.signals.cache_stored.emit(cache_type, key, size_bytes)

            return success

        except Exception as e:
            self.handle_error(e, f"set({cache_type}, {key})")
            return False

    def delete(self, cache_type: str, key: str) -> bool:
        """
        Delete an item from cache.

        Args:
            cache_type: Type of cache
            key: Cache key

        Returns:
            bool: True if deleted successfully
        """
        try:
            if cache_type not in self.CACHE_TYPES:
                return False

            # Remove from memory cache
            self._remove_from_memory_cache(cache_type, key)

            # Remove from disk cache
            success = self._remove_from_disk_cache(cache_type, key)

            if success:
                self.signals.cache_evicted.emit(cache_type, key)

            return success

        except Exception as e:
            self.handle_error(e, f"delete({cache_type}, {key})")
            return False

    def clear(self, cache_type: Optional[str] = None) -> bool:
        """
        Clear cache entries.

        Args:
            cache_type: Specific cache type to clear, or None for all

        Returns:
            bool: True if cleared successfully
        """
        try:
            if cache_type:
                # Clear specific cache type
                if cache_type not in self.CACHE_TYPES:
                    return False

                self._clear_memory_cache(cache_type)
                return self._clear_disk_cache(cache_type)
            else:
                # Clear all caches
                for ct in self.CACHE_TYPES:
                    self._clear_memory_cache(ct)
                    self._clear_disk_cache(ct)
                return True

        except Exception as e:
            self.handle_error(e, f"clear({cache_type})")
            return False

    def exists(self, cache_type: str, key: str) -> bool:
        """
        Check if an item exists in cache.

        Args:
            cache_type: Type of cache
            key: Cache key

        Returns:
            bool: True if item exists
        """
        try:
            if cache_type not in self.CACHE_TYPES:
                return False

            # Check memory cache first
            if self._exists_in_memory_cache(cache_type, key):
                return True

            # Check disk cache
            return self._exists_in_disk_cache(cache_type, key)

        except Exception as e:
            self.handle_error(e, f"exists({cache_type}, {key})")
            return False

    # ========================================
    # Specialized Cache Methods
    # ========================================

    def get_thumbnail(self, video_path: str, timestamp: float = 0.0) -> Optional[QPixmap]:
        """
        Get thumbnail for a video file.

        Args:
            video_path: Path to video file
            timestamp: Timestamp for thumbnail (default: 0.0)

        Returns:
            QPixmap thumbnail or None
        """
        try:
            # Generate cache key
            key = self._generate_thumbnail_key(video_path, timestamp)

            # Try to get from cache
            thumbnail_data = self.get('thumbnails', key)
            if thumbnail_data:
                # Convert back to QPixmap
                pixmap = QPixmap()
                if pixmap.loadFromData(thumbnail_data):
                    return pixmap

            return None

        except Exception as e:
            self.handle_error(e, f"get_thumbnail({video_path}, {timestamp})")
            return None

    def store_thumbnail(self, video_path: str, thumbnail: QPixmap, timestamp: float = 0.0) -> bool:
        """
        Store thumbnail for a video file.

        Args:
            video_path: Path to video file
            thumbnail: QPixmap thumbnail
            timestamp: Timestamp for thumbnail

        Returns:
            bool: True if stored successfully
        """
        try:
            # Generate cache key
            key = self._generate_thumbnail_key(video_path, timestamp)

            # Convert QPixmap to bytes
            from PyQt6.QtCore import QByteArray, QBuffer, QIODevice
            byte_array = QByteArray()
            buffer = QBuffer(byte_array)
            buffer.open(QIODevice.OpenModeFlag.WriteOnly)
            thumbnail.save(buffer, "PNG")
            thumbnail_data = byte_array.data()

            # Store in cache
            return self.set('thumbnails', key, thumbnail_data)

        except Exception as e:
            self.handle_error(e, f"store_thumbnail({video_path}, {timestamp})")
            return False

    def get_video_metadata(self, video_path: str) -> Optional[Dict[str, Any]]:
        """
        Get cached video metadata.

        Args:
            video_path: Path to video file

        Returns:
            Dictionary with video metadata or None
        """
        try:
            key = self._generate_file_key(video_path)
            return self.get('video_info', key)

        except Exception as e:
            self.handle_error(e, f"get_video_metadata({video_path})")
            return None

    def store_video_metadata(self, video_path: str, metadata: Dict[str, Any]) -> bool:
        """
        Store video metadata in cache.

        Args:
            video_path: Path to video file
            metadata: Video metadata dictionary

        Returns:
            bool: True if stored successfully
        """
        try:
            key = self._generate_file_key(video_path)
            return self.set('video_info', key, metadata)

        except Exception as e:
            self.handle_error(e, f"store_video_metadata({video_path})")
            return False

    # ========================================
    # Cache Management and Statistics
    # ========================================

    def get_cache_stats(self) -> Dict[str, Any]:
        """Get comprehensive cache statistics."""
        try:
            stats = {
                'total_size_mb': self._get_total_cache_size_mb(),
                'cache_limit_mb': self.total_cache_limit_mb,
                'cache_types': {}
            }

            for cache_type in self.CACHE_TYPES:
                type_stats = self.cache_stats.get(cache_type, {})
                hit_rate = self._calculate_hit_rate(cache_type)

                stats['cache_types'][cache_type] = {
                    'hits': type_stats.get('hits', 0),
                    'misses': type_stats.get('misses', 0),
                    'stores': type_stats.get('stores', 0),
                    'evictions': type_stats.get('evictions', 0),
                    'hit_rate': hit_rate,
                    'size_mb': self._get_cache_type_size_mb(cache_type),
                    'item_count': self._get_cache_type_item_count(cache_type)
                }

            return stats

        except Exception as e:
            self.handle_error(e, "get_cache_stats")
            return {}

    def cleanup_expired(self, cache_type: Optional[str] = None) -> Tuple[int, int]:
        """
        Clean up expired cache entries.

        Args:
            cache_type: Specific cache type or None for all

        Returns:
            Tuple of (files_removed, bytes_freed)
        """
        try:
            total_removed = 0
            total_freed = 0

            cache_types = [cache_type] if cache_type else list(self.CACHE_TYPES.keys())

            for ct in cache_types:
                removed, freed = self._cleanup_expired_cache_type(ct)
                total_removed += removed
                total_freed += freed

            if total_removed > 0:
                self.signals.cache_cleanup_completed.emit(total_removed, total_freed)
                self.logger.info(f"Cleaned up {total_removed} expired cache entries, freed {total_freed} bytes")

            return total_removed, total_freed

        except Exception as e:
            self.handle_error(e, f"cleanup_expired({cache_type})")
            return 0, 0

    def enforce_size_limits(self) -> Tuple[int, int]:
        """
        Enforce cache size limits using LRU eviction.

        Returns:
            Tuple of (files_removed, bytes_freed)
        """
        try:
            total_removed = 0
            total_freed = 0

            # Check total cache size
            total_size_mb = self._get_total_cache_size_mb()
            if total_size_mb > self.total_cache_limit_mb:
                self.signals.cache_size_warning.emit(int(total_size_mb), self.total_cache_limit_mb)

            # Enforce limits for each cache type
            for cache_type, config in self.CACHE_TYPES.items():
                type_size_mb = self._get_cache_type_size_mb(cache_type)
                limit_mb = config['max_size_mb']

                if type_size_mb > limit_mb:
                    removed, freed = self._enforce_cache_type_limit(cache_type, limit_mb)
                    total_removed += removed
                    total_freed += freed

            return total_removed, total_freed

        except Exception as e:
            self.handle_error(e, "enforce_size_limits")
            return 0, 0

    # ========================================
    # Helper Methods
    # ========================================

    def _setup_cache_directories(self) -> None:
        """Set up cache directories using ConfigurationManager."""
        try:
            config_manager = self.container.get_service('configuration')
            if config_manager and config_manager.is_initialized():
                self.cache_directory = config_manager.get_cache_directory()
            else:
                # Fallback to default location
                self.cache_directory = Path.home() / '.sentrysix' / 'cache'

            # Ensure main cache directory exists
            self.cache_directory.mkdir(parents=True, exist_ok=True)

            # Create subdirectories for each cache type
            for cache_type in self.CACHE_TYPES:
                subdir = self.cache_directory / cache_type
                subdir.mkdir(exist_ok=True)
                self.cache_subdirs[cache_type] = subdir

        except Exception as e:
            self.handle_error(e, "_setup_cache_directories")

    def _load_cache_configuration(self) -> None:
        """Load cache configuration from ConfigurationManager."""
        try:
            config_manager = self.container.get_service('configuration')
            if config_manager and config_manager.is_initialized():
                self.total_cache_limit_mb = config_manager.get_setting('performance.max_cache_size_mb', 512)
                self.cleanup_interval_minutes = config_manager.get_setting('cache.cleanup_interval_minutes', 30)
                self.memory_cache_limit = config_manager.get_setting('cache.memory_cache_limit', 100)

        except Exception as e:
            self.handle_error(e, "_load_cache_configuration")

    def _initialize_cache_stats(self) -> None:
        """Initialize cache statistics tracking."""
        for cache_type in self.CACHE_TYPES:
            self.cache_stats[cache_type] = {
                'hits': 0,
                'misses': 0,
                'stores': 0,
                'evictions': 0
            }
            self.recent_operations[cache_type] = []

    def _initialize_memory_caches(self) -> None:
        """Initialize in-memory cache structures."""
        for cache_type in self.CACHE_TYPES:
            self.memory_cache[cache_type] = {}
            self.memory_cache_access_times[cache_type] = {}

    def _get_from_memory_cache(self, cache_type: str, key: str) -> Any:
        """Get item from memory cache."""
        try:
            if key in self.memory_cache[cache_type]:
                # Update access time
                self.memory_cache_access_times[cache_type][key] = time.time()
                return self.memory_cache[cache_type][key]
            return None

        except Exception as e:
            self.handle_error(e, f"_get_from_memory_cache({cache_type}, {key})")
            return None

    def _store_in_memory_cache(self, cache_type: str, key: str, value: Any) -> None:
        """Store item in memory cache with LRU eviction."""
        try:
            # Check if we need to evict items
            if len(self.memory_cache[cache_type]) >= self.memory_cache_limit:
                self._evict_lru_memory_cache(cache_type)

            # Store the item
            self.memory_cache[cache_type][key] = value
            self.memory_cache_access_times[cache_type][key] = time.time()

        except Exception as e:
            self.handle_error(e, f"_store_in_memory_cache({cache_type}, {key})")

    def _evict_lru_memory_cache(self, cache_type: str) -> None:
        """Evict least recently used item from memory cache."""
        try:
            if not self.memory_cache_access_times[cache_type]:
                return

            # Find least recently used item
            lru_key = min(self.memory_cache_access_times[cache_type],
                         key=self.memory_cache_access_times[cache_type].get)

            # Remove it
            del self.memory_cache[cache_type][lru_key]
            del self.memory_cache_access_times[cache_type][lru_key]

        except Exception as e:
            self.handle_error(e, f"_evict_lru_memory_cache({cache_type})")

    def _get_from_disk_cache(self, cache_type: str, key: str) -> Any:
        """Get item from disk cache."""
        try:
            cache_file = self._get_cache_file_path(cache_type, key)
            if not cache_file.exists():
                return None

            # Check if expired
            if self._is_cache_file_expired(cache_file, cache_type):
                cache_file.unlink()  # Remove expired file
                return None

            # Load the cached data
            with open(cache_file, 'rb') as f:
                data = pickle.load(f)

            # Update access time
            cache_file.touch()

            return data

        except Exception as e:
            self.handle_error(e, f"_get_from_disk_cache({cache_type}, {key})")
            return None

    def _store_in_disk_cache(self, cache_type: str, key: str, value: Any, ttl_days: Optional[int] = None) -> bool:
        """Store item in disk cache."""
        try:
            cache_file = self._get_cache_file_path(cache_type, key)

            # Create metadata
            metadata = {
                'created': time.time(),
                'ttl_days': ttl_days or self.CACHE_TYPES[cache_type]['ttl_days'],
                'data': value
            }

            # Store the data
            with open(cache_file, 'wb') as f:
                pickle.dump(metadata, f)

            self.cache_stats[cache_type]['stores'] += 1
            return True

        except Exception as e:
            self.handle_error(e, f"_store_in_disk_cache({cache_type}, {key})")
            return False

    def _get_cache_file_path(self, cache_type: str, key: str) -> Path:
        """Get the file path for a cache entry."""
        safe_key = self._make_safe_filename(key)
        extension = self.CACHE_TYPES[cache_type]['extension']
        return self.cache_subdirs[cache_type] / f"{safe_key}{extension}"

    def _make_safe_filename(self, key: str) -> str:
        """Convert cache key to safe filename."""
        # Use hash for long keys or keys with special characters
        if len(key) > 100 or any(c in key for c in '<>:"/\\|?*'):
            return hashlib.md5(key.encode()).hexdigest()
        return key.replace('/', '_').replace('\\', '_')

    def _is_cache_file_expired(self, cache_file: Path, cache_type: str) -> bool:
        """Check if a cache file is expired."""
        try:
            with open(cache_file, 'rb') as f:
                metadata = pickle.load(f)

            created_time = metadata.get('created', 0)
            ttl_days = metadata.get('ttl_days', self.CACHE_TYPES[cache_type]['ttl_days'])

            expiry_time = created_time + (ttl_days * 24 * 60 * 60)
            return time.time() > expiry_time

        except Exception:
            return True  # Consider corrupted files as expired

    def _generate_thumbnail_key(self, video_path: str, timestamp: float) -> str:
        """Generate cache key for thumbnail."""
        # Include file modification time to invalidate cache when file changes
        try:
            mtime = os.path.getmtime(video_path)
            return f"{video_path}_{timestamp}_{mtime}"
        except OSError:
            return f"{video_path}_{timestamp}"

    def _generate_file_key(self, file_path: str) -> str:
        """Generate cache key for file-based data."""
        try:
            mtime = os.path.getmtime(file_path)
            size = os.path.getsize(file_path)
            return f"{file_path}_{mtime}_{size}"
        except OSError:
            return file_path

    def _record_cache_hit(self, cache_type: str, key: str) -> None:
        """Record a cache hit for statistics."""
        self.cache_stats[cache_type]['hits'] += 1
        self.recent_operations[cache_type].append(True)

        # Keep only recent operations for hit rate calculation
        if len(self.recent_operations[cache_type]) > self.hit_rate_window:
            self.recent_operations[cache_type].pop(0)

        self.signals.cache_hit.emit(cache_type, key)

    def _record_cache_miss(self, cache_type: str, key: str) -> None:
        """Record a cache miss for statistics."""
        self.cache_stats[cache_type]['misses'] += 1
        self.recent_operations[cache_type].append(False)

        # Keep only recent operations for hit rate calculation
        if len(self.recent_operations[cache_type]) > self.hit_rate_window:
            self.recent_operations[cache_type].pop(0)

        self.signals.cache_miss.emit(cache_type, key)

    def _calculate_hit_rate(self, cache_type: str) -> float:
        """Calculate hit rate for a cache type."""
        operations = self.recent_operations[cache_type]
        if not operations:
            return 0.0

        hits = sum(1 for op in operations if op)
        return hits / len(operations)

    def _estimate_size(self, value: Any) -> int:
        """Estimate the size of a value in bytes."""
        try:
            if isinstance(value, (str, bytes)):
                return len(value)
            elif isinstance(value, (int, float)):
                return 8
            elif isinstance(value, dict):
                return sum(self._estimate_size(k) + self._estimate_size(v) for k, v in value.items())
            elif isinstance(value, (list, tuple)):
                return sum(self._estimate_size(item) for item in value)
            else:
                # Fallback: use pickle size
                return len(pickle.dumps(value))
        except Exception:
            return 1024  # Default estimate

    def _get_total_cache_size_mb(self) -> float:
        """Get total cache size in MB."""
        try:
            total_size = 0
            for cache_type in self.CACHE_TYPES:
                cache_dir = self.cache_subdirs[cache_type]
                if cache_dir.exists():
                    for file_path in cache_dir.iterdir():
                        if file_path.is_file():
                            total_size += file_path.stat().st_size

            return total_size / (1024 * 1024)

        except Exception as e:
            self.handle_error(e, "_get_total_cache_size_mb")
            return 0.0

    def _get_cache_type_size_mb(self, cache_type: str) -> float:
        """Get cache size for a specific type in MB."""
        try:
            cache_dir = self.cache_subdirs[cache_type]
            if not cache_dir.exists():
                return 0.0

            total_size = 0
            for file_path in cache_dir.iterdir():
                if file_path.is_file():
                    total_size += file_path.stat().st_size

            return total_size / (1024 * 1024)

        except Exception as e:
            self.handle_error(e, f"_get_cache_type_size_mb({cache_type})")
            return 0.0

    def _get_cache_type_item_count(self, cache_type: str) -> int:
        """Get number of items in a cache type."""
        try:
            cache_dir = self.cache_subdirs[cache_type]
            if not cache_dir.exists():
                return 0

            return len([f for f in cache_dir.iterdir() if f.is_file()])

        except Exception as e:
            self.handle_error(e, f"_get_cache_type_item_count({cache_type})")
            return 0

    def _start_cleanup_timer(self) -> None:
        """Start the automatic cleanup timer."""
        try:
            interval_ms = self.cleanup_interval_minutes * 60 * 1000
            self.cleanup_timer.start(interval_ms)
            self.logger.debug(f"Cache cleanup timer started (interval: {self.cleanup_interval_minutes} minutes)")

        except Exception as e:
            self.handle_error(e, "_start_cleanup_timer")

    def _perform_automatic_cleanup(self) -> None:
        """Perform automatic cache cleanup."""
        try:
            self.signals.cache_cleanup_started.emit()

            # Clean up expired entries
            expired_removed, expired_freed = self.cleanup_expired()

            # Enforce size limits
            limit_removed, limit_freed = self.enforce_size_limits()

            total_removed = expired_removed + limit_removed
            total_freed = expired_freed + limit_freed

            if total_removed > 0:
                self.logger.info(f"Automatic cleanup: removed {total_removed} items, freed {total_freed} bytes")

        except Exception as e:
            self.handle_error(e, "_perform_automatic_cleanup")

    def _perform_initial_cleanup(self) -> None:
        """Perform initial cleanup on startup."""
        try:
            # Clean up any expired entries from previous sessions
            self.cleanup_expired()

            # Ensure we're within size limits
            self.enforce_size_limits()

        except Exception as e:
            self.handle_error(e, "_perform_initial_cleanup")

    def _load_cache_metadata(self) -> None:
        """Load cache metadata from previous sessions."""
        try:
            # Skip loading if cache directory is not initialized
            if not self.cache_directory:
                self.logger.debug("Cache directory not initialized, skipping metadata load")
                return

            metadata_file = self.cache_directory / 'cache_metadata.json'
            if metadata_file.exists():
                with open(metadata_file, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)

                # Restore statistics if available
                if 'stats' in metadata:
                    for cache_type, stats in metadata['stats'].items():
                        if cache_type in self.cache_stats:
                            self.cache_stats[cache_type].update(stats)

        except Exception as e:
            self.handle_error(e, "_load_cache_metadata")

    def _save_cache_metadata(self) -> None:
        """Save cache metadata for next session."""
        try:
            # Skip saving if cache directory is not initialized
            if not self.cache_directory:
                self.logger.debug("Cache directory not initialized, skipping metadata save")
                return

            metadata = {
                'last_cleanup': time.time(),
                'stats': self.cache_stats,
                'version': '1.0'
            }

            metadata_file = self.cache_directory / 'cache_metadata.json'
            with open(metadata_file, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2)

        except Exception as e:
            self.handle_error(e, "_save_cache_metadata")

    def _cleanup_expired_cache_type(self, cache_type: str) -> Tuple[int, int]:
        """Clean up expired entries for a specific cache type."""
        try:
            cache_dir = self.cache_subdirs[cache_type]
            if not cache_dir.exists():
                return 0, 0

            removed_count = 0
            freed_bytes = 0

            for cache_file in cache_dir.iterdir():
                if cache_file.is_file() and self._is_cache_file_expired(cache_file, cache_type):
                    file_size = cache_file.stat().st_size
                    cache_file.unlink()
                    removed_count += 1
                    freed_bytes += file_size

            return removed_count, freed_bytes

        except Exception as e:
            self.handle_error(e, f"_cleanup_expired_cache_type({cache_type})")
            return 0, 0

    def _enforce_cache_type_limit(self, cache_type: str, limit_mb: int) -> Tuple[int, int]:
        """Enforce size limit for a specific cache type using LRU eviction."""
        try:
            cache_dir = self.cache_subdirs[cache_type]
            if not cache_dir.exists():
                return 0, 0

            # Get all cache files with their access times
            cache_files = []
            for cache_file in cache_dir.iterdir():
                if cache_file.is_file():
                    stat = cache_file.stat()
                    cache_files.append((cache_file, stat.st_atime, stat.st_size))

            # Sort by access time (oldest first)
            cache_files.sort(key=lambda x: x[1])

            # Calculate current size
            current_size = sum(size for _, _, size in cache_files)
            limit_bytes = limit_mb * 1024 * 1024

            removed_count = 0
            freed_bytes = 0

            # Remove oldest files until we're under the limit
            for cache_file, _, size in cache_files:
                if current_size <= limit_bytes:
                    break

                cache_file.unlink()
                current_size -= size
                removed_count += 1
                freed_bytes += size

            if removed_count > 0:
                self.cache_stats[cache_type]['evictions'] += removed_count

            return removed_count, freed_bytes

        except Exception as e:
            self.handle_error(e, f"_enforce_cache_type_limit({cache_type}, {limit_mb})")
            return 0, 0

    def _remove_from_memory_cache(self, cache_type: str, key: str) -> None:
        """Remove item from memory cache."""
        try:
            if key in self.memory_cache[cache_type]:
                del self.memory_cache[cache_type][key]
            if key in self.memory_cache_access_times[cache_type]:
                del self.memory_cache_access_times[cache_type][key]

        except Exception as e:
            self.handle_error(e, f"_remove_from_memory_cache({cache_type}, {key})")

    def _remove_from_disk_cache(self, cache_type: str, key: str) -> bool:
        """Remove item from disk cache."""
        try:
            cache_file = self._get_cache_file_path(cache_type, key)
            if cache_file.exists():
                cache_file.unlink()
                self.cache_stats[cache_type]['evictions'] += 1
                return True
            return False

        except Exception as e:
            self.handle_error(e, f"_remove_from_disk_cache({cache_type}, {key})")
            return False

    def _clear_memory_cache(self, cache_type: str) -> None:
        """Clear memory cache for a specific type."""
        try:
            self.memory_cache[cache_type].clear()
            self.memory_cache_access_times[cache_type].clear()

        except Exception as e:
            self.handle_error(e, f"_clear_memory_cache({cache_type})")

    def _clear_disk_cache(self, cache_type: str) -> bool:
        """Clear disk cache for a specific type."""
        try:
            cache_dir = self.cache_subdirs[cache_type]
            if not cache_dir.exists():
                return True

            removed_count = 0
            for cache_file in cache_dir.iterdir():
                if cache_file.is_file():
                    cache_file.unlink()
                    removed_count += 1

            if removed_count > 0:
                self.cache_stats[cache_type]['evictions'] += removed_count

            return True

        except Exception as e:
            self.handle_error(e, f"_clear_disk_cache({cache_type})")
            return False

    def _exists_in_memory_cache(self, cache_type: str, key: str) -> bool:
        """Check if item exists in memory cache."""
        return key in self.memory_cache[cache_type]

    def _exists_in_disk_cache(self, cache_type: str, key: str) -> bool:
        """Check if item exists in disk cache."""
        try:
            cache_file = self._get_cache_file_path(cache_type, key)
            if not cache_file.exists():
                return False

            # Check if expired
            return not self._is_cache_file_expired(cache_file, cache_type)

        except Exception as e:
            self.handle_error(e, f"_exists_in_disk_cache({cache_type}, {key})")
            return False

    # ========================================
    # Public Utility Methods
    # ========================================

    def get_cache_directory(self) -> Path:
        """Get the main cache directory path."""
        return self.cache_directory

    def get_cache_subdirectory(self, cache_type: str) -> Optional[Path]:
        """Get the subdirectory for a specific cache type."""
        return self.cache_subdirs.get(cache_type)

    def is_cache_enabled(self, cache_type: str) -> bool:
        """Check if caching is enabled for a specific type."""
        try:
            config_manager = self.container.get_service('configuration')
            if config_manager and config_manager.is_initialized():
                return config_manager.get_setting(f'cache.{cache_type}_enabled', True)
            return True

        except Exception as e:
            self.handle_error(e, f"is_cache_enabled({cache_type})")
            return True

    def get_cache_info(self) -> Dict[str, Any]:
        """Get comprehensive cache information."""
        try:
            stats = self.get_cache_stats()

            info = {
                'cache_directory': str(self.cache_directory),
                'total_cache_limit_mb': self.total_cache_limit_mb,
                'cleanup_interval_minutes': self.cleanup_interval_minutes,
                'memory_cache_limit': self.memory_cache_limit,
                'cache_types': list(self.CACHE_TYPES.keys()),
                'statistics': stats,
                'subdirectories': {ct: str(path) for ct, path in self.cache_subdirs.items()}
            }

            return info

        except Exception as e:
            self.handle_error(e, "get_cache_info")
            return {}
