from PyQt6.QtWidgets import (QWidget, QVBoxLayout, QLabel, QPushButton, QFileDialog,
                             QGridLayout, QHBoxLayout, QInputDialog, QMessageBox,
                             QSlider, QComboBox, QRadioButton, QButtonGroup, QApplication,
                             QLineEdit, QDialog, QMenu, QSizePolicy,
                             QGraphicsView, QGraphicsScene, QCheckBox, QProgressDialog, QDialogButtonBox, 
                             QStyle, QStyleOptionSlider)
from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
from PyQt6.QtMultimediaWidgets import QGraphicsVideoItem
from PyQt6.QtCore import (Qt, QUrl, QTimer, QSettings, QByteArray, QPointF, QRectF, 
                          QSize, pyqtSignal, QMimeData, QPoint, QThread, QObject, QRect) 
from PyQt6.QtGui import (QIcon, QPixmap, QPainter, QMouseEvent, QWheelEvent, QAction, 
                         QDrag, QTransform, QColor, QPen, QPainterPath) 

import os
import json
import traceback
from datetime import datetime, timedelta
import re
import subprocess
import tempfile
import shutil
import math 

try:
    import __main__
    DEBUG_UI = __main__.DEBUG if hasattr(__main__, 'DEBUG') else False
except (ImportError, AttributeError):
    DEBUG_UI = False 

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(os.path.dirname(BASE_DIR), 'assets')


FFMPEG_PATH = "ffmpeg" 
FFPROBE_PATH = "ffprobe"
FFMPEG_FOUND = False

def find_ffmpeg():
    global FFMPEG_PATH, FFPROBE_PATH, FFMPEG_FOUND
    ffmpeg_exe = shutil.which("ffmpeg")
    if ffmpeg_exe: FFMPEG_PATH = ffmpeg_exe; FFMPEG_FOUND = True
    else: FFMPEG_FOUND = False
    
    ffprobe_exe = shutil.which("ffprobe")
    if not ffprobe_exe:
        if FFMPEG_FOUND:
            ffprobe_in_ffmpeg_dir = os.path.join(os.path.dirname(FFMPEG_PATH), "ffprobe.exe" if os.name == 'nt' else "ffprobe")
            if os.path.exists(ffprobe_in_ffmpeg_dir):
                ffprobe_exe = ffprobe_in_ffmpeg_dir
    
    FFPROBE_PATH = ffprobe_exe if ffprobe_exe else ""
    
    if DEBUG_UI: 
        print(f"FFmpeg found: {FFMPEG_FOUND} at {FFMPEG_PATH if FFMPEG_FOUND else 'N/A'}")
        print(f"FFprobe found: {bool(FFPROBE_PATH)} at {FFPROBE_PATH if FFPROBE_PATH else 'N/A'}")
    return FFMPEG_FOUND

FFMPEG_FOUND = find_ffmpeg()

