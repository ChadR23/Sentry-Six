# FFmpeg Binaries

This folder contains FFmpeg binaries for video export functionality.

## Platform-Specific Setup

### Windows
FFmpeg binaries (`ffmpeg.exe`, `ffprobe.exe`) are bundled with the app installer.
No additional setup required.

### macOS
FFmpeg is **NOT bundled** with the macOS app due to licensing and size constraints.

**Install via Homebrew (recommended):**
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install FFmpeg
brew install ffmpeg
```

The app automatically detects FFmpeg from these locations:
- `/opt/homebrew/bin/ffmpeg` (Apple Silicon Macs)
- `/usr/local/bin/ffmpeg` (Intel Macs)
- `/opt/local/bin/ffmpeg` (MacPorts)

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
