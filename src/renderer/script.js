import { MULTI_LAYOUTS, DEFAULT_MULTI_LAYOUT } from './scripts/lib/multiLayouts.js';
import { CLIPS_MODE_KEY, MULTI_LAYOUT_KEY, MULTI_ENABLED_KEY, DASHBOARD_ENABLED_KEY, MAP_ENABLED_KEY } from './scripts/lib/storageKeys.js';
import { createClipsPanelMode } from './scripts/ui/panelMode.js';
import { escapeHtml, cssEscape } from './scripts/lib/utils.js';
import { state } from './scripts/lib/state.js';

// State
const player = state.player;
const library = state.library;
const selection = state.selection;
const multi = state.multi;
const previews = state.previews;
let seiType = null;
let enumFields = null;

// Multi-camera playback (Step 6)
// now lives in state.multi

// MULTI_LAYOUTS now lives in src/multiLayouts.js

// Preview pipeline state now lives in state.previews

// Sentry event metadata (event.json)
// Keyed by `${tag}/${eventId}` (e.g. `SentryClips/2025-12-11_17-58-00`)
const eventMetaByKey = new Map(); // key -> parsed JSON object

// Export state
const exportState = {
    startMarkerPct: null,  // Start marker position as percentage (0-100)
    endMarkerPct: null,    // End marker position as percentage (0-100)
    isExporting: false,
    currentExportId: null,
    ffmpegAvailable: false
};

// Sentry collection mode state now lives in state.collection.active

// DOM Elements
const $ = id => document.getElementById(id);
const dropOverlay = $('dropOverlay');
const folderInput = $('folderInput');
const overlayChooseFolderBtn = $('overlayChooseFolderBtn');
const loadingOverlay = $('loadingOverlay');
const loadingText = $('loadingText');
const loadingProgress = $('loadingProgress');
const loadingBar = $('loadingBar');
// Main video element (for single camera mode)
const videoMain = $('videoMain');
const progressBar = $('progressBar');
const playBtn = $('playBtn');
const skipBackBtn = $('skipBackBtn');
const skipForwardBtn = $('skipForwardBtn');
const currentTimeEl = $('currentTime');
const totalTimeEl = $('totalTime');
const dashboardVis = $('dashboardVis');
const videoContainer = $('videoContainer');
const clipList = $('clipList');
const clipBrowserSubtitle = $('clipBrowserSubtitle');
const dayFilter = $('dayFilter');
const chooseFolderBtn = $('chooseFolderBtn');
const clipsCollapseBtn = $('clipsCollapseBtn');
const cameraSelect = $('cameraSelect');
const autoplayToggle = $('autoplayToggle');
const multiCamToggle = $('multiCamToggle');
const dashboardToggle = $('dashboardToggle');
const mapToggle = $('mapToggle');
const speedSelect = $('speedSelect');
const multiLayoutSelect = $('multiLayoutSelect');
const multiCamGrid = $('multiCamGrid');
// Video elements for 6-camera grid (slots: tl, tc, tr, bl, bc, br)
const videoTL = $('videoTL');
const videoTC = $('videoTC');
const videoTR = $('videoTR');
const videoBL = $('videoBL');
const videoBC = $('videoBC');
const videoBR = $('videoBR');
// Video elements for immersive layout
const videoImmersiveMain = $('videoImmersiveMain');
const videoOverlayTL = $('videoOverlayTL');
const videoOverlayTR = $('videoOverlayTR');
const videoOverlayBL = $('videoOverlayBL');
const videoOverlayBC = $('videoOverlayBC');
const videoOverlayBR = $('videoOverlayBR');

// Video element map by slot
const videoBySlot = {
    tl: videoTL, tc: videoTC, tr: videoTR,
    bl: videoBL, bc: videoBC, br: videoBR,
    main: videoImmersiveMain,
    overlay_tl: videoOverlayTL, overlay_tr: videoOverlayTR,
    overlay_bl: videoOverlayBL, overlay_bc: videoOverlayBC, overlay_br: videoOverlayBR
};

// URL object references for cleanup
const videoUrls = new Map(); // video element -> objectURL

// Visualization Elements
const speedValue = $('speedValue');
const gearState = $('gearState');
const blinkLeft = $('blinkLeft');
const blinkRight = $('blinkRight');
const steeringIcon = $('steeringIcon');

// Smooth steering wheel animation using spring-damper physics
// This creates natural, fluid motion like a real steering wheel
let steeringPosition = 0;      // Current displayed angle
let steeringVelocity = 0;      // Current angular velocity
let steeringTarget = 0;        // Target angle from SEI data
let smoothedTarget = 0;        // Smoothed target (reduces noise)
let steeringAnimationId = null;
let lastSteeringTime = 0;

// Spring-damper physics base constants (tuned for 1x playback)
// Higher stiffness = faster response, higher damping = less oscillation
const STEERING_STIFFNESS_BASE = 15.0;  // Spring force - how strongly it pulls toward target
const STEERING_DAMPING_BASE = 6.5;     // Damping - reduces oscillation/overshoot
const TARGET_SMOOTHING_BASE = 0.25;    // How much to smooth incoming target values (reduces noise)

function smoothSteeringTo(targetAngle) {
    steeringTarget = targetAngle;
    
    // Start animation loop if not already running
    if (!steeringAnimationId) {
        lastSteeringTime = performance.now();
        steeringAnimationId = requestAnimationFrame(animateSteeringWheel);
    }
}

function animateSteeringWheel() {
    const now = performance.now();
    // Delta time in seconds, capped to prevent huge jumps
    const dt = Math.min((now - lastSteeringTime) / 1000, 0.1);
    lastSteeringTime = now;
    
    // Scale physics by playback rate so animation keeps up at higher speeds
    const playbackRate = state.ui.playbackRate || 1;
    const stiffness = STEERING_STIFFNESS_BASE * playbackRate;
    const damping = STEERING_DAMPING_BASE * Math.sqrt(playbackRate); // sqrt for stability at high speeds
    const smoothing = Math.min(0.7, TARGET_SMOOTHING_BASE * playbackRate); // Cap smoothing to prevent overshooting
    
    // First, smooth the target to reduce noise from SEI data
    smoothedTarget += (steeringTarget - smoothedTarget) * smoothing;
    
    // Spring-damper physics:
    // F = -k*(x - target) - b*v
    // where k = stiffness, b = damping, x = position, v = velocity
    const springForce = stiffness * (smoothedTarget - steeringPosition);
    const dampingForce = -damping * steeringVelocity;
    const acceleration = springForce + dampingForce;
    
    // Update velocity and position
    steeringVelocity += acceleration * dt;
    steeringPosition += steeringVelocity * dt;
    
    // Apply to DOM
    if (steeringIcon) {
        steeringIcon.style.transform = `rotate(${steeringPosition}deg)`;
    }
    
    // Check if we're settled (very close to target with low velocity)
    const settleThreshold = 0.1 * playbackRate; // More lenient at higher speeds
    const settled = Math.abs(smoothedTarget - steeringPosition) < settleThreshold && 
                    Math.abs(steeringVelocity) < 0.5 * playbackRate;
    
    if (settled) {
        steeringPosition = smoothedTarget;
        steeringVelocity = 0;
        if (steeringIcon) {
            steeringIcon.style.transform = `rotate(${steeringPosition}deg)`;
        }
        steeringAnimationId = null;
        return;
    }
    
    // Continue animation
    steeringAnimationId = requestAnimationFrame(animateSteeringWheel);
}

// Stop steering animation when paused
function stopSteeringAnimation() {
    if (steeringAnimationId) {
        cancelAnimationFrame(steeringAnimationId);
        steeringAnimationId = null;
    }
}

// Reset dashboard and map to default state (no SEI data)
function resetDashboardAndMap() {
    // Reset speed
    if (speedValue) speedValue.textContent = '--';
    const unitEl = $('speedUnit');
    if (unitEl) unitEl.textContent = useMetric ? 'KM/H' : 'MPH';
    
    // Reset gear
    if (gearState) {
        gearState.textContent = '--';
        gearState.classList.remove('active');
    }
    
    // Reset blinkers
    blinkLeft?.classList.remove('active', 'paused');
    blinkRight?.classList.remove('active', 'paused');
    
    // Reset steering wheel
    stopSteeringAnimation();
    steeringPosition = 0;
    steeringVelocity = 0;
    steeringTarget = 0;
    smoothedTarget = 0;
    if (steeringIcon) steeringIcon.style.transform = 'rotate(0deg)';
    
    // Reset autopilot
    const autosteerIcon = $('autosteerIcon');
    if (autosteerIcon) autosteerIcon.classList.remove('active');
    if (apText) {
        apText.textContent = 'No Data';
        apText.classList.remove('active');
    }
    
    // Reset brake and accelerator
    brakeIcon?.classList.remove('active');
    const accelPedal = $('accelPedal');
    if (accelPedal) accelPedal.classList.remove('active');
    
    // Reset extra data
    if (valSeq) valSeq.textContent = '--';
    if (valLat) valLat.textContent = '--';
    if (valLon) valLon.textContent = '--';
    if (valHeading) valHeading.textContent = '--';
    
    // Reset G-force meter
    if (gforceDot) {
        gforceDot.setAttribute('cx', 30);
        gforceDot.setAttribute('cy', 30);
        gforceDot.classList.remove('braking', 'accelerating', 'cornering-hard');
    }
    if (gforceTrail1) { gforceTrail1.setAttribute('cx', 30); gforceTrail1.setAttribute('cy', 30); }
    if (gforceTrail2) { gforceTrail2.setAttribute('cx', 30); gforceTrail2.setAttribute('cy', 30); }
    if (gforceTrail3) { gforceTrail3.setAttribute('cx', 30); gforceTrail3.setAttribute('cy', 30); }
    gforceHistory.length = 0;
    if (gforceX) { gforceX.textContent = '0.0'; gforceX.classList.remove('positive', 'negative', 'high'); }
    if (gforceY) { gforceY.textContent = '0.0'; gforceY.classList.remove('positive', 'negative', 'high'); }
    
    // Reset compass
    if (compassNeedle) compassNeedle.setAttribute('transform', 'rotate(0 30 30)');
    if (compassValue) compassValue.textContent = '--';
    
    // Reset map
    if (mapMarker) {
        mapMarker.remove();
        mapMarker = null;
    }
    if (mapPolyline) {
        mapPolyline.remove();
        mapPolyline = null;
    }
    mapPath = [];
    currentMapArrowRotation = 0;
    
    // Clear SEI data cache and tracking flags
    if (nativeVideo) {
        nativeVideo.seiData = [];
        nativeVideo.mapPath = [];
        nativeVideo.lastSeiTimeMs = -Infinity;
        nativeVideo.dashboardReset = false;
    }
}

// Reset only dashboard elements (not map - preserve event.json marker)
function resetDashboardOnly() {
    // Reset speed
    if (speedValue) speedValue.textContent = '--';
    const unitEl = $('speedUnit');
    if (unitEl) unitEl.textContent = useMetric ? 'KM/H' : 'MPH';
    
    // Reset gear
    if (gearState) {
        gearState.textContent = '--';
        gearState.classList.remove('active');
    }
    
    // Reset blinkers
    blinkLeft?.classList.remove('active', 'paused');
    blinkRight?.classList.remove('active', 'paused');
    
    // Reset steering wheel
    stopSteeringAnimation();
    steeringPosition = 0;
    steeringVelocity = 0;
    steeringTarget = 0;
    smoothedTarget = 0;
    if (steeringIcon) steeringIcon.style.transform = 'rotate(0deg)';
    
    // Reset autopilot
    const autosteerIcon = $('autosteerIcon');
    if (autosteerIcon) autosteerIcon.classList.remove('active');
    if (apText) {
        apText.textContent = 'No Data';
        apText.classList.remove('active');
    }
    
    // Reset brake and accelerator
    brakeIcon?.classList.remove('active');
    const accelPedal = $('accelPedal');
    if (accelPedal) accelPedal.classList.remove('active');
    
    // Reset extra data
    if (valSeq) valSeq.textContent = '--';
    if (valLat) valLat.textContent = '--';
    if (valLon) valLon.textContent = '--';
    if (valHeading) valHeading.textContent = '--';
    
    // Reset G-force meter
    if (gforceDot) {
        gforceDot.setAttribute('cx', 30);
        gforceDot.setAttribute('cy', 30);
        gforceDot.classList.remove('braking', 'accelerating', 'cornering-hard');
    }
    if (gforceTrail1) { gforceTrail1.setAttribute('cx', 30); gforceTrail1.setAttribute('cy', 30); }
    if (gforceTrail2) { gforceTrail2.setAttribute('cx', 30); gforceTrail2.setAttribute('cy', 30); }
    if (gforceTrail3) { gforceTrail3.setAttribute('cx', 30); gforceTrail3.setAttribute('cy', 30); }
    gforceHistory.length = 0;
    if (gforceX) { gforceX.textContent = '0.0'; gforceX.classList.remove('positive', 'negative', 'high'); }
    if (gforceY) { gforceY.textContent = '0.0'; gforceY.classList.remove('positive', 'negative', 'high'); }
    
    // Reset compass
    if (compassNeedle) compassNeedle.setAttribute('transform', 'rotate(0 30 30)');
    if (compassValue) compassValue.textContent = '--';
    
    // Note: Map is NOT reset here - preserves event.json static marker
}