def get_video_duration_ms(video_path):
    if not FFPROBE_PATH: return 60000
    try:
        cmd = [ FFPROBE_PATH, "-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video_path ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        stdout, _ = proc.communicate(timeout=5)
        if proc.returncode == 0 and stdout: return int(float(stdout.strip()) * 1000)
        else: return 60000
    except Exception: return 60000

class ExportWorker(QObject):
    finished = pyqtSignal(bool, str); progress = pyqtSignal(str)
    def __init__(self, ffmpeg_cmd, parent=None):
        super().__init__(parent); self.ffmpeg_cmd = ffmpeg_cmd; self._is_running = True
    def run(self):
        try:
            if DEBUG_UI: print(f"--- Starting Export ---\nFFmpeg Command:\n{' '.join(self.ffmpeg_cmd)}\n-----------------------")
            self.progress.emit("Exporting clip... This may take a while.")
            self.proc = subprocess.Popen(self.ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            for line in self.proc.stdout:
                if not self._is_running: self.proc.terminate(); break
                if DEBUG_UI: print(f"[FFMPEG]: {line.strip()}")
            self.proc.wait()
            if not self._is_running: self.finished.emit(False, "Export was cancelled by the user.")
            elif self.proc.returncode == 0: self.finished.emit(True, "Export completed successfully!")
            else: self.finished.emit(False, f"Export failed with return code {self.proc.returncode}.")
        except Exception as e: self.finished.emit(False, f"An exception occurred during export: {e}\n{traceback.format_exc()}")
        finally: self._is_running = False
    def stop(self):
        self._is_running = False
        if hasattr(self, 'proc') and self.proc.poll() is None: self.proc.terminate()

class ExportScrubber(QSlider):
    export_marker_moved = pyqtSignal(str, int); event_marker_clicked = pyqtSignal(object)
    event_marker_hovered = pyqtSignal(object, QPoint)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs); self.start_ms, self.end_ms, self.dragging_marker = None, None, None
        self.events = []; self.setMouseTracking(True)
        self.icon_camera = QPixmap(os.path.join(ASSETS_DIR, "camera.svg"))
        self.icon_hand = QPixmap(os.path.join(ASSETS_DIR, "hand.svg"))
        self.icon_horn = QPixmap(os.path.join(ASSETS_DIR, "horn.svg"))
        self.hovered_event = None

    def set_export_range(self, start_ms, end_ms): self.start_ms, self.end_ms = start_ms, end_ms; self.update()
    def set_events(self, events): self.events = events; self.update()
    
    def _value_to_pixel(self, value):
        return QStyle.sliderPositionFromValue(self.minimum(), self.maximum(), int(value), self.width())

    def _pixel_to_value(self, pixel):
        return QStyle.sliderValueFromPosition(self.minimum(), self.maximum(), pixel, self.width())

    def get_style_option(self): opt = QStyleOptionSlider(); self.initStyleOption(opt); return opt

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        groove_rect = self.style().subControlRect(QStyle.ComplexControl.CC_Slider, self.get_style_option(), QStyle.SubControl.SC_SliderGroove, self)
        
        if self.start_ms is not None and self.end_ms is not None:
            start_px, end_px = self._value_to_pixel(self.start_ms), self._value_to_pixel(self.end_ms)
            painter.setBrush(QColor(97, 175, 239, 70)); painter.setPen(Qt.PenStyle.NoPen)
            painter.drawRect(QRect(QPoint(start_px, groove_rect.y()), QPoint(end_px, groove_rect.y() + groove_rect.height())))
            painter.setPen(QPen(QColor(30, 220, 100), 2)); painter.drawLine(start_px, 0, start_px, self.height())
            painter.setPen(QPen(QColor(220, 50, 50), 2)); painter.drawLine(end_px, 0, end_px, self.height())

        for evt in self.events:
            event_pixel = self._value_to_pixel(evt['ms_in_timeline'])
            if 'sentry' in evt['reason']: icon = self.icon_camera
            elif 'user_interaction' in evt['reason']: icon = self.icon_hand
            elif 'honk' in evt['reason']: icon = self.icon_horn
            else: continue
            
            icon_y = groove_rect.center().y() - icon.height() // 2
            
            # --- FIX: Clamp the icon's draw position to keep it inside the slider bounds ---
            ideal_x = event_pixel - icon.width() // 2
            draw_x = max(0, min(ideal_x, self.width() - icon.width()))
            
            painter.drawPixmap(draw_x, icon_y, icon)

    def mousePressEvent(self, event: QMouseEvent):
        pos_x = event.pos().x()
        for evt in self.events:
            event_pixel = self._value_to_pixel(evt['ms_in_timeline'])
            if abs(pos_x - event_pixel) < 10:
                self.event_marker_clicked.emit(evt); return

        if self.start_ms is not None and self.end_ms is not None:
            start_px, end_px = self._value_to_pixel(self.start_ms), self._value_to_pixel(self.end_ms)
            if abs(pos_x - start_px) < 10: self.dragging_marker = 'start'; self.setSliderDown(True); return
            if abs(pos_x - end_px) < 10: self.dragging_marker = 'end'; self.setSliderDown(True); return
        
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent):
        if self.dragging_marker:
            new_value = self._pixel_to_value(event.pos().x())
            if self.dragging_marker == 'start' and new_value < self.end_ms: self.export_marker_moved.emit('start', new_value)
            elif self.dragging_marker == 'end' and new_value > self.start_ms: self.export_marker_moved.emit('end', new_value)
            return
        
        current_hover = None
        for evt in self.events:
            event_pixel = self._value_to_pixel(evt['ms_in_timeline'])
            if abs(event.pos().x() - event_pixel) < 10: current_hover = evt; break
        
        if self.hovered_event != current_hover:
            self.hovered_event = current_hover
            self.event_marker_hovered.emit(self.hovered_event, self.mapToGlobal(event.pos()))
        
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent):
        if self.dragging_marker: self.dragging_marker = None; self.setSliderDown(False)
        else: super().mouseReleaseEvent(event)

class EventToolTip(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent, Qt.WindowType.ToolTip | Qt.WindowType.FramelessWindowHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        layout = QVBoxLayout(self); layout.setContentsMargins(10, 10, 10, 10)
        self.thumbnail_label = QLabel(); self.thumbnail_label.setFixedSize(192, 108); self.thumbnail_label.setStyleSheet("border: 1px solid #444; background-color: #222;")
        self.reason_label = QLabel(); self.reason_label.setStyleSheet("background-color: #282c34; padding: 4px; border-radius: 3px;")
        layout.addWidget(self.thumbnail_label); layout.addWidget(self.reason_label)
    def update_content(self, reason_text, pixmap):
        self.reason_label.setText(reason_text.replace("_", " ").title())
        if pixmap and not pixmap.isNull():
            self.thumbnail_label.setPixmap(pixmap.scaled(self.thumbnail_label.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        else: self.thumbnail_label.setText("  No Preview Available")

class VideoPlayerItemWidget(QGraphicsView):
    def __init__(self, player_index: int, media_player: QMediaPlayer, parent=None):
        super().__init__(parent); self.player_index = player_index; self.media_player = media_player
        self.scene = QGraphicsScene(self); self.video_item = QGraphicsVideoItem()
        self.scene.addItem(self.video_item); self.setScene(self.scene); self.media_player.setVideoOutput(self.video_item)
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True); self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag); self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter); self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff); self.setMinimumSize(100,75)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding); self.setObjectName(f"VideoPlayerItemWidget_{player_index}")
    def fit_video_to_view(self):
        if not self.video_item.nativeSize().isEmpty(): self.fitInView(self.video_item, Qt.AspectRatioMode.KeepAspectRatio)
    def wheelEvent(self, event: QWheelEvent):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        if self.transform().m11() * factor < 1.0: self.reset_view()
        elif self.transform().m11() * factor > 7.0: return
        else: self.scale(factor, factor)
        event.accept()
    def reset_view(self): self.setTransform(QTransform()); self.fit_video_to_view()
    def resizeEvent(self, event): super().resizeEvent(event); self.fit_video_to_view()

