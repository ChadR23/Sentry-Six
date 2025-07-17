from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class ExportState:
    """Holds the state for a video export operation."""
    start_ms: int | None = None
    end_ms: int | None = None

@dataclass
class PlaybackState:
    """Holds the state for the current playback segment."""
    clip_indices: list[int] = field(default_factory=lambda: [-1] * 6)
    segment_start_ms: int = 0

@dataclass
class TimelineData:
    """Holds the results of a timeline scan."""
    daily_clip_collections: list[list[str]]
    events: list[dict]
    first_timestamp_of_day: datetime | None
    total_duration_ms: int
    error: str | None = None

@dataclass
class AppState:
    """Holds the primary state for the application."""
    root_clips_path: str | None = None
    first_timestamp_of_day: datetime | None = None
    is_daily_view_active: bool = False
    daily_clip_collections: list[list[str]] = field(default_factory=lambda: [[] for _ in range(6)])
    
    # Nested state objects
    playback_state: PlaybackState = field(default_factory=PlaybackState)
    export_state: ExportState = field(default_factory=ExportState)