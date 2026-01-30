# Sentry-Six Update API - Server-Side Specification

## Overview

This document provides the specification for the server-side API that handles update checks and telemetry for the Sentry-Six desktop application. The client-side implementation is complete and expects the server to conform to this spec.

---

## Endpoint

```
POST https://api.sentry-six.com/update-check
```

---

## Request

### Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `User-Agent` | `Sentry-Six/{version}` (e.g., `Sentry-Six/2026.5.1`) |

### Body (JSON)

```json
{
  "fingerprint": "a7d8f9e0c1b2a3d4e5f6789012345678901234567890abcdef1234567890abcd",
  "current_version": "v2026.5.1",
  "platform": "windows",
  "arch": "x64"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `fingerprint` | `string` | 64-character SHA-256 hex hash. Anonymized machine identifier. **Consistent across app reinstalls** on the same machine. |
| `current_version` | `string` | Semantic version prefixed with `v` (e.g., `v2026.5.1`) |
| `platform` | `string` | One of: `windows`, `macos`, `linux` |
| `arch` | `string` | CPU architecture: `x64`, `arm64`, `ia32`, etc. |

---

## Response

### Success Response (HTTP 200)

```json
{
  "update_available": true,
  "new_version": "v2026.6.0",
  "force_manual": false,
  "message": "Optional message to display to user",
  "download_url": "https://github.com/ChadR23/Sentry-Six/releases/latest"
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `update_available` | `boolean` | **Yes** | `true` if a newer version exists |
| `new_version` | `string` | If update available | The latest version string (e.g., `v2026.6.0`) |
| `force_manual` | `boolean` | **Yes** | **Killswitch flag** - if `true`, client stops auto-update and shows critical alert |
| `message` | `string` | No | Custom message to display (used for notices or killswitch explanations) |
| `download_url` | `string` | If force_manual | URL to open in browser for manual download |

---

## Response Scenarios

### Scenario 1: No Update Available

```json
{
  "update_available": false,
  "force_manual": false
}
```

Client behavior: Silently continues, no UI shown.

---

### Scenario 2: Update Available (Normal)

```json
{
  "update_available": true,
  "new_version": "v2026.6.0",
  "force_manual": false,
  "message": null
}
```

Client behavior: Shows standard update modal with "Update Now" and "Later" buttons. Proceeds with electron-updater auto-download.

---

### Scenario 3: Update Available with Notice

```json
{
  "update_available": true,
  "new_version": "v2026.6.0",
  "force_manual": false,
  "message": "This update includes important security fixes."
}
```

Client behavior: Shows update modal with the `message` displayed in the "What's New" section. Normal auto-update flow.

---

### Scenario 4: Killswitch Activated (force_manual)

```json
{
  "update_available": true,
  "new_version": "v2026.6.0",
  "force_manual": true,
  "message": "A critical bug was found in your version. Please download the latest version manually to continue using the app safely.",
  "download_url": "https://github.com/ChadR23/Sentry-Six/releases/tag/v2026.6.0"
}
```

Client behavior:
- **Stops all auto-download functionality**
- Shows a **critical alert modal** (red styling, cannot be dismissed by clicking outside)
- Hides "Update Now" and "Later" buttons
- Shows only a **"Download from GitHub"** button that opens `download_url` in browser
- User must manually download and reinstall

---

## Server-Side Logic Requirements

### 1. Database Schema (Suggested)

```sql
-- Track unique installations
CREATE TABLE installations (
  id SERIAL PRIMARY KEY,
  fingerprint VARCHAR(64) UNIQUE NOT NULL,
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW(),
  last_version VARCHAR(20),
  platform VARCHAR(20),
  arch VARCHAR(20)
);

-- Version blacklist for killswitch
CREATE TABLE version_blacklist (
  version VARCHAR(20) PRIMARY KEY,
  message TEXT,
  download_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Current latest version
CREATE TABLE app_versions (
  platform VARCHAR(20) PRIMARY KEY,
  latest_version VARCHAR(20) NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 2. Request Processing Logic

```python
# Pseudocode for /update-check endpoint

def handle_update_check(request):
    fingerprint = request.fingerprint
    current_version = request.current_version
    platform = request.platform
    arch = request.arch
    
    # 1. Upsert installation record (for analytics)
    if fingerprint_exists(fingerprint):
        update_installation(fingerprint, current_version, platform, arch)
        is_new_user = False
    else:
        create_installation(fingerprint, current_version, platform, arch)
        is_new_user = True
    
    # 2. Check killswitch (version blacklist)
    blacklist_entry = get_blacklist_entry(current_version)
    if blacklist_entry:
        return {
            "update_available": True,
            "new_version": get_latest_version(platform),
            "force_manual": True,
            "message": blacklist_entry.message,
            "download_url": blacklist_entry.download_url
        }
    
    # 3. Check for updates
    latest_version = get_latest_version(platform)
    if version_compare(current_version, latest_version) < 0:
        return {
            "update_available": True,
            "new_version": latest_version,
            "force_manual": False,
            "message": get_update_message(latest_version)  # Optional
        }
    
    # 4. Up to date
    return {
        "update_available": False,
        "force_manual": False
    }
```

### 3. Analytics Queries

```sql
-- Count new users vs returning users (daily)
SELECT 
  DATE(last_seen) as date,
  COUNT(CASE WHEN DATE(first_seen) = DATE(last_seen) THEN 1 END) as new_users,
  COUNT(CASE WHEN DATE(first_seen) < DATE(last_seen) THEN 1 END) as returning_users
FROM installations
GROUP BY DATE(last_seen);

-- Active users by platform
SELECT platform, COUNT(*) as count
FROM installations
WHERE last_seen > NOW() - INTERVAL '30 days'
GROUP BY platform;

-- Version distribution
SELECT last_version, COUNT(*) as count
FROM installations
WHERE last_seen > NOW() - INTERVAL '7 days'
GROUP BY last_version
ORDER BY count DESC;
```

---

## Error Handling

### Server Errors

If the server returns a non-2xx status code or is unreachable, the client will:
1. Log the error
2. **Fall back to direct GitHub check** (existing electron-updater / version.json flow)
3. Users are never locked out due to API downtime

### Timeout

Client timeout is **10 seconds**. Ensure responses are fast.

---

## Security Considerations

1. **Rate Limiting**: Implement rate limiting per fingerprint (e.g., 1 request per minute)
2. **No PII**: The fingerprint is a one-way hash - the server cannot reverse it to get machine info
3. **HTTPS Only**: All communication must be over HTTPS
4. **Input Validation**: Validate all incoming fields (version format, platform values, fingerprint length)

---

## Testing the Killswitch

To test the killswitch functionality:

1. Add the current app version to the `version_blacklist` table
2. Restart the app or click "Check for Updates" in settings
3. The critical alert modal should appear with the custom message
4. Verify the "Download from GitHub" button opens the correct URL

---

## Client Implementation Reference

The client-side code is in:
- `src/updateTelemetry.js` - Fingerprint generation and API request
- `src/main.js` - IPC handler that calls telemetry API
- `src/renderer/scripts/features/autoUpdate.js` - UI handling for force_manual

---

## Contact

For questions about the client implementation, refer to the codebase or contact the desktop app developer.
