"""
Clip Manager for SentrySix.

This module handles file discovery, clip loading, and timeline data management.
Extracted from TeslaCamViewer as part of the manager-based architecture refactoring.
"""

import os
import re
import json
import traceback
from datetime import datetime, timedelta
from typing import List, Dict, Tuple, Optional, Set
from PyQt6.QtCore import QObject, pyqtSignal, QThread

from .base import BaseManager
from ..state import TimelineData
from .. import utils
from ..workers import ClipLoaderWorker, RecentClipsLoaderWorker


class ClipManagerSignals(QObject):
    """Signals for ClipManager communication with UI."""
    
    # File discovery signals
    folder_scan_started = pyqtSignal(str)  # root_path
    folder_scan_completed = pyqtSignal(list)  # available_dates
    folder_scan_failed = pyqtSignal(str)  # error_message
    
    # Clip loading signals
    clip_loading_started = pyqtSignal(str)  # selected_date
    clip_loading_progress = pyqtSignal(int, str)  # percentage, status_message
    clip_loading_completed = pyqtSignal(object)  # TimelineData
    clip_loading_failed = pyqtSignal(str)  # error_message
    
    # File system monitoring signals
    file_system_changed = pyqtSignal(str)  # changed_path
    new_clips_detected = pyqtSignal(str, list)  # date, new_clip_paths
    
    # Cache management signals
    cache_updated = pyqtSignal(str)  # cache_key
    cache_cleared = pyqtSignal()  # cache cleared
    
    # Validation signals
    file_validation_failed = pyqtSignal(str, str)  # file_path, error_message
    corrupted_files_detected = pyqtSignal(list)  # corrupted_file_paths




    def run(self):
        """Run the clip loading process."""
        try:
            self.progress.emit(0, "Initializing clip scan...")
            
            raw_files = {cam_idx: [] for cam_idx in range(len(self.camera_map))}
            all_ts = []
            events = []
            
            # Find potential folders for the selected date
            self.progress.emit(10, "Scanning for date folders...")
            potential_folders = [
                p for p in [os.path.join(self.root_path, d) for d in os.listdir(self.root_path)]
                if os.path.isdir(p) and os.path.basename(p).startswith(self.selected_date)
            ]
            
            if not self._is_running:
                return
                
            if not potential_folders:
                self.finished.emit(TimelineData([], [], None, 0, f"No clip folders found for {self.selected_date}"))
                return

            self.progress.emit(20, f"Found {len(potential_folders)} folders, scanning files...")
            
            total_folders = len(potential_folders)
            for folder_idx, folder in enumerate(potential_folders):
                if not self._is_running:
                    return
                    
                folder_progress = 20 + (folder_idx / total_folders) * 60
                self.progress.emit(int(folder_progress), f"Scanning folder {os.path.basename(folder)}...")
                
                for filename in os.listdir(folder):
                    if not self._is_running:
                        return
                        
                    # Process video files
                    m = utils.filename_pattern.match(filename)
                    if m:
                        try:
                            ts = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-',':')}", "%Y-%m-%d %H:%M:%S")
                            cam_idx = self.camera_map[m.group(3)]
                            raw_files[cam_idx].append((os.path.join(folder, filename), ts))
                            all_ts.append(ts)
                        except (ValueError, KeyError):
                            pass
                    # Process event files
                    elif filename == "event.json":
                        try:
                            with open(os.path.join(folder, filename), 'r') as f:
                                data = json.load(f)
                            data['timestamp_dt'] = datetime.fromisoformat(data['timestamp'])
                            data['folder_path'] = folder
                            events.append(data)
                        except (json.JSONDecodeError, KeyError, ValueError):
                            pass
            
            if not self._is_running:
                return
                
            self.progress.emit(80, "Processing timeline data...")
            
            if not all_ts:
                self.finished.emit(TimelineData([], [], None, 0, f"No valid video files found for {self.selected_date}."))
                return

            # Calculate timeline bounds
            first_ts, last_ts = min(all_ts), max(all_ts)
            last_clip_path = next((f[0] for files in raw_files.values() for f in files if f[1] == last_ts), None)
            
            total_duration = int((last_ts - first_ts).total_seconds() * 1000)
            if last_clip_path:
                total_duration += utils.get_video_duration_ms(last_clip_path)

            # Process events with timeline positions
            for evt in events:
                evt['ms_in_timeline'] = (evt['timestamp_dt'] - first_ts).total_seconds() * 1000
            
            self.progress.emit(90, "Organizing clip collections...")
            
            # Create final clip collections
            final_clip_collections = [[] for _ in range(len(self.camera_map))]
            for i in range(len(self.camera_map)):
                raw_files[i].sort(key=lambda x: x[1])
                final_clip_collections[i] = [f[0] for f in raw_files[i]]

            if not self._is_running:
                return
            
            self.progress.emit(100, "Clip loading completed")
            
            result = TimelineData(
                daily_clip_collections=final_clip_collections,
                events=events,
                first_timestamp_of_day=first_ts,
                total_duration_ms=total_duration
            )
            self.finished.emit(result)

        except Exception as e:
            error_msg = f"Error loading date videos: {e}\n{traceback.format_exc()}"
            if self._is_running:
                self.finished.emit(TimelineData([], [], None, 0, error_msg))

    def stop(self):
        """Stop the clip loading process."""
        self._is_running = False


