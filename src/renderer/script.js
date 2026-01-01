import { MULTI_LAYOUTS, DEFAULT_MULTI_LAYOUT } from './scripts/lib/multiLayouts.js';
import { CLIPS_MODE_KEY, MULTI_LAYOUT_KEY, MULTI_ENABLED_KEY, SENTRY_CAMERA_HIGHLIGHT_KEY, SAVED_CAMERA_HIGHLIGHT_KEY } from './scripts/lib/storageKeys.js';
import { createClipsPanelMode } from './scripts/ui/panelMode.js';
import { escapeHtml, cssEscape } from './scripts/lib/utils.js';
import { state } from './scripts/lib/state.js';
import { notify } from './scripts/ui/notifications.js';
import { showLoading, updateLoading, hideLoading, yieldToUI } from './scripts/ui/loadingOverlay.js';
import { updateGForceMeter, resetGForceMeter } from './scripts/ui/gforceMeter.js';
import { updateCompass, resetCompass } from './scripts/ui/compass.js';
import { initKeybindActions, initKeybindSettings, initGlobalKeybindListener } from './scripts/lib/keybinds.js';
import { initSteeringWheel, smoothSteeringTo, stopSteeringAnimation, resetSteeringWheel } from './scripts/ui/steeringWheel.js';
import { formatTimeHMS, updateTimeDisplayNew, updateRecordingTime } from './scripts/ui/timeDisplay.js';
import { 
    exportState, initExportModule, setExportMarker, updateExportMarkers, 
    updateExportButtonState, openExportModal, closeExportModal, reopenExportModal,
    updateExportRangeDisplay, updateExportSizeEstimate, checkFFmpegAvailability,
    startExport, cancelExport, clearExportMarkers 
} from './scripts/features/exportVideo.js';
import { initLayoutLab } from './scripts/ui/layoutLab.js';
import { initAutoUpdate, showUpdateModal, hideUpdateModal, handleInstallUpdate } from './scripts/features/autoUpdate.js';
import { zoomPanState, initZoomPan, resetZoomPan, applyZoomPan, applyMirrorTransforms } from './scripts/ui/zoomPan.js';
import { initSettingsModalDeps, initSettingsModal, initDevSettingsModal, openDevSettings, initChangelogModal } from './scripts/ui/settingsModal.js';
import { initWelcomeGuide, checkAndShowWelcomeGuide, resetWelcomeGuide, openWelcomeGuide } from './scripts/ui/welcomeGuide.js';
import { initDiagnostics, logDiagnosticEvent } from './scripts/ui/diagnostics.js';
import { 
    initCameraRearrange, initCustomCameraOrder, getCustomCameraOrder, setCustomCameraOrder,
    resetCameraOrder, getEffectiveSlots, initCameraDragAndDrop, updateTileLabels, saveCustomCameraOrder
} from './scripts/features/cameraRearrange.js';
import { initDraggablePanels } from './scripts/ui/draggablePanels.js';
import { initEventMarkers, updateEventTimelineMarker, updateEventCameraHighlight } from './scripts/ui/eventMarkers.js';
import { initSkipSeconds, skipSeconds } from './scripts/features/skipSeconds.js';
import { initMapVisualization, updateMapVisibility, updateMapMarker, clearMapMarker } from './scripts/ui/mapVisualization.js';
import { initDashboardVisibility, updateDashboardVisibility } from './scripts/ui/dashboardVisibility.js';
import { initMultiCamFocus, clearMultiFocus, toggleMultiFocus, scheduleResync, forceResyncAllVideos, syncMultiVideos } from './scripts/ui/multiCamFocus.js';
import { formatEventTime, getTypeLabel, populateEventPopout } from './scripts/ui/clipListHelpers.js';
import { 
    initClipBrowser, renderClipList, createClipItem, highlightSelectedClip, 
    closeEventPopout, toggleEventPopout, buildDisplayItems, parseTimestampKeyToEpochMs,
    formatCameraName, timestampLabel, setupPopoutCloseHandler
} from './scripts/core/clipBrowser.js';

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

