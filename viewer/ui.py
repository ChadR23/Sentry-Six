import os
import json
import time
import traceback
import tempfile
import math
import re
import subprocess
from datetime import datetime, timedelta

from PyQt6.QtWidgets import (QWidget, QVBoxLayout, QLabel, QPushButton, QFileDialog,
                             QGridLayout, QHBoxLayout, QMessageBox, QComboBox, 
                             QRadioButton, QApplication, QCheckBox, QProgressDialog, 
                             QDialog, QDialogButtonBox)
from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
from PyQt6.QtMultimediaWidgets import QGraphicsVideoItem
from PyQt6.QtCore import Qt, QUrl, QTimer, QSettings, QThread
from PyQt6.QtGui import QPixmap, QAction, QKeySequence

from . import utils
from . import widgets
from . import workers
from .state import AppState, PlaybackState, ExportState, TimelineData
from .ffmpeg_builder import FFmpegCommandBuilder
from .ffmpeg_manager import FFMPEG_EXE
from .hwacc_detector import hwacc_detector
from .constants import (
    APP_TITLE, CAMERA_NAMES, get_camera_index_to_name_map, NUM_CAMERAS,
    MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT,
    DEFAULT_WINDOW_X, DEFAULT_WINDOW_Y, PLAYBACK_RATES, DEFAULT_PLAYBACK_RATE,
    PLAY_BUTTON_TEXT, PAUSE_BUTTON_TEXT, EXPORT_FILE_FILTER, LAYOUT_SPACING,
    LAYOUT_MARGINS, SETTINGS_WINDOW_GEOMETRY, SETTINGS_LAST_ROOT_FOLDER,
    SETTINGS_LAST_SPEED_TEXT, SETTINGS_CAMERA_VISIBILITY, SETTINGS_CAMERA_ORDER,
    SETTINGS_DONT_SHOW_WELCOME
)
from .logging_config import get_logger, LoggedOperation, log_errors
from .resource_manager import (
    get_resource_tracker, temporary_file, ManagedMediaPlayer, ManagedThread,
    safe_cleanup_media_player, safe_remove_file
)
from .input_validation import (
    InputValidator, ValidationResult, validate_clips_folder, validate_time_input,
    validate_export_settings, sanitize_filename
)