// Show a static map marker from event.json location data (for Sentry/Saved clips)
function showEventJsonLocation(coll) {
    if (!map || !coll?.groups?.length) return;
    
    // Get eventMeta from any group in the collection
    let eventMeta = null;
    for (const g of coll.groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    
    if (!eventMeta) return;
    
    // Parse coordinates
    const lat = parseFloat(eventMeta.est_lat);
    const lon = parseFloat(eventMeta.est_lon);
    
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001)) {
        return; // Invalid coordinates
    }
    
    console.log('Showing event.json location:', lat, lon, eventMeta.street || '', eventMeta.city || '');
    
    // Store event metadata for display
    state.collection.eventMeta = eventMeta;
    
    // Create a static marker icon (different from moving GPS arrow)
    const eventIcon = L.divIcon({
        className: 'event-location-marker',
        html: `<div class="event-marker-pin">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="#e53935">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
        </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32]
    });
    
    // Create marker and add popup with location info
    const latlng = L.latLng(lat, lon);
    mapMarker = L.marker(latlng, { icon: eventIcon }).addTo(map);
    
    // Center map on location
    map.setView(latlng, 16);
    map.invalidateSize();
}

// Format event reason for display
function formatEventReason(reason) {
    const reasonMap = {
        'sentry_aware_object_detection': 'Object Detected',
        'vehicle_auto_emergency_braking': 'Auto Emergency Braking',
        'user_interaction_dashcam_icon_tapped': 'Manual Save',
        'user_interaction_dashcam_panel_save': 'Manual Save',
        'user_interaction_honk': 'Honk Triggered',
        'sentry_aware_accel': 'Acceleration Detected',
        'collision': 'Collision Detected',
        'user_interaction_dashcam': 'Manual Save'
    };
    return reasonMap[reason] || reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Get icon for event reason (returns SVG or null)
function getEventReasonIcon(reason) {
    const icons = {
        'sentry_aware_object_detection': '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>',
        'vehicle_auto_emergency_braking': '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.83L19.13 19H4.87L12 5.83zM11 16h2v2h-2v-2zm0-6h2v4h-2v-4z"/></svg>',
        'collision': '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.83L19.13 19H4.87L12 5.83zM11 16h2v2h-2v-2zm0-6h2v4h-2v-4z"/></svg>'
    };
    return icons[reason] || null;
}
const apText = $('apText');
const brakeIcon = $('brakeIcon');
const toggleExtra = $('toggleExtra');
const extraDataContainer = document.querySelector('.extra-data-container');
const mapVis = $('mapVis');

// Map State
let map = null;
let mapMarker = null;
let mapPolyline = null;
let mapPath = [];
let currentMapArrowRotation = 0; // Track cumulative rotation for shortest path calculation

// Extra Data Elements
const valLat = $('valLat');
const valLon = $('valLon');
const valHeading = $('valHeading');
const valSeq = $('valSeq');

// G-Force Meter Elements
const gforceDot = $('gforceDot');
const gforceTrail1 = $('gforceTrail1');
const gforceTrail2 = $('gforceTrail2');
const gforceTrail3 = $('gforceTrail3');
const gforceX = $('gforceX');
const gforceY = $('gforceY');

// Compass Elements
const compassNeedle = $('compassNeedle');
const compassValue = $('compassValue');

// G-Force trail history (stores last few positions)
const gforceHistory = [];
const GFORCE_HISTORY_MAX = 3;

// Constants
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;
let useMetric = localStorage.getItem('useMetric') === 'true';

function notify(message, opts = {}) {
    const type = opts.type || 'info'; // 'info' | 'success' | 'warn' | 'error'
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : (type === 'error' ? 5500 : 3200);

    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');
        document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `<span class="dot" aria-hidden="true"></span><div class="msg"></div>`;
    el.querySelector('.msg').textContent = String(message || '');
    container.appendChild(el);

    // Animate in
    requestAnimationFrame(() => el.classList.add('show'));

    // Auto remove
    const remove = () => {
        el.classList.remove('show');
        setTimeout(() => { try { el.remove(); } catch { } }, 180);
    };
    setTimeout(remove, timeoutMs);
}

// Loading overlay helpers for large folder imports
function showLoading(text = 'Scanning folder...', progress = '') {
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    if (loadingText) loadingText.textContent = text;
    if (loadingProgress) loadingProgress.textContent = progress;
    if (loadingBar) loadingBar.style.width = '0%';
}

function updateLoading(text, progress, percent = 0) {
    if (loadingText) loadingText.textContent = text;
    if (loadingProgress) loadingProgress.textContent = progress;
    if (loadingBar) loadingBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

function hideLoading() {
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
}

// Yield to the event loop to prevent UI freezing during heavy processing
function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function hasValidGps(sei) {
    // Tesla SEI can be missing, zeroed, or invalid while parked / initializing GPS.
    const lat = Number(sei?.latitudeDeg ?? sei?.latitude_deg);
    const lon = Number(sei?.longitudeDeg ?? sei?.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    // Treat (0,0) as "no fix" (real-world clips should never be there).
    if (lat === 0 && lon === 0) return false;
    // Basic sanity bounds.
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    return true;
}

// Initialize
(async function init() {
    // Init Map
    try {
        if (window.L) {
            map = L.map('map', { 
                zoomControl: false, 
                attributionControl: false,
                dragging: false,
                touchZoom: false,
                scrollWheelZoom: false,
                doubleClickZoom: false,
                boxZoom: false,
                keyboard: false
            }).setView([0, 0], 2);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                maxZoom: 19,
                subdomains: 'abcd'
            }).addTo(map);
        }
    } catch(e) { console.error('Leaflet init failed', e); }
    
    // Re-center map when window is resized or goes fullscreen
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (map && mapPolyline) {
                map.invalidateSize();
                map.fitBounds(mapPolyline.getBounds(), { padding: [20, 20] });
            }
        }, 100);
    });
    
    // Also handle fullscreen changes
    document.addEventListener('fullscreenchange', () => {
        if (map && mapPolyline) {
            setTimeout(() => {
                map.invalidateSize();
                map.fitBounds(mapPolyline.getBounds(), { padding: [20, 20] });
            }, 100);
        }
    });

    try {
        const { SeiMetadata, enumFields: ef } = await DashcamHelpers.initProtobuf();
        seiType = SeiMetadata;
        enumFields = ef;
    } catch (e) {
        console.error('Failed to init protobuf:', e);
        notify('Failed to initialize metadata parser. Make sure protobuf loads and you are not running via file://', { type: 'error' });
    }

    // Clip Browser buttons
    chooseFolderBtn.onclick = (e) => {
        e.preventDefault();
        openFolderPicker();
    };

    if (dayFilter) {
        dayFilter.onchange = async () => {
            const selectedDate = dayFilter.value;
            if (selectedDate && folderStructure?.dateHandles?.has(selectedDate)) {
                // Lazy load: fetch files for this date from NAS
                await loadDateContent(selectedDate);
            } else {
                renderClipList();
            }
        };
    }

    // Panel layout mode (floating/collapsed only)
    const panelMode = createClipsPanelMode({ map, clipsCollapseBtn });
    panelMode.initClipsPanelMode();
    clipsCollapseBtn.onclick = (e) => { e.preventDefault(); panelMode.toggleCollapsedMode(); };

    cameraSelect.onchange = () => {
        const g = selection.selectedGroupId ? library.clipGroupById.get(selection.selectedGroupId) : null;
        if (!g) return;

        if (multi.enabled) {
            // In multi-cam, the dropdown selects the master camera (telemetry + timeline).
            multi.masterCamera = cameraSelect.value;
            reloadSelectedGroup();
        } else {
            selection.selectedCamera = cameraSelect.value;
            loadClipGroupCamera(g, selection.selectedCamera);
        }
    };

    multiCamToggle.onchange = () => {
        multi.enabled = !!multiCamToggle.checked;
        localStorage.setItem(MULTI_ENABLED_KEY, multi.enabled ? '1' : '0');
        if (multiLayoutSelect) multiLayoutSelect.disabled = !multi.enabled;
        reloadSelectedGroup();
    };

    // Dashboard (SEI overlay) toggle
    dashboardToggle.onchange = () => {
        state.ui.dashboardEnabled = !!dashboardToggle.checked;
        localStorage.setItem(DASHBOARD_ENABLED_KEY, state.ui.dashboardEnabled ? '1' : '0');
        updateDashboardVisibility();
    };

    // Map toggle
    mapToggle.onchange = () => {
        state.ui.mapEnabled = !!mapToggle.checked;
        localStorage.setItem(MAP_ENABLED_KEY, state.ui.mapEnabled ? '1' : '0');
        updateMapVisibility();
    };

    // Metric toggle
    const metricToggle = $('metricToggle');
    if (metricToggle) {
        metricToggle.checked = useMetric;
        metricToggle.onchange = () => {
            useMetric = metricToggle.checked;
            localStorage.setItem('useMetric', useMetric ? 'true' : 'false');
        };
    }

    // Playback speed selector
    if (speedSelect) {
        // Restore saved playback rate
        const savedRate = localStorage.getItem('playbackRate');
        if (savedRate) {
            state.ui.playbackRate = parseFloat(savedRate) || 1;
            speedSelect.value = state.ui.playbackRate.toString();
        }
        speedSelect.onchange = () => {
            const rate = parseFloat(speedSelect.value) || 1;
            applyPlaybackRate(rate);
            localStorage.setItem('playbackRate', rate.toString());
        };
    }

    // Initialize dashboard/map toggles from localStorage (default ON)
    const savedDashboard = localStorage.getItem(DASHBOARD_ENABLED_KEY);
    state.ui.dashboardEnabled = savedDashboard == null ? true : savedDashboard === '1';
    if (dashboardToggle) dashboardToggle.checked = state.ui.dashboardEnabled;

    const savedMap = localStorage.getItem(MAP_ENABLED_KEY);
    state.ui.mapEnabled = savedMap == null ? true : savedMap === '1';
    if (mapToggle) mapToggle.checked = state.ui.mapEnabled;

    // Apply initial visibility state
    updateDashboardVisibility();
    updateMapVisibility();

    // Multi-cam layout preset - force six_default
    multi.layoutId = 'six_default';
    if (multiLayoutSelect) {
        multiLayoutSelect.value = multi.layoutId;
        multiLayoutSelect.onchange = () => {
            setMultiLayout(multiLayoutSelect.value || DEFAULT_MULTI_LAYOUT);
        };
    }

    // Layout quick switch buttons (removed - buttons don't exist in HTML)
    updateMultiLayoutButtons();

    // Skip buttons (±15 seconds)
    if (skipBackBtn) skipBackBtn.onclick = (e) => { e.preventDefault(); skipSeconds(-15); };
    if (skipForwardBtn) skipForwardBtn.onclick = (e) => { e.preventDefault(); skipSeconds(15); };

    // Export buttons
    const setStartMarkerBtn = $('setStartMarkerBtn');
    const setEndMarkerBtn = $('setEndMarkerBtn');
    const exportBtn = $('exportBtn');
    const exportModal = $('exportModal');
    const closeExportModal = $('closeExportModal');
    const startExportBtn = $('startExportBtn');
    const cancelExportBtn = $('cancelExportBtn');

    if (setStartMarkerBtn) {
        setStartMarkerBtn.onclick = (e) => { e.preventDefault(); setExportMarker('start'); };
    }
    if (setEndMarkerBtn) {
        setEndMarkerBtn.onclick = (e) => { e.preventDefault(); setExportMarker('end'); };
    }
    if (exportBtn) {
        exportBtn.onclick = (e) => { e.preventDefault(); openExportModal(); };
    }
    if (closeExportModal) {
        closeExportModal.onclick = (e) => { e.preventDefault(); closeExportModalFn(); };
    }
    if (cancelExportBtn) {
        cancelExportBtn.onclick = (e) => { e.preventDefault(); cancelExport(); };
    }
    if (startExportBtn) {
        startExportBtn.onclick = (e) => { e.preventDefault(); startExport(); };
    }
    // Close modal on backdrop click
    if (exportModal) {
        exportModal.onclick = (e) => {
            if (e.target === exportModal) closeExportModalFn();
        };
    }


    // Initialize native video playback system
    initNativeVideoPlayback();

    // Multi focus mode (click a tile - works for both standard and immersive layouts)
    // Debounced to prevent rapid clicking issues
    let lastFocusToggle = 0;
    if (multiCamGrid) {
        multiCamGrid.addEventListener('click', (e) => {
            // Debounce rapid clicks (200ms minimum between toggles)
            const now = Date.now();
            if (now - lastFocusToggle < 200) return;
            lastFocusToggle = now;
            
            // Handle both standard tiles and immersive overlays/main
            const tile = e.target.closest?.('.multi-tile') 
                      || e.target.closest?.('.immersive-overlay')
                      || e.target.closest?.('.immersive-main');
            if (!tile) return;
            const slot = tile.getAttribute('data-slot');
            if (!slot) return;
            toggleMultiFocus(slot);
        });
    }

    // Multi-cam enabled preference (default ON if no prior preference)
    const savedMulti = localStorage.getItem(MULTI_ENABLED_KEY);
    multi.enabled = savedMulti == null ? !!multiCamToggle?.checked : savedMulti === '1';
    if (multiCamToggle) multiCamToggle.checked = multi.enabled;
    if (multiLayoutSelect) multiLayoutSelect.disabled = !multi.enabled;
})();

// -------------------------------------------------------------
// Explicit mode transitions
// -------------------------------------------------------------

function setMode(nextMode) {
    const normalized = (nextMode === 'collection') ? 'collection' : 'clip';
    if (state.mode === normalized) return;

    // Stop playback timers and prevent overlapping loops across transitions.
    pause();

    // Close transient UI.
    closeEventPopout();
    clearMultiFocus();

    // Clear mode-specific state.
    if (normalized === 'clip') {
        state.collection.active = null;
    } else {
        selection.selectedGroupId = null;
    }

    state.mode = normalized;
}

function setMultiLayout(layoutId) {
    const next = MULTI_LAYOUTS[layoutId] ? layoutId : DEFAULT_MULTI_LAYOUT;
    multi.layoutId = next;
    localStorage.setItem(MULTI_LAYOUT_KEY, next);
    if (multiLayoutSelect) multiLayoutSelect.value = next;
    updateMultiLayoutButtons();

    // Set grid column mode and layout type for the new layout
    const layout = MULTI_LAYOUTS[next];
    if (multiCamGrid && layout) {
        multiCamGrid.setAttribute('data-columns', layout.columns || 3);
        // Set layout type for immersive mode CSS
        if (layout.type === 'immersive') {
            multiCamGrid.setAttribute('data-layout-type', 'immersive');
            // Set overlay opacity as CSS variable
            multiCamGrid.style.setProperty('--immersive-opacity', layout.overlayOpacity || 0.9);
        } else {
            multiCamGrid.removeAttribute('data-layout-type');
            multiCamGrid.style.removeProperty('--immersive-opacity');
        }
    }

    if (multi.enabled) {
        // In native video mode, reload the current segment with new layout
        if (state.ui.nativeVideoMode && state.collection.active) {
            // Use >= 0 check to properly handle segment 0 (0 is falsy in JS)
            const segIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
            const wasPlaying = nativeVideo.playing;
            const currentTime = nativeVideo.master?.currentTime || 0;
            
            loadNativeSegment(segIdx).then(() => {
                // Restore playback position and state
                if (nativeVideo.master) {
                    nativeVideo.master.currentTime = currentTime;
                    syncMultiVideos(currentTime);
                }
                if (wasPlaying) {
                    playNative();
                }
            });
        } else {
            reloadSelectedGroup();
        }
    }
}

function updateMultiLayoutButtons() {
    // Layout buttons removed - function kept for compatibility but does nothing
}

// Timer for debounced video resync
let resyncTimer = null;

function clearMultiFocus() {
    state.ui.multiFocusSlot = null;
    if (!multiCamGrid) return;
    multiCamGrid.classList.remove('focused');
    multiCamGrid.removeAttribute('data-focus-slot');
    // Re-sync all videos after focus change with debouncing
    scheduleResync();
}

function toggleMultiFocus(slot) {
    if (!multiCamGrid) return;
    if (state.ui.multiFocusSlot === slot) {
        clearMultiFocus();
        return;
    }
    state.ui.multiFocusSlot = slot;
    multiCamGrid.classList.add('focused');
    multiCamGrid.setAttribute('data-focus-slot', slot);
    // Re-sync all videos after focus change with debouncing
    scheduleResync();
}

// Debounced resync to prevent rapid-fire sync operations
function scheduleResync() {
    // Cancel any pending resync
    if (resyncTimer) {
        clearTimeout(resyncTimer);
        resyncTimer = null;
    }
    // Schedule new resync after clicks settle down
    resyncTimer = setTimeout(() => {
        resyncTimer = null;
        forceResyncAllVideos();
    }, 300);
}

// Force resync ALL videos to master - more aggressive version for focus changes
function forceResyncAllVideos() {
    if (!nativeVideo.master) return;
    if (nativeVideo.master.readyState < 1) return;
    
    const masterTime = nativeVideo.master.currentTime;
    const masterPlaying = !nativeVideo.master.paused;
    
    console.log('Force resyncing all videos to', masterTime.toFixed(2), 'masterPlaying:', masterPlaying);
    
    // Get ALL secondary videos
    const secondaryVideos = Object.values(videoBySlot).filter(vid => 
        vid && vid !== nativeVideo.master && vid.src
    );
    
    // First, pause everything to reset state
    secondaryVideos.forEach(vid => {
        try { vid.pause(); } catch(e) {}
    });
    
    // Then set times
    secondaryVideos.forEach(vid => {
        if (vid.readyState >= 1) {
            vid.currentTime = masterTime;
        }
    });
    
    // Finally, if master is playing, play all secondaries
    if (masterPlaying) {
        // Small delay to let time sync settle
        setTimeout(() => {
            secondaryVideos.forEach(vid => {
                if (vid.readyState >= 1 && vid.paused) {
                    vid.play().catch(err => {
                        console.warn('Resync play failed:', err.message);
                    });
                }
            });
        }, 50);
    }
}

// Regular sync for timeupdate events (less aggressive)
function syncMultiVideos(targetTime) {
    if (!multi.enabled) return;
    
    Object.entries(videoBySlot).forEach(([slot, vid]) => {
        if (!vid || vid === nativeVideo.master) return;
        if (!vid.src || vid.readyState < 2) return; // Need more data ready
        
        const drift = vid.currentTime - targetTime;
        const absDrift = Math.abs(drift);
        
        // Use playbackRate adjustment for small drifts (smoother)
        // Hard sync only for large drifts > 0.3s
        if (absDrift > 0.3) {
            vid.currentTime = targetTime;
            vid.playbackRate = state.ui.playbackRate || 1;
        } else if (absDrift > 0.05) {
            // Subtle speed adjustment to catch up/slow down
            const baseRate = state.ui.playbackRate || 1;
            const correction = drift > 0 ? 0.97 : 1.03; // Slow down if ahead, speed up if behind
            vid.playbackRate = baseRate * correction;
        } else {
            // Within tolerance - reset to normal rate
            vid.playbackRate = state.ui.playbackRate || 1;
        }
        
        // Also ensure play state matches master
        const masterPlaying = nativeVideo.master && !nativeVideo.master.paused;
        if (masterPlaying && vid.paused) {
            vid.play().catch(() => {});
        }
    });
}

// Dashboard (SEI overlay) visibility
function updateDashboardVisibility() {
    if (!dashboardVis) return;
    // Toggle controls whether it can be shown; 'visible' class is added when there's data
    dashboardVis.classList.toggle('user-hidden', !state.ui.dashboardEnabled);
}

// Map visibility  
function updateMapVisibility() {
    if (!mapVis) return;
    // Toggle controls whether it can be shown; 'visible' class is added when there's GPS data
    mapVis.classList.toggle('user-hidden', !state.ui.mapEnabled);
    
    // When map becomes visible, invalidate size and re-center after CSS transition
    if (state.ui.mapEnabled && map) {
        setTimeout(() => {
            map.invalidateSize();
            // Re-center on current data
            if (mapPolyline) {
                map.fitBounds(mapPolyline.getBounds(), { padding: [20, 20] });
            } else if (mapMarker) {
                map.setView(mapMarker.getLatLng(), 16);
            }
        }, 150);
    }
}

// Clips panel mode logic moved to src/panelMode.js

// Drag & Drop Logic for Floating Vis - Direct attachment to panels
const dragOffsets = new Map(); // el -> {x, y}

function initDraggablePanels() {
    const panels = [dashboardVis, mapVis].filter(Boolean);
    
    panels.forEach(panel => {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        
        if (!dragOffsets.has(panel)) {
            dragOffsets.set(panel, { x: 0, y: 0 });
        }
        
        panel.addEventListener('mousedown', (e) => {
            // Don't drag if clicking on interactive elements
            if (e.target.closest('button, input, select, a')) return;
            
            isDragging = true;
            const offset = dragOffsets.get(panel);
            startX = e.clientX - offset.x;
            startY = e.clientY - offset.y;
            panel.style.cursor = 'grabbing';
            e.preventDefault();
            e.stopPropagation();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            e.preventDefault();
            const offset = dragOffsets.get(panel);
            offset.x = e.clientX - startX;
            offset.y = e.clientY - startY;
            panel.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
        });
        
        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                panel.style.cursor = 'grab';
            }
        });
    });
}

// Initialize draggable panels after DOM is ready
initDraggablePanels();

// File Handling - Use File System Access API for lazy directory traversal
// This prevents the browser from loading all files into memory at once

async function openFolderPicker() {
    // Use Electron's native APIs for both path resolution and directory traversal
    // This gives us actual file paths for FFmpeg export
    
    if (window.electronAPI?.openFolder && window.electronAPI?.readDir) {
        try {
            const folderPath = await window.electronAPI.openFolder();
            if (!folderPath) {
                return; // User cancelled
            }
            
            baseFolderPath = folderPath;
            console.log('Selected folder path:', baseFolderPath);
            
            showLoading('Scanning folder...', 'Looking for TeslaCam clips');
            await traverseDirectoryElectron(folderPath);
            return;
        } catch (err) {
            hideLoading();
            console.error('Folder picker error:', err);
            notify('Failed to open folder: ' + err.message, { type: 'error' });
            return;
        }
    }
    
    // Fallback to File System Access API (no export support)
    if ('showDirectoryPicker' in window) {
        try {
            showLoading('Opening folder...', 'Please select a TeslaCam folder');
            baseFolderPath = null; // No actual path available
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            await traverseDirectoryHandle(dirHandle);
        } catch (err) {
            hideLoading();
            if (err.name !== 'AbortError') {
                console.error('Folder picker error:', err);
                notify('Failed to open folder: ' + err.message, { type: 'error' });
            }
        }
    } else {
        // Fallback to webkitdirectory for unsupported browsers
        folderInput.click();
    }
}

// Traverse directory using Electron's fs APIs (provides actual file paths)
async function traverseDirectoryElectron(dirPath) {
    const folderName = dirPath.split('/').pop() || dirPath.split('\\').pop();
    
    // Create a pseudo directory handle structure for compatibility
    rootDirHandle = { name: folderName, kind: 'directory' };
    folderStructure = {
        root: rootDirHandle,
        recentClips: null,
        sentryClips: null,
        savedClips: null,
        dates: new Set(),
        dateHandles: new Map()
    };
    
    try {
        const entries = await window.electronAPI.readDir(dirPath);
        
        for (const entry of entries) {
            if (!entry.isDirectory) continue;
            const name = entry.name.toLowerCase();
            
            if (name === 'recentclips') {
                folderStructure.recentClips = entry;
                await scanRecentClipsElectron(entry.path);
            } else if (name === 'sentryclips') {
                folderStructure.sentryClips = entry;
                await scanEventFolderElectron(entry.path, 'sentry');
            } else if (name === 'savedclips') {
                folderStructure.savedClips = entry;
                await scanEventFolderElectron(entry.path, 'saved');
            }
        }
    } catch (err) {
        console.error('Error scanning folder:', err);
    }
    
    hideLoading();
    
    if (!folderStructure.dates.size) {
        notify('No TeslaCam clips found. Make sure you selected a TeslaCam folder.', { type: 'warn' });
        return;
    }
    
    // Build date list and update UI
    const sortedDates = Array.from(folderStructure.dates).sort().reverse();
    library.allDates = sortedDates;
    library.folderLabel = folderName;
    library.clipGroups = [];
    library.clipGroupById = new Map();
    library.dayCollections = new Map();
    library.dayData = new Map();
    
    clipBrowserSubtitle.textContent = folderName;
    dayFilter.innerHTML = '<option value="">Select Date</option>';
    sortedDates.forEach(date => {
        const opt = document.createElement('option');
        opt.value = date;
        opt.textContent = formatDateDisplay(date);
        dayFilter.appendChild(opt);
    });
    
    // Hide drop overlay
    dropOverlay.classList.add('hidden');
    
    if (sortedDates.length > 0) {
        dayFilter.value = sortedDates[0];
        await loadDateContentElectron(sortedDates[0]);
    }
    
    notify(`Found ${sortedDates.length} dates with clips`, { type: 'success' });
}

// Scan RecentClips using Electron fs
async function scanRecentClipsElectron(dirPath) {
    try {
        const entries = await window.electronAPI.readDir(dirPath);
        
        for (const entry of entries) {
            if (entry.isDirectory) {
                // Date subfolder
                const date = entry.name;
                if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                    folderStructure.dates.add(date);
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: entry, sentry: new Map(), saved: new Map() });
                    } else {
                        folderStructure.dateHandles.get(date).recent = entry;
                    }
                }
            } else if (entry.isFile && entry.name.endsWith('.mp4')) {
                // Flat file structure - extract date from filename
                const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
                if (match) {
                    const date = match[1];
                    folderStructure.dates.add(date);
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: { path: dirPath, isFlat: true }, sentry: new Map(), saved: new Map() });
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Error scanning RecentClips:', err);
    }
}

// Scan Sentry/Saved clips using Electron fs
async function scanEventFolderElectron(dirPath, clipType) {
    try {
        const entries = await window.electronAPI.readDir(dirPath);
        
        for (const entry of entries) {
            if (!entry.isDirectory) continue;
            
            // Event folders have format: YYYY-MM-DD_HH-MM-SS
            const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
            if (match) {
                const date = match[1];
                folderStructure.dates.add(date);
                
                if (!folderStructure.dateHandles.has(date)) {
                    folderStructure.dateHandles.set(date, { recent: null, sentry: new Map(), saved: new Map() });
                }
                
                const dateData = folderStructure.dateHandles.get(date);
                if (clipType === 'sentry') {
                    dateData.sentry.set(entry.name, entry);
                } else {
                    dateData.saved.set(entry.name, entry);
                }
            }
        }
    } catch (err) {
        console.warn(`Error scanning ${clipType} clips:`, err);
    }
}

// Load date content using Electron fs
async function loadDateContentElectron(date) {
    if (!folderStructure?.dateHandles?.has(date)) {
        notify(`No data for ${date}`, { type: 'warn' });
        return;
    }
    
    showLoading('Loading clips...', `Loading ${date}...`);
    
    const dateData = folderStructure.dateHandles.get(date);
    const files = [];
    
    // Load RecentClips
    if (dateData.recent) {
        updateLoading('Loading clips...', 'Loading RecentClips...');
        try {
            const recentPath = dateData.recent.isFlat ? dateData.recent.path : dateData.recent.path;
            const entries = await window.electronAPI.readDir(recentPath);
            
            for (const entry of entries) {
                if (!entry.isFile || !entry.name.endsWith('.mp4')) continue;
                
                // Filter by date if flat structure
                if (dateData.recent.isFlat) {
                    if (!entry.name.startsWith(date)) continue;
                }
                
                // Create a file-like object with path
                files.push({
                    name: entry.name,
                    path: entry.path,
                    webkitRelativePath: `${folderStructure.root.name}/RecentClips/${entry.name}`,
                    isElectronFile: true
                });
            }
        } catch (err) {
            console.warn('Error loading RecentClips:', err);
        }
    }
    
    // Load SentryClips events
    for (const [eventId, eventEntry] of dateData.sentry.entries()) {
        updateLoading('Loading clips...', `Loading Sentry event ${eventId}...`);
        try {
            const entries = await window.electronAPI.readDir(eventEntry.path);
            for (const entry of entries) {
                if (!entry.isFile) continue;
                files.push({
                    name: entry.name,
                    path: entry.path,
                    webkitRelativePath: `${folderStructure.root.name}/SentryClips/${eventId}/${entry.name}`,
                    isElectronFile: true
                });
            }
        } catch (err) {
            console.warn(`Error loading Sentry event ${eventId}:`, err);
        }
    }
    
    // Load SavedClips events
    for (const [eventId, eventEntry] of dateData.saved.entries()) {
        updateLoading('Loading clips...', `Loading Saved event ${eventId}...`);
        try {
            const entries = await window.electronAPI.readDir(eventEntry.path);
            for (const entry of entries) {
                if (!entry.isFile) continue;
                files.push({
                    name: entry.name,
                    path: entry.path,
                    webkitRelativePath: `${folderStructure.root.name}/SavedClips/${eventId}/${entry.name}`,
                    isElectronFile: true
                });
            }
        } catch (err) {
            console.warn(`Error loading Saved event ${eventId}:`, err);
        }
    }
    
    hideLoading();
    
    if (files.length === 0) {
        notify(`No clips found for ${date}`, { type: 'info' });
        return;
    }
    
    // Build index with path information
    const built = await buildTeslaCamIndex(files, folderStructure?.root?.name);
    
    // Merge into library (replace data for this date)
    library.clipGroups = built.groups;
    library.clipGroupById = new Map(library.clipGroups.map(g => [g.id, g]));
    library.dayCollections = buildDayCollections(library.clipGroups);
    library.dayData = library.dayData || new Map();
    
    // Update day data for this date
    const dayData = { recent: [], sentry: new Map(), saved: new Map() };
    for (const g of library.clipGroups) {
        const type = (g.tag || '').toLowerCase();
        if (type === 'recentclips') {
            dayData.recent.push(g);
        } else if (type === 'sentryclips' && g.eventId) {
            if (!dayData.sentry.has(g.eventId)) dayData.sentry.set(g.eventId, []);
            dayData.sentry.get(g.eventId).push(g);
        } else if (type === 'savedclips' && g.eventId) {
            if (!dayData.saved.has(g.eventId)) dayData.saved.set(g.eventId, []);
            dayData.saved.get(g.eventId).push(g);
        }
    }
    library.dayData.set(date, dayData);

    // Reset selection
    selection.selectedGroupId = null;
    state.collection.active = null;
    previews.cache.clear();
    previews.queue.length = 0;
    previews.inFlight = 0;
    state.ui.openEventRowId = null;

    clipBrowserSubtitle.textContent = `${library.folderLabel}: ${library.clipGroups.length} clip${library.clipGroups.length === 1 ? '' : 's'} on ${date}`;
    renderClipList();

    // Auto-select first item
    const dayValues = library.dayCollections ? Array.from(library.dayCollections.values()) : [];
    if (dayValues.length) {
        dayValues.sort((a, b) => (b.sortEpoch ?? 0) - (a.sortEpoch ?? 0));
        const latest = dayValues[0];
        if (latest?.key) {
            selectDayCollection(latest.key);
            // Update export button state after collection loads
            setTimeout(updateExportButtonState, 100);
        }
    }

    // Parse event.json in background
    ingestSentryEventJson(built.eventAssetsByKey);
    
    notify(`Loaded ${files.length} files for ${date}`, { type: 'success' });
}

function formatDateDisplay(dateStr) {
    try {
        const [year, month, day] = dateStr.split('-');
        const date = new Date(year, month - 1, day);
        return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
        return dateStr;
    }
}

// Store root directory handle for lazy loading
let rootDirHandle = null;
let folderStructure = null; // { recentClips: handle, sentryClips: handle, savedClips: handle, dates: Set }
let baseFolderPath = null; // Full file system path (only available when using Electron dialog)

// Quick folder structure scan - only reads folder names, not files
async function traverseDirectoryHandle(dirHandle) {
    showLoading('Scanning folder structure...', 'Finding available dates...');
    await yieldToUI();
    
    rootDirHandle = dirHandle;
    folderStructure = {
        root: dirHandle,
        recentClips: null,
        sentryClips: null,
        savedClips: null,
        dates: new Set(),
        // Store handles for event folders: Map<date, Map<clipType, handle[]>>
        dateHandles: new Map()
    };

    // Find the main clip folders
    try {
        for await (const entry of dirHandle.values()) {
            if (entry.kind !== 'directory') continue;
            const name = entry.name.toLowerCase();
            if (name === 'recentclips') {
                folderStructure.recentClips = entry;
                await scanRecentClipsForDates(entry);
            } else if (name === 'sentryclips') {
                folderStructure.sentryClips = entry;
                await scanEventFolderForDates(entry, 'sentry');
            } else if (name === 'savedclips') {
                folderStructure.savedClips = entry;
                await scanEventFolderForDates(entry, 'saved');
            }
        }
    } catch (err) {
        console.error('Error scanning folder structure:', err);
    }

    hideLoading();

    if (!folderStructure.dates.size) {
        notify('No TeslaCam clips found. Make sure you selected a TeslaCam folder.', { type: 'warn' });
        return;
    }

    // Build date list and update UI
    const sortedDates = Array.from(folderStructure.dates).sort().reverse();
    library.allDates = sortedDates;
    library.folderLabel = dirHandle.name;
    library.clipGroups = [];
    library.clipGroupById = new Map();
    library.dayCollections = new Map();
    library.dayData = new Map();

    // Update UI
    clipBrowserSubtitle.textContent = `${dirHandle.name}: ${sortedDates.length} date${sortedDates.length === 1 ? '' : 's'} available`;
    updateDayFilterOptions();
    
    // Hide drop overlay
    dropOverlay.classList.add('hidden');
    
    // Auto-select most recent date
    if (sortedDates.length && dayFilter) {
        dayFilter.value = sortedDates[0];
        await loadDateContent(sortedDates[0]);
    }
}

// Scan RecentClips folder for dates (supports both date subfolders and flat file structure)
async function scanRecentClipsForDates(handle) {
    try {
        for await (const entry of handle.values()) {
            if (entry.kind === 'directory') {
                // Date subfolders (e.g., 2025-12-15)
                const folderMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})/);
                if (folderMatch) {
                    const date = folderMatch[1];
                    folderStructure.dates.add(date);
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: entry, sentry: new Map(), saved: new Map() });
                    } else {
                        folderStructure.dateHandles.get(date).recent = entry;
                    }
                }
            } else if (entry.kind === 'file') {
                const nameLower = entry.name.toLowerCase();
                if (nameLower.endsWith('.mp4')) {
                    // Flat file structure: YYYY-MM-DD_HH-MM-SS-camera.mp4
                    const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
                    if (match) {
                        const date = match[1];
                        folderStructure.dates.add(date);
                        if (!folderStructure.dateHandles.has(date)) {
                            folderStructure.dateHandles.set(date, { recent: handle, sentry: new Map(), saved: new Map() });
                        } else {
                            folderStructure.dateHandles.get(date).recent = handle;
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Error scanning RecentClips:', err);
    }
}

// Scan SentryClips/SavedClips folders for dates (dates are in subfolder names)
async function scanEventFolderForDates(handle, clipType) {
    try {
        for await (const entry of handle.values()) {
            if (entry.kind === 'directory') {
                // Event folder name format: YYYY-MM-DD_HH-MM-SS
                const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$/);
                if (match) {
                    const date = match[1];
                    const eventId = entry.name;
                    folderStructure.dates.add(date);
                    
                    // Store handle reference for this date/event
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: null, sentry: new Map(), saved: new Map() });
                    }
                    const dateData = folderStructure.dateHandles.get(date);
                    if (clipType === 'sentry') {
                        dateData.sentry.set(eventId, entry);
                    } else {
                        dateData.saved.set(eventId, entry);
                    }
                }
            }
        }
    } catch (err) {
        console.warn(`Error scanning ${clipType} folder:`, err);
    }
}

// Load content for a specific date (called when user selects a date)
async function loadDateContent(date) {
    if (!folderStructure?.dateHandles?.has(date)) {
        renderClipList();
        return;
    }

    const dateData = folderStructure.dateHandles.get(date);
    
    // Check if we're using Electron (objects with path property) or browser File System API (directory handles)
    const isElectron = dateData.recent?.path || 
                       (dateData.sentry.size > 0 && dateData.sentry.values().next().value?.path) ||
                       (dateData.saved.size > 0 && dateData.saved.values().next().value?.path);
    
    if (isElectron) {
        await loadDateContentElectron(date);
        return;
    }

    // Browser File System Access API path
    showLoading('Loading clips...', `Loading ${date}...`);
    await yieldToUI();

    const files = [];

    // Load RecentClips for this date
    if (dateData.recent && typeof dateData.recent.values === 'function') {
        updateLoading('Loading clips...', 'Loading RecentClips...');
        await yieldToUI();
        try {
            for await (const entry of dateData.recent.values()) {
                if (entry.kind === 'file') {
                    const name = entry.name;
                    const nameLower = name.toLowerCase();
                    if (name.startsWith(date) && (nameLower.endsWith('.mp4') || nameLower.endsWith('.json') || nameLower.endsWith('.png'))) {
                        try {
                            const file = await entry.getFile();
                            Object.defineProperty(file, 'webkitRelativePath', {
                                value: `${folderStructure.root.name}/RecentClips/${name}`,
                                writable: false
                            });
                            files.push(file);
                        } catch { /* skip inaccessible files */ }
                    }
                }
            }
        } catch (err) {
            console.warn('Error loading RecentClips:', err);
        }
    }

    // Load SentryClips events for this date
    let eventCount = 0;
    const totalEvents = dateData.sentry.size + dateData.saved.size;
    
    for (const [eventId, eventHandle] of dateData.sentry) {
        eventCount++;
        updateLoading('Loading clips...', `Loading Sentry event ${eventCount}/${totalEvents}...`);
        await yieldToUI();
        await loadEventFolder(eventHandle, 'SentryClips', eventId, files);
    }

    // Load SavedClips events for this date
    for (const [eventId, eventHandle] of dateData.saved) {
        eventCount++;
        updateLoading('Loading clips...', `Loading Saved event ${eventCount}/${totalEvents}...`);
        await yieldToUI();
        await loadEventFolder(eventHandle, 'SavedClips', eventId, files);
    }

    hideLoading();

    if (!files.length) {
        notify(`No clips found for ${date}`, { type: 'info' });
        renderClipList();
        return;
    }

    // Build index for just this date's files
    await handleFolderFilesForDate(files, date);
}

// Load files from a single event folder (browser File System Access API)
async function loadEventFolder(eventHandle, clipType, eventId, files) {
    // Skip if this is an Electron path object (handled by loadDateContentElectron)
    if (eventHandle.path && !eventHandle.values) return;
    
    try {
        for await (const entry of eventHandle.values()) {
            if (entry.kind === 'file') {
                const name = entry.name.toLowerCase();
                if (name.endsWith('.mp4') || name.endsWith('.json') || name.endsWith('.png')) {
                    try {
                        const file = await entry.getFile();
                        Object.defineProperty(file, 'webkitRelativePath', {
                            value: `${folderStructure.root.name}/${clipType}/${eventId}/${entry.name}`,
                            writable: false
                        });
                        files.push(file);
                    } catch { /* skip inaccessible files */ }
                }
            }
        }
    } catch (err) {
        console.warn(`Error loading event folder ${eventId}:`, err);
    }
}

// Process files for a single date
async function handleFolderFilesForDate(files, date) {
    if (!seiType) {
        notify('Metadata parser not initialized yet—try again in a second.', { type: 'warn' });
        return;
    }

    const built = await buildTeslaCamIndex(files, folderStructure?.root?.name);
    
    // Merge into library (replace data for this date)
    library.clipGroups = built.groups;
    library.clipGroupById = new Map(library.clipGroups.map(g => [g.id, g]));
    library.dayCollections = buildDayCollections(library.clipGroups);
    library.dayData = library.dayData || new Map();
    
    // Update day data for this date
    const dayData = { recent: [], sentry: new Map(), saved: new Map() };
    for (const g of library.clipGroups) {
        const type = (g.tag || '').toLowerCase();
        if (type === 'recentclips') {
            dayData.recent.push(g);
        } else if (type === 'sentryclips' && g.eventId) {
            if (!dayData.sentry.has(g.eventId)) dayData.sentry.set(g.eventId, []);
            dayData.sentry.get(g.eventId).push(g);
        } else if (type === 'savedclips' && g.eventId) {
            if (!dayData.saved.has(g.eventId)) dayData.saved.set(g.eventId, []);
            dayData.saved.get(g.eventId).push(g);
        }
    }
    library.dayData.set(date, dayData);

    // Reset selection
    selection.selectedGroupId = null;
    state.collection.active = null;
    previews.cache.clear();
    previews.queue.length = 0;
    previews.inFlight = 0;
    state.ui.openEventRowId = null;

    clipBrowserSubtitle.textContent = `${library.folderLabel}: ${library.clipGroups.length} clip${library.clipGroups.length === 1 ? '' : 's'} on ${date}`;
    renderClipList();

    // Auto-select first item
    const dayValues = library.dayCollections ? Array.from(library.dayCollections.values()) : [];
    if (dayValues.length) {
        dayValues.sort((a, b) => (b.sortEpoch ?? 0) - (a.sortEpoch ?? 0));
        const latest = dayValues[0];
        if (latest?.key) {
            selectDayCollection(latest.key);
        }
    }

    // Parse event.json in background
    ingestSentryEventJson(built.eventAssetsByKey);
}

// Default click = choose folder (streamlined TeslaCam flow).
dropOverlay.onclick = (e) => {
    if (e?.target?.closest?.('#overlayChooseFolderBtn')) return;
    openFolderPicker();
};
overlayChooseFolderBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFolderPicker();
};

// Fallback for browsers without showDirectoryPicker
folderInput.onchange = async e => {
    const rawFiles = e.target.files;
    const totalCount = rawFiles?.length ?? 0;
    if (!totalCount) return;
    
    const files = Array.from(rawFiles);
    const root = getRootFolderNameFromWebkitRelativePath(files[0]?.webkitRelativePath);
    e.target.value = '';
    
    if (totalCount > 1000) {
        showLoading('Loading files...', `${totalCount.toLocaleString()} items found`);
        await yieldToUI();
    }
    
    handleFolderFiles(files, root);
};

function setMultiCamGridVisible(visible) {
    if (!multiCamGrid) return;
    multiCamGrid.classList.toggle('hidden', !visible);
    // Hide the single video when multi is active.
    if (videoMain) videoMain.classList.toggle('hidden', visible);
    if (!visible) clearMultiFocus();
}

function resetMultiStreams() {
    for (const s of multi.streams.values()) {
        try { s.decoder?.close?.(); } catch { /* ignore */ }
    }
    multi.streams.clear();
}

async function reloadSelectedGroup() {
    // Legacy WebCodecs reloading removed - native video playback handles this now
    // This function is kept for API compatibility but does nothing
}

// Legacy WebCodecs multi-cam loading removed - native video playback is now used exclusively

// -------------------------------------------------------------
// Folder ingest + Clip Groups (Phase 1)
// -------------------------------------------------------------

function getRootFolderNameFromWebkitRelativePath(relPath) {
    if (!relPath || typeof relPath !== 'string') return null;
    const parts = relPath.split('/').filter(Boolean);
    return parts.length ? parts[0] : null;
}

function getBestEffortRelPath(file, directoryName = null) {
    // 1) webkitdirectory input provides webkitRelativePath
    if (file?.webkitRelativePath) return file.webkitRelativePath;

    // 2) directory drop traversal: our helper stores entry.fullPath on the File as _teslaPath
    //    Example: "/TeslaCam/RecentClips/2025-...-front.mp4"
    const p = file?._teslaPath;
    if (typeof p === 'string' && p.length) {
        return p.startsWith('/') ? p.slice(1) : p;
    }

    // 3) fall back to whatever we know
    return directoryName ? `${directoryName}/${file.name}` : file.name;
}

function parseTeslaCamPath(relPath) {
    const norm = (relPath || '').replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);

    // Find "TeslaCam" segment if present.
    const teslaIdx = parts.findIndex(p => p.toLowerCase() === 'teslacam');
    const base = teslaIdx >= 0 ? parts.slice(teslaIdx) : parts;

    // base: ["TeslaCam", "<tag>", ...]
    if (base.length >= 2 && base[0].toLowerCase() === 'teslacam') {
        const tag = base[1];
        const rest = base.slice(2);
        return { tag, rest };
    }

    // No TeslaCam root: best effort tag from first folder if any
    if (parts.length >= 2) return { tag: parts[0], rest: parts.slice(1) };
    return { tag: 'Unknown', rest: parts.slice(1) };
}

function parseClipFilename(name) {
    // Tesla naming: YYYY-MM-DD_HH-MM-SS-front.mp4
    // Also seen in Sentry: same naming inside event folder; also "event.mp4" which we ignore.
    const lower = name.toLowerCase();
    if (!lower.endsWith('.mp4')) return null;
    if (lower === 'event.mp4') return null;

    const m = name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(.+)\.mp4$/i);
    if (!m) return null;
    const timestampKey = `${m[1]}_${m[2]}`;
    const cameraRaw = m[3];
    return { timestampKey, camera: normalizeCamera(cameraRaw) };
}

function normalizeCamera(cameraRaw) {
    const c = (cameraRaw || '').toLowerCase();
    if (c === 'front') return 'front';
    if (c === 'back') return 'back';
    if (c === 'left_repeater' || c === 'left') return 'left_repeater';
    if (c === 'right_repeater' || c === 'right') return 'right_repeater';
    if (c === 'left_pillar') return 'left_pillar';
    if (c === 'right_pillar') return 'right_pillar';
    return c || 'unknown';
}

function cameraLabel(camera) {
    if (camera === 'front') return 'Front';
    if (camera === 'back') return 'Back';
    if (camera === 'left_repeater') return 'Left Rep';
    if (camera === 'right_repeater') return 'Right Rep';
    if (camera === 'left_pillar') return 'Left Pillar';
    if (camera === 'right_pillar') return 'Right Pillar';
    return camera;
}

function timestampLabel(timestampKey) {
    // "2025-12-11_17-12-17" -> "2025-12-11 17:12:17"
    return (timestampKey || '').replace('_', ' ').replace(/-/g, (m, off, s) => {
        // keep date hyphens; convert time hyphens to colons by using position in string
        return m;
    }).replace(/(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})/, '$1 $2:$3:$4');
}

function parseTimestampKeyToEpochMs(timestampKey) {
    // "YYYY-MM-DD_HH-MM-SS" (local time)
    const m = String(timestampKey || '').match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const [ , Y, Mo, D, h, mi, s ] = m;
    return new Date(+Y, +Mo - 1, +D, +h, +mi, +s, 0).getTime();
}

function buildDisplayItems() {
    // Returns items sorted newest-first. Items are either:
    // - { type: 'group', id: groupId, group }
    // - { type: 'collection', id: collectionId, collection }
    const items = [];
    const sentryBuckets = new Map(); // key `${tag}/${eventId}` -> groups[]

    for (const g of library.clipGroups) {
        if (g.tag?.toLowerCase() === 'sentryclips' && g.eventId) {
            const key = `${g.tag}/${g.eventId}`;
            if (!sentryBuckets.has(key)) sentryBuckets.set(key, []);
            sentryBuckets.get(key).push(g);
        } else {
            items.push({ type: 'group', id: g.id, group: g });
        }
    }

    for (const [key, groups] of sentryBuckets.entries()) {
        groups.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
        const [tag, eventId] = key.split('/');
        const id = `sentry:${key}`;

        const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
        const lastStart = parseTimestampKeyToEpochMs(groups[groups.length - 1]?.timestampKey) ?? startEpochMs;
        const endEpochMs = lastStart + 60_000; // estimate
        const durationMs = Math.max(1, endEpochMs - startEpochMs);

        const segmentStartsMs = groups.map(g => {
            const t = parseTimestampKeyToEpochMs(g.timestampKey) ?? startEpochMs;
            return Math.max(0, t - startEpochMs);
        });

        const meta = groups[0]?.eventMeta || (eventMetaByKey.get(key) ?? null);
        let anchorMs = null;
        let anchorGroupId = groups[0].id;
        if (meta?.timestamp) {
            const eventEpoch = Date.parse(meta.timestamp);
            if (Number.isFinite(eventEpoch)) {
                anchorMs = Math.max(0, Math.min(durationMs, eventEpoch - startEpochMs));
                let anchorIdx = 0;
                for (let i = 0; i < segmentStartsMs.length; i++) {
                    if (segmentStartsMs[i] <= anchorMs) anchorIdx = i;
                }
                anchorGroupId = groups[anchorIdx]?.id || anchorGroupId;
            }
        }

        const sortEpoch = meta?.timestamp ? Date.parse(meta.timestamp) : lastStart;
        items.push({
            type: 'collection',
            id,
            sortEpoch: Number.isFinite(sortEpoch) ? sortEpoch : lastStart,
            collection: {
                id,
                key,
                tag,
                eventId,
                groups,
                meta,
                durationMs,
                segmentStartsMs,
                anchorMs,
                anchorGroupId
            }
        });
    }

    items.sort((a, b) => {
        const ta = a.type === 'collection'
            ? (a.sortEpoch ?? 0)
            : (parseTimestampKeyToEpochMs(a.group.timestampKey) ?? 0);
        const tb = b.type === 'collection'
            ? (b.sortEpoch ?? 0)
            : (parseTimestampKeyToEpochMs(b.group.timestampKey) ?? 0);
        return tb - ta;
    });

    return items;
}

async function buildTeslaCamIndex(files, directoryName = null, onProgress = null) {
    const groups = new Map(); // id -> group
    let inferredRoot = directoryName || null;
    const eventAssetsByKey = new Map(); // `${tag}/${eventId}` -> { jsonFile, pngFile, mp4File }

    const totalFiles = files.length;
    const BATCH_SIZE = 500; // Process files in batches to prevent UI blocking
    let processed = 0;

    for (let i = 0; i < totalFiles; i++) {
        const file = files[i];
        const relPath = getBestEffortRelPath(file, directoryName);
        const { tag, rest } = parseTeslaCamPath(relPath);
        const filename = rest[rest.length - 1] || file.name;
        const lowerName = String(filename || '').toLowerCase();

        // Event assets (event.json / event.png / event.mp4) for SentryClips and SavedClips
        const tagLowerAsset = tag.toLowerCase();
        if ((tagLowerAsset === 'sentryclips' || tagLowerAsset === 'savedclips') && rest.length >= 2 && (lowerName === 'event.json' || lowerName === 'event.png' || lowerName === 'event.mp4')) {
            const eventId = rest[0];
            const key = `${tag}/${eventId}`;
            if (!eventAssetsByKey.has(key)) eventAssetsByKey.set(key, {});
            const entry = eventAssetsByKey.get(key);
            if (lowerName === 'event.json') entry.jsonFile = file;
            if (lowerName === 'event.png') entry.pngFile = file;
            if (lowerName === 'event.mp4') entry.mp4File = file;
            processed++;
            continue;
        }

        // Regular per-camera MP4
        const parsed = parseClipFilename(filename);
        if (!parsed) {
            processed++;
            continue;
        }

        // SentryClips/<eventId>/YYYY-...-front.mp4
        // SavedClips/<eventId>/YYYY-...-front.mp4
        // RecentClips/YYYY-...-front.mp4
        let eventId = null;
        const tagLower = tag.toLowerCase();
        if ((tagLower === 'sentryclips' || tagLower === 'savedclips') && rest.length >= 2) {
            eventId = rest[0];
        }

        const groupId = `${tag}/${eventId ? eventId + '/' : ''}${parsed.timestampKey}`;
        if (!groups.has(groupId)) {
            groups.set(groupId, {
                id: groupId,
                tag,
                eventId,
                timestampKey: parsed.timestampKey,
                filesByCamera: new Map(),
                bestRelPathHint: relPath,
                eventMeta: null,
                eventJsonFile: null,
                eventPngFile: null,
                eventMp4File: null
            });
        }
        const g = groups.get(groupId);
        g.filesByCamera.set(parsed.camera, { file, relPath, tag, eventId, timestampKey: parsed.timestampKey, camera: parsed.camera });

        // try to infer folder label from relPath root if possible
        if (!inferredRoot && relPath) inferredRoot = relPath.split('/')[0] || null;

        processed++;

        // Yield to UI every BATCH_SIZE files to prevent blocking
        if (processed % BATCH_SIZE === 0) {
            if (onProgress) onProgress(processed, totalFiles, groups.size);
            await yieldToUI();
        }
    }

    // Final progress update
    if (onProgress) onProgress(totalFiles, totalFiles, groups.size);

    // Attach any event assets to groups in the same Sentry event folder
    for (const g of groups.values()) {
        if (!g.eventId) continue;
        const key = `${g.tag}/${g.eventId}`;
        const assets = eventAssetsByKey.get(key);
        if (!assets) continue;
        g.eventJsonFile = assets.jsonFile || null;
        g.eventPngFile = assets.pngFile || null;
        g.eventMp4File = assets.mp4File || null;
    }

    const arr = Array.from(groups.values());
    arr.sort((a, b) => (b.timestampKey || '').localeCompare(a.timestampKey || ''));
    return { groups: arr, inferredRoot, eventAssetsByKey };
}

function buildDayCollections(groups) {
    // Hierarchical structure: date -> { recentClips: [], sentryEvents: [], savedEvents: [] }
    const byDay = new Map(); // day -> { recent: groups[], sentry: Map<eventId, groups[]>, saved: Map<eventId, groups[]> }
    const allDates = new Set();

    for (const g of groups) {
        const key = String(g.timestampKey || '');
        const day = key.split('_')[0] || 'Unknown';
        const type = (g.tag || '').toLowerCase();
        
        allDates.add(day);
        
        if (!byDay.has(day)) {
            byDay.set(day, {
                recent: [],
                sentry: new Map(), // eventId -> groups[]
                saved: new Map()   // eventId -> groups[]
            });
        }
        const dayData = byDay.get(day);
        
        if (type === 'recentclips') {
            dayData.recent.push(g);
        } else if (type === 'sentryclips' && g.eventId) {
            if (!dayData.sentry.has(g.eventId)) dayData.sentry.set(g.eventId, []);
            dayData.sentry.get(g.eventId).push(g);
        } else if (type === 'savedclips' && g.eventId) {
            if (!dayData.saved.has(g.eventId)) dayData.saved.set(g.eventId, []);
            dayData.saved.get(g.eventId).push(g);
        }
    }

    // Build collections for each selectable item
    const collections = new Map();

    for (const [day, dayData] of byDay.entries()) {
        // Recent clips collection (all clips for this day combined)
        if (dayData.recent.length > 0) {
            const recentGroups = dayData.recent.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
            const id = `recent:${day}`;
            collections.set(id, buildCollectionFromGroups(id, day, 'RecentClips', recentGroups));
        }

        // Individual Sentry events
        for (const [eventId, eventGroups] of dayData.sentry.entries()) {
            const sortedGroups = eventGroups.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
            const id = `sentry:${day}:${eventId}`;
            const coll = buildCollectionFromGroups(id, day, 'SentryClips', sortedGroups);
            coll.eventId = eventId;
            coll.eventTime = eventId.split('_')[1]?.replace(/-/g, ':') || '';
            collections.set(id, coll);
        }

        // Individual Saved events
        for (const [eventId, eventGroups] of dayData.saved.entries()) {
            const sortedGroups = eventGroups.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
            const id = `saved:${day}:${eventId}`;
            const coll = buildCollectionFromGroups(id, day, 'SavedClips', sortedGroups);
            coll.eventId = eventId;
            coll.eventTime = eventId.split('_')[1]?.replace(/-/g, ':') || '';
            collections.set(id, coll);
        }
    }

    // Store all dates for the day filter
    library.allDates = Array.from(allDates).sort().reverse();
    library.dayData = byDay;

    return collections;
}

function buildCollectionFromGroups(id, day, clipType, groups) {
    const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
    const lastStart = parseTimestampKeyToEpochMs(groups[groups.length - 1]?.timestampKey) ?? startEpochMs;
    const endEpochMs = lastStart + 60_000;
    const durationMs = Math.max(1, endEpochMs - startEpochMs);

    const segmentStartsMs = groups.map(g => {
        const t = parseTimestampKeyToEpochMs(g.timestampKey) ?? startEpochMs;
        return Math.max(0, t - startEpochMs);
    });

    return {
        id,
        key: id,
        day,
        clipType,
        tag: clipType,
        groups,
        meta: null,
        durationMs,
        segmentStartsMs,
        anchorMs: 0,
        anchorGroupId: groups[0]?.id || null,
        sortEpoch: endEpochMs
    };
}

function updateDayFilterOptions() {
    if (!dayFilter || !library.allDates) return;
    
    const currentDay = dayFilter.value;
    const dates = library.allDates;
    
    // Rebuild day filter dropdown
    dayFilter.innerHTML = '<option value="">Select Date</option>';
    for (const d of dates) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        dayFilter.appendChild(opt);
    }
    
    // Preserve selection if still valid, otherwise default to most recent
    if (currentDay && dates.includes(currentDay)) {
        dayFilter.value = currentDay;
    } else {
        dayFilter.value = dates[0] || '';
    }
}

async function handleFolderFiles(fileList, directoryName = null) {
    if (!seiType) {
        notify('Metadata parser not initialized yet—try again in a second.', { type: 'warn' });
        return;
    }

    // Show loading overlay immediately for large folders
    const totalRaw = fileList?.length ?? 0;
    const isLargeFolder = totalRaw > 1000;
    if (isLargeFolder) {
        showLoading('Filtering files...', `${totalRaw.toLocaleString()} items to scan`);
        await yieldToUI();
    }

    // Filter files in batches to prevent blocking for huge file lists
    const FILTER_BATCH = 2000;
    const files = [];
    const rawFiles = Array.isArray(fileList) ? fileList : Array.from(fileList);
    
    for (let i = 0; i < rawFiles.length; i++) {
        const f = rawFiles[i];
        const n = f?.name?.toLowerCase?.() || '';
        if (n.endsWith('.mp4') || n.endsWith('.json') || n.endsWith('.png')) {
            files.push(f);
        }
        // Yield periodically during filtering for very large folders
        if (isLargeFolder && i > 0 && i % FILTER_BATCH === 0) {
            updateLoading('Filtering files...', `${i.toLocaleString()} / ${totalRaw.toLocaleString()} scanned`, (i / totalRaw) * 30);
            await yieldToUI();
        }
    }

    if (!files.length) {
        hideLoading();
        notify('No supported files found in that folder.', { type: 'warn' });
        return;
    }

    // Show loading for index building
    if (isLargeFolder || files.length > 500) {
        showLoading('Indexing clips...', `${files.length.toLocaleString()} media files found`);
        await yieldToUI();
    }

    // Build index with progress callback
    const onProgress = (processed, total, groupCount) => {
        const percent = 30 + (processed / total) * 60; // 30-90% range for indexing
        updateLoading(
            'Indexing clips...',
            `${processed.toLocaleString()} / ${total.toLocaleString()} files · ${groupCount.toLocaleString()} clip groups`,
            percent
        );
    };

    const built = await buildTeslaCamIndex(files, directoryName, isLargeFolder ? onProgress : null);
    
    if (isLargeFolder) {
        updateLoading('Building collections...', `${built.groups.length.toLocaleString()} clip groups`, 92);
        await yieldToUI();
    }

    library.clipGroups = built.groups;
    library.clipGroupById = new Map(library.clipGroups.map(g => [g.id, g]));
    library.folderLabel = built.inferredRoot || directoryName || 'Folder';

    // Build virtual day-level collections (Sentry Six–style day timelines)
    library.dayCollections = buildDayCollections(library.clipGroups);

    // Build day index (YYYY-MM-DD) for Recent/Saved/Sentry clips
    const dayIndex = new Map();
    for (const g of library.clipGroups) {
        const key = String(g.timestampKey || '');
        const day = key.split('_')[0] || 'Unknown';
        if (!dayIndex.has(day)) dayIndex.set(day, []);
        dayIndex.get(day).push(g.id);
    }
    library.dayIndex = dayIndex;

    // Reset selection + previews
    selection.selectedGroupId = null;
    state.collection.active = null;
    previews.cache.clear();
    previews.queue.length = 0;
    previews.inFlight = 0;
    state.ui.openEventRowId = null;

    if (isLargeFolder) {
        updateLoading('Rendering...', '', 98);
        await yieldToUI();
    }

    // Update UI
    clipBrowserSubtitle.textContent = `${library.folderLabel}: ${library.clipGroups.length} clip group${library.clipGroups.length === 1 ? '' : 's'}`;
    
    // Update day filter options and render clip list
    updateDayFilterOptions();
    renderClipList();

    // Autoselect most recent collection if available
    const dayValues = library.dayCollections ? Array.from(library.dayCollections.values()) : [];
    if (dayValues.length) {
        dayValues.sort((a, b) => (b.sortEpoch ?? 0) - (a.sortEpoch ?? 0));
        const latest = dayValues[0];
        if (latest?.key) {
            selectDayCollection(latest.key);
        }
    } else if (library.clipGroups.length) {
        const items = buildDisplayItems();
        const first = items[0];
        if (first?.type === 'collection') selectSentryCollection(first.id);
        else if (first?.type === 'group') selectClipGroup(first.id);
    }

    // Hide overlays once we have a folder loaded
    hideLoading();
    dropOverlay.classList.add('hidden');

    // Parse any Sentry event.json files in the background and attach metadata to groups.
    ingestSentryEventJson(built.eventAssetsByKey);
}

function renderClipList() {
    clipList.innerHTML = '';
    
    const selectedDay = dayFilter?.value || '';
    if (!selectedDay || !library.dayData) {
        // Show message to select a date
        const placeholder = document.createElement('div');
        placeholder.className = 'clip-list-placeholder';
        placeholder.textContent = 'Select a date to view clips';
        placeholder.style.cssText = 'padding: 16px; text-align: center; color: rgba(255,255,255,0.5); font-size: 12px;';
        clipList.appendChild(placeholder);
        return;
    }
    
    const dayData = library.dayData.get(selectedDay);
    if (!dayData) return;
    
    // 1. Recent Clips (at top)
    if (dayData.recent.length > 0) {
        const recentId = `recent:${selectedDay}`;
        const recentColl = library.dayCollections?.get(recentId);
        if (recentColl) {
            const item = createClipItem(recentColl, 'Recent Clips', 'recent');
            clipList.appendChild(item);
        }
    }
    
    // 2. Sentry Events (individual folders)
    const sentryEvents = Array.from(dayData.sentry.entries())
        .map(([eventId, groups]) => ({ eventId, groups, type: 'sentry' }))
        .sort((a, b) => b.eventId.localeCompare(a.eventId)); // Most recent first
    
    for (const event of sentryEvents) {
        const eventId = event.eventId;
        const collId = `sentry:${selectedDay}:${eventId}`;
        const coll = library.dayCollections?.get(collId);
        if (coll) {
            const timeStr = formatEventTime(eventId);
            const item = createClipItem(coll, `Sentry · ${timeStr}`, 'sentry');
            clipList.appendChild(item);
        }
    }
    
    // 3. Saved Events (individual folders)
    const savedEvents = Array.from(dayData.saved.entries())
        .map(([eventId, groups]) => ({ eventId, groups, type: 'saved' }))
        .sort((a, b) => b.eventId.localeCompare(a.eventId)); // Most recent first
    
    for (const event of savedEvents) {
        const eventId = event.eventId;
        const collId = `saved:${selectedDay}:${eventId}`;
        const coll = library.dayCollections?.get(collId);
        if (coll) {
            const timeStr = formatEventTime(eventId);
            const item = createClipItem(coll, `Saved · ${timeStr}`, 'saved');
            clipList.appendChild(item);
        }
    }
    
    highlightSelectedClip();
}

function createClipItem(coll, title, typeClass) {
    const groups = coll.groups || [];
    const firstGroup = groups[0];
    const cameras = firstGroup ? Array.from(firstGroup.filesByCamera.keys()) : [];
    
    // Get eventMeta for reason icon
    let eventMeta = null;
    for (const g of groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    
    const item = document.createElement('div');
    item.className = `clip-item event-item ${typeClass}-item`;
    item.dataset.groupid = coll.id;
    item.dataset.type = 'collection';
    
    const subline = `${groups.length} segment${groups.length !== 1 ? 's' : ''} · ${Math.max(1, cameras.length)} cam`;
    const badgeClass = typeClass;
    const badgeLabel = typeClass.charAt(0).toUpperCase() + typeClass.slice(1);
    
    // Build reason badge for SavedClips only (as text, not icon)
    let reasonBadge = '';
    if (typeClass === 'saved' && eventMeta?.reason) {
        const reasonLabel = formatEventReason(eventMeta.reason);
        const alertClass = eventMeta.reason.includes('emergency') || eventMeta.reason.includes('collision') ? 'alert' : 'warning';
        reasonBadge = `<span class="badge reason-icon ${alertClass}" title="${escapeHtml(eventMeta.reason)}">${escapeHtml(reasonLabel)}</span>`;
    }
    
    item.innerHTML = `
        <div class="clip-meta clip-meta-full">
            <div class="clip-title">${escapeHtml(title)}</div>
            <div class="clip-badges">
                <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
                ${reasonBadge}
            </div>
            <div class="clip-sub">
                <div>${escapeHtml(subline)}</div>
            </div>
        </div>
    `;
    
    item.onclick = () => selectDayCollection(coll.key);
    return item;
}

function formatEventTime(eventId) {
    // eventId format: "2025-12-11_17-58-00"
    const parts = eventId.split('_');
    if (parts.length >= 2) {
        const timePart = parts[1]; // "17-58-00"
        return timePart.replace(/-/g, ':'); // "17:58:00"
    }
    return eventId;
}

function getTypeLabel(clipType) {
    switch (clipType) {
        case 'SentryClips': return 'Sentry';
        case 'RecentClips': return 'Recent';
        case 'SavedClips': return 'Saved';
        default: return clipType || 'Unknown';
    }
}

// Close event popout when clicking elsewhere
document.addEventListener('click', (e) => {
    if (!state.ui.openEventRowId) return;
    const openEl = clipList?.querySelector?.(`.clip-item[data-groupid="${cssEscape(state.ui.openEventRowId)}"]`);
    if (!openEl) { state.ui.openEventRowId = null; return; }
    if (openEl.contains(e.target)) return;
    closeEventPopout();
});

function closeEventPopout() {
    if (!state.ui.openEventRowId) return;
    const el = clipList?.querySelector?.(`.clip-item[data-groupid="${cssEscape(state.ui.openEventRowId)}"]`);
    if (el) el.classList.remove('event-open');
    state.ui.openEventRowId = null;
}

function toggleEventPopout(rowId, metaOverride = null) {
    if (state.ui.openEventRowId && state.ui.openEventRowId !== rowId) closeEventPopout();
    const el = clipList?.querySelector?.(`.clip-item[data-groupid="${cssEscape(rowId)}"]`);
    if (!el) return;
    const opening = !el.classList.contains('event-open');
    if (!opening) { closeEventPopout(); return; }

    const meta = metaOverride ?? (library.clipGroupById.get(rowId)?.eventMeta || null);
    populateEventPopout(el, meta);
    el.classList.add('event-open');
    state.ui.openEventRowId = rowId;
}

function populateEventPopout(rowEl, meta) {
    const kv = rowEl.querySelector('.event-kv');
    if (!kv) return;
    kv.innerHTML = '';

    if (!meta) {
        const kEl = document.createElement('div');
        kEl.className = 'k';
        kEl.textContent = 'status';
        const vEl = document.createElement('div');
        vEl.className = 'v';
        vEl.textContent = 'Loading event.json…';
        kv.appendChild(kEl);
        kv.appendChild(vEl);
        return;
    }

    const preferred = ['timestamp', 'reason', 'camera', 'city', 'street', 'est_lat', 'est_lon'];
    const keys = [...preferred.filter(k => meta[k] != null), ...Object.keys(meta).filter(k => !preferred.includes(k))];
    for (const k of keys) {
        const v = meta[k];
        const kEl = document.createElement('div');
        kEl.className = 'k';
        kEl.textContent = k;
        const vEl = document.createElement('div');
        vEl.className = 'v';
        vEl.textContent = String(v);
        kv.appendChild(kEl);
        kv.appendChild(vEl);
    }
}

function highlightSelectedClip() {
    for (const el of clipList.querySelectorAll('.clip-item')) {
        el.classList.toggle('selected', el.dataset.groupid === selection.selectedGroupId || el.dataset.groupid === state.collection.active?.id);
    }
}

function selectClipGroup(groupId) {
    const g = library.clipGroupById.get(groupId);
    if (!g) return;
    setMode('clip');
    selection.selectedGroupId = groupId;
    highlightSelectedClip();
    progressBar.step = 1;

    // Choose default camera/master: front preferred, else first available
    const defaultCam = g.filesByCamera.has('front') ? 'front' : (g.filesByCamera.keys().next().value || 'front');
    selection.selectedCamera = defaultCam;
    multi.masterCamera = multi.masterCamera || defaultCam;
    if (!g.filesByCamera.has(multi.masterCamera)) multi.masterCamera = defaultCam;
    updateCameraSelect(g);
    cameraSelect.value = multi.enabled ? multi.masterCamera : selection.selectedCamera;
    reloadSelectedGroup();

    // Kick off preview for this group immediately
    ensureGroupPreview(groupId, { highPriority: true });
}

function selectSentryCollection(collectionId) {
    const items = buildDisplayItems();
    const it = items.find(x => x.type === 'collection' && x.id === collectionId);
    if (!it) return;

    const c = it.collection;
    setMode('collection');
    // Ensure a clean start. If we came from an actively playing clip, segment loading clears timers,
    // which can leave playing=true but no timer loop. Pause first so autoplay can reliably start.
    pause();
    
    // Reset dashboard and map when switching clips (clears stale SEI data)
    resetDashboardAndMap();
    
    state.collection.active = {
        ...c,
        currentSegmentIdx: -1,
        currentGroupId: null,
        currentLocalFrameIdx: 0,
        loadToken: 0
    };
    highlightSelectedClip();

    // Configure progress bar as millisecond timeline.
    progressBar.min = 0;
    progressBar.max = Math.floor(state.collection.active.durationMs);
    // Keep step=1 so playback can advance smoothly (Safari may snap programmatic values to step).
    // User scrubs are quantized in the oninput handler.
    progressBar.step = 1;
    progressBar.value = Math.floor(state.collection.active.anchorMs ?? 0);
    playBtn.disabled = false;
    progressBar.disabled = false;

    // Load at anchor (event time) if known, else start.
    const startMs = state.collection.active.anchorMs ?? 0;
    showCollectionAtMs(startMs).then(() => {
        if (autoplayToggle?.checked) setTimeout(() => play(), 0);
    }).catch(() => { /* ignore */ });
}

function selectDayCollection(dayKey) {
    try {
        console.log('Selecting day collection:', dayKey);
        console.log('Available day collections:', library.dayCollections ? Array.from(library.dayCollections.keys()) : 'none');
        
        const coll = library.dayCollections?.get(dayKey);
        if (!coll) {
            console.error('Day collection not found:', dayKey);
            return;
        }
        
        console.log('Day collection:', coll.id, 'groups:', coll.groups?.length, 'duration:', coll.durationMs);

    setMode('collection');
    pause();
    pauseNative();

    // Reset dashboard and map when switching clips (clears stale SEI data)
    resetDashboardAndMap();
    
    // Show event.json location on map for Sentry/Saved clips (if available)
    showEventJsonLocation(coll);

    // Reset native video state for new collection
    nativeVideo.currentSegmentIdx = -1;
    nativeVideo.isTransitioning = false;

    state.collection.active = {
        ...coll,
        currentSegmentIdx: -1,
        currentGroupId: null,
        currentLocalFrameIdx: 0,
        loadToken: 0
    };
    highlightSelectedClip();

    // Enable native video mode for smooth playback
    state.ui.nativeVideoMode = true;

    // Enable multi-cam by default for day collections.
    multi.enabled = true;
    if (multiCamToggle) {
        multiCamToggle.checked = true;
        localStorage.setItem(MULTI_ENABLED_KEY, '1');
    }
    
    // Ensure layout is applied to grid (sets data-columns, data-layout-type)
    const layoutId = multi.layoutId || DEFAULT_MULTI_LAYOUT;
    const layout = MULTI_LAYOUTS[layoutId];
    if (multiCamGrid && layout) {
        multiCamGrid.setAttribute('data-columns', layout.columns || 3);
        if (layout.type === 'immersive') {
            multiCamGrid.setAttribute('data-layout-type', 'immersive');
            multiCamGrid.style.setProperty('--immersive-opacity', layout.overlayOpacity || 0.9);
        } else {
            multiCamGrid.removeAttribute('data-layout-type');
            multiCamGrid.style.removeProperty('--immersive-opacity');
        }
    }

    // Initialize segment duration tracking (estimate 60s per segment, update as we load)
    const numSegs = coll.groups?.length || 0;
    nativeVideo.segmentDurations = new Array(numSegs).fill(60); // Estimated
    nativeVideo.cumulativeStarts = [];
    let cum = 0;
    for (let i = 0; i <= numSegs; i++) {
        nativeVideo.cumulativeStarts.push(cum);
        if (i < numSegs) cum += 60;
    }
    
    // Configure progress bar as percentage (0-100) for entire day with smooth stepping
    progressBar.min = 0;
    progressBar.max = 100;
    progressBar.step = 0.01; // Smooth sliding
    progressBar.value = 0;

    // Load first segment with native video
    loadNativeSegment(0).then(() => {
        // Update time display with total duration
        const totalSec = nativeVideo.cumulativeStarts[numSegs] || 60;
        updateTimeDisplayNew(0, totalSec);
        
        playBtn.disabled = false;
        progressBar.disabled = false;
        
        if (autoplayToggle?.checked) {
            setTimeout(() => playNative(), 100);
        }
    }).catch(err => {
        console.error('Failed to load native segment:', err);
        notify('Failed to load video: ' + (err?.message || String(err)), { type: 'error' });
    });
    } catch (err) {
        console.error('Error in selectDayCollection:', err);
        notify('Error selecting day: ' + (err?.message || String(err)), { type: 'error' });
    }
}

function updateCameraSelect(group) {
    const cams = Array.from(group.filesByCamera.keys());
    cameraSelect.innerHTML = '';
    const ordered = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar', ...cams];
    const seen = new Set();
    for (const cam of ordered) {
        if (seen.has(cam)) continue;
        seen.add(cam);
        if (!group.filesByCamera.has(cam)) continue;
        const opt = document.createElement('option');
        opt.value = cam;
        opt.textContent = cameraLabel(cam);
        cameraSelect.appendChild(opt);
    }
    cameraSelect.disabled = cameraSelect.options.length === 0;
    cameraSelect.value = selection.selectedCamera;
}

async function ingestSentryEventJson(eventAssetsByKey) {
    if (!eventAssetsByKey || eventAssetsByKey.size === 0) return;
    for (const [key, assets] of eventAssetsByKey.entries()) {
        if (!assets?.jsonFile) continue;
        try {
            let text;
            // Handle both browser File objects and Electron path objects
            if (assets.jsonFile.isElectronFile && assets.jsonFile.path) {
                // Electron file - read using fs
                text = await window.electronAPI.readFile(assets.jsonFile.path);
            } else {
                // Browser File object
                text = await assets.jsonFile.text();
            }
            const meta = JSON.parse(text);
            eventMetaByKey.set(key, meta);
            // Attach meta to all groups in the same Sentry event folder
            const [tag, eventId] = key.split('/');
            for (const g of library.clipGroups) {
                if (g.tag === tag && g.eventId === eventId) g.eventMeta = meta;
            }
            // Re-render list so Sentry collections can show event marker + updated details.
            renderClipList();
            // If an event popout is currently open, refresh its contents.
            if (state.ui.openEventRowId) {
                const el = clipList?.querySelector?.(`.clip-item[data-groupid="${cssEscape(state.ui.openEventRowId)}"]`);
                if (el?.classList?.contains('event-open')) populateEventPopout(el, meta);
            }
            // Refresh map if this event is currently active (fixes map not showing on auto-select)
            if (state.collection.active?.groups?.some(g => g.tag === tag && g.eventId === eventId)) {
                showEventJsonLocation(state.collection.active);
            }
        } catch (err) {
            console.warn(`Error parsing event.json for ${key}:`, err);
        }
    }
}

function loadClipGroupCamera(group, camera) {
    // Legacy WebCodecs loader - native video uses selectDayCollection() instead
    notify('Please select a day collection from the clip browser.', { type: 'info' });
}

// Legacy WebCodecs loadSingleGroup removed - native video playback is now used exclusively

function ensureGroupPreview(groupId, opts = {}) {
    const existing = previews.cache.get(groupId);
    // Avoid duplicate work when the observer triggers quickly or multiple rows reference the same preview.
    if (existing?.status === 'ready' || existing?.status === 'loading' || existing?.status === 'queued') return;
    previews.cache.set(groupId, { status: 'queued' });

    const task = async () => {
        previews.cache.set(groupId, { ...(previews.cache.get(groupId) || {}), status: 'loading' });
        const group = library.clipGroupById.get(groupId);
        if (!group) return;

        // choose best file for preview: front preferred
        const entry = group.filesByCamera.get('front') || group.filesByCamera.values().next().value;
        if (!entry?.file) return;

        // 1) minimap from SEI GPS
        let pathPoints = null;
        let buffer = null;
        try {
            buffer = await entry.file.arrayBuffer();
            const pmp4 = new DashcamMP4(buffer);
            const messages = pmp4.extractSeiMessages(seiType);
            const pts = [];
            for (const m of messages) {
                if (!hasValidGps(m)) continue;
                pts.push([m.latitude_deg, m.longitude_deg]);
            }
            pathPoints = downsamplePoints(pts, 120);
        } catch { /* ignore */ }

        // 2) thumbnail
        let thumbDataUrl = null;
        // Prefer Sentry event.png when present (fast + consistent)
        if (group.eventPngFile) {
            try { thumbDataUrl = await fileToDataUrl(group.eventPngFile); } catch { /* ignore */ }
        }
        // Otherwise best-effort using HTMLVideoElement snapshot (fast enough for previews)
        try {
            if (!thumbDataUrl) thumbDataUrl = await captureVideoThumbnail(entry.file, 112, 63);
        } catch { /* ignore */ }
        // Fallback: decode first keyframe using WebCodecs (more reliable for local MP4s)
        if (!thumbDataUrl && buffer) {
            try {
                thumbDataUrl = await captureWebcodecsThumbnailFromMp4Buffer(buffer, 112, 63);
            } catch { /* ignore */ }
        }

        previews.cache.set(groupId, { status: 'ready', thumbDataUrl, pathPoints });
        applyGroupPreviewToRow(groupId);
    };

    if (opts.highPriority) previews.queue.unshift(task);
    else previews.queue.push(task);
    pumpPreviewQueue();
}

function pumpPreviewQueue() {
    while (previews.inFlight < previews.maxConcurrency && previews.queue.length) {
        const task = previews.queue.shift();
        previews.inFlight++;
        Promise.resolve()
            .then(task)
            .catch(() => { })
            .finally(() => {
                previews.inFlight--;
                pumpPreviewQueue();
            });
    }
}

function applyGroupPreviewToRow(groupId) {
    const preview = previews.cache.get(groupId);
    if (!preview || preview.status !== 'ready') return;

    // Update any row that directly represents this group OR any collection row that references it as its preview group.
    const rows = [
        ...clipList.querySelectorAll(`.clip-item[data-groupid="${cssEscape(groupId)}"]`),
        ...clipList.querySelectorAll(`.clip-item[data-preview-groupid="${cssEscape(groupId)}"]`)
    ];
    for (const el of rows) {
        const img = el.querySelector('.clip-thumb img');
        if (img && preview.thumbDataUrl) img.src = preview.thumbDataUrl;

        const canvasEl = el.querySelector('canvas.clip-minimap');
        if (canvasEl && preview.pathPoints?.length) {
            drawMiniPath(canvasEl, preview.pathPoints);
        }
    }
}

function downsamplePoints(points, maxPoints) {
    if (!Array.isArray(points) || points.length <= maxPoints) return points;
    const step = points.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
    return out;
}

function drawMiniPath(canvasEl, points) {
    const c = canvasEl.getContext('2d');
    const w = canvasEl.width, h = canvasEl.height;
    c.clearRect(0, 0, w, h);

    // background
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(0, 0, w, h);

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lat, lon] of points) {
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    }
    const pad = 6;
    const dy = (maxLat - minLat) || 1e-9;

    // Avoid stretching when the canvas is rectangular: use a uniform scale and center the path.
    // Also compensate longitude by cos(meanLat) to reduce visual distortion at higher latitudes.
    const meanLat = (minLat + maxLat) / 2;
    const lonScale = Math.cos((meanLat * Math.PI) / 180) || 1;
    const minLonAdj = minLon * lonScale;
    const maxLonAdj = maxLon * lonScale;
    const dx = (maxLonAdj - minLonAdj) || 1e-9;

    const availW = Math.max(1, w - pad * 2);
    const availH = Math.max(1, h - pad * 2);
    const scale = Math.min(availW / dx, availH / dy);
    const contentW = dx * scale;
    const contentH = dy * scale;
    const offX = (w - contentW) / 2;
    const offY = (h - contentH) / 2;

    const project = (lat, lon) => {
        const x = offX + ((lon * lonScale - minLonAdj) * scale);
        const y = offY + ((maxLat - lat) * scale);
        return [x, y];
    };

    c.strokeStyle = 'rgba(62, 156, 191, 0.95)';
    c.lineWidth = 2;
    c.beginPath();
    points.forEach(([lat, lon], idx) => {
        const [x, y] = project(lat, lon);
        if (idx === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
    });
    c.stroke();

    // start/end markers
    const [sLat, sLon] = points[0];
    const [eLat, eLon] = points[points.length - 1];
    const [sx, sy] = project(sLat, sLon);
    const [ex, ey] = project(eLat, eLon);

    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.beginPath(); c.arc(sx, sy, 2.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255, 0, 0, 0.85)';
    c.beginPath(); c.arc(ex, ey, 2.5, 0, Math.PI * 2); c.fill();
}

async function fileToDataUrl(file) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
    });
}

async function captureVideoThumbnail(file, width, height) {
    const url = URL.createObjectURL(file);
    try {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.src = url;

        // Some browsers won't decode a drawable frame until after metadata + a seek + a frame callback.
        await new Promise((resolve, reject) => {
            const onError = () => reject(new Error('video load failed'));
            video.addEventListener('error', onError, { once: true });
            video.addEventListener('loadedmetadata', () => resolve(), { once: true });
            try { video.load(); } catch { /* ignore */ }
        });

        // Seek a bit to avoid black/empty first frame in some encodes.
        const seekTo = (() => {
            const d = Number.isFinite(video.duration) ? video.duration : 0;
            if (d > 0) return Math.min(0.5, Math.max(0.05, d * 0.05));
            return 0.1;
        })();
        try {
            video.currentTime = seekTo;
            await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
        } catch { /* ignore seek errors */ }

        // Wait for an actual decoded frame if possible.
        if (video.requestVideoFrameCallback) {
            await new Promise((resolve) => video.requestVideoFrameCallback(() => resolve()));
        } else {
            await new Promise((resolve, reject) => {
                const onError = () => reject(new Error('video decode failed'));
                video.addEventListener('error', onError, { once: true });
                video.addEventListener('canplay', () => resolve(), { once: true });
                // Safety timeout so we don't hang forever
                setTimeout(resolve, 250);
            });
        }

        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const cctx = c.getContext('2d');
        if (!video.videoWidth || !video.videoHeight) throw new Error('video has no decoded frame');
        cctx.drawImage(video, 0, 0, width, height);
        return c.toDataURL('image/jpeg', 0.72);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function captureWebcodecsThumbnailFromMp4Buffer(buffer, width, height) {
    if (!window.VideoDecoder) throw new Error('VideoDecoder not available');

    const localMp4 = new DashcamMP4(buffer);
    // Parse frames without decoding SEI for speed
    const localFrames = localMp4.parseFrames(null);
    const firstKeyIdx = localFrames.findIndex(f => f.keyframe);
    if (firstKeyIdx < 0) throw new Error('No keyframe found');

    const config = localMp4.getConfig();
    const frame = localFrames[firstKeyIdx];
    const sc = new Uint8Array([0, 0, 0, 1]);
    const data = frame.keyframe
        ? DashcamMP4.concat(sc, frame.sps || config.sps, sc, frame.pps || config.pps, sc, frame.data)
        : DashcamMP4.concat(sc, frame.data);

    const canvasEl = document.createElement('canvas');
    canvasEl.width = width;
    canvasEl.height = height;
    const cctx = canvasEl.getContext('2d');

    const decoder = new VideoDecoder({
        output: (vf) => {
            try {
                cctx.drawImage(vf, 0, 0, width, height);
            } finally {
                vf.close();
            }
        },
        error: () => { /* handled by flush */ }
    });
    decoder.configure({ codec: config.codec, width: config.width, height: config.height });
    decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
    await decoder.flush();
    try { decoder.close(); } catch { /* ignore */ }
    return canvasEl.toDataURL('image/jpeg', 0.72);
}

// escapeHtml/cssEscape moved to src/utils.js

// Playback Logic
playBtn.onclick = () => {
    const isPlaying = state.ui.nativeVideoMode ? nativeVideo.playing : player.playing;
    isPlaying ? pause() : play();
};
function previewAtSliderValue() {
    // Native video mode with day collection: seek across entire day
    if (state.ui.nativeVideoMode && state.collection.active) {
        const pct = +progressBar.value || 0;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        const targetSec = (pct / 100) * totalSec;
        seekNativeDayCollectionBySec(targetSec);
        return;
    }
    
    // Native video single clip: seek using percentage
    if (state.ui.nativeVideoMode && nativeVideo.master) {
        const pct = +progressBar.value || 0;
        seekNative(pct);
        return;
    }
    
    pause();
    if (state.collection.active) {
        // Keep step=1 for playback smoothness, but quantize user scrubs to reduce segment churn.
        const quantum = 100; // ms
        const raw = +progressBar.value || 0;
        const snapped = Math.round(raw / quantum) * quantum;
        progressBar.value = String(snapped);
        // Debounce heavy segment loads while dragging to avoid black frames and decoder churn.
        if (state.ui.collectionScrubPreviewTimer) clearTimeout(state.ui.collectionScrubPreviewTimer);
        state.ui.collectionScrubPreviewTimer = setTimeout(() => {
            state.ui.collectionScrubPreviewTimer = null;
            showCollectionAtMs(snapped);
        }, 120);
    } else {
        showFrame(+progressBar.value);
    }
}

function maybeAutoplayAfterSeek() {
    if (!autoplayToggle?.checked) return;
    // If the user is still dragging, don't restart yet.
    if (state.ui.isScrubbing) return;
    setTimeout(() => play(), 0);
}

// Preview while dragging/scrubbing
progressBar.addEventListener('input', () => {
    previewAtSliderValue();
});

// Commit when the user releases the slider (click or drag end)
progressBar.addEventListener('change', () => {
    state.ui.isScrubbing = false;
    if (state.ui.collectionScrubPreviewTimer) { clearTimeout(state.ui.collectionScrubPreviewTimer); state.ui.collectionScrubPreviewTimer = null; }
    
    // Native video mode: final seek
    if (state.ui.nativeVideoMode && state.collection.active) {
        const pct = +progressBar.value || 0;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        seekNativeDayCollectionBySec((pct / 100) * totalSec);
        return;
    }
    if (state.ui.nativeVideoMode && nativeVideo.master) {
        const pct = +progressBar.value || 0;
        seekNative(pct);
        return;
    }
    
    // For collections: do the final seek immediately on release (not debounced).
    if (state.collection.active) {
        pause();
        const quantum = 100;
        const raw = +progressBar.value || 0;
        const snapped = Math.round(raw / quantum) * quantum;
        progressBar.value = String(snapped);
        showCollectionAtMs(snapped).then(() => maybeAutoplayAfterSeek()).catch(() => { /* ignore */ });
        return;
    }
    previewAtSliderValue();
    maybeAutoplayAfterSeek();
});
progressBar.addEventListener('pointerdown', () => { state.ui.isScrubbing = true; });
progressBar.addEventListener('pointerup', () => { state.ui.isScrubbing = false; maybeAutoplayAfterSeek(); });
progressBar.addEventListener('pointercancel', () => { state.ui.isScrubbing = false; });

// Keyboard controls
document.addEventListener('keydown', (e) => {
    if (!player.frames && !state.collection.active) return;

    // Ignore keyboard shortcuts when an interactive element is focused
    // (buttons, inputs, selects) to avoid double-triggering
    const activeEl = document.activeElement;
    const isInteractive = activeEl && (
        activeEl.tagName === 'BUTTON' ||
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable
    );

    if (e.code === 'Space') {
        // If a button/input is focused, let the browser handle it normally
        if (isInteractive) return;
        e.preventDefault();
        player.playing ? pause() : play();
    } else if (e.code === 'Escape') {
        if (state.ui.openEventRowId) {
            e.preventDefault();
            closeEventPopout();
        } else if (state.ui.multiFocusSlot) {
            e.preventDefault();
            clearMultiFocus();
        }
    } else if (e.code === 'ArrowLeft' && e.shiftKey) {
        // Shift+Left: Skip back 15 seconds
        e.preventDefault();
        skipSeconds(-15);
    } else if (e.code === 'ArrowRight' && e.shiftKey) {
        // Shift+Right: Skip forward 15 seconds
        e.preventDefault();
        skipSeconds(15);
    } else if (e.code === 'ArrowLeft') {
        // Left: Small step back (1 second in native mode, frame in WebCodecs mode)
        e.preventDefault();
        if (state.ui.nativeVideoMode && nativeVideo.master) {
            nativeVideo.master.currentTime = Math.max(0, nativeVideo.master.currentTime - 1);
            syncMultiVideos(nativeVideo.master.currentTime);
        } else if (state.collection.active) {
            const prev = Math.max(0, +progressBar.value - 1000);
            progressBar.value = prev;
            showCollectionAtMs(prev);
            maybeAutoplayAfterSeek();
        } else {
            const prev = Math.max(0, +progressBar.value - 15);
            progressBar.value = prev;
            showFrame(prev);
            maybeAutoplayAfterSeek();
        }
    } else if (e.code === 'ArrowRight') {
        // Right: Small step forward
        e.preventDefault();
        if (state.ui.nativeVideoMode && nativeVideo.master) {
            nativeVideo.master.currentTime = Math.min(nativeVideo.master.duration || 0, nativeVideo.master.currentTime + 1);
            syncMultiVideos(nativeVideo.master.currentTime);
        } else if (state.collection.active) {
            const next = Math.min(+progressBar.max, +progressBar.value + 1000);
            progressBar.value = next;
            showCollectionAtMs(next);
            maybeAutoplayAfterSeek();
        } else {
            const next = Math.min(player.frames.length - 1, +progressBar.value + 15);
            progressBar.value = next;
            showFrame(next);
            maybeAutoplayAfterSeek();
        }
    }
});

function play() {
    // Use native video playback in native mode (GPU-accelerated, smooth)
    if (state.ui.nativeVideoMode) {
        playNative();
        return;
    }
    
    if (player.playing) return;
    if (!player.frames || !player.frames.length) {
        // In Sentry collection mode we may not have a segment loaded yet; load it, then start.
        if (state.collection.active) {
            player.playing = true;
            updatePlayButton();
            showCollectionAtMs(+progressBar.value || 0)
                .then(() => { if (player.playing) playNext(); })
                .catch(() => { pause(); });
            return;
        }
        return;
    }
    player.playing = true;
    updatePlayButton();
    
    // Dave Plummer Optimization: Drift-correcting clock
    // Reset the reference clock to "now". 
    // We will schedule future frames based on this baseline + cumulative duration.
    player.nextFrameTime = performance.now();
    playNext();
}

function pause() {
    // Use native video pause in native mode
    if (state.ui.nativeVideoMode) {
        pauseNative();
        return;
    }
    
    player.playing = false;
    updatePlayButton();
    if (player.playTimer) { clearTimeout(player.playTimer); player.playTimer = null; }
    // When pausing, we should flush the pipeline so the last requested frame actually appears
    if (player.decoder && player.decoder.state === 'configured') {
        player.decoder.flush().catch(() => {});
    }
    
    // Stop steering wheel animation when paused
    stopSteeringAnimation();
}

function updatePlayButton() {
    const isPlaying = state.ui.nativeVideoMode ? nativeVideo.playing : player.playing;
    playBtn.innerHTML = isPlaying 
        ? '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}

function playNext() {
    if (!player.playing) return;

    // Sentry Collection Mode Handling
    if (state.collection.active) {
        if (player.playTimer) { clearTimeout(player.playTimer); player.playTimer = null; }
        
        // If loading a segment, spin-wait briefly (could be optimized further but fine for boundary)
        if (state.collection.active.loading) {
            player.playTimer = setTimeout(playNext, 20); 
            player.nextFrameTime = performance.now(); // Reset clock while loading
            return;
        }

        const currentMs = +progressBar.value;
        const idx = Math.min(Math.max(state.collection.active.currentLocalFrameIdx || 0, 0), (player.frames?.length || 1) - 1);
        const frameDur = player.frames?.[idx]?.duration || 33;
        const playbackRate = state.ui.playbackRate || 1;
        
        // Advance time (at playback speed)
        const nextMs = currentMs + (frameDur * playbackRate);
        if (nextMs > +progressBar.max) {
            pause();
            return;
        }

        progressBar.value = Math.floor(nextMs);

        // Schedule next tick (adjusted for playback speed)
        // 1. Calculate ideal time for next frame
        const adjustedFrameDur = frameDur / playbackRate;
        player.nextFrameTime += adjustedFrameDur;
        const now = performance.now();
        let delay = player.nextFrameTime - now;

        // 2. Drift correction: if we are lagging significantly (>100ms), reset the clock to avoid catch-up fast-forwarding
        if (delay < -100) {
            player.nextFrameTime = now;
            delay = 0;
        }

        showCollectionAtMs(nextMs)
            .then(() => {
                if (!player.playing) return;
                // Wait for the calculated delay
                player.playTimer = setTimeout(playNext, Math.max(0, delay));
            })
            .catch(() => pause());
        return;
    }

    // Standard Clip Mode
    let next = +progressBar.value + 1;
    if (!player.frames || next >= player.frames.length) {
        pause();
        return;
    }

    // Optimization: Check decoder backpressure
    // If the decoder queue is backing up, skip scheduling a new frame draw this tick to let it drain.
    // We still advance the clock (drop frame) to maintain sync, OR we just wait.
    // For smooth playback, we want to feed it. If it's full, we wait.
    if (player.decoder && player.decoder.decodeQueueSize > 5) {
        // Backpressure detected. Re-schedule immediately to check again, 
        // effectively busy-waiting (or small sleep) until queue drains.
        // Don't advance 'next' yet.
        player.playTimer = setTimeout(playNext, 5); 
        return;
    }

    progressBar.value = next;
    showFrame(next);

    const frameDur = player.frames[next].duration || 33;
    const playbackRate = state.ui.playbackRate || 1;
    
    // Drift-correcting scheduling (adjusted for playback speed)
    const adjustedFrameDur = frameDur / playbackRate;
    player.nextFrameTime += adjustedFrameDur;
    const now = performance.now();
    let delay = player.nextFrameTime - now;

    // Sync recovery
    if (delay < -100) {
        player.nextFrameTime = now;
        delay = 0;
    }

    player.playTimer = setTimeout(playNext, Math.max(0, delay));
}

function showFrame(index) {
    if (!player.frames?.[index]) return;
    
    // Update visualization and time display
    // Note: In native video mode, telemetry is updated via onMasterTimeUpdate() instead
    updateVisualization(player.frames[index].sei);
    updateTimeDisplay(index);
}

function findFrameIndexAtLocalMs(localMs) {
    if (!player.frames?.length) return 0;
    let lo = 0, hi = player.frames.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if ((player.frames[mid].timestamp || 0) <= localMs) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

async function showCollectionAtMs(ms) {
    if (!state.collection.active) return;
    const token = ++state.collection.active.loadToken;
    const clamped = Math.max(0, Math.min(state.collection.active.durationMs, ms));

    // Find segment index by start offsets
    const starts = state.collection.active.segmentStartsMs;
    let segIdx = 0;
    for (let i = 0; i < starts.length; i++) {
        if (starts[i] <= clamped) segIdx = i;
        else break;
    }

    const segStart = starts[segIdx] || 0;
    const localMs = Math.max(0, clamped - segStart);

    if (segIdx !== state.collection.active.currentSegmentIdx) {
        await loadCollectionSegment(segIdx, token);
        if (!state.collection.active || state.collection.active.loadToken !== token) return;
    }

    // Render the nearest frame in the current segment.
    const idx = findFrameIndexAtLocalMs(localMs);
    state.collection.active.currentLocalFrameIdx = idx;
    progressBar.value = Math.floor(clamped);
    showFrame(idx);
}

async function loadCollectionSegment(segIdx, token) {
    // Legacy WebCodecs segment loading - native video uses loadNativeSegment() instead
    // This is kept for Sentry collection mode compatibility but is not used in day collections
    if (!state.collection.active) return;
    state.collection.active.currentSegmentIdx = segIdx;
    state.collection.active.loading = false;
}

// Legacy WebCodecs rendering functions removed - native video playback is now used exclusively

// G-Force Meter Logic
const GRAVITY = 9.81; // m/s² per G
const GFORCE_SCALE = 25; // pixels per G (radius of meter is ~28px, so 1G reaches near edge)

function updateGForceMeter(sei) {
    if (!gforceDot) return;

    // Get acceleration values (in m/s²) - support both naming conventions
    const accX = sei?.linearAccelerationMps2X ?? sei?.linear_acceleration_mps2_x ?? 0;
    const accY = sei?.linearAccelerationMps2Y ?? sei?.linear_acceleration_mps2_y ?? 0;

    // Convert to G-force
    const gX = accX / GRAVITY;
    const gY = accY / GRAVITY;

    // Clamp to reasonable range (-2G to +2G for display)
    const clampedGX = Math.max(-2, Math.min(2, gX));
    const clampedGY = Math.max(-2, Math.min(2, gY));

    // Calculate dot position (center is 30,30 in the SVG viewBox)
    // X: positive = right (cornering left causes rightward force)
    // Y: positive = down (braking causes forward force, shown as down)
    const dotX = 30 + (clampedGX * GFORCE_SCALE);
    const dotY = 30 - (clampedGY * GFORCE_SCALE); // Invert Y so acceleration shows up

    // Update trail history
    gforceHistory.unshift({ x: dotX, y: dotY });
    if (gforceHistory.length > GFORCE_HISTORY_MAX) {
        gforceHistory.pop();
    }

    // Update dot position
    gforceDot.setAttribute('cx', dotX);
    gforceDot.setAttribute('cy', dotY);

    // Update trail dots
    if (gforceTrail1 && gforceHistory.length > 0) {
        gforceTrail1.setAttribute('cx', gforceHistory[0]?.x || 30);
        gforceTrail1.setAttribute('cy', gforceHistory[0]?.y || 30);
    }
    if (gforceTrail2 && gforceHistory.length > 1) {
        gforceTrail2.setAttribute('cx', gforceHistory[1]?.x || 30);
        gforceTrail2.setAttribute('cy', gforceHistory[1]?.y || 30);
    }
    if (gforceTrail3 && gforceHistory.length > 2) {
        gforceTrail3.setAttribute('cx', gforceHistory[2]?.x || 30);
        gforceTrail3.setAttribute('cy', gforceHistory[2]?.y || 30);
    }

    // Color the dot based on force type
    const totalG = Math.sqrt(gX * gX + gY * gY);
    gforceDot.classList.remove('braking', 'accelerating', 'cornering-hard');
    if (gY < -0.3) {
        gforceDot.classList.add('braking');
    } else if (gY > 0.3) {
        gforceDot.classList.add('accelerating');
    } else if (Math.abs(gX) > 0.5) {
        gforceDot.classList.add('cornering-hard');
    }

    // Update numeric displays
    if (gforceX) {
        gforceX.textContent = (gX >= 0 ? '+' : '') + gX.toFixed(1);
        gforceX.classList.remove('positive', 'negative', 'high');
        if (Math.abs(gX) > 0.8) gforceX.classList.add('high');
        else if (gX > 0.2) gforceX.classList.add('positive');
        else if (gX < -0.2) gforceX.classList.add('negative');
    }
    if (gforceY) {
        gforceY.textContent = (gY >= 0 ? '+' : '') + gY.toFixed(1);
        gforceY.classList.remove('positive', 'negative', 'high');
        if (Math.abs(gY) > 0.8) gforceY.classList.add('high');
        else if (gY > 0.2) gforceY.classList.add('positive');
        else if (gY < -0.2) gforceY.classList.add('negative');
    }
}

// Compass update
function updateCompass(sei) {
    if (!compassNeedle) return;

    // Get heading - support both naming conventions
    let heading = parseFloat(sei?.headingDeg ?? sei?.heading_deg);
    if (!Number.isFinite(heading)) heading = 0;
    
    // Normalize to 0-360 range
    heading = ((heading % 360) + 360) % 360;
    
    // Rotate the needle - heading 0° = North (pointing up)
    compassNeedle.setAttribute('transform', `rotate(${heading} 30 30)`);
    
    // Update numeric display
    if (compassValue) {
        // Format heading with cardinal direction
        const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const index = Math.round(heading / 45) % 8;
        const cardinal = cardinals[index] || 'N';
        compassValue.textContent = `${Math.round(heading)}° ${cardinal}`;
    }
}

// Visualization Logic - support both camelCase (protobufjs) and snake_case
function updateVisualization(sei) {
    if (!sei) return;

    // Helper to get field value (supports both naming conventions)
    const get = (camel, snake) => sei[camel] ?? sei[snake];

    // Speed (use absolute value to avoid negative display when in reverse)
    const mps = Math.abs(get('vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    speedValue.textContent = speed;
    const unitEl = $('speedUnit');
    if (unitEl) unitEl.textContent = useMetric ? 'KM/H' : 'MPH';

    // Gear
    const gear = get('gearState', 'gear_state');
    let gearText = '--';
    if (gear === 0) gearText = 'Park'; // PARK
    else if (gear === 1) gearText = 'Drive'; // DRIVE
    else if (gear === 2) gearText = 'Reverse'; // REVERSE
    else if (gear === 3) gearText = 'Neutral'; // NEUTRAL
    
    if (gearState) {
        gearState.textContent = gearText;
    }

    // Blinkers - pause animation when video is not playing
    const isCurrentlyPlaying = state.ui.nativeVideoMode ? nativeVideo.playing : player.playing;
    blinkLeft?.classList.toggle('active', !!get('blinkerOnLeft', 'blinker_on_left'));
    blinkRight?.classList.toggle('active', !!get('blinkerOnRight', 'blinker_on_right'));
    blinkLeft?.classList.toggle('paused', !isCurrentlyPlaying);
    blinkRight?.classList.toggle('paused', !isCurrentlyPlaying);

    // Steering
    const targetAngle = get('steeringWheelAngle', 'steering_wheel_angle') || 0;
    smoothSteeringTo(targetAngle);

    // Autopilot
    const apState = get('autopilotState', 'autopilot_state');
    const autosteerIcon = $('autosteerIcon');
    const isActive = apState === 1 || apState === 2;
    
    if (autosteerIcon) {
        autosteerIcon.classList.toggle('active', isActive);
    }
    apText?.classList.toggle('active', isActive);
    gearState?.classList.toggle('active', isActive);
    
    if (apState === 1) {
        if (apText) apText.textContent = 'Self Driving';
    } else if (apState === 2) {
        if (apText) apText.textContent = 'Autosteer';
    } else if (apState === 3) {
        if (apText) apText.textContent = 'TACC';
    } else {
        if (apText) apText.textContent = 'Manual';
    }

    // Brake - also detect Tesla's auto-hold (gear in Drive but speed is 0)
    const brakeState = get('brakeApplied', 'brake_applied');
    const isAutoHold = gear === 1 && mps < 0.01; // Gear Drive (1) and essentially stopped
    brakeIcon?.classList.toggle('active', !!brakeState || isAutoHold);

    // Accelerator pedal - lights up when pressed
    const accelPosRaw = get('acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPedal = $('accelPedal');
    if (accelPedal) {
        // Detect if pressed (handle both 0-1 and 0-100 ranges)
        const isPressed = accelPosRaw > 1 ? accelPosRaw > 5 : accelPosRaw > 0.05;
        accelPedal.classList.toggle('active', isPressed);
    }

    // Extra Data
    const seqNo = get('frameSeqNo', 'frame_seq_no');
    const lat = get('latitudeDeg', 'latitude_deg') || 0;
    const lon = get('longitudeDeg', 'longitude_deg') || 0;
    const heading = get('headingDeg', 'heading_deg') || 0;
    const accX = get('linearAccelerationMps2X', 'linear_acceleration_mps2_x') || 0;
    const accY = get('linearAccelerationMps2Y', 'linear_acceleration_mps2_y') || 0;
    const accZ = get('linearAccelerationMps2Z', 'linear_acceleration_mps2_z') || 0;
    
    if (valSeq) valSeq.textContent = seqNo ?? '--';
    if (valLat) valLat.textContent = lat.toFixed(6);
    if (valLon) valLon.textContent = lon.toFixed(6);
    if (valHeading) valHeading.textContent = heading.toFixed(1) + '°';
    
    // Acceleration values (valAccX/Y/Z removed - elements don't exist in HTML)
    // G-force meter already displays this information

    // G-Force Meter Update
    updateGForceMeter(sei);

    // Compass Update
    updateCompass(sei);

    // Map Update
    if (map && hasValidGps(sei)) {
        const latlng = [lat, lon];
        
        // Only proceed if we have valid, non-zero coordinates
        if (Math.abs(lat) < 0.001 || Math.abs(lon) < 0.001) {
            // Remove marker if coordinates are invalid
            if (mapMarker) {
                mapMarker.remove();
                mapMarker = null;
            }
            return;
        }
        
        // Calculate target heading normalized to 0-360
        const targetHeading = ((heading % 360) + 360) % 360;
        
        // Calculate shortest rotation path to avoid 360° spins
        // Find the difference and adjust if it would spin the long way
        let delta = targetHeading - (currentMapArrowRotation % 360);
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        currentMapArrowRotation += delta;
        
        // Calculate transition duration based on playback rate (faster playback = faster transitions)
        const transitionDuration = Math.max(0.03, 0.15 / (state.ui.playbackRate || 1));
        
        // Only recreate marker if it doesn't exist or position changed significantly
        if (!mapMarker) {
            // Initialize rotation to target
            currentMapArrowRotation = targetHeading;
            
            // Create arrow using divIcon for full control over HTML/CSS and positioning
            const arrowIcon = L.divIcon({
                className: 'arrow-marker-icon',
                html: `<img src="../../assets/arrow.png" style="width: 77px; height: 77px; transform: rotate(${currentMapArrowRotation}deg); transform-origin: center center; transition: transform ${transitionDuration}s ease-out; display: block;" />`,
                iconSize: [77, 77],
                iconAnchor: [38, 38], // Center for 77x77 icon
                popupAnchor: [0, -38]
            });
            
            // Create marker with current valid coordinates
            mapMarker = L.marker(latlng, { icon: arrowIcon }).addTo(map);
        } else {
            // Always update marker position for smooth movement
            // CSS transitions handle the visual smoothing
            mapMarker.setLatLng(latlng);
            
            // Update rotation using cumulative rotation (prevents 360° spins)
            const iconElement = mapMarker._icon;
            if (iconElement) {
                const imgElement = iconElement.querySelector('img');
                if (imgElement) {
                    imgElement.style.transition = `transform ${transitionDuration}s ease-out`;
                    imgElement.style.transform = `rotate(${currentMapArrowRotation}deg)`;
                } else {
                    // If img not found, recreate icon with updated rotation
                    const newArrowIcon = L.divIcon({
                        className: 'arrow-marker-icon',
                        html: `<img src=\"../../assets/arrow.png\" style=\"width: 77px; height: 77px; transform: rotate(${currentMapArrowRotation}deg); transform-origin: center center; transition: transform ${transitionDuration}s ease-out; display: block;\" />`,
                        iconSize: [77, 77],
                        iconAnchor: [38, 38],
                        popupAnchor: [0, -38]
                    });
                    mapMarker.setIcon(newArrowIcon);
                }
            }
        }
    } else if (mapMarker) {
        // If GPS becomes invalid, remove the marker
        mapMarker.remove();
        mapMarker = null;
    }
}

