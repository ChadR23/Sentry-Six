# Sentry-Six Docker Deployment Guide

Run Sentry-Six on your server (Unraid, Synology, NAS) with a browser-based WebUI.

## Quick Start

### Using Docker Compose (Recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/ChadR23/Sentry-Six.git
   cd Sentry-Six
   ```

2. Edit `docker-compose.yml` to set your Tesla footage path:
   ```yaml
   volumes:
     - ./config:/config
     - /path/to/your/TeslaCam:/data  # Change this!
   ```

3. Start the container:
   ```bash
   docker-compose up -d
   ```

4. Access the WebUI at: **http://localhost:5800**

### Using Docker Run

```bash
docker run -d \
  --name sentry-six \
  -p 5800:5800 \
  -p 5900:5900 \
  -v /path/to/config:/config \
  -v /path/to/TeslaCam:/data \
  --shm-size=2g \
  --security-opt seccomp=unconfined \
  ghcr.io/chadr23/sentry-six:latest
```

## Volume Mappings

| Container Path | Purpose | Required |
|----------------|---------|----------|
| `/config` | Settings, machine ID, diagnostics | Yes |
| `/data` | Tesla footage (TeslaCam folder) | Yes |

### /config Volume
Stores persistent application data:
- `settings.json` - Application settings (firstRunComplete, analyticsEnabled, etc.)
- `.machine-id` - Persistent machine identifier for telemetry
- `diagnostics/` - Diagnostic reports

**Important:** Map this to a persistent location to preserve settings across container updates.

### /data Volume
Mount your Tesla footage directory here. This should be the folder containing your TeslaCam recordings (SentryClips, SavedClips, RecentClips folders).

## Port Mappings

| Port | Protocol | Purpose |
|------|----------|---------|
| 5800 | TCP | WebUI (noVNC) - Primary access |
| 5900 | TCP | VNC (optional) - Direct VNC client |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DISPLAY_WIDTH` | 1400 | Application window width |
| `DISPLAY_HEIGHT` | 900 | Application window height |
| `DARK_MODE` | 1 | Enable dark mode (1=on, 0=off) |
| `KEEP_APP_RUNNING` | 1 | Auto-restart on crash |
| `TZ` | America/New_York | Container timezone |
| `USER_ID` | 99 | User ID for file permissions |
| `GROUP_ID` | 100 | Group ID for file permissions |

## Platform-Specific Instructions

### Unraid

1. Go to **Apps** → **Search** for "Sentry-Six" (if in Community Apps)
   
   Or manually add via **Docker** → **Add Container**:
   - Repository: `ghcr.io/chadr23/sentry-six:latest`
   - Use the template from `docker/sentry-six.xml`

2. Configure paths:
   - Config Path: `/mnt/user/appdata/sentry-six`
   - Tesla Footage: `/mnt/user/TeslaCam` (or your footage location)

3. Set Extra Parameters:
   ```
   --shm-size=2g --security-opt seccomp=unconfined
   ```

4. Click **Apply**

### Synology NAS

1. Open **Container Manager** (or Docker package)

2. Go to **Registry** → Search for `ghcr.io/chadr23/sentry-six`

3. Download the image

4. Create container with these settings:
   - **Port Settings:**
     - Local 5800 → Container 5800
     - Local 5900 → Container 5900
   - **Volume Settings:**
     - `/docker/sentry-six/config` → `/config`
     - `/volume1/TeslaCam` → `/data`
   - **Environment:**
     - Add variables as needed from table above

5. In **Advanced Settings** → **Execution Command**, add:
   ```
   --shm-size=2g
   ```

### QNAP NAS

1. Open **Container Station**

2. Go to **Images** → **Pull** → Enter `ghcr.io/chadr23/sentry-six:latest`

3. Create container with volume and port mappings as described above

## Building from Source

```bash
# Clone repository
git clone https://github.com/ChadR23/Sentry-Six.git
cd Sentry-Six

# Build Docker image
docker build -t sentry-six:local .

# Run with docker-compose
docker-compose up -d
```

## First Run Setup

1. Access the WebUI at `http://your-server-ip:5800`

2. You'll see the **Welcome Screen** with Terms & Conditions

3. Click **Accept & Continue** to:
   - Set `firstRunComplete: true`
   - Enable anonymous analytics (helps improve the app)
   - Generate a persistent machine fingerprint

4. Browse to your Tesla footage using the folder picker
   - In Docker, navigate to `/data` which maps to your TeslaCam folder

## Troubleshooting

### Black Screen / App Won't Start

1. Check container logs:
   ```bash
   docker logs sentry-six
   ```

2. Ensure shared memory is sufficient:
   ```bash
   docker run --shm-size=2g ...
   ```

3. Verify security options:
   ```bash
   docker run --security-opt seccomp=unconfined ...
   ```

### Permission Issues

If you can't access files in `/data`:

1. Check the USER_ID and GROUP_ID environment variables
2. Ensure they match the owner of your Tesla footage directory:
   ```bash
   ls -la /path/to/TeslaCam
   ```

### Settings Not Persisting

Ensure `/config` is properly mounted to a persistent location:
```bash
docker inspect sentry-six | grep -A5 "Mounts"
```

### WebUI Not Loading

1. Verify port 5800 is not in use:
   ```bash
   netstat -tlnp | grep 5800
   ```

2. Check firewall rules allow access to port 5800

3. Try accessing via IP instead of hostname

## Machine ID & Telemetry

The Docker container generates a persistent machine ID stored in `/config/.machine-id`. This ensures:

- Consistent fingerprint across container rebuilds
- Proper recognition by the Sentry-Six API
- Analytics continuity (if enabled)

**Do not delete** the `.machine-id` file unless you want to reset your installation identity.

## Updating

### Docker Compose
```bash
docker-compose pull
docker-compose up -d
```

### Docker Run
```bash
docker pull ghcr.io/chadr23/sentry-six:latest
docker stop sentry-six
docker rm sentry-six
# Re-run your docker run command
```

## Support

- **Issues:** https://github.com/ChadR23/Sentry-Six/issues
- **Discussions:** https://github.com/ChadR23/Sentry-Six/discussions

## Architecture

The Docker implementation uses a "GUI-in-Browser" approach:

```
┌─────────────────────────────────────────────────┐
│  Docker Container                               │
│  ┌───────────────────────────────────────────┐  │
│  │  jlesage/baseimage-gui                    │  │
│  │  ┌─────────────┐  ┌─────────────────────┐ │  │
│  │  │   Xvfb      │  │   noVNC/websockify  │ │  │
│  │  │  (Virtual   │──│   (WebSocket to     │ │  │
│  │  │   Display)  │  │    VNC bridge)      │ │  │
│  │  └─────────────┘  └─────────────────────┘ │  │
│  │        │                    │              │  │
│  │        ▼                    ▼              │  │
│  │  ┌─────────────┐      Port 5800           │  │
│  │  │  Electron   │      (WebUI)             │  │
│  │  │  Sentry-Six │                          │  │
│  │  └─────────────┘                          │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  Volumes:                                       │
│  /config ──► Settings, Machine ID              │
│  /data   ──► Tesla Footage                     │
└─────────────────────────────────────────────────┘
```

This approach renders the existing Electron UI inside a virtual frame buffer (Xvfb), then streams it to your browser via noVNC - no need to rewrite the frontend as a separate web app.