class WelcomeDialog(QDialog):
    """Simple first-time welcome dialog prompting for TeslaCam folder."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Welcome to Sentry-Six")
        self.setModal(True)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("It looks like this is your first time running Sentry-Six.\nPlease choose your TeslaCam clips folder to get started."))
        self.choose_btn = QPushButton("Select Clips Folder")
        layout.addWidget(self.choose_btn)
        self.dont_show_cb = QCheckBox("Don't show this again")
        layout.addWidget(self.dont_show_cb)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        layout.addWidget(buttons)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        self.choose_btn.clicked.connect(self._choose_folder)
        self.selected_folder = None

    def _choose_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "Select TeslaCam Folder")
        if folder:
            self.selected_folder = folder

class TeslaCamViewer(QWidget):
    def __init__(self, show_welcome: bool = True):
        super().__init__()
        self.logger = get_logger(__name__)
        self.logger.info("Initializing TeslaCamViewer")

        self.settings = QSettings()
        self.app_state = AppState()
        self.camera_name_to_index = CAMERA_NAMES
        self.camera_index_to_name = get_camera_index_to_name_map()

        self.logger.debug(f"Camera configuration: {len(CAMERA_NAMES)} cameras")

        # Register cleanup callback with resource tracker
        self.resource_tracker = get_resource_tracker()
        self.resource_tracker.register_cleanup_callback(self._cleanup_ui_resources)

        self.go_to_time_dialog_instance = None
        self.event_tooltip = widgets.EventToolTip(self)
        self.tooltip_timer = QTimer(self)
        self.tooltip_timer.setSingleShot(True)
        
        self.export_thread, self.export_worker = None, None
        self.clip_loader_thread, self.clip_loader_worker = None, None

        self.files_to_cleanup_after_export = []
        self.last_text_update_time = 0
        self.was_playing_before_scrub = False

        # State for robustly handling seeks to unloaded clips
        self.pending_seek_position = -1
        self.players_awaiting_seek = set()

        # Hardware acceleration detection
        self.hwacc_gpu_type = None
        self.hwacc_available = False
        self._detect_hardware_acceleration()

        self.setWindowTitle(APP_TITLE)
        self.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._layout = QVBoxLayout(self)
        self._layout.setSpacing(LAYOUT_SPACING)
        self._layout.setContentsMargins(LAYOUT_MARGINS, LAYOUT_MARGINS, LAYOUT_MARGINS, LAYOUT_MARGINS)

        self._create_top_controls()
        self._create_video_grid()
        self._create_players_and_items()
        self._create_playback_controls()
        self._create_scrubber()
        self._create_actions_and_shortcuts()

        self.setLayout(self._layout)
        
        self.position_update_timer = QTimer(self); self.position_update_timer.setInterval(300)
        self.position_update_timer.timeout.connect(self.update_slider_and_time_display)
        
        self.load_settings()

        # First-time onboarding dialog
        if show_welcome:
            self._maybe_show_welcome_dialog()
        self.update_layout()

        self.logger.info("TeslaCamViewer initialization completed")

    def _start_ffmpeg_check_with_progress(self):
        from PyQt6.QtWidgets import QProgressDialog
        self.ffmpeg_progress_dialog = QProgressDialog("Checking for FFmpeg updates...", None, 0, 0, self)
        self.ffmpeg_progress_dialog.setWindowTitle("Please Wait")
        self.ffmpeg_progress_dialog.setWindowModality(Qt.WindowModality.ApplicationModal)
        self.ffmpeg_progress_dialog.setMinimumDuration(0)
        self.ffmpeg_progress_dialog.setCancelButton(None)
        self.ffmpeg_progress_dialog.show()
        self.ffmpeg_check_thread = QThread()
        self.ffmpeg_check_worker = FFmpegCheckWorker(parent_widget=self)
        self.ffmpeg_check_worker.moveToThread(self.ffmpeg_check_thread)
        self.ffmpeg_check_thread.started.connect(self.ffmpeg_check_worker.run)
        self.ffmpeg_check_worker.finished.connect(self._on_ffmpeg_check_done)
        self.ffmpeg_check_worker.finished.connect(self.ffmpeg_check_thread.quit)
        self.ffmpeg_check_worker.finished.connect(self.ffmpeg_check_worker.deleteLater)
        self.ffmpeg_check_thread.finished.connect(self.ffmpeg_check_thread.deleteLater)
        self.ffmpeg_check_thread.start()

    def _maybe_show_welcome_dialog(self):
        if self.app_state.root_clips_path is not None and self.settings.value("welcome_seen", False, type=bool):
            return
        dlg = WelcomeDialog(self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            if dlg.selected_folder:
                self._apply_root_folder(dlg.selected_folder)
            if dlg.dont_show_cb.isChecked() or dlg.selected_folder:
                self.settings.setValue("welcome_seen", True)
        else:
            if dlg.dont_show_cb.isChecked():
                self.settings.setValue("welcome_seen", True)

    def _create_top_controls(self):
        top_controls_layout = QHBoxLayout()
        self.select_folder_btn = QPushButton("📂 Select Clips"); self.select_folder_btn.clicked.connect(self.select_root_folder)
        self.go_to_time_btn = QPushButton("⏰ Go to Time"); self.go_to_time_btn.clicked.connect(self.show_go_to_time_dialog)
        self.reset_layout_btn = QPushButton("🔄 Reset Layout"); self.reset_layout_btn.clicked.connect(self.reset_to_default_layout)
        
        self.check_update_btn = QPushButton("Check for Updates"); self.check_update_btn.clicked.connect(self.check_for_updates)
        
        self.date_selector = QComboBox(); self.date_selector.setEnabled(False)
        self.date_selector.currentIndexChanged.connect(self.handle_date_selection_change)

        top_controls_layout.addWidget(self.select_folder_btn)
        top_controls_layout.addWidget(self.go_to_time_btn)
        top_controls_layout.addWidget(self.reset_layout_btn)
        top_controls_layout.addWidget(self.check_update_btn)
        top_controls_layout.addSpacing(15)
        top_controls_layout.addWidget(QLabel("Date:"))
        top_controls_layout.addWidget(self.date_selector)
        top_controls_layout.addSpacing(25)
        
        self.camera_visibility_checkboxes, self.checkbox_info = [], [
            ("LP", "Left Pillar", self.camera_name_to_index["left_pillar"]),("F", "Front", self.camera_name_to_index["front"]),
            ("RP", "Right Pillar", self.camera_name_to_index["right_pillar"]),("LR", "Left Repeater", self.camera_name_to_index["left_repeater"]),
            ("B", "Back", self.camera_name_to_index["back"]),("RR", "Right Repeater", self.camera_name_to_index["right_repeater"]),
        ]
        for abbr, full_name, _ in self.checkbox_info:
            cb = QCheckBox(abbr); cb.setToolTip(full_name); cb.setChecked(True)
            cb.toggled.connect(self.update_layout_from_visibility_change)
            self.camera_visibility_checkboxes.append(cb); top_controls_layout.addWidget(cb)
        
        top_controls_layout.addStretch(1)
        self._layout.addLayout(top_controls_layout)

    def _create_video_grid(self):
        self.video_grid_widget = QWidget(self)
        self.video_grid = QGridLayout(self.video_grid_widget)
        self.video_grid.setSpacing(3)
        self._layout.addWidget(self.video_grid_widget, 1)

    def _create_players_and_items(self):
        self.players_a, self.players_b = [], []
        self.video_player_item_widgets = []
        self.video_items_a, self.video_items_b = [], []
        self.active_player_set = 'a'

        for i in range(6):
            player_a = QMediaPlayer(); player_a.setAudioOutput(QAudioOutput())
            player_a.mediaStatusChanged.connect(lambda s, p=player_a, idx=i: self.handle_media_status_changed(s, p, idx))
            player_b = QMediaPlayer(); player_b.setAudioOutput(QAudioOutput())
            player_b.mediaStatusChanged.connect(lambda s, p=player_b, idx=i: self.handle_media_status_changed(s, p, idx))
            self.players_a.append(player_a); self.players_b.append(player_b)

            self.video_items_a.append(QGraphicsVideoItem())
            self.video_items_b.append(QGraphicsVideoItem())
            
            self.players_a[i].setVideoOutput(self.video_items_a[i])
            self.players_b[i].setVideoOutput(self.video_items_b[i])

            widget = widgets.VideoPlayerItemWidget(i, self)
            widget.set_video_item(self.video_items_a[i])
            widget.swap_requested.connect(self.handle_widget_swap)
            self.video_player_item_widgets.append(widget)

    def _create_playback_controls(self):
        control_layout = QHBoxLayout(); control_layout.setSpacing(8); control_layout.addStretch()
        
        self.skip_bwd_15_btn = QPushButton("« 15s"); self.skip_bwd_15_btn.clicked.connect(lambda: self.seek_all_global(self.scrubber.value() - 15000, restore_play_state=True))
        self.frame_back_btn = QPushButton("⏪ FR"); self.frame_back_btn.clicked.connect(lambda: self.frame_action(-33))
        self.play_btn = QPushButton(PLAY_BUTTON_TEXT); self.play_btn.clicked.connect(self.toggle_play_pause_all)
        self.frame_forward_btn = QPushButton("FR ⏩"); self.frame_forward_btn.clicked.connect(lambda: self.frame_action(33))
        self.skip_fwd_15_btn = QPushButton("15s »"); self.skip_fwd_15_btn.clicked.connect(lambda: self.seek_all_global(self.scrubber.value() + 15000, restore_play_state=True))
        
        for btn in [self.skip_bwd_15_btn, self.frame_back_btn, self.play_btn, self.frame_forward_btn, self.skip_fwd_15_btn]:
            control_layout.addWidget(btn)
        
        control_layout.addSpacing(20)
        self.mark_start_btn = QPushButton("Set Start"); self.mark_start_btn.clicked.connect(self.mark_start_time)
        self.start_time_label = QLabel("Start: --:--"); 
        self.mark_end_btn = QPushButton("Set End"); self.mark_end_btn.clicked.connect(self.mark_end_time)
        self.end_time_label = QLabel("End: --:--")
        self.export_btn = QPushButton("Export Clip"); self.export_btn.clicked.connect(self.show_export_dialog)
        
        for w in [self.mark_start_btn, self.start_time_label, self.mark_end_btn, self.end_time_label, self.export_btn]:
            control_layout.addWidget(w)
            
        control_layout.addSpacing(20)
        self.speed_selector = QComboBox()
        self.playback_rates = PLAYBACK_RATES
        self.speed_selector.addItems(self.playback_rates.keys())
        self.speed_selector.currentTextChanged.connect(self.set_playback_speed)
        control_layout.addWidget(QLabel("Speed:"))
        control_layout.addWidget(self.speed_selector)
        
        control_layout.addStretch()
        self._layout.addLayout(control_layout)
        
    def _create_scrubber(self):
        self.slider_layout = QHBoxLayout()
        self.time_label = QLabel("MM/DD/YYYY hh:mm:ss (Clip: 00:00 / 00:00)")
        self.scrubber = widgets.ExportScrubber(Qt.Orientation.Horizontal)
        self.scrubber.setRange(0, 1000)
        self.scrubber.sliderMoved.connect(self.seek_all_global)
        self.scrubber.sliderPressed.connect(self._handle_scrubber_press)
        self.scrubber.sliderReleased.connect(self.handle_scrubber_release)
        self.scrubber.export_marker_moved.connect(self.handle_marker_drag)
        self.scrubber.event_marker_clicked.connect(self.handle_event_click)
        self.scrubber.event_marker_hovered.connect(self.handle_event_hover)
        self.scrubber.drag_started.connect(self._handle_scrubber_press)
        self.scrubber.drag_finished.connect(self._handle_marker_drag_finished)
        
        self.slider_layout.addWidget(self.time_label)
        self.slider_layout.addWidget(self.scrubber, 1)
        self._layout.addLayout(self.slider_layout)

    def _create_actions_and_shortcuts(self):
        # Play/Pause Action
        play_pause_action = QAction("Play/Pause", self)
        play_pause_action.setShortcut(QKeySequence(Qt.Key.Key_Space))
        play_pause_action.triggered.connect(self.toggle_play_pause_all)
        self.addAction(play_pause_action)

        # Frame Back Action
        frame_back_action = QAction("Frame Back", self)
        frame_back_action.setShortcut(QKeySequence(Qt.Key.Key_Left))
        frame_back_action.triggered.connect(lambda: self.frame_action(-33))
        self.addAction(frame_back_action)

        # Frame Forward Action
        frame_forward_action = QAction("Frame Forward", self)
        frame_forward_action.setShortcut(QKeySequence(Qt.Key.Key_Right))
        frame_forward_action.triggered.connect(lambda: self.frame_action(33))
        self.addAction(frame_forward_action)

        # Mark Start Action
        mark_start_action = QAction("Mark Start", self)
        mark_start_action.setShortcut(QKeySequence(Qt.Key.Key_M))
        mark_start_action.triggered.connect(self.mark_start_time)
        self.addAction(mark_start_action)

        # Mark End Action
        mark_end_action = QAction("Mark End", self)
        mark_end_action.setShortcut(QKeySequence(Qt.Key.Key_N))
        mark_end_action.triggered.connect(self.mark_end_time)
        self.addAction(mark_end_action)

        # Export Action
        export_action = QAction("Export", self)
        export_action.setShortcut(QKeySequence(Qt.Key.Key_E))
        export_action.triggered.connect(self.show_export_dialog)
        self.addAction(export_action)

    def get_active_players(self): return self.players_a if self.active_player_set == 'a' else self.players_b
    def get_inactive_players(self): return self.players_b if self.active_player_set == 'a' else self.players_a
    def get_active_video_items(self): return self.video_items_a if self.active_player_set == 'a' else self.video_items_b
        
    def reset_to_default_layout(self):
        self.settings.remove("cameraOrder") # Remove saved order to reset
        for checkbox in self.camera_visibility_checkboxes:
            checkbox.blockSignals(True)
            checkbox.setChecked(True)
            checkbox.blockSignals(False)
        # Reset the ordered_visible_player_indices to default order (all indices from checkbox_info)
        self.ordered_visible_player_indices = [idx for _, _, idx in self.checkbox_info]
        self.update_layout()
        # Reload video sources for all visible cameras
        current_segment_index = self.app_state.playback_state.clip_indices[0]
        active_players = self.get_active_players()
        reference_player = None
        for idx in self.ordered_visible_player_indices:
            if active_players[idx].mediaStatus() == QMediaPlayer.MediaStatus.LoadedMedia:
                reference_player = active_players[idx]
                break
        current_time = reference_player.position() if reference_player else 0
        is_playing = self.play_btn.text() == PAUSE_BUTTON_TEXT
        for i in self.ordered_visible_player_indices:
            self._load_next_clip_for_player_set(active_players, i, current_segment_index)
            active_players[i].setPosition(current_time)
            if is_playing:
                active_players[i].play()
        for i in set(range(6)) - set(self.ordered_visible_player_indices):
            active_players[i].setSource(QUrl())
        self.video_grid_widget.update()
        self.video_grid_widget.adjustSize()
        self.save_settings()

    def update_layout_from_visibility_change(self):
        # Update the list of visible player indices based on checkboxes
        new_visible = [
            self.checkbox_info[i][2]
            for i, cb in enumerate(self.camera_visibility_checkboxes)
            if cb.isChecked()
        ]
        # Track previously visible cameras
        last_visible = getattr(self, '_last_visible_player_indices', [])
        newly_visible = set(new_visible) - set(last_visible)
        newly_hidden = set(last_visible) - set(new_visible)

        if newly_visible:
            self.logger.info(f"Cameras becoming visible: {list(newly_visible)}")
        if newly_hidden:
            self.logger.info(f"Cameras becoming hidden: {list(newly_hidden)}")

        self.ordered_visible_player_indices = new_visible
        self.update_layout()
        # Sync newly visible cameras to current timeline position
        if newly_visible and self.app_state.is_daily_view_active:
            self.logger.debug(f"Syncing newly visible cameras {list(newly_visible)} to current timeline position")

            # Get current global timeline position
            current_global_ms = self.scrubber.value()
            is_playing = self.play_btn.text() == PAUSE_BUTTON_TEXT

            # Pause all players temporarily to avoid sync issues
            if is_playing:
                self.pause_all()

            # Load and sync newly visible cameras
            for camera_idx in newly_visible:
                self.logger.debug(f"Syncing camera {camera_idx} to {current_global_ms}ms")
                # This will load the correct clip and seek to the right position
                self._load_and_seek_player_to_global_time(camera_idx, current_global_ms)

            # Resume playback if it was playing
            if is_playing:
                # Small delay to ensure all players are loaded before resuming
                QTimer.singleShot(100, self.play_all)

        # Clean up newly hidden cameras
        active_players = self.get_active_players()
        for i in newly_hidden:
            self.logger.debug(f"Hiding camera {i}")
            active_players[i].setSource(QUrl())
        self.save_settings()
        # Update for next time
        self._last_visible_player_indices = list(new_visible)

    def _load_and_seek_player_to_global_time(self, camera_idx: int, global_ms: int):
        """Load the correct clip for a camera and seek to the specified global timeline position."""
        if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day:
            return

        try:
            # Find which clip should be playing at this global time
            target_datetime = self.app_state.first_timestamp_of_day + timedelta(milliseconds=global_ms)

            # Get the clips for this camera
            camera_clips = self.app_state.daily_clip_collections[camera_idx]
            if not camera_clips:
                self.logger.debug(f"No clips available for camera {camera_idx}")
                return

            # Find the appropriate clip and calculate local position
            target_clip_path = None
            local_position_ms = 0

            for clip_path in camera_clips:
                clip_info = utils.parse_tesla_filename(clip_path)
                if clip_info:
                    clip_start_time = clip_info['datetime']
                    clip_duration_ms = utils.get_video_duration_ms(clip_path)
                    clip_end_time = clip_start_time + timedelta(milliseconds=clip_duration_ms)

                    # Check if target time falls within this clip
                    if clip_start_time <= target_datetime < clip_end_time:
                        target_clip_path = clip_path
                        local_position_ms = int((target_datetime - clip_start_time).total_seconds() * 1000)
                        break

            if target_clip_path:
                # Load the clip and seek to position
                active_players = self.get_active_players()
                player = active_players[camera_idx]

                self.logger.debug(f"Loading clip {target_clip_path} for camera {camera_idx}, seeking to {local_position_ms}ms")

                # Set up a one-time connection to seek when media is loaded
                def on_media_loaded():
                    if player.mediaStatus() == QMediaPlayer.MediaStatus.LoadedMedia:
                        player.setPosition(local_position_ms)
                        player.mediaStatusChanged.disconnect(on_media_loaded)

                player.mediaStatusChanged.connect(on_media_loaded)
                player.setSource(QUrl.fromLocalFile(target_clip_path))
            else:
                self.logger.debug(f"No clip found for camera {camera_idx} at time {target_datetime}")

        except Exception as e:
            self.logger.error(f"Error loading and seeking camera {camera_idx} to {global_ms}ms: {e}")
    
    def handle_widget_swap(self, dragged_index, dropped_on_index):
        if utils.DEBUG_UI:
            print(f"[UI] handle_widget_swap received: Dragged={dragged_index}, Dropped On={dropped_on_index}")
            print(f"[UI] List before swap: {self.ordered_visible_player_indices}")
        
        try:
            drag_pos = self.ordered_visible_player_indices.index(dragged_index)
            drop_pos = self.ordered_visible_player_indices.index(dropped_on_index)
            
            # Swap the items in the list
            self.ordered_visible_player_indices[drag_pos], self.ordered_visible_player_indices[drop_pos] = \
                self.ordered_visible_player_indices[drop_pos], self.ordered_visible_player_indices[drag_pos]

            if utils.DEBUG_UI:
                print(f"[UI] List after swap: {self.ordered_visible_player_indices}")
                print("[UI] Calling update_layout...")

            self.update_layout()
            self.save_settings()
        except ValueError:
            if utils.DEBUG_UI: print("Error: Tried to swap indices that are not in the visible list.")

    def set_ui_loading(self, is_loading):
        """Enable/disable UI elements during async operations."""
        self.select_folder_btn.setEnabled(not is_loading)
        self.go_to_time_btn.setEnabled(not is_loading)
        self.date_selector.setEnabled(not is_loading)
        if is_loading:
            self.time_label.setText("Loading clips, please wait...")
            QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        else:
            self.time_label.setText("MM/DD/YYYY hh:mm:ss (Clip: 00:00 / 00:00)")
            QApplication.restoreOverrideCursor()

    def load_settings(self):
        geom = self.settings.value(SETTINGS_WINDOW_GEOMETRY)
        if geom:
            self.restoreGeometry(geom)
        else:
            self.setGeometry(DEFAULT_WINDOW_X, DEFAULT_WINDOW_Y, DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)

        self.speed_selector.setCurrentText(self.settings.value(SETTINGS_LAST_SPEED_TEXT, DEFAULT_PLAYBACK_RATE, type=str))

        # Load visibility first
        vis_states = self.settings.value(SETTINGS_CAMERA_VISIBILITY)
        if vis_states and len(vis_states) == len(self.camera_visibility_checkboxes):
            for i, cb in enumerate(self.camera_visibility_checkboxes):
                cb.setChecked(vis_states[i] == 'true')

        # Build the initial ordered list from the checkboxes
        visible_from_checkboxes = [self.checkbox_info[i][2] for i, cb in enumerate(self.camera_visibility_checkboxes) if cb.isChecked()]

        # Load custom order and validate it
        saved_order_str = self.settings.value(SETTINGS_CAMERA_ORDER, type=list)
        if saved_order_str:
            saved_order = [int(i) for i in saved_order_str]
            # Ensure the saved order only contains currently visible cameras
            validated_order = [idx for idx in saved_order if idx in visible_from_checkboxes]
            # Add any newly visible cameras (that weren't in the saved order) to the end
            for idx in visible_from_checkboxes:
                if idx not in validated_order:
                    validated_order.append(idx)
            self.ordered_visible_player_indices = validated_order
        else:
            self.ordered_visible_player_indices = visible_from_checkboxes

        last_folder = self.settings.value(SETTINGS_LAST_ROOT_FOLDER, "", type=str)
        if last_folder and os.path.isdir(last_folder):
            self.app_state.root_clips_path = last_folder
            self.repopulate_date_selector_from_path(last_folder)
            self.date_selector.setCurrentIndex(-1)
        
        if not self.app_state.is_daily_view_active:
            # Only clear players if they have been used, not during initial setup
            if hasattr(self, '_players_initialized') and self._players_initialized:
                self.clear_all_players()
            else:
                # Mark that players are now initialized
                self._players_initialized = True

    def save_settings(self):
        self.settings.setValue(SETTINGS_WINDOW_GEOMETRY, self.saveGeometry())
        self.settings.setValue(SETTINGS_LAST_ROOT_FOLDER, self.app_state.root_clips_path or "")
        self.settings.setValue(SETTINGS_LAST_SPEED_TEXT, self.speed_selector.currentText())
        self.settings.setValue(SETTINGS_CAMERA_VISIBILITY, [str(cb.isChecked()).lower() for cb in self.camera_visibility_checkboxes])
        # Save the custom order of visible indices
        self.settings.setValue(SETTINGS_CAMERA_ORDER, [str(i) for i in self.ordered_visible_player_indices])

    def closeEvent(self, event):
        self.logger.info("Application closing, performing cleanup")

        # Stop timers first to prevent them from triggering during cleanup
        try:
            if hasattr(self, 'position_update_timer'):
                self.position_update_timer.stop()
        except (RuntimeError, AttributeError):
            pass

        try:
            if hasattr(self, 'tooltip_timer'):
                self.tooltip_timer.stop()
        except (RuntimeError, AttributeError):
            pass

        self.save_settings()
        self.clear_all_players() # Safely stop any running workers

        # Clean up export operations
        if self.export_thread and self.export_thread.isRunning() and self.export_worker:
            self.logger.debug("Stopping export operation")
            self.export_worker.stop()
            self.export_thread.quit()
            self.export_thread.wait(5000)  # Wait up to 5 seconds

        # Clean up any remaining temporary files
        for file_path in self.files_to_cleanup_after_export:
            safe_remove_file(file_path)
        self.files_to_cleanup_after_export.clear()

        # Final cleanup of media players
        for p_set in [self.players_a, self.players_b]:
            for p in p_set:
                safe_cleanup_media_player(p)

        self.logger.info("Application cleanup completed")
        super().closeEvent(event)

    def _cleanup_ui_resources(self):
        """Cleanup callback for UI-specific resources."""
        self.logger.debug("Cleaning up UI-specific resources")

        # Stop any running timers safely
        try:
            if hasattr(self, 'position_update_timer') and self.position_update_timer is not None:
                self.position_update_timer.stop()
        except (RuntimeError, AttributeError) as e:
            # Timer may have been deleted by Qt already
            self.logger.debug(f"Could not stop position_update_timer: {e}")

        try:
            if hasattr(self, 'tooltip_timer') and self.tooltip_timer is not None:
                self.tooltip_timer.stop()
        except (RuntimeError, AttributeError) as e:
            # Timer may have been deleted by Qt already
            self.logger.debug(f"Could not stop tooltip_timer: {e}")

        # Clean up any remaining temporary files
        if hasattr(self, 'files_to_cleanup_after_export'):
            for file_path in self.files_to_cleanup_after_export:
                safe_remove_file(file_path)
            self.files_to_cleanup_after_export.clear()

        # Clean up media players
        if hasattr(self, 'players_a') and hasattr(self, 'players_b'):
            for p_set in [self.players_a, self.players_b]:
                for p in p_set:
                    safe_cleanup_media_player(p)

    def handle_date_selection_change(self):
        if self.date_selector.currentIndex() < 0:
            return # Don't clear if nothing is selected

        selected_date_str = self.date_selector.currentData()
        self.logger.info(f"User selected date: {selected_date_str}")

        if not selected_date_str or not self.app_state.root_clips_path:
            self.logger.warning("Invalid date selection or no root path set")
            self.clear_all_players()
            return

        self.logger.info(f"Loading clips for date: {selected_date_str}")
        self.clear_all_players() # Clean up any previous worker first
        self.set_ui_loading(True)

        self.clip_loader_worker = workers.ClipLoaderWorker(
            self.app_state.root_clips_path, 
            selected_date_str, 
            self.camera_name_to_index
        )
        self.clip_loader_thread = QThread()
        self.clip_loader_worker.moveToThread(self.clip_loader_thread)

        self.clip_loader_thread.started.connect(self.clip_loader_worker.run)
        self.clip_loader_worker.finished.connect(self._on_clips_loaded)
        self.clip_loader_thread.finished.connect(self.clip_loader_thread.deleteLater)
        self.clip_loader_worker.finished.connect(self.clip_loader_worker.deleteLater)

        self.clip_loader_thread.start()

    def _on_clips_loaded(self, data: TimelineData):
        self.set_ui_loading(False)

        if data.error:
            QMessageBox.warning(self, "Could Not Load Date", data.error)
            # No need to call clear_all_players here, as it was done before starting
            return
        
        if data.first_timestamp_of_day is None:
             QMessageBox.warning(self, "No Videos", f"No valid video files found.")
             return

        self.app_state.is_daily_view_active = True
        self.app_state.first_timestamp_of_day = data.first_timestamp_of_day
        self.app_state.daily_clip_collections = data.daily_clip_collections
        
        self.scrubber.setRange(0, data.total_duration_ms)
        self.scrubber.set_events(data.events)

        self._load_and_set_segment(0)
        self.update_layout()

    def _apply_root_folder(self, folder):
        """Set root clips folder and refresh date selector."""
        if not folder:
            return

        # Validate the clips directory
        validation_result = validate_clips_folder(folder)
        if not validation_result.is_valid:
            self.logger.warning(f"Invalid clips folder selected: {validation_result.error_message}")
            QMessageBox.warning(self, "Invalid Folder",
                              f"The selected folder is not a valid Tesla clips directory:\n\n{validation_result.error_message}")
            return

        self.app_state.root_clips_path = str(validation_result.value)
        self.clear_all_players()
        if not self.repopulate_date_selector_from_path(folder):
            QMessageBox.information(self, "No Dates", "No date folders found.")
        else:
            self.date_selector.setCurrentIndex(-1)

    def select_root_folder(self):
        self.logger.info("User selecting root folder")
        folder = QFileDialog.getExistingDirectory(self, "Select Clips Root", self.app_state.root_clips_path or os.path.expanduser("~"))
        if folder:
            self.logger.info(f"User selected folder: {folder}")
        else:
            self.logger.debug("User cancelled folder selection")
        self._apply_root_folder(folder)

    def repopulate_date_selector_from_path(self, folder_path):
        self.date_selector.blockSignals(True); self.date_selector.clear(); self.date_selector.setEnabled(False)
        date_folder_pattern = re.compile(r"^(\d{4}-\d{2}-\d{2})")
        dates = sorted({m.group(1) for item in os.listdir(folder_path) if os.path.isdir(os.path.join(folder_path, item)) and (m := date_folder_pattern.match(item))}, reverse=True)
        for date_str in dates:
            display_text = datetime.strptime(date_str, "%Y-%m-%d").strftime("%m/%d/%Y")
            self.date_selector.addItem(display_text, date_str)
        if dates: self.date_selector.setEnabled(True)
        self.date_selector.blockSignals(False); return bool(dates)

    def generate_and_set_thumbnail(self, video_path, timestamp_seconds):
        if not os.path.exists(FFMPEG_EXE) or not self.go_to_time_dialog_instance:
            return

        with temporary_file(suffix=".jpg") as temp_file_path:
            try:
                cmd = [FFMPEG_EXE, "-y", "-ss", str(timestamp_seconds), "-i", video_path, "-vframes", "1", "-vf", "scale=192:-1", "-q:v", "3", str(temp_file_path)]
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

                pixmap = QPixmap(str(temp_file_path)) if temp_file_path.exists() else QPixmap()
                if self.go_to_time_dialog_instance:
                    self.go_to_time_dialog_instance.set_thumbnail(pixmap)
                self.logger.debug(f"Generated thumbnail for {video_path} at {timestamp_seconds}s")
            except Exception as e:
                self.logger.error(f"Failed to generate thumbnail: {e}")
                if self.go_to_time_dialog_instance:
                    self.go_to_time_dialog_instance.set_thumbnail(QPixmap())
            
    def show_go_to_time_dialog(self):
        if not self.app_state.is_daily_view_active:
            QMessageBox.warning(self, "Action Required", "Please load a date before using 'Go to Time'."); return
        current_date_display = self.date_selector.currentText()
        current_date_data = self.date_selector.currentData()
        self.go_to_time_dialog_instance = widgets.GoToTimeDialog(self, current_date_display, self.app_state.first_timestamp_of_day, self.app_state.daily_clip_collections, self.camera_name_to_index["front"])
        self.go_to_time_dialog_instance.request_thumbnail.connect(self.generate_and_set_thumbnail)
        if self.go_to_time_dialog_instance.exec():
            time_str = self.go_to_time_dialog_instance.get_time_string().strip()
            if not time_str:
                return

            # Validate time input
            time_validation = validate_time_input(time_str)
            if not time_validation.is_valid:
                self.logger.warning(f"Invalid time input: {time_validation.error_message}")
                QMessageBox.warning(self, "Invalid Time", time_validation.error_message)
                return

            try:
                target_dt = datetime.strptime(f"{current_date_data} {time_str}", "%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError):
                QMessageBox.warning(self, "Invalid Time", "Please use HH:MM:SS format.")
                return

            if self.app_state.first_timestamp_of_day:
                global_ms = (target_dt - self.app_state.first_timestamp_of_day).total_seconds()*1000
                if 0 <= global_ms <= self.scrubber.maximum():
                    self.seek_all_global(int(global_ms))
                else:
                    QMessageBox.information(self, "Out of Range", "The specified time is outside the range of the current day's clips.")
        self.go_to_time_dialog_instance = None
    
    def toggle_play_pause_all(self):
        if not self.app_state.is_daily_view_active: return
        if any(p.playbackState() == QMediaPlayer.PlaybackState.PlayingState for p in self.get_active_players()): self.pause_all()
        else: self.play_all()

    def play_all(self):
        # Validate playback rate
        rate_str = self.speed_selector.currentText()
        rate_validation = InputValidator.validate_playback_rate(rate_str, self.playback_rates)
        if not rate_validation.is_valid:
            self.logger.warning(f"Invalid playback rate: {rate_validation.error_message}")
            rate = 1.0  # Fallback to normal speed
        else:
            rate = rate_validation.value

        self.play_btn.setText(PAUSE_BUTTON_TEXT)
        any_playing = False
        for i, p in enumerate(self.get_active_players()):
            if i in self.ordered_visible_player_indices and p.source() and p.source().isValid():
                p.setPlaybackRate(rate); p.play(); any_playing = True
        if any_playing: self.position_update_timer.start()

    def pause_all(self):
        self.play_btn.setText(PLAY_BUTTON_TEXT); [p.pause() for p in self.get_active_players()]; self.position_update_timer.stop(); self.update_slider_and_time_display()
    
    def frame_action(self, offset_ms): 
        if not self.app_state.is_daily_view_active: return
        self.pause_all(); [p.setPosition(p.position() + offset_ms) for p in self.get_active_players() if p.source() and p.source().isValid()]; self.update_slider_and_time_display()

    def _handle_scrubber_press(self):
        if not self.app_state.is_daily_view_active: return
        self.was_playing_before_scrub = self.play_btn.text() == PAUSE_BUTTON_TEXT
        self.pause_all()

    def handle_scrubber_release(self):
        self.seek_all_global(self.scrubber.value())
        if self.was_playing_before_scrub:
            self.play_all()
        self.was_playing_before_scrub = False

    def seek_all_global(self, global_ms, restore_play_state=False):
        if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day: return
        
        was_playing = self.play_btn.text() == PAUSE_BUTTON_TEXT
        if was_playing:
            self.pause_all()

        target_dt = self.app_state.first_timestamp_of_day + timedelta(milliseconds=max(0, global_ms))
        front_clips = self.app_state.daily_clip_collections[self.camera_name_to_index["front"]]
        if not front_clips: 
            if restore_play_state and was_playing: self.play_all()
            return
        
        target_seg_idx = -1
        # Find the last segment whose start time is before or at the target time.
        for i, clip_path in enumerate(front_clips):
            m = utils.filename_pattern.match(os.path.basename(clip_path))
            if m:
                clip_start_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-', ':')}", "%Y-%m-%d %H:%M:%S")
                if clip_start_dt <= target_dt:
                    target_seg_idx = i
                else:
                    # Since clips are sorted, we can stop once we pass the target time.
                    break
        
        if target_seg_idx == -1: 
            if restore_play_state and was_playing: self.play_all()
            return
        
        m = utils.filename_pattern.match(os.path.basename(front_clips[target_seg_idx]))
        if m:
            s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
            pos_in_seg_ms = int((target_dt - s_dt).total_seconds() * 1000)
        else:
            pos_in_seg_ms = 0
        
        if target_seg_idx != self.app_state.playback_state.clip_indices[0]:
            self._load_and_set_segment(target_seg_idx, pos_in_seg_ms)
        else:
            # If we are in the same segment, we can just seek directly.
            for p in self.get_active_players(): p.setPosition(pos_in_seg_ms)
        
        self.update_slider_and_time_display()

        if restore_play_state and was_playing:
            self.play_all()

    def mark_start_time(self):
        if not self.app_state.is_daily_view_active:
            return

        start_ms = self.scrubber.value()

        # Validate start time
        if start_ms < 0:
            QMessageBox.warning(self, "Invalid Start Time", "Start time cannot be negative")
            return

        if start_ms > self.scrubber.maximum():
            QMessageBox.warning(self, "Invalid Start Time", "Start time is beyond the available timeline")
            return

        self.app_state.export_state.start_ms = start_ms

        # Auto-adjust end time if needed
        if self.app_state.export_state.end_ms is not None and self.app_state.export_state.start_ms >= self.app_state.export_state.end_ms:
            self.app_state.export_state.end_ms = self.app_state.export_state.start_ms + 1000

        self.logger.debug(f"Start time marked: {start_ms}ms")
        self.update_export_ui()

    def mark_end_time(self):
        if not self.app_state.is_daily_view_active:
            return

        end_ms = self.scrubber.value()

        # Validate end time
        if end_ms < 0:
            QMessageBox.warning(self, "Invalid End Time", "End time cannot be negative")
            return

        if end_ms > self.scrubber.maximum():
            QMessageBox.warning(self, "Invalid End Time", "End time is beyond the available timeline")
            return

        self.app_state.export_state.end_ms = end_ms

        # Auto-adjust start time if needed
        if self.app_state.export_state.start_ms is not None and self.app_state.export_state.end_ms <= self.app_state.export_state.start_ms:
            self.app_state.export_state.start_ms = self.app_state.export_state.end_ms - 1000

        self.logger.debug(f"End time marked: {end_ms}ms")
        self.update_export_ui()

    def handle_marker_drag(self, marker_type, value):
        if marker_type == 'start': self.app_state.export_state.start_ms = value
        elif marker_type == 'end': self.app_state.export_state.end_ms = value
        self.update_export_ui()
        self.preview_at_global_ms(value)

    def _handle_marker_drag_finished(self):
        # When the user releases an export marker, snap the video back to the main scrubber position
        self.seek_all_global(self.scrubber.value())
        if self.was_playing_before_scrub:
            self.play_all()

    def handle_event_click(self, event_data):
        seek_ms = event_data['ms_in_timeline']
        if 'sentry' in event_data['reason'] or 'user_interaction' in event_data['reason']:
            seek_ms -= 10000 
        self.seek_all_global(max(0, seek_ms))
        self.play_all()

    def handle_event_hover(self, event_data, global_pos):
        self.tooltip_timer.stop()
        try: self.tooltip_timer.timeout.disconnect()
        except TypeError: pass 
        
        if event_data:
            self.tooltip_timer.timeout.connect(lambda evt=event_data, pos=global_pos: self.show_event_tooltip(evt, pos))
            self.tooltip_timer.start(500)
        else: self.event_tooltip.hide()

    def show_event_tooltip(self, event_data, global_pos):
        self.event_tooltip.move(global_pos.x() - self.event_tooltip.width() // 2, global_pos.y() - self.event_tooltip.height() - 20)
        self.event_tooltip.show()
        
        thumb_path = os.path.join(event_data['folder_path'], 'thumb.png')
        pixmap = QPixmap(thumb_path) if os.path.exists(thumb_path) else QPixmap()
        self.event_tooltip.update_content(event_data['reason'], pixmap)

    def update_export_ui(self):
        self.start_time_label.setText(f"Start: {utils.format_time(self.app_state.export_state.start_ms)}")
        self.end_time_label.setText(f"End: {utils.format_time(self.app_state.export_state.end_ms)}")
        self.scrubber.set_export_range(self.app_state.export_state.start_ms, self.app_state.export_state.end_ms)

    def show_export_dialog(self):
        if not all([utils.FFMPEG_FOUND, self.app_state.is_daily_view_active, self.app_state.export_state.start_ms is not None, self.app_state.export_state.end_ms is not None]):
            QMessageBox.warning(self, "Export Error", "Please load clips and set both a start and end time before exporting."); return
        dialog = QDialog(self); dialog.setWindowTitle("Export Options"); layout = QVBoxLayout(dialog)
        layout.addWidget(QLabel("Select export quality:")); full_res_rb = QRadioButton("Full Resolution"); mobile_rb = QRadioButton("Mobile Friendly - 1080p")
        full_res_rb.setChecked(True); layout.addWidget(full_res_rb); layout.addWidget(mobile_rb)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel); buttons.accepted.connect(dialog.accept); buttons.rejected.connect(dialog.reject); layout.addWidget(buttons)
        if dialog.exec():
            # Generate a safe default filename
            date_str = self.date_selector.currentData() or "unknown_date"
            safe_filename = sanitize_filename(f"{date_str}_clip.mp4")

            output_path, _ = QFileDialog.getSaveFileName(self, "Save Exported Clip", safe_filename, EXPORT_FILE_FILTER)
            if output_path:
                # Validate export settings before starting
                validation_result = validate_export_settings(
                    self.app_state.export_state.start_ms,
                    self.app_state.export_state.end_ms,
                    output_path
                )

                if not validation_result.is_valid:
                    self.logger.warning(f"Export validation failed: {validation_result.error_message}")
                    QMessageBox.warning(self, "Export Error", validation_result.error_message)
                    return

                self.start_export(output_path, mobile_rb.isChecked())

    def start_export(self, output_path, is_mobile):
        self.logger.info(f"Starting export to: {output_path}, mobile: {is_mobile}")
        self.pause_all()
        result = self._build_ffmpeg_command(output_path, is_mobile)
        if not result or not result[0]:
            self.logger.error("Failed to generate FFmpeg command for export")
            QMessageBox.critical(self, "Export Failed", "Could not generate FFmpeg command. No visible cameras or clips found for the selected range."); return
        
        ffmpeg_cmd, self.files_to_cleanup_after_export, duration_s = result
        
        self.progress_dialog = QProgressDialog("Preparing export...", "Cancel", 0, 100, self)
        self.progress_dialog.setWindowModality(Qt.WindowModality.WindowModal)
        self.progress_dialog.setWindowTitle("Exporting")
        self.progress_dialog.show()
        
        self.export_worker = workers.ExportWorker(ffmpeg_cmd, duration_s)
        self.export_thread = QThread()
        self.export_worker.moveToThread(self.export_thread)
        
        self.export_thread.started.connect(self.export_worker.run)
        self.export_worker.finished.connect(self.on_export_finished)
        self.export_worker.progress.connect(self.progress_dialog.setLabelText)
        self.export_worker.progress_value.connect(self.progress_dialog.setValue)
        self.progress_dialog.canceled.connect(self.export_worker.stop)
        
        self.export_thread.start()

    def on_export_finished(self, success, message):
        if success:
            self.logger.info(f"Export completed successfully: {message}")
            self.progress_dialog.setValue(100)
        else:
            self.logger.error(f"Export failed: {message}")
        self.progress_dialog.close()
        
        if self.export_thread:
            self.export_thread.quit()
            self.export_thread.wait()

        if success:
            QMessageBox.information(self, "Export Complete", message)
        else:
            QMessageBox.critical(self, "Export Failed", message)

        # Clean up temporary files using safe removal
        for path in self.files_to_cleanup_after_export:
            if not safe_remove_file(path):
                self.logger.warning(f"Failed to remove temporary export file: {path}")
        self.files_to_cleanup_after_export.clear()
        self.export_thread, self.export_worker = None, None

    def _build_ffmpeg_command(self, output_path, is_mobile):
        builder = FFmpegCommandBuilder(
            app_state=self.app_state,
            ordered_visible_indices=self.ordered_visible_player_indices,
            camera_map=self.camera_name_to_index,
            is_mobile=is_mobile,
            output_path=output_path
        )
        return builder.build()
    
    def set_playback_speed(self, speed_text):
        rate = self.playback_rates.get(speed_text,1.0)
        for p_set in [self.players_a, self.players_b]:
            for p in p_set: p.setPlaybackRate(rate)

    def update_slider_and_time_display(self):
        try:
            if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day: return
            
            ref_player = self.get_active_players()[self.camera_name_to_index["front"]]
            if not (ref_player.source() and ref_player.source().isValid()):
                ref_player = next((p for p in self.get_active_players() if p.source() and p.source().isValid()), None)

            if not ref_player:
                if self.play_btn.text() != PLAY_BUTTON_TEXT:
                     if self.scrubber.value() < self.scrubber.maximum(): self.scrubber.setValue(self.scrubber.maximum())
                     self.pause_all()
                return

            current_pos = ref_player.position()
            global_position = min(self.app_state.playback_state.segment_start_ms + current_pos, self.scrubber.maximum())
            
            if not self.scrubber.isSliderDown(): 
                self.scrubber.blockSignals(True); self.scrubber.setValue(global_position); self.scrubber.blockSignals(False)
            
            current_time = time.time()
            if current_time - self.last_text_update_time > 1 or self.play_btn.text() == PLAY_BUTTON_TEXT:
                clip_duration = ref_player.duration()
                global_time = self.app_state.first_timestamp_of_day + timedelta(milliseconds=global_position)
                self.time_label.setText(f"{global_time.strftime('%m/%d/%Y %I:%M:%S %p')} (Clip: {utils.format_time(current_pos)} / {utils.format_time(clip_duration if clip_duration > 0 else 0)})")
                self.last_text_update_time = current_time
        
        except Exception as e:
            if utils.DEBUG_UI: print(f"Error in update_slider_and_time_display: {e}"); traceback.print_exc()
    
    def clear_all_players(self):
        self.logger.debug("Clearing all players and stopping background operations")

        if self.clip_loader_thread and self.clip_loader_thread.isRunning() and self.clip_loader_worker:
            self.clip_loader_worker.stop()
            self.clip_loader_thread.quit()
            self.clip_loader_thread.wait() # Wait for thread to fully terminate

        self.clip_loader_thread = None
        self.clip_loader_worker = None

        if QApplication.overrideCursor() is not None:
            QApplication.restoreOverrideCursor()

        self.pending_seek_position = -1
        self.players_awaiting_seek.clear()
        self.position_update_timer.stop()

        # Use safe cleanup for media players
        for p_set in [self.players_a, self.players_b]:
            for p in p_set:
                safe_cleanup_media_player(p)
        
        root_path = self.app_state.root_clips_path
        self.app_state = AppState()
        self.app_state.root_clips_path = root_path
        
        self.time_label.setText("MM/DD/YYYY HH:MM:SS (Clip: 00:00 / 00:00)")
        self.scrubber.setValue(0); self.scrubber.setMaximum(1000)
        self.play_btn.setText(PLAY_BUTTON_TEXT); self.speed_selector.setCurrentText(DEFAULT_PLAYBACK_RATE)
        self.scrubber.set_events([]); self.update_export_ui()

    def preview_at_global_ms(self, global_ms):
        """Seeks players to a time for previewing without affecting the main timeline."""
        if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day:
            return
        
        self.pause_all()
        target_dt = self.app_state.first_timestamp_of_day + timedelta(milliseconds=max(0, global_ms))
        front_clips = self.app_state.daily_clip_collections[self.camera_name_to_index["front"]]
        if not front_clips: return
        
        target_seg_idx = -1
        for i, clip_path in enumerate(front_clips):
            m = utils.filename_pattern.match(os.path.basename(clip_path))
            if m:
                clip_start_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-', ':')}", "%Y-%m-%d %H:%M:%S")
                if clip_start_dt <= target_dt:
                    target_seg_idx = i
                else:
                    break
        
        if target_seg_idx == -1: return
        
        m = utils.filename_pattern.match(os.path.basename(front_clips[target_seg_idx]))
        if m:
            s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
            pos_in_seg_ms = int((target_dt - s_dt).total_seconds() * 1000)
        else:
            pos_in_seg_ms = 0
        
        if target_seg_idx != self.app_state.playback_state.clip_indices[0]:
            self._load_and_set_segment(target_seg_idx, pos_in_seg_ms)
        else:
            for p in self.get_active_players(): p.setPosition(pos_in_seg_ms)

    def _load_and_set_segment(self, segment_index, position_ms=0):
        # Cancel any previous pending seek operation.
        self.pending_seek_position = -1
        self.players_awaiting_seek.clear()

        # When seeking, we forcefully switch to player set 'a' as the active one.
        # This simplifies the logic by providing a consistent state.
        self.active_player_set = 'a'
        active_players = self.get_active_players()
        active_video_items = self.get_active_video_items()

        # Stop the other player set to prevent it from continuing playback in the background.
        [p.stop() for p in self.get_inactive_players()]
        
        front_clips = self.app_state.daily_clip_collections[self.camera_name_to_index["front"]]
        if not (0 <= segment_index < len(front_clips)):
            if utils.DEBUG_UI: print(f"Segment index {segment_index} out of range. Aborting load.")
            return

        m = utils.filename_pattern.match(os.path.basename(front_clips[segment_index]))
        if m and self.app_state.first_timestamp_of_day:
            s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
            segment_start_ms = int((s_dt - self.app_state.first_timestamp_of_day).total_seconds() * 1000)
        else:
            segment_start_ms = 0
        self.app_state.playback_state = PlaybackState(clip_indices=[segment_index]*6, segment_start_ms=segment_start_ms)

        # Update the UI to show the new video items immediately.
        for i in range(6):
            self.video_player_item_widgets[i].set_video_item(active_video_items[i])
            
        # Only load visible cameras
        players_to_load = set()
        for i in self.ordered_visible_player_indices:
            clips = self.app_state.daily_clip_collections[i]
            if 0 <= segment_index < len(clips):
                players_to_load.add(active_players[i])
                self._load_next_clip_for_player_set(active_players, i)
            else:
                active_players[i].setSource(QUrl())
        # Unload hidden cameras
        for i in set(range(6)) - set(self.ordered_visible_player_indices):
            active_players[i].setSource(QUrl())
        
        if not players_to_load:
            return

        if utils.DEBUG_UI: print(f"--- Loading segment {segment_index}, preparing pending seek to {position_ms}ms ---")
        
        # Set up the pending seek operation. It will be executed in handle_media_status_changed.
        self.pending_seek_position = position_ms
        self.players_awaiting_seek = players_to_load

        self._preload_next_segment()

    def _preload_next_segment(self):
        if not self.app_state.is_daily_view_active: return
        next_segment_index = self.app_state.playback_state.clip_indices[0] + 1
        front_cam_idx = self.camera_name_to_index["front"]
        if next_segment_index >= len(self.app_state.daily_clip_collections[front_cam_idx]): return
        
        inactive_players = self.get_inactive_players()
        if inactive_players[front_cam_idx].source().isValid():
            path = inactive_players[front_cam_idx].source().path()
            if os.path.basename(path) == os.path.basename(self.app_state.daily_clip_collections[front_cam_idx][next_segment_index]):
                return
        
        if utils.DEBUG_UI: print(f"--- Preloading segment {next_segment_index} ---")
        # Only preload visible cameras
        for i in self.ordered_visible_player_indices:
            self._load_next_clip_for_player_set(inactive_players, i, next_segment_index)
        # Unload hidden cameras
        for i in set(range(6)) - set(self.ordered_visible_player_indices):
            inactive_players[i].setSource(QUrl())

    def _load_next_clip_for_player_set(self, player_set, player_index, force_index=None):
        idx_to_load = force_index if force_index is not None else self.app_state.playback_state.clip_indices[player_index]
        clips = self.app_state.daily_clip_collections[player_index]
        if 0 <= idx_to_load < len(clips):
            player_set[player_index].setSource(QUrl.fromLocalFile(clips[idx_to_load]))
        else: player_set[player_index].setSource(QUrl())
            
    def handle_media_status_changed(self, status, player_instance, player_index):
        front_idx = self.camera_name_to_index["front"]

        if status == QMediaPlayer.MediaStatus.EndOfMedia and player_instance.source() and player_instance.source().isValid():
            if player_index == front_idx and player_instance in self.get_active_players():
                self._swap_player_sets()
        
        elif status == QMediaPlayer.MediaStatus.LoadedMedia: 
            self.video_player_item_widgets[player_index].fit_video_to_view()
            
            # If a seek operation is pending, execute it now that the media is loaded.
            if self.pending_seek_position != -1 and player_instance in self.players_awaiting_seek:
                player_instance.setPosition(self.pending_seek_position)
                self.players_awaiting_seek.remove(player_instance)
                
                # If this was the last player we were waiting for, reset the state.
                if not self.players_awaiting_seek:
                    if utils.DEBUG_UI: print(f"--- Pending seek to {self.pending_seek_position}ms completed. ---")
                    self.pending_seek_position = -1
        
        elif status == QMediaPlayer.MediaStatus.InvalidMedia:
            # If a player fails to load, remove it from the await set to avoid getting stuck.
            if player_instance in self.players_awaiting_seek:
                self.players_awaiting_seek.remove(player_instance)
                if not self.players_awaiting_seek and self.pending_seek_position != -1:
                    if utils.DEBUG_UI: print(f"--- Pending seek to {self.pending_seek_position}ms completed (with invalid media). ---")
                    self.pending_seek_position = -1

    def _swap_player_sets(self):
        # Cancel any pending seeks before swapping, as they are no longer relevant.
        self.pending_seek_position = -1
        self.players_awaiting_seek.clear()
        
        if utils.DEBUG_UI: print(f"--- Swapping player sets. New active set: {'b' if self.active_player_set == 'a' else 'a'} ---")
        was_playing = self.play_btn.text() == PAUSE_BUTTON_TEXT
        [p.stop() for p in self.get_active_players()]
        
        self.active_player_set = 'b' if self.active_player_set == 'a' else 'a'
        active_players = self.get_active_players()
        active_video_items = self.get_active_video_items()
        
        next_segment_index = self.app_state.playback_state.clip_indices[0] + 1
        front_cam_idx = self.camera_name_to_index["front"]
        
        if next_segment_index >= len(self.app_state.daily_clip_collections[front_cam_idx]):
            self.pause_all(); return
        
        front_clips = self.app_state.daily_clip_collections[front_cam_idx]
        m = utils.filename_pattern.match(os.path.basename(front_clips[next_segment_index]))
        if m and self.app_state.first_timestamp_of_day:
            s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
            segment_start_ms = int((s_dt - self.app_state.first_timestamp_of_day).total_seconds() * 1000)
        else:
            segment_start_ms = 0
        self.app_state.playback_state = PlaybackState(clip_indices=[next_segment_index] * 6, segment_start_ms=segment_start_ms)

        for i in range(6):
            self.video_player_item_widgets[i].set_video_item(active_video_items[i])
            active_players[i].setPosition(0)
        
        if active_players[front_cam_idx].mediaStatus() == QMediaPlayer.MediaStatus.InvalidMedia:
            if utils.DEBUG_UI: print(f"--- Segment {next_segment_index} is invalid, skipping. ---")
            QTimer.singleShot(0, self._swap_player_sets)
            return

        if was_playing: self.play_all()
        self._preload_next_segment()

    def update_layout(self):
        while self.video_grid.count():
            item = self.video_grid.takeAt(0)
            widget = item.widget() if item else None
            if widget is not None:
                widget.setParent(None)
                widget.hide()
        
        num_visible = len(self.ordered_visible_player_indices)
        if num_visible == 0: self.video_grid.update(); return 

        cols = 1 if num_visible == 1 else 2 if num_visible in [2, 4] else 3
        
        current_col, current_row = 0, 0
        for p_idx in self.ordered_visible_player_indices:
            widget = self.video_player_item_widgets[p_idx]; widget.setVisible(True); widget.reset_view() 
            self.video_grid.addWidget(widget, current_row, current_col)
            
            active_video_item = self.get_active_video_items()[p_idx]
            widget.set_video_item(active_video_item)

            current_col += 1
            if current_col >= cols: current_col = 0; current_row += 1

        for hidden_idx in (set(range(6)) - set(self.ordered_visible_player_indices)):
            self.video_player_item_widgets[hidden_idx].setVisible(False)
        
        self.video_grid_widget.update()

    def check_for_updates(self):
        from viewer import updater
        from PyQt6.QtWidgets import QMessageBox
        self.set_ui_loading(True)
        try:
            url, latest_version = updater.check_for_update()
            if url:
                reply = QMessageBox.question(
                    self, "Update Available",
                    f"A new version ({latest_version}) is available. Download and install now?",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
                )
                if reply == QMessageBox.StandardButton.Yes:
                    updater.download_and_run_installer(url)
            else:
                QMessageBox.information(self, "No Update", "You are running the latest version.")
        except Exception as e:
            QMessageBox.warning(self, "Update Error", f"Could not check for updates:\n{e}")
        finally:
            self.set_ui_loading(False)