// Toggle Extra Data - prevent all event bubbling to avoid interfering with playback
toggleExtra.addEventListener('mousedown', (e) => e.stopPropagation());
toggleExtra.addEventListener('pointerdown', (e) => e.stopPropagation());
toggleExtra.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    extraDataContainer.classList.toggle('expanded');
    // Refresh data if expanding while paused
    if (extraDataContainer.classList.contains('expanded') && player.frames && progressBar.value) {
         updateVisualization(player.frames[+progressBar.value].sei);
    }
    // Blur so Space key works for play/pause immediately after
    toggleExtra.blur();
};

// Prevent dashboard interactions from bubbling to videoContainer
dashboardVis.addEventListener('mousedown', (e) => {
    // Only stop propagation if not on the drag handle
    if (!e.target.closest('.vis-header')) {
        e.stopPropagation();
    }
});
dashboardVis.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.vis-header')) {
        e.stopPropagation();
    }
});

// Format time as HH:MM:SS
function formatTimeHMS(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Update time display (new format with current/total)
// Update the recording time display from the current segment filename
function updateRecordingTime(segIdx) {
    const timeText = document.getElementById('recordingTimeText');
    if (!timeText) return;
    
    try {
        const group = state.collection.active?.groups?.[segIdx];
        if (!group) return;
        
        // Get any file from the group to extract timestamp
        let filename = null;
        if (group.filesByCamera) {
            const iter = group.filesByCamera.values();
            const first = iter.next();
            if (first.value?.file?.name) filename = first.value.file.name;
        }
        if (!filename) return;
        
        // Tesla filename format: 2024-12-15_14-30-45-front.mp4
        const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
        if (match) {
            const [, , , , hour, min, sec] = match;
            // Add current video position to the base timestamp
            const vid = nativeVideo.master;
            const vidSec = vid ? Math.floor(vid.currentTime || 0) : 0;
            
            // Calculate actual time
            let totalSeconds = parseInt(hour) * 3600 + parseInt(min) * 60 + parseInt(sec) + vidSec;
            totalSeconds = totalSeconds % 86400; // Wrap at 24 hours
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            
            const ampm = h >= 12 ? 'PM' : 'AM';
            const h12 = h % 12 || 12;
            timeText.textContent = `${h12}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} ${ampm}`;
        }
    } catch (e) {
        console.warn('updateRecordingTime error:', e);
    }
}

function updateTimeDisplayNew(currentSec, totalSec) {
    if (currentTimeEl) currentTimeEl.textContent = formatTimeHMS(currentSec);
    if (totalTimeEl) totalTimeEl.textContent = formatTimeHMS(totalSec);
}

function updateTimeDisplay(frameIndex) {
    if (state.collection.active) {
        const currentSec = Math.floor((+progressBar.value || 0) / 1000);
        const totalSec = Math.floor((state.collection.active.durationMs || 0) / 1000);
        updateTimeDisplayNew(currentSec, totalSec);
        return;
    }
    if (!player.frames || !player.frames[frameIndex]) return;
    const currentSec = Math.floor(player.frames[frameIndex].timestamp / 1000);
    const totalSec = player.frames.length > 0 ? Math.floor(player.frames[player.frames.length - 1].timestamp / 1000) : 0;
    updateTimeDisplayNew(currentSec, totalSec);
}

// ============================================================
// Skip Seconds (Sentry Six style ±15s)
// ============================================================
function skipSeconds(delta) {
    // Native video day collection mode - use actual durations
    if (state.ui.nativeVideoMode && state.collection.active) {
        const vid = nativeVideo.master;
        if (!vid) return;
        
        const segIdx = nativeVideo.currentSegmentIdx || 0;
        const cumStart = nativeVideo.cumulativeStarts[segIdx] || 0;
        const currentSec = cumStart + vid.currentTime;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        const newSec = Math.max(0, Math.min(totalSec, currentSec + delta));
        
        seekNativeDayCollectionBySec(newSec);
        return;
    }
    
    // WebCodecs collection mode
    if (state.collection.active) {
        const currentMs = +progressBar.value || 0;
        const newMs = Math.max(0, Math.min(state.collection.active.durationMs, currentMs + delta * 1000));
        progressBar.value = Math.floor(newMs);
        showCollectionAtMs(newMs);
    } else if (player.frames?.length) {
        // Clip mode: find frame ~delta seconds away
        const currentIdx = +progressBar.value || 0;
        const currentTs = player.frames[currentIdx]?.timestamp || 0;
        const targetTs = currentTs + delta * 1000;
        let lo = 0, hi = player.frames.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            if (player.frames[mid].timestamp <= targetTs) lo = mid;
            else hi = mid - 1;
        }
        const newIdx = Math.max(0, Math.min(player.frames.length - 1, lo));
        progressBar.value = newIdx;
        showFrame(newIdx);
    }
}