class ClipManager(BaseManager):
    """
    Manages file discovery, clip loading, and timeline data processing.
    
    Handles:
    - File system scanning and date folder detection
    - Clip loading with progress tracking and caching
    - Timeline data processing and event management
    - File validation and corruption detection
    - Intelligent caching and indexing for performance
    """

    def __init__(self, parent_widget, dependency_container):
        """Initialize the ClipManager."""
        super().__init__(parent_widget, dependency_container)

        # Initialize signals
        self.signals = ClipManagerSignals()

        # Camera configuration
        self.camera_name_to_index = {
            "front": 0, "left_repeater": 1, "right_repeater": 2, 
            "back": 3, "left_pillar": 4, "right_pillar": 5
        }

        # File discovery state
        self.root_clips_path: Optional[str] = None
        self.available_dates: List[str] = []
        self.date_folder_pattern = re.compile(r"^(\d{4}-\d{2}-\d{2})")
        self.is_recent_clips_folder: bool = False

        # Clip loading state
        self.current_timeline_data: Optional[TimelineData] = None
        self.clip_loader_worker: Optional[ClipLoaderWorker] = None
        self.recent_clips_worker: Optional[RecentClipsLoaderWorker] = None
        self.clip_loader_thread: Optional[QThread] = None
        self.is_loading: bool = False

        # Cache management
        self.timeline_cache: Dict[str, TimelineData] = {}
        self.file_index_cache: Dict[str, List[str]] = {}
        self.cache_max_size: int = 10  # Maximum cached timeline data entries

        # Dependencies (will be set during initialization)
        self.app_state = None

        self.logger.debug("ClipManager created")

    def initialize(self) -> bool:
        """
        Initialize clip manager.

        Returns:
            bool: True if initialization was successful
        """
        try:
            # Use parent widget's app_state directly to avoid dependency injection issues
            if hasattr(self.parent_widget, 'app_state'):
                self.app_state = self.parent_widget.app_state
            else:
                # Fallback to container
                self.app_state = self.container.get_service('app_state')

            # Get camera mapping from container
            camera_map = self.container.get_service('camera_map')
            if camera_map:
                self.camera_name_to_index = camera_map

            # Initialize root path from app state
            if self.app_state and self.app_state.root_clips_path:
                self.root_clips_path = self.app_state.root_clips_path

            self.logger.info("ClipManager initialized successfully")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "ClipManager initialization")
            return False

    def cleanup(self) -> None:
        """Clean up clip manager resources."""
        try:
            self._mark_cleanup_started()

            # Stop any running clip loading
            self.stop_clip_loading()

            # Clear caches
            self.clear_all_caches()

            # Reset state
            self.root_clips_path = None
            self.available_dates.clear()
            self.current_timeline_data = None
            self.is_loading = False

            # Clear references
            self.app_state = None

            self.logger.info("ClipManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "ClipManager cleanup")

    def stop_clip_loading(self) -> None:
        """Stop any running clip loading operation."""
        try:
            # Stop regular clip loader worker
            if self.clip_loader_worker:
                self.clip_loader_worker.stop()

            # Stop RecentClips worker
            if self.recent_clips_worker:
                self.recent_clips_worker.stop()

            # Check if thread exists and is still valid before calling methods
            if self.clip_loader_thread:
                try:
                    if self.clip_loader_thread.isRunning():
                        self.clip_loader_thread.quit()
                        self.clip_loader_thread.wait(3000)  # Wait max 3 seconds
                except RuntimeError:
                    # Thread object has been deleted by Qt, ignore
                    pass

            self.clip_loader_thread = None
            self.clip_loader_worker = None
            self.recent_clips_worker = None
            self.is_loading = False

        except Exception as e:
            self.handle_error(e, "stop_clip_loading")

    def clear_all_caches(self) -> None:
        """Clear all cached data."""
        try:
            self.timeline_cache.clear()
            self.file_index_cache.clear()
            self.signals.cache_cleared.emit()
            self.logger.debug("All caches cleared")

        except Exception as e:
            self.handle_error(e, "clear_all_caches")

    # ========================================
    # File Discovery Methods (Week 6 Implementation)
    # ========================================

    def _detect_folder_type(self, path: str) -> bool:
        """
        Detect if the folder is a RecentClips folder (flat structure) or regular clips folder.

        Args:
            path: Directory path to analyze

        Returns:
            bool: True if RecentClips folder detected
        """
        try:
            if not os.path.isdir(path):
                return False

            # Check if folder name contains "RecentClips"
            folder_name = os.path.basename(path).lower()
            if "recentclips" in folder_name:
                return True

            # Check folder structure - RecentClips has video files directly in root
            has_video_files_in_root = False
            has_date_subfolders = False

            for item in os.listdir(path):
                item_path = os.path.join(path, item)

                # Check for video files in root
                if os.path.isfile(item_path) and utils.filename_pattern.match(item):
                    has_video_files_in_root = True

                # Check for date subfolders
                elif os.path.isdir(item_path) and self.date_folder_pattern.match(item):
                    has_date_subfolders = True

            # RecentClips: has video files in root, no date subfolders
            # SavedClips/SentryClips: has date subfolders, no video files in root
            return has_video_files_in_root and not has_date_subfolders

        except Exception as e:
            self.logger.warning(f"Error detecting folder type for {path}: {e}")
            return False

    def set_root_clips_path(self, path: str) -> bool:
        """
        Set the root clips path and scan for available dates.

        Args:
            path: Root directory path containing clip folders

        Returns:
            bool: True if path was set successfully
        """
        try:
            if not os.path.isdir(path):
                self.logger.warning(f"Invalid root clips path: {path}")
                return False

            self.root_clips_path = path

            # Detect folder type
            self.is_recent_clips_folder = self._detect_folder_type(path)

            # Update app state
            if self.app_state:
                self.app_state.root_clips_path = path

            # Scan for available dates
            self.scan_for_dates()

            folder_type = "RecentClips" if self.is_recent_clips_folder else "SavedClips/SentryClips"
            self.logger.info(f"Root clips path set to: {path} (detected as {folder_type})")
            return True

        except Exception as e:
            self.handle_error(e, f"set_root_clips_path({path})")
            return False

    def scan_for_dates(self) -> List[str]:
        """
        Scan root clips path for available dates.

        Returns:
            List of available date strings (YYYY-MM-DD format)
        """
        try:
            if not self.root_clips_path or not os.path.isdir(self.root_clips_path):
                self.available_dates = []
                return []

            self.signals.folder_scan_started.emit(self.root_clips_path)

            date_folders = []

            if self.is_recent_clips_folder:
                # For RecentClips, extract dates from video filenames
                unique_dates = set()
                for filename in os.listdir(self.root_clips_path):
                    if os.path.isfile(os.path.join(self.root_clips_path, filename)):
                        match = utils.filename_pattern.match(filename)
                        if match:
                            date_str = match.group(1)
                            try:
                                datetime.strptime(date_str, "%Y-%m-%d")
                                unique_dates.add(date_str)
                            except ValueError:
                                continue

                date_folders = list(unique_dates)

            else:
                # For SavedClips/SentryClips, scan date folders
                unique_dates = set()
                for item in os.listdir(self.root_clips_path):
                    item_path = os.path.join(self.root_clips_path, item)
                    if os.path.isdir(item_path):
                        match = self.date_folder_pattern.match(item)
                        if match:
                            date_str = match.group(1)
                            # Validate date format
                            try:
                                datetime.strptime(date_str, "%Y-%m-%d")
                                unique_dates.add(date_str)
                            except ValueError:
                                continue

                date_folders = list(unique_dates)

            # Sort dates in descending order (newest first)
            date_folders.sort(reverse=True)
            self.available_dates = date_folders

            self.signals.folder_scan_completed.emit(self.available_dates)
            folder_type = "RecentClips" if self.is_recent_clips_folder else "date folders"
            self.logger.debug(f"Found {len(self.available_dates)} {folder_type}")

            return self.available_dates

        except Exception as e:
            error_msg = f"Error scanning for dates: {str(e)}"
            self.handle_error(e, "scan_for_dates")
            self.signals.folder_scan_failed.emit(error_msg)
            return []

    def get_available_dates(self) -> List[str]:
        """Get list of available dates."""
        return self.available_dates.copy()

    def validate_date_folder(self, date_str: str) -> bool:
        """
        Validate that a date folder exists and contains video files.

        Args:
            date_str: Date string in YYYY-MM-DD format

        Returns:
            bool: True if date folder is valid
        """
        try:
            if not self.root_clips_path:
                return False

            if self.is_recent_clips_folder:
                # For RecentClips, check if any video files exist for the date
                for filename in os.listdir(self.root_clips_path):
                    if os.path.isfile(os.path.join(self.root_clips_path, filename)):
                        match = utils.filename_pattern.match(filename)
                        if match and match.group(1) == date_str:
                            return True
                return False
            else:
                # For SavedClips/SentryClips, find folders matching the date
                potential_folders = []
                for item in os.listdir(self.root_clips_path):
                    item_path = os.path.join(self.root_clips_path, item)
                    if os.path.isdir(item_path) and item.startswith(date_str):
                        potential_folders.append(item_path)

                if not potential_folders:
                    return False

                # Check if any folder contains video files
                for folder in potential_folders:
                    for filename in os.listdir(folder):
                        if utils.filename_pattern.match(filename):
                            return True

                return False

        except Exception as e:
            self.handle_error(e, f"validate_date_folder({date_str})")
            return False

    # ========================================
    # Clip Loading Methods (Week 6 Implementation)
    # ========================================

    def load_clips_for_date(self, date_str: str, use_cache: bool = True) -> None:
        """
        Load clips for a specific date asynchronously.

        Args:
            date_str: Date string in YYYY-MM-DD format
            use_cache: Whether to use cached data if available
        """
        try:
            if self.is_loading:
                self.logger.warning("Clip loading already in progress")
                return

            # Check cache first
            if use_cache and date_str in self.timeline_cache:
                cached_data = self.timeline_cache[date_str]
                self.current_timeline_data = cached_data
                self.signals.clip_loading_completed.emit(cached_data)
                self.logger.debug(f"Loaded clips for {date_str} from cache")
                return

            if not self.root_clips_path:
                error_msg = "No root clips path set"
                self.signals.clip_loading_failed.emit(error_msg)
                return

            if not self.validate_date_folder(date_str):
                error_msg = f"No valid clips found for date {date_str}"
                self.signals.clip_loading_failed.emit(error_msg)
                return

            # Start asynchronous loading
            self.is_loading = True
            self.signals.clip_loading_started.emit(date_str)

            # Create appropriate worker based on folder type
            self.logger.debug(f"Creating worker for folder type: {'RecentClips' if self.is_recent_clips_folder else 'Regular'}")
            if self.is_recent_clips_folder:
                # Use RecentClips worker for flat file structure
                self.recent_clips_worker = RecentClipsLoaderWorker(
                    self.root_clips_path,
                    self.camera_name_to_index
                )
                worker = self.recent_clips_worker
                self.logger.debug(f"Created RecentClipsLoaderWorker")
            else:
                # Use regular worker for date folder structure
                self.clip_loader_worker = ClipLoaderWorker(
                    self.root_clips_path,
                    date_str,
                    self.camera_name_to_index
                )
                worker = self.clip_loader_worker
                self.logger.debug(f"Created ClipLoaderWorker for date {date_str}")

            self.clip_loader_thread = QThread()

            # Move worker to thread
            worker.moveToThread(self.clip_loader_thread)

            # Connect signals
            self.clip_loader_thread.started.connect(worker.run)
            worker.finished.connect(self._on_clip_loading_finished)
            worker.progress.connect(self._on_clip_loading_progress)
            worker.finished.connect(self.clip_loader_thread.quit)
            worker.finished.connect(worker.deleteLater)
            self.clip_loader_thread.finished.connect(self.clip_loader_thread.deleteLater)

            # Start the thread
            self.clip_loader_thread.start()

            self.logger.debug(f"Started loading clips for {date_str}")

        except Exception as e:
            self.is_loading = False
            error_msg = f"Error starting clip loading: {str(e)}"
            self.handle_error(e, f"load_clips_for_date({date_str})")
            self.signals.clip_loading_failed.emit(error_msg)

    def _on_clip_loading_progress(self, percentage: int, status: str) -> None:
        """Handle clip loading progress updates."""
        try:
            self.signals.clip_loading_progress.emit(percentage, status)
        except Exception as e:
            self.handle_error(e, "_on_clip_loading_progress")

    def _on_clip_loading_finished(self, timeline_data: TimelineData) -> None:
        """Handle clip loading completion."""
        try:
            self.is_loading = False
            self.current_timeline_data = timeline_data

            # Cache the result if successful
            if timeline_data and not timeline_data.error:
                # Determine cache key from timeline data
                if timeline_data.first_timestamp_of_day:
                    date_str = timeline_data.first_timestamp_of_day.strftime("%Y-%m-%d")
                    self._cache_timeline_data(date_str, timeline_data)

            # Emit completion signal
            self.signals.clip_loading_completed.emit(timeline_data)

            self.logger.debug("Clip loading completed")

        except Exception as e:
            self.handle_error(e, "_on_clip_loading_finished")

    def get_current_timeline_data(self) -> Optional[TimelineData]:
        """Get the currently loaded timeline data."""
        return self.current_timeline_data

    def is_clip_loading_in_progress(self) -> bool:
        """Check if clip loading is currently in progress."""
        return self.is_loading

    # ========================================
    # Cache Management Methods (Week 6 Implementation)
    # ========================================

    def _cache_timeline_data(self, date_str: str, timeline_data: TimelineData) -> None:
        """
        Cache timeline data for a specific date.

        Args:
            date_str: Date string in YYYY-MM-DD format
            timeline_data: Timeline data to cache
        """
        try:
            # Implement LRU cache behavior
            if len(self.timeline_cache) >= self.cache_max_size:
                # Remove oldest entry
                oldest_key = next(iter(self.timeline_cache))
                del self.timeline_cache[oldest_key]
                self.logger.debug(f"Removed oldest cache entry: {oldest_key}")

            self.timeline_cache[date_str] = timeline_data
            self.signals.cache_updated.emit(date_str)
            self.logger.debug(f"Cached timeline data for {date_str}")

        except Exception as e:
            self.handle_error(e, f"_cache_timeline_data({date_str})")

    def get_cached_timeline_data(self, date_str: str) -> Optional[TimelineData]:
        """
        Get cached timeline data for a specific date.

        Args:
            date_str: Date string in YYYY-MM-DD format

        Returns:
            Cached timeline data or None if not found
        """
        return self.timeline_cache.get(date_str)

    def is_date_cached(self, date_str: str) -> bool:
        """Check if timeline data for a date is cached."""
        return date_str in self.timeline_cache

    def clear_cache_for_date(self, date_str: str) -> bool:
        """
        Clear cached data for a specific date.

        Args:
            date_str: Date string in YYYY-MM-DD format

        Returns:
            bool: True if cache was cleared
        """
        try:
            if date_str in self.timeline_cache:
                del self.timeline_cache[date_str]
                self.logger.debug(f"Cleared cache for {date_str}")
                return True
            return False

        except Exception as e:
            self.handle_error(e, f"clear_cache_for_date({date_str})")
            return False

    def get_cache_info(self) -> Dict[str, any]:
        """Get information about current cache state."""
        try:
            return {
                'timeline_cache_size': len(self.timeline_cache),
                'timeline_cache_max_size': self.cache_max_size,
                'cached_dates': list(self.timeline_cache.keys()),
                'file_index_cache_size': len(self.file_index_cache),
                'memory_usage_estimate': self._estimate_cache_memory_usage()
            }

        except Exception as e:
            self.handle_error(e, "get_cache_info")
            return {}

    def _estimate_cache_memory_usage(self) -> str:
        """Estimate memory usage of caches."""
        try:
            # Rough estimation based on cache sizes
            timeline_size = len(self.timeline_cache) * 1024  # Rough estimate per timeline
            file_index_size = sum(len(files) for files in self.file_index_cache.values()) * 100  # Rough estimate per file path
            total_bytes = timeline_size + file_index_size

            if total_bytes < 1024:
                return f"{total_bytes} B"
            elif total_bytes < 1024 * 1024:
                return f"{total_bytes / 1024:.1f} KB"
            else:
                return f"{total_bytes / (1024 * 1024):.1f} MB"

        except Exception as e:
            self.handle_error(e, "_estimate_cache_memory_usage")
            return "Unknown"

    # ========================================
    # File Indexing Methods (Week 6 Implementation)
    # ========================================

    def build_file_index_for_date(self, date_str: str) -> Dict[str, List[str]]:
        """
        Build file index for a specific date.

        Args:
            date_str: Date string in YYYY-MM-DD format

        Returns:
            Dictionary mapping camera names to file lists
        """
        try:
            if not self.root_clips_path:
                return {}

            # Check cache first
            cache_key = f"{date_str}_{self.root_clips_path}"
            if cache_key in self.file_index_cache:
                return self.file_index_cache[cache_key]

            # Build index
            file_index = {name: [] for name in self.camera_name_to_index.keys()}

            if self.is_recent_clips_folder:
                # For RecentClips, scan files directly in root folder
                for filename in os.listdir(self.root_clips_path):
                    if os.path.isfile(os.path.join(self.root_clips_path, filename)):
                        match = utils.filename_pattern.match(filename)
                        if match and match.group(1) == date_str:
                            try:
                                camera_name = match.group(3)
                                if camera_name in file_index:
                                    file_path = os.path.join(self.root_clips_path, filename)
                                    file_index[camera_name].append(file_path)
                            except (ValueError, KeyError):
                                continue
            else:
                # For SavedClips/SentryClips, find folders for the date
                potential_folders = []
                for item in os.listdir(self.root_clips_path):
                    item_path = os.path.join(self.root_clips_path, item)
                    if os.path.isdir(item_path) and item.startswith(date_str):
                        potential_folders.append(item_path)

                # Scan files in each folder
                for folder in potential_folders:
                    for filename in os.listdir(folder):
                        match = utils.filename_pattern.match(filename)
                        if match:
                            try:
                                camera_name = match.group(3)
                                if camera_name in file_index:
                                    file_path = os.path.join(folder, filename)
                                    file_index[camera_name].append(file_path)
                            except (ValueError, KeyError):
                                continue

            # Sort files by timestamp
            for camera_name in file_index:
                file_index[camera_name].sort()

            # Cache the result
            self.file_index_cache[cache_key] = file_index

            self.logger.debug(f"Built file index for {date_str}")
            return file_index

        except Exception as e:
            self.handle_error(e, f"build_file_index_for_date({date_str})")
            return {}

    def get_files_for_camera(self, date_str: str, camera_name: str) -> List[str]:
        """
        Get list of files for a specific camera and date.

        Args:
            date_str: Date string in YYYY-MM-DD format
            camera_name: Camera name (e.g., 'front', 'back')

        Returns:
            List of file paths for the camera
        """
        try:
            file_index = self.build_file_index_for_date(date_str)
            return file_index.get(camera_name, [])

        except Exception as e:
            self.handle_error(e, f"get_files_for_camera({date_str}, {camera_name})")
            return []

    def get_total_file_count_for_date(self, date_str: str) -> int:
        """
        Get total number of video files for a specific date.

        Args:
            date_str: Date string in YYYY-MM-DD format

        Returns:
            Total number of video files
        """
        try:
            file_index = self.build_file_index_for_date(date_str)
            return sum(len(files) for files in file_index.values())

        except Exception as e:
            self.handle_error(e, f"get_total_file_count_for_date({date_str})")
            return 0

    # ========================================
    # File System Monitoring (Week 6 Implementation)
    # ========================================

    def enable_file_system_monitoring(self) -> bool:
        """
        Enable file system monitoring for the root clips path.

        Returns:
            bool: True if monitoring was enabled successfully
        """
        try:
            # Note: For now, we'll implement a simple polling-based approach
            # In a production system, you might want to use QFileSystemWatcher
            # or a more sophisticated file monitoring library

            if not self.root_clips_path:
                self.logger.warning("Cannot enable file system monitoring: no root path set")
                return False

            # For now, just log that monitoring would be enabled
            self.logger.info(f"File system monitoring enabled for: {self.root_clips_path}")
            return True

        except Exception as e:
            self.handle_error(e, "enable_file_system_monitoring")
            return False

    def disable_file_system_monitoring(self) -> None:
        """Disable file system monitoring."""
        try:
            self.logger.info("File system monitoring disabled")

        except Exception as e:
            self.handle_error(e, "disable_file_system_monitoring")

    def check_for_new_clips(self, date_str: str) -> List[str]:
        """
        Check for new clips that may have been added for a specific date.

        Args:
            date_str: Date string in YYYY-MM-DD format

        Returns:
            List of new clip file paths
        """
        try:
            if not self.root_clips_path:
                return []

            # Clear cache and rebuild to detect new files
            cache_key = f"{date_str}_{self.root_clips_path}"
            if cache_key in self.file_index_cache:
                old_index = self.file_index_cache[cache_key]
                del self.file_index_cache[cache_key]

                # Rebuild index
                new_index = self.build_file_index_for_date(date_str)

                # Find new files
                new_files = []
                for camera_name in new_index:
                    old_files = set(old_index.get(camera_name, []))
                    new_files_for_camera = [f for f in new_index[camera_name] if f not in old_files]
                    new_files.extend(new_files_for_camera)

                if new_files:
                    self.signals.new_clips_detected.emit(date_str, new_files)
                    self.logger.info(f"Detected {len(new_files)} new clips for {date_str}")

                return new_files

            return []

        except Exception as e:
            self.handle_error(e, f"check_for_new_clips({date_str})")
            return []

    # ========================================
    # Cache Optimization (Week 6 Implementation)
    # ========================================

    def optimize_cache(self) -> None:
        """Optimize cache by removing least recently used entries."""
        try:
            if len(self.timeline_cache) <= self.cache_max_size:
                return

            # Simple LRU implementation - remove oldest entries
            # In a production system, you might want to track access times
            entries_to_remove = len(self.timeline_cache) - self.cache_max_size

            for _ in range(entries_to_remove):
                if self.timeline_cache:
                    oldest_key = next(iter(self.timeline_cache))
                    del self.timeline_cache[oldest_key]
                    self.logger.debug(f"Removed cache entry during optimization: {oldest_key}")

            self.logger.info(f"Cache optimized, removed {entries_to_remove} entries")

        except Exception as e:
            self.handle_error(e, "optimize_cache")

    def preload_adjacent_dates(self, current_date: str, days_ahead: int = 1, days_behind: int = 1) -> None:
        """
        Preload timeline data for dates adjacent to the current date.

        Args:
            current_date: Current date string in YYYY-MM-DD format
            days_ahead: Number of days ahead to preload
            days_behind: Number of days behind to preload
        """
        try:
            current_dt = datetime.strptime(current_date, "%Y-%m-%d")

            # Generate dates to preload
            dates_to_preload = []

            # Add dates behind
            for i in range(1, days_behind + 1):
                date_behind = (current_dt - timedelta(days=i)).strftime("%Y-%m-%d")
                if date_behind in self.available_dates and not self.is_date_cached(date_behind):
                    dates_to_preload.append(date_behind)

            # Add dates ahead
            for i in range(1, days_ahead + 1):
                date_ahead = (current_dt + timedelta(days=i)).strftime("%Y-%m-%d")
                if date_ahead in self.available_dates and not self.is_date_cached(date_ahead):
                    dates_to_preload.append(date_ahead)

            # Preload in background (simplified - in production you might use a separate thread)
            for date_str in dates_to_preload:
                if len(self.timeline_cache) < self.cache_max_size:
                    self.logger.debug(f"Preloading data for {date_str}")
                    # Note: This would ideally be done in a background thread
                    # For now, we just mark it as a candidate for preloading

        except Exception as e:
            self.handle_error(e, f"preload_adjacent_dates({current_date})")

    def set_cache_size(self, max_size: int) -> None:
        """
        Set maximum cache size.

        Args:
            max_size: Maximum number of timeline data entries to cache
        """
        try:
            if max_size < 1:
                self.logger.warning("Cache size must be at least 1")
                return

            old_size = self.cache_max_size
            self.cache_max_size = max_size

            # Optimize cache if new size is smaller
            if max_size < old_size:
                self.optimize_cache()

            self.logger.info(f"Cache size changed from {old_size} to {max_size}")

        except Exception as e:
            self.handle_error(e, f"set_cache_size({max_size})")

    # ========================================
    # Background File Scanning (Week 6 Implementation)
    # ========================================

    def start_background_scan(self) -> None:
        """Start background scanning for file changes."""
        try:
            # Note: This is a placeholder for background scanning functionality
            # In a production system, you would implement this with QTimer or QThread
            self.logger.info("Background file scanning started")

        except Exception as e:
            self.handle_error(e, "start_background_scan")

    def stop_background_scan(self) -> None:
        """Stop background scanning."""
        try:
            self.logger.info("Background file scanning stopped")

        except Exception as e:
            self.handle_error(e, "stop_background_scan")

    # ========================================
    # Public API Methods (Week 6 Implementation)
    # ========================================

    def get_clip_manager_state(self) -> dict:
        """Get comprehensive clip manager state information."""
        try:
            return {
                'root_clips_path': self.root_clips_path,
                'available_dates_count': len(self.available_dates),
                'available_dates': self.available_dates.copy(),
                'is_loading': self.is_loading,
                'current_timeline_loaded': self.current_timeline_data is not None,
                'cache_info': self.get_cache_info(),
                'manager_initialized': self.is_initialized(),
                'total_cameras': len(self.camera_name_to_index)
            }

        except Exception as e:
            self.handle_error(e, "get_clip_manager_state")
            return {}

    def refresh_available_dates(self) -> List[str]:
        """Refresh the list of available dates by rescanning the root path."""
        try:
            # Clear any cached date information
            self.available_dates.clear()

            # Rescan for dates
            return self.scan_for_dates()

        except Exception as e:
            self.handle_error(e, "refresh_available_dates")
            return []

    def invalidate_cache_for_date(self, date_str: str) -> None:
        """
        Invalidate all cached data for a specific date.

        Args:
            date_str: Date string in YYYY-MM-DD format
        """
        try:
            # Clear timeline cache
            self.clear_cache_for_date(date_str)

            # Clear file index cache
            cache_key = f"{date_str}_{self.root_clips_path}"
            if cache_key in self.file_index_cache:
                del self.file_index_cache[cache_key]
                self.logger.debug(f"Cleared file index cache for {date_str}")

        except Exception as e:
            self.handle_error(e, f"invalidate_cache_for_date({date_str})")

    # ========================================
    # File Validation & Error Handling (Week 6 Implementation)
    # ========================================

    def validate_video_file(self, file_path: str) -> bool:
        """
        Validate that a video file exists and is accessible.

        Args:
            file_path: Path to the video file

        Returns:
            bool: True if file is valid
        """
        try:
            if not os.path.exists(file_path):
                self.signals.file_validation_failed.emit(file_path, "File does not exist")
                return False

            if not os.path.isfile(file_path):
                self.signals.file_validation_failed.emit(file_path, "Path is not a file")
                return False

            # Check file size (empty files are invalid)
            if os.path.getsize(file_path) == 0:
                self.signals.file_validation_failed.emit(file_path, "File is empty")
                return False

            # Check file extension
            if not file_path.lower().endswith(('.mp4', '.avi', '.mov', '.mkv')):
                self.signals.file_validation_failed.emit(file_path, "Invalid video file extension")
                return False

            # Check if file is readable
            try:
                with open(file_path, 'rb') as f:
                    # Try to read first few bytes
                    f.read(1024)
            except (IOError, OSError) as e:
                self.signals.file_validation_failed.emit(file_path, f"File not readable: {str(e)}")
                return False

            return True

        except Exception as e:
            error_msg = f"Error validating file: {str(e)}"
            self.handle_error(e, f"validate_video_file({file_path})")
            self.signals.file_validation_failed.emit(file_path, error_msg)
            return False

    def validate_clip_collection(self, clip_collection: List[str]) -> Tuple[List[str], List[str]]:
        """
        Validate a collection of clip files.

        Args:
            clip_collection: List of clip file paths

        Returns:
            Tuple of (valid_files, invalid_files)
        """
        try:
            valid_files = []
            invalid_files = []

            for file_path in clip_collection:
                if self.validate_video_file(file_path):
                    valid_files.append(file_path)
                else:
                    invalid_files.append(file_path)

            if invalid_files:
                self.signals.corrupted_files_detected.emit(invalid_files)
                self.logger.warning(f"Found {len(invalid_files)} invalid files in collection")

            return valid_files, invalid_files

        except Exception as e:
            self.handle_error(e, "validate_clip_collection")
            return [], clip_collection

    def check_file_integrity(self, file_path: str) -> bool:
        """
        Check file integrity using ffprobe if available.

        Args:
            file_path: Path to the video file

        Returns:
            bool: True if file integrity is good
        """
        try:
            if not self.validate_video_file(file_path):
                return False

            # Use ffprobe to check file integrity if available
            from .. import utils
            if utils.FFPROBE_EXE and os.path.exists(utils.FFPROBE_EXE):
                import subprocess

                command = [
                    utils.FFPROBE_EXE,
                    "-v", "error",
                    "-select_streams", "v:0",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    file_path
                ]

                try:
                    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                    proc = subprocess.Popen(
                        command,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        creationflags=creation_flags
                    )
                    stdout, stderr = proc.communicate(timeout=10)

                    if proc.returncode != 0:
                        error_msg = f"ffprobe failed: {stderr.decode() if stderr else 'Unknown error'}"
                        self.signals.file_validation_failed.emit(file_path, error_msg)
                        return False

                    # If we got a duration, the file is likely valid
                    if stdout and stdout.strip():
                        return True
                    else:
                        self.signals.file_validation_failed.emit(file_path, "Could not determine file duration")
                        return False

                except subprocess.TimeoutExpired:
                    self.signals.file_validation_failed.emit(file_path, "File integrity check timed out")
                    return False
                except Exception as e:
                    self.signals.file_validation_failed.emit(file_path, f"Integrity check failed: {str(e)}")
                    return False
            else:
                # Fallback to basic validation if ffprobe not available
                return True

        except Exception as e:
            self.handle_error(e, f"check_file_integrity({file_path})")
            return False

    def recover_from_file_system_error(self, error_type: str, affected_path: str) -> bool:
        """
        Attempt to recover from file system errors.

        Args:
            error_type: Type of error (e.g., 'missing_folder', 'corrupted_file')
            affected_path: Path that caused the error

        Returns:
            bool: True if recovery was successful
        """
        try:
            self.logger.info(f"Attempting recovery from {error_type} for {affected_path}")

            if error_type == 'missing_folder':
                # Try to find alternative folders with similar names
                if self.root_clips_path and os.path.isdir(self.root_clips_path):
                    # Refresh available dates
                    self.scan_for_dates()
                    return True

            elif error_type == 'corrupted_file':
                # Remove corrupted file from cache
                for cache_key in list(self.file_index_cache.keys()):
                    file_lists = self.file_index_cache[cache_key]
                    for camera_name in file_lists:
                        if affected_path in file_lists[camera_name]:
                            file_lists[camera_name].remove(affected_path)
                            self.logger.info(f"Removed corrupted file from cache: {affected_path}")
                            return True

            elif error_type == 'permission_denied':
                # Log the issue and suggest user action
                self.logger.error(f"Permission denied for {affected_path}. User intervention required.")
                return False

            return False

        except Exception as e:
            self.handle_error(e, f"recover_from_file_system_error({error_type}, {affected_path})")
            return False

    def get_file_system_diagnostics(self) -> dict:
        """Get comprehensive file system diagnostics."""
        try:
            diagnostics = {
                'root_path_exists': False,
                'root_path_readable': False,
                'total_date_folders': 0,
                'total_video_files': 0,
                'corrupted_files': [],
                'missing_files': [],
                'permission_issues': [],
                'disk_space_info': {}
            }

            if self.root_clips_path:
                diagnostics['root_path_exists'] = os.path.exists(self.root_clips_path)

                if diagnostics['root_path_exists']:
                    try:
                        os.listdir(self.root_clips_path)
                        diagnostics['root_path_readable'] = True
                    except PermissionError:
                        diagnostics['permission_issues'].append(self.root_clips_path)

                    # Count date folders
                    diagnostics['total_date_folders'] = len(self.available_dates)

                    # Get disk space info
                    try:
                        import shutil
                        total, used, free = shutil.disk_usage(self.root_clips_path)
                        diagnostics['disk_space_info'] = {
                            'total_gb': round(total / (1024**3), 2),
                            'used_gb': round(used / (1024**3), 2),
                            'free_gb': round(free / (1024**3), 2),
                            'usage_percent': round((used / total) * 100, 1)
                        }
                    except Exception:
                        pass

            return diagnostics

        except Exception as e:
            self.handle_error(e, "get_file_system_diagnostics")
            return {}

    def cleanup_invalid_cache_entries(self) -> int:
        """
        Clean up cache entries for files that no longer exist.

        Returns:
            int: Number of entries cleaned up
        """
        try:
            cleaned_count = 0

            # Clean timeline cache
            for date_str in list(self.timeline_cache.keys()):
                timeline_data = self.timeline_cache[date_str]
                if timeline_data and timeline_data.daily_clip_collections:
                    # Check if any files in the timeline data no longer exist
                    has_missing_files = False
                    for clip_collection in timeline_data.daily_clip_collections:
                        for file_path in clip_collection:
                            if not os.path.exists(file_path):
                                has_missing_files = True
                                break
                        if has_missing_files:
                            break

                    if has_missing_files:
                        del self.timeline_cache[date_str]
                        cleaned_count += 1
                        self.logger.debug(f"Cleaned timeline cache for {date_str} (missing files)")

            # Clean file index cache
            for cache_key in list(self.file_index_cache.keys()):
                file_index = self.file_index_cache[cache_key]
                has_missing_files = False

                for camera_name in file_index:
                    file_index[camera_name] = [
                        f for f in file_index[camera_name]
                        if os.path.exists(f)
                    ]
                    if len(file_index[camera_name]) == 0:
                        has_missing_files = True

                if has_missing_files:
                    del self.file_index_cache[cache_key]
                    cleaned_count += 1
                    self.logger.debug(f"Cleaned file index cache for {cache_key}")

            if cleaned_count > 0:
                self.logger.info(f"Cleaned up {cleaned_count} invalid cache entries")

            return cleaned_count

        except Exception as e:
            self.handle_error(e, "cleanup_invalid_cache_entries")
            return 0
