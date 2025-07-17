import os
import subprocess
import platform
from typing import Optional, Tuple
from PyQt6.QtMultimedia import QMediaPlayer
from PyQt6.QtCore import QSettings

class HWAccDetector:
    """Hardware acceleration detector for video decoding"""
    
    def __init__(self):
        self.gpu_type = None
        self.hwacc_available = False
        self.hwacc_method = None
        self.debug_info = []
        
    def detect_gpu(self) -> Tuple[Optional[str], bool]:
        """Detect GPU type and availability"""
        try:
            if platform.system() == "Windows":
                return self._detect_gpu_windows()
            elif platform.system() == "Darwin":  # macOS
                return self._detect_gpu_macos()
            else:
                self.debug_info.append(f"Unsupported platform: {platform.system()}")
                return None, False
        except Exception as e:
            self.debug_info.append(f"GPU detection error: {e}")
            return None, False
    
    def _detect_gpu_windows(self) -> Tuple[Optional[str], bool]:
        """Detect GPU on Windows using wmic"""
        try:
            # Check for NVIDIA GPU
            result = subprocess.run(
                ["wmic", "path", "win32_VideoController", "get", "name"],
                capture_output=True, text=True, timeout=5
            )
            
            if result.returncode == 0:
                output = result.stdout.lower()
                if "nvidia" in output:
                    self.debug_info.append("Found NVIDIA GPU")
                    return "nvidia", True
                elif "amd" in output or "radeon" in output:
                    self.debug_info.append("Found AMD GPU")
                    return "amd", True
                elif "intel" in output:
                    self.debug_info.append("Found Intel GPU")
                    return "intel", True
                else:
                    self.debug_info.append(f"GPU detection output: {output}")
            
        except Exception as e:
            self.debug_info.append(f"Windows GPU detection error: {e}")
        
        return None, False
    

    
    def _detect_gpu_macos(self) -> Tuple[Optional[str], bool]:
        """Detect GPU on macOS using system_profiler"""
        try:
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType"],
                capture_output=True, text=True, timeout=5
            )
            
            if result.returncode == 0:
                output = result.stdout.lower()
                if "nvidia" in output:
                    self.debug_info.append("Found NVIDIA GPU")
                    return "nvidia", True
                elif "amd" in output or "radeon" in output:
                    self.debug_info.append("Found AMD GPU")
                    return "amd", True
                elif "intel" in output:
                    self.debug_info.append("Found Intel GPU")
                    return "intel", True
                else:
                    self.debug_info.append(f"macOS GPU detection output: {output}")
            
        except Exception as e:
            self.debug_info.append(f"macOS GPU detection error: {e}")
        
        return None, False
    
    def test_ffmpeg_hwacc(self, gpu_type: str) -> bool:
        """Test if FFmpeg supports hardware acceleration for the detected GPU"""
        try:
            from .ffmpeg_manager import FFMPEG_EXE
            
            if not os.path.exists(FFMPEG_EXE):
                self.debug_info.append("FFmpeg not found, cannot test hardware acceleration")
                return False
            
            # Test hardware acceleration encoders
            hwacc_encoders = {
                "nvidia": ["h264_nvenc", "hevc_nvenc"],
                "amd": ["h264_amf", "hevc_amf"],
                "intel": ["h264_qsv", "hevc_qsv"]
            }
            
            encoders = hwacc_encoders.get(gpu_type, [])
            
            for encoder in encoders:
                result = subprocess.run(
                    [FFMPEG_EXE, "-hide_banner", "-encoders"],
                    capture_output=True, text=True, timeout=5
                )
                
                if result.returncode == 0 and encoder in result.stdout:
                    self.debug_info.append(f"FFmpeg supports {encoder}")
                    return True
            
            self.debug_info.append(f"No hardware acceleration encoders found for {gpu_type}")
            return False
            
        except Exception as e:
            self.debug_info.append(f"FFmpeg hardware acceleration test error: {e}")
            return False
    
    def configure_media_player_hwacc(self, player: QMediaPlayer, gpu_type: str) -> bool:
        """Configure QMediaPlayer for hardware acceleration"""
        try:
            # Set hardware acceleration hints based on GPU type
            if gpu_type == "nvidia":
                # NVIDIA hardware acceleration
                player.setProperty("video.surface_type", "OpenGLSurface")
                self.debug_info.append("Configured NVIDIA hardware acceleration")
                return True
            elif gpu_type == "amd":
                # AMD hardware acceleration
                player.setProperty("video.surface_type", "OpenGLSurface")
                self.debug_info.append("Configured AMD hardware acceleration")
                return True
            elif gpu_type == "intel":
                # Intel Quick Sync
                player.setProperty("video.surface_type", "OpenGLSurface")
                self.debug_info.append("Configured Intel Quick Sync acceleration")
                return True
            else:
                self.debug_info.append(f"Unknown GPU type: {gpu_type}")
                return False
                
        except Exception as e:
            self.debug_info.append(f"Media player hardware acceleration configuration error: {e}")
            return False
    
    def detect_and_configure(self) -> Tuple[Optional[str], bool]:
        """Main method to detect GPU and configure hardware acceleration"""
        self.debug_info.append("=== Hardware Acceleration Detection ===")
        
        # Detect GPU
        gpu_type, gpu_available = self.detect_gpu()
        
        if not gpu_available:
            self.debug_info.append("No compatible GPU detected, using CPU decoding")
            return None, False
        
        self.debug_info.append(f"GPU detected: {gpu_type}")
        
        # Test FFmpeg hardware acceleration support
        if gpu_type and self.test_ffmpeg_hwacc(gpu_type):
            self.debug_info.append(f"Hardware acceleration available for {gpu_type}")
            self.gpu_type = gpu_type
            self.hwacc_available = True
            self.hwacc_method = f"{gpu_type}_hwacc"
            return gpu_type, True
        else:
            if gpu_type:
                self.debug_info.append(f"Hardware acceleration not available for {gpu_type}, falling back to CPU")
            else:
                self.debug_info.append("No GPU detected, falling back to CPU")
            return gpu_type, False
    
    def get_debug_info(self) -> list:
        """Get debug information about hardware acceleration detection"""
        return self.debug_info.copy()
    
    def print_debug_info(self):
        """Print debug information to console"""
        for info in self.debug_info:
            print(f"[HWACC] {info}")

# Global instance for easy access
hwacc_detector = HWAccDetector() 