// ============================================================
// Native Video Playback System (GPU-accelerated, smooth)
// ============================================================
const nativeVideo = {
    master: null,           // Master video element (drives timeline)
    streams: new Map(),     // slot -> { video, file, url }
    playing: false,
    currentSegmentIdx: -1,
    syncInterval: null,
    seiData: [],            // Pre-extracted SEI: [{timestampMs, sei}, ...]
    mapPath: [],            // GPS path for map polyline
    segmentDurations: [],   // Actual duration of each segment in seconds
    cumulativeStarts: [],   // Cumulative start time of each segment in seconds
    isTransitioning: false, // Guard to prevent double-triggering segment transitions
    lastSeiTimeMs: -Infinity, // Track last timestamp where SEI data was found
    dashboardReset: false   // Track if dashboard has been reset for no-SEI section
};

function initNativeVideoPlayback() {
    console.log('Initializing native video playback');
    console.log('videoMain:', videoMain?.id);
    console.log('videoBySlot:', Object.fromEntries(Object.entries(videoBySlot).map(([k, v]) => [k, v?.id])));
    
    // Set up event listeners on ALL video elements
    // Master events will only fire when that element is actually the master
    const allVideos = [videoMain, ...Object.values(videoBySlot)].filter(Boolean);
    console.log('All videos:', allVideos.length, 'elements');
    
    allVideos.forEach(vid => {
        vid.addEventListener('timeupdate', () => {
            if (vid === nativeVideo.master) onMasterTimeUpdate();
        });
        vid.addEventListener('ended', () => {
            if (vid === nativeVideo.master) onMasterEnded();
        });
        vid.addEventListener('loadedmetadata', () => {
            if (vid === nativeVideo.master) onMasterLoaded();
            // Sync non-master videos to master time
            else if (nativeVideo.master && nativeVideo.master !== vid) {
                vid.currentTime = nativeVideo.master.currentTime;
            }
        });
        vid.addEventListener('play', () => {
            if (vid === nativeVideo.master) {
                nativeVideo.playing = true;
                updatePlayButton();
            }
        });
        vid.addEventListener('pause', () => {
            if (vid === nativeVideo.master) {
                nativeVideo.playing = false;
                updatePlayButton();
            }
        });
    });
}

