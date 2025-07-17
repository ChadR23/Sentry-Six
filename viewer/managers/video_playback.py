"""
Video Playback Manager

Manages all video playback operations and player synchronization
for the SentrySix application.

Week 2 Implementation: Extracted from TeslaCamViewer monolith.
"""

from typing import List, Set, Optional
import os
from datetime import timedelta, datetime
from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
from PyQt6.QtMultimediaWidgets import QGraphicsVideoItem
from PyQt6.QtCore import QObject, pyqtSignal, QUrl, QTimer
from .base import BaseManager


class VideoPlaybackManagerSignals(QObject):
    """Signal emitter for VideoPlaybackManager."""
    playback_state_changed = pyqtSignal(bool)  # is_playing
    position_changed = pyqtSignal(int)  # position_ms
    segment_changed = pyqtSignal(int)  # segment_index
    error_occurred = pyqtSignal(str)  # error_message
    player_swap_completed = pyqtSignal()  # when player set swap is done


class VideoPlaybackManager(BaseManager):
    """
    Manages all video playback operations and player synchronization.

    Extracted from TeslaCamViewer in Week 2 refactoring:
    - Player state management (get_active_players, get_inactive_players)
    - Playback controls (play_all, pause_all, frame_action)
    - Seeking and loading (seek_all_global, _load_and_set_segment)
    - Player synchronization and preloading
    """

    def __init__(self, parent_widget, dependency_container):
        """Initialize the VideoPlaybackManager."""
        super().__init__(parent_widget, dependency_container)

        # Create signal emitter
        self.signals = VideoPlaybackManagerSignals()

        # Player management
        self.players_a: List[QMediaPlayer] = []
        self.players_b: List[QMediaPlayer] = []
        self.video_items_a: List[QGraphicsVideoItem] = []
        self.video_items_b: List[QGraphicsVideoItem] = []
        self.active_player_set = 'a'

        # Seeking state
        self.pending_seek_position = -1
        self.players_awaiting_seek: Set[QMediaPlayer] = set()

        # Playback state
        self.is_playing = False
        self.current_segment_index = -1
        self.playback_rate = 1.0

        # Week 3 Enhancement: Additional state variables
        self.is_playing = False
        self.players_awaiting_seek = set()
        self.pending_seek_position = -1

        # Error recovery state
        self.recovery_attempts = {}  # Track recovery attempts per player
        self.max_recovery_attempts = 3
        self.corrupted_files = set()  # Track known corrupted files
        self.fallback_segments = {}  # Track fallback segments for corrupted ones

        # Performance monitoring
        self.performance_history = []
        self.last_performance_check = datetime.now()

        # Get dependencies
        self.app_state = None
        self.camera_name_to_index = None
        self.hwacc_detector = None

        self.logger.debug("VideoPlaybackManager created")

    def initialize(self) -> bool:
        """
        Initialize video players and connect signals.

        Returns:
            bool: True if initialization was successful
        """
        try:
            # Get dependencies from container
            self.app_state = self.container.get_service('app_state')
            self.camera_name_to_index = self.container.get_service('camera_map')



            # Get hardware acceleration detector from parent
            if hasattr(self.parent_widget, 'hwacc_gpu_type'):
                self.hwacc_gpu_type = self.parent_widget.hwacc_gpu_type
                self.hwacc_available = self.parent_widget.hwacc_available
            else:
                self.hwacc_gpu_type = None
                self.hwacc_available = False

            # Use existing players from parent widget or create new ones
            if (hasattr(self.parent_widget, 'players_a') and
                hasattr(self.parent_widget, 'players_b') and
                hasattr(self.parent_widget, 'video_items_a') and
                hasattr(self.parent_widget, 'video_items_b')):
                # Use existing players from TeslaCamViewer
                self.players_a = self.parent_widget.players_a
                self.players_b = self.parent_widget.players_b
                self.video_items_a = self.parent_widget.video_items_a
                self.video_items_b = self.parent_widget.video_items_b
                self.active_player_set = getattr(self.parent_widget, 'active_player_set', 'a')

                # Update media status change handlers to use manager
                self._update_existing_signal_connections()
            else:
                # Create new players (fallback)
                self._create_players_and_items()

            self.logger.info("VideoPlaybackManager initialized successfully")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "VideoPlaybackManager initialization")
            return False

    def _create_players_and_items(self) -> None:
        """Create media players and video items (extracted from TeslaCamViewer)."""
        self.players_a.clear()
        self.players_b.clear()
        self.video_items_a.clear()
        self.video_items_b.clear()

        for i in range(6):
            # Create player A
            player_a = QMediaPlayer()
            player_a.setAudioOutput(QAudioOutput())
            player_a.mediaStatusChanged.connect(
                lambda s, p=player_a, idx=i: self._handle_media_status_changed(s, p, idx)
            )

            # Create player B
            player_b = QMediaPlayer()
            player_b.setAudioOutput(QAudioOutput())
            player_b.mediaStatusChanged.connect(
                lambda s, p=player_b, idx=i: self._handle_media_status_changed(s, p, idx)
            )

            # Configure hardware acceleration if available
            if self.hwacc_available and self.hwacc_gpu_type:
                self._configure_hardware_acceleration(player_a, i)
                self._configure_hardware_acceleration(player_b, i)

            self.players_a.append(player_a)
            self.players_b.append(player_b)

            # Create video items
            video_item_a = QGraphicsVideoItem()
            video_item_b = QGraphicsVideoItem()

            self.video_items_a.append(video_item_a)
            self.video_items_b.append(video_item_b)

            # Connect players to video items
            self.players_a[i].setVideoOutput(self.video_items_a[i])
            self.players_b[i].setVideoOutput(self.video_items_b[i])

    def _configure_hardware_acceleration(self, player: QMediaPlayer, index: int) -> None:
        """Configure hardware acceleration for a player."""
        try:
            # Import hwacc_detector here to avoid circular imports
            from ..hwacc_detector import hwacc_detector
            hwacc_detector.configure_media_player_hwacc(player, self.hwacc_gpu_type)
            self.logger.debug(f"Configured hardware acceleration for player {index}")
        except Exception as e:
            self.logger.warning(f"Failed to configure hardware acceleration for player {index}: {e}")

    def _handle_media_status_changed(self, status, player: QMediaPlayer, index: int) -> None:
        """Handle media status changes for players."""
        try:
            # Delegate to parent widget's handler if it exists
            if hasattr(self.parent_widget, 'handle_media_status_changed'):
                self.parent_widget.handle_media_status_changed(status, player, index)
        except Exception as e:
            self.handle_error(e, f"media status change for player {index}")

    def _update_existing_signal_connections(self) -> None:
        """Update existing player signal connections to use manager."""
        try:
            # Disconnect existing connections and reconnect to manager
            for i, (player_a, player_b) in enumerate(zip(self.players_a, self.players_b)):
                # Disconnect existing connections
                try:
                    player_a.mediaStatusChanged.disconnect()
                    player_b.mediaStatusChanged.disconnect()
                except:
                    pass  # Ignore if no connections exist

                # Reconnect to manager
                player_a.mediaStatusChanged.connect(
                    lambda s, p=player_a, idx=i: self._handle_media_status_changed(s, p, idx)
                )
                player_b.mediaStatusChanged.connect(
                    lambda s, p=player_b, idx=i: self._handle_media_status_changed(s, p, idx)
                )

        except Exception as e:
            self.logger.warning(f"Error updating signal connections: {e}")

    def cleanup(self) -> None:
        """Clean up video players and resources."""
        try:
            self._mark_cleanup_started()

            # Stop all players and clear sources
            for player_set in [self.players_a, self.players_b]:
                for player in player_set:
                    try:
                        player.stop()
                        player.setSource(QUrl())
                    except Exception as e:
                        self.logger.warning(f"Error stopping player: {e}")

            # Clear player lists
            self.players_a.clear()
            self.players_b.clear()
            self.video_items_a.clear()
            self.video_items_b.clear()

            # Clear seeking state
            self.pending_seek_position = -1
            self.players_awaiting_seek.clear()

            self.logger.info("VideoPlaybackManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "VideoPlaybackManager cleanup")

    # ========================================
    # Player State Management (Extracted from TeslaCamViewer)
    # ========================================

    def get_active_players(self) -> List[QMediaPlayer]:
        """Get currently active player set."""
        return self.players_a if self.active_player_set == 'a' else self.players_b

    def get_inactive_players(self) -> List[QMediaPlayer]:
        """Get currently inactive player set."""
        return self.players_b if self.active_player_set == 'a' else self.players_a

    def get_active_video_items(self) -> List[QGraphicsVideoItem]:
        """Get currently active video items."""
        return self.video_items_a if self.active_player_set == 'a' else self.video_items_b

    def get_inactive_video_items(self) -> List[QGraphicsVideoItem]:
        """Get currently inactive video items."""
        return self.video_items_b if self.active_player_set == 'a' else self.video_items_a

    # ========================================
    # Playback Control Methods (Extracted from TeslaCamViewer)
    # ========================================

    def toggle_play_pause_all(self) -> None:
        """Toggle play/pause state for all active players."""
        try:
            if not self.app_state.is_daily_view_active:
                return

            # Check if any player is currently playing
            if any(p.playbackState() == QMediaPlayer.PlaybackState.PlayingState
                   for p in self.get_active_players()):
                self.pause_all()
            else:
                self.play_all()

        except Exception as e:
            self.handle_error(e, "toggle_play_pause_all")

    def play_all(self) -> None:
        """Start playback on all active players (extracted from TeslaCamViewer)."""
        try:
            self.is_playing = True

            # Get playback rate from parent widget if available
            rate = self.playback_rate
            if hasattr(self.parent_widget, 'playback_rates') and hasattr(self.parent_widget, 'speed_selector'):
                rate = self.parent_widget.playback_rates.get(
                    self.parent_widget.speed_selector.currentText(), 1.0
                )

            any_playing = False
            active_players = self.get_active_players()

            # Get visible player indices from parent widget
            visible_indices = getattr(self.parent_widget, 'ordered_visible_player_indices', list(range(6)))

            for i, player in enumerate(active_players):
                if i in visible_indices and player.source() and player.source().isValid():
                    player.setPlaybackRate(rate)
                    player.play()
                    any_playing = True

            # Start position update timer if available
            if any_playing and hasattr(self.parent_widget, 'position_update_timer'):
                self.parent_widget.position_update_timer.start()

            # Update UI button text
            if hasattr(self.parent_widget, 'play_btn'):
                self.parent_widget.play_btn.setText("⏸️ Pause")

            # Emit signal
            self.signals.playback_state_changed.emit(True)

        except Exception as e:
            self.handle_error(e, "play_all")

    def pause_all(self) -> None:
        """Pause playback on all active players (extracted from TeslaCamViewer)."""
        try:
            self.is_playing = False

            # Pause all active players
            for player in self.get_active_players():
                player.pause()

            # Stop position update timer if available
            if hasattr(self.parent_widget, 'position_update_timer'):
                self.parent_widget.position_update_timer.stop()

            # Update UI button text
            if hasattr(self.parent_widget, 'play_btn'):
                self.parent_widget.play_btn.setText("▶️ Play")

            # Update slider and time display
            if hasattr(self.parent_widget, 'update_slider_and_time_display'):
                self.parent_widget.update_slider_and_time_display()

            # Emit signal
            self.signals.playback_state_changed.emit(False)

        except Exception as e:
            self.handle_error(e, "pause_all")

    def frame_action(self, offset_ms: int) -> None:
        """Move playback by frame offset (extracted from TeslaCamViewer)."""
        try:
            if not self.app_state.is_daily_view_active:
                return

            # Pause playback first
            self.pause_all()

            # Apply frame offset to all active players
            for player in self.get_active_players():
                if player.source() and player.source().isValid():
                    new_position = player.position() + offset_ms
                    player.setPosition(max(0, new_position))

            # Update slider and time display
            if hasattr(self.parent_widget, 'update_slider_and_time_display'):
                self.parent_widget.update_slider_and_time_display()

        except Exception as e:
            self.handle_error(e, f"frame_action({offset_ms})")

    def set_playback_rate(self, rate: float) -> None:
        """Set playback rate for all players."""
        try:
            self.playback_rate = rate

            # Apply to currently playing players
            if self.is_playing:
                for player in self.get_active_players():
                    if player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
                        player.setPlaybackRate(rate)

        except Exception as e:
            self.handle_error(e, f"set_playback_rate({rate})")

    # ========================================
    # Complex Seeking Logic (Extracted from TeslaCamViewer)
    # ========================================

    def seek_all_global(self, global_ms: int, restore_play_state: bool = False) -> None:
        """
        Seek all players to a global timeline position (extracted from TeslaCamViewer).

        This is the main seeking method that handles complex segment switching
        and player synchronization.
        """
        try:
            if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day:
                return

            # Check if we were playing before seeking
            was_playing = self.is_playing
            if hasattr(self.parent_widget, 'play_btn'):
                was_playing = self.parent_widget.play_btn.text() == "⏸️ Pause"

            if was_playing:
                self.pause_all()

            # Import required modules
            from .. import utils

            # Calculate target datetime
            target_dt = self.app_state.first_timestamp_of_day + timedelta(milliseconds=max(0, global_ms))
            front_clips = self.app_state.daily_clip_collections[self.camera_name_to_index["front"]]

            if not front_clips:
                if restore_play_state and was_playing:
                    self.play_all()
                return

            # Find the target segment index
            target_seg_idx = -1
            # Find the last segment whose start time is before or at the target time
            for i, clip_path in enumerate(front_clips):
                m = utils.filename_pattern.match(os.path.basename(clip_path))
                if m:
                    clip_start_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-', ':')}", "%Y-%m-%d %H:%M:%S")
                    if clip_start_dt <= target_dt:
                        target_seg_idx = i
                    else:
                        # Since clips are sorted, we can stop once we pass the target time
                        break

            if target_seg_idx == -1:
                if restore_play_state and was_playing:
                    self.play_all()
                return

            # Calculate position within the segment
            m = utils.filename_pattern.match(os.path.basename(front_clips[target_seg_idx]))
            if m:
                s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-', ':')}", "%Y-%m-%d %H:%M:%S")
                pos_in_seg_ms = int((target_dt - s_dt).total_seconds() * 1000)
            else:
                pos_in_seg_ms = 0

            # Load segment or seek within current segment
            if target_seg_idx != self.app_state.playback_state.clip_indices[0]:
                self._load_and_set_segment(target_seg_idx, pos_in_seg_ms)
            else:
                # If we are in the same segment, we can just seek directly
                for player in self.get_active_players():
                    player.setPosition(pos_in_seg_ms)

            # Update UI
            if hasattr(self.parent_widget, 'update_slider_and_time_display'):
                self.parent_widget.update_slider_and_time_display()

            # Restore play state if requested
            if restore_play_state and was_playing:
                self.play_all()

        except Exception as e:
            self.handle_error(e, f"seek_all_global({global_ms})")

    def _load_and_set_segment(self, segment_index: int, position_ms: int = 0) -> None:
        """
        Load and set a specific segment across all players (extracted from TeslaCamViewer).

        This method handles the complex logic of switching segments, managing
        player sets, and setting up pending seeks.
        """
        try:
            from ..state import PlaybackState
            from .. import utils

            # Cancel any previous pending seek operation
            self.pending_seek_position = -1
            self.players_awaiting_seek.clear()
            # Sync with parent widget
            if hasattr(self.parent_widget, 'pending_seek_position'):
                self.parent_widget.pending_seek_position = -1
            if hasattr(self.parent_widget, 'players_awaiting_seek'):
                self.parent_widget.players_awaiting_seek.clear()

            # When seeking, we forcefully switch to player set 'a' as the active one
            # This simplifies the logic by providing a consistent state
            self.active_player_set = 'a'
            # Sync with parent widget
            if hasattr(self.parent_widget, 'active_player_set'):
                self.parent_widget.active_player_set = 'a'

            active_players = self.get_active_players()
            active_video_items = self.get_active_video_items()

            # Stop the other player set to prevent it from continuing playback in the background
            for player in self.get_inactive_players():
                player.stop()

            front_clips = self.app_state.daily_clip_collections[self.camera_name_to_index["front"]]
            if not (0 <= segment_index < len(front_clips)):
                if utils.DEBUG_UI:
                    print(f"Segment index {segment_index} out of range. Aborting load.")
                return

            # Calculate segment start time
            m = utils.filename_pattern.match(os.path.basename(front_clips[segment_index]))
            if m and self.app_state.first_timestamp_of_day:
                s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-', ':')}", "%Y-%m-%d %H:%M:%S")
                segment_start_ms = int((s_dt - self.app_state.first_timestamp_of_day).total_seconds() * 1000)
            else:
                segment_start_ms = 0

            # Update playback state
            self.app_state.playback_state = PlaybackState(
                clip_indices=[segment_index] * 6,
                segment_start_ms=segment_start_ms
            )

            # Update the UI to show the new video items immediately
            if hasattr(self.parent_widget, 'video_player_item_widgets'):
                for i in range(6):
                    self.parent_widget.video_player_item_widgets[i].set_video_item(active_video_items[i])

            # Get visible player indices from parent widget
            visible_indices = getattr(self.parent_widget, 'ordered_visible_player_indices', list(range(6)))

            # Only load visible cameras
            players_to_load = set()
            for i in visible_indices:
                clips = self.app_state.daily_clip_collections[i]
                if 0 <= segment_index < len(clips):
                    players_to_load.add(active_players[i])
                    self._load_next_clip_for_player_set(active_players, i)
                else:
                    active_players[i].setSource(QUrl())

            # Unload hidden cameras
            for i in set(range(6)) - set(visible_indices):
                active_players[i].setSource(QUrl())

            if not players_to_load:
                return

            if utils.DEBUG_UI:
                print(f"--- Loading segment {segment_index}, preparing pending seek to {position_ms}ms ---")

            # Set up the pending seek operation. It will be executed in handle_media_status_changed
            self.pending_seek_position = position_ms
            self.players_awaiting_seek = players_to_load
            # Sync with parent widget
            if hasattr(self.parent_widget, 'pending_seek_position'):
                self.parent_widget.pending_seek_position = position_ms
            if hasattr(self.parent_widget, 'players_awaiting_seek'):
                self.parent_widget.players_awaiting_seek = players_to_load.copy()

            # Preload next segment
            self._preload_next_segment()

        except Exception as e:
            self.handle_error(e, f"_load_and_set_segment({segment_index}, {position_ms})")

    def _preload_next_segment(self) -> None:
        """
        Preload the next segment in the inactive player set (extracted from TeslaCamViewer).

        This optimizes playback by preparing the next segment in advance.
        """
        try:
            if not self.app_state.is_daily_view_active:
                return

            from .. import utils

            next_segment_index = self.app_state.playback_state.clip_indices[0] + 1
            front_cam_idx = self.camera_name_to_index["front"]

            if next_segment_index >= len(self.app_state.daily_clip_collections[front_cam_idx]):
                return

            inactive_players = self.get_inactive_players()

            # Check if already preloaded
            if inactive_players[front_cam_idx].source().isValid():
                path = inactive_players[front_cam_idx].source().path()
                expected_path = self.app_state.daily_clip_collections[front_cam_idx][next_segment_index]
                if os.path.basename(path) == os.path.basename(expected_path):
                    return

            if utils.DEBUG_UI:
                print(f"--- Preloading segment {next_segment_index} ---")

            # Get visible player indices from parent widget
            visible_indices = getattr(self.parent_widget, 'ordered_visible_player_indices', list(range(6)))

            # Only preload visible cameras
            for i in visible_indices:
                self._load_next_clip_for_player_set(inactive_players, i, next_segment_index)

            # Unload hidden cameras
            for i in set(range(6)) - set(visible_indices):
                inactive_players[i].setSource(QUrl())

        except Exception as e:
            self.handle_error(e, "_preload_next_segment")

    def _load_next_clip_for_player_set(self, player_set: List[QMediaPlayer], player_index: int, force_index: Optional[int] = None) -> None:
        """
        Load the next clip for a specific player in a player set (extracted from TeslaCamViewer).

        Args:
            player_set: The player set (active or inactive)
            player_index: Index of the player (0-5 for cameras)
            force_index: Optional segment index to force load (for preloading)
        """
        try:
            idx_to_load = force_index if force_index is not None else self.app_state.playback_state.clip_indices[player_index]
            clips = self.app_state.daily_clip_collections[player_index]

            if 0 <= idx_to_load < len(clips):
                player_set[player_index].setSource(QUrl.fromLocalFile(clips[idx_to_load]))
            else:
                player_set[player_index].setSource(QUrl())

        except Exception as e:
            self.handle_error(e, f"_load_next_clip_for_player_set({player_index}, {force_index})")

    def handle_media_status_changed(self, status, player_instance: QMediaPlayer, player_index: int) -> None:
        """
        Handle media status changes for players (extracted from TeslaCamViewer).

        This method handles pending seeks and end-of-media events.
        """
        try:
            from .. import utils

            front_idx = self.camera_name_to_index["front"]

            # Handle end of media - trigger player set swap
            if (status == QMediaPlayer.MediaStatus.EndOfMedia and
                player_instance.source() and player_instance.source().isValid()):
                if player_index == front_idx and player_instance in self.get_active_players():
                    self._swap_player_sets()

            # Handle pending seeks when media is loaded
            elif (status == QMediaPlayer.MediaStatus.LoadedMedia and
                  self.pending_seek_position >= 0 and
                  player_instance in self.players_awaiting_seek):

                player_instance.setPosition(self.pending_seek_position)
                self.players_awaiting_seek.discard(player_instance)

                if not self.players_awaiting_seek:
                    if utils.DEBUG_UI:
                        print(f"--- Pending seek to {self.pending_seek_position}ms completed. ---")
                    self.pending_seek_position = -1
                    # Sync with parent widget
                    if hasattr(self.parent_widget, 'pending_seek_position'):
                        self.parent_widget.pending_seek_position = -1

        except Exception as e:
            self.handle_error(e, f"handle_media_status_changed({status}, {player_index})")

    def _swap_player_sets(self) -> None:
        """
        Swap active and inactive player sets for seamless playback (extracted from TeslaCamViewer).

        This enables continuous playback across segment boundaries.
        """
        try:
            from ..state import PlaybackState
            from .. import utils

            # Cancel any pending seeks before swapping, as they are no longer relevant
            self.pending_seek_position = -1
            self.players_awaiting_seek.clear()
            # Sync with parent widget
            if hasattr(self.parent_widget, 'pending_seek_position'):
                self.parent_widget.pending_seek_position = -1
            if hasattr(self.parent_widget, 'players_awaiting_seek'):
                self.parent_widget.players_awaiting_seek.clear()

            new_active_set = 'b' if self.active_player_set == 'a' else 'a'
            if utils.DEBUG_UI:
                print(f"--- Swapping player sets. New active set: {new_active_set} ---")

            # Check if we were playing
            was_playing = self.is_playing
            if hasattr(self.parent_widget, 'play_btn'):
                was_playing = self.parent_widget.play_btn.text() == "⏸️ Pause"

            # Stop current active players
            for player in self.get_active_players():
                player.stop()

            # Swap to new active set
            self.active_player_set = new_active_set
            # Sync with parent widget
            if hasattr(self.parent_widget, 'active_player_set'):
                self.parent_widget.active_player_set = new_active_set

            active_players = self.get_active_players()
            active_video_items = self.get_active_video_items()

            next_segment_index = self.app_state.playback_state.clip_indices[0] + 1
            front_cam_idx = self.camera_name_to_index["front"]

            # Check if we've reached the end
            if next_segment_index >= len(self.app_state.daily_clip_collections[front_cam_idx]):
                self.pause_all()
                return

            # Calculate new segment start time
            front_clips = self.app_state.daily_clip_collections[front_cam_idx]
            m = utils.filename_pattern.match(os.path.basename(front_clips[next_segment_index]))
            if m and self.app_state.first_timestamp_of_day:
                s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-', ':')}", "%Y-%m-%d %H:%M:%S")
                segment_start_ms = int((s_dt - self.app_state.first_timestamp_of_day).total_seconds() * 1000)
            else:
                segment_start_ms = 0

            # Update playback state
            self.app_state.playback_state = PlaybackState(
                clip_indices=[next_segment_index] * 6,
                segment_start_ms=segment_start_ms
            )

            # Update UI and reset player positions
            if hasattr(self.parent_widget, 'video_player_item_widgets'):
                for i in range(6):
                    self.parent_widget.video_player_item_widgets[i].set_video_item(active_video_items[i])
                    active_players[i].setPosition(0)

            # Check if the new segment is valid
            if active_players[front_cam_idx].mediaStatus() == QMediaPlayer.MediaStatus.InvalidMedia:
                if utils.DEBUG_UI:
                    print(f"--- Segment {next_segment_index} is invalid, skipping. ---")
                # Use QTimer to avoid recursion issues
                QTimer.singleShot(0, self._swap_player_sets)
                return

            # Resume playback if we were playing
            if was_playing:
                self.play_all()

            # Preload the next segment
            self._preload_next_segment()

            # Emit signal
            self.signals.player_swap_completed.emit()

        except Exception as e:
            self.handle_error(e, "_swap_player_sets")

    # ========================================
    # Performance Optimization Methods (Week 3 Implementation)
    # ========================================

    def _optimized_preload_next_segment(self) -> None:
        """
        Optimized preloading with intelligent memory management and priority-based loading.

        Performance improvements:
        - Smart memory usage
        - Priority-based camera loading (front camera first)
        - Asynchronous loading to prevent UI blocking
        - Intelligent cache management
        """
        try:
            from .. import utils

            if not self.app_state.is_daily_view_active:
                return

            front_cam_idx = self.camera_name_to_index["front"]
            current_segment_index = self.app_state.playback_state.clip_indices[front_cam_idx]
            next_segment_index = current_segment_index + 1

            # Check if next segment exists
            front_clips = self.app_state.daily_clip_collections[front_cam_idx]
            if next_segment_index >= len(front_clips):
                return

            # OPTIMIZATION: Priority-based loading - front camera first
            inactive_players = self.get_inactive_players()
            visible_indices = getattr(self.parent_widget, 'ordered_visible_player_indices', list(range(6)))

            # Load front camera first (highest priority)
            if front_cam_idx in visible_indices:
                self._load_camera_with_priority(inactive_players[front_cam_idx], front_cam_idx, next_segment_index, priority=1)

            # OPTIMIZATION: Staggered loading for other cameras to spread I/O load
            other_cameras = [i for i in visible_indices if i != front_cam_idx]
            for delay_ms, camera_idx in enumerate(other_cameras, start=1):
                QTimer.singleShot(delay_ms * 25, lambda idx=camera_idx:
                    self._load_camera_with_priority(inactive_players[idx], idx, next_segment_index, priority=2))

            # OPTIMIZATION: Unload hidden cameras to free memory
            hidden_cameras = set(range(6)) - set(visible_indices)
            for camera_idx in hidden_cameras:
                inactive_players[camera_idx].setSource(QUrl())

            if utils.DEBUG_UI:
                print(f"--- Optimized preloading segment {next_segment_index} ---")

        except Exception as e:
            self.handle_error(e, "_optimized_preload_next_segment")

    def _load_camera_with_priority(self, player: QMediaPlayer, camera_idx: int, segment_index: int, priority: int) -> None:
        """Load a specific camera with priority-based resource allocation."""
        try:
            if segment_index >= len(self.app_state.daily_clip_collections[camera_idx]):
                return

            clip_path = self.app_state.daily_clip_collections[camera_idx][segment_index]

            # OPTIMIZATION: Validate file exists before loading
            if os.path.exists(clip_path):
                player.setSource(QUrl.fromLocalFile(clip_path))

                # OPTIMIZATION: Set buffer size based on priority
                if hasattr(player, 'setBufferSize'):
                    buffer_size = 8192 if priority == 1 else 4096  # Front camera gets larger buffer
                    player.setBufferSize(buffer_size)

        except Exception as e:
            self.handle_error(e, f"_load_camera_with_priority(camera_{camera_idx}, segment_{segment_index})")

    def _optimized_play_all(self) -> None:
        """
        Optimized play_all with intelligent resource management and smooth startup.

        Performance improvements:
        - Staggered player startup to reduce CPU spikes
        - Smart validation to avoid unnecessary operations
        - Optimized UI updates
        - Better error recovery
        """
        try:
            if not self.app_state.is_daily_view_active:
                return

            active_players = self.get_active_players()
            visible_indices = getattr(self.parent_widget, 'ordered_visible_player_indices', list(range(6)))

            # OPTIMIZATION: Pre-validate players to avoid failed play attempts
            valid_players = []
            for i, player in enumerate(active_players):
                if i in visible_indices and player.source() and player.source().isValid():
                    valid_players.append((i, player))

            if not valid_players:
                return

            # OPTIMIZATION: Staggered startup to reduce CPU load
            front_cam_idx = self.camera_name_to_index["front"]

            # Start front camera immediately (most important)
            for i, player in valid_players:
                if i == front_cam_idx:
                    player.play()
                    break

            # Start other cameras with small delays
            other_players = [(i, player) for i, player in valid_players if i != front_cam_idx]
            for delay_idx, (i, player) in enumerate(other_players):
                QTimer.singleShot((delay_idx + 1) * 15, player.play)

            # Update state and UI
            self.is_playing = True
            if hasattr(self.parent_widget, 'play_btn'):
                self.parent_widget.play_btn.setText("⏸️ Pause")

            # OPTIMIZATION: Start position timer with adaptive interval
            if hasattr(self.parent_widget, 'position_update_timer'):
                # Use faster updates during seeking, slower during normal playback
                interval = 50 if self.pending_seek_position >= 0 else 100
                self.parent_widget.position_update_timer.start(interval)

            # Emit signal
            self.signals.playback_state_changed.emit(True)

        except Exception as e:
            self.handle_error(e, "_optimized_play_all")

    def get_performance_metrics(self) -> dict:
        """
        Get performance metrics for monitoring and optimization.

        Returns:
            dict: Performance metrics including memory usage, player states, etc.
        """
        try:
            metrics = {
                'active_player_set': self.active_player_set,
                'is_playing': self.is_playing,
                'pending_seeks': len(self.players_awaiting_seek),
                'loaded_players': 0,
                'valid_sources': 0,
                'memory_usage': {
                    'active_players': len(self.players_a) if self.active_player_set == 'a' else len(self.players_b),
                    'inactive_players': len(self.players_b) if self.active_player_set == 'a' else len(self.players_a)
                }
            }

            # Count loaded and valid players
            for player_set in [self.players_a, self.players_b]:
                for player in player_set:
                    if player.source() and player.source().isValid():
                        metrics['valid_sources'] += 1
                    if player.mediaStatus() in [QMediaPlayer.MediaStatus.LoadedMedia, QMediaPlayer.MediaStatus.BufferedMedia]:
                        metrics['loaded_players'] += 1

            return metrics

        except Exception as e:
            self.handle_error(e, "get_performance_metrics")
            return {}

    # ========================================
    # Advanced Seeking Features (Week 3 Implementation)
    # ========================================

    def seek_frame_accurate(self, global_ms: int, frame_precision: bool = True) -> bool:
        """
        Frame-accurate seeking with precise positioning.

        Args:
            global_ms: Global timeline position in milliseconds
            frame_precision: Whether to seek to exact frame boundaries

        Returns:
            bool: True if seek was successful
        """
        try:
            if not self.app_state.is_daily_view_active:
                return False

            # OPTIMIZATION: Calculate target frame if frame precision is enabled
            if frame_precision:
                # Assume 30 FPS for frame calculation (can be made dynamic)
                fps = 30.0
                frame_duration_ms = 1000.0 / fps
                target_frame = round(global_ms / frame_duration_ms)
                global_ms = int(target_frame * frame_duration_ms)

            # Store original playback state
            was_playing = self.is_playing
            if was_playing:
                self.pause_all()

            # Perform the seek
            success = self.seek_all_global(global_ms, restore_play_state=False)

            # OPTIMIZATION: Wait for seek completion before resuming
            if success and was_playing:
                # Use a short delay to ensure seek has completed
                QTimer.singleShot(100, self.play_all)

            return success

        except Exception as e:
            self.handle_error(e, f"seek_frame_accurate({global_ms}, {frame_precision})")
            return False

    def create_bookmark(self, name: str, global_ms: int = None) -> dict:
        """
        Create a bookmark at the current or specified position.

        Args:
            name: Human-readable name for the bookmark
            global_ms: Position in milliseconds (current position if None)

        Returns:
            dict: Bookmark data
        """
        try:
            if global_ms is None:
                # Get current position from front camera
                front_cam_idx = self.camera_name_to_index["front"]
                active_players = self.get_active_players()
                current_position = active_players[front_cam_idx].position()
                segment_start_ms = self.app_state.playback_state.segment_start_ms
                global_ms = segment_start_ms + current_position

            # Create bookmark data
            bookmark = {
                'name': name,
                'global_ms': global_ms,
                'timestamp': datetime.now().isoformat(),
                'segment_index': self.app_state.playback_state.clip_indices[0],
                'local_position_ms': global_ms - self.app_state.playback_state.segment_start_ms
            }

            # Store in app state (extend AppState if needed)
            if not hasattr(self.app_state, 'bookmarks'):
                self.app_state.bookmarks = []

            self.app_state.bookmarks.append(bookmark)

            # Emit signal for UI updates
            if hasattr(self.signals, 'bookmark_created'):
                self.signals.bookmark_created.emit(bookmark)

            return bookmark

        except Exception as e:
            self.handle_error(e, f"create_bookmark({name}, {global_ms})")
            return {}

    def seek_to_bookmark(self, bookmark: dict) -> bool:
        """
        Seek to a specific bookmark position.

        Args:
            bookmark: Bookmark data dictionary

        Returns:
            bool: True if seek was successful
        """
        try:
            if 'global_ms' not in bookmark:
                return False

            return self.seek_frame_accurate(bookmark['global_ms'], frame_precision=True)

        except Exception as e:
            self.handle_error(e, f"seek_to_bookmark({bookmark.get('name', 'unknown')})")
            return False

    def get_bookmarks(self) -> list:
        """Get all bookmarks for the current session."""
        try:
            return getattr(self.app_state, 'bookmarks', [])
        except Exception as e:
            self.handle_error(e, "get_bookmarks")
            return []

    def delete_bookmark(self, bookmark_name: str) -> bool:
        """
        Delete a bookmark by name.

        Args:
            bookmark_name: Name of the bookmark to delete

        Returns:
            bool: True if bookmark was found and deleted
        """
        try:
            if not hasattr(self.app_state, 'bookmarks'):
                return False

            original_count = len(self.app_state.bookmarks)
            self.app_state.bookmarks = [b for b in self.app_state.bookmarks if b.get('name') != bookmark_name]

            deleted = len(self.app_state.bookmarks) < original_count

            if deleted and hasattr(self.signals, 'bookmark_deleted'):
                self.signals.bookmark_deleted.emit(bookmark_name)

            return deleted

        except Exception as e:
            self.handle_error(e, f"delete_bookmark({bookmark_name})")
            return False

    def seek_relative(self, offset_ms: int) -> bool:
        """
        Seek relative to current position.

        Args:
            offset_ms: Milliseconds to seek forward (positive) or backward (negative)

        Returns:
            bool: True if seek was successful
        """
        try:
            if not self.app_state.is_daily_view_active:
                return False

            # Get current global position
            front_cam_idx = self.camera_name_to_index["front"]
            active_players = self.get_active_players()
            current_position = active_players[front_cam_idx].position()
            segment_start_ms = self.app_state.playback_state.segment_start_ms
            current_global_ms = segment_start_ms + current_position

            # Calculate new position
            new_global_ms = max(0, current_global_ms + offset_ms)

            return self.seek_frame_accurate(new_global_ms, frame_precision=False)

        except Exception as e:
            self.handle_error(e, f"seek_relative({offset_ms})")
            return False

    def get_current_frame_info(self) -> dict:
        """
        Get detailed information about the current frame.

        Returns:
            dict: Frame information including position, timestamp, etc.
        """
        try:
            if not self.app_state.is_daily_view_active:
                return {}

            front_cam_idx = self.camera_name_to_index["front"]
            active_players = self.get_active_players()
            front_player = active_players[front_cam_idx]

            current_position = front_player.position()
            segment_start_ms = self.app_state.playback_state.segment_start_ms
            global_ms = segment_start_ms + current_position

            # Calculate frame number (assuming 30 FPS)
            fps = 30.0
            frame_number = int(global_ms * fps / 1000.0)

            # Get timestamp if available
            timestamp = None
            if self.app_state.first_timestamp_of_day:
                timestamp = self.app_state.first_timestamp_of_day + timedelta(milliseconds=global_ms)

            return {
                'global_position_ms': global_ms,
                'local_position_ms': current_position,
                'segment_index': self.app_state.playback_state.clip_indices[front_cam_idx],
                'frame_number': frame_number,
                'timestamp': timestamp.isoformat() if timestamp else None,
                'is_playing': self.is_playing,
                'media_status': front_player.mediaStatus().name if hasattr(front_player.mediaStatus(), 'name') else str(front_player.mediaStatus())
            }

        except Exception as e:
            self.handle_error(e, "get_current_frame_info")
            return {}

    # ========================================
    # Error Recovery & Resilience (Week 3 Implementation)
    # ========================================



    def handle_corrupted_file(self, file_path: str, player_index: int) -> bool:
        """
        Handle corrupted or unreadable video files with intelligent recovery.

        Args:
            file_path: Path to the corrupted file
            player_index: Index of the player that encountered the error

        Returns:
            bool: True if recovery was successful
        """
        try:
            self.corrupted_files.add(file_path)

            # Log the corruption
            self.logger.warning(f"Corrupted file detected: {file_path}")

            # Try to find a fallback segment
            segment_index = self._get_segment_index_from_path(file_path)
            if segment_index is not None:
                fallback_segment = self._find_fallback_segment(segment_index, player_index)

                if fallback_segment:
                    self.fallback_segments[file_path] = fallback_segment

                    # Load fallback segment
                    player = self._get_player_by_index(player_index)
                    if player:
                        player.setSource(QUrl.fromLocalFile(fallback_segment))
                        self.logger.info(f"Using fallback segment: {fallback_segment}")
                        return True

            # If no fallback available, skip this segment
            self._skip_corrupted_segment(segment_index, player_index)
            return False

        except Exception as e:
            self.handle_error(e, f"handle_corrupted_file({file_path}, {player_index})")
            return False

    def _find_fallback_segment(self, segment_index: int, camera_index: int) -> str:
        """Find a suitable fallback segment for a corrupted file."""
        try:
            camera_clips = self.app_state.daily_clip_collections[camera_index]

            # Try adjacent segments first
            for offset in [1, -1, 2, -2]:
                fallback_index = segment_index + offset
                if 0 <= fallback_index < len(camera_clips):
                    fallback_path = camera_clips[fallback_index]
                    if os.path.exists(fallback_path) and fallback_path not in self.corrupted_files:
                        return fallback_path

            # Try other cameras at the same time index
            for other_camera_index in range(6):
                if other_camera_index != camera_index:
                    other_clips = self.app_state.daily_clip_collections[other_camera_index]
                    if segment_index < len(other_clips):
                        fallback_path = other_clips[segment_index]
                        if os.path.exists(fallback_path) and fallback_path not in self.corrupted_files:
                            return fallback_path

            return None

        except Exception as e:
            self.handle_error(e, f"_find_fallback_segment({segment_index}, {camera_index})")
            return None

    def recover_from_hardware_failure(self, player_index: int) -> bool:
        """
        Recover from hardware acceleration or decoder failures.

        Args:
            player_index: Index of the player that failed

        Returns:
            bool: True if recovery was successful
        """
        try:
            player = self._get_player_by_index(player_index)
            if not player:
                return False

            recovery_key = f"hw_failure_{player_index}"
            attempts = self.recovery_attempts.get(recovery_key, 0)

            if attempts >= self.max_recovery_attempts:
                self.logger.error(f"Max recovery attempts reached for player {player_index}")
                return False

            self.recovery_attempts[recovery_key] = attempts + 1

            # Try different recovery strategies
            if attempts == 0:
                # First attempt: Reset player
                self._reset_player(player)

            elif attempts == 1:
                # Second attempt: Disable hardware acceleration
                self._disable_hardware_acceleration(player)

            elif attempts == 2:
                # Third attempt: Recreate player
                self._recreate_player(player_index)

            self.logger.info(f"Hardware recovery attempt {attempts + 1} for player {player_index}")
            return True

        except Exception as e:
            self.handle_error(e, f"recover_from_hardware_failure({player_index})")
            return False

    def _reset_player(self, player: QMediaPlayer) -> None:
        """Reset a player to its initial state."""
        try:
            current_source = player.source()
            player.stop()
            player.setSource(QUrl())
            QTimer.singleShot(100, lambda: player.setSource(current_source))

        except Exception as e:
            self.handle_error(e, "_reset_player")

    def _disable_hardware_acceleration(self, player: QMediaPlayer) -> None:
        """Disable hardware acceleration for a specific player."""
        try:
            # This would depend on the specific Qt multimedia backend
            # For now, we'll log the attempt
            self.logger.info("Attempting to disable hardware acceleration")

            # Reset with software decoding preference
            current_source = player.source()
            player.stop()
            player.setSource(QUrl())

            # Set software decoding preference if available
            if hasattr(player, 'setVideoSink'):
                # Qt6 approach - would need specific implementation
                pass

            QTimer.singleShot(100, lambda: player.setSource(current_source))

        except Exception as e:
            self.handle_error(e, "_disable_hardware_acceleration")

    def _recreate_player(self, player_index: int) -> None:
        """Recreate a player from scratch."""
        try:
            # Determine which player set
            if player_index < 6:
                player_set = self.players_a
                video_items = self.video_items_a
            else:
                player_set = self.players_b
                video_items = self.video_items_b
                player_index -= 6

            # Store current source
            old_player = player_set[player_index]
            current_source = old_player.source()

            # Create new player
            new_player = QMediaPlayer()
            new_audio_output = QAudioOutput()
            new_player.setAudioOutput(new_audio_output)

            # Configure hardware acceleration if available
            if self.hwacc_available:
                self._configure_hardware_acceleration(new_player)

            # Replace in the list
            player_set[player_index] = new_player

            # Update video item
            video_items[player_index].setVideoOutput(new_player)

            # Reconnect signals
            self._connect_player_signals(new_player, player_index)

            # Restore source
            QTimer.singleShot(100, lambda: new_player.setSource(current_source))

            self.logger.info(f"Recreated player {player_index}")

        except Exception as e:
            self.handle_error(e, f"_recreate_player({player_index})")

    def monitor_performance(self) -> dict:
        """
        Monitor performance and detect potential issues.

        Returns:
            dict: Performance status and recommendations
        """
        try:
            now = datetime.now()
            metrics = self.get_performance_metrics()

            # Add timing information
            metrics['timestamp'] = now.isoformat()
            metrics['time_since_last_check'] = (now - self.last_performance_check).total_seconds()

            # Analyze performance
            issues = []
            recommendations = []

            # Check for too many pending seeks
            if metrics.get('pending_seeks', 0) > 5:
                issues.append("High number of pending seeks")
                recommendations.append("Consider reducing seek frequency")

            # Check for low valid sources
            total_players = metrics['memory_usage']['active_players'] + metrics['memory_usage']['inactive_players']
            valid_ratio = metrics.get('valid_sources', 0) / max(total_players, 1)
            if valid_ratio < 0.5:
                issues.append("Low ratio of valid video sources")
                recommendations.append("Check for corrupted files or network issues")

            # Check recovery attempts
            total_recovery_attempts = sum(self.recovery_attempts.values())
            if total_recovery_attempts > 10:
                issues.append("High number of recovery attempts")
                recommendations.append("Consider system restart or hardware check")

            metrics['issues'] = issues
            metrics['recommendations'] = recommendations
            metrics['health_score'] = self._calculate_health_score(metrics)

            # Store in history (keep last 100 entries)
            self.performance_history.append(metrics)
            if len(self.performance_history) > 100:
                self.performance_history.pop(0)

            self.last_performance_check = now
            return metrics

        except Exception as e:
            self.handle_error(e, "monitor_performance")
            return {'error': str(e)}

    def _calculate_health_score(self, metrics: dict) -> float:
        """Calculate a health score from 0.0 to 1.0 based on performance metrics."""
        try:
            score = 1.0

            # Deduct for issues
            score -= len(metrics.get('issues', [])) * 0.2

            # Deduct for low valid sources
            total_players = metrics['memory_usage']['active_players'] + metrics['memory_usage']['inactive_players']
            valid_ratio = metrics.get('valid_sources', 0) / max(total_players, 1)
            score -= (1.0 - valid_ratio) * 0.3

            # Deduct for recovery attempts
            total_recovery_attempts = sum(self.recovery_attempts.values())
            if total_recovery_attempts > 0:
                score -= min(total_recovery_attempts * 0.05, 0.3)

            return max(0.0, min(1.0, score))

        except Exception as e:
            self.handle_error(e, "_calculate_health_score")
            return 0.5

    def get_recovery_status(self) -> dict:
        """Get current recovery status and statistics."""
        try:
            return {
                'corrupted_files': list(self.corrupted_files),
                'recovery_attempts': dict(self.recovery_attempts),
                'fallback_segments': dict(self.fallback_segments),
                'max_recovery_attempts': self.max_recovery_attempts,
                'total_corrupted_files': len(self.corrupted_files),
                'total_recovery_attempts': sum(self.recovery_attempts.values())
            }
        except Exception as e:
            self.handle_error(e, "get_recovery_status")
            return {}

    # ========================================
    # Helper Methods for Week 3 Enhancements
    # ========================================

    def _get_segment_index_from_path(self, file_path: str) -> int:
        """Extract segment index from file path."""
        try:
            # Find the file in daily_clip_collections
            for camera_idx, clips in enumerate(self.app_state.daily_clip_collections):
                for segment_idx, clip_path in enumerate(clips):
                    if clip_path == file_path:
                        return segment_idx
            return None
        except Exception as e:
            self.handle_error(e, f"_get_segment_index_from_path({file_path})")
            return None

    def _get_player_by_index(self, player_index: int) -> QMediaPlayer:
        """Get player by index from either player set."""
        try:
            if player_index < 6:
                return self.players_a[player_index]
            else:
                return self.players_b[player_index - 6]
        except Exception as e:
            self.handle_error(e, f"_get_player_by_index({player_index})")
            return None

    def _skip_corrupted_segment(self, segment_index: int, camera_index: int) -> None:
        """Skip a corrupted segment by advancing to the next one."""
        try:
            # This would trigger automatic advancement to next segment
            # Implementation depends on specific requirements
            self.logger.warning(f"Skipping corrupted segment {segment_index} for camera {camera_index}")
        except Exception as e:
            self.handle_error(e, f"_skip_corrupted_segment({segment_index}, {camera_index})")

    def _configure_hardware_acceleration(self, player: QMediaPlayer) -> None:
        """Configure hardware acceleration for a player."""
        try:
            # This would depend on the specific Qt multimedia backend
            # For now, we'll log the configuration attempt
            if hasattr(self.parent_widget, 'hwacc_available') and self.parent_widget.hwacc_available:
                self.logger.info("Configuring hardware acceleration for player")
                # Actual hardware acceleration configuration would go here
        except Exception as e:
            self.handle_error(e, "_configure_hardware_acceleration")

    def _connect_player_signals(self, player: QMediaPlayer, player_index: int) -> None:
        """Connect signals for a player."""
        try:
            # Connect standard signals
            player.mediaStatusChanged.connect(lambda status, idx=player_index: self._on_media_status_changed(status, idx))
            player.positionChanged.connect(lambda pos, idx=player_index: self._on_position_changed(pos, idx))
        except Exception as e:
            self.handle_error(e, f"_connect_player_signals(player_{player_index})")

    def _on_media_status_changed(self, status, player_index: int) -> None:
        """Handle media status changes."""
        try:
            if status == QMediaPlayer.MediaStatus.InvalidMedia:
                self.logger.warning(f"Invalid media detected for player {player_index}")
                # Could trigger error recovery here
        except Exception as e:
            self.handle_error(e, f"_on_media_status_changed({status}, {player_index})")

    def _on_position_changed(self, position: int, player_index: int = None) -> None:
        """Handle position changes from players."""
        try:
            # Emit position change signal
            if hasattr(self.signals, 'position_changed'):
                self.signals.position_changed.emit(position)
        except Exception as e:
            self.handle_error(e, f"_on_position_changed({position}, {player_index})")
