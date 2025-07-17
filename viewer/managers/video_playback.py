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