function onMasterTimeUpdate() {
    const vid = nativeVideo.master || videoMain;
    if (!vid) return;
    
    // Skip time updates during segment transitions to prevent time display glitches
    if (nativeVideo.isTransitioning) return;
    
    const currentVidSec = vid.currentTime || 0;
    const currentVidMs = currentVidSec * 1000;
    
    // Update telemetry overlay from pre-extracted SEI data
    const sei = findSeiAtTime(currentVidMs);
    if (sei) {
        updateVisualization(sei);
        nativeVideo.lastSeiTimeMs = currentVidMs;
        nativeVideo.dashboardReset = false;
    } else {
        // No SEI data at this timestamp - check if we should show "no data" state
        // Only reset if we haven't had SEI data for 2+ seconds of video time
        const lastSei = nativeVideo.lastSeiTimeMs ?? -Infinity;
        const timeSinceLastSei = currentVidMs - lastSei;
        if (timeSinceLastSei > 2000 && !nativeVideo.dashboardReset) {
            // Show "no data" state for dashboard (but keep any event.json map marker)
            resetDashboardOnly();
            nativeVideo.dashboardReset = true;
        }
    }
    
    // For day collections, calculate position using actual segment durations
    if (state.collection.active && state.ui.nativeVideoMode) {
        // Use >= 0 check to properly handle segment 0 (0 is falsy in JS)
        const segIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
        const cumStart = nativeVideo.cumulativeStarts[segIdx] || 0;
        const currentSec = cumStart + currentVidSec;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        
        updateTimeDisplayNew(Math.floor(currentSec), Math.floor(totalSec));
        updateRecordingTime(segIdx);
        
        // Progress bar as smooth percentage
        const pct = (currentSec / totalSec) * 100;
        progressBar.value = Math.min(100, pct);
        return;
    }
    
    // Single clip mode
    const totalSec = vid.duration || 0;
    updateTimeDisplayNew(currentVidSec, totalSec);
    if (totalSec > 0) {
        progressBar.value = (currentVidSec / totalSec) * 100;
    }
    
    // Sync other videos to master
    syncMultiVideos(currentVidSec);
}

