# Sentry-Six for Unraid

Sentry-Six is now available as a Docker container for Unraid servers with easy WebUI access!

## Quick Install (Community Apps)

1. **Open Community Applications** in your Unraid server
2. **Search for:** "Sentry-Six" or "Tesla"
3. **Click "Install"** on the Sentry-Six app
4. **Configure paths:**
   - Config Path: `/mnt/user/appdata/sentry-six`
   - Tesla Footage: `/mnt/user/TeslaCam` (or your footage location)
5. **Click "Apply"**

## Manual Install

If you can't find it in Community Apps:

1. **Docker** → **Add Container**
2. **Repository:** `chadr23/sentry-six:latest`
3. **Name:** `sentry-six`
4. **WebUI:** `http://[IP]:5800`

### Port Settings
- **WebUI Port:** `5800:5800` (Primary access)
- **VNC Port:** `5900:5900` (Optional direct VNC)

### Volume Settings
- **Config:** `/mnt/user/appdata/sentry-six` → `/config`
- **Tesla Footage:** `/mnt/user/TeslaCam` → `/data`

### Environment Variables
- `DISPLAY_WIDTH`: `1400`
- `DISPLAY_HEIGHT`: `900`
- `DARK_MODE`: `1`
- `TZ`: `America/New_York` (your timezone)

### Extra Parameters
```
--shm-size=2g --security-opt seccomp=unconfined
```

## Access

Once running, access the WebUI at: **http://[your-unraid-ip]:5800**

## First Setup

1. You'll see the **Welcome Screen** with Terms & Conditions
2. Click **Accept & Continue** to:
   - Complete first run setup
   - Enable anonymous analytics (helps improve the app)
   - Generate persistent machine ID
3. Browse to your Tesla footage using the folder picker
4. Start viewing your Sentry Mode and Dashcam recordings!

## Features

- 📹 **Multi-camera synchronized playback**
- 🗂️ **Browse footage by date and event type**
- 🎬 **Export clips with custom layouts**
- 🚗 **Automatic event detection**
- 🌐 **Web-based interface** (no software installation needed)
- 💾 **Persistent settings** across container updates

## Troubleshooting

### Container Won't Start
- Check Docker logs: **Docker** → click container name → **Logs**
- Ensure volumes exist: `/mnt/user/appdata/sentry-six` and your Tesla footage path
- Verify ports 5800/5900 aren't in use

### WebUI Not Loading
- Try accessing via IP: `http://192.168.1.10:5800` (use your Unraid IP)
- Check if container is running in Docker tab
- Wait 1-2 minutes after starting for full initialization

### Can't Access Tesla Footage
- Verify your Tesla footage path is correct
- Check permissions on the TeslaCam folder
- Ensure `/data` volume maps to your actual Tesla footage location

## Support

- **Issues:** https://github.com/ChadR23/Sentry-Six/issues
- **Discussions:** https://github.com/ChadR23/Sentry-Six/discussions
- **Documentation:** https://github.com/ChadR23/Sentry-Six/blob/main/DOCKER.md

## How It Works

Sentry-Six uses a "GUI-in-Browser" approach:
- Runs Electron app in Docker container
- Uses virtual display (Xvfb) 
- Streams interface to browser via noVNC
- No need to rewrite as separate web app

This provides the full desktop experience in your web browser!
