import os
import re
import subprocess
import traceback
import json
from datetime import datetime
from typing import Dict

from PyQt6.QtCore import QObject, pyqtSignal

from . import utils
from .state import TimelineData

class ExportWorker(QObject):
    finished = pyqtSignal(bool, str)
    progress = pyqtSignal(str)
    progress_value = pyqtSignal(int)

    def __init__(self, ffmpeg_cmd, duration_s, parent=None):
        super().__init__(parent)
        self.ffmpeg_cmd = ffmpeg_cmd
        self.duration_s = duration_s
        self._is_running = True
        self.proc = None

    def run(self):
        time_pattern = re.compile(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})")
        
        try:
            if utils.DEBUG_UI:
                print(f"--- Starting Export ---\nFFmpeg Command:\n{' '.join(self.ffmpeg_cmd)}\n-----------------------")
            
            self.progress.emit("Exporting clip... (0%)")
            
            creation_flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            self.proc = subprocess.Popen(
                self.ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                universal_newlines=True,
                creationflags=creation_flags
            )

            if self.proc.stdout:
                for line in self.proc.stdout:
                    if not self._is_running:
                        self.proc.terminate()
                        break
                    
                    match = time_pattern.search(line)
                    if match and self.duration_s > 0:
                        hours, minutes, seconds, hundredths = map(int, match.groups())
                        current_progress_s = (hours * 3600) + (minutes * 60) + seconds + (hundredths / 100)
                        percentage = max(0, min(100, int((current_progress_s / self.duration_s) * 100)))
                        self.progress_value.emit(percentage)
                        self.progress.emit(f"Exporting... ({percentage}%)")

                    if utils.DEBUG_UI:
                        print(f"[FFMPEG]: {line.strip()}")
            
            self.proc.wait()

            if not self._is_running:
                self.finished.emit(False, "Export was cancelled by the user.")
            elif self.proc.returncode == 0:
                self.progress_value.emit(100)
                self.progress.emit("Finalizing...")
                self.finished.emit(True, "Export completed successfully!")
            else:
                self.finished.emit(False, f"Export failed with return code {self.proc.returncode}.")
        
        except Exception as e:
            if self._is_running:
                self.finished.emit(False, f"An exception occurred during export: {e}\n{traceback.format_exc()}")
        
        finally:
            self._is_running = False

    def stop(self):
        self._is_running = False
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


class ClipLoaderWorker(QObject):
    """Worker to scan for and process video files asynchronously."""
    finished = pyqtSignal(TimelineData)
    progress = pyqtSignal(int, str)  # percentage, status_message

    def __init__(self, root_path, selected_date, camera_map, parent=None):
        super().__init__(parent)
        self.root_path = root_path
        self.selected_date = selected_date
        self.camera_map = camera_map
        self._is_running = True

    def run(self):
        try:
            self.progress.emit(0, "Initializing clip scan...")

            raw_files = {cam_idx: [] for cam_idx in range(len(self.camera_map))}
            all_ts = []
            events = []

            self.progress.emit(10, "Scanning for date folders...")
            potential_folders = [p for p in [os.path.join(self.root_path, d) for d in os.listdir(self.root_path)] if os.path.isdir(p) and os.path.basename(p).startswith(self.selected_date)]

            if not self._is_running: return
            if not potential_folders:
                self.finished.emit(TimelineData([], [], None, 0, f"No clip folders found for {self.selected_date}"))
                return

            self.progress.emit(20, f"Found {len(potential_folders)} folders, scanning files...")

            total_folders = len(potential_folders)
            for folder_idx, folder in enumerate(potential_folders):
                if not self._is_running: return

                folder_progress = 20 + (folder_idx / total_folders) * 60
                self.progress.emit(int(folder_progress), f"Scanning folder {os.path.basename(folder)}...")

                for filename in os.listdir(folder):
                    if not self._is_running: return
                        
                    m = utils.filename_pattern.match(filename)
                    if m:
                        try:
                            ts = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-',':')}", "%Y-%m-%d %H:%M:%S")
                            cam_idx = self.camera_map[m.group(3)]
                            raw_files[cam_idx].append((os.path.join(folder, filename), ts))
                            all_ts.append(ts)
                        except (ValueError, KeyError):
                            pass
                    elif filename == "event.json":
                        try:
                            with open(os.path.join(folder, filename), 'r') as f:
                                data = json.load(f)
                            data['timestamp_dt'] = datetime.fromisoformat(data['timestamp'])
                            data['folder_path'] = folder
                            events.append(data)
                        except (json.JSONDecodeError, KeyError, ValueError):
                            pass
            
            if not self._is_running: return
            if not all_ts:
                self.finished.emit(TimelineData([], [], None, 0, f"No valid video files found for {self.selected_date}."))
                return

            self.progress.emit(85, "Calculating timeline data...")
            first_ts, last_ts = min(all_ts), max(all_ts)
            last_clip_path = next((f[0] for files in raw_files.values() for f in files if f[1] == last_ts), None)
            
            total_duration = int((last_ts - first_ts).total_seconds() * 1000)
            if last_clip_path:
                 total_duration += utils.get_video_duration_ms(last_clip_path)

            for evt in events:
                evt['ms_in_timeline'] = (evt['timestamp_dt'] - first_ts).total_seconds() * 1000

            self.progress.emit(90, "Organizing clip collections...")
            final_clip_collections = [[] for _ in range(len(self.camera_map))]
            for i in range(len(self.camera_map)):
                raw_files[i].sort(key=lambda x: x[1])
                final_clip_collections[i] = [f[0] for f in raw_files[i]]

            if not self._is_running: return

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
        self._is_running = False