function onMasterLoaded() {
    const vid = nativeVideo.master || videoMain;
    if (!vid) return;
    
    const actualDuration = vid.duration || 60;
    const segIdx = nativeVideo.currentSegmentIdx || 0;
    
    // Update segment duration with actual value
    if (nativeVideo.segmentDurations && segIdx < nativeVideo.segmentDurations.length) {
        const oldDur = nativeVideo.segmentDurations[segIdx];
        nativeVideo.segmentDurations[segIdx] = actualDuration;
        
        // Recalculate cumulative starts from this segment onward
        if (nativeVideo.cumulativeStarts && oldDur !== actualDuration) {
            let cum = nativeVideo.cumulativeStarts[segIdx];
            for (let i = segIdx; i < nativeVideo.segmentDurations.length; i++) {
                nativeVideo.cumulativeStarts[i] = cum;
                cum += nativeVideo.segmentDurations[i];
            }
            nativeVideo.cumulativeStarts[nativeVideo.segmentDurations.length] = cum;
        }
    }
    
    progressBar.disabled = false;
    playBtn.disabled = false;
}

function onMasterEnded() {
    console.log('onMasterEnded called, isTransitioning:', nativeVideo.isTransitioning, 'segIdx:', nativeVideo.currentSegmentIdx);
    
    // Guard against double-triggering during segment transitions
    if (nativeVideo.isTransitioning) {
        console.log('onMasterEnded: Already transitioning, ignoring');
        return;
    }
    
    // If in day collection, advance to next segment automatically
    if (state.collection.active && state.ui.nativeVideoMode) {
        // Use >= 0 check instead of || 0 to properly handle segment index 0
        const currentIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
        const nextSegIdx = currentIdx + 1;
        
        console.log('Advancing from segment', currentIdx, 'to', nextSegIdx, 'of', state.collection.active.groups.length);
        
        if (nextSegIdx < state.collection.active.groups.length) {
            // Set transition guard to prevent re-triggering
            nativeVideo.isTransitioning = true;
            
            // NOTE: If the video ended naturally, it was playing - so we should continue playing
            // The pause event fires before ended, so nativeVideo.playing is already false here
            // We ALWAYS want to continue playing when auto-advancing on ended
            
            loadNativeSegment(nextSegIdx).then(() => {
                nativeVideo.isTransitioning = false;
                // Always continue playing when auto-advancing (video only ends if it was playing)
                console.log('Segment loaded, starting playback');
                playNative();
            }).catch(err => {
                nativeVideo.isTransitioning = false;
                console.error('Failed to load next segment:', err);
            });
            return;
        } else {
            console.log('Reached end of all segments');
        }
    }
    // End of day or single clip - pause
    nativeVideo.playing = false;
    updatePlayButton();
}