// Export state moved to scripts/features/exportVideo.js

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
// currentTimeEl and totalTimeEl moved to scripts/ui/timeDisplay.js
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

// Custom camera order moved to scripts/features/cameraRearrange.js

// Visualization Elements
const speedValue = $('speedValue');
const gearState = $('gearState');
const blinkLeft = $('blinkLeft');
const blinkRight = $('blinkRight');

// Steering wheel animation moved to scripts/ui/steeringWheel.js
// Initialize with playback rate getter
initSteeringWheel(() => state.ui.playbackRate || 1);

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
    resetSteeringWheel();
    
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
    resetGForceMeter();
    
    // Reset compass
    resetCompass();
    
    // Reset map
    clearMapMarker();
    if (mapPolyline) {
        mapPolyline.remove();
        mapPolyline = null;
    }
    mapPath = [];
    
    // Clear event location marker (Sentry/Saved clip static pin)
    if (eventLocationMarker) {
        eventLocationMarker.remove();
        eventLocationMarker = null;
    }
    
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
    resetSteeringWheel();
    
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
    resetGForceMeter();
    
    // Reset compass
    resetCompass();
    
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
    
    // Clear any existing event location marker before adding new one
    if (eventLocationMarker) {
        eventLocationMarker.remove();
        eventLocationMarker = null;
    }
    
    // Create marker and add popup with location info
    const latlng = L.latLng(lat, lon);
    // Note: This is a static event location marker, separate from the moving GPS marker
    eventLocationMarker = L.marker(latlng, { icon: eventIcon }).addTo(map);
    
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
// mapMarker moved to scripts/ui/mapVisualization.js
let mapPolyline = null;
let eventLocationMarker = null; // Static marker for Sentry/Saved clip event locations
let mapPath = [];

// Extra Data Elements
const valLat = $('valLat');
const valLon = $('valLon');
const valHeading = $('valHeading');
const valSeq = $('valSeq');

// G-Force Meter Elements moved to scripts/ui/gforceMeter.js

// Compass Elements moved to scripts/ui/compass.js


// Constants
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;
let useMetric = false; // Will be loaded from settings