class TimestampCalculationWorker(QObject):
    """Worker to perform timestamp calculations asynchronously to prevent UI thread blocking."""
    timestamp_calculated = pyqtSignal(str)  # Emits formatted timestamp string

    def __init__(self, parent=None):
        super().__init__(parent)
        self._is_running = True
        self.pending_calculations = []

    def calculate_timestamp(self, global_position, current_pos, clip_duration, first_timestamp_of_day):
        """Queue a timestamp calculation."""
        if not self._is_running:
            return

        calculation_data = {
            'global_position': global_position,
            'current_pos': current_pos,
            'clip_duration': clip_duration,
            'first_timestamp_of_day': first_timestamp_of_day,
            'timestamp': time.time()
        }

        self.pending_calculations.append(calculation_data)

        # Process immediately if this is the only calculation
        if len(self.pending_calculations) == 1:
            self._process_calculation(calculation_data)

    def _process_calculation(self, data):
        """Process a single timestamp calculation."""
        try:
            from datetime import timedelta
            from . import utils

            global_time = data['first_timestamp_of_day'] + timedelta(milliseconds=data['global_position'])

            # Use optimized timestamp formatter
            timestamp = utils.timestamp_formatter.format_timestamp(global_time)

            # Pre-format clip times
            current_clip_time = utils.format_time(data['current_pos'])
            total_clip_time = utils.format_time(data['clip_duration'] if data['clip_duration'] > 0 else 0)

            # Create final display text
            display_text = f"{timestamp} (Clip: {current_clip_time} / {total_clip_time})"

            # Emit the result
            self.timestamp_calculated.emit(display_text)

        except Exception as e:
            if utils.DEBUG_UI:
                print(f"Error in timestamp calculation worker: {e}")
            # Emit a fallback timestamp
            self.timestamp_calculated.emit("--:--:-- (Clip: --:-- / --:--)")

        finally:
            # Remove processed calculation
            if self.pending_calculations:
                self.pending_calculations.pop(0)

            # Process next calculation if available
            if self.pending_calculations and self._is_running:
                self._process_calculation(self.pending_calculations[0])

    def stop(self):
        """Stop the worker and clear pending calculations."""
        self._is_running = False
        self.pending_calculations.clear()


class VideoOperationWorker(QObject):
    """Worker to perform video loading and seeking operations asynchronously to prevent UI blocking."""

    # Signals for different operations
    file_validated = pyqtSignal(str, bool)  # file_path, exists
    source_loaded = pyqtSignal(object, str)  # player, file_path
    position_set = pyqtSignal(object, int)  # player, position_ms
    operation_completed = pyqtSignal(str, bool, str)  # operation_id, success, error_msg

    def __init__(self, parent=None):
        super().__init__(parent)
        self._is_running = True
        self.pending_operations = []
        self._operation_counter = 0

    def validate_file_async(self, file_path: str):
        """Asynchronously validate if a file exists."""
        if not self._is_running:
            return

        operation_id = f"validate_{self._operation_counter}"
        self._operation_counter += 1

        # Queue the operation
        self.pending_operations.append({
            'type': 'validate_file',
            'id': operation_id,
            'file_path': file_path
        })

        # Process immediately if this is the only operation
        if len(self.pending_operations) == 1:
            self._process_next_operation()

    def load_source_async(self, player, file_path: str):
        """Asynchronously load a video source."""
        if not self._is_running:
            return

        operation_id = f"load_{self._operation_counter}"
        self._operation_counter += 1

        # Queue the operation
        self.pending_operations.append({
            'type': 'load_source',
            'id': operation_id,
            'player': player,
            'file_path': file_path
        })

        # Process immediately if this is the only operation
        if len(self.pending_operations) == 1:
            self._process_next_operation()

    def set_position_async(self, player, position_ms: int):
        """Asynchronously set player position."""
        if not self._is_running:
            return

        operation_id = f"seek_{self._operation_counter}"
        self._operation_counter += 1

        # Queue the operation
        self.pending_operations.append({
            'type': 'set_position',
            'id': operation_id,
            'player': player,
            'position_ms': position_ms
        })

        # Process immediately if this is the only operation
        if len(self.pending_operations) == 1:
            self._process_next_operation()

    def _process_next_operation(self):
        """Process the next queued operation."""
        if not self.pending_operations or not self._is_running:
            return

        operation = self.pending_operations[0]

        try:
            if operation['type'] == 'validate_file':
                self._validate_file(operation)
            elif operation['type'] == 'load_source':
                self._load_source(operation)
            elif operation['type'] == 'set_position':
                self._set_position(operation)

        except Exception as e:
            self.operation_completed.emit(operation['id'], False, str(e))

        finally:
            # Remove processed operation
            if self.pending_operations:
                self.pending_operations.pop(0)

            # Process next operation if available
            if self.pending_operations and self._is_running:
                # Use QTimer to avoid blocking
                from PyQt6.QtCore import QTimer
                QTimer.singleShot(1, self._process_next_operation)

    def _validate_file(self, operation):
        """Validate file existence."""
        import os
        file_path = operation['file_path']
        exists = os.path.exists(file_path)

        self.file_validated.emit(file_path, exists)
        self.operation_completed.emit(operation['id'], True, "")

    def _load_source(self, operation):
        """Load video source."""
        from PyQt6.QtCore import QUrl

        player = operation['player']
        file_path = operation['file_path']

        # This operation should be done on the main thread
        # Emit signal to trigger main thread operation
        self.source_loaded.emit(player, file_path)
        self.operation_completed.emit(operation['id'], True, "")

    def _set_position(self, operation):
        """Set player position."""
        player = operation['player']
        position_ms = operation['position_ms']

        # This operation should be done on the main thread
        # Emit signal to trigger main thread operation
        self.position_set.emit(player, position_ms)
        self.operation_completed.emit(operation['id'], True, "")

    def stop(self):
        """Stop the worker and clear pending operations."""
        self._is_running = False
        self.pending_operations.clear()