// Load a segment using native video elements (fast, GPU-accelerated)
async function loadNativeSegment(segIdx) {
    if (!state.collection.active) return;
    
    const group = state.collection.active.groups?.[segIdx];
    if (!group) {
        console.error('No group found for segment', segIdx);
        return;
    }
    
    console.log('Loading native segment', segIdx, 'group:', group.id, 'cameras:', Array.from(group.filesByCamera.keys()));
    
    // Pause all videos before changing sources to prevent race conditions
    if (nativeVideo.master) {
        nativeVideo.master.pause();
    }
    Object.values(videoBySlot).forEach(vid => {
        if (vid && vid.src) vid.pause();
    });
    
    nativeVideo.currentSegmentIdx = segIdx;
    state.collection.active.currentSegmentIdx = segIdx;
    
    // Clear stale SEI data immediately to prevent old segment data from showing during transition
    nativeVideo.seiData = [];
    nativeVideo.mapPath = [];
    nativeVideo.lastSeiTimeMs = -Infinity;
    nativeVideo.dashboardReset = false;
    
    // Clean up old URLs
    videoUrls.forEach((url, vid) => {
        if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    });
    videoUrls.clear();
    
    // Helper to get video URL from entry (handles both File objects and Electron paths)
    const getVideoUrl = (entry) => {
        if (!entry) return null;
        
        // If it's an Electron file with path, use file:// protocol
        if (entry.file?.isElectronFile && entry.file?.path) {
            const filePath = entry.file.path;
            // Convert path to file:// URL
            const fileUrl = filePath.startsWith('/') 
                ? `file://${filePath}` 
                : `file:///${filePath.replace(/\\/g, '/')}`;
            return { url: fileUrl, isBlob: false };
        }
        
        // Regular File object - create blob URL
        if (entry.file && entry.file instanceof File) {
            const url = URL.createObjectURL(entry.file);
            return { url, isBlob: true };
        }
        
        return null;
    };
    
    if (multi.enabled) {
        // Load all cameras
        const layout = MULTI_LAYOUTS[multi.layoutId] || MULTI_LAYOUTS[DEFAULT_MULTI_LAYOUT];
        const slotsArr = layout?.slots || [];
        
        console.log('Multi-cam layout:', multi.layoutId, 'slots:', slotsArr);
        
        for (const slotDef of slotsArr) {
            const { slot, camera } = slotDef;
            const vid = videoBySlot[slot];
            if (!vid) {
                console.warn('No video element for slot:', slot);
                continue;
            }
            
            const entry = group.filesByCamera.get(camera);
            const urlData = getVideoUrl(entry);
            if (urlData) {
                videoUrls.set(vid, urlData.url);
                vid.src = urlData.url;
                vid.load();
                console.log('Loaded', camera, 'into slot', slot, urlData.isBlob ? '(blob)' : '(file://)');
            } else {
                vid.src = '';
                console.log('No file for camera', camera, 'in slot', slot);
            }
        }
        
        // Set master to front camera or first available
        const masterCam = multi.masterCamera || 'front';
        const masterSlotDef = slotsArr.find(s => s.camera === masterCam);
        const masterSlot = masterSlotDef?.slot;
        nativeVideo.master = masterSlot ? videoBySlot[masterSlot] : videoMain;
        
        console.log('Master camera:', masterCam, 'slot:', masterSlot, 'video:', nativeVideo.master?.id);
        
        setMultiCamGridVisible(true);
    } else {
        // Single camera
        const cam = selection.selectedCamera || 'front';
        const entry = group.filesByCamera.get(cam) || group.filesByCamera.values().next().value;
        
        const urlData = getVideoUrl(entry);
        if (urlData) {
            videoUrls.set(videoMain, urlData.url);
            videoMain.src = urlData.url;
            videoMain.load();
            console.log('Loaded single camera', cam, urlData.isBlob ? '(blob)' : '(file://)');
        } else {
            console.error('No file found for camera', cam);
        }
        
        nativeVideo.master = videoMain;
        setMultiCamGridVisible(false);
    }
    
    // Show dashboard and map panels
    dashboardVis.classList.add('visible');
    mapVis.classList.add('visible');
    
    // Pre-extract SEI telemetry from master camera file (runs in background)
    const masterCam = multi.masterCamera || 'front';
    const masterEntry = group.filesByCamera.get(masterCam) || group.filesByCamera.values().next().value;
    if (masterEntry && seiType) {
        extractSeiFromEntry(masterEntry).then(({ seiData, mapPath }) => {
            nativeVideo.seiData = seiData;
            nativeVideo.mapPath = mapPath;
            // Draw route on map
            if (map && mapPath.length > 0) {
                if (mapPolyline) mapPolyline.remove();
                mapPolyline = L.polyline(mapPath, { color: '#3e9cbf', weight: 3, opacity: 0.7 }).addTo(map);
                map.invalidateSize();
                map.fitBounds(mapPolyline.getBounds(), { padding: [20, 20] });
                // Re-center map after 1 second to ensure proper centering if a glitch occurred
                setTimeout(() => {
                    if (map && mapPolyline) {
                        map.invalidateSize();
                        map.fitBounds(mapPolyline.getBounds(), { padding: [20, 20] });
                    }
                }, 1000);
            }
        }).catch(err => console.warn('SEI extraction failed:', err));
    }
    
    // Wait for master to be ready
    if (!nativeVideo.master) {
        console.error('No master video element');
        return;
    }
    
    console.log('Waiting for master video to load, current readyState:', nativeVideo.master.readyState, 'src:', nativeVideo.master.src?.substring(0, 60));
    
    // Wait for video to be ready
    await new Promise((resolve, reject) => {
        const vid = nativeVideo.master;
        let resolved = false;
        
        const cleanup = () => {
            vid.removeEventListener('loadedmetadata', onLoaded);
            vid.removeEventListener('canplay', onLoaded);
            vid.removeEventListener('error', onError);
        };
        
        const onLoaded = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            clearTimeout(timeout);
            console.log('Master video ready, readyState:', vid.readyState, 'duration:', vid.duration?.toFixed(2));
            resolve();
        };
        
        const onError = (e) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            clearTimeout(timeout);
            console.error('Video load error:', e);
            reject(e);
        };
        
        const timeout = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            cleanup();
            // Don't reject - just continue and hope for the best
            console.warn('Timeout waiting for video to load, continuing anyway. readyState:', vid.readyState);
            resolve();
        }, 5000);
        
        // Listen for both loadedmetadata and canplay (canplay is more reliable)
        vid.addEventListener('loadedmetadata', onLoaded, { once: true });
        vid.addEventListener('canplay', onLoaded, { once: true });
        vid.addEventListener('error', onError, { once: true });
        
        // Check if already ready (but give a tick for load() to reset state)
        requestAnimationFrame(() => {
            if (!resolved && vid.readyState >= 2) {
                console.log('Video already ready (readyState:', vid.readyState, ')');
                onLoaded();
            }
        });
    });
    
    // Reset video to start (ensure clean state after loading new segment)
    if (nativeVideo.master) {
        nativeVideo.master.currentTime = 0;
    }
    
    // Re-apply playback rate after loading new segment
    applyPlaybackRate(state.ui.playbackRate);
    
    console.log('Segment', segIdx, 'loaded and ready to play');
    
    // Note: Playback is NOT auto-started here. Callers are responsible for calling playNative() if needed.
}

function playNative() {
    console.log('playNative called, master:', nativeVideo.master?.id, 
        'segIdx:', nativeVideo.currentSegmentIdx,
        'readyState:', nativeVideo.master?.readyState,
        'duration:', nativeVideo.master?.duration?.toFixed(2),
        'currentTime:', nativeVideo.master?.currentTime?.toFixed(2));
    
    if (!nativeVideo.master || !nativeVideo.master.src) {
        console.error('playNative: No master video or src');
        return;
    }
    
    nativeVideo.playing = true;
    player.playing = true;
    updatePlayButton();
    
    // Play master
    nativeVideo.master.play().then(() => {
        console.log('Master video now playing');
    }).catch(err => {
        console.error('Failed to play master video:', err);
    });
    
    // Play all multi-cam videos
    if (multi.enabled) {
        Object.entries(videoBySlot).forEach(([slot, vid]) => {
            if (vid && vid.src && vid !== nativeVideo.master) {
                vid.play().catch(err => {
                    console.warn('Failed to play', slot, ':', err.message);
                });
            }
        });
    }
}

function pauseNative() {
    nativeVideo.playing = false;
    player.playing = false;
    updatePlayButton();
    
    // Pause all videos
    if (nativeVideo.master) {
        nativeVideo.master.pause();
    }
    Object.values(videoBySlot).forEach(vid => {
        if (vid && vid.src) {
            vid.pause();
        }
    });
    
    // Stop steering wheel animation when paused
    stopSteeringAnimation();
}

// Apply playback rate to all video elements
function applyPlaybackRate(rate) {
    const playbackRate = parseFloat(rate) || 1;
    state.ui.playbackRate = playbackRate;
    
    // Apply to master video
    if (nativeVideo.master) {
        nativeVideo.master.playbackRate = playbackRate;
    }
    
    // Apply to all multi-cam videos
    Object.values(videoBySlot).forEach(vid => {
        if (vid) {
            vid.playbackRate = playbackRate;
        }
    });
    
    // Also apply to videoMain in case it's being used
    if (videoMain) {
        videoMain.playbackRate = playbackRate;
    }
    
    // Update CSS variable for map marker transitions (faster at higher speeds)
    const transitionDuration = Math.max(0.03, 0.15 / playbackRate);
    document.documentElement.style.setProperty('--map-transition-duration', `${transitionDuration}s`);
    
    console.log('Playback rate set to:', playbackRate);
}

