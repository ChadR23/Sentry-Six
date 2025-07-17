"""
Layout Manager for SentrySix.

This module handles camera layout management, visibility control, and UI arrangement.
Extracted from TeslaCamViewer as part of the manager-based architecture refactoring.
"""

from typing import List, Dict, Tuple, Optional
from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QCheckBox

from .base import BaseManager


class LayoutManagerSignals(QObject):
    """Signals for LayoutManager communication with UI."""
    
    # Layout change signals
    layout_updated = pyqtSignal()  # General layout update
    camera_visibility_changed = pyqtSignal(int, bool)  # camera_index, is_visible
    camera_order_changed = pyqtSignal(list)  # new_ordered_indices
    
    # Grid layout signals
    grid_configuration_changed = pyqtSignal(int, int)  # rows, columns
    camera_position_changed = pyqtSignal(int, int, int)  # camera_index, row, col
    
    # Layout validation signals
    layout_validation_failed = pyqtSignal(str)  # error_message
    layout_reset_completed = pyqtSignal()  # layout reset to defaults
    
    # Drag and drop signals
    camera_drag_started = pyqtSignal(int)  # camera_index
    camera_drop_completed = pyqtSignal(int, int)  # dragged_index, dropped_on_index


class LayoutManager(BaseManager):
    """
    Manages camera layout, visibility, and UI arrangement.
    
    Handles:
    - Camera visibility control and checkbox management
    - Camera ordering and drag-and-drop reordering
    - Grid layout calculations and positioning
    - Layout validation and error recovery
    - Settings persistence for layout preferences
    """

    def __init__(self, parent_widget, dependency_container):
        """Initialize the LayoutManager."""
        super().__init__(parent_widget, dependency_container)

        # Initialize signals
        self.signals = LayoutManagerSignals()

        # Camera configuration
        self.camera_name_to_index = {
            "front": 0, "left_repeater": 1, "right_repeater": 2, 
            "back": 3, "left_pillar": 4, "right_pillar": 5
        }
        self.camera_index_to_name = {v: k for k, v in self.camera_name_to_index.items()}
        
        # Camera information for UI
        self.checkbox_info = [
            ("LP", "Left Pillar", self.camera_name_to_index["left_pillar"]),
            ("F", "Front", self.camera_name_to_index["front"]),
            ("RP", "Right Pillar", self.camera_name_to_index["right_pillar"]),
            ("LR", "Left Repeater", self.camera_name_to_index["left_repeater"]),
            ("B", "Back", self.camera_name_to_index["back"]),
            ("RR", "Right Repeater", self.camera_name_to_index["right_repeater"]),
        ]

        # Layout state
        self.ordered_visible_player_indices: List[int] = []
        self.camera_visibility_checkboxes: List[QCheckBox] = []
        self._last_visible_player_indices: List[int] = []
        
        # Grid layout state
        self.current_grid_rows: int = 0
        self.current_grid_cols: int = 0
        self.camera_positions: Dict[int, Tuple[int, int]] = {}  # camera_index -> (row, col)

        # Dependencies (will be set during initialization)
        self.settings = None
        self.video_grid = None
        self.video_player_item_widgets = None

        self.logger.debug("LayoutManager created")

    def initialize(self) -> bool:
        """
        Initialize layout manager.

        Returns:
            bool: True if initialization was successful
        """
        try:
            # Use parent widget's settings directly to avoid dependency injection issues
            if hasattr(self.parent_widget, 'settings'):
                self.settings = self.parent_widget.settings
            else:
                # Fallback to container
                self.settings = self.container.get_service('settings')

            # Get UI components from parent widget (may not be available during early initialization)
            self._acquire_ui_components()

            # Initialize default layout
            self._initialize_default_layout()

            self.logger.info("LayoutManager initialized successfully")
            self._mark_initialized()
            return True

        except Exception as e:
            self.handle_error(e, "LayoutManager initialization")
            return False

    def cleanup(self) -> None:
        """Clean up layout resources."""
        try:
            self._mark_cleanup_started()

            # Reset layout state
            self.ordered_visible_player_indices.clear()
            self._last_visible_player_indices.clear()
            self.camera_positions.clear()
            self.current_grid_rows = 0
            self.current_grid_cols = 0

            # Clear references
            self.settings = None
            self.video_grid = None
            self.video_player_item_widgets = None
            self.camera_visibility_checkboxes = None

            self.logger.info("LayoutManager cleaned up successfully")

        except Exception as e:
            self.handle_error(e, "LayoutManager cleanup")

    def _acquire_ui_components(self) -> bool:
        """
        Acquire UI components from parent widget.

        Returns:
            bool: True if all components were acquired successfully
        """
        try:
            components_acquired = True

            # Get video grid
            if hasattr(self.parent_widget, 'video_grid'):
                self.video_grid = self.parent_widget.video_grid
            else:
                self.video_grid = None
                components_acquired = False

            # Get video player widgets
            if hasattr(self.parent_widget, 'video_player_item_widgets'):
                self.video_player_item_widgets = self.parent_widget.video_player_item_widgets
            else:
                self.video_player_item_widgets = None
                components_acquired = False

            # Get camera visibility checkboxes
            if hasattr(self.parent_widget, 'camera_visibility_checkboxes'):
                self.camera_visibility_checkboxes = self.parent_widget.camera_visibility_checkboxes
            else:
                self.camera_visibility_checkboxes = None
                components_acquired = False

            if not components_acquired:
                self.logger.debug("Some UI components not yet available during initialization")

            return components_acquired

        except Exception as e:
            self.handle_error(e, "_acquire_ui_components")
            return False

    def _initialize_default_layout(self) -> None:
        """Initialize the default camera layout."""
        try:
            # Set default visible cameras (all cameras visible)
            self.ordered_visible_player_indices = [idx for _, _, idx in self.checkbox_info]
            self._last_visible_player_indices = self.ordered_visible_player_indices.copy()
            
            # Calculate initial grid layout
            self._calculate_grid_layout()

            self.logger.debug("Default layout initialized")

        except Exception as e:
            self.handle_error(e, "_initialize_default_layout")

    # ========================================
    # Camera Visibility Management (Week 5 Implementation)
    # ========================================

    def set_camera_visibility(self, camera_index: int, is_visible: bool) -> None:
        """Set visibility for a specific camera."""
        try:
            if camera_index < 0 or camera_index >= 6:
                self.logger.warning(f"Invalid camera index: {camera_index}")
                return

            # Update checkbox if available
            if (self.camera_visibility_checkboxes and 
                camera_index < len(self.camera_visibility_checkboxes)):
                checkbox = self.camera_visibility_checkboxes[camera_index]
                checkbox.blockSignals(True)
                checkbox.setChecked(is_visible)
                checkbox.blockSignals(False)

            # Update visibility list
            self._update_visibility_from_checkboxes()

            # Emit signal for individual camera visibility change
            self.signals.camera_visibility_changed.emit(camera_index, is_visible)

            self.logger.debug(f"Camera {camera_index} visibility set to {is_visible}")

        except Exception as e:
            self.handle_error(e, f"set_camera_visibility({camera_index}, {is_visible})")

    def toggle_camera_visibility(self, camera_index: int) -> bool:
        """
        Toggle visibility for a specific camera.
        
        Returns:
            bool: New visibility state
        """
        try:
            if (self.camera_visibility_checkboxes and 
                camera_index < len(self.camera_visibility_checkboxes)):
                checkbox = self.camera_visibility_checkboxes[camera_index]
                new_state = not checkbox.isChecked()
                self.set_camera_visibility(camera_index, new_state)
                return new_state
            
            return False

        except Exception as e:
            self.handle_error(e, f"toggle_camera_visibility({camera_index})")
            return False

    def get_visible_cameras(self) -> List[int]:
        """Get list of currently visible camera indices."""
        return self.ordered_visible_player_indices.copy()

    def get_camera_visibility_state(self) -> Dict[int, bool]:
        """Get visibility state for all cameras."""
        try:
            visibility_state = {}
            for i in range(6):
                visibility_state[i] = i in self.ordered_visible_player_indices
            return visibility_state

        except Exception as e:
            self.handle_error(e, "get_camera_visibility_state")
            return {}

    def _update_visibility_from_checkboxes(self) -> None:
        """Update visibility list based on checkbox states."""
        try:
            if not self.camera_visibility_checkboxes:
                return

            # Track previously visible cameras
            self._last_visible_player_indices = self.ordered_visible_player_indices.copy()

            # Update the list of visible player indices based on checkboxes
            new_visible = [
                self.checkbox_info[i][2]
                for i, cb in enumerate(self.camera_visibility_checkboxes)
                if cb.isChecked()
            ]

            # Update ordered visible indices
            self.ordered_visible_player_indices = new_visible

            # Calculate new grid layout
            self._calculate_grid_layout()

            # Emit signals
            self.signals.camera_order_changed.emit(self.ordered_visible_player_indices)
            self.signals.layout_updated.emit()

        except Exception as e:
            self.handle_error(e, "_update_visibility_from_checkboxes")

    # ========================================
    # Camera Ordering Management (Week 5 Implementation)
    # ========================================

    def reorder_cameras(self, new_order: List[int]) -> bool:
        """
        Reorder cameras according to new order list.

        Args:
            new_order: List of camera indices in desired order

        Returns:
            bool: True if reordering was successful
        """
        try:
            # Validate new order
            if not self._validate_camera_order(new_order):
                return False

            # Update order
            self.ordered_visible_player_indices = new_order.copy()

            # Recalculate grid layout
            self._calculate_grid_layout()

            # Emit signals
            self.signals.camera_order_changed.emit(self.ordered_visible_player_indices)
            self.signals.layout_updated.emit()

            self.logger.debug(f"Cameras reordered to: {new_order}")
            return True

        except Exception as e:
            self.handle_error(e, f"reorder_cameras({new_order})")
            return False

    def swap_cameras(self, camera1_index: int, camera2_index: int) -> bool:
        """
        Swap positions of two cameras in the layout.

        Args:
            camera1_index: Index of first camera
            camera2_index: Index of second camera

        Returns:
            bool: True if swap was successful
        """
        try:
            # Find positions in ordered list
            try:
                pos1 = self.ordered_visible_player_indices.index(camera1_index)
                pos2 = self.ordered_visible_player_indices.index(camera2_index)
            except ValueError:
                self.logger.warning(f"Cannot swap cameras {camera1_index} and {camera2_index}: not in visible list")
                return False

            # Perform swap
            self.ordered_visible_player_indices[pos1], self.ordered_visible_player_indices[pos2] = \
                self.ordered_visible_player_indices[pos2], self.ordered_visible_player_indices[pos1]

            # Recalculate grid layout
            self._calculate_grid_layout()

            # Emit signals
            self.signals.camera_drop_completed.emit(camera1_index, camera2_index)
            self.signals.camera_order_changed.emit(self.ordered_visible_player_indices)
            self.signals.layout_updated.emit()

            self.logger.debug(f"Swapped cameras {camera1_index} and {camera2_index}")
            return True

        except Exception as e:
            self.handle_error(e, f"swap_cameras({camera1_index}, {camera2_index})")
            return False

    def move_camera_to_position(self, camera_index: int, new_position: int) -> bool:
        """
        Move a camera to a specific position in the layout.

        Args:
            camera_index: Index of camera to move
            new_position: New position (0-based index)

        Returns:
            bool: True if move was successful
        """
        try:
            if camera_index not in self.ordered_visible_player_indices:
                self.logger.warning(f"Camera {camera_index} not in visible list")
                return False

            if new_position < 0 or new_position >= len(self.ordered_visible_player_indices):
                self.logger.warning(f"Invalid position {new_position}")
                return False

            # Remove camera from current position
            current_pos = self.ordered_visible_player_indices.index(camera_index)
            self.ordered_visible_player_indices.pop(current_pos)

            # Insert at new position
            self.ordered_visible_player_indices.insert(new_position, camera_index)

            # Recalculate grid layout
            self._calculate_grid_layout()

            # Emit signals
            self.signals.camera_order_changed.emit(self.ordered_visible_player_indices)
            self.signals.layout_updated.emit()

            self.logger.debug(f"Moved camera {camera_index} to position {new_position}")
            return True

        except Exception as e:
            self.handle_error(e, f"move_camera_to_position({camera_index}, {new_position})")
            return False

    def _validate_camera_order(self, order: List[int]) -> bool:
        """Validate camera order list."""
        try:
            # Check for valid indices
            for idx in order:
                if idx < 0 or idx >= 6:
                    self.logger.warning(f"Invalid camera index in order: {idx}")
                    return False

            # Check for duplicates
            if len(order) != len(set(order)):
                self.logger.warning("Duplicate camera indices in order")
                return False

            return True

        except Exception as e:
            self.handle_error(e, f"_validate_camera_order({order})")
            return False

    # ========================================
    # Grid Layout Management (Week 5 Implementation)
    # ========================================

    def _calculate_grid_layout(self) -> None:
        """Calculate grid layout based on number of visible cameras."""
        try:
            num_visible = len(self.ordered_visible_player_indices)

            if num_visible == 0:
                self.current_grid_rows = 0
                self.current_grid_cols = 0
                self.camera_positions.clear()
                return

            # Calculate columns (1 for 1, 2 for 2/4, 3 for 3/6)
            if num_visible == 1:
                cols = 1
            elif num_visible in [2, 4]:
                cols = 2
            else:  # 3, 5, 6
                cols = 3

            # Calculate rows
            rows = (num_visible + cols - 1) // cols

            self.current_grid_rows = rows
            self.current_grid_cols = cols

            # Calculate camera positions
            self.camera_positions.clear()
            current_row, current_col = 0, 0

            for camera_idx in self.ordered_visible_player_indices:
                self.camera_positions[camera_idx] = (current_row, current_col)

                # Emit position change signal
                self.signals.camera_position_changed.emit(camera_idx, current_row, current_col)

                current_col += 1
                if current_col >= cols:
                    current_col = 0
                    current_row += 1

            # Emit grid configuration signal
            self.signals.grid_configuration_changed.emit(rows, cols)

            self.logger.debug(f"Grid layout calculated: {rows}x{cols} for {num_visible} cameras")

        except Exception as e:
            self.handle_error(e, "_calculate_grid_layout")

    def get_grid_configuration(self) -> Tuple[int, int]:
        """Get current grid configuration (rows, columns)."""
        return (self.current_grid_rows, self.current_grid_cols)

    def get_camera_position(self, camera_index: int) -> Optional[Tuple[int, int]]:
        """Get grid position for a specific camera."""
        return self.camera_positions.get(camera_index)

    def get_camera_at_position(self, row: int, col: int) -> Optional[int]:
        """Get camera index at specific grid position."""
        try:
            for camera_idx, (cam_row, cam_col) in self.camera_positions.items():
                if cam_row == row and cam_col == col:
                    return camera_idx
            return None

        except Exception as e:
            self.handle_error(e, f"get_camera_at_position({row}, {col})")
            return None

    # ========================================
    # Layout Reset and Defaults (Week 5 Implementation)
    # ========================================

    def reset_to_default_layout(self) -> None:
        """Reset layout to default configuration."""
        try:
            # Remove saved order from settings
            if self.settings:
                self.settings.remove("cameraOrder")

            # Set all cameras to visible
            if self.camera_visibility_checkboxes:
                for checkbox in self.camera_visibility_checkboxes:
                    checkbox.blockSignals(True)
                    checkbox.setChecked(True)
                    checkbox.blockSignals(False)

            # Reset to default order (all indices from checkbox_info)
            self.ordered_visible_player_indices = [idx for _, _, idx in self.checkbox_info]
            self._last_visible_player_indices = self.ordered_visible_player_indices.copy()

            # Recalculate grid layout
            self._calculate_grid_layout()

            # Emit signals
            self.signals.layout_reset_completed.emit()
            self.signals.camera_order_changed.emit(self.ordered_visible_player_indices)
            self.signals.layout_updated.emit()

            self.logger.info("Layout reset to default configuration")

        except Exception as e:
            self.handle_error(e, "reset_to_default_layout")

    def apply_layout_from_settings(self) -> None:
        """Apply layout configuration from saved settings."""
        try:
            if not self.settings:
                self.logger.warning("No settings available for layout loading")
                return

            # Load visibility states
            vis_states = self.settings.value("cameraVisibility")
            if vis_states and len(vis_states) == len(self.camera_visibility_checkboxes):
                for i, cb in enumerate(self.camera_visibility_checkboxes):
                    cb.blockSignals(True)
                    cb.setChecked(vis_states[i] == 'true')
                    cb.blockSignals(False)

            # Build initial ordered list from checkboxes
            visible_from_checkboxes = [
                self.checkbox_info[i][2]
                for i, cb in enumerate(self.camera_visibility_checkboxes)
                if cb.isChecked()
            ]

            # Load custom order and validate it
            saved_order_str = self.settings.value("cameraOrder", type=list)
            if saved_order_str:
                try:
                    saved_order = [int(i) for i in saved_order_str]
                    # Ensure the saved order only contains currently visible cameras
                    validated_order = [idx for idx in saved_order if idx in visible_from_checkboxes]
                    # Add any newly visible cameras (that weren't in the saved order) to the end
                    for idx in visible_from_checkboxes:
                        if idx not in validated_order:
                            validated_order.append(idx)
                    self.ordered_visible_player_indices = validated_order
                except (ValueError, TypeError):
                    self.logger.warning("Invalid saved camera order, using default")
                    self.ordered_visible_player_indices = visible_from_checkboxes
            else:
                self.ordered_visible_player_indices = visible_from_checkboxes

            self._last_visible_player_indices = self.ordered_visible_player_indices.copy()

            # Calculate grid layout
            self._calculate_grid_layout()

            # Emit signals
            self.signals.camera_order_changed.emit(self.ordered_visible_player_indices)
            self.signals.layout_updated.emit()

            self.logger.debug("Layout applied from settings")

        except Exception as e:
            self.handle_error(e, "apply_layout_from_settings")

    def save_layout_to_settings(self) -> None:
        """Save current layout configuration to settings."""
        try:
            if not self.settings:
                self.logger.warning("No settings available for layout saving")
                return

            # Save camera visibility states
            if self.camera_visibility_checkboxes:
                visibility_states = [
                    str(cb.isChecked()).lower()
                    for cb in self.camera_visibility_checkboxes
                ]
                self.settings.setValue("cameraVisibility", visibility_states)

            # Save camera order
            order_strings = [str(i) for i in self.ordered_visible_player_indices]
            self.settings.setValue("cameraOrder", order_strings)

            self.logger.debug("Layout saved to settings")

        except Exception as e:
            self.handle_error(e, "save_layout_to_settings")

    # ========================================
    # Public API Methods (Week 5 Implementation)
    # ========================================

    def get_layout_state(self) -> dict:
        """Get comprehensive layout state information."""
        try:
            return {
                'visible_cameras': self.ordered_visible_player_indices.copy(),
                'camera_visibility': self.get_camera_visibility_state(),
                'grid_rows': self.current_grid_rows,
                'grid_cols': self.current_grid_cols,
                'camera_positions': self.camera_positions.copy(),
                'total_visible': len(self.ordered_visible_player_indices),
                'camera_names': {idx: self.camera_index_to_name[idx] for idx in self.ordered_visible_player_indices}
            }

        except Exception as e:
            self.handle_error(e, "get_layout_state")
            return {}

    def is_camera_visible(self, camera_index: int) -> bool:
        """Check if a specific camera is currently visible."""
        return camera_index in self.ordered_visible_player_indices

    def get_newly_visible_cameras(self) -> List[int]:
        """Get cameras that became visible since last update."""
        try:
            current_visible = set(self.ordered_visible_player_indices)
            last_visible = set(self._last_visible_player_indices)
            return list(current_visible - last_visible)

        except Exception as e:
            self.handle_error(e, "get_newly_visible_cameras")
            return []

    def get_newly_hidden_cameras(self) -> List[int]:
        """Get cameras that became hidden since last update."""
        try:
            current_visible = set(self.ordered_visible_player_indices)
            last_visible = set(self._last_visible_player_indices)
            return list(last_visible - current_visible)

        except Exception as e:
            self.handle_error(e, "get_newly_hidden_cameras")
            return []

    def update_last_visible_state(self) -> None:
        """Update the last visible state for change tracking."""
        self._last_visible_player_indices = self.ordered_visible_player_indices.copy()

    # ========================================
    # UI Layout Operations (Week 5 Implementation)
    # ========================================

    def update_ui_layout(self) -> None:
        """Update the actual UI layout based on current state."""
        try:
            # Try to acquire UI components if not available
            if not self.video_grid or not self.video_player_item_widgets:
                if not self._acquire_ui_components():
                    self.logger.warning("UI components not available for layout update")
                    return

            # Clear existing layout
            self._clear_grid_layout()

            num_visible = len(self.ordered_visible_player_indices)
            if num_visible == 0:
                self.logger.debug("No visible cameras, layout cleared")
                return

            # Apply grid layout
            self._apply_grid_layout()

            # Update widget geometry
            self._update_widget_geometry()

            # Emit layout updated signal
            self.signals.layout_updated.emit()

            self.logger.debug(f"UI layout updated for {num_visible} cameras")

        except Exception as e:
            self.handle_error(e, "update_ui_layout")

    def _clear_grid_layout(self) -> None:
        """Clear all widgets from the grid layout."""
        try:
            # Remove all widgets from grid
            for i in range(self.video_grid.count()):
                item = self.video_grid.itemAt(0)
                if item:
                    widget = item.widget()
                    if widget:
                        self.video_grid.removeWidget(widget)

            # Reset stretch factors
            for i in range(6):  # Max 6 rows/columns
                self.video_grid.setRowStretch(i, 0)
                self.video_grid.setColumnStretch(i, 0)

        except Exception as e:
            self.handle_error(e, "_clear_grid_layout")

    def _apply_grid_layout(self) -> None:
        """Apply the calculated grid layout to UI widgets."""
        try:
            num_visible = len(self.ordered_visible_player_indices)
            rows, cols = self.get_grid_configuration()

            # Position visible widgets
            for camera_idx in self.ordered_visible_player_indices:
                if camera_idx >= len(self.video_player_item_widgets):
                    continue

                widget = self.video_player_item_widgets[camera_idx]
                position = self.get_camera_position(camera_idx)

                if position:
                    row, col = position
                    widget.setVisible(True)
                    widget.reset_view()  # Ensure video fits the new cell size
                    self.video_grid.addWidget(widget, row, col)

                    # Set video item if available
                    if hasattr(self.parent_widget, 'get_active_video_items'):
                        active_video_items = self.parent_widget.get_active_video_items()
                        if camera_idx < len(active_video_items):
                            widget.set_video_item(active_video_items[camera_idx])

            # Hide widgets not in visible set
            all_camera_indices = set(range(6))
            visible_indices = set(self.ordered_visible_player_indices)
            hidden_indices = all_camera_indices - visible_indices

            for hidden_idx in hidden_indices:
                if hidden_idx < len(self.video_player_item_widgets):
                    self.video_player_item_widgets[hidden_idx].setVisible(False)

            # Set stretch factors for uniform grid sizing
            self._set_grid_stretch_factors(rows, cols, num_visible)

        except Exception as e:
            self.handle_error(e, "_apply_grid_layout")

    def _set_grid_stretch_factors(self, rows: int, cols: int, num_visible: int) -> None:
        """Set row and column stretch factors for uniform grid sizing."""
        try:
            if num_visible == 1:
                # Only one camera: make it fill all space
                self.video_grid.setRowStretch(0, 1)
                self.video_grid.setColumnStretch(0, 1)
                # Set all other stretches to 0 (in case of previous layouts)
                for i in range(1, 6):
                    self.video_grid.setRowStretch(i, 0)
                    self.video_grid.setColumnStretch(i, 0)
            else:
                # Multiple cameras: uniform distribution
                for i in range(rows):
                    self.video_grid.setRowStretch(i, 1)
                for j in range(cols):
                    self.video_grid.setColumnStretch(j, 1)
                # Reset unused stretches
                for i in range(rows, 6):
                    self.video_grid.setRowStretch(i, 0)
                for j in range(cols, 6):
                    self.video_grid.setColumnStretch(j, 0)

        except Exception as e:
            self.handle_error(e, "_set_grid_stretch_factors")

    def _update_widget_geometry(self) -> None:
        """Update widget geometry and force layout refresh."""
        try:
            if hasattr(self.parent_widget, 'video_grid_widget'):
                video_grid_widget = self.parent_widget.video_grid_widget
                video_grid_widget.updateGeometry()
                video_grid_widget.update()
                video_grid_widget.adjustSize()

            self.video_grid.update()
            self.video_grid.invalidate()

        except Exception as e:
            self.handle_error(e, "_update_widget_geometry")

    # ========================================
    # Drag and Drop Operations (Week 5 Implementation)
    # ========================================

    def handle_camera_drag_start(self, camera_index: int) -> None:
        """Handle start of camera drag operation."""
        try:
            if camera_index not in self.ordered_visible_player_indices:
                self.logger.warning(f"Cannot drag camera {camera_index}: not visible")
                return

            self.signals.camera_drag_started.emit(camera_index)
            self.logger.debug(f"Camera drag started: {camera_index}")

        except Exception as e:
            self.handle_error(e, f"handle_camera_drag_start({camera_index})")

    def handle_camera_drop(self, dragged_index: int, dropped_on_index: int) -> bool:
        """
        Handle camera drop operation.

        Args:
            dragged_index: Index of camera being dragged
            dropped_on_index: Index of camera being dropped on

        Returns:
            bool: True if drop was successful
        """
        try:
            if dragged_index == dropped_on_index:
                return False

            # Perform the swap
            success = self.swap_cameras(dragged_index, dropped_on_index)

            if success:
                # Update UI layout
                self.update_ui_layout()

                # Save to settings
                self.save_layout_to_settings()

            return success

        except Exception as e:
            self.handle_error(e, f"handle_camera_drop({dragged_index}, {dropped_on_index})")
            return False

    # ========================================
    # Layout Validation and Error Recovery (Week 5 Implementation)
    # ========================================

    def validate_layout_state(self) -> Tuple[bool, str]:
        """
        Validate current layout state.

        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            # Check for valid camera indices
            for idx in self.ordered_visible_player_indices:
                if idx < 0 or idx >= 6:
                    return False, f"Invalid camera index: {idx}"

            # Check for duplicates
            if len(self.ordered_visible_player_indices) != len(set(self.ordered_visible_player_indices)):
                return False, "Duplicate camera indices in layout"

            # Check grid configuration consistency
            expected_positions = len(self.ordered_visible_player_indices)
            actual_positions = len(self.camera_positions)
            if expected_positions != actual_positions:
                return False, f"Grid position mismatch: expected {expected_positions}, got {actual_positions}"

            # Check UI component availability
            if self.video_grid is None:
                return False, "Video grid not available"

            if self.video_player_item_widgets is None:
                return False, "Video player widgets not available"

            return True, ""

        except Exception as e:
            self.handle_error(e, "validate_layout_state")
            return False, f"Validation error: {str(e)}"

    def recover_from_invalid_state(self) -> bool:
        """
        Attempt to recover from invalid layout state.

        Returns:
            bool: True if recovery was successful
        """
        try:
            self.logger.warning("Attempting layout state recovery")

            # Reset to default layout
            self.reset_to_default_layout()

            # Validate recovery
            is_valid, error_msg = self.validate_layout_state()
            if not is_valid:
                self.logger.error(f"Layout recovery failed: {error_msg}")
                self.signals.layout_validation_failed.emit(f"Recovery failed: {error_msg}")
                return False

            self.logger.info("Layout state recovery successful")
            return True

        except Exception as e:
            self.handle_error(e, "recover_from_invalid_state")
            return False

    # ========================================
    # Enhanced Error Handling & Validation (Week 5 Implementation)
    # ========================================

    def validate_ui_components(self) -> Tuple[bool, str]:
        """
        Validate that all required UI components are available.

        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            if not self.video_grid:
                return False, "Video grid widget not available"

            if not self.video_player_item_widgets:
                return False, "Video player item widgets not available"

            if len(self.video_player_item_widgets) != 6:
                return False, f"Expected 6 video player widgets, got {len(self.video_player_item_widgets)}"

            if not self.camera_visibility_checkboxes:
                return False, "Camera visibility checkboxes not available"

            if len(self.camera_visibility_checkboxes) != 6:
                return False, f"Expected 6 camera checkboxes, got {len(self.camera_visibility_checkboxes)}"

            return True, ""

        except Exception as e:
            return False, f"UI component validation error: {str(e)}"

    def validate_camera_configuration(self) -> Tuple[bool, str]:
        """
        Validate camera configuration consistency.

        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            # Check camera mapping consistency
            if len(self.camera_name_to_index) != 6:
                return False, f"Expected 6 cameras in name mapping, got {len(self.camera_name_to_index)}"

            if len(self.camera_index_to_name) != 6:
                return False, f"Expected 6 cameras in index mapping, got {len(self.camera_index_to_name)}"

            # Check checkbox info consistency
            if len(self.checkbox_info) != 6:
                return False, f"Expected 6 checkbox info entries, got {len(self.checkbox_info)}"

            # Validate checkbox info structure
            for i, (abbr, full_name, idx) in enumerate(self.checkbox_info):
                if not isinstance(abbr, str) or not abbr:
                    return False, f"Invalid abbreviation at index {i}: {abbr}"

                if not isinstance(full_name, str) or not full_name:
                    return False, f"Invalid full name at index {i}: {full_name}"

                if idx < 0 or idx >= 6:
                    return False, f"Invalid camera index at checkbox info {i}: {idx}"

            return True, ""

        except Exception as e:
            return False, f"Camera configuration validation error: {str(e)}"

    def validate_layout_consistency(self) -> Tuple[bool, str]:
        """
        Validate layout state consistency.

        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            # Check visible cameras list
            for idx in self.ordered_visible_player_indices:
                if idx < 0 or idx >= 6:
                    return False, f"Invalid camera index in visible list: {idx}"

            # Check for duplicates
            if len(self.ordered_visible_player_indices) != len(set(self.ordered_visible_player_indices)):
                return False, "Duplicate camera indices in visible list"

            # Check grid configuration
            expected_positions = len(self.ordered_visible_player_indices)
            actual_positions = len(self.camera_positions)

            if expected_positions != actual_positions:
                return False, f"Grid position count mismatch: expected {expected_positions}, got {actual_positions}"

            # Validate grid positions
            for camera_idx, (row, col) in self.camera_positions.items():
                if camera_idx not in self.ordered_visible_player_indices:
                    return False, f"Camera {camera_idx} has position but is not visible"

                if row < 0 or col < 0:
                    return False, f"Invalid grid position for camera {camera_idx}: ({row}, {col})"

            # Check grid dimensions
            if self.current_grid_rows < 0 or self.current_grid_cols < 0:
                return False, f"Invalid grid dimensions: {self.current_grid_rows}x{self.current_grid_cols}"

            return True, ""

        except Exception as e:
            return False, f"Layout consistency validation error: {str(e)}"

    def perform_comprehensive_validation(self) -> Tuple[bool, List[str]]:
        """
        Perform comprehensive validation of all layout components.

        Returns:
            Tuple of (is_valid, list_of_error_messages)
        """
        errors = []

        # Validate UI components
        ui_valid, ui_error = self.validate_ui_components()
        if not ui_valid:
            errors.append(f"UI Components: {ui_error}")

        # Validate camera configuration
        config_valid, config_error = self.validate_camera_configuration()
        if not config_valid:
            errors.append(f"Camera Configuration: {config_error}")

        # Validate layout consistency
        layout_valid, layout_error = self.validate_layout_consistency()
        if not layout_valid:
            errors.append(f"Layout Consistency: {layout_error}")

        # Validate base layout state
        base_valid, base_error = self.validate_layout_state()
        if not base_valid:
            errors.append(f"Layout State: {base_error}")

        return len(errors) == 0, errors

    def auto_recover_layout(self) -> bool:
        """
        Attempt automatic recovery from layout issues.

        Returns:
            bool: True if recovery was successful
        """
        try:
            self.logger.info("Starting automatic layout recovery")

            # Step 1: Validate current state
            is_valid, errors = self.perform_comprehensive_validation()
            if is_valid:
                self.logger.info("Layout validation passed, no recovery needed")
                return True

            self.logger.warning(f"Layout validation failed with {len(errors)} errors:")
            for error in errors:
                self.logger.warning(f"  - {error}")

            # Step 2: Attempt to fix UI component issues
            if not self.video_grid or not self.video_player_item_widgets:
                self.logger.info("Attempting to re-acquire UI components")
                if hasattr(self.parent_widget, 'video_grid'):
                    self.video_grid = self.parent_widget.video_grid
                if hasattr(self.parent_widget, 'video_player_item_widgets'):
                    self.video_player_item_widgets = self.parent_widget.video_player_item_widgets
                if hasattr(self.parent_widget, 'camera_visibility_checkboxes'):
                    self.camera_visibility_checkboxes = self.parent_widget.camera_visibility_checkboxes

            # Step 3: Reset to default layout
            self.logger.info("Resetting to default layout")
            self.reset_to_default_layout()

            # Step 4: Validate recovery
            is_valid_after, errors_after = self.perform_comprehensive_validation()
            if is_valid_after:
                self.logger.info("Automatic layout recovery successful")
                return True
            else:
                self.logger.error(f"Automatic recovery failed, {len(errors_after)} errors remain:")
                for error in errors_after:
                    self.logger.error(f"  - {error}")
                return False

        except Exception as e:
            self.handle_error(e, "auto_recover_layout")
            return False

    def get_layout_diagnostics(self) -> dict:
        """
        Get comprehensive layout diagnostics for debugging.

        Returns:
            dict: Diagnostic information
        """
        try:
            diagnostics = {
                'timestamp': self.logger.handlers[0].formatter.formatTime(self.logger.makeRecord(
                    'layout', 20, '', 0, '', (), None)) if self.logger.handlers else 'unknown',
                'manager_initialized': self.is_initialized(),
                'visible_cameras': self.ordered_visible_player_indices.copy(),
                'camera_positions': self.camera_positions.copy(),
                'grid_dimensions': (self.current_grid_rows, self.current_grid_cols),
                'ui_components': {
                    'video_grid_available': self.video_grid is not None,
                    'video_widgets_available': self.video_player_item_widgets is not None,
                    'video_widgets_count': len(self.video_player_item_widgets) if self.video_player_item_widgets else 0,
                    'checkboxes_available': self.camera_visibility_checkboxes is not None,
                    'checkboxes_count': len(self.camera_visibility_checkboxes) if self.camera_visibility_checkboxes else 0,
                },
                'validation_results': {}
            }

            # Add validation results
            is_valid, errors = self.perform_comprehensive_validation()
            diagnostics['validation_results'] = {
                'overall_valid': is_valid,
                'error_count': len(errors),
                'errors': errors
            }

            return diagnostics

        except Exception as e:
            return {
                'error': f"Failed to generate diagnostics: {str(e)}",
                'timestamp': 'unknown'
            }
