"""
Export Manager for SentrySix.

This module handles video export operations, progress tracking, and FFmpeg integration.
Extracted from TeslaCamViewer as part of the manager-based architecture refactoring.
"""

import os
from typing import Optional, List, Tuple
from datetime import datetime
from PyQt6.QtCore import QObject, pyqtSignal, QThread, QTimer, Qt
from PyQt6.QtWidgets import QProgressDialog, QMessageBox

from .base import BaseManager
from ..ffmpeg_builder import FFmpegCommandBuilder
from ..workers import ExportWorker
from .. import utils


class ExportManagerSignals(QObject):
    """Signals for ExportManager communication with UI."""

    # Export lifecycle signals
    export_started = pyqtSignal()
    export_progress = pyqtSignal(int, str)  # percentage, message
    export_finished = pyqtSignal(bool, str)  # success, message
    export_cancelled = pyqtSignal()

    # Export marker signals
    export_markers_changed = pyqtSignal(int, int)  # start_ms, end_ms
    start_marker_set = pyqtSignal(int)  # start_ms
    end_marker_set = pyqtSignal(int)  # end_ms

    # Error and status signals
    export_error = pyqtSignal(str)  # error_message
    export_validation_failed = pyqtSignal(str)  # validation_message


class ExportManager(BaseManager):
    """
    Manages video export operations and progress tracking.

    Handles:
    - Export state management (start_ms, end_ms markers)
    - FFmpeg command building and execution
    - Progress tracking and user feedback
    - Error recovery and cleanup
    - Worker thread management
    """

    def __init__(self, parent_widget, dependency_container):
        """Initialize the ExportManager."""
        super().__init__(parent_widget, dependency_container)

        # Initialize signals
        self.signals = ExportManagerSignals()

        # Export state management
        self.start_ms: Optional[int] = None
        self.end_ms: Optional[int] = None
        self.is_exporting: bool = False
        self.current_export_path: Optional[str] = None

        # Export worker management
        self.export_thread: Optional[QThread] = None
        self.export_worker: Optional[ExportWorker] = None
        self.temp_files: List[str] = []

        # Progress tracking
        self.progress_dialog: Optional[QProgressDialog] = None
        self.export_start_time: Optional[datetime] = None

        # Dependencies (will be set during initialization)
        self.app_state = None
        self.camera_map = None
        self.ffmpeg_exe = None

        self.logger.debug("ExportManager created")

    def initialize(self) -> bool:
        """
        Initialize export manager.

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

            self.camera_map = self.container.get_service('camera_map')

            # Verify FFmpeg availability
            from ..ffmpeg_manager import FFMPEG_EXE
            self.ffmpeg_exe = FFMPEG_EXE

            if not os.path.exists(self.ffmpeg_exe):
                self.logger.error(f"FFmpeg not found at {self.ffmpeg_exe}")
                return False

            # Initialize export state from app_state
            if hasattr(self.app_state, 'export_state'):
                self.start_ms = self.app_state.export_state.start_ms
                self.end_ms = self.app_state.export_state.end_ms

            self.logger.info("ExportManager initialized successfully")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "ExportManager initialization")
            return False

    def cleanup(self) -> None:
        """Clean up export resources."""
        try:
            self._mark_cleanup_started()

            # Stop any running export operations
            if self.is_exporting:
                self.cancel_export()

            # Clean up temporary files
            self._cleanup_temp_files()

            # Terminate worker threads
            if self.export_thread and self.export_thread.isRunning():
                if self.export_worker:
                    self.export_worker.stop()
                self.export_thread.quit()
                self.export_thread.wait(5000)  # Wait up to 5 seconds

            # Close progress dialog
            if self.progress_dialog:
                self.progress_dialog.close()
                self.progress_dialog = None

            # Reset export state
            self.is_exporting = False
            self.current_export_path = None
            self.export_thread = None
            self.export_worker = None

            self.logger.info("ExportManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "ExportManager cleanup")

    # ========================================
    # Export State Management (Week 4 Implementation)
    # ========================================

    def set_start_marker(self, position_ms: int) -> None:
        """Set export start position."""
        try:
            # Refresh app_state reference to ensure we have the latest instance
            if hasattr(self.parent_widget, 'app_state'):
                self.app_state = self.parent_widget.app_state

            if not self.app_state.is_daily_view_active:
                return

            self.start_ms = position_ms

            # Update app_state
            if hasattr(self.app_state, 'export_state'):
                self.app_state.export_state.start_ms = position_ms

            # Validate and adjust end marker if necessary
            if self.end_ms is not None and self.start_ms >= self.end_ms:
                self.end_ms = self.start_ms + 1000  # Add 1 second
                if hasattr(self.app_state, 'export_state'):
                    self.app_state.export_state.end_ms = self.end_ms

            # Emit signals
            self.signals.start_marker_set.emit(position_ms)
            if self.end_ms is not None:
                self.signals.export_markers_changed.emit(self.start_ms, self.end_ms)

            self.logger.debug(f"Export start marker set to {position_ms}ms")

        except Exception as e:
            self.handle_error(e, f"set_start_marker({position_ms})")

    def set_end_marker(self, position_ms: int) -> None:
        """Set export end position."""
        try:
            # Refresh app_state reference to ensure we have the latest instance
            if hasattr(self.parent_widget, 'app_state'):
                self.app_state = self.parent_widget.app_state

            if not self.app_state.is_daily_view_active:
                return

            self.end_ms = position_ms

            # Update app_state
            if hasattr(self.app_state, 'export_state'):
                self.app_state.export_state.end_ms = position_ms

            # Validate and adjust start marker if necessary
            if self.start_ms is not None and self.end_ms <= self.start_ms:
                self.start_ms = self.end_ms - 1000  # Subtract 1 second
                if hasattr(self.app_state, 'export_state'):
                    self.app_state.export_state.start_ms = self.start_ms

            # Emit signals
            self.signals.end_marker_set.emit(position_ms)
            if self.start_ms is not None:
                self.signals.export_markers_changed.emit(self.start_ms, self.end_ms)

            self.logger.debug(f"Export end marker set to {position_ms}ms")

        except Exception as e:
            self.handle_error(e, f"set_end_marker({position_ms})")

    def handle_marker_drag(self, marker_type: str, value: int) -> None:
        """Handle marker drag from UI."""
        try:
            if marker_type == 'start':
                self.set_start_marker(value)
            elif marker_type == 'end':
                self.set_end_marker(value)

        except Exception as e:
            self.handle_error(e, f"handle_marker_drag({marker_type}, {value})")

    def can_export(self) -> bool:
        """Check if export is possible with current settings."""
        try:
            # Check basic requirements
            if not self.app_state.is_daily_view_active:
                return False

            if not os.path.exists(self.ffmpeg_exe):
                return False

            if self.start_ms is None or self.end_ms is None:
                return False

            if self.start_ms >= self.end_ms:
                return False

            # Check if we're already exporting
            if self.is_exporting:
                return False

            return True

        except Exception as e:
            self.handle_error(e, "can_export")
            return False

    def validate_export_settings(self) -> Tuple[bool, str]:
        """
        Validate export settings and return validation result.

        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            if not os.path.exists(self.ffmpeg_exe):
                return False, "FFmpeg not found. Please ensure FFmpeg is installed."

            if not self.app_state.is_daily_view_active:
                return False, "Please load clips before exporting."

            if self.start_ms is None or self.end_ms is None:
                return False, "Please set both start and end time before exporting."

            if self.start_ms >= self.end_ms:
                return False, "Start time must be before end time."

            if self.is_exporting:
                return False, "Export already in progress."

            # Check if we have visible cameras
            if not hasattr(self.parent_widget, 'ordered_visible_player_indices'):
                return False, "No visible cameras configured."

            visible_indices = self.parent_widget.ordered_visible_player_indices
            if not visible_indices:
                return False, "No visible cameras selected."

            return True, ""

        except Exception as e:
            self.handle_error(e, "validate_export_settings")
            return False, f"Validation error: {str(e)}"

    def start_export(self, output_path: str, is_mobile: bool = False) -> bool:
        """
        Start export operation.

        Args:
            output_path: Path where to save the exported video
            is_mobile: Whether to use mobile-optimized settings

        Returns:
            bool: True if export started successfully
        """
        try:
            # Validate export settings
            is_valid, error_message = self.validate_export_settings()
            if not is_valid:
                self.signals.export_validation_failed.emit(error_message)
                return False

            # Pause playback if active
            if hasattr(self.parent_widget, 'pause_all'):
                self.parent_widget.pause_all()

            # Build FFmpeg command
            result = self._build_ffmpeg_command(output_path, is_mobile)
            if not result or not result[0]:
                error_msg = "Could not generate FFmpeg command. No visible cameras or clips found for the selected range."
                self.signals.export_error.emit(error_msg)
                return False

            ffmpeg_cmd, temp_files, duration_s = result
            self.temp_files = temp_files
            self.current_export_path = output_path

            # Set up progress dialog
            self._setup_progress_dialog()

            # Create and start export worker
            self._start_export_worker(ffmpeg_cmd, duration_s)

            # Update state
            self.is_exporting = True
            self.export_start_time = datetime.now()

            # Emit signal
            self.signals.export_started.emit()

            self.logger.info(f"Export started: {output_path} (mobile: {is_mobile})")
            return True

        except Exception as e:
            self.handle_error(e, f"start_export({output_path}, {is_mobile})")
            return False

    def cancel_export(self) -> None:
        """Cancel current export operation."""
        try:
            if not self.is_exporting:
                return

            # Stop the worker
            if self.export_worker:
                self.export_worker.stop()

            # Update state
            self.is_exporting = False

            # Close progress dialog
            if self.progress_dialog:
                self.progress_dialog.close()

            # Clean up
            self._cleanup_temp_files()

            # Emit signal
            self.signals.export_cancelled.emit()

            self.logger.info("Export cancelled by user")

        except Exception as e:
            self.handle_error(e, "cancel_export")

    def get_export_progress(self) -> Tuple[int, str]:
        """
        Get current export progress.

        Returns:
            Tuple of (percentage, status_message)
        """
        try:
            if not self.is_exporting:
                return (0, "No export in progress")

            if self.progress_dialog:
                percentage = self.progress_dialog.value()
                message = self.progress_dialog.labelText()
                return (percentage, message)

            return (0, "Export starting...")

        except Exception as e:
            self.handle_error(e, "get_export_progress")
            return (0, "Error getting progress")

    # ========================================
    # Helper Methods (Week 4 Implementation)
    # ========================================

    def _build_ffmpeg_command(self, output_path: str, is_mobile: bool) -> Tuple[List[str], List[str], float]:
        """Build FFmpeg command using FFmpegCommandBuilder."""
        try:
            builder = FFmpegCommandBuilder(
                app_state=self.app_state,
                ordered_visible_indices=self.parent_widget.ordered_visible_player_indices,
                camera_map=self.camera_map,
                is_mobile=is_mobile,
                output_path=output_path
            )

            return builder.build()

        except Exception as e:
            self.handle_error(e, f"_build_ffmpeg_command({output_path}, {is_mobile})")
            return None, [], 0.0

    def _setup_progress_dialog(self) -> None:
        """Set up the progress dialog for export."""
        try:
            self.progress_dialog = QProgressDialog(
                "Preparing export...",
                "Cancel",
                0,
                100,
                self.parent_widget
            )
            self.progress_dialog.setWindowModality(Qt.WindowModality.WindowModal)
            self.progress_dialog.setWindowTitle("Exporting")
            self.progress_dialog.show()

            # Connect cancel signal
            self.progress_dialog.canceled.connect(self.cancel_export)

        except Exception as e:
            self.handle_error(e, "_setup_progress_dialog")

    def _start_export_worker(self, ffmpeg_cmd: List[str], duration_s: float) -> None:
        """Start the export worker thread."""
        try:
            # Create worker and thread
            self.export_worker = ExportWorker(ffmpeg_cmd, duration_s)
            self.export_thread = QThread()
            self.export_worker.moveToThread(self.export_thread)

            # Connect signals
            self.export_thread.started.connect(self.export_worker.run)
            self.export_worker.finished.connect(self._on_export_finished)
            self.export_worker.progress.connect(self._on_export_progress)
            self.export_worker.progress_value.connect(self._on_export_progress_value)

            # Start the thread
            self.export_thread.start()

        except Exception as e:
            self.handle_error(e, "_start_export_worker")

    def _cleanup_temp_files(self) -> None:
        """Clean up temporary files created during export."""
        try:
            for file_path in self.temp_files:
                try:
                    if os.path.exists(file_path):
                        os.remove(file_path)
                        self.logger.debug(f"Removed temp file: {file_path}")
                except OSError as e:
                    self.logger.warning(f"Error removing temp file {file_path}: {e}")

            self.temp_files.clear()

        except Exception as e:
            self.handle_error(e, "_cleanup_temp_files")

    # ========================================
    # Signal Handlers (Week 4 Implementation)
    # ========================================

    def _on_export_finished(self, success: bool, message: str) -> None:
        """Handle export completion."""
        try:
            # Update progress dialog
            if self.progress_dialog:
                if success:
                    self.progress_dialog.setValue(100)
                self.progress_dialog.close()
                self.progress_dialog = None

            # Clean up thread
            if self.export_thread:
                self.export_thread.quit()
                self.export_thread.wait()
                self.export_thread = None

            # Clean up temp files
            self._cleanup_temp_files()

            # Update state
            self.is_exporting = False
            export_duration = None
            if self.export_start_time:
                export_duration = (datetime.now() - self.export_start_time).total_seconds()

            # Show result to user
            if success:
                QMessageBox.information(
                    self.parent_widget,
                    "Export Complete",
                    message
                )
            else:
                QMessageBox.critical(
                    self.parent_widget,
                    "Export Failed",
                    message
                )

            # Emit signal
            self.signals.export_finished.emit(success, message)

            # Log result
            if success:
                self.logger.info(f"Export completed successfully in {export_duration:.1f}s: {self.current_export_path}")
            else:
                self.logger.error(f"Export failed: {message}")

            # Reset state
            self.current_export_path = None
            self.export_start_time = None
            self.export_worker = None

        except Exception as e:
            self.handle_error(e, f"_on_export_finished({success}, {message})")

    def _on_export_progress(self, message: str) -> None:
        """Handle export progress message updates."""
        try:
            if self.progress_dialog:
                self.progress_dialog.setLabelText(message)

            # Emit signal
            percentage = self.progress_dialog.value() if self.progress_dialog else 0
            self.signals.export_progress.emit(percentage, message)

        except Exception as e:
            self.handle_error(e, f"_on_export_progress({message})")

    def _on_export_progress_value(self, percentage: int) -> None:
        """Handle export progress percentage updates."""
        try:
            if self.progress_dialog:
                self.progress_dialog.setValue(percentage)

            # Emit signal
            message = self.progress_dialog.labelText() if self.progress_dialog else ""
            self.signals.export_progress.emit(percentage, message)

        except Exception as e:
            self.handle_error(e, f"_on_export_progress_value({percentage})")

    # ========================================
    # Public API Methods (Week 4 Implementation)
    # ========================================

    def get_export_state(self) -> dict:
        """Get current export state information."""
        try:
            return {
                'start_ms': self.start_ms,
                'end_ms': self.end_ms,
                'is_exporting': self.is_exporting,
                'current_export_path': self.current_export_path,
                'can_export': self.can_export(),
                'export_duration_ms': (self.end_ms - self.start_ms) if (self.start_ms is not None and self.end_ms is not None) else None,
                'temp_files_count': len(self.temp_files)
            }

        except Exception as e:
            self.handle_error(e, "get_export_state")
            return {}

    def reset_export_markers(self) -> None:
        """Reset export start and end markers."""
        try:
            self.start_ms = None
            self.end_ms = None

            # Update app_state
            if hasattr(self.app_state, 'export_state'):
                self.app_state.export_state.start_ms = None
                self.app_state.export_state.end_ms = None

            # Emit signal
            self.signals.export_markers_changed.emit(-1, -1)  # -1 indicates cleared

            self.logger.debug("Export markers reset")

        except Exception as e:
            self.handle_error(e, "reset_export_markers")