// notify() moved to scripts/ui/notifications.js
// Loading overlay helpers moved to scripts/ui/loadingOverlay.js

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

    // Panel layout mode (floating/collapsed or docked/hidden based on layout style)
    const panelMode = createClipsPanelMode({ map, clipsCollapseBtn });
    panelMode.initClipsPanelMode();
    clipsCollapseBtn.onclick = (e) => { e.preventDefault(); panelMode.toggleCollapsedMode(); };
    
    // Store panelMode functions globally for settings modal access
    window._panelMode = panelMode;

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
        if (window.electronAPI?.setSetting) {
            window.electronAPI.setSetting('dashboardEnabled', state.ui.dashboardEnabled);
        }
        updateDashboardVisibility();
    };

    // Map toggle
    mapToggle.onchange = () => {
        state.ui.mapEnabled = !!mapToggle.checked;
        if (window.electronAPI?.setSetting) {
            window.electronAPI.setSetting('mapEnabled', state.ui.mapEnabled);
        }
        updateMapVisibility();
    };

    // Metric toggle (hidden, controlled via settings modal)
    const metricToggle = $('metricToggle');
    if (metricToggle) {
        metricToggle.checked = useMetric;
        metricToggle.onchange = () => {
            useMetric = metricToggle.checked;
            if (window.electronAPI?.setSetting) {
                window.electronAPI.setSetting('useMetric', useMetric);
            }
            // Update speed unit display
            const unitEl = $('speedUnit');
            if (unitEl) unitEl.textContent = useMetric ? 'KM/H' : 'MPH';
        };
    }

    // Initialize Settings Modal
    initSettingsModal();

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

    // Initialize dashboard/map/metric toggles from file-based settings (default ON)
    if (window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('dashboardEnabled').then(saved => {
            state.ui.dashboardEnabled = saved === undefined ? true : saved === true;
            if (dashboardToggle) dashboardToggle.checked = state.ui.dashboardEnabled;
            updateDashboardVisibility();
        });
        window.electronAPI.getSetting('mapEnabled').then(saved => {
            state.ui.mapEnabled = saved === undefined ? true : saved === true;
            if (mapToggle) mapToggle.checked = state.ui.mapEnabled;
            updateMapVisibility();
        });
        window.electronAPI.getSetting('useMetric').then(saved => {
            useMetric = saved === true;
            const metricToggle = $('metricToggle');
            if (metricToggle) metricToggle.checked = useMetric;
            const unitEl = $('speedUnit');
            if (unitEl) unitEl.textContent = useMetric ? 'KM/H' : 'MPH';
        });
    } else {
        // Fallback to defaults
        state.ui.dashboardEnabled = true;
        state.ui.mapEnabled = true;
        if (dashboardToggle) dashboardToggle.checked = state.ui.dashboardEnabled;
        if (mapToggle) mapToggle.checked = state.ui.mapEnabled;
    }

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
        closeExportModal.onclick = (e) => { 
            e.preventDefault(); 
            // During export, this will minimize the modal and show floating progress
            closeExportModalFn(); 
        };
    }
    if (cancelExportBtn) {
        cancelExportBtn.onclick = (e) => { e.preventDefault(); cancelExport(); };
    }
    if (startExportBtn) {
        startExportBtn.onclick = (e) => { e.preventDefault(); startExport(); };
    }
    // Close modal on backdrop click (minimize during export, close otherwise)
    if (exportModal) {
        exportModal.onclick = (e) => {
            if (e.target === exportModal) {
                closeExportModalFn();
            }
        };
    }
    
    // Floating export progress - reopen modal button
    const exportFloatingOpenBtn = $('exportFloatingOpenBtn');
    if (exportFloatingOpenBtn) {
        exportFloatingOpenBtn.onclick = (e) => { e.preventDefault(); reopenExportModal(); };
    }
    


    // Initialize native video playback system
    initNativeVideoPlayback();

    // Multi focus mode (click a tile - works for both standard and immersive layouts)
    // Debounced to prevent rapid clicking issues
    let lastFocusToggle = 0;
    if (multiCamGrid) {
        multiCamGrid.addEventListener('click', (e) => {
            // Don't toggle focus if we just finished panning
            if (zoomPanState.wasPanning) return;
            
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

    // Initialize custom camera order from localStorage
    initCustomCameraOrder();
    
    // Initialize drag-and-drop for camera rearrangement
    initCameraDragAndDrop();
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

// Zoom/Pan moved to scripts/ui/zoomPan.js
// Initialize zoom/pan module
initZoomPan({
    getMultiCamGrid: () => multiCamGrid,
    getState: () => state
});

// Multi-camera focus moved to scripts/ui/multiCamFocus.js
initMultiCamFocus({
    getMultiCamGrid: () => multiCamGrid,
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getVideoBySlot: () => videoBySlot
});

// Dashboard visibility moved to scripts/ui/dashboardVisibility.js
initDashboardVisibility({
    getDashboardVis: () => dashboardVis,
    getState: () => state
});

// Map visibility moved to scripts/ui/mapVisualization.js
initMapVisualization({
    getMap: () => map,
    getMapVis: () => mapVis,
    getMapPolyline: () => mapPolyline,
    getState: () => state
});

// Clips panel mode logic moved to src/panelMode.js

// Draggable panels moved to scripts/ui/draggablePanels.js
initDraggablePanels([dashboardVis, mapVis]);

// Clip browser moved to scripts/core/clipBrowser.js
initClipBrowser({
    getState: () => state,
    getLibrary: () => library,
    getSelection: () => selection,
    clipList,
    dayFilter,
    selectDayCollection,
    formatEventReason
});
setupPopoutCloseHandler();

// Settings Modal moved to scripts/ui/settingsModal.js
// Initialize settings modal with dependencies
initSettingsModalDeps({
    getState: () => state,
    getUseMetric: () => useMetric,
    updateEventCameraHighlight,
    resetCameraOrder,
    openDevSettingsModal: openDevSettings,
    setLayoutStyle: (style) => window._panelMode?.setLayoutStyle?.(style),
    getLayoutStyle: () => window._panelMode?.getLayoutStyle?.() || 'modern'
});
initSettingsModal();
initDevSettingsModal();
initChangelogModal();

// Initialize diagnostics system (captures console logs for Support ID)
initDiagnostics();
logDiagnosticEvent('app_initialized');

// Initialize Welcome Guide for first-time users
initWelcomeGuide();

// Expose welcome guide functions for developer settings
window._resetWelcomeGuide = resetWelcomeGuide;
window._openWelcomeGuide = openWelcomeGuide;

// Keybind System - moved to scripts/lib/keybinds.js
// Initialize keybind actions (handlers stay here since they use local functions)
initKeybindActions({
    playPause: () => {
        const playBtn = $('playBtn');
        if (playBtn && !playBtn.disabled) playBtn.click();
    },
    skipForward: () => {
        skipSeconds(15);
    },
    skipBackward: () => {
        skipSeconds(-15);
    },
    toggleDash: () => {
        const dashboardToggle = $('dashboardToggle');
        if (dashboardToggle) {
            dashboardToggle.checked = !dashboardToggle.checked;
            dashboardToggle.dispatchEvent(new Event('change'));
            const settingsDashboardToggle = $('settingsDashboardToggle');
            if (settingsDashboardToggle) settingsDashboardToggle.checked = dashboardToggle.checked;
        }
    },
    toggleMap: () => {
        const mapToggle = $('mapToggle');
        if (mapToggle) {
            mapToggle.checked = !mapToggle.checked;
            mapToggle.dispatchEvent(new Event('change'));
            const settingsMapToggle = $('settingsMapToggle');
            if (settingsMapToggle) settingsMapToggle.checked = mapToggle.checked;
        }
    },
    toggleMetric: () => {
        const metricToggle = $('metricToggle');
        if (metricToggle) {
            metricToggle.checked = !metricToggle.checked;
            metricToggle.dispatchEvent(new Event('change'));
            const settingsMetricToggle = $('settingsMetricToggle');
            if (settingsMetricToggle) settingsMetricToggle.checked = metricToggle.checked;
        }
    },
    toggleClips: () => {
        const clipsCollapseBtn = $('clipsCollapseBtn');
        if (clipsCollapseBtn) clipsCollapseBtn.click();
    }
});

// Initialize global keybind listener
initGlobalKeybindListener();

// Auto-load default folder on startup
async function loadDefaultFolderOnStartup() {
    let savedFolder = null;
    if (window.electronAPI?.getSetting) {
        savedFolder = await window.electronAPI.getSetting('defaultFolder');
    }
    if (savedFolder && window.electronAPI?.readDir) {
        try {
            console.log('Auto-loading default TeslaCam folder:', savedFolder);
            baseFolderPath = savedFolder;
            showLoading('Loading default folder...', 'Looking for TeslaCam clips');
            await traverseDirectoryElectron(savedFolder);
        } catch (err) {
            hideLoading();
            console.error('Failed to load default folder:', err);
            // Don't show error - folder might have been moved/deleted
        }
    }
}

// Call after a short delay to allow UI to initialize
setTimeout(loadDefaultFolderOnStartup, 500);

// Check for updates on startup (if not disabled in settings)
async function checkForUpdatesOnStartup() {
    let autoUpdateDisabled = false;
    
    // Load from file-based settings
    if (window.electronAPI?.getSetting) {
        const savedValue = await window.electronAPI.getSetting('disableAutoUpdate');
        autoUpdateDisabled = savedValue === true;
    }
    
    if (!autoUpdateDisabled && window.electronAPI?.checkForUpdates) {
        window.electronAPI.checkForUpdates();
    }
}

// Delay update check to allow app to fully initialize
setTimeout(checkForUpdatesOnStartup, 2000);

// Show welcome guide for first-time users (after app fully initializes)
setTimeout(checkAndShowWelcomeGuide, 1000);

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

// Clip browser functions moved to scripts/core/clipBrowser.js

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

}

function selectSentryCollection(collectionId) {
    console.log('%c[SELECT] selectSentryCollection called with:', 'color: orange; font-weight: bold', collectionId);
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
        console.log('%c[SELECT] selectDayCollection called with:', 'color: lime; font-weight: bold', dayKey);
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

    // Initialize segment duration tracking with estimates, then probe actual durations
    const numSegs = coll.groups?.length || 0;
    const groups = coll.groups || [];
    
    // Start with 60s estimates for immediate UI responsiveness
    nativeVideo.segmentDurations = new Array(numSegs).fill(60);
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

    // Update event timeline marker and camera highlight
    updateEventTimelineMarker();
    updateEventCameraHighlight();

    // Calculate anchorMs from event metadata for Sentry/Saved clips
    let anchorMs = 0;
    let eventMeta = null;
    for (const g of groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    // Also check eventMetaByKey if not found in groups
    if (!eventMeta && coll.tag && coll.eventId) {
        const key = `${coll.tag}/${coll.eventId}`;
        eventMeta = eventMetaByKey.get(key);
    }
    if (eventMeta?.timestamp) {
        const eventEpoch = Date.parse(eventMeta.timestamp);
        const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
        if (Number.isFinite(eventEpoch) && startEpochMs > 0) {
            anchorMs = Math.max(0, eventEpoch - startEpochMs);
        }
    }
    
    // Calculate start position: 15 seconds before event time, or 0 if no anchor
    const startOffsetMs = Math.max(0, anchorMs - 15000); // 15 seconds before event
    const startOffsetSec = startOffsetMs / 1000;

    // Probe actual segment durations in the background for accurate seek positioning
    // This runs concurrently with loading the first segment
    console.log('Starting duration probe for', groups.length, 'segments');
    probeSegmentDurations(groups).then(probedDurations => {
        console.log('Duration probe completed:', probedDurations);
        if (!state.collection.active || state.collection.active.id !== coll.id) return; // Stale
        
        // Update durations with actual values
        nativeVideo.segmentDurations = probedDurations;
        nativeVideo.cumulativeStarts = [];
        let cumulative = 0;
        for (let i = 0; i <= probedDurations.length; i++) {
            nativeVideo.cumulativeStarts.push(cumulative);
            if (i < probedDurations.length) cumulative += probedDurations[i];
        }
        
        // Update time display with accurate total duration
        const totalSec = nativeVideo.cumulativeStarts[probedDurations.length] || 60;
        const vid = nativeVideo.master;
        const segIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
        const cumStart = nativeVideo.cumulativeStarts[segIdx] || 0;
        const currentSec = cumStart + (vid?.currentTime || 0);
        updateTimeDisplayNew(Math.floor(currentSec), Math.floor(totalSec));
        
        // Refresh event timeline marker with accurate durations
        updateEventTimelineMarker();
        
        console.log('Timeline updated with actual durations, total:', totalSec.toFixed(1) + 's');
    }).catch(err => {
        console.warn('Duration probing failed, using estimates:', err);
    });

    // Load first segment with native video, then seek to event offset
    loadNativeSegment(0).then(() => {
        // Update time display with total duration (may be updated again when probing completes)
        const totalSec = nativeVideo.cumulativeStarts[numSegs] || 60;
        updateTimeDisplayNew(0, totalSec);
        
        playBtn.disabled = false;
        progressBar.disabled = false;
        
        // Seek to 15 seconds before event time if we have an anchor
        if (startOffsetSec > 0) {
            seekNativeDayCollectionBySec(startOffsetSec).then(() => {
                if (autoplayToggle?.checked) {
                    setTimeout(() => playNative(), 100);
                }
            });
        } else if (autoplayToggle?.checked) {
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
                // Also refresh timeline marker and camera highlight
                updateEventTimelineMarker();
                updateEventCameraHighlight();
                
                // Seek to 15 seconds before event time now that we have the metadata
                if (meta?.timestamp) {
                    const eventEpoch = Date.parse(meta.timestamp);
                    const groups = state.collection.active.groups || [];
                    const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
                    if (Number.isFinite(eventEpoch) && startEpochMs > 0) {
                        const anchorMs = Math.max(0, eventEpoch - startEpochMs);
                        const startOffsetMs = Math.max(0, anchorMs - 15000);
                        const startOffsetSec = startOffsetMs / 1000;
                        if (startOffsetSec > 0) {
                            seekNativeDayCollectionBySec(startOffsetSec);
                        }
                    }
                }
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

// Legacy preview/thumbnail code removed - not used in current UI

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
    // If the user is still dragging or an async seek is in progress, don't restart yet.
    if (state.ui.isScrubbing || nativeVideo.isSeeking) return;
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

// G-Force Meter moved to scripts/ui/gforceMeter.js
// Compass moved to scripts/ui/compass.js

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

    // Map Update - moved to scripts/ui/mapVisualization.js
    updateMapMarker(sei, hasValidGps);
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

// Time display functions moved to scripts/ui/timeDisplay.js
// Local wrapper that uses imported functions
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
// Skip Seconds - moved to scripts/features/skipSeconds.js
// ============================================================
initSkipSeconds({
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getProgressBar: () => progressBar,
    getPlayer: () => player,
    seekNativeDayCollectionBySec,
    showCollectionAtMs,
    showFrame
});

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
    isSeeking: false,       // Guard to prevent progress bar updates during user-initiated seeks
    lastSeiTimeMs: -Infinity, // Track last timestamp where SEI data was found
    dashboardReset: false   // Track if dashboard has been reset for no-SEI section
};

/**
 * Probe video durations for all segments upfront to enable accurate seek positioning.
 * Uses temporary video elements to get actual durations without full loading.
 * @param {Array} groups - Array of clip groups with filesByCamera maps
 * @returns {Promise<number[]>} - Array of segment durations in seconds
 */
async function probeSegmentDurations(groups) {
    if (!groups || groups.length === 0) return [];
    
    console.log('Probing durations for', groups.length, 'segments...');
    const durations = [];
    
    // Helper to get video URL from entry (same as in loadNativeSegment)
    const getVideoUrl = (entry) => {
        if (!entry) return null;
        if (entry.file?.isElectronFile && entry.file?.path) {
            const filePath = entry.file.path;
            const fileUrl = filePath.startsWith('/') 
                ? `file://${filePath}` 
                : `file:///${filePath.replace(/\\/g, '/')}`;
            return { url: fileUrl, isBlob: false };
        }
        if (entry.file && entry.file instanceof File) {
            const url = URL.createObjectURL(entry.file);
            return { url, isBlob: true };
        }
        return null;
    };
    
    // Probe each segment's duration using a temporary video element
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        // Prefer front camera for duration, fall back to any available camera
        const entry = group.filesByCamera.get('front') || 
                      group.filesByCamera.values().next().value;
        const urlData = getVideoUrl(entry);
        
        if (!urlData) {
            console.warn('No video file for segment', i, '- using 60s estimate');
            durations.push(60);
            continue;
        }
        
        try {
            const duration = await new Promise((resolve, reject) => {
                const tempVid = document.createElement('video');
                tempVid.preload = 'metadata';
                tempVid.muted = true;
                
                const cleanup = () => {
                    tempVid.src = '';
                    tempVid.load();
                    if (urlData.isBlob) {
                        URL.revokeObjectURL(urlData.url);
                    }
                };
                
                const timeout = setTimeout(() => {
                    cleanup();
                    reject(new Error('Timeout'));
                }, 5000); // 5s timeout per segment
                
                tempVid.onloadedmetadata = () => {
                    clearTimeout(timeout);
                    const dur = tempVid.duration;
                    cleanup();
                    resolve(Number.isFinite(dur) ? dur : 60);
                };
                
                tempVid.onerror = () => {
                    clearTimeout(timeout);
                    cleanup();
                    reject(new Error('Load error'));
                };
                
                tempVid.src = urlData.url;
            });
            
            durations.push(duration);
        } catch (err) {
            console.warn('Failed to probe segment', i, ':', err.message, '- using 60s estimate');
            durations.push(60);
        }
    }
    
    console.log('Probed durations:', durations.map(d => d.toFixed(1) + 's').join(', '));
    return durations;
}

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
    
    // Skip progress bar updates while user is scrubbing or seeking to prevent fighting with user input
    const skipProgressUpdate = state.ui.isScrubbing || nativeVideo.isSeeking;
    
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
        updateRecordingTime({ collection: state.collection.active, segIdx, videoCurrentTime: nativeVideo.master?.currentTime || 0 });
        
        // Progress bar as smooth percentage (skip if user is scrubbing)
        if (!skipProgressUpdate) {
            const pct = (currentSec / totalSec) * 100;
            progressBar.value = Math.min(100, pct);
        }
        return;
    }
    
    // Single clip mode
    const totalSec = vid.duration || 0;
    updateTimeDisplayNew(currentVidSec, totalSec);
    if (totalSec > 0 && !skipProgressUpdate) {
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
        // Load all cameras (use custom order if set)
        const slotsArr = getEffectiveSlots();
        
        console.log('Multi-cam layout:', multi.layoutId, 'slots:', slotsArr, 'custom:', !!getCustomCameraOrder());
        
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
        
        // Update tile labels to reflect custom camera order
        updateTileLabels();
        
        // Apply mirror transforms to repeater cameras
        applyMirrorTransforms();
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
    
    // If a seek is already in progress, ignore this one to prevent race conditions
    if (nativeVideo.isSeeking) {
        console.log('Seek already in progress, ignoring new seek to', targetSec.toFixed(1) + 's');
        return;
    }
    
    // Set seeking flag to prevent progress bar updates and overlapping seeks
    nativeVideo.isSeeking = true;
    
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
    
    // Clear seeking flag after a short delay to let the video element settle
    // Then check if autoplay should start (since maybeAutoplayAfterSeek was blocked during seek)
    setTimeout(() => {
        nativeVideo.isSeeking = false;
        maybeAutoplayAfterSeek();
    }, 100);
}

// ============================================================
// Event Timeline Markers - moved to scripts/ui/eventMarkers.js
// ============================================================
initEventMarkers({
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getEventMetaByKey: () => eventMetaByKey,
    parseTimestampKeyToEpochMs,
    seekNativeDayCollectionBySec
});

// ============================================================
// Export Functions - moved to scripts/features/exportVideo.js
// ============================================================

// Initialize export module with dependencies
initExportModule({
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getBaseFolderPath: () => baseFolderPath,
    getProgressBar: () => progressBar,
    getUseMetric: () => useMetric
});

// Alias for closeExportModal (used internally)
const closeExportModalFn = closeExportModal;

// Update export button state when collection changes
const originalSelectDayCollection = selectDayCollection;
window.selectDayCollectionWrapper = function(dayKey) {
    originalSelectDayCollection.call(this, dayKey);
    setTimeout(updateExportButtonState, 100);
};

// Call updateExportButtonState initially
setTimeout(updateExportButtonState, 500);

// ============================================================
// Auto-Update System - moved to scripts/features/autoUpdate.js
// ============================================================
initAutoUpdate();

// -------------------------------------------------------------
// Camera Rearrangement - moved to scripts/features/cameraRearrange.js
// -------------------------------------------------------------
initCameraRearrange({
    getMultiCamGrid: () => multiCamGrid,
    getState: () => state,
    getMulti: () => multi,
    loadNativeSegment,
    getNativeVideo: () => nativeVideo,
    syncMultiVideos,
    playNative,
    updateEventCameraHighlight
});
