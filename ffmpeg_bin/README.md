# FFmpeg Binaries

This folder should contain FFmpeg binaries for video export functionality.

## Directory Structure

```
ffmpeg_bin/
├── ffmpeg.exe      # Windows FFmpeg
├── ffprobe.exe     # Windows FFprobe
└── mac/
    ├── ffmpeg      # macOS FFmpeg
    └── ffprobe     # macOS FFprobe (optional)
```

## How to Get FFmpeg

### macOS (Homebrew)
```bash
brew install ffmpeg
```
The app will automatically detect FFmpeg from Homebrew paths.

### Windows
Download from https://ffmpeg.org/download.html and place the binaries here.

### Linux
```bash
sudo apt install ffmpeg  # Debian/Ubuntu
sudo dnf install ffmpeg  # Fedora
```

## System FFmpeg

If FFmpeg is not found in this directory, the app will fall back to system FFmpeg if it's in your PATH.
