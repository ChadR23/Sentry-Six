import os
import tempfile
import subprocess
from datetime import datetime

from PyQt6.QtWidgets import (QWidget, QVBoxLayout, QLabel, QPushButton, QDialog, QHBoxLayout,
                             QLineEdit, QSlider, QGraphicsView, QGraphicsScene, QStyle, 
                             QSizePolicy, QStyleOptionSlider, QApplication)
from PyQt6.QtCore import Qt, pyqtSignal, QPoint, QRect, QTimer, QMimeData
from PyQt6.QtGui import QPixmap, QPainter, QColor, QPen, QTransform, QWheelEvent, QMouseEvent, QDrag

from . import utils

class ExportScrubber(QSlider):
    export_marker_moved = pyqtSignal(str, int)
    event_marker_clicked = pyqtSignal(object)
    event_marker_hovered = pyqtSignal(object, QPoint)
    drag_started = pyqtSignal()
    drag_finished = pyqtSignal()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.start_ms, self.end_ms = None, None
        self.dragging_marker = None
        self.events = []
        self.setMouseTracking(True)
        
        self.icon_camera = QPixmap(os.path.join(utils.ASSETS_DIR, "camera.svg")).scaled(28, 28, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.icon_hand = QPixmap(os.path.join(utils.ASSETS_DIR, "hand.svg")).scaled(28, 28, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.icon_horn = QPixmap(os.path.join(utils.ASSETS_DIR, "horn.svg")).scaled(28, 28, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.hovered_event = None

    def set_export_range(self, start_ms, end_ms):
        self.start_ms, self.end_ms = start_ms, end_ms
        self.update()

    def set_events(self, events):
        self.events = events
        self.update()
    
    def _value_to_pixel(self, value):
        if value is None:
            return -1
        return QStyle.sliderPositionFromValue(self.minimum(), self.maximum(), int(value), self.width())

    def _pixel_to_value(self, pixel):
        return QStyle.sliderValueFromPosition(self.minimum(), self.maximum(), pixel, self.width())

    def get_style_option(self):
        opt = QStyleOptionSlider()
        self.initStyleOption(opt)
        return opt

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        style = self.style()
        if style is None:
            return
        groove_rect = style.subControlRect(QStyle.ComplexControl.CC_Slider, self.get_style_option(), QStyle.SubControl.SC_SliderGroove, self)
        
        if self.start_ms is not None and self.end_ms is not None:
            start_px = self._value_to_pixel(self.start_ms)
            end_px = self._value_to_pixel(self.end_ms)
            painter.setBrush(QColor(97, 175, 239, 70))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawRect(QRect(QPoint(start_px, groove_rect.y()), QPoint(end_px, groove_rect.y() + groove_rect.height())))
            painter.setPen(QPen(QColor(30, 220, 100), 2))
            painter.drawLine(start_px, 0, start_px, self.height())
            painter.setPen(QPen(QColor(220, 50, 50), 2))
            painter.drawLine(end_px, 0, end_px, self.height())

        for evt in self.events:
            event_pixel = self._value_to_pixel(evt['ms_in_timeline'])
            if 'sentry' in evt['reason']: icon = self.icon_camera
            elif 'user_interaction' in evt['reason']: icon = self.icon_hand
            elif 'honk' in evt['reason']: icon = self.icon_horn
            else: continue
            
            icon_y = groove_rect.center().y() - icon.height() // 2
            ideal_x = event_pixel - icon.width() // 2
            draw_x = max(0, min(ideal_x, self.width() - icon.width()))
            
            painter.drawPixmap(draw_x, icon_y, icon)

    def mousePressEvent(self, event: QMouseEvent):
        pos_x = event.pos().x()
        for evt in self.events:
            event_pixel = self._value_to_pixel(evt['ms_in_timeline'])
            if abs(pos_x - event_pixel) < 10:
                self.event_marker_clicked.emit(evt)
                return

        if self.start_ms is not None and self.end_ms is not None:
            start_px = self._value_to_pixel(self.start_ms)
            end_px = self._value_to_pixel(self.end_ms)
            if abs(pos_x - start_px) < 10:
                self.dragging_marker = 'start'
                self.drag_started.emit()
                self.setSliderDown(True)
                return
            if abs(pos_x - end_px) < 10:
                self.dragging_marker = 'end'
                self.drag_started.emit()
                self.setSliderDown(True)
                return
        
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent):
        if self.dragging_marker:
            new_value = self._pixel_to_value(event.pos().x())
            if self.dragging_marker == 'start' and self.end_ms is not None and new_value < self.end_ms:
                self.export_marker_moved.emit('start', new_value)
            elif self.dragging_marker == 'end' and self.start_ms is not None and new_value > self.start_ms:
                self.export_marker_moved.emit('end', new_value)
            return
        
        current_hover = None
        for evt in self.events:
            event_pixel = self._value_to_pixel(evt['ms_in_timeline'])
            if abs(event.pos().x() - event_pixel) < 10:
                current_hover = evt
                break
        
        if self.hovered_event != current_hover:
            self.hovered_event = current_hover
            self.event_marker_hovered.emit(self.hovered_event, self.mapToGlobal(event.pos()))
        
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent):
        if self.dragging_marker:
            self.dragging_marker = None
            self.drag_finished.emit()
            self.setSliderDown(False)
        else:
            super().mouseReleaseEvent(event)

    def leaveEvent(self, event):
        super().leaveEvent(event)
        # Emit hover event with None to hide the tooltip
        self.event_marker_hovered.emit(None, self.mapToGlobal(self.rect().center()))

class EventToolTip(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent, Qt.WindowType.ToolTip | Qt.WindowType.FramelessWindowHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)
        self.thumbnail_label = QLabel()
        self.thumbnail_label.setFixedSize(192, 108)
        self.thumbnail_label.setStyleSheet("border: 1px solid #444; background-color: #222;")
        self.thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.reason_label = QLabel()
        self.reason_label.setStyleSheet("background-color: #282c34; padding: 4px; border-radius: 3px;")
        self.reason_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.thumbnail_label)
        layout.addWidget(self.reason_label)

    def update_content(self, reason_text, pixmap):
        # Map reason to short label
        reason_lower = reason_text.lower() if reason_text else ""
        if "user_interaction" in reason_lower:
            short_label = "User Event"
        elif "sentry" in reason_lower:
            short_label = "Sentry Detection"
        elif "honk" in reason_lower:
            short_label = "User Honked"
        else:
            short_label = reason_text.replace("_", " ").title() if reason_text else "Event"
        self.reason_label.setText(short_label)
        if pixmap and not pixmap.isNull():
            self.thumbnail_label.setPixmap(pixmap.scaled(self.thumbnail_label.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
            self.thumbnail_label.setText("")
        else:
            self.thumbnail_label.setText("  No Preview Available")

class VideoPlayerItemWidget(QGraphicsView):
    MIME_TYPE = "application/x-teslacam-widget-index"
    swap_requested = pyqtSignal(int, int) # dragged_index, dropped_on_index

    def __init__(self, player_index: int, parent=None):
        super().__init__(parent)
        self.player_index = player_index
        self._scene = QGraphicsScene(self)
        self.video_item = None
        self.setAcceptDrops(True)
        self.is_being_dragged_over = False

        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setMinimumSize(100, 75)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setObjectName(f"VideoPlayerItemWidget_{player_index}")
        self.setStyleSheet("QGraphicsView { border: 2px solid #282c34; }")

    def set_video_item(self, item):
        if self.video_item and self._scene:
            self._scene.removeItem(self.video_item)
        self.video_item = item
        if self._scene and self.video_item:
            self._scene.addItem(self.video_item)
        self.setScene(self._scene)

    def fit_video_to_view(self):
        if self.video_item and not self.video_item.nativeSize().isEmpty():
            self.fitInView(self.video_item, Qt.AspectRatioMode.KeepAspectRatio)

    def wheelEvent(self, event: QWheelEvent):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        if self.transform().m11() * factor < 1.0:
            self.reset_view()
        elif self.transform().m11() * factor > 7.0:
            return
        else:
            self.scale(factor, factor)
        event.accept()

    def reset_view(self):
        self.setTransform(QTransform())
        self.fit_video_to_view()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.fit_video_to_view()

    def mousePressEvent(self, event: QMouseEvent):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_start_position = event.pos()
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent):
        if not (event.buttons() & Qt.MouseButton.LeftButton):
            return
        if (event.pos() - self.drag_start_position).manhattanLength() < QApplication.startDragDistance():
            return

        # Temporarily disable the view's internal drag mode to prevent state conflicts.
        original_drag_mode = self.dragMode()
        self.setDragMode(QGraphicsView.DragMode.NoDrag)

        drag = QDrag(self)
        mime_data = QMimeData()
        mime_data.setData(self.MIME_TYPE, str(self.player_index).encode())
        drag.setMimeData(mime_data)
        
        pixmap = self.grab()
        pixmap.setDevicePixelRatio(1.0) # Ensure pixmap size matches widget size
        painter = QPainter(pixmap)
        painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_DestinationIn)
        painter.fillRect(pixmap.rect(), QColor(0, 0, 0, 150))
        painter.end()

        drag.setPixmap(pixmap)
        drag.setHotSpot(event.pos())
        drag.exec(Qt.DropAction.MoveAction)

        # Restore the original drag mode after the operation is complete.
        self.setDragMode(original_drag_mode)
    
    def dragEnterEvent(self, event):
        if event is not None and hasattr(event, 'mimeData'):
            mime_data = event.mimeData()
            if mime_data is not None and mime_data.hasFormat(self.MIME_TYPE):
                source_index = int(mime_data.data(self.MIME_TYPE).data().decode())
                if source_index != self.player_index:
                    event.acceptProposedAction()
                    self.is_being_dragged_over = True
                    self.setStyleSheet("QGraphicsView { border: 2px solid #61afef; }") # Highlight border
                return
        if event is not None:
            event.ignore()

    def dragMoveEvent(self, event):
        if event is not None and hasattr(event, 'mimeData'):
            mime_data = event.mimeData()
            if mime_data is not None and mime_data.hasFormat(self.MIME_TYPE):
                event.acceptProposedAction()
                return
        if event is not None:
            event.ignore()

    def dragLeaveEvent(self, event=None):
        self.is_being_dragged_over = False
        self.setStyleSheet("QGraphicsView { border: 2px solid #282c34; }") # Reset border

    def dropEvent(self, event):
        if event is not None and hasattr(event, 'mimeData'):
            mime_data = event.mimeData()
            if mime_data is not None and mime_data.hasFormat(self.MIME_TYPE):
                source_index = int(mime_data.data(self.MIME_TYPE).data().decode())
                if utils.DEBUG_UI:
                    print(f"[Widget {self.player_index}] Drop detected. Emitting swap request: Dragged={source_index}, Dropped On={self.player_index}")
                self.swap_requested.emit(source_index, self.player_index)
                event.acceptProposedAction()
        self.dragLeaveEvent() # Reset style after drop

