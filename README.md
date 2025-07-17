# SentrySix 

SentrySix  is a modern, feature-rich viewer and exporter for your Tesla Sentry and Dashcam footage, built with Python and PyQt6. It provides a fluid, intuitive interface to navigate, review, and export your clips with powerful tools not found in other viewers.

This project was remastered and significantly enhanced through a collaboration between Scott and Google's Gemini 2.5 Pro, building upon the excellent foundation of the original SentrySix by ChadR23.

## Community & Support

Have questions, suggestions, or want to connect with other users? Join our official Discord server!

**[Join the TeslaCam Viewer Discord Server](https://discord.com/invite/9qzezvwdnt)**

![SentrySix UI Overview](Screenshots/All_cams.png)

## 🚀 Features

-   **Synchronized 6-Camera Playback**: Watch footage from the front, back, repeaters, and pillar cameras, all perfectly in sync.
-   **Interactive Event Markers**: Automatically displays icons on the timeline for **Sentry**, **Honk**, and **User-saved** events.
    -   🖱️ **Click to Seek**: Instantly jump to any event. Sentry and User events jump 10 seconds prior to give you context.
    -   🖼️ **Hover to Preview**: Hover over an event icon to see the official `thumb.png` and the reason for the event in a tooltip.
-   **Visual Clip Exporting**:
    -   🚩 **Draggable Markers**: Set your export start and end points with draggable red and green markers directly on the timeline for frame-perfect trimming.
    -   ✨ **Live Scrubbing Preview**: Get an instant visual preview in the main video grid as you drag the markers.
-   **Flexible Layout Control**: Use the simple checkboxes in the toolbar to instantly toggle the visibility of any combination of cameras.
-   **High-Quality Exports**:
    -   Choose between **Full Resolution** for archival quality or a **Mobile-Friendly** 1080p version for easy sharing.
    -   The exported clip intelligently stitches together the camera views based on your selected layout.
-   **Advanced Playback Controls**:
    -   **Zoom & Pan**: Dynamically zoom and pan any camera view with your mouse wheel and by dragging.
    -   **Variable Speed**: Adjust playback speed from 0.25x to 4x.
    -   **Frame-by-Frame**: Step through footage one frame at a time to find the perfect shot.
    -   **15-Second Skip**: Quickly jump forward or backward in 15-second intervals.
-   **Go To Timestamp**: Jump to a precise time in the day's footage with a simple dialog that even shows a thumbnail preview.

## 📸 Layouts & UI

| Feature | Screenshot |
| :--- | :--- |
| **Event Markers & Tooltip** | ![Event Markers & Tooltip](Screenshots/even_Markers.png) |
| **Draggable Export Markers** | ![Draggable Export Marker](Screenshots/export_markers.png) |
| **All Camera View** | ![All Camera View](Screenshots/All_cams.png) |
| **Go To Time Dialog** | ![Timestamp Preview](Screenshots/go_to_time.png) |

## 📋 Requirements

-   Python 3.10+
-   PyQt6

Install all Python dependencies with:

```bash
pip install -r requirements.txt
```
## Installation  

1. Download the latest `SentrySix.exe` from the [Releases page](https://github.com/ChadR23/Sentry-Six/releases).
2. Double-click the downloaded file to run the application. No installation or Python required.
3. (Optional) Pin the app to your taskbar for easy access.
4. To check for updates, use the "Check for Updates" button in the app. If a new version is available, the app will guide you through the update process.

## FFmpeg

FFmpeg is now bundled with Sentry-Six and managed automatically by the application. No manual installation or PATH configuration is required.

## 🛠️ Usage

1.  Launch the application by running **main.py**.
2.  Click **“Select Clips Folder”** and navigate to your `TeslaCam` folder (which contains `SavedClips` and/or `SentryClips`).
3.  Click the **Date** dropdown and select the date you want to review.
4.  Use the playback controls, event markers, and timeline to find your desired footage.
5.  To export:
    -   Move the timeline scrubber to your desired start point and click **Set Start**.
    -   Move to your desired end point and click **Set End**.
    -   Fine-tune by dragging the green and red markers on the timeline.
    -   Click **Export Clip** and choose your resolution.

## ⚠️ Disclaimer

SentrySix is an open-source utility provided as-is, with no warranties or guarantees. By using this software, you accept that you are doing so at your own risk. The developers are not responsible for any data loss, system behavior, or other unexpected issues that may arise.

It is always recommended to have a backup of your important TeslaCam footage before performing any file operations.

## 🗺️ Roadmap

This project is actively developed. Here are some ideas for the future:

-   [ ] Display GPS data from `event.json` on a map widget.
-   [ ] Option to burn-in camera name labels (e.g., "Front", "Left Repeater") on exported videos.
-   [ ] Support for exporting clips as GIFs or image sequences.
-   [ ] Drag-and-drop support for clip folders.
-   [ ] Add Model Y (Juniper) front bumper camera support if/when it's used for Sentry/Dashcam.

## 🙌 Contributing

Contributions are welcome! Whether it's reporting a bug, suggesting a feature, or writing code, your help is appreciated. Please feel free to open an issue or submit a pull request on the project's GitHub repository.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ❤️ Credits

-   **Original Concept & Code:** ChadR23
-   **Remaster & Feature Development:** A collaborative effort between Scott and Google's Gemini 2.5 Pro AI.
