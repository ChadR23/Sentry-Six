# FFmpeg Binaries

This folder contains FFmpeg binaries for video export functionality.

## Platform-Specific Setup

### Windows
FFmpeg binaries (`ffmpeg.exe`, `ffprobe.exe`) are bundled with the app installer.
No additional setup required.

### macOS
FFmpeg binaries can be bundled with the macOS app (recommended) or installed via Homebrew as fallback.

**Option 1: Bundled (Recommended for Distribution)**

Place the following files in this `ffmpeg_bin/` folder:
- `ffmpeg` (macOS binary, no extension)
- `ffprobe` (macOS binary, no extension)

To obtain universal macOS binaries (works on both Intel and Apple Silicon):
```bash
# Download from https://evermeet.cx/ffmpeg/ or build universal binaries:
# 1. Download ffmpeg and ffprobe from evermeet.cx/ffmpeg (select "universal" build)
# 2. Extract and copy ffmpeg + ffprobe to this ffmpeg_bin/ folder
# 3. Make executable: chmod +x ffmpeg ffprobe
```

The app checks bundled paths first, then falls back to system installations.

**Option 2: Homebrew (Fallback)**
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install FFmpeg
brew install ffmpeg
```

The app automatically detects FFmpeg from these locations (in order):
1. Bundled: `ffmpeg_bin/ffmpeg` (development) or `Resources/ffmpeg_bin/ffmpeg` (packaged)
2. Homebrew: `/opt/homebrew/bin/ffmpeg` (Apple Silicon) or `/usr/local/bin/ffmpeg` (Intel)
3. MacPorts: `/opt/local/bin/ffmpeg`

### Linux
```bash
sudo apt install ffmpeg  # Debian/Ubuntu
sudo dnf install ffmpeg  # Fedora
sudo pacman -S ffmpeg    # Arch Linux
```

## Verification

To verify FFmpeg is installed correctly:
```bash
ffmpeg -version
```

## Troubleshooting

**macOS: "FFmpeg not found" after installing via Homebrew**
- Restart the app after installing FFmpeg
- If using Apple Silicon, ensure Homebrew is installed at `/opt/homebrew`
- Run `which ffmpeg` in Terminal to verify the installation path

**Windows: FFmpeg not detected**
- Ensure `ffmpeg.exe` is in the `ffmpeg_bin` folder
- Re-install the app if the bundled FFmpeg is missing
