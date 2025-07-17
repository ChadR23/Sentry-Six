import os
import tempfile
import math
from datetime import datetime, timedelta

from . import utils
from .state import AppState
from .constants import (
    VIDEO_SCALE_WIDTH, VIDEO_SCALE_HEIGHT, MOBILE_EXPORT_HEIGHT,
    ENCODING_PRESET_FAST, ENCODING_PRESET_MEDIUM, ENCODING_CRF_MOBILE,
    ENCODING_CRF_DESKTOP, AUDIO_BITRATE, FFMPEG_COMMON_ARGS
)
from .resource_manager import managed_temp_file, get_resource_tracker
from .logging_config import get_logger

class FFmpegCommandBuilder:
    def __init__(self, app_state: AppState, ordered_visible_indices: list[int], camera_map: dict, is_mobile: bool, output_path: str):
        self.app_state = app_state
        self.ordered_visible_indices = ordered_visible_indices
        self.camera_map = camera_map
        self.is_mobile = is_mobile
        self.output_path = output_path
        self.temp_files = []
        self.logger = get_logger(__name__)
        self.resource_tracker = get_resource_tracker()

    def build(self) -> tuple[list[str] | None, list[str], float]:
        """Builds the FFmpeg command list and returns it, temp files, and the duration in seconds."""
        if not self.app_state.first_timestamp_of_day or self.app_state.export_state.start_ms is None or self.app_state.export_state.end_ms is None:
            return None, [], 0.0

        start_dt = self.app_state.first_timestamp_of_day + timedelta(milliseconds=self.app_state.export_state.start_ms)
        duration = (self.app_state.export_state.end_ms - self.app_state.export_state.start_ms) / 1000.0
        
        inputs = self._create_input_streams(start_dt, duration)
        if not inputs:
            return None, [], 0.0

        cmd = [utils.FFMPEG_EXE, "-y"]
        initial_filters = []
        stream_maps = []
        
        front_cam_idx = self.camera_map["front"]
        
        for i, stream_data in enumerate(inputs):
            cmd.extend(["-f", "concat", "-safe", "0", "-ss", str(stream_data["offset"]), "-i", stream_data["path"]])
            
            scale_filter = f",scale={VIDEO_SCALE_WIDTH}:{VIDEO_SCALE_HEIGHT}"
            initial_filters.append(f"[{i}:v]setpts=PTS-STARTPTS{scale_filter}[v{i}]")
            stream_maps.append(f"[v{i}]")

        main_processing_chain = []
        num_streams = len(inputs)
        w, h = (VIDEO_SCALE_WIDTH, VIDEO_SCALE_HEIGHT)
        
        if num_streams > 1:
            cols = 2 if num_streams in [2, 4] else 3 if num_streams > 2 else 1
            layout = '|'.join([f"{c*w}_{r*h}" for i in range(num_streams) for r, c in [divmod(i, cols)]])
            main_processing_chain.append(f"{''.join(stream_maps)}xstack=inputs={num_streams}:layout={layout}[stacked]")
            last_output_tag = "[stacked]"
        else:
            last_output_tag = "[v0]"
            cols = 1

        start_time_unix = start_dt.timestamp()
        basetime_us = int(start_time_unix * 1_000_000)

        drawtext_filter = (
            f"drawtext=font='Arial':expansion=strftime:basetime={basetime_us}:"
            "text='%m/%d/%Y %I\\:%M\\:%S %p':"
            "fontcolor=white:fontsize=36:box=1:boxcolor=black@0.4:boxborderw=5:"
            "x=(w-text_w)/2:y=h-th-10"
        )
        main_processing_chain.append(f"{last_output_tag}{drawtext_filter}")

        if self.is_mobile:
            total_width = w * cols
            total_height = h * math.ceil(num_streams / cols)
            mobile_width = int(MOBILE_EXPORT_HEIGHT * (total_width / total_height)) // 2 * 2
            main_processing_chain.append(f"scale={mobile_width}:{MOBILE_EXPORT_HEIGHT}")
        
        chained_processing = ",".join(main_processing_chain)
        final_video_stream = "[final_v]"
        full_filter_complex = ";".join(initial_filters) + ";" + chained_processing + final_video_stream
        
        cmd.extend(["-filter_complex", full_filter_complex, "-map", final_video_stream])
        
        audio_stream_idx = next((i for i, data in enumerate(inputs) if data["p_idx"] == front_cam_idx), -1)
        if audio_stream_idx != -1:
            cmd.extend(["-map", f"{audio_stream_idx}:a?"])
        
        v_codec = ["-c:v", "libx264", "-preset", ENCODING_PRESET_FAST, "-crf", ENCODING_CRF_MOBILE] if self.is_mobile else ["-c:v", "libx264", "-preset", ENCODING_PRESET_MEDIUM, "-crf", ENCODING_CRF_DESKTOP]
        cmd.extend(["-t", str(duration), *v_codec, "-c:a", "aac", "-b:a", AUDIO_BITRATE, self.output_path])
        
        return cmd, self.temp_files, duration

    def _create_input_streams(self, start_dt, duration):
        inputs = []
        for p_idx in self.ordered_visible_indices:
            if not self.app_state.daily_clip_collections[p_idx]:
                continue
            
            clips_in_range = []
            for p in self.app_state.daily_clip_collections[p_idx]:
                m = utils.filename_pattern.match(os.path.basename(p))
                if m:
                    s_dt = datetime.strptime(f"{m.group(1)} {m.group(2).replace('-' , ':')}", "%Y-%m-%d %H:%M:%S")
                    if s_dt < start_dt + timedelta(seconds=duration) and s_dt + timedelta(seconds=60) > start_dt:
                        clips_in_range.append((p, s_dt))
            
            if not clips_in_range:
                continue

            # Create temporary file for FFmpeg concat list
            fd, temp_path = tempfile.mkstemp(suffix=".txt", text=True)
            try:
                with os.fdopen(fd, 'w') as f:
                    for p, _ in clips_in_range:
                        f.write(f"file '{os.path.abspath(p)}'\n")

                # Register temp file with resource tracker for cleanup
                self.resource_tracker.register_temp_file(temp_path)
                self.temp_files.append(temp_path)
                self.logger.debug(f"Created concat file for camera {p_idx}: {temp_path}")

                inputs.append({
                    "p_idx": p_idx,
                    "path": temp_path,
                    "offset": max(0, (start_dt - clips_in_range[0][1]).total_seconds())
                })
            except Exception as e:
                # Clean up file descriptor if something goes wrong
                try:
                    os.close(fd)
                except OSError:
                    pass
                self.logger.error(f"Failed to create concat file for camera {p_idx}: {e}")
                raise
        return inputs