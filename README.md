# Sentry Six Revamped

**Sentry Six SEI Revamped** is an Electron-based viewer for **Tesla Dashcam / Sentry** footage with a modern UI, **multi-camera playback**, and **SEI telemetry** (GPS/speed/steering/accel, etc.) overlaid as a dashboard + map.

This repository is a **complete overhaul** of the older Sentry-Six Electron project: some previous features are intentionally not present yet, and new capabilities (notably **SEI data support**) are a core focus of this version.

https://github.com/user-attachments/assets/573f36ae-3bc7-43ad-a7c3-4c60ef822a51

## Community & Support

Have questions, feedback, or want to connect with other users and developers?  
Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt) for real-time support and discussion!

## Features (current)

- **TeslaCam folder ingest**
  - Drag & drop a `TeslaCam` folder (or use the folder picker)
  - **Hierarchical clip browser** with date picker
  - Supports **RecentClips**, **SentryClips**, and **SavedClips** folder structures
- **Multi-camera playback**
  - 6-camera grid layouts (Front/Back/Repeaters/Pillars)
  - Click a tile to **focus** that camera (Esc/click again to exit)
  - Smooth “native video” playback with synced camera playback.
  - Adjustable playback speed (0.5x, 1x, 2x, 3x, 4x)
- **SentryClips & SavedClips support**
  - Automatically parses `event.json` metadata for each event
  - Displays **event location on map** using estimated GPS coordinates from event.json
  - Shows **event reason badges** for SavedClips (e.g., "Auto Emergency Braking", "Collision Detected", "Manual Save")
- **SEI telemetry (new in this overhaul)**
  - Support for Tesla's new SEI Metadata that was added to HW3 and newer vehicles as part of the 2025 Holiday Update. (Requires 2025.44.25.1 or newer)
  - Dashboard overlay for common signals (speed, gear, steering, blinkers, brake, accelerator, heading, G-force, GPS, etc.)
  - **Metric toggle** (MPH / KM/H)
  - **Partial SEI support** - clips that only have SEI data for part of the video (e.g., parked then started driving) will show data when available and "No Data" when not
- **GPS map**
  - Builds a route polyline from SEI GPS points
  - Shows static location marker for Sentry/Saved events (from event.json)
  - Floating, draggable map panel (Leaflet)
- **Clip Exporting**
  - Hardware Acceleration: Enables GPU encoding when supported.
  - Live Estimates: See export progress, duration, and size predictions.
  - Adjustable Quality: Select Maximum Quality for best video quality, or a lower quality for easier sharing with smaller file sizes.
  - For MacOS users, ensure you have the latest version of ffmpeg installed. (You can use Homebrew to install it: `brew install ffmpeg`)
- **Auto-Update**
  - Automatically checks for updates from the GitHub repository on app startup
  - Shows a prompt when a new version is available with commit details
  - Downloads and installs updates with progress indicator
  - Updates all files including source code, README, and configuration files
  - After update completes, click the Exit button and restart with `npm start`


## What’s intentionally not here (yet)

- **Timelapse / burn-in overlays** are **not implemented** in this revamped codebase right now.

## Requirements

- **Node.js 18+**
- macOS / Windows

## Run from source

```bash
npm install
npm start
```

Other scripts:

- `npm run dev`: same as start (convenience)
- `npm run build`: package via `electron-builder` (outputs to `release/`)

## Usage

1. Launch the app.
2. Drop a **TeslaCam folder** onto the window, or click **Choose Folder**.
3. Select a clip (or a Sentry event collection) from the **Clips** panel.
4. Use the playback controls (play/pause, skip, playback speed).
5. Toggle **Dashboard** and **Map** overlays as desired.

## SEI telemetry notes

- Not all footage includes complete or valid SEI data; SEI telemetry is typically not recorded while the vehicle is parked.
- Certain signals, such as accelerator pedal and brake pedal data, are not logged when Full Self Driving (FSD) is engaged. If you see an accelerator or brake pedal press registered during Self Driving, this indicates the input was made by the driver, not the automated system.

## Project Origin & Credits

This project was created and concepted by [**ChadR23**](https://github.com/ChadR23). It also benefited from help by [Scottmg1](https://github.com/Scottmg1) and use of the **OpenAI Opus 4.5 AI Model** during development.

Special thanks to [**Parallax**](https://github.com/DennisGarvey) and **38tu** for hands-on beta testing and invaluable feedback.

## License

This project is licensed under the MIT License - see the LICENSE file for details.