class RecentClipsLoaderWorker(QObject):
    """Worker to scan and process RecentClips files (flat structure, no date folders)."""
    finished = pyqtSignal(TimelineData)
    progress = pyqtSignal(int, str)  # percentage, status_message

    def __init__(self, root_path: str, camera_map: Dict[str, int], parent=None):
        super().__init__(parent)
        self.root_path = root_path
        self.camera_map = camera_map
        self._is_running = True

    def run(self):
        """Run the RecentClips loading process."""
        try:
            self.progress.emit(0, "Initializing RecentClips scan...")

            raw_files = {cam_idx: [] for cam_idx in range(len(self.camera_map))}
            all_ts = []
            events = []  # RecentClips typically have no events

            self.progress.emit(20, "Scanning RecentClips files...")

            if not self._is_running:
                return

            # Scan files directly in root folder (flat structure)
            total_files = 0
            processed_files = 0

            # Count total files first for progress tracking
            for filename in os.listdir(self.root_path):
                if utils.filename_pattern.match(filename):
                    total_files += 1

            if total_files == 0:
                self.finished.emit(TimelineData([], [], None, 0, "No video files found in RecentClips"))
                return

            self.progress.emit(30, f"Processing {total_files} RecentClips files...")

            for filename in os.listdir(self.root_path):
                if not self._is_running:
                    return

                # Process video files
                m = utils.filename_pattern.match(filename)
                if m:
                    try:
                        ts = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-',':')}", "%Y-%m-%d %H:%M:%S")
                        cam_idx = self.camera_map[m.group(3)]
                        file_path = os.path.join(self.root_path, filename)
                        raw_files[cam_idx].append((file_path, ts))
                        all_ts.append(ts)
                        processed_files += 1

                        # Update progress
                        progress = 30 + int((processed_files / total_files) * 50)
                        self.progress.emit(progress, f"Processed {processed_files}/{total_files} files...")

                    except (ValueError, KeyError):
                        pass

            if not self._is_running:
                return

            self.progress.emit(85, "Calculating timeline data...")

            # Calculate timeline data
            first_ts = min(all_ts) if all_ts else None
            last_ts = max(all_ts) if all_ts else None
            total_duration = 0

            if first_ts and last_ts:
                # Calculate accurate duration using actual video file duration (same as ClipLoaderWorker)
                time_span_ms = int((last_ts - first_ts).total_seconds() * 1000)

                # Find the last clip file to get its actual duration
                last_clip_path = None
                for files in raw_files.values():
                    for file_path, timestamp in files:
                        if timestamp == last_ts:
                            last_clip_path = file_path
                            break
                    if last_clip_path:
                        break

                total_duration = time_span_ms
                if last_clip_path:
                    # Add actual duration of the last clip for precise timeline
                    total_duration += utils.get_video_duration_ms(last_clip_path)

            self.progress.emit(90, "Organizing clip collections...")

            # Create final clip collections
            final_clip_collections = [[] for _ in range(len(self.camera_map))]
            for i in range(len(self.camera_map)):
                raw_files[i].sort(key=lambda x: x[1])
                final_clip_collections[i] = [f[0] for f in raw_files[i]]

            if not self._is_running:
                return

            self.progress.emit(100, "RecentClips loading completed")

            result = TimelineData(
                daily_clip_collections=final_clip_collections,
                events=events,  # Empty for RecentClips
                first_timestamp_of_day=first_ts,
                total_duration_ms=total_duration
            )
            self.finished.emit(result)

        except Exception as e:
            error_msg = f"Error loading RecentClips: {e}\n{traceback.format_exc()}"
            if self._is_running:
                self.finished.emit(TimelineData([], [], None, 0, error_msg))

    def stop(self):
        self._is_running = False