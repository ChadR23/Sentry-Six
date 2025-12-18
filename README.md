# Sentry Six Revamped

**Sentry Six SEI Revamped** is an Electron-based viewer for **Tesla Dashcam / Sentry** footage with a modern UI, **multi-camera playback**, and **SEI telemetry** (GPS/speed/steering/accel, etc.) overlaid as a dashboard + map.

This repository is a **complete overhaul** of the older Sentry-Six Electron project: some previous features are intentionally not present yet, and new capabilities (notably **SEI data support**) are a core focus of this version.

## Community & Support

Have questions, feedback, or want to connect with other users and developers?  
Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt) for real-time support and discussion!

![SentrySix Revamped UI Overview](assets/uioverview.png)

## Features (current)

- **TeslaCam folder ingest**
  - Drag & drop a `TeslaCam` folder (or use the folder picker)
- **Multi-camera playback**
  - 6-camera grid layouts (Front/Back/Repeaters/Pillars)
  - Click a tile to **focus** that camera (Esc/click again to exit)
  - Smooth “native video” playback with synced camera playback.
- **SEI telemetry (new in this overhaul)**
  - Support for Tesla's new SEI Metadata that was added to HW3 and newer vehicles as part of the 2025 Holiday Update. (Requires 2025.44.25.1 or newer)
  - Dashboard overlay for common signals (speed, gear, steering, blinkers, brake, accelerator, heading, G-force, GPS, etc.)
  - **Metric toggle** (MPH / KM/H)
- **GPS map**
  - Builds a route polyline from SEI GPS points
  - Floating, draggable map panel (Leaflet)

## What’s intentionally not here (yet)

- **FFmpeg exporting / timelapse / burn-in overlays** (present in older versions) are **not implemented** in this revamped codebase right now.

## Requirements

- **Node.js 18+**
- macOS / Windows / Linux

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


