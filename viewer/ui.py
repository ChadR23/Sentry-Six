import os
import json
import time
import traceback
import tempfile
import math
import re
import subprocess
from datetime import datetime, timedelta
from typing import Tuple, List, Any

from PyQt6.QtWidgets import (QWidget, QVBoxLayout, QLabel, QPushButton, QFileDialog,
                             QGridLayout, QHBoxLayout, QMessageBox, QComboBox, 
                             QRadioButton, QApplication, QCheckBox, QProgressDialog, 
                             QDialog, QDialogButtonBox)
from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
from PyQt6.QtMultimediaWidgets import QGraphicsVideoItem
from PyQt6.QtCore import Qt, QUrl, QTimer, QSettings, QThread, pyqtSignal, QObject
from PyQt6.QtGui import QPixmap, QAction, QKeySequence

from . import utils
from . import widgets
from . import workers
from . import ffmpeg_manager
from .state import AppState, PlaybackState, ExportState, TimelineData
from .ffmpeg_builder import FFmpegCommandBuilder
from .ffmpeg_manager import FFMPEG_EXE
from .hwacc_detector import hwacc_detector
from .managers import (DependencyContainer, ErrorHandler, VideoPlaybackManager,
                      ExportManager, LayoutManager, ClipManager, ConfigurationManager,
                      LoggingManager, CacheManager, PluginManager, ErrorContext, ErrorSeverity)