class TeslaCamViewer(QWidget):
    # ... (Rest of the class is unchanged)
    def __init__(self):
        super().__init__(); self.settings = QSettings() 
        self.camera_name_to_index = {"front":0,"left_repeater":1,"right_repeater":2,"back":3,"left_pillar":4,"right_pillar":5}
        self.camera_index_to_name = {v:k for k,v in self.camera_name_to_index.items()}
        self.filename_pattern = re.compile(r"(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(front|left_repeater|right_repeater|back|left_pillar|right_pillar)\.mp4")
        
        self.setWindowTitle("TeslaCam Viewer"); self.setMinimumSize(1280,720); self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.layout = QVBoxLayout(self); self.layout.setSpacing(8); self.layout.setContentsMargins(8,8,8,8)

        top_controls_layout = QHBoxLayout()
        self.select_folder_btn = QPushButton("📂 Select Clips"); self.select_folder_btn.clicked.connect(self.select_root_folder); top_controls_layout.addWidget(self.select_folder_btn)
        self.go_to_time_btn = QPushButton("⏰ Go to Time"); self.go_to_time_btn.clicked.connect(self.show_go_to_time_dialog); top_controls_layout.addWidget(self.go_to_time_btn)
        self.reset_layout_btn = QPushButton("🔄 Reset Layout"); self.reset_layout_btn.clicked.connect(self.reset_to_default_layout); top_controls_layout.addWidget(self.reset_layout_btn)
        top_controls_layout.addSpacing(15); self.date_selector_label = QLabel("Date:")
        self.date_selector = QComboBox(); self.date_selector.setEnabled(False); self.date_selector.currentIndexChanged.connect(self.handle_date_selection_change)
        top_controls_layout.addWidget(self.date_selector_label); top_controls_layout.addWidget(self.date_selector); top_controls_layout.addSpacing(25)
        self.camera_visibility_checkboxes, self.checkbox_info = [], [
            ("LP", "Left Pillar", self.camera_name_to_index["left_pillar"]),("F", "Front", self.camera_name_to_index["front"]),
            ("RP", "Right Pillar", self.camera_name_to_index["right_pillar"]),("LR", "Left Repeater", self.camera_name_to_index["left_repeater"]),
            ("B", "Back", self.camera_name_to_index["back"]),("RR", "Right Repeater", self.camera_name_to_index["right_repeater"]),
        ]
        for abbr, full_name, _ in self.checkbox_info:
            cb = QCheckBox(abbr); cb.setToolTip(full_name); cb.setChecked(True); cb.toggled.connect(self.update_layout_from_visibility_change)
            self.camera_visibility_checkboxes.append(cb); top_controls_layout.addWidget(cb)
        top_controls_layout.addStretch(1); self.layout.addLayout(top_controls_layout)

        self.video_grid_widget = QWidget(self); self.video_grid = QGridLayout(self.video_grid_widget); self.video_grid.setSpacing(3)
        self.layout.addWidget(self.video_grid_widget, 1)
        self.players, self.video_player_item_widgets, self.sources = [], [], [None]*6
        for i in range(6):
            player = QMediaPlayer(); player.setAudioOutput(QAudioOutput()); player.mediaStatusChanged.connect(lambda s,p=player: self.handle_media_status_changed(s,p,self.players.index(p)))
            self.players.append(player); self.video_player_item_widgets.append(VideoPlayerItemWidget(i, player, self.video_grid_widget))

        control_layout = QHBoxLayout(); control_layout.setSpacing(8); control_layout.addStretch()
        self.skip_bwd_15_btn=QPushButton("« 15s"); self.skip_bwd_15_btn.clicked.connect(lambda: self.seek_all_global(self.scrubber.value()-15000))
        self.frame_back_btn=QPushButton("⏪ FR"); self.frame_back_btn.clicked.connect(lambda: self.frame_action(-33))
        self.play_btn=QPushButton("▶️ Play"); self.play_btn.clicked.connect(self.toggle_play_pause_all)
        self.frame_forward_btn=QPushButton("FR ⏩"); self.frame_forward_btn.clicked.connect(lambda: self.frame_action(33))
        self.skip_fwd_15_btn=QPushButton("15s »"); self.skip_fwd_15_btn.clicked.connect(lambda: self.seek_all_global(self.scrubber.value()+15000))
        for btn in [self.skip_bwd_15_btn,self.frame_back_btn,self.play_btn,self.frame_forward_btn,self.skip_fwd_15_btn]: control_layout.addWidget(btn)
        control_layout.addSpacing(20)
        self.mark_start_btn = QPushButton("Set Start"); self.mark_start_btn.clicked.connect(self.mark_start_time); control_layout.addWidget(self.mark_start_btn)
        self.start_time_label = QLabel("Start: --:--"); control_layout.addWidget(self.start_time_label)
        self.mark_end_btn = QPushButton("Set End"); self.mark_end_btn.clicked.connect(self.mark_end_time); control_layout.addWidget(self.mark_end_btn)
        self.end_time_label = QLabel("End: --:--"); control_layout.addWidget(self.end_time_label)
        self.export_btn = QPushButton("Export Clip"); self.export_btn.clicked.connect(self.show_export_dialog); control_layout.addWidget(self.export_btn)
        control_layout.addSpacing(20); speed_label=QLabel("Speed:")
        self.speed_selector=QComboBox(); self.playback_rates={"0.25x":0.25,"0.5x":0.5,"1x":1.0,"1.5x":1.5,"2x":2.0,"4x":4.0}
        self.speed_selector.addItems(self.playback_rates.keys()); self.speed_selector.currentTextChanged.connect(self.set_playback_speed)
        control_layout.addWidget(speed_label); control_layout.addWidget(self.speed_selector)
        control_layout.addStretch(); self.layout.addLayout(control_layout)

        self.slider_layout = QHBoxLayout(); self.time_label = QLabel("YYYY-MM-DD HH:MM:SS (Clip: 00:00 / 00:00)")
        self.scrubber = ExportScrubber(Qt.Orientation.Horizontal)
        self.scrubber.setRange(0,1000); self.scrubber.sliderReleased.connect(self.handle_scrubber_release); self.scrubber.setTracking(True)
        self.scrubber.export_marker_moved.connect(self.handle_marker_drag); self.scrubber.event_marker_clicked.connect(self.handle_event_click)
        self.scrubber.event_marker_hovered.connect(self.handle_event_hover)
        self.slider_layout.addWidget(self.time_label); self.slider_layout.addWidget(self.scrubber,1); self.layout.addLayout(self.slider_layout); self.setLayout(self.layout)
        
        self.position_update_timer = QTimer(self); self.position_update_timer.setInterval(100); self.position_update_timer.timeout.connect(self.update_slider_and_time_display)
        self.sync_timer=QTimer(); self.sync_timer.timeout.connect(self.sync_playback); self.sync_timer.start(1000)
        self.daily_clip_collections=[[] for _ in range(6)]; self.current_clip_indices=[-1]*6; self.export_start_ms = None; self.export_end_ms = None
        self.root_clips_path=None; self.current_segment_start_datetime=None; self.first_timestamp_of_day=None
        self.is_daily_view_active=False; self.temp_thumbnail_file=None; self.go_to_time_dialog_instance=None
        self.event_tooltip = EventToolTip(self); self.tooltip_timer = QTimer(self); self.tooltip_timer.setSingleShot(True)
        self.export_thread = None; self.export_worker = None; self.files_to_cleanup_after_export = []
        
        self.load_settings(); self.update_layout()

    def reset_to_default_layout(self):
        for checkbox in self.camera_visibility_checkboxes:
            checkbox.blockSignals(True); checkbox.setChecked(True); checkbox.blockSignals(False)
        self.update_layout_from_visibility_change()

    def update_layout_from_visibility_change(self):
        self.ordered_visible_player_indices = [self.checkbox_info[i][2] for i, cb in enumerate(self.camera_visibility_checkboxes) if cb.isChecked()]
        if DEBUG_UI: print(f"Visibility change. New order: {self.ordered_visible_player_indices}")
        self.update_layout(); self.save_settings()

    def load_settings(self):
        geom = self.settings.value("windowGeometry"); self.restoreGeometry(geom) if geom else self.setGeometry(50, 50, 1600, 950)
        self.speed_selector.setCurrentText(self.settings.value("lastSpeedText", "1x", type=str))
        vis_states = self.settings.value("cameraVisibility");
        if vis_states and len(vis_states) == len(self.camera_visibility_checkboxes):
            for i, cb in enumerate(self.camera_visibility_checkboxes): cb.setChecked(vis_states[i] == 'true')
        self.update_layout_from_visibility_change()
        last_folder = self.settings.value("lastRootFolder", "", type=str)
        if last_folder and os.path.isdir(last_folder):
            self.root_clips_path = last_folder; self.repopulate_date_selector_from_path(last_folder); self.date_selector.setCurrentIndex(-1)
        if not self.is_daily_view_active: self.clear_all_players()

    def save_settings(self):
        self.settings.setValue("windowGeometry", self.saveGeometry()); self.settings.setValue("lastRootFolder", self.root_clips_path or "")
        self.settings.setValue("lastSpeedText", self.speed_selector.currentText()); self.settings.setValue("cameraVisibility", [str(cb.isChecked()).lower() for cb in self.camera_visibility_checkboxes])

    def closeEvent(self, event): 
        self.save_settings()
        if self.temp_thumbnail_file and os.path.exists(self.temp_thumbnail_file):
            try: os.remove(self.temp_thumbnail_file)
            except: pass
        if self.export_thread and self.export_thread.isRunning():
            self.export_worker.stop(); self.export_thread.quit(); self.export_thread.wait()
        for p in self.players: p.setSource(QUrl())
        super().closeEvent(event)

    def load_selected_date_videos(self):
        selected_date_str = self.date_selector.currentText()
        if not self.root_clips_path or not selected_date_str: return
        self.clear_all_players(); self.is_daily_view_active = True;
        raw_files = {cam_idx: [] for cam_idx in range(6)}; all_ts = []; events = []
        try:
            potential_folders = [p for p in [os.path.join(self.root_clips_path, d) for d in os.listdir(self.root_clips_path)] if os.path.isdir(p) and os.path.basename(p).startswith(selected_date_str)]
            if not potential_folders: QMessageBox.warning(self, "No Data", f"No folders found for {selected_date_str}"); self.clear_all_players(); return
            
            for folder in potential_folders:
                for filename in os.listdir(folder):
                    m = self.filename_pattern.match(filename)
                    if m:
                        try:
                            ts = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-',':')}", "%Y-%m-%d %H:%M:%S")
                            cam_idx = self.camera_name_to_index[m.group(3)]; raw_files[cam_idx].append((os.path.join(folder, filename), ts)); all_ts.append(ts)
                        except (ValueError, KeyError): pass
                    elif filename == "event.json":
                        try:
                            with open(os.path.join(folder, filename), 'r') as f: data = json.load(f)
                            data['timestamp_dt'] = datetime.fromisoformat(data['timestamp'])
                            data['folder_path'] = folder
                            events.append(data)
                        except (json.JSONDecodeError, KeyError, ValueError): pass

            if not all_ts: QMessageBox.warning(self, "No Videos", f"No valid video files found for {selected_date_str}."); self.clear_all_players(); return
            
            self.first_timestamp_of_day, last_ts = min(all_ts), max(all_ts)
            last_clip_path = next((f[0] for files in raw_files.values() for f in files if f[1] == last_ts), None)
            total_duration = int((last_ts - self.first_timestamp_of_day).total_seconds() * 1000) + get_video_duration_ms(last_clip_path)
            self.scrubber.setRange(0, total_duration)
            
            for evt in events: evt['ms_in_timeline'] = (evt['timestamp_dt'] - self.first_timestamp_of_day).total_seconds() * 1000
            self.scrubber.set_events(events)

            for i in range(6):
                raw_files[i].sort(key=lambda x: x[1]); self.daily_clip_collections[i] = [f[0] for f in raw_files[i]]
                if self.daily_clip_collections[i]: self.load_next_clip_for_player(i, True)
            self.update_layout()
        except Exception as e: QMessageBox.critical(self, "Error", f"Error loading date videos: {e}"); traceback.print_exc(); self.clear_all_players()

    def handle_date_selection_change(self):
        if self.date_selector.currentIndex() >= 0: self.load_selected_date_videos()
        else: self.clear_all_players()

    def select_root_folder(self): 
        folder = QFileDialog.getExistingDirectory(self, "Select Clips Root", self.root_clips_path or os.path.expanduser("~"))
        if folder and os.path.isdir(folder):
            self.root_clips_path=folder; self.clear_all_players()
            if not self.repopulate_date_selector_from_path(folder): QMessageBox.information(self,"No Dates","No date folders found.")
            else: self.date_selector.setCurrentIndex(-1)

    def repopulate_date_selector_from_path(self, folder_path):
        self.date_selector.blockSignals(True); self.date_selector.clear(); self.date_selector.setEnabled(False)
        dates = sorted({m.group(1) for item in os.listdir(folder_path) if os.path.isdir(os.path.join(folder_path, item)) and (m := re.match(r"^(\d{4}-\d{2}-\d{2})", item))}, reverse=True)
        if dates: self.date_selector.addItems(dates); self.date_selector.setEnabled(True)
        self.date_selector.blockSignals(False); return bool(dates)

    def generate_and_set_thumbnail(self, video_path, timestamp_seconds):
        if not FFMPEG_FOUND or not self.go_to_time_dialog_instance: return
        
        temp_fd, temp_file_path = tempfile.mkstemp(suffix=".jpg"); os.close(temp_fd)
        try:
            cmd = [FFMPEG_PATH, "-y", "-ss", str(timestamp_seconds), "-i", video_path, "-vframes", "1", "-vf", "scale=192:-1", "-q:v", "3", temp_file_path]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            
            pixmap = QPixmap(temp_file_path) if os.path.exists(temp_file_path) else QPixmap()
            if self.go_to_time_dialog_instance: self.go_to_time_dialog_instance.set_thumbnail(pixmap)
            
        except Exception:
            if DEBUG_UI: traceback.print_exc()
            if self.go_to_time_dialog_instance: self.go_to_time_dialog_instance.set_thumbnail(QPixmap())
        finally:
            if os.path.exists(temp_file_path): os.remove(temp_file_path)
            
    def show_go_to_time_dialog(self):
        if not self.is_daily_view_active:
            QMessageBox.warning(self, "Action Required", "Please load a date before using 'Go to Time'."); return
        current_date = self.date_selector.currentText()
        self.go_to_time_dialog_instance = GoToTimeDialog(self, current_date, self.first_timestamp_of_day, self.daily_clip_collections, self.camera_name_to_index["front"])
        self.go_to_time_dialog_instance.request_thumbnail.connect(self.generate_and_set_thumbnail)
        if self.go_to_time_dialog_instance.exec():
            time_str = self.go_to_time_dialog_instance.get_time_string().strip()
            if not time_str: return
            try: target_dt = datetime.strptime(f"{current_date} {time_str}", "%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError): QMessageBox.warning(self,"Invalid Time","Please use HH:MM:SS format."); return
            if self.first_timestamp_of_day:
                global_ms = (target_dt - self.first_timestamp_of_day).total_seconds()*1000
                if 0 <= global_ms <= self.scrubber.maximum(): self.seek_all_global(int(global_ms))
                else: QMessageBox.information(self,"Out of Range","The specified time is outside the range of the current day's clips.")
        self.go_to_time_dialog_instance = None
    
    def toggle_play_pause_all(self):
        if any(p.playbackState() == QMediaPlayer.PlaybackState.PlayingState for p in self.players): self.pause_all()
        else: self.play_all()

    def play_all(self): 
        self.play_btn.setText("⏸️ Pause"); rate = self.playback_rates.get(self.speed_selector.currentText(), 1.0)
        any_playing = False
        for i, p in enumerate(self.players):
            if i in self.ordered_visible_player_indices and p.source() and p.source().isValid():
                p.setPlaybackRate(rate); p.play(); any_playing = True
        if any_playing: self.position_update_timer.start()

    def pause_all(self): 
        self.play_btn.setText("▶️ Play"); [p.pause() for p in self.players]; self.position_update_timer.stop(); self.update_slider_and_time_display()
    
    def frame_action(self, offset_ms): 
        self.pause_all(); [p.setPosition(p.position() + offset_ms) for p in self.players if p.source() and p.source().isValid()]; self.update_slider_and_time_display()

    def handle_scrubber_release(self): 
        if self.is_daily_view_active: self.seek_all_global(self.scrubber.value())

    def seek_all_global(self, global_ms):
        if not self.is_daily_view_active or not self.first_timestamp_of_day: return
        target_dt = self.first_timestamp_of_day + timedelta(milliseconds=max(0, global_ms))
        front_clips = self.daily_clip_collections[self.camera_name_to_index["front"]]
        if not front_clips: return
        
        target_seg_idx = -1
        for i, p in enumerate(front_clips):
            m = self.filename_pattern.match(os.path.basename(p))
            if m:
                s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
                if s_dt <= target_dt < s_dt + timedelta(seconds=60):
                    target_seg_idx = i; break
        if target_seg_idx == -1 and target_dt >= self.first_timestamp_of_day: target_seg_idx = len(front_clips) - 1
        if target_seg_idx == -1: return
        
        m = self.filename_pattern.match(os.path.basename(front_clips[target_seg_idx])); s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
        pos_in_seg_ms = int((target_dt - s_dt).total_seconds() * 1000)
        
        was_playing = self.play_btn.text() == "⏸️ Pause"; self.pause_all()
        if target_seg_idx == self.current_clip_indices[self.camera_name_to_index["front"]]:
            for p in self.players: p.setPosition(pos_in_seg_ms)
            if was_playing: self.play_all()
        else:
            for i in range(6): self.load_next_clip_for_player(i, False, target_seg_idx)
            def apply_pos():
                for p in self.players: p.setPosition(pos_in_seg_ms)
                if was_playing: self.play_all()
            QTimer.singleShot(350, apply_pos)

    def mark_start_time(self):
        if not self.is_daily_view_active: return
        self.export_start_ms = self.scrubber.value()
        if self.export_end_ms is not None and self.export_start_ms >= self.export_end_ms:
            self.export_end_ms = self.export_start_ms + 1000 
        self.update_export_ui()

    def mark_end_time(self):
        if not self.is_daily_view_active: return
        self.export_end_ms = self.scrubber.value()
        if self.export_start_ms is not None and self.export_end_ms <= self.export_start_ms:
            self.export_start_ms = self.export_end_ms - 1000
        self.update_export_ui()

    def handle_marker_drag(self, marker_type, value):
        if marker_type == 'start': self.export_start_ms = value
        elif marker_type == 'end': self.export_end_ms = value
        self.update_export_ui(); self.seek_all_global(value)

    def handle_event_click(self, event_data):
        seek_ms = event_data['ms_in_timeline']
        if 'sentry' in event_data['reason'] or 'user_interaction' in event_data['reason']:
            seek_ms -= 10000 
        self.seek_all_global(max(0, seek_ms))

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
        self.start_time_label.setText(f"Start: {self.format_time(self.export_start_ms)}")
        self.end_time_label.setText(f"End: {self.format_time(self.export_end_ms)}")
        self.scrubber.set_export_range(self.export_start_ms, self.export_end_ms)

    def show_export_dialog(self):
        if not all([FFMPEG_FOUND, self.is_daily_view_active, self.export_start_ms is not None, self.export_end_ms is not None]):
            QMessageBox.warning(self, "Export Error", "Please load clips and set both a start and end time before exporting."); return
        dialog = QDialog(self); dialog.setWindowTitle("Export Options"); layout = QVBoxLayout(dialog)
        layout.addWidget(QLabel("Select export quality:")); full_res_rb = QRadioButton("Full Resolution"); mobile_rb = QRadioButton("Mobile Friendly - 1080p")
        full_res_rb.setChecked(True); layout.addWidget(full_res_rb); layout.addWidget(mobile_rb)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel); buttons.accepted.connect(dialog.accept); buttons.rejected.connect(dialog.reject); layout.addWidget(buttons)
        if dialog.exec():
            output_path, _ = QFileDialog.getSaveFileName(self, "Save Exported Clip", f"{self.date_selector.currentText()}_clip.mp4", "MP4 Videos (*.mp4)")
            if output_path: self.start_export(output_path, mobile_rb.isChecked())

    def start_export(self, output_path, is_mobile):
        self.pause_all()
        result = self._build_ffmpeg_command(output_path, is_mobile)
        if not result:
            QMessageBox.critical(self, "Export Failed", "Could not generate FFmpeg command. No visible cameras or clips found for the selected range."); return
        
        ffmpeg_cmd, self.files_to_cleanup_after_export = result
        self.progress_dialog = QProgressDialog("Preparing export...", "Cancel", 0, 0, self); self.progress_dialog.setWindowModality(Qt.WindowModality.WindowModal); self.progress_dialog.setWindowTitle("Exporting"); self.progress_dialog.show()
        
        self.export_worker = ExportWorker(ffmpeg_cmd); self.export_thread = QThread(); self.export_worker.moveToThread(self.export_thread)
        self.export_thread.started.connect(self.export_worker.run); self.export_worker.finished.connect(self.on_export_finished)
        self.export_worker.progress.connect(self.progress_dialog.setLabelText); self.progress_dialog.canceled.connect(self.export_worker.stop)
        self.export_thread.start()

    def on_export_finished(self, success, message):
        self.progress_dialog.close()
        if self.export_thread: self.export_thread.quit(); self.export_thread.wait()
        if success: QMessageBox.information(self, "Export Complete", message)
        else: QMessageBox.critical(self, "Export Failed", message)
        for path in self.files_to_cleanup_after_export:
            try: os.remove(path)
            except OSError as e: print(f"Error removing temp file {path}: {e}")
        self.files_to_cleanup_after_export.clear()
        self.export_thread, self.export_worker = None, None

    def _build_ffmpeg_command(self, output_path, is_mobile):
        start_dt = self.first_timestamp_of_day + timedelta(milliseconds=self.export_start_ms)
        end_dt = self.first_timestamp_of_day + timedelta(milliseconds=self.export_end_ms)
        duration = (self.export_end_ms - self.export_start_ms) / 1000.0
        
        inputs, temp_files = [], []
        front_cam_idx = self.camera_name_to_index["front"]
        
        for p_idx in self.ordered_visible_player_indices:
            if not self.daily_clip_collections[p_idx]: continue
            clips_in_range = [(p, s_dt) for p in self.daily_clip_collections[p_idx] if (m:=self.filename_pattern.match(os.path.basename(p))) and (s_dt:=datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")) < end_dt and s_dt + timedelta(seconds=60) > start_dt]
            if not clips_in_range: continue
            
            fd, path = tempfile.mkstemp(suffix=".txt", text=True); temp_files.append(path)
            with os.fdopen(fd, 'w') as f: [f.write(f"file '{os.path.abspath(p)}'\n") for p, _ in clips_in_range]
            inputs.append({"p_idx": p_idx, "path": path, "offset": max(0, (start_dt - clips_in_range[0][1]).total_seconds())})

        if not inputs: return None

        cmd = [FFMPEG_PATH, "-y"]; filter_complex = []; stream_maps = []
        
        for i, stream_data in enumerate(inputs):
            cmd.extend(["-f", "concat", "-safe", "0", "-ss", str(stream_data["offset"]), "-i", stream_data["path"]])
            
            if stream_data["p_idx"] == front_cam_idx:
                filter_complex.append(f"[{i}:v]setpts=PTS-STARTPTS,scale=1448:938[v{i}]")
            else:
                filter_complex.append(f"[{i}:v]setpts=PTS-STARTPTS[v{i}]")
            stream_maps.append(f"[v{i}]")
        
        num_streams = len(inputs)
        cols = 1 if num_streams == 1 else 2 if num_streams in [2, 4] else 3
        w, h = 1448, 938
        layout = '|'.join([f"{c*w}_{r*h}" for i in range(num_streams) for r, c in [divmod(i, cols)]])
        filter_complex.append(f"{''.join(stream_maps)}xstack=inputs={num_streams}:layout={layout}[final_v]")
        
        v_map = "[final_v]"
        if is_mobile:
            tw = w * cols; th = h * math.ceil(num_streams/cols); mw = int(1080 * (tw/th)) // 2 * 2
            filter_complex.append(f"[final_v]scale={mw}:1080[mobile_v]"); v_map = "[mobile_v]"
        
        cmd.extend(["-filter_complex", ",".join(filter_complex), "-map", v_map])
        
        audio_stream_idx = next((i for i, data in enumerate(inputs) if data["p_idx"] == front_cam_idx), -1)
        if audio_stream_idx != -1: cmd.extend(["-map", f"{audio_stream_idx}:a?"])
        
        v_codec = ["-c:v", "libx264", "-preset", "fast", "-crf", "23"] if is_mobile else ["-c:v", "libx264", "-preset", "medium", "-crf", "18"]
        cmd.extend(["-t", str(duration), *v_codec, "-c:a", "aac", "-b:a", "128k", output_path])
        return cmd, temp_files

    def format_time(self, ms): 
        if ms is None: return "--:--"
        s=max(0,ms//1000); return f"{s//60:02}:{s%60:02}"
    
    def set_playback_speed(self, speed_text):
        rate = self.playback_rates.get(speed_text,1.0)
        for p in self.players: p.setPlaybackRate(rate)

    def update_slider_and_time_display(self):
        try:
            if not self.is_daily_view_active or not self.first_timestamp_of_day: 
                self.time_label.setText("Time: --:-- (Clip: --:--)")
                return

            ref_player = next((p for i, p in enumerate(self.players) if (p.source() and p.source().isValid() and p.duration() > 0 and i in self.ordered_visible_player_indices)), None)
            
            if not ref_player:
                if self.play_btn.text() != "▶️ Play":
                     if self.scrubber.value() < self.scrubber.maximum(): self.scrubber.setValue(self.scrubber.maximum())
                     self.pause_all()
                     end_time_dt = self.first_timestamp_of_day + timedelta(milliseconds=self.scrubber.maximum())
                     self.time_label.setText(f"{end_time_dt.strftime('%Y-%m-%d %H:%M:%S')} (Clip: Ended)")
                return

            current_pos, clip_duration = ref_player.position(), ref_player.duration()
            match = self.filename_pattern.match(os.path.basename(ref_player.source().path()))
            if not match: return

            clip_start_time = datetime.strptime(f"{match.group(1)} {match.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
            time_since_first_clip = int((clip_start_time - self.first_timestamp_of_day).total_seconds() * 1000)
            global_position = min(time_since_first_clip + current_pos, self.scrubber.maximum())
            
            if not self.scrubber.isSliderDown(): 
                self.scrubber.blockSignals(True)
                self.scrubber.setValue(global_position)
                self.scrubber.blockSignals(False)

            global_time = self.first_timestamp_of_day + timedelta(milliseconds=global_position)
            self.time_label.setText(f"{global_time.strftime('%Y-%m-%d %H:%M:%S')} (Clip: {self.format_time(current_pos)} / {self.format_time(clip_duration if clip_duration > 0 else 0)})")
        
        except Exception as e:
            if DEBUG_UI: print(f"Error in update_slider_and_time_display: {e}"); traceback.print_exc()
    
    def clear_all_players(self): 
        for p in self.players: p.stop(); p.setSource(QUrl())
        self.sources=[None]*6; self.daily_clip_collections=[[] for _ in range(6)]; self.current_clip_indices=[-1]*6
        self.current_segment_start_datetime=None; self.time_label.setText("YYYY-MM-DD HH:MM:SS (Clip: 00:00 / 00:00)")
        self.scrubber.setValue(0); self.scrubber.setMaximum(1000); self.is_daily_view_active=False
        self.play_btn.setText("▶️ Play"); self.speed_selector.setCurrentText("1x") 
        self.export_start_ms = None; self.export_end_ms = None
        self.scrubber.set_events([]); self.update_export_ui()

    def load_next_clip_for_player(self, player_index, is_initial_load=False, target_clip_index_override=None):
        if target_clip_index_override is not None: self.current_clip_indices[player_index] = target_clip_index_override - 1
        
        self.current_clip_indices[player_index] += 1
        current_idx = self.current_clip_indices[player_index]
        clips = self.daily_clip_collections[player_index]

        if 0 <= current_idx < len(clips):
            self.players[player_index].setSource(QUrl.fromLocalFile(clips[current_idx]))
            self.sources[player_index] = clips[current_idx]
            if not is_initial_load and self.play_btn.text() == "⏸️ Pause": 
                self.players[player_index].play()
        else: 
            self.players[player_index].setSource(QUrl())
            self.sources[player_index] = None

    def handle_media_status_changed(self, status, player_instance, player_index): 
        if status == QMediaPlayer.MediaStatus.EndOfMedia and player_instance.source() and player_instance.source().isValid():
            front_idx = self.camera_name_to_index["front"]
            if player_index == front_idx:
                next_idx = self.current_clip_indices[player_index] + 1
                if next_idx < len(self.daily_clip_collections[front_idx]):
                    for i in range(6): 
                        self.load_next_clip_for_player(i, False, next_idx)
                else:
                    self.pause_all()
                    self.scrubber.setValue(self.scrubber.maximum())
        
        elif status == QMediaPlayer.MediaStatus.LoadedMedia: 
            self.video_player_item_widgets[player_index].fit_video_to_view()
        
        elif status == QMediaPlayer.MediaStatus.InvalidMedia:
            if DEBUG_UI:
                 source_path = player_instance.source().path() if player_instance.source() else "N/A"
                 print(f"Error: Invalid media for player {player_index}. Source: {source_path}. Error: {player_instance.errorString()}")

    def update_layout(self):
        while self.video_grid.count():
            item = self.video_grid.takeAt(0)
            if item and item.widget(): 
                item.widget().setParent(None)
                item.widget().hide()
        
        num_visible = len(self.ordered_visible_player_indices)
        if num_visible == 0: 
            self.video_grid.update()
            return 

        cols = 1 if num_visible == 1 else 2 if num_visible in [2, 4] else 3
        
        current_col, current_row = 0, 0
        for p_idx in self.ordered_visible_player_indices:
            widget = self.video_player_item_widgets[p_idx]
            widget.setVisible(True)
            widget.reset_view() 
            self.video_grid.addWidget(widget, current_row, current_col)
            
            if self.players[p_idx].videoOutput() is not widget.video_item:
                self.players[p_idx].setVideoOutput(widget.video_item)

            current_col += 1
            if current_col >= cols:
                current_col = 0
                current_row += 1

        all_indices = set(range(6))
        visible_indices = set(self.ordered_visible_player_indices)
        hidden_indices = all_indices - visible_indices
        for hidden_idx in hidden_indices:
            self.video_player_item_widgets[hidden_idx].setVisible(False)
        
        self.video_grid_widget.update()

    def sync_playback(self): 
        if not self.is_daily_view_active or self.play_btn.text()!="⏸️ Pause": return
        active_players = [p for i, p in enumerate(self.players) if i in self.ordered_visible_player_indices and p.source() and p.source().isValid() and p.playbackState() == QMediaPlayer.PlaybackState.PlayingState]
        if len(active_players) < 2: return
        avg_pos = sum(p.position() for p in active_players) // len(active_players)
        for p in active_players:
            if abs(p.position() - avg_pos) > 700: p.setPosition(avg_pos)