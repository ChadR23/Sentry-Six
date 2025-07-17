import os
import re
import subprocess
import traceback
import json
from datetime import datetime

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

    def __init__(self, root_path, selected_date, camera_map, parent=None):
        super().__init__(parent)
        self.root_path = root_path
        self.selected_date = selected_date
        self.camera_map = camera_map
        self._is_running = True

    def run(self):
        try:
            raw_files = {cam_idx: [] for cam_idx in range(len(self.camera_map))}
            all_ts = []
            events = []
            
            potential_folders = [p for p in [os.path.join(self.root_path, d) for d in os.listdir(self.root_path)] if os.path.isdir(p) and os.path.basename(p).startswith(self.selected_date)]
            
            if not self._is_running: return
            if not potential_folders:
                self.finished.emit(TimelineData([], [], None, 0, f"No clip folders found for {self.selected_date}"))
                return

            for folder in potential_folders:
                if not self._is_running: return
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

            first_ts, last_ts = min(all_ts), max(all_ts)
            last_clip_path = next((f[0] for files in raw_files.values() for f in files if f[1] == last_ts), None)
            
            total_duration = int((last_ts - first_ts).total_seconds() * 1000)
            if last_clip_path:
                 total_duration += utils.get_video_duration_ms(last_clip_path)

            for evt in events:
                evt['ms_in_timeline'] = (evt['timestamp_dt'] - first_ts).total_seconds() * 1000
            
            final_clip_collections = [[] for _ in range(len(self.camera_map))]
            for i in range(len(self.camera_map)):
                raw_files[i].sort(key=lambda x: x[1])
                final_clip_collections[i] = [f[0] for f in raw_files[i]]

            if not self._is_running: return
            
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