class WelcomeDialog(QDialog):
    """Simple first-time welcome dialog prompting for TeslaCam folder."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Welcome to Sentry-Six")
        self.setModal(True)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("It looks like this is your first time running Sentry-Six.\nPlease choose your TeslaCam clips folder to get started.\n\nSupported folders: SavedClips, SentryClips, or RecentClips"))
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
        folder = QFileDialog.getExistingDirectory(self, "Select Tesla Clips Folder (SavedClips, SentryClips, or RecentClips)")
        if folder:
            self.selected_folder = folder

class FFmpegCheckWorker(QObject):
    finished = pyqtSignal()
    def __init__(self, parent_widget):
        super().__init__()
        self.parent_widget = parent_widget
    def run(self):
        from . import ffmpeg_manager
        ffmpeg_manager.ensure_ffmpeg_up_to_date(parent=self.parent_widget)
        self.finished.emit()

class TeslaCamViewer(QWidget):
    def __init__(self, show_welcome: bool = True):
        super().__init__()
        self.settings = QSettings()
        self.app_state = AppState()
        self.camera_name_to_index = {"front":0, "left_repeater":1, "right_repeater":2, "back":3, "left_pillar":4, "right_pillar":5}
        self.camera_index_to_name = {v: k for k, v in self.camera_name_to_index.items()}

        # Manager infrastructure will be initialized after UI is fully created

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

        self.setWindowTitle("Sentry Six")
        self.setMinimumSize(1280, 720)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._layout = QVBoxLayout(self)
        self._layout.setSpacing(8)
        self._layout.setContentsMargins(8, 8, 8, 8)

        self._create_top_controls()
        self._create_video_grid()
        self._create_players_and_items()
        self._create_playback_controls()
        self._create_scrubber()
        self._create_actions_and_shortcuts()

        self.setLayout(self._layout)
        
        # Enhanced timer system to prevent synchronization conflicts
        self.position_update_timer = QTimer(self)
        self.position_update_timer.setInterval(100)  # Reduced from 300ms to 100ms for smoother updates
        self.position_update_timer.timeout.connect(self._optimized_position_update)

        # Separate timer for timestamp display updates (less frequent to reduce UI load)
        self.timestamp_display_timer = QTimer(self)
        self.timestamp_display_timer.setInterval(250)  # Update timestamp display every 250ms
        self.timestamp_display_timer.timeout.connect(self._update_timestamp_display)

        # Performance tracking
        self.last_position_update_time = 0
        self.last_timestamp_update_time = 0
        self.pending_position_update = False

        # Asynchronous timestamp calculation
        self.timestamp_worker_thread = None
        self.timestamp_worker = None
        self.pending_timestamp_data = None
        self._setup_timestamp_worker()

        # Real-time performance monitoring
        self.performance_monitor_timer = QTimer(self)
        self.performance_monitor_timer.setInterval(5000)  # Report every 5 seconds
        self.performance_monitor_timer.timeout.connect(self._report_performance_metrics)
        if utils.DEBUG_UI_PERFORMANCE:
            self.performance_monitor_timer.start()

        # Emergency timer recovery system
        self.watchdog_timer = QTimer(self)
        self.watchdog_timer.setInterval(1000)  # Check every second
        self.watchdog_timer.timeout.connect(self._watchdog_check)
        self.last_timer_heartbeat = time.time()
        self.ui_freeze_detected = False
        self.freeze_recovery_attempts = 0
        self.max_freeze_recovery_attempts = 3
        self.watchdog_timer.start()
        
        self.load_settings()

        # Initialize manager infrastructure after UI is fully created
        try:
            self._initialize_managers()
        except Exception as e:
            print(f"Warning: Manager initialization failed: {e}")
            # Continue with fallback behavior

        # First-time onboarding dialog
        if show_welcome:
            self._maybe_show_welcome_dialog()
        self.update_layout()
        # FFmpeg update check (Windows only) - show progress dialog and run in thread
        QTimer.singleShot(0, self._start_ffmpeg_check_with_progress)

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

    def _on_ffmpeg_check_done(self):
        if hasattr(self, 'ffmpeg_progress_dialog') and self.ffmpeg_progress_dialog:
            self.ffmpeg_progress_dialog.close()
            self.ffmpeg_progress_dialog = None

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

    def _detect_hardware_acceleration(self):
        """Detect and configure hardware acceleration for video decoding"""
        try:
            # Detect GPU and hardware acceleration capabilities
            gpu_type, hwacc_available = hwacc_detector.detect_and_configure()
            
            self.hwacc_gpu_type = gpu_type
            self.hwacc_available = hwacc_available
            
            # Print debug information
            hwacc_detector.print_debug_info()
            
            if utils.DEBUG_UI:
                print(f"[UI] Hardware acceleration detection complete:")
                print(f"[UI] GPU Type: {gpu_type}")
                print(f"[UI] HWACC Available: {hwacc_available}")
                
        except Exception as e:
            if utils.DEBUG_UI:
                print(f"[UI] Hardware acceleration detection error: {e}")
            self.hwacc_gpu_type = None
            self.hwacc_available = False

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
            
            # Configure hardware acceleration if available
            if self.hwacc_available and self.hwacc_gpu_type:
                hwacc_detector.configure_media_player_hwacc(player_a, self.hwacc_gpu_type)
                hwacc_detector.configure_media_player_hwacc(player_b, self.hwacc_gpu_type)
                if utils.DEBUG_UI:
                    print(f"[UI] Configured hardware acceleration for player {i}")
            
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
        self.frame_back_btn = QPushButton("⏪ FR"); self.frame_back_btn.clicked.connect(lambda: self.frame_action_precise(-1))
        self.play_btn = QPushButton("▶️ Play"); self.play_btn.clicked.connect(self.toggle_play_pause_all)
        self.frame_forward_btn = QPushButton("FR ⏩"); self.frame_forward_btn.clicked.connect(lambda: self.frame_action_precise(1))
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
        # Enhanced speed options with more granular control
        self.playback_rates = {
            "0.1x": 0.1, "0.25x": 0.25, "0.5x": 0.5, "0.75x": 0.75,
            "1x": 1.0, "1.25x": 1.25, "1.5x": 1.5, "2x": 2.0,
            "3x": 3.0, "4x": 4.0, "8x": 8.0
        }
        self.speed_selector.addItems(self.playback_rates.keys())
        self.speed_selector.setCurrentText("1x")  # Set default
        self.speed_selector.currentTextChanged.connect(self.set_playback_speed_smooth)
        control_layout.addWidget(QLabel("Speed:"))
        control_layout.addWidget(self.speed_selector)
        
        control_layout.addStretch()
        self._layout.addLayout(control_layout)
        
    def _create_scrubber(self):
        self.slider_layout = QHBoxLayout()
        self.time_label = QLabel("MM/DD/YYYY HH:MM:SS AM/PM (Clip: 00:00 / 00:00)")
        self.scrubber = widgets.ExportScrubber(Qt.Orientation.Horizontal)
        self.scrubber.setRange(0, 1000)
        self.scrubber.sliderMoved.connect(self.seek_all_global)
        self.scrubber.sliderPressed.connect(self._handle_scrubber_press)
        self.scrubber.sliderReleased.connect(self.handle_scrubber_release)
        self.scrubber.export_marker_moved.connect(self.handle_marker_drag)
        self.scrubber.event_marker_clicked.connect(self.handle_event_click)
        self.scrubber.event_marker_hovered.connect(self.handle_event_hover)
        self.scrubber.bookmark_added.connect(self.handle_bookmark_added)
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

        # Frame Back Action (Precise)
        frame_back_action = QAction("Frame Back", self)
        frame_back_action.setShortcut(QKeySequence(Qt.Key.Key_Left))
        frame_back_action.triggered.connect(lambda: self.frame_action_precise(-1))
        self.addAction(frame_back_action)

        # Frame Forward Action (Precise)
        frame_forward_action = QAction("Frame Forward", self)
        frame_forward_action.setShortcut(QKeySequence(Qt.Key.Key_Right))
        frame_forward_action.triggered.connect(lambda: self.frame_action_precise(1))
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

        # Add Bookmark Action
        add_bookmark_action = QAction("Add Bookmark", self)
        add_bookmark_action.setShortcut(QKeySequence(Qt.Key.Key_B))
        add_bookmark_action.triggered.connect(self.add_manual_bookmark)
        self.addAction(add_bookmark_action)

    # ========================================
    # Backward Compatibility Wrappers (Week 2 & Week 4 Implementation)
    # ========================================
    # These methods delegate to managers while maintaining the original API

    # VideoPlaybackManager wrappers (Week 2)

    def get_active_players(self):
        """Get active players (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            return self.video_manager.get_active_players()
        # Fallback to original implementation
        return self.players_a if self.active_player_set == 'a' else self.players_b

    def get_inactive_players(self):
        """Get inactive players (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            return self.video_manager.get_inactive_players()
        # Fallback to original implementation
        return self.players_b if self.active_player_set == 'a' else self.players_a

    def get_active_video_items(self):
        """Get active video items (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            return self.video_manager.get_active_video_items()
        # Fallback to original implementation
        return self.video_items_a if self.active_player_set == 'a' else self.video_items_b
    
    def get_hardware_acceleration_status(self) -> dict:
        """Get current hardware acceleration status for debugging"""
        return {
            "gpu_type": self.hwacc_gpu_type,
            "hwacc_available": self.hwacc_available,
            "debug_info": hwacc_detector.get_debug_info()
        }
        
    def reset_to_default_layout(self):
        """Reset layout to default configuration (delegated to LayoutManager)."""
        if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
            self.layout_manager.reset_to_default_layout()
            self.layout_manager.update_ui_layout()

            # Reload video sources for all visible cameras
            current_segment_index = self.app_state.playback_state.clip_indices[0]
            active_players = self.get_active_players()
            reference_player = None
            for idx in self.layout_manager.get_visible_cameras():
                if active_players[idx].mediaStatus() == QMediaPlayer.MediaStatus.LoadedMedia:
                    reference_player = active_players[idx]
                    break
            current_time = reference_player.position() if reference_player else 0
            is_playing = self.play_btn.text() == "⏸️ Pause"
            visible_cameras = self.layout_manager.get_visible_cameras()
            for i in visible_cameras:
                self._load_next_clip_for_player_set(active_players, i, current_segment_index)
                active_players[i].setPosition(current_time)
                if is_playing:
                    active_players[i].play()
            for i in set(range(6)) - set(visible_cameras):
                active_players[i].setSource(QUrl())
            self.save_settings()
        else:
            # Fallback to original implementation
            self.settings.remove("cameraOrder")
            for checkbox in self.camera_visibility_checkboxes:
                checkbox.blockSignals(True)
                checkbox.setChecked(True)
                checkbox.blockSignals(False)
            self.ordered_visible_player_indices = [idx for _, _, idx in self.checkbox_info]
            self.update_layout()

    def update_layout_from_visibility_change(self):
        """Update layout from visibility change (delegated to LayoutManager)."""
        if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
            self.layout_manager._update_visibility_from_checkboxes()
            self.layout_manager.update_ui_layout()

            # Get newly visible and hidden cameras for synchronization
            newly_visible = self.layout_manager.get_newly_visible_cameras()
            newly_hidden = self.layout_manager.get_newly_hidden_cameras()

            # Handle newly hidden cameras - stop their playback
            active_players = self.get_active_players()
            for camera_index in newly_hidden:
                active_players[camera_index].setSource(QUrl())

            # Handle newly visible cameras - synchronize them properly
            #
            # Camera Synchronization Workflow:
            # 1. LayoutManager detects visibility changes and emits camera_visibility_changed signal
            # 2. This handler receives the signal with lists of newly visible/hidden cameras
            # 3. For each newly visible camera, we attempt synchronization:
            #    a) Primary: Use VideoPlaybackManager.synchronize_camera_to_current_position()
            #    b) Fallback: Use UI-based _synchronize_newly_visible_camera()
            # 4. Synchronization loads correct video segment and seeks to current position
            # 5. Playback state is preserved (resume if others were playing)
            #
            for camera_index in newly_visible:
                # Use VideoPlaybackManager if available, otherwise fallback to UI method
                if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
                    self.video_manager.synchronize_camera_to_current_position(camera_index)
                else:
                    self._synchronize_newly_visible_camera(camera_index)

            # Save settings after visibility changes
            self.save_settings()

            # Update state tracking
            self.layout_manager.update_last_visible_state()
        else:
            # Fallback to original implementation
            new_visible = [
                self.checkbox_info[i][2]
                for i, cb in enumerate(self.camera_visibility_checkboxes)
                if cb.isChecked()
            ]
            self.ordered_visible_player_indices = new_visible
            self.update_layout()
    
    def handle_widget_swap(self, dragged_index, dropped_on_index):
        """Handle widget swap (delegated to LayoutManager)."""
        if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
            if utils.DEBUG_UI:
                print(f"[UI] handle_widget_swap received: Dragged={dragged_index}, Dropped On={dropped_on_index}")
                print(f"[UI] List before swap: {self.layout_manager.get_visible_cameras()}")

            success = self.layout_manager.handle_camera_drop(dragged_index, dropped_on_index)

            if utils.DEBUG_UI:
                print(f"[UI] List after swap: {self.layout_manager.get_visible_cameras()}")
                print(f"[UI] Swap successful: {success}")
        else:
            # Fallback to original implementation
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
            self.time_label.setText("MM/DD/YYYY HH:MM:SS AM/PM (Clip: 00:00 / 00:00)")
            QApplication.restoreOverrideCursor()

    def load_settings(self):
        """Load settings (layout delegated to LayoutManager)."""
        geom = self.settings.value("windowGeometry"); self.restoreGeometry(geom) if geom else self.setGeometry(50, 50, 1600, 950)
        self.speed_selector.setCurrentText(self.settings.value("lastSpeedText", "1x", type=str))

        # Load layout settings through LayoutManager
        if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
            self.layout_manager.apply_layout_from_settings()
            # Update ordered_visible_player_indices for backward compatibility
            self.ordered_visible_player_indices = self.layout_manager.get_visible_cameras()
        else:
            # Fallback to original implementation
            # Load visibility first
            vis_states = self.settings.value("cameraVisibility")
            if vis_states and len(vis_states) == len(self.camera_visibility_checkboxes):
                for i, cb in enumerate(self.camera_visibility_checkboxes):
                    cb.setChecked(vis_states[i] == 'true')

            # Build the initial ordered list from the checkboxes
            visible_from_checkboxes = [self.checkbox_info[i][2] for i, cb in enumerate(self.camera_visibility_checkboxes) if cb.isChecked()]

            # Load custom order and validate it
            saved_order_str = self.settings.value("cameraOrder", type=list)
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

        last_folder = self.settings.value("lastRootFolder", "", type=str)
        if last_folder and os.path.isdir(last_folder):
            self.app_state.root_clips_path = last_folder
            self.repopulate_date_selector_from_path(last_folder)
            self.date_selector.setCurrentIndex(-1)

        if not self.app_state.is_daily_view_active:
            self.clear_all_players()

    def save_settings(self):
        """Save settings (layout delegated to LayoutManager)."""
        self.settings.setValue("windowGeometry", self.saveGeometry())
        self.settings.setValue("lastRootFolder", self.app_state.root_clips_path or "")
        self.settings.setValue("lastSpeedText", self.speed_selector.currentText())

        # Save layout settings through LayoutManager
        if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
            self.layout_manager.save_layout_to_settings()
        else:
            # Fallback to original implementation
            self.settings.setValue("cameraVisibility", [str(cb.isChecked()).lower() for cb in self.camera_visibility_checkboxes])
            # Save the custom order of visible indices
            self.settings.setValue("cameraOrder", [str(i) for i in self.ordered_visible_player_indices])

    def closeEvent(self, event): 
        self.save_settings()
        self.clear_all_players() # Safely stop any running workers
        if self.export_thread and self.export_thread.isRunning() and self.export_worker:
            self.export_worker.stop(); self.export_thread.quit(); self.export_thread.wait()
        
        for p_set in [self.players_a, self.players_b]:
            for p in p_set: p.setSource(QUrl())
        super().closeEvent(event)

    def handle_date_selection_change(self):
        """Handle date selection change (delegated to ClipManager)."""
        if self.date_selector.currentIndex() < 0:
            return # Don't clear if nothing is selected

        selected_date_str = self.date_selector.currentData()
        if not selected_date_str or not self.app_state.root_clips_path:
            self.clear_all_players()
            return

        self.clear_all_players() # Clean up any previous worker first

        # Use ClipManager if available, otherwise fallback to original implementation
        if hasattr(self, 'clip_manager') and self.clip_manager.is_initialized():
            self.clip_manager.load_clips_for_date(selected_date_str)
        else:
            # Fallback to original implementation
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

        # Ensure LayoutManager updates UI after clips are loaded
        if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
            # Re-acquire UI components in case they weren't available during initialization
            self.layout_manager._acquire_ui_components()
            self.layout_manager.update_ui_layout()

    def _apply_root_folder(self, folder):
        """Set root clips folder and refresh date selector (delegated to ClipManager)."""
        if folder and os.path.isdir(folder):
            self.clear_all_players()

            # Use ClipManager if available, otherwise fallback to original implementation
            if hasattr(self, 'clip_manager') and self.clip_manager.is_initialized():
                if self.clip_manager.set_root_clips_path(folder):
                    # ClipManager will emit folder_scan_completed signal which updates date selector
                    self.date_selector.setCurrentIndex(-1)
                else:
                    QMessageBox.information(self, "No Dates", "No date folders found.")
            else:
                # Fallback to original implementation
                self.app_state.root_clips_path = folder
                if not self.repopulate_date_selector_from_path(folder):
                    QMessageBox.information(self, "No Dates", "No date folders found.")
                else:
                    self.date_selector.setCurrentIndex(-1)

    def select_root_folder(self):
        folder = QFileDialog.getExistingDirectory(
            self,
            "Select Tesla Clips Folder (SavedClips, SentryClips, or RecentClips)",
            self.app_state.root_clips_path or os.path.expanduser("~")
        )
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
        if not os.path.exists(FFMPEG_EXE) or not self.go_to_time_dialog_instance: return
        
        temp_fd, temp_file_path = tempfile.mkstemp(suffix=".jpg"); os.close(temp_fd)
        try:
            cmd = [FFMPEG_EXE, "-y", "-ss", str(timestamp_seconds), "-i", video_path, "-vframes", "1", "-vf", "scale=192:-1", "-q:v", "3", temp_file_path]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            
            pixmap = QPixmap(temp_file_path) if os.path.exists(temp_file_path) else QPixmap()
            if self.go_to_time_dialog_instance: self.go_to_time_dialog_instance.set_thumbnail(pixmap)
            
        except Exception:
            if self.go_to_time_dialog_instance: self.go_to_time_dialog_instance.set_thumbnail(QPixmap())
        finally:
            if os.path.exists(temp_file_path):
                try: os.remove(temp_file_path)
                except OSError: pass
            
    def show_go_to_time_dialog(self):
        if not self.app_state.is_daily_view_active:
            QMessageBox.warning(self, "Action Required", "Please load a date before using 'Go to Time'."); return
        current_date_display = self.date_selector.currentText()
        current_date_data = self.date_selector.currentData()
        self.go_to_time_dialog_instance = widgets.GoToTimeDialog(self, current_date_display, self.app_state.first_timestamp_of_day, self.app_state.daily_clip_collections, self.camera_name_to_index["front"])
        self.go_to_time_dialog_instance.request_thumbnail.connect(self.generate_and_set_thumbnail)
        if self.go_to_time_dialog_instance.exec():
            time_str = self.go_to_time_dialog_instance.get_time_string().strip()
            if not time_str: return
            try: target_dt = datetime.strptime(f"{current_date_data} {time_str}", "%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError): QMessageBox.warning(self,"Invalid Time","Please use HH:MM:SS format."); return
            if self.app_state.first_timestamp_of_day:
                global_ms = (target_dt - self.app_state.first_timestamp_of_day).total_seconds()*1000
                if 0 <= global_ms <= self.scrubber.maximum(): self.seek_all_global(int(global_ms))
                else: QMessageBox.information(self,"Out of Range","The specified time is outside the range of the current day's clips.")
        self.go_to_time_dialog_instance = None
    
    def toggle_play_pause_all(self):
        """Toggle play/pause (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.toggle_play_pause_all()
        else:
            # Fallback to original implementation
            if not self.app_state.is_daily_view_active: return
            if any(p.playbackState() == QMediaPlayer.PlaybackState.PlayingState for p in self.get_active_players()):
                self.pause_all()
            else:
                self.play_all()

    def play_all(self):
        """Start playback (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.play_all()
        else:
            # Fallback to original implementation
            self.play_btn.setText("⏸️ Pause"); rate = self.playback_rates.get(self.speed_selector.currentText(), 1.0)
            any_playing = False
            for i, p in enumerate(self.get_active_players()):
                if i in self.ordered_visible_player_indices and p.source() and p.source().isValid():
                    p.setPlaybackRate(rate); p.play(); any_playing = True
            if any_playing: self.position_update_timer.start()

    def pause_all(self):
        """Pause playback (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.pause_all()
        else:
            # Fallback to original implementation
            self.play_btn.setText("▶️ Play"); [p.pause() for p in self.get_active_players()]; self.position_update_timer.stop(); self.update_slider_and_time_display()

    def frame_action(self, offset_ms):
        """Frame step action (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.frame_action(offset_ms)
        else:
            # Fallback to original implementation
            if not self.app_state.is_daily_view_active: return
            self.pause_all(); [p.setPosition(p.position() + offset_ms) for p in self.get_active_players() if p.source() and p.source().isValid()]; self.update_slider_and_time_display()

    def frame_action_precise(self, direction):
        """Frame-accurate navigation using Tesla camera specifications (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.frame_action_precise(direction)
        else:
            # Fallback to legacy frame action with Tesla FPS calculation
            tesla_fps = 36.02
            frame_duration_ms = 1000.0 / tesla_fps  # ≈ 27.8ms per frame
            offset_ms = direction * frame_duration_ms
            self.frame_action(int(offset_ms))

    def _handle_scrubber_press(self):
        if not self.app_state.is_daily_view_active: return
        self.was_playing_before_scrub = self.play_btn.text() == "⏸️ Pause"
        self.pause_all()

    def handle_scrubber_release(self):
        self.seek_all_global(self.scrubber.value())
        if self.was_playing_before_scrub:
            self.play_all()
        self.was_playing_before_scrub = False

    def seek_all_global(self, global_ms, restore_play_state=False):
        """Seek to global timeline position (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.seek_all_global(global_ms, restore_play_state)
        else:
            # Fallback to original implementation
            if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day: return

            was_playing = self.play_btn.text() == "⏸️ Pause"
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

    # ExportManager wrappers (Week 4)
    def mark_start_time(self):
        """Mark start time for export (delegated to ExportManager)."""
        if hasattr(self, 'export_manager') and self.export_manager.is_initialized():
            self.export_manager.set_start_marker(self.scrubber.value())
            self.update_export_ui()
        else:
            # Fallback implementation
            if not self.app_state.is_daily_view_active:
                return
            self.app_state.export_state.start_ms = self.scrubber.value()
            if self.app_state.export_state.end_ms is not None and self.app_state.export_state.start_ms >= self.app_state.export_state.end_ms:
                self.app_state.export_state.end_ms = self.app_state.export_state.start_ms + 1000
            self.update_export_ui()

    def mark_end_time(self):
        """Mark end time for export (delegated to ExportManager)."""
        if hasattr(self, 'export_manager') and self.export_manager.is_initialized():
            self.export_manager.set_end_marker(self.scrubber.value())
            self.update_export_ui()
        else:
            # Fallback implementation
            if not self.app_state.is_daily_view_active:
                return
            self.app_state.export_state.end_ms = self.scrubber.value()
            if self.app_state.export_state.start_ms is not None and self.app_state.export_state.end_ms <= self.app_state.export_state.start_ms:
                self.app_state.export_state.start_ms = self.app_state.export_state.end_ms - 1000
            self.update_export_ui()

    def handle_marker_drag(self, marker_type, value):
        """Handle marker drag (delegated to ExportManager)."""
        if hasattr(self, 'export_manager') and self.export_manager.is_initialized():
            self.export_manager.handle_marker_drag(marker_type, value)
            self.update_export_ui()
            self.preview_at_global_ms(value)
        else:
            # Fallback implementation
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

    def add_manual_bookmark(self):
        """Add a manual bookmark at the current playback position."""
        try:
            if not self.app_state.is_daily_view_active:
                return

            current_position = self.scrubber.value()
            self.scrubber.add_manual_bookmark(current_position)

            # Show confirmation message
            global_time = self.app_state.first_timestamp_of_day + timedelta(milliseconds=current_position)
            timestamp_str = global_time.strftime('%I:%M:%S %p')
            print(f"Bookmark added at {timestamp_str}")

        except Exception as e:
            print(f"Error adding bookmark: {e}")

    def handle_bookmark_added(self, position_ms):
        """Handle bookmark added signal from scrubber."""
        try:
            # Could add bookmark to a persistent list or database here
            # For now, just log the bookmark
            global_time = self.app_state.first_timestamp_of_day + timedelta(milliseconds=position_ms)
            timestamp_str = global_time.strftime('%I:%M:%S %p')
            self.logger.info(f"Manual bookmark added at {timestamp_str} ({position_ms}ms)")

        except Exception as e:
            print(f"Error handling bookmark: {e}")

    def update_export_ui(self):
        self.start_time_label.setText(f"Start: {utils.format_time(self.app_state.export_state.start_ms)}")
        self.end_time_label.setText(f"End: {utils.format_time(self.app_state.export_state.end_ms)}")
        self.scrubber.set_export_range(self.app_state.export_state.start_ms, self.app_state.export_state.end_ms)

    def show_export_dialog(self):
        """Show export dialog (with ExportManager validation)."""
        # Use ExportManager validation if available
        if hasattr(self, 'export_manager') and self.export_manager.is_initialized():
            is_valid, error_message = self.export_manager.validate_export_settings()
            if not is_valid:
                QMessageBox.warning(self, "Export Error", error_message)
                return
        else:
            # Fallback validation
            if not all([os.path.exists(FFMPEG_EXE), self.app_state.is_daily_view_active, self.app_state.export_state.start_ms is not None, self.app_state.export_state.end_ms is not None]):
                QMessageBox.warning(self, "Export Error", "Please load clips and set both a start and end time before exporting.")
                return

        # Show export options dialog
        dialog = QDialog(self)
        dialog.setWindowTitle("Export Options")
        layout = QVBoxLayout(dialog)
        layout.addWidget(QLabel("Select export quality:"))

        full_res_rb = QRadioButton("Full Resolution")
        mobile_rb = QRadioButton("Mobile Friendly - 1080p")
        full_res_rb.setChecked(True)
        layout.addWidget(full_res_rb)
        layout.addWidget(mobile_rb)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)

        if dialog.exec():
            output_path, _ = QFileDialog.getSaveFileName(
                self,
                "Save Exported Clip",
                f"{self.date_selector.currentData()}_clip.mp4",
                "MP4 Videos (*.mp4)"
            )
            if output_path:
                self.start_export(output_path, mobile_rb.isChecked())

    def start_export(self, output_path, is_mobile):
        """Start export operation (delegated to ExportManager)."""
        if hasattr(self, 'export_manager') and self.export_manager.is_initialized():
            success = self.export_manager.start_export(output_path, is_mobile)
            if not success:
                # Error handling is done by ExportManager through signals
                pass
        else:
            # Fallback implementation
            self.pause_all()
            result = self._build_ffmpeg_command(output_path, is_mobile)
            if not result or not result[0]:
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
            self.progress_dialog.setValue(100)
        self.progress_dialog.close()
        
        if self.export_thread:
            self.export_thread.quit()
            self.export_thread.wait()

        if success:
            QMessageBox.information(self, "Export Complete", message)
        else:
            QMessageBox.critical(self, "Export Failed", message)
            
        for path in self.files_to_cleanup_after_export:
            try: os.remove(path)
            except OSError as e: print(f"Error removing temp file {path}: {e}")
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
        """Legacy speed setting method (kept for compatibility)."""
        rate = self.playback_rates.get(speed_text, 1.0)
        for p_set in [self.players_a, self.players_b]:
            for p in p_set:
                p.setPlaybackRate(rate)

    def set_playback_speed_smooth(self, speed_text):
        """Enhanced speed setting with smooth transitions (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            rate = self.playback_rates.get(speed_text, 1.0)
            self.video_manager.set_playback_rate_smooth(rate)
        else:
            # Fallback to original method
            self.set_playback_speed(speed_text)

    def _optimized_position_update(self):
        """Optimized position update that only handles scrubber position, not timestamp display."""
        try:
            start_time = time.time()
            utils.performance_monitor.record_timer_update(start_time)

            # Update watchdog heartbeat
            self.last_timer_heartbeat = start_time

            if utils.DEBUG_TIMING:
                print(f"[TIMING] Timer update at {start_time:.3f}")

            if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day:
                return

            # Get active players with bounds checking
            if utils.DEBUG_TIMING:
                step_time = time.time()
                print(f"[TIMING] Getting active players at {step_time:.3f}")

            active_players = self.get_active_players()
            if not active_players or len(active_players) <= self.camera_name_to_index["front"]:
                return

            if utils.DEBUG_TIMING:
                step_time = time.time()
                print(f"[TIMING] Got active players at {step_time:.3f}")

            ref_player = active_players[self.camera_name_to_index["front"]]
            if not (ref_player.source() and ref_player.source().isValid()):
                ref_player = next((p for i, p in enumerate(active_players) if p.source() and p.source().isValid()), None)

            if not ref_player:
                return

            if utils.DEBUG_TIMING:
                step_time = time.time()
                print(f"[TIMING] Getting player position at {step_time:.3f}")

            # Use cached position to reduce blocking calls
            if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
                current_pos = self.video_manager.get_cached_player_position(ref_player)
            else:
                current_pos = ref_player.position()

            if utils.DEBUG_TIMING:
                step_time = time.time()
                print(f"[TIMING] Got player position {current_pos} at {step_time:.3f}")

            global_position = self.app_state.playback_state.segment_start_ms + current_pos

            # Bounds checking to prevent erratic scrubber behavior
            global_position = max(0, min(global_position, self.scrubber.maximum()))

            # Only update scrubber if not being dragged and position is valid
            if not self.scrubber.isSliderDown() and global_position >= 0:
                if utils.DEBUG_TIMING:
                    step_time = time.time()
                    print(f"[TIMING] Updating scrubber at {step_time:.3f}")

                # Prevent rapid updates that could cause jumping
                current_scrubber_value = self.scrubber.value()
                position_diff = abs(global_position - current_scrubber_value)

                # Only update if position changed significantly (>50ms) to reduce jitter
                if position_diff > 50:
                    self.scrubber.blockSignals(True)
                    self.scrubber.setValue(global_position)
                    self.scrubber.blockSignals(False)

                    if utils.DEBUG_TIMING:
                        step_time = time.time()
                        print(f"[TIMING] Scrubber updated at {step_time:.3f}")

            # Record performance metrics
            duration_ms = (time.time() - start_time) * 1000
            utils.performance_monitor.record_ui_update_duration(duration_ms)

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error in _optimized_position_update: {e}")
                traceback.print_exc()

    def _update_timestamp_display(self):
        """Separate method for updating timestamp display using asynchronous worker when available."""
        try:
            start_time = time.time()

            if not self.app_state.is_daily_view_active or not self.app_state.first_timestamp_of_day:
                return

            # Get active players with bounds checking
            active_players = self.get_active_players()
            if not active_players or len(active_players) <= self.camera_name_to_index["front"]:
                return

            ref_player = active_players[self.camera_name_to_index["front"]]
            if not (ref_player.source() and ref_player.source().isValid()):
                ref_player = next((p for i, p in enumerate(active_players) if p.source() and p.source().isValid()), None)

            if not ref_player:
                return

            # Use cached position to reduce blocking calls
            if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
                current_pos = self.video_manager.get_cached_player_position(ref_player)
            else:
                current_pos = ref_player.position()

            global_position = self.app_state.playback_state.segment_start_ms + current_pos
            clip_duration = ref_player.duration()

            # Use asynchronous worker if available, otherwise fall back to synchronous calculation
            if self.timestamp_worker and self.timestamp_worker_thread and self.timestamp_worker_thread.isRunning():
                # Queue asynchronous timestamp calculation
                self.timestamp_worker.calculate_timestamp(
                    global_position,
                    current_pos,
                    clip_duration,
                    self.app_state.first_timestamp_of_day
                )
            else:
                # Fallback to synchronous calculation
                calc_start = time.time()

                global_time = self.app_state.first_timestamp_of_day + timedelta(milliseconds=global_position)

                # Use optimized timestamp formatter to reduce string operations
                timestamp = utils.timestamp_formatter.format_timestamp(global_time)

                # Pre-format clip times to avoid repeated calls
                current_clip_time = utils.format_time(current_pos)
                total_clip_time = utils.format_time(clip_duration if clip_duration > 0 else 0)

                # Single setText call to minimize UI updates
                display_text = f"{timestamp} (Clip: {current_clip_time} / {total_clip_time})"
                self.time_label.setText(display_text)

                # Record performance metrics
                calc_duration_ms = (time.time() - calc_start) * 1000
                utils.performance_monitor.record_timestamp_calc_duration(calc_duration_ms)

            total_duration_ms = (time.time() - start_time) * 1000
            utils.performance_monitor.record_ui_update_duration(total_duration_ms)

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error in _update_timestamp_display: {e}")
                traceback.print_exc()

    def update_slider_and_time_display(self):
        """Legacy method maintained for compatibility - delegates to optimized methods."""
        try:
            self._optimized_position_update()
            self._update_timestamp_display()
        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error in update_slider_and_time_display: {e}")
                traceback.print_exc()
    
    def clear_all_players(self):
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

        # Stop all timers
        self.position_update_timer.stop()
        if hasattr(self, 'timestamp_display_timer'):
            self.timestamp_display_timer.stop()
        if hasattr(self, 'performance_monitor_timer'):
            self.performance_monitor_timer.stop()
        if hasattr(self, 'watchdog_timer'):
            self.watchdog_timer.stop()

        # Clean up timestamp worker
        self._cleanup_timestamp_worker()

        for p_set in [self.players_a, self.players_b]:
            for p in p_set: p.stop(); p.setSource(QUrl())
        
        root_path = self.app_state.root_clips_path
        self.app_state = AppState()
        self.app_state.root_clips_path = root_path

        # Update manager references to the new app_state
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.app_state = self.app_state
            # Update container service registration
            self.container.register_service('app_state', self.app_state)
        
        self.time_label.setText("MM/DD/YYYY HH:MM:SS AM/PM (Clip: 00:00 / 00:00)")
        self.scrubber.setValue(0); self.scrubber.setMaximum(1000)
        self.play_btn.setText("▶️ Play"); self.speed_selector.setCurrentText("1x") 
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
        """Load and set segment (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager._load_and_set_segment(segment_index, position_ms)
        else:
            # Fallback to original implementation
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
        """Preload next segment (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager._preload_next_segment()
        else:
            # Fallback to original implementation
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
        """Load next clip for player set (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager._load_next_clip_for_player_set(player_set, player_index, force_index)
        else:
            # Fallback to original implementation
            idx_to_load = force_index if force_index is not None else self.app_state.playback_state.clip_indices[player_index]
            clips = self.app_state.daily_clip_collections[player_index]
            if 0 <= idx_to_load < len(clips):
                player_set[player_index].setSource(QUrl.fromLocalFile(clips[idx_to_load]))
            else: player_set[player_index].setSource(QUrl())
            
    def handle_media_status_changed(self, status, player_instance, player_index):
        """Handle media status changes (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager.handle_media_status_changed(status, player_instance, player_index)
        else:
            # Fallback to original implementation
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
        """Swap player sets (delegated to VideoPlaybackManager)."""
        if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
            self.video_manager._swap_player_sets()
        else:
            # Fallback to original implementation
            # Cancel any pending seeks before swapping, as they are no longer relevant.
            self.pending_seek_position = -1
            self.players_awaiting_seek.clear()

            if utils.DEBUG_UI: print(f"--- Swapping player sets. New active set: {'b' if self.active_player_set == 'a' else 'a'} ---")
            was_playing = self.play_btn.text() == "⏸️ Pause"
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
        """Update layout (delegated to LayoutManager)."""
        if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
            self.layout_manager.update_ui_layout()
        else:
            # Fallback to original implementation
            # Remove all widgets from the grid
            while self.video_grid.count():
                item = self.video_grid.takeAt(0)
                widget = item.widget() if item else None
                if widget is not None:
                    widget.setParent(None)
                    widget.hide()

            num_visible = len(self.ordered_visible_player_indices)
            if num_visible == 0:
                self.video_grid.update()
                return

            # Calculate columns (1 for 1, 2 for 2/4, 3 for 3/6)
            cols = 1 if num_visible == 1 else 2 if num_visible in [2, 4] else 3

            current_col, current_row = 0, 0
            for p_idx in self.ordered_visible_player_indices:
                widget = self.video_player_item_widgets[p_idx]
                widget.setVisible(True)
                widget.reset_view()  # Ensure video fits the new cell size
                self.video_grid.addWidget(widget, current_row, current_col)
                active_video_item = self.get_active_video_items()[p_idx]
                widget.set_video_item(active_video_item)

                current_col += 1
                if current_col >= cols:
                    current_col = 0
                    current_row += 1

            # Hide any widgets not in the visible set
            for hidden_idx in (set(range(6)) - set(self.ordered_visible_player_indices)):
                self.video_player_item_widgets[hidden_idx].setVisible(False)

            # Set row and column stretch factors for uniform grid sizing
            num_rows = (num_visible + cols - 1) // cols
            if num_visible == 1:
                # Only one camera: make it fill all space
                self.video_grid.setRowStretch(0, 1)
                self.video_grid.setColumnStretch(0, 1)
                # Set all other stretches to 0 (in case of previous layouts)
                for i in range(1, 6):
                    self.video_grid.setRowStretch(i, 0)
                    self.video_grid.setColumnStretch(i, 0)
            else:
                for i in range(num_rows):
                    self.video_grid.setRowStretch(i, 1)
                for j in range(cols):
                    self.video_grid.setColumnStretch(j, 1)

            self.video_grid_widget.updateGeometry()
            self.video_grid_widget.update()
            self.video_grid_widget.adjustSize()
            self.video_grid.update()
            self.video_grid.invalidate()

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

    # ========================================
    # Manager Infrastructure (Week 1 Implementation)
    # ========================================

    def _initialize_managers(self) -> None:
        """Initialize the manager-based architecture infrastructure."""
        try:
            # Create dependency injection container
            self.container = DependencyContainer()

            # Create and register error handler
            self.error_handler = ErrorHandler()
            self.container.register_service('error_handler', self.error_handler)

            # Register core services
            self.container.register_service('app_state', self.app_state)
            self.container.register_service('settings', self.settings)
            self.container.register_service('camera_map', self.camera_name_to_index)

            # Create managers
            self.config_manager = ConfigurationManager(self, self.container)
            self.logging_manager = LoggingManager(self, self.container)
            self.cache_manager = CacheManager(self, self.container)
            self.plugin_manager = PluginManager(self, self.container)
            self.video_manager = VideoPlaybackManager(self, self.container)
            self.export_manager = ExportManager(self, self.container)
            self.layout_manager = LayoutManager(self, self.container)
            self.clip_manager = ClipManager(self, self.container)

            # Register managers in container
            self.container.register_service('configuration', self.config_manager)
            self.container.register_service('logging', self.logging_manager)
            self.container.register_service('cache', self.cache_manager)
            self.container.register_service('plugin', self.plugin_manager)
            self.container.register_service('video_playback', self.video_manager)
            self.container.register_service('export', self.export_manager)
            self.container.register_service('layout', self.layout_manager)
            self.container.register_service('clip', self.clip_manager)

            # Initialize managers
            if not self._initialize_all_managers():
                raise RuntimeError("Failed to initialize one or more managers")

            # Connect manager signals to UI
            self._connect_manager_signals()

            print("✓ Manager infrastructure initialized successfully")

        except Exception as e:
            error_msg = f"Failed to initialize manager infrastructure: {e}"
            print(f"✗ {error_msg}")
            QMessageBox.critical(self, "Initialization Error", error_msg)
            raise

    def _initialize_all_managers(self) -> bool:
        """Initialize all managers in correct order."""
        managers = [
            ('ConfigurationManager', self.config_manager),
            ('LoggingManager', self.logging_manager),
            ('CacheManager', self.cache_manager),
            ('PluginManager', self.plugin_manager),
            ('VideoPlaybackManager', self.video_manager),
            ('ExportManager', self.export_manager),
            ('LayoutManager', self.layout_manager),
            ('ClipManager', self.clip_manager),
        ]

        for name, manager in managers:
            try:
                if not manager.initialize():
                    print(f"✗ Failed to initialize {name}")
                    return False
                print(f"✓ {name} initialized successfully")
            except Exception as e:
                print(f"✗ Error initializing {name}: {e}")
                return False

        return True

    def _connect_manager_signals(self) -> None:
        """Connect manager signals to UI update methods."""
        try:
            # Connect error handler signals
            self.error_handler.error_occurred.connect(self._on_manager_error)
            self.error_handler.critical_error.connect(self._on_critical_error)

            # Configuration manager signals (Week 7 implementation)
            self.config_manager.signals.setting_changed.connect(self._on_setting_changed)
            self.config_manager.signals.theme_changed.connect(self._on_theme_changed)
            self.config_manager.signals.language_changed.connect(self._on_language_changed)
            self.config_manager.signals.profile_loaded.connect(self._on_profile_loaded)

            # Logging manager signals (Week 7 implementation)
            self.logging_manager.signals.log_level_changed.connect(self._on_log_level_changed)
            self.logging_manager.signals.debug_mode_changed.connect(self._on_debug_mode_changed)
            self.logging_manager.signals.critical_error_logged.connect(self._on_critical_error_logged)
            self.logging_manager.signals.log_cleanup_completed.connect(self._on_log_cleanup_completed)

            # Cache manager signals (Week 7 implementation)
            self.cache_manager.signals.cache_cleanup_completed.connect(self._on_cache_cleanup_completed)
            self.cache_manager.signals.cache_size_warning.connect(self._on_cache_size_warning)
            self.cache_manager.signals.cache_hit_rate_updated.connect(self._on_cache_hit_rate_updated)

            # Plugin manager signals (Week 7 implementation)
            self.plugin_manager.signals.plugin_loaded.connect(self._on_plugin_loaded)
            self.plugin_manager.signals.plugin_unloaded.connect(self._on_plugin_unloaded)
            self.plugin_manager.signals.plugin_error.connect(self._on_plugin_error)
            self.plugin_manager.signals.plugins_discovered.connect(self._on_plugins_discovered)

            # Video playback manager signals (Week 2 Implementation)
            self.video_manager.signals.playback_state_changed.connect(self._on_playback_state_changed)
            self.video_manager.signals.position_changed.connect(self._on_position_changed)
            self.video_manager.signals.segment_changed.connect(self._on_segment_changed)
            self.video_manager.signals.error_occurred.connect(self._on_video_manager_error)
            self.video_manager.signals.player_swap_completed.connect(self._on_player_swap_completed)

            # Export manager signals (Week 4 implementation)
            self.export_manager.signals.export_started.connect(self._on_export_started)
            self.export_manager.signals.export_progress.connect(self._on_export_progress)
            self.export_manager.signals.export_finished.connect(self._on_export_finished)
            self.export_manager.signals.export_cancelled.connect(self._on_export_cancelled)
            self.export_manager.signals.export_markers_changed.connect(self._on_export_markers_changed)
            self.export_manager.signals.export_error.connect(self._on_export_error)
            self.export_manager.signals.export_validation_failed.connect(self._on_export_validation_failed)

            # Layout manager signals (Week 5 implementation)
            self.layout_manager.signals.layout_updated.connect(self._on_layout_updated)
            self.layout_manager.signals.camera_visibility_changed.connect(self._on_camera_visibility_changed)
            self.layout_manager.signals.camera_order_changed.connect(self._on_camera_order_changed)
            self.layout_manager.signals.grid_configuration_changed.connect(self._on_grid_configuration_changed)
            self.layout_manager.signals.layout_validation_failed.connect(self._on_layout_validation_failed)
            self.layout_manager.signals.camera_drop_completed.connect(self._on_camera_drop_completed)

            # Clip manager signals (Week 6 implementation)
            self.clip_manager.signals.folder_scan_completed.connect(self._on_folder_scan_completed)
            self.clip_manager.signals.clip_loading_started.connect(self._on_clip_loading_started)
            self.clip_manager.signals.clip_loading_progress.connect(self._on_clip_loading_progress)
            self.clip_manager.signals.clip_loading_completed.connect(self._on_clip_loading_completed)
            self.clip_manager.signals.clip_loading_failed.connect(self._on_clip_loading_failed)

            print("✓ Manager signals connected")

        except Exception as e:
            print(f"✗ Error connecting manager signals: {e}")

    def _on_manager_error(self, severity: str, title: str, message: str) -> None:
        """Handle error signals from managers."""
        if severity == "critical":
            QMessageBox.critical(self, title, message)
        elif severity == "error":
            QMessageBox.warning(self, title, message)
        else:
            print(f"Manager {severity}: {title} - {message}")

    def _on_critical_error(self, message: str) -> None:
        """Handle critical error signals from managers."""
        QMessageBox.critical(self, "Critical Error",
                           f"A critical error occurred:\n\n{message}\n\n"
                           "The application may not function correctly.")

    # ========================================
    # ConfigurationManager Signal Handlers (Week 7 Implementation)
    # ========================================

    def _on_setting_changed(self, setting_key: str, new_value: Any) -> None:
        """Handle setting changes from ConfigurationManager."""
        try:
            # Apply setting changes to UI
            if setting_key == 'ui.theme':
                self._apply_theme(new_value)
            elif setting_key == 'playback.default_speed':
                self._update_default_playback_speed(new_value)
            elif setting_key == 'ui.compact_mode':
                self._toggle_compact_mode(new_value)
            elif setting_key == 'cameras.default_layout':
                self._apply_camera_layout(new_value)

        except Exception as e:
            print(f"Error handling setting change: {e}")

    def _on_theme_changed(self, theme_name: str) -> None:
        """Handle theme changes from ConfigurationManager."""
        try:
            self._apply_theme(theme_name)
        except Exception as e:
            print(f"Error handling theme change: {e}")

    def _on_language_changed(self, language_code: str) -> None:
        """Handle language changes from ConfigurationManager."""
        try:
            # Language change implementation would go here
            # For now, just log the change
            print(f"Language changed to: {language_code}")
        except Exception as e:
            print(f"Error handling language change: {e}")

    def _on_profile_loaded(self, profile_name: str) -> None:
        """Handle profile loading from ConfigurationManager."""
        try:
            # Refresh UI with new profile settings
            self._refresh_ui_from_config()
            print(f"Profile '{profile_name}' loaded")
        except Exception as e:
            print(f"Error handling profile load: {e}")

    # ========================================
    # LoggingManager Signal Handlers (Week 7 Implementation)
    # ========================================

    def _on_log_level_changed(self, level: str) -> None:
        """Handle log level changes from LoggingManager."""
        try:
            print(f"Log level changed to: {level}")
            # Update UI elements that show current log level
        except Exception as e:
            print(f"Error handling log level change: {e}")

    def _on_debug_mode_changed(self, enabled: bool) -> None:
        """Handle debug mode changes from LoggingManager."""
        try:
            print(f"Debug mode {'enabled' if enabled else 'disabled'}")
            # Update UI to reflect debug mode state
        except Exception as e:
            print(f"Error handling debug mode change: {e}")

    def _on_critical_error_logged(self, logger_name: str, message: str) -> None:
        """Handle critical errors from LoggingManager."""
        try:
            # Show critical error notification to user
            QMessageBox.critical(self, "Critical Error",
                               f"Critical error in {logger_name}:\n{message}")
        except Exception as e:
            print(f"Error handling critical error notification: {e}")

    def _on_log_cleanup_completed(self, files_removed: int) -> None:
        """Handle log cleanup completion from LoggingManager."""
        try:
            if files_removed > 0:
                print(f"Log cleanup completed: {files_removed} files removed")
        except Exception as e:
            print(f"Error handling log cleanup notification: {e}")

    # ========================================
    # CacheManager Signal Handlers (Week 7 Implementation)
    # ========================================

    def _on_cache_cleanup_completed(self, files_removed: int, bytes_freed: int) -> None:
        """Handle cache cleanup completion from CacheManager."""
        try:
            if files_removed > 0:
                mb_freed = bytes_freed / (1024 * 1024)
                print(f"Cache cleanup completed: {files_removed} files removed, {mb_freed:.2f} MB freed")
        except Exception as e:
            print(f"Error handling cache cleanup notification: {e}")

    def _on_cache_size_warning(self, current_size_mb: int, limit_mb: int) -> None:
        """Handle cache size warnings from CacheManager."""
        try:
            print(f"Cache size warning: {current_size_mb} MB / {limit_mb} MB limit")
            # Could show a notification to user about high cache usage
        except Exception as e:
            print(f"Error handling cache size warning: {e}")

    def _on_cache_hit_rate_updated(self, cache_type: str, hit_rate: float) -> None:
        """Handle cache hit rate updates from CacheManager."""
        try:
            print(f"Cache hit rate for {cache_type}: {hit_rate:.2%}")
        except Exception as e:
            print(f"Error handling cache hit rate update: {e}")

    # ========================================
    # PluginManager Signal Handlers (Week 7 Implementation)
    # ========================================

    def _on_plugin_loaded(self, plugin_id: str, plugin_name: str) -> None:
        """Handle plugin loading from PluginManager."""
        try:
            print(f"Plugin loaded: {plugin_name} ({plugin_id})")
            # Could update plugin menu or toolbar here
        except Exception as e:
            print(f"Error handling plugin load notification: {e}")

    def _on_plugin_unloaded(self, plugin_id: str) -> None:
        """Handle plugin unloading from PluginManager."""
        try:
            print(f"Plugin unloaded: {plugin_id}")
            # Could update plugin menu or toolbar here
        except Exception as e:
            print(f"Error handling plugin unload notification: {e}")

    def _on_plugin_error(self, plugin_id: str, error_message: str) -> None:
        """Handle plugin errors from PluginManager."""
        try:
            print(f"Plugin error in {plugin_id}: {error_message}")
            # Could show error notification to user
        except Exception as e:
            print(f"Error handling plugin error notification: {e}")

    def _on_plugins_discovered(self, plugin_count: int) -> None:
        """Handle plugin discovery completion from PluginManager."""
        try:
            print(f"Plugin discovery completed: {plugin_count} plugins found")
        except Exception as e:
            print(f"Error handling plugin discovery notification: {e}")

    # ========================================
    # VideoPlaybackManager Signal Handlers (Week 2 Implementation)
    # ========================================

    def _on_playback_state_changed(self, is_playing: bool) -> None:
        """Handle playback state changes from VideoPlaybackManager."""
        try:
            # Update play button text
            if is_playing:
                self.play_btn.setText("⏸️ Pause")
                # Start both timers for smooth playback
                if hasattr(self, 'position_update_timer'):
                    self.position_update_timer.start()
                if hasattr(self, 'timestamp_display_timer'):
                    self.timestamp_display_timer.start()
            else:
                self.play_btn.setText("▶️ Play")
                # Stop timers when paused
                if hasattr(self, 'position_update_timer'):
                    self.position_update_timer.stop()
                if hasattr(self, 'timestamp_display_timer'):
                    self.timestamp_display_timer.stop()
                # Immediate update when paused for accurate display
                self.update_slider_and_time_display()
        except Exception as e:
            print(f"Error handling playback state change: {e}")

    def _on_position_changed(self, position_ms: int) -> None:
        """Handle position changes from VideoPlaybackManager."""
        try:
            # Update scrubber position if not being dragged by user
            if not getattr(self, '_scrubber_being_dragged', False) and not self.scrubber.isSliderDown():
                # Calculate global timeline position
                if self.app_state.playback_state and self.app_state.playback_state.segment_start_ms >= 0:
                    global_ms = self.app_state.playback_state.segment_start_ms + position_ms

                    # Bounds checking and validation
                    if 0 <= global_ms <= self.scrubber.maximum():
                        # Prevent rapid updates that could cause jumping
                        current_value = self.scrubber.value()
                        position_diff = abs(global_ms - current_value)

                        # Only update if position changed significantly (>50ms) to reduce jitter
                        if position_diff > 50:
                            self.scrubber.blockSignals(True)
                            self.scrubber.setValue(global_ms)
                            self.scrubber.blockSignals(False)
        except Exception as e:
            print(f"Error handling position change: {e}")

    def _on_segment_changed(self, segment_index: int) -> None:
        """Handle segment changes from VideoPlaybackManager."""
        try:
            # Update UI to reflect new segment
            self.update_slider_and_time_display()
        except Exception as e:
            print(f"Error handling segment change: {e}")

    def _on_video_manager_error(self, error_message: str) -> None:
        """Handle error signals from VideoPlaybackManager."""
        QMessageBox.warning(self, "Video Playback Error", error_message)

    def _on_player_swap_completed(self) -> None:
        """Handle player swap completion from VideoPlaybackManager."""
        try:
            # Update UI after player swap
            self.update_slider_and_time_display()
        except Exception as e:
            print(f"Error handling player swap completion: {e}")

    # ========================================
    # ExportManager Signal Handlers (Week 4 Implementation)
    # ========================================

    def _on_export_started(self) -> None:
        """Handle export start from ExportManager."""
        try:
            # Update UI to show export is in progress
            self.export_btn.setEnabled(False)
            self.export_btn.setText("Exporting...")
        except Exception as e:
            print(f"Error handling export start: {e}")

    def _on_export_progress(self, percentage: int, message: str) -> None:
        """Handle export progress updates from ExportManager."""
        try:
            # Progress is handled by ExportManager's progress dialog
            # This is for any additional UI updates if needed
            pass
        except Exception as e:
            print(f"Error handling export progress: {e}")

    def _on_export_finished(self, success: bool, message: str) -> None:
        """Handle export completion from ExportManager."""
        try:
            # Reset export button
            self.export_btn.setEnabled(True)
            self.export_btn.setText("Export Clip")

            # Additional UI updates if needed
            if success:
                print(f"Export completed successfully: {message}")
            else:
                print(f"Export failed: {message}")

        except Exception as e:
            print(f"Error handling export finished: {e}")

    def _on_export_cancelled(self) -> None:
        """Handle export cancellation from ExportManager."""
        try:
            # Reset export button
            self.export_btn.setEnabled(True)
            self.export_btn.setText("Export Clip")
            print("Export cancelled by user")
        except Exception as e:
            print(f"Error handling export cancellation: {e}")

    def _on_export_markers_changed(self, start_ms: int, end_ms: int) -> None:
        """Handle export marker changes from ExportManager."""
        try:
            # Update UI to reflect new markers
            self.update_export_ui()
        except Exception as e:
            print(f"Error handling export markers changed: {e}")

    def _on_export_error(self, error_message: str) -> None:
        """Handle export errors from ExportManager."""
        try:
            QMessageBox.critical(self, "Export Error", error_message)
        except Exception as e:
            print(f"Error handling export error: {e}")

    def _on_export_validation_failed(self, validation_message: str) -> None:
        """Handle export validation failures from ExportManager."""
        try:
            QMessageBox.warning(self, "Export Validation Failed", validation_message)
        except Exception as e:
            print(f"Error handling export validation failed: {e}")

    # ========================================
    # Layout Manager Signal Handlers (Week 5 Implementation)
    # ========================================

    def _on_layout_updated(self) -> None:
        """Handle layout update from LayoutManager."""
        try:
            # Update ordered_visible_player_indices for backward compatibility
            if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
                self.ordered_visible_player_indices = self.layout_manager.get_visible_cameras()

                # Notify VideoPlaybackManager about layout changes if needed
                if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
                    # VideoPlaybackManager will use the updated ordered_visible_player_indices
                    pass
        except Exception as e:
            print(f"Error handling layout update: {e}")

    def _on_camera_visibility_changed(self, camera_index: int, is_visible: bool) -> None:
        """Handle camera visibility change from LayoutManager."""
        try:
            # If camera is being made visible, synchronize it with other cameras
            if is_visible:
                self._synchronize_newly_visible_camera(camera_index)
        except Exception as e:
            print(f"Error handling camera visibility change: {e}")

    def _synchronize_newly_visible_camera(self, camera_index: int) -> None:
        """
        Synchronize a newly visible camera with the current playback state.

        This is a fallback synchronization method used when the VideoPlaybackManager
        is not available or not initialized. It provides the same functionality as
        the manager-based synchronization but operates directly on UI components.

        The method performs the following steps:
        1. Gets the current playback state (playing/paused)
        2. Finds a reference position from currently visible cameras
        3. Loads the appropriate video segment for the target camera
        4. Sets up a callback to seek to the correct position when media loads
        5. Resumes playback if other cameras were playing

        Args:
            camera_index (int): Index of the camera to synchronize (0-5)

        Note:
            This method is automatically called by the camera visibility change
            handler when the VideoPlaybackManager is not available. It uses
            Qt's signal/slot mechanism to ensure proper timing of the seek
            operation after media loading completes.

        See Also:
            VideoPlaybackManager.synchronize_camera_to_current_position():
            The preferred synchronization method when managers are available.
        """
        try:
            if not self.app_state.is_daily_view_active:
                return

            # Get current playback state
            was_playing = self.play_btn.text() == "⏸️ Pause"

            # Get reference position from currently visible cameras
            reference_position = self._get_reference_playback_position()
            if reference_position is None:
                return

            current_segment_index = reference_position['segment_index']
            current_local_ms = reference_position['local_ms']

            # Get active players
            active_players = self.get_active_players()
            target_player = active_players[camera_index]

            # Check if we need to load a different segment for this camera
            camera_clips = self.app_state.daily_clip_collections[camera_index]
            if not camera_clips or current_segment_index >= len(camera_clips):
                # No clips available for this camera at current segment
                target_player.setSource(QUrl())
                return

            # Load the correct segment for this camera
            target_clip_path = camera_clips[current_segment_index]
            target_player.setSource(QUrl.fromLocalFile(target_clip_path))

            # Set up synchronization when media is loaded
            def on_media_loaded():
                try:
                    if target_player.mediaStatus() == QMediaPlayer.MediaStatus.LoadedMedia:
                        # Seek to the correct position
                        target_player.setPosition(current_local_ms)

                        # Resume playback if other cameras were playing
                        if was_playing:
                            target_player.play()

                        # Disconnect the signal to avoid multiple calls
                        target_player.mediaStatusChanged.disconnect(on_media_loaded)

                except Exception as e:
                    print(f"Error in media loaded callback for camera {camera_index}: {e}")

            # Connect to media status change to sync when loaded
            target_player.mediaStatusChanged.connect(on_media_loaded)

        except Exception as e:
            print(f"Error synchronizing newly visible camera {camera_index}: {e}")

    def _get_reference_playback_position(self) -> dict:
        """
        Get the current playback position from visible cameras as reference.

        This method finds a suitable reference camera from currently visible cameras
        and extracts the current playback position information needed for synchronization.
        It prioritizes the front camera but will use any available camera as fallback.

        The method attempts to get position information in this order:
        1. Front camera (preferred reference)
        2. Any other visible camera with valid media
        3. Returns None if no suitable reference is found

        Returns:
            dict or None: Dictionary containing position information with keys:
                - 'global_ms' (int): Global timeline position in milliseconds
                - 'segment_index' (int): Current video segment index
                - 'local_ms' (int): Position within current segment in milliseconds

                Returns None if:
                - Daily view is not active
                - No cameras are currently visible
                - No visible cameras have valid media loaded

        Note:
            This method is used by the fallback UI synchronization when the
            VideoPlaybackManager is not available. The returned position data
            is used to synchronize newly visible cameras to the current playback state.
        """
        try:
            if not self.app_state.is_daily_view_active:
                return None

            # Get currently visible cameras
            visible_cameras = []
            if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
                visible_cameras = self.layout_manager.get_visible_cameras()
            else:
                visible_cameras = self.ordered_visible_player_indices

            if not visible_cameras:
                return None

            # Get active players
            active_players = self.get_active_players()

            # Find a reference player that has loaded media
            reference_player = None
            reference_camera_index = None

            # Prefer front camera as reference if visible and loaded
            front_idx = self.camera_name_to_index["front"]
            if front_idx in visible_cameras:
                front_player = active_players[front_idx]
                if (front_player.source() and front_player.source().isValid() and
                    front_player.mediaStatus() == QMediaPlayer.MediaStatus.LoadedMedia):
                    reference_player = front_player
                    reference_camera_index = front_idx

            # If front camera not available, use any other visible camera
            if not reference_player:
                for camera_idx in visible_cameras:
                    player = active_players[camera_idx]
                    if (player.source() and player.source().isValid() and
                        player.mediaStatus() == QMediaPlayer.MediaStatus.LoadedMedia):
                        reference_player = player
                        reference_camera_index = camera_idx
                        break

            if not reference_player:
                return None

            # Get current position information
            local_ms = reference_player.position()
            segment_start_ms = getattr(self.app_state.playback_state, 'segment_start_ms', 0)
            global_ms = segment_start_ms + local_ms

            # Get current segment index
            segment_index = 0
            if hasattr(self.app_state.playback_state, 'clip_indices'):
                segment_index = self.app_state.playback_state.clip_indices.get(reference_camera_index, 0)

            return {
                'global_ms': global_ms,
                'local_ms': local_ms,
                'segment_index': segment_index,
                'reference_camera': reference_camera_index
            }

        except Exception as e:
            print(f"Error getting reference playback position: {e}")
            return None

    def _on_camera_order_changed(self, new_order: list) -> None:
        """Handle camera order change from LayoutManager."""
        try:
            # Order change is handled by LayoutManager
            pass
        except Exception as e:
            print(f"Error handling camera order change: {e}")

    def _on_grid_configuration_changed(self, rows: int, cols: int) -> None:
        """Handle grid configuration change from LayoutManager."""
        try:
            # Grid configuration change is handled by LayoutManager
            pass
        except Exception as e:
            print(f"Error handling grid configuration change: {e}")

    def _on_layout_validation_failed(self, error_message: str) -> None:
        """Handle layout validation failure from LayoutManager."""
        try:
            QMessageBox.warning(self, "Layout Validation Failed", error_message)
        except Exception as e:
            print(f"Error handling layout validation failed: {e}")

    def _on_camera_drop_completed(self, dragged_index: int, dropped_on_index: int) -> None:
        """Handle camera drop completion from LayoutManager."""
        try:
            # Drop completion is handled by LayoutManager
            pass
        except Exception as e:
            print(f"Error handling camera drop completed: {e}")

    def show_error_message(self, message: str) -> None:
        """Show error message to user (fallback for managers without error handler)."""
        QMessageBox.warning(self, "Error", message)

    # ========================================
    # ClipManager Signal Handlers (Week 6 Implementation)
    # ========================================

    def _on_folder_scan_completed(self, available_dates: list) -> None:
        """Handle folder scan completion from ClipManager."""
        try:
            # Update date selector with available dates
            self.date_selector.blockSignals(True)
            self.date_selector.clear()
            self.date_selector.setEnabled(False)

            for date_str in available_dates:
                try:
                    display_text = datetime.strptime(date_str, "%Y-%m-%d").strftime("%m/%d/%Y")
                    self.date_selector.addItem(display_text, date_str)
                except ValueError:
                    continue

            if available_dates:
                self.date_selector.setEnabled(True)

            self.date_selector.blockSignals(False)

            # Update window title and UI to indicate folder type
            self._update_folder_type_indicator()

        except Exception as e:
            print(f"Error handling folder scan completed: {e}")

    def _update_folder_type_indicator(self) -> None:
        """Update UI elements to indicate the current folder type."""
        try:
            if hasattr(self, 'clip_manager') and self.clip_manager.is_initialized():
                if self.clip_manager.is_recent_clips_folder:
                    # Update window title for RecentClips
                    self.setWindowTitle("SentrySix - RecentClips Viewer")
                    # Update select folder button text
                    self.select_folder_btn.setText("📂 Select Clips (RecentClips)")
                    self.select_folder_btn.setToolTip("Currently viewing RecentClips - continuous recording without event markers")
                else:
                    # Update window title for SavedClips/SentryClips
                    self.setWindowTitle("SentrySix - Tesla Dashcam Viewer")
                    # Update select folder button text
                    self.select_folder_btn.setText("📂 Select Clips")
                    self.select_folder_btn.setToolTip("Currently viewing SavedClips/SentryClips with event markers")
            else:
                # Default state
                self.setWindowTitle("SentrySix - Tesla Dashcam Viewer")
                self.select_folder_btn.setText("📂 Select Clips")
                self.select_folder_btn.setToolTip("Select your Tesla clips folder")

        except Exception as e:
            print(f"Error updating folder type indicator: {e}")

    def _on_clip_loading_started(self, date_str: str) -> None:
        """Handle clip loading start from ClipManager."""
        try:
            self.set_ui_loading(True)
        except Exception as e:
            print(f"Error handling clip loading started: {e}")

    def _on_clip_loading_progress(self, percentage: int, status: str) -> None:
        """Handle clip loading progress from ClipManager."""
        try:
            # Progress updates are handled by ClipManager
            # Could update a progress bar here if needed
            pass
        except Exception as e:
            print(f"Error handling clip loading progress: {e}")

    def _on_clip_loading_completed(self, timeline_data: TimelineData) -> None:
        """Handle clip loading completion from ClipManager."""
        try:
            self.set_ui_loading(False)

            if timeline_data.error:
                QMessageBox.warning(self, "Could Not Load Date", timeline_data.error)
                return

            if timeline_data.first_timestamp_of_day is None:
                QMessageBox.warning(self, "No Videos", "No valid video files found.")
                return

            # Update app state with loaded data
            self.app_state.is_daily_view_active = True
            self.app_state.first_timestamp_of_day = timeline_data.first_timestamp_of_day
            self.app_state.daily_clip_collections = timeline_data.daily_clip_collections

            # Update UI components
            self.scrubber.setRange(0, timeline_data.total_duration_ms)
            self.scrubber.set_events(timeline_data.events)

            # Load first segment
            self._load_and_set_segment(0)
            self.update_layout()

            # Ensure LayoutManager updates UI after clips are loaded
            if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
                self.layout_manager._acquire_ui_components()
                self.layout_manager.update_ui_layout()

        except Exception as e:
            print(f"Error handling clip loading completed: {e}")

    def _on_clip_loading_failed(self, error_message: str) -> None:
        """Handle clip loading failure from ClipManager."""
        try:
            self.set_ui_loading(False)
            QMessageBox.warning(self, "Clip Loading Failed", error_message)
        except Exception as e:
            print(f"Error handling clip loading failed: {e}")

    def cleanup_managers(self) -> None:
        """Clean up all managers when application closes."""
        try:
            if hasattr(self, 'config_manager'):
                self.config_manager.cleanup()
            if hasattr(self, 'logging_manager'):
                self.logging_manager.cleanup()
            if hasattr(self, 'cache_manager'):
                self.cache_manager.cleanup()
            if hasattr(self, 'plugin_manager'):
                self.plugin_manager.cleanup()
            if hasattr(self, 'video_manager'):
                self.video_manager.cleanup()
            if hasattr(self, 'export_manager'):
                self.export_manager.cleanup()
            if hasattr(self, 'layout_manager'):
                self.layout_manager.cleanup()
            if hasattr(self, 'clip_manager'):
                self.clip_manager.cleanup()
            if hasattr(self, 'container'):
                self.container.clear()
            print("✓ Managers cleaned up successfully")
        except Exception as e:
            print(f"✗ Error during manager cleanup: {e}")

    # ========================================
    # ConfigurationManager Wrapper Methods (Week 7 Implementation)
    # ========================================

    def get_setting(self, key: str, default: Any = None) -> Any:
        """Get a configuration setting (delegated to ConfigurationManager)."""
        if hasattr(self, 'config_manager') and self.config_manager.is_initialized():
            return self.config_manager.get_setting(key, default)
        else:
            # Fallback to QSettings for basic settings
            return self.settings.value(key, default)

    def set_setting(self, key: str, value: Any, save: bool = True) -> bool:
        """Set a configuration setting (delegated to ConfigurationManager)."""
        if hasattr(self, 'config_manager') and self.config_manager.is_initialized():
            return self.config_manager.set_setting(key, value, save)
        else:
            # Fallback to QSettings
            self.settings.setValue(key, value)
            if save:
                self.settings.sync()
            return True

    def save_window_geometry(self) -> None:
        """Save current window geometry to configuration."""
        try:
            geometry = self.saveGeometry()
            window_state = self.saveState()

            if hasattr(self, 'config_manager') and self.config_manager.is_initialized():
                self.config_manager.set_setting('app.window_geometry', geometry.data())
                self.config_manager.set_setting('app.window_state', window_state.data())
            else:
                self.settings.setValue('geometry', geometry)
                self.settings.setValue('windowState', window_state)

        except Exception as e:
            print(f"Error saving window geometry: {e}")

    def restore_window_geometry(self) -> None:
        """Restore window geometry from configuration."""
        try:
            if hasattr(self, 'config_manager') and self.config_manager.is_initialized():
                geometry = self.config_manager.get_setting('app.window_geometry')
                window_state = self.config_manager.get_setting('app.window_state')

                if geometry:
                    self.restoreGeometry(geometry)
                if window_state:
                    self.restoreState(window_state)
            else:
                geometry = self.settings.value('geometry')
                window_state = self.settings.value('windowState')

                if geometry:
                    self.restoreGeometry(geometry)
                if window_state:
                    self.restoreState(window_state)

        except Exception as e:
            print(f"Error restoring window geometry: {e}")

    def _apply_theme(self, theme_name: str) -> None:
        """Apply a theme to the application."""
        try:
            # Theme application logic would go here
            # For now, just log the theme change
            print(f"Applying theme: {theme_name}")
        except Exception as e:
            print(f"Error applying theme: {e}")

    def _update_default_playback_speed(self, speed: float) -> None:
        """Update default playback speed."""
        try:
            # Update playback speed logic would go here
            print(f"Default playback speed updated to: {speed}")
        except Exception as e:
            print(f"Error updating playback speed: {e}")

    def _toggle_compact_mode(self, enabled: bool) -> None:
        """Toggle compact mode UI."""
        try:
            # Compact mode logic would go here
            print(f"Compact mode {'enabled' if enabled else 'disabled'}")
        except Exception as e:
            print(f"Error toggling compact mode: {e}")

    def _apply_camera_layout(self, layout_name: str) -> None:
        """Apply camera layout configuration."""
        try:
            # Camera layout logic would go here
            print(f"Applying camera layout: {layout_name}")
        except Exception as e:
            print(f"Error applying camera layout: {e}")

    def _refresh_ui_from_config(self) -> None:
        """Refresh UI elements from current configuration."""
        try:
            if hasattr(self, 'config_manager') and self.config_manager.is_initialized():
                # Apply current settings to UI
                theme = self.config_manager.get_setting('ui.theme', 'dark')
                self._apply_theme(theme)

                speed = self.config_manager.get_setting('playback.default_speed', 1.0)
                self._update_default_playback_speed(speed)

                compact = self.config_manager.get_setting('ui.compact_mode', False)
                self._toggle_compact_mode(compact)

        except Exception as e:
            print(f"Error refreshing UI from config: {e}")

    # ========================================
    # LoggingManager Wrapper Methods (Week 7 Implementation)
    # ========================================

    def get_logger(self, name: str):
        """Get a logger instance (delegated to LoggingManager)."""
        if hasattr(self, 'logging_manager') and self.logging_manager.is_initialized():
            return self.logging_manager.get_logger(name)
        else:
            # Fallback to standard logging
            import logging
            return logging.getLogger(name)

    def set_log_level(self, level: str) -> bool:
        """Set log level (delegated to LoggingManager)."""
        if hasattr(self, 'logging_manager') and self.logging_manager.is_initialized():
            return self.logging_manager.set_log_level(level)
        else:
            # Fallback to standard logging
            import logging
            try:
                numeric_level = getattr(logging, level.upper())
                logging.getLogger().setLevel(numeric_level)
                return True
            except AttributeError:
                return False

    def set_debug_mode(self, enabled: bool) -> None:
        """Enable/disable debug mode (delegated to LoggingManager)."""
        if hasattr(self, 'logging_manager') and self.logging_manager.is_initialized():
            self.logging_manager.set_debug_mode(enabled)
        else:
            # Fallback behavior
            level = 'DEBUG' if enabled else 'INFO'
            self.set_log_level(level)

    def log_performance_metric(self, metric_name: str, value: float, unit: str = 'ms') -> None:
        """Log performance metric (delegated to LoggingManager)."""
        if hasattr(self, 'logging_manager') and self.logging_manager.is_initialized():
            self.logging_manager.log_performance_metric(metric_name, value, unit)
        else:
            # Fallback to print
            print(f"PERF: {metric_name}: {value}{unit}")

    def get_log_file_info(self) -> dict:
        """Get log file information (delegated to LoggingManager)."""
        if hasattr(self, 'logging_manager') and self.logging_manager.is_initialized():
            return self.logging_manager.get_log_file_info()
        else:
            return {}

    def cleanup_old_logs(self, days: int = None) -> int:
        """Clean up old log files (delegated to LoggingManager)."""
        if hasattr(self, 'logging_manager') and self.logging_manager.is_initialized():
            return self.logging_manager.cleanup_old_logs(days)
        else:
            return 0

    # ========================================
    # CacheManager Wrapper Methods (Week 7 Implementation)
    # ========================================

    def get_cache(self, cache_type: str, key: str, default=None):
        """Get item from cache (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.get(cache_type, key, default)
        else:
            return default

    def set_cache(self, cache_type: str, key: str, value, ttl_days=None) -> bool:
        """Set item in cache (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.set(cache_type, key, value, ttl_days)
        else:
            return False

    def get_thumbnail(self, video_path: str, timestamp: float = 0.0):
        """Get thumbnail for video (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.get_thumbnail(video_path, timestamp)
        else:
            return None

    def store_thumbnail(self, video_path: str, thumbnail, timestamp: float = 0.0) -> bool:
        """Store thumbnail for video (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.store_thumbnail(video_path, thumbnail, timestamp)
        else:
            return False

    def get_video_metadata(self, video_path: str) -> dict:
        """Get cached video metadata (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.get_video_metadata(video_path) or {}
        else:
            return {}

    def store_video_metadata(self, video_path: str, metadata: dict) -> bool:
        """Store video metadata in cache (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.store_video_metadata(video_path, metadata)
        else:
            return False

    def get_cache_stats(self) -> dict:
        """Get cache statistics (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.get_cache_stats()
        else:
            return {}

    def cleanup_cache(self, cache_type: str = None) -> tuple:
        """Clean up cache entries (delegated to CacheManager)."""
        if hasattr(self, 'cache_manager') and self.cache_manager.is_initialized():
            return self.cache_manager.cleanup_expired(cache_type)
        else:
            return 0, 0

    # ========================================
    # PluginManager Wrapper Methods (Week 7 Implementation)
    # ========================================

    def load_plugin(self, plugin_path: str) -> bool:
        """Load a plugin (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            from pathlib import Path
            return self.plugin_manager.load_plugin(Path(plugin_path))
        else:
            return False

    def unload_plugin(self, plugin_id: str) -> bool:
        """Unload a plugin (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            return self.plugin_manager.unload_plugin(plugin_id)
        else:
            return False

    def get_loaded_plugins(self) -> dict:
        """Get loaded plugins (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            return self.plugin_manager.get_loaded_plugins()
        else:
            return {}

    def enable_plugin(self, plugin_id: str) -> bool:
        """Enable a plugin (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            return self.plugin_manager.enable_plugin(plugin_id)
        else:
            return False

    def disable_plugin(self, plugin_id: str) -> bool:
        """Disable a plugin (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            return self.plugin_manager.disable_plugin(plugin_id)
        else:
            return False

    def notify_plugins_video_loaded(self, video_path: str) -> None:
        """Notify plugins that a video was loaded (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            self.plugin_manager.notify_video_loaded(video_path)

    def notify_plugins_export_started(self, export_settings: dict) -> None:
        """Notify plugins that export started (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            self.plugin_manager.notify_export_started(export_settings)

    def notify_plugins_export_completed(self, export_path: str) -> None:
        """Notify plugins that export completed (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            self.plugin_manager.notify_export_completed(export_path)

    def get_plugin_info(self) -> dict:
        """Get plugin system information (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            return self.plugin_manager.get_plugin_info()
        else:
            return {}

    def create_sample_plugin(self, plugin_name: str) -> bool:
        """Create a sample plugin (delegated to PluginManager)."""
        if hasattr(self, 'plugin_manager') and self.plugin_manager.is_initialized():
            return self.plugin_manager.create_sample_plugin(plugin_name)
        else:
            return False

    def closeEvent(self, event):
        """Override close event to ensure proper cleanup."""
        try:
            self.cleanup_managers()
        except Exception as e:
            print(f"Error during cleanup: {e}")

        # Call original close event handling if it exists
        if hasattr(super(), 'closeEvent'):
            super().closeEvent(event)

    # ========================================
    # Manager Integration Methods (Week 5 Implementation)
    # ========================================

    def sync_layout_state(self) -> None:
        """Synchronize layout state between LayoutManager and UI."""
        try:
            if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
                # Update backward compatibility variables
                self.ordered_visible_player_indices = self.layout_manager.get_visible_cameras()

                # Ensure VideoPlaybackManager uses updated layout
                if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
                    # VideoPlaybackManager reads ordered_visible_player_indices from parent widget
                    pass

        except Exception as e:
            print(f"Error syncing layout state: {e}")

    def get_layout_diagnostics(self) -> dict:
        """Get layout diagnostics for debugging."""
        try:
            if hasattr(self, 'layout_manager') and self.layout_manager.is_initialized():
                return self.layout_manager.get_layout_diagnostics()
            else:
                return {
                    'error': 'LayoutManager not available',
                    'fallback_state': {
                        'ordered_visible_player_indices': getattr(self, 'ordered_visible_player_indices', []),
                        'camera_visibility_checkboxes_count': len(getattr(self, 'camera_visibility_checkboxes', [])),
                    }
                }
        except Exception as e:
            return {'error': f"Failed to get diagnostics: {str(e)}"}

    def get_timing_diagnostics(self) -> dict:
        """Get timing and performance diagnostics for debugging timestamp synchronization issues."""
        try:
            # Get performance statistics from the global monitor
            perf_stats = utils.performance_monitor.get_performance_stats()

            # Add current timer states
            timer_states = {
                'position_update_timer_active': getattr(self.position_update_timer, 'isActive', lambda: False)(),
                'position_update_timer_interval': getattr(self.position_update_timer, 'interval', lambda: 0)(),
                'timestamp_display_timer_active': getattr(self.timestamp_display_timer, 'isActive', lambda: False)() if hasattr(self, 'timestamp_display_timer') else False,
                'timestamp_display_timer_interval': getattr(self.timestamp_display_timer, 'interval', lambda: 0)() if hasattr(self, 'timestamp_display_timer') else 0,
            }

            # Add current playback state
            playback_info = {
                'is_playing': self.play_btn.text() == "⏸️ Pause",
                'is_daily_view_active': self.app_state.is_daily_view_active,
                'pending_position_update': getattr(self, 'pending_position_update', False),
                'last_position_update_time': getattr(self, 'last_position_update_time', 0),
                'last_timestamp_update_time': getattr(self, 'last_timestamp_update_time', 0),
            }

            # Get current video player status
            player_info = {}
            try:
                active_players = self.get_active_players()
                if active_players and len(active_players) > self.camera_name_to_index["front"]:
                    front_player = active_players[self.camera_name_to_index["front"]]
                    player_info = {
                        'front_player_position': front_player.position(),
                        'front_player_duration': front_player.duration(),
                        'front_player_state': str(front_player.playbackState()),
                        'front_player_media_status': str(front_player.mediaStatus()),
                        'front_player_has_valid_source': bool(front_player.source() and front_player.source().isValid()),
                    }
            except Exception as e:
                player_info = {'error': f"Failed to get player info: {str(e)}"}

            return {
                'performance_stats': perf_stats,
                'timer_states': timer_states,
                'playback_info': playback_info,
                'player_info': player_info,
                'timestamp': time.time()
            }

        except Exception as e:
            return {'error': f"Failed to get timing diagnostics: {str(e)}"}

    def print_timing_diagnostics(self):
        """Print timing diagnostics to console for debugging."""
        diagnostics = self.get_timing_diagnostics()
        print("\n=== TIMING DIAGNOSTICS ===")
        for category, data in diagnostics.items():
            print(f"\n{category.upper()}:")
            if isinstance(data, dict):
                for key, value in data.items():
                    print(f"  {key}: {value}")
            else:
                print(f"  {data}")
        print("========================\n")

    def _setup_timestamp_worker(self):
        """Setup asynchronous timestamp calculation worker."""
        try:
            from PyQt6.QtCore import QThread

            # Create worker thread for timestamp calculations
            self.timestamp_worker_thread = QThread()
            self.timestamp_worker = workers.TimestampCalculationWorker()

            # Move worker to thread
            self.timestamp_worker.moveToThread(self.timestamp_worker_thread)

            # Connect signals
            self.timestamp_worker.timestamp_calculated.connect(self._on_timestamp_calculated)

            # Start thread
            self.timestamp_worker_thread.start()

            if utils.DEBUG_UI:
                print("[UI] Asynchronous timestamp worker initialized")

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"[UI] Failed to setup timestamp worker: {e}")
            # Continue without async worker - will use synchronous updates
            self.timestamp_worker = None
            self.timestamp_worker_thread = None

    def _on_timestamp_calculated(self, display_text: str):
        """Handle timestamp calculation results from worker thread."""
        try:
            # Update the timestamp display with the calculated text
            self.time_label.setText(display_text)
        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error updating timestamp display: {e}")

    def _cleanup_timestamp_worker(self):
        """Clean up the timestamp worker thread."""
        try:
            if self.timestamp_worker:
                self.timestamp_worker.stop()

            if self.timestamp_worker_thread and self.timestamp_worker_thread.isRunning():
                self.timestamp_worker_thread.quit()
                self.timestamp_worker_thread.wait(1000)  # Wait up to 1 second

            self.timestamp_worker = None
            self.timestamp_worker_thread = None

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error cleaning up timestamp worker: {e}")

    def _report_performance_metrics(self):
        """Report performance metrics for real-time monitoring."""
        try:
            if not utils.DEBUG_UI_PERFORMANCE:
                return

            stats = utils.performance_monitor.get_performance_stats()

            print(f"\n[PERF] === Performance Report ===")
            print(f"[PERF] Timer frequency: {stats.get('timer_update_frequency', 0):.2f} Hz")
            print(f"[PERF] Position frequency: {stats.get('position_update_frequency', 0):.2f} Hz")
            print(f"[PERF] Avg UI update: {stats.get('avg_ui_update_time', 0):.2f} ms")
            print(f"[PERF] Avg timestamp calc: {stats.get('avg_timestamp_calc_time', 0):.2f} ms")
            print(f"[PERF] Max UI update: {stats.get('max_ui_update_time', 0):.2f} ms")
            print(f"[PERF] Conflicts detected: {stats.get('conflicts_detected', 0)}")

            # Check for performance issues
            if stats.get('avg_ui_update_time', 0) > 16.67:
                print(f"[PERF] WARNING: UI updates are slower than 60fps threshold!")

            if stats.get('conflicts_detected', 0) > 10:
                print(f"[PERF] WARNING: High number of timing conflicts detected!")

            if stats.get('max_ui_update_time', 0) > 50:
                print(f"[PERF] WARNING: Very slow UI update detected ({stats.get('max_ui_update_time', 0):.2f}ms)!")

            print(f"[PERF] ========================\n")

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error reporting performance metrics: {e}")

    def _watchdog_check(self):
        """Emergency watchdog to detect and recover from UI thread blocking."""
        try:
            current_time = time.time()
            time_since_heartbeat = current_time - self.last_timer_heartbeat

            # Check if UI has been frozen for more than 2 seconds
            if time_since_heartbeat > 2.0:
                if not self.ui_freeze_detected:
                    self.ui_freeze_detected = True
                    self.freeze_recovery_attempts += 1

                    if utils.DEBUG_UI:
                        print(f"[WATCHDOG] UI freeze detected! Time since last heartbeat: {time_since_heartbeat:.2f}s")
                        print(f"[WATCHDOG] Recovery attempt {self.freeze_recovery_attempts}/{self.max_freeze_recovery_attempts}")

                    # Attempt recovery
                    self._attempt_freeze_recovery()

                # If freeze persists for more than 5 seconds, force recovery
                elif time_since_heartbeat > 5.0:
                    if utils.DEBUG_UI:
                        print(f"[WATCHDOG] Severe UI freeze detected! Forcing emergency recovery...")
                    self._force_emergency_recovery()
            else:
                # Reset freeze detection if heartbeat is recent
                if self.ui_freeze_detected:
                    if utils.DEBUG_UI:
                        print(f"[WATCHDOG] UI freeze resolved. Normal operation resumed.")
                    self.ui_freeze_detected = False

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error in watchdog check: {e}")

    def _attempt_freeze_recovery(self):
        """Attempt to recover from UI freeze."""
        try:
            if self.freeze_recovery_attempts <= self.max_freeze_recovery_attempts:
                # Stop all timers temporarily
                if hasattr(self, 'position_update_timer'):
                    self.position_update_timer.stop()
                if hasattr(self, 'timestamp_display_timer'):
                    self.timestamp_display_timer.stop()

                # Clear any pending operations
                if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
                    # Clear pending seeks
                    self.video_manager.pending_seek_position = -1
                    self.video_manager.players_awaiting_seek.clear()

                # Restart timers with longer intervals
                recovery_interval = 200 + (self.freeze_recovery_attempts * 100)  # Progressively longer intervals

                if hasattr(self, 'position_update_timer'):
                    self.position_update_timer.setInterval(recovery_interval)
                    self.position_update_timer.start()

                if hasattr(self, 'timestamp_display_timer'):
                    self.timestamp_display_timer.setInterval(recovery_interval + 50)
                    self.timestamp_display_timer.start()

                if utils.DEBUG_UI:
                    print(f"[WATCHDOG] Recovery attempt: Set timer intervals to {recovery_interval}ms")

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error in freeze recovery: {e}")

    def _force_emergency_recovery(self):
        """Force emergency recovery from severe UI freeze."""
        try:
            if utils.DEBUG_UI:
                print("[WATCHDOG] Forcing emergency recovery...")

            # Stop all video operations
            if hasattr(self, 'video_manager') and self.video_manager.is_initialized():
                # Pause all players
                self.video_manager.pause_all()

                # Clear all pending operations
                self.video_manager.pending_seek_position = -1
                self.video_manager.players_awaiting_seek.clear()

            # Reset all timers to safe intervals
            if hasattr(self, 'position_update_timer'):
                self.position_update_timer.stop()
                self.position_update_timer.setInterval(500)  # Very conservative interval
                self.position_update_timer.start()

            if hasattr(self, 'timestamp_display_timer'):
                self.timestamp_display_timer.stop()
                self.timestamp_display_timer.setInterval(1000)  # Very conservative interval
                self.timestamp_display_timer.start()

            # Reset freeze detection
            self.ui_freeze_detected = False
            self.freeze_recovery_attempts = 0
            self.last_timer_heartbeat = time.time()

            if utils.DEBUG_UI:
                print("[WATCHDOG] Emergency recovery completed. Timers reset to safe intervals.")

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error in emergency recovery: {e}")

    def validate_manager_integration(self) -> Tuple[bool, List[str]]:
        """Validate integration between all managers."""
        try:
            errors = []

            # Check LayoutManager
            if not hasattr(self, 'layout_manager'):
                errors.append("LayoutManager not available")
            elif not self.layout_manager.is_initialized():
                errors.append("LayoutManager not initialized")

            # Check VideoPlaybackManager
            if not hasattr(self, 'video_manager'):
                errors.append("VideoPlaybackManager not available")
            elif not self.video_manager.is_initialized():
                errors.append("VideoPlaybackManager not initialized")

            # Check ExportManager
            if not hasattr(self, 'export_manager'):
                errors.append("ExportManager not available")
            elif not self.export_manager.is_initialized():
                errors.append("ExportManager not initialized")

            # Check state synchronization
            if (hasattr(self, 'layout_manager') and self.layout_manager.is_initialized() and
                hasattr(self, 'ordered_visible_player_indices')):
                layout_visible = self.layout_manager.get_visible_cameras()
                ui_visible = self.ordered_visible_player_indices
                if layout_visible != ui_visible:
                    errors.append(f"Layout state mismatch: LayoutManager={layout_visible}, UI={ui_visible}")

            return len(errors) == 0, errors

        except Exception as e:
            return False, [f"Validation error: {str(e)}"]