class GoToTimeDialog(QDialog):
    request_thumbnail = pyqtSignal(str, float)

    def __init__(self, parent=None, current_date_str="", first_timestamp_of_day=None, daily_clip_collections=None, front_cam_idx=None):
        super().__init__(parent)
        self.setWindowTitle("Go to Timestamp")
        self.setMinimumWidth(400)
        layout = QVBoxLayout(self)
        self.info_label = QLabel(f"Date: {current_date_str}\nEnter time (HH:MM:SS)")
        layout.addWidget(self.info_label)
        self.time_input = QLineEdit(self)
        self.time_input.setPlaceholderText("HH:MM:SS")
        self.time_input.textChanged.connect(self.on_time_input_changed)
        layout.addWidget(self.time_input)
        self.thumbnail_label = QLabel("Enter time to see preview...")
        self.thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thumbnail_label.setMinimumSize(320, 180)
        self.thumbnail_label.setStyleSheet("border: 1px solid #444; background-color: #222;")
        layout.addWidget(self.thumbnail_label)
        self.buttons_layout = QHBoxLayout()
        self.ok_button = QPushButton("OK")
        self.ok_button.clicked.connect(self.accept)
        self.cancel_button = QPushButton("Cancel")
        self.cancel_button.clicked.connect(self.reject)
        self.buttons_layout.addWidget(self.ok_button)
        self.buttons_layout.addWidget(self.cancel_button)
        layout.addLayout(self.buttons_layout)
        if parent:
            self.setStyleSheet(parent.styleSheet())
        
        self.current_date_str_for_dialog = current_date_str
        self.first_timestamp_of_day_for_thumb = first_timestamp_of_day
        self.daily_clip_collections_for_thumb = daily_clip_collections
        self.front_cam_idx_for_thumb = front_cam_idx
        self.thumbnail_timer = QTimer(self)
        self.thumbnail_timer.setSingleShot(True)
        self.thumbnail_timer.timeout.connect(self.trigger_thumbnail_generation)

    def on_time_input_changed(self, text):
        self.thumbnail_label.setText("Generating preview...")
        self.thumbnail_label.setPixmap(QPixmap())
        self.thumbnail_timer.start(750)

    def trigger_thumbnail_generation(self):
        time_str = self.time_input.text().strip()
        if not time_str or not utils.FFMPEG_EXE:
            self.thumbnail_label.setText("Preview N/A (No input/ffmpeg)")
            return
        
        parent = self.parent()
        original_date_str = None
        date_selector = getattr(parent, 'date_selector', None)
        if date_selector is not None:
            original_date_str = date_selector.currentData()
        if not original_date_str:
            self.thumbnail_label.setText("Invalid date for preview")
            return
        try:
            target_dt = datetime.strptime(f"{original_date_str} {time_str}", "%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            self.thumbnail_label.setText("Invalid time format for preview")
            return
        if not (target_dt and self.first_timestamp_of_day_for_thumb and self.daily_clip_collections_for_thumb is not None and self.front_cam_idx_for_thumb is not None):
            return
        if self.first_timestamp_of_day_for_thumb is None:
            return
        time_offset_s = (target_dt - self.first_timestamp_of_day_for_thumb).total_seconds() if target_dt and self.first_timestamp_of_day_for_thumb else 0
        if time_offset_s < 0:
            self.thumbnail_label.setText("Time before day start")
            return
        seg_idx, offset_in_seg = int(time_offset_s // 60), time_offset_s % 60
        front_clips = self.daily_clip_collections_for_thumb[self.front_cam_idx_for_thumb] if self.daily_clip_collections_for_thumb and self.front_cam_idx_for_thumb is not None else None
        if front_clips and 0 <= seg_idx < len(front_clips):
            self.request_thumbnail.emit(front_clips[seg_idx], offset_in_seg)
        else:
            self.thumbnail_label.setText("Time out of range")

    def set_thumbnail(self, pixmap: QPixmap):
        if pixmap and not pixmap.isNull():
            self.thumbnail_label.setPixmap(pixmap.scaled(self.thumbnail_label.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        else:
            self.thumbnail_label.setText("Preview failed or N/A")

    def get_time_string(self):
        return self.time_input.text()