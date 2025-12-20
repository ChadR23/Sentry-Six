# Sentry Six Revamped

A modern viewer for **Tesla Dashcam & Sentry** footage featuring **multi-camera playback**, **SEI telemetry overlays** (speed, GPS, steering, G-force, and more), and an interactive route map.

https://github.com/user-attachments/assets/573f36ae-3bc7-43ad-a7c3-4c60ef822a51

## Community & Support

Have questions, feedback, or want to connect with other users?  
Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt)!

## Features

- **Easy Clip Browsing**
  - Drag & drop your `TeslaCam` folder or use the folder picker
  - Browse clips by date with a clean, organized interface
  - Supports **RecentClips**, **SentryClips**, and **SavedClips**
  - Set a default folder to load automatically on startup

- **Multi-Camera Playback**
  - View all 6 cameras at once (Front, Back, Repeaters, Pillars)
  - Click any camera to focus on it full-screen (Esc to exit)
  - Synced playback across all cameras
  - Speed control: 0.5x, 1x, 2x, 3x, 4x

- **Sentry & Saved Events**
  - Shows event reason badges (e.g., "Collision Detected", "Manual Save")
  - Displays event location on the map

- **SEI Telemetry Dashboard**
  - Live data overlay showing speed, gear, steering angle, turn signals, brake/accelerator pedals, heading, and G-force
  - GPS route tracking on an interactive map
  - Toggle between MPH and KM/H
  - Works with partial SEI data (shows "No Data" when unavailable)
  - *Requires Tesla software 2025.44.25.1 or newer on HW3+ vehicles*

- **Clip Export**
  - Export clips with hardware-accelerated encoding
  - Choose from Mobile, Medium, High, or Maximum quality
  - Set custom start/end points for trimming
  - Live progress with time and size estimates
  - *MacOS: Install ffmpeg via `brew install ffmpeg`*

- **Customizable Settings**
  - Toggle dashboard and map overlays
  - Customizable keyboard shortcuts
  - Default folder auto-load

- **Auto-Update**
  - Checks for updates on startup and installs with one click

## Requirements

- **Node.js 18+**
- Windows / MacOS / Linux

## Run from source

```bash
npm install
npm start
```

## Usage

1. Launch the app
2. Drop your **TeslaCam folder** onto the window (or click Choose Folder)
3. Pick a clip from the sidebar
4. Use playback controls and toggle overlays via the settings menu

## Notes on SEI Data

- SEI telemetry is typically not recorded while parked
- Brake/accelerator pedal data is not logged during FSD—if you see pedal activity while Autopilot is engaged, that's driver input

## Project Origin & Credits

Created by [**ChadR23**](https://github.com/ChadR23) with help from [Scottmg1](https://github.com/Scottmg1).  
Special thanks to [**Parallax**](https://github.com/DennisGarvey) and **38tu** for beta testing and feedback.

## License

MIT License - see LICENSE file for details.