// Extract SEI telemetry from an entry (handles both File objects and Electron paths)
async function extractSeiFromEntry(entry) {
    if (!entry) return { seiData: [], mapPath: [] };
    
    // If it's an Electron file with path, fetch via file:// protocol
    if (entry.file?.isElectronFile && entry.file?.path) {
        try {
            const filePath = entry.file.path;
            const fileUrl = filePath.startsWith('/') 
                ? `file://${filePath}` 
                : `file:///${filePath.replace(/\\/g, '/')}`;
            const response = await fetch(fileUrl);
            const buffer = await response.arrayBuffer();
            return extractSeiFromBuffer(buffer);
        } catch (err) {
            console.warn('Failed to extract SEI from Electron file:', err);
            return { seiData: [], mapPath: [] };
        }
    }
    
    // Regular File object
    if (entry.file && entry.file instanceof File) {
        return extractSeiFromFile(entry.file);
    }
    
    return { seiData: [], mapPath: [] };
}

// Extract SEI from ArrayBuffer
function extractSeiFromBuffer(buffer) {
    const seiData = [];
    const mapPath = [];
    
    try {
        const mp4 = new DashcamMP4(buffer);
        const frames = mp4.parseFrames(seiType);
        
        for (const frame of frames) {
            if (frame.sei) {
                seiData.push({ timestampMs: frame.timestamp, sei: frame.sei });
                if (hasValidGps(frame.sei)) {
                    const lat = frame.sei.latitudeDeg ?? frame.sei.latitude_deg;
                    const lon = frame.sei.longitudeDeg ?? frame.sei.longitude_deg;
                    mapPath.push([lat, lon]);
                }
            }
        }
    } catch (err) {
        console.warn('Failed to extract SEI:', err);
    }
    
    return { seiData, mapPath };
}

// Extract SEI telemetry from a video file (runs once per segment load)
async function extractSeiFromFile(file) {
    const seiData = [];
    const mapPath = [];
    
    try {
        const buffer = await file.arrayBuffer();
        const mp4 = new DashcamMP4(buffer);
        const frames = mp4.parseFrames(seiType);
        
        for (const frame of frames) {
            if (frame.sei) {
                seiData.push({ timestampMs: frame.timestamp, sei: frame.sei });
                if (hasValidGps(frame.sei)) {
                    const lat = frame.sei.latitudeDeg ?? frame.sei.latitude_deg;
                    const lon = frame.sei.longitudeDeg ?? frame.sei.longitude_deg;
                    mapPath.push([lat, lon]);
                }
            }
        }
    } catch (err) {
        console.warn('Failed to extract SEI:', err);
    }
    
    return { seiData, mapPath };
}

// Find SEI data for a given timestamp (find closest match)
function findSeiAtTime(timestampMs) {
    const data = nativeVideo.seiData;
    if (!data || !data.length) return null;
    
    // Find closest SEI frame to the target time
    let closest = data[0];
    let minDiff = Math.abs(data[0].timestampMs - timestampMs);
    
    for (let i = 1; i < data.length; i++) {
        const diff = Math.abs(data[i].timestampMs - timestampMs);
        if (diff < minDiff) {
            minDiff = diff;
            closest = data[i];
        }
        // Since data is sorted, if diff starts increasing, we passed the closest
        if (data[i].timestampMs > timestampMs && diff > minDiff) break;
    }
    
    return closest?.sei || null;
}

function seekNative(pct) {
    const vid = nativeVideo.master || videoMain;
    if (!vid || !vid.duration) return;
    
    const targetTime = (pct / 100) * vid.duration;
    vid.currentTime = targetTime;
    
    // Sync others
    syncMultiVideos(targetTime);
}

// Seek to a position (in seconds) within the entire day collection using actual durations
async function seekNativeDayCollectionBySec(targetSec) {
    if (!state.collection.active) return;
    
    const cumStarts = nativeVideo.cumulativeStarts;
    if (!cumStarts.length) return;
    
    const totalSec = cumStarts[cumStarts.length - 1];
    const clampedSec = Math.max(0, Math.min(totalSec, targetSec));
    
    // Find which segment contains this time using cumulative starts
    let segIdx = 0;
    for (let i = 0; i < cumStarts.length - 1; i++) {
        if (clampedSec >= cumStarts[i] && clampedSec < cumStarts[i + 1]) {
            segIdx = i;
            break;
        }
        if (i === cumStarts.length - 2) segIdx = i; // Last segment
    }
    
    const localSec = clampedSec - (cumStarts[segIdx] || 0);
    
    // Load segment if different
    const wasPlaying = nativeVideo.playing;
    if (segIdx !== nativeVideo.currentSegmentIdx) {
        await loadNativeSegment(segIdx);
    }
    
    // Seek within segment
    const vid = nativeVideo.master;
    if (vid) {
        vid.currentTime = Math.min(localSec, vid.duration || 60);
        syncMultiVideos(vid.currentTime);
        
        // Resume playback if it was playing before seek
        if (wasPlaying) {
            playNative();
        }
    }
}

// ============================================================
// Export Functions
// ============================================================

function setExportMarker(type) {
    if (!state.collection.active) {
        notify('Load a collection first to set export markers', { type: 'warn' });
        return;
    }
    
    // Get current position as percentage
    const currentPct = parseFloat(progressBar.value) || 0;
    
    if (type === 'start') {
        exportState.startMarkerPct = currentPct;
        // If end marker is before start, clear it
        if (exportState.endMarkerPct !== null && exportState.endMarkerPct <= currentPct) {
            exportState.endMarkerPct = null;
        }
        notify('Start marker set', { type: 'success' });
    } else {
        exportState.endMarkerPct = currentPct;
        // If start marker is after end, clear it
        if (exportState.startMarkerPct !== null && exportState.startMarkerPct >= currentPct) {
            exportState.startMarkerPct = null;
        }
        notify('End marker set', { type: 'success' });
    }
    
    updateExportMarkers();
    updateExportButtonState();
}

function updateExportMarkers() {
    const markersContainer = $('timelineMarkers');
    if (!markersContainer) return;
    
    // Get or create start marker
    let startMarker = markersContainer.querySelector('.export-marker.start');
    if (exportState.startMarkerPct !== null) {
        if (!startMarker) {
            startMarker = document.createElement('div');
            startMarker.className = 'export-marker start';
            startMarker.title = 'Export start point (drag to adjust)';
            makeMarkerDraggable(startMarker, 'start');
            markersContainer.appendChild(startMarker);
        }
        startMarker.style.left = `${exportState.startMarkerPct}%`;
    } else if (startMarker) {
        startMarker.remove();
    }
    
    // Get or create end marker
    let endMarker = markersContainer.querySelector('.export-marker.end');
    if (exportState.endMarkerPct !== null) {
        if (!endMarker) {
            endMarker = document.createElement('div');
            endMarker.className = 'export-marker end';
            endMarker.title = 'Export end point (drag to adjust)';
            makeMarkerDraggable(endMarker, 'end');
            markersContainer.appendChild(endMarker);
        }
        endMarker.style.left = `${exportState.endMarkerPct}%`;
    } else if (endMarker) {
        endMarker.remove();
    }
    
    // Get or create highlight between markers
    let highlight = markersContainer.querySelector('.export-range-highlight');
    if (exportState.startMarkerPct !== null && exportState.endMarkerPct !== null) {
        if (!highlight) {
            highlight = document.createElement('div');
            highlight.className = 'export-range-highlight';
            markersContainer.appendChild(highlight);
        }
        const startPct = Math.min(exportState.startMarkerPct, exportState.endMarkerPct);
        const endPct = Math.max(exportState.startMarkerPct, exportState.endMarkerPct);
        highlight.style.left = `${startPct}%`;
        highlight.style.width = `${endPct - startPct}%`;
    } else if (highlight) {
        highlight.remove();
    }
}

function makeMarkerDraggable(marker, type) {
    let isDragging = false;
    
    marker.addEventListener('mousedown', (e) => {
        isDragging = true;
        marker.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
        
        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const timelineContainer = marker.closest('.timeline-container');
            if (!timelineContainer) return;
            
            const rect = timelineContainer.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((moveEvent.clientX - rect.left) / rect.width) * 100));
            
            if (type === 'start') {
                exportState.startMarkerPct = pct;
            } else {
                exportState.endMarkerPct = pct;
            }
            
            updateExportMarkers();
        };
        
        const onMouseUp = () => {
            isDragging = false;
            marker.style.cursor = 'ew-resize';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            updateExportButtonState();
        };
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function updateExportButtonState() {
    const setStartMarkerBtn = $('setStartMarkerBtn');
    const setEndMarkerBtn = $('setEndMarkerBtn');
    const exportBtn = $('exportBtn');
    
    const hasCollection = !!state.collection.active;
    
    if (setStartMarkerBtn) setStartMarkerBtn.disabled = !hasCollection;
    if (setEndMarkerBtn) setEndMarkerBtn.disabled = !hasCollection;
    if (exportBtn) {
        // Enable export if we have a collection (markers are optional - defaults to full export)
        exportBtn.disabled = !hasCollection;
    }
}

function openExportModal() {
    if (!state.collection.active) {
        notify('Load a collection first', { type: 'warn' });
        return;
    }
    
    const modal = $('exportModal');
    if (!modal) return;
    
    // Update export range display
    updateExportRangeDisplay();
    
    // Check FFmpeg availability
    checkFFmpegAvailability();
    
    // Reset progress
    const progressEl = $('exportProgress');
    const progressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');
    if (progressEl) progressEl.classList.add('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = 'Preparing...';
    
    // Set default filename
    const filenameInput = $('exportFilename');
    if (filenameInput) {
        const date = new Date().toISOString().slice(0, 10);
        const collName = state.collection.active?.label || 'export';
        const safeName = collName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
        filenameInput.value = `tesla_${safeName}_${date}`;
    }
    
    // Reset quality to high
    const highQuality = document.querySelector('input[name="exportQuality"][value="high"]');
    if (highQuality) highQuality.checked = true;
    
    // Set up quality and camera change listeners for size estimate
    const qualityInputs = document.querySelectorAll('input[name="exportQuality"]');
    qualityInputs.forEach(input => {
        input.onchange = updateExportSizeEstimate;
    });
    const cameraInputs = document.querySelectorAll('.camera-checkbox input');
    cameraInputs.forEach(input => {
        input.onchange = updateExportSizeEstimate;
    });
    updateExportSizeEstimate();
    
    // Enable start button
    const startBtn = $('startExportBtn');
    if (startBtn) startBtn.disabled = false;
    
    modal.classList.remove('hidden');
}

function closeExportModalFn() {
    const modal = $('exportModal');
    if (modal) modal.classList.add('hidden');
    
    // Cancel ongoing export if any
    if (exportState.isExporting && exportState.currentExportId) {
        cancelExport();
    }
}

function updateExportRangeDisplay() {
    const startTimeEl = $('exportStartTime');
    const endTimeEl = $('exportEndTime');
    const durationEl = $('exportDuration');
    
    if (!state.collection.active) return;
    
    const totalSec = nativeVideo.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    
    // Use markers or default to full range
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    
    const startSec = (startPct / 100) * totalSec;
    const endSec = (endPct / 100) * totalSec;
    const durationSec = Math.abs(endSec - startSec);
    
    if (startTimeEl) startTimeEl.textContent = formatTimeHMS(Math.min(startSec, endSec));
    if (endTimeEl) endTimeEl.textContent = formatTimeHMS(Math.max(startSec, endSec));
    if (durationEl) durationEl.textContent = formatTimeHMS(durationSec);
}

function updateExportSizeEstimate() {
    const estimateEl = $('exportSizeEstimate');
    if (!estimateEl || !state.collection.active) return;
    
    // Get duration
    const totalSec = nativeVideo.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    const durationMin = Math.abs((endPct - startPct) / 100 * totalSec) / 60;
    
    // Get selected cameras
    const cameraCount = document.querySelectorAll('.camera-checkbox input:checked').length || 6;
    
    // Calculate grid layout (same logic as main.js)
    let cols, rows;
    if (cameraCount <= 1) { cols = 1; rows = 1; }
    else if (cameraCount === 2) { cols = 2; rows = 1; }
    else if (cameraCount === 3) { cols = 3; rows = 1; }
    else if (cameraCount === 4) { cols = 2; rows = 2; }
    else { cols = 3; rows = 2; }
    
    // Get quality settings (per-camera resolution)
    const quality = document.querySelector('input[name="exportQuality"]:checked')?.value || 'high';
    const perCam = { mobile: [640, 360], medium: [960, 540], high: [1280, 720], max: [1280, 960] }[quality] || [1280, 720];
    
    // Calculate final grid resolution
    const gridW = perCam[0] * cols;
    const gridH = perCam[1] * rows;
    
    // Estimate MB/min based on resolution (roughly 0.015 MB per 1000 pixels per minute at CRF 23)
    const pixels = gridW * gridH;
    const mbPerMin = pixels * 0.000018; // Empirical factor for H.264
    
    const estimatedMB = Math.round(durationMin * mbPerMin);
    const estimatedGB = (estimatedMB / 1024).toFixed(1);
    
    let sizeText;
    if (estimatedMB > 1024) {
        sizeText = `~${estimatedGB} GB`;
    } else {
        sizeText = `~${estimatedMB} MB`;
    }
    
    estimateEl.textContent = `Output: ${gridW}×${gridH} • ${sizeText}`;
}

async function checkFFmpegAvailability() {
    const statusEl = $('ffmpegStatus');
    const startBtn = $('startExportBtn');
    
    if (!statusEl) return;
    
    statusEl.innerHTML = '<span class="status-icon">⏳</span><span class="status-text">Checking FFmpeg...</span>';
    
    try {
        if (window.electronAPI?.checkFFmpeg) {
            const result = await window.electronAPI.checkFFmpeg();
            exportState.ffmpegAvailable = result.available;
            
            if (result.available) {
                statusEl.innerHTML = '<span class="status-icon" style="color: #4caf50;">✓</span><span class="status-text">FFmpeg available</span>';
                if (startBtn) startBtn.disabled = false;
            } else {
                statusEl.innerHTML = '<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">FFmpeg not found. Please install FFmpeg or place it in ffmpeg_bin folder.</span>';
                if (startBtn) startBtn.disabled = true;
            }
        } else {
            statusEl.innerHTML = '<span class="status-icon" style="color: #ff9800;">⚠</span><span class="status-text">Export not available (running in browser)</span>';
            if (startBtn) startBtn.disabled = true;
        }
    } catch (err) {
        statusEl.innerHTML = '<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">Error checking FFmpeg</span>';
        if (startBtn) startBtn.disabled = true;
    }
}

async function startExport() {
    if (!state.collection.active || !window.electronAPI?.startExport) {
        notify('Export not available', { type: 'error' });
        return;
    }
    
    // Check if we have a base folder path (required for FFmpeg)
    if (!baseFolderPath) {
        notify('Export requires selecting a folder via the folder picker. Please re-select your TeslaCam folder.', { type: 'warn' });
        return;
    }
    
    // Get selected cameras
    const cameraCheckboxes = document.querySelectorAll('.camera-checkbox input[type="checkbox"]:checked');
    const cameras = Array.from(cameraCheckboxes).map(cb => cb.dataset.camera);
    
    if (cameras.length === 0) {
        notify('Please select at least one camera', { type: 'warn' });
        return;
    }
    
    // Get filename from input
    const filenameInput = $('exportFilename');
    let filename = filenameInput?.value?.trim() || `tesla_export_${new Date().toISOString().slice(0, 10)}`;
    // Ensure .mp4 extension
    if (!filename.toLowerCase().endsWith('.mp4')) filename += '.mp4';
    
    // Get quality option
    const qualityInput = document.querySelector('input[name="exportQuality"]:checked');
    const quality = qualityInput?.value || 'high';
    
    // Get save location
    const outputPath = await window.electronAPI.saveFile({
        title: 'Save Tesla Export',
        defaultPath: filename
    });
    
    if (!outputPath) {
        notify('Export cancelled', { type: 'info' });
        return;
    }
    
    // Calculate export range in milliseconds
    const totalSec = nativeVideo.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    
    const startTimeMs = (Math.min(startPct, endPct) / 100) * totalSec * 1000;
    const endTimeMs = (Math.max(startPct, endPct) / 100) * totalSec * 1000;
    
    // Build segments data with file paths
    const segments = [];
    const groups = state.collection.active.groups || [];
    const cumStarts = nativeVideo.cumulativeStarts || [];
    
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const durationSec = nativeVideo.segmentDurations?.[i] || 60;
        
        // Get file paths for each camera
        const files = {};
        for (const camera of cameras) {
            const entry = group.filesByCamera?.get(camera);
            if (entry?.file) {
                // Use direct path if available (Electron), otherwise construct from relative path
                if (entry.file.path) {
                    // Electron file object has direct path
                    files[camera] = entry.file.path;
                } else if (entry.file.webkitRelativePath && baseFolderPath) {
                    // Browser File API - construct from relative path
                    const relativePath = entry.file.webkitRelativePath;
                    const pathParts = relativePath.split('/');
                    const subPath = pathParts.slice(1).join('/');
                    const fullPath = baseFolderPath + '/' + subPath;
                    files[camera] = fullPath;
                }
            }
        }
        
        segments.push({
            index: i,
            durationSec,
            startSec: cumStarts[i] || 0,
            files,
            groupId: group.id
        });
    }
    
    // Verify we have valid file paths
    const hasFiles = segments.some(seg => Object.keys(seg.files).length > 0);
    if (!hasFiles) {
        notify('No video files found for export. Please ensure the folder was selected correctly.', { type: 'error' });
        return;
    }
    
    // Show progress
    const progressEl = $('exportProgress');
    const exportProgressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');
    const startBtn = $('startExportBtn');
    
    if (progressEl) progressEl.classList.remove('hidden');
    if (exportProgressBar) exportProgressBar.style.width = '0%';
    if (progressText) progressText.textContent = 'Starting export...';
    if (startBtn) startBtn.disabled = true;
    
    // Generate export ID
    const exportId = `export_${Date.now()}`;
    exportState.currentExportId = exportId;
    exportState.isExporting = true;
    
    // Set up progress listener
    if (window.electronAPI?.on) {
        window.electronAPI.on('export:progress', (receivedExportId, progress) => {
            if (receivedExportId !== exportId) return;
            
            if (progress.type === 'progress') {
                if (exportProgressBar) exportProgressBar.style.width = `${progress.percentage}%`;
                if (progressText) progressText.textContent = progress.message;
            } else if (progress.type === 'complete') {
                exportState.isExporting = false;
                exportState.currentExportId = null;
                
                if (progress.success) {
                    if (exportProgressBar) exportProgressBar.style.width = '100%';
                    if (progressText) progressText.textContent = progress.message;
                    notify(progress.message, { type: 'success' });
                    
                    // Offer to show file location
                    setTimeout(() => {
                        if (confirm(`${progress.message}\n\nWould you like to open the file location?`)) {
                            window.electronAPI.showItemInFolder(outputPath);
                        }
                        closeExportModalFn();
                    }, 500);
                } else {
                    if (progressText) progressText.textContent = progress.message;
                    notify(progress.message, { type: 'error' });
                    if (startBtn) startBtn.disabled = false;
                }
            }
        });
    }
    
    // Start export
    try {
        const exportData = {
            segments,
            startTimeMs,
            endTimeMs,
            outputPath,
            cameras,
            baseFolderPath,
            quality
        };
        
        console.log('Starting export with data:', exportData);
        await window.electronAPI.startExport(exportId, exportData);
    } catch (err) {
        console.error('Export error:', err);
        notify(`Export failed: ${err.message}`, { type: 'error' });
        exportState.isExporting = false;
        exportState.currentExportId = null;
        if (startBtn) startBtn.disabled = false;
    }
}

async function cancelExport() {
    if (exportState.currentExportId && window.electronAPI?.cancelExport) {
        await window.electronAPI.cancelExport(exportState.currentExportId);
        notify('Export cancelled', { type: 'info' });
    }
    
    exportState.isExporting = false;
    exportState.currentExportId = null;
    
    const progressEl = $('exportProgress');
    const startBtn = $('startExportBtn');
    
    if (progressEl) progressEl.classList.add('hidden');
    if (startBtn) startBtn.disabled = false;
    
    // Close the modal
    closeExportModalFn();
}

// Update export button state when collection changes
const originalSelectDayCollection = selectDayCollection;
window.selectDayCollectionWrapper = function(dayKey) {
    originalSelectDayCollection.call(this, dayKey);
    // Update export button state after collection loads
    setTimeout(updateExportButtonState, 100);
};

// Call updateExportButtonState initially
setTimeout(updateExportButtonState, 500);


