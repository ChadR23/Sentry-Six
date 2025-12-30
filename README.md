# Sentry Six Revamped

A modern viewer for **Tesla Dashcam & Sentry** footage featuring **multi-camera playback**, **SEI telemetry overlays** (speed, GPS, steering, G-force, and more), and a route map.

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
   <img width="404" height="221.6" alt="SEIDashboard" src="https://github.com/user-attachments/assets/0f367d16-2f98-4d0b-b6a9-4b40e994a7fe" />

- **Clip Export**
  - Export clips with hardware-accelerated GPU encoding (NVENC/HEVC)
  - Dashboard overlay rendering during export
  - Choose from Mobile, Medium, High, or Maximum quality
  - Customizable camera layout with drag-and-drop arrangement
  - Set custom start/end points for trimming
  - Live progress with time and size estimates
  - *MacOS: Install ffmpeg via `brew install ffmpeg`*
   <img width="208.5" height="299" alt="ClipExport" src="https://github.com/user-attachments/assets/525a20d2-447b-44c6-8396-55159c29a555" />

- **Customizable Settings**
  - Toggle dashboard and map overlays
  - Adjustable glass blur intensity
  - Customizable keyboard shortcuts
  - Default TeslaCam folder auto-load
  - View changelog from settings
   <img width="205.5" height="303" alt="Settings" src="https://github.com/user-attachments/assets/bc90c81a-1bf5-4807-844d-2a4c6bed5070" />

- **Auto-Update**
  - Checks for updates on startup and installs with one click
  - Shows changelog with release notes for each version
   <img width="214" height="248" alt="AutoUpdate" src="https://github.com/user-attachments/assets/1c96f5d6-367b-493d-9fa3-d92a72f2080d" />

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
- Brake/accelerator pedal data is not logged during Self Driving. If you see pedal activity while Autopilot/Self Driving is engaged, that's driver input.

## Project Origin & Credits

This project was created and concepted by [**ChadR23**](https://github.com/ChadR23). It also benefited from help by [Scottmg1](https://github.com/Scottmg1) and use of the **OpenAI Opus 4.5 AI Model** during development.

Special thanks to [**Parallax**](https://github.com/DennisGarvey) and **38tu** for hands-on beta testing and invaluable feedback.

## License

MIT License - see LICENSE file for details.
