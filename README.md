# Sentry Six Revamped
#### View all six cameras simultaneously. Visualize SEI telemetry data. Export clips with hardware acceleration. All in one beautiful app.

Sentry Six is a modern, feature‑rich viewer and exporter for your TeslaCam. View sentry and dashcam events with an easy-to-use UI! Trim and export your clips with ease with a variety of options - from camera layouts to a telemetry overlay. Use it on your preferred OS - Windows, MacOS, or Linux.

https://github.com/user-attachments/assets/573f36ae-3bc7-43ad-a7c3-4c60ef822a51

## Features
- **Simple UI**
  - Select your TeslaCam folder using the folder explorer
  - Select a default folder in the settings
  - Easily browse files by date
  - Supports Recent, Sentry, and Saved Clips
  - Event Triggers (e.g. "Manual Save", "Sentry", etc.)

    <img width="176.5" height="275.5" alt="image" src="https://github.com/user-attachments/assets/1b2f3970-965b-431a-b1c9-073a7fd30800" />

- **Multi-Camera Playback**
  - View all cameras at once
    - Front, Back, B-Pillars (HW4/AI4+), Repeaters
  - Synced playback across all cameras
  - Focus on the details with speed controls, from half speed (0.5x) to 4x.
 
- **SEI Telemetry**
  - Visualize the car's actions
    - See data such as speed, gear, autopilot status, and more
  - GPS data
    - See the path your car took during the clip
  - *Requirements for SEI Telemetry*
    - *2025.44.25 or newer*
    - *Hardware 3 (HW3/AI3) or newer*

  ![Dashboard](https://github.com/user-attachments/assets/6bc6ff11-0066-427f-b2ab-c95530eaa2e3)

- **Clip Exporting**
  - Trim clips with ease using in/out points
  - Hardware-accelerated encoding
  - Pick different export qualities
    - Mobile, Medium, High, Maximum
  - Add the SEI overlay to your export
    - Choose either between the full and compact overlays
    - Overlay is pre-rendered for optimal performance
  - Use blur zones to ensure privacy
    - *Currently cannot be used with the overlay*

  <img width="208.5" height="299" alt="ClipExport" src="https://github.com/user-attachments/assets/525a20d2-447b-44c6-8396-55159c29a555" />

- **Customizable Settings**
  - Adjustable glass blur intensity
  - Toggle between metric or imperial measurements (Km/H or MPH)
  - Keyboard shortcuts
  - Switch between stable and dev branches
  - Event Highlights
    - See which camera was triggered, visualized with a yellow or red highlight

  <img width="220.4" height="395.1" alt="image" src="https://github.com/user-attachments/assets/17f2ca3b-93ff-47e0-af38-e42feee02cea" />

- **Auto Update**
  - Checks for new updates on start up with a one-click install.
    - You can also check for updates via the settings

## Privacy & Updates

Sentry Six keeps things simple and respects your privacy:

- **Automatic Updates**: The app checks for updates to keep running smoothly with the latest features
- **Anonymous Version Stats**: A random ID helps us see which versions are most popular so we can fix bugs faster
- **No Personal Info**: We never collect or send any personal information to our servers
- **First-Time Notice**: You'll see a one-time notification about these features when you first launch the app

This helps us improve Sentry Six while keeping everything private and transparent.

## Community & Support

Have questions, feedback, or want to connect with other users?

Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt)!

## Requirements
- Windows / MacOS 10.12+ / Linux

## Automatic Installation for Windows & MacOS (Recommended, easiest)
1. Go to the Sentry Six [Releases](https://github.com/ChadR23/Sentry-Six/releases/) page
2. Download the SentrySixRevampedSetup.exe (SentrySixRevamped.dmg for MacOS) 
3. Run the installer
4. Run Sentry Six Revamped

**Note for macOS users:** You may encounter a security warning because this app is not digitally signed. As this is an open-source project, we do not maintain a paid subscription to the Apple Developer Program. To launch the app, navigate to **System Settings > Privacy & Security**, scroll down, and click **"Open Anyway."**

 <img width="245.5" height="96.5" alt="Screenshot_2026-01-02_at_1 17 05_PM" src="https://github.com/user-attachments/assets/81c21fef-6eb6-49c9-a0d3-75765eb32685" />


## Manual Installation

1. Install [node.js](https://nodejs.org/en/download)
2. Extract Sentry Six to your desired location.
3. Open a new Terminal (Command Prompt or Power Shell) and head to the Sentry Six folder `cd C:\users\yourname\downloads\Sentry-Six-Revamped`
4. In your Sentry Six folder, use the following command: `npm install`
6. To run Sentry Six, use `npm start`

## Usage

1. Launch the app
2. Select your **TeslaCam folder**
3. Pick a clip from the sidebar
4. Use the playback controls and in/out markers to select the part of the clip you'd like to export.

## Notes
- SEI telemetry is typically not recorded while parked
- SEI telemetry while using Smart Summon will be notated as manual
- Brake/accelerator pedal data is not logged during Self Driving. Pedal activity while Autopilot/Self Driving is engaged indicates driver input.

## Project Origin & Credits

This project was created and concepted by [**ChadR23**](https://github.com/ChadR23). It also benefited from help by [**Scottmg1**](https://github.com/Scottmg1) and use of the **Claude Opus 4.5 AI Model** during development.

Special thanks to [**Parallax**](https://github.com/DennisGarvey), [**JeffFromTheIRS**](https://github.com/JeffFromTheIRS) and **38tu** for hands-on beta testing and invaluable feedback.

## License

MIT License - see LICENSE file for details.
