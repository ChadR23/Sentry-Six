/**
 * Map Visualization
 * Handles map marker updates and visibility
 */

// Map state
let mapMarker = null;
let currentMapArrowRotation = 0;

// Dependencies set via init
let getMap = null;
let getMapVis = null;
let getMapPolyline = null;
let getState = null;

/**
 * Initialize map visualization module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initMapVisualization(deps) {
    getMap = deps.getMap;
    getMapVis = deps.getMapVis;
    getMapPolyline = deps.getMapPolyline;
    getState = deps.getState;
}

/**
 * Update map visibility based on user toggle
 */
export function updateMapVisibility() {
    const mapVis = getMapVis?.();
    const map = getMap?.();
    const mapPolyline = getMapPolyline?.();
    const state = getState?.();
    
    if (!mapVis) return;
    mapVis.classList.toggle('user-hidden', !state?.ui?.mapEnabled);
    
    if (state?.ui?.mapEnabled && map) {
        setTimeout(() => {
            map.invalidateSize();
            if (mapPolyline) {
                map.fitBounds(mapPolyline.getBounds(), { padding: [20, 20] });
            } else if (mapMarker) {
                map.setView(mapMarker.getLatLng(), 16);
            }
        }, 150);
    }
}

/**
 * Update map marker position and heading
 * @param {Object} sei - SEI telemetry data
 * @param {Function} hasValidGps - Function to check if GPS is valid
 */
export function updateMapMarker(sei, hasValidGps) {
    const map = getMap?.();
    const state = getState?.();
    
    if (!map || !sei) return;
    
    const get = (camel, snake) => sei[camel] ?? sei[snake];
    const lat = get('latitudeDeg', 'latitude_deg') || 0;
    const lon = get('longitudeDeg', 'longitude_deg') || 0;
    const heading = get('headingDeg', 'heading_deg') || 0;
    
    if (hasValidGps(sei)) {
        const latlng = [lat, lon];
        
        if (Math.abs(lat) < 0.001 || Math.abs(lon) < 0.001) {
            if (mapMarker) {
                mapMarker.remove();
                mapMarker = null;
            }
            return;
        }
        
        const targetHeading = ((heading % 360) + 360) % 360;
        let delta = targetHeading - (currentMapArrowRotation % 360);
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        currentMapArrowRotation += delta;
        
        const transitionDuration = Math.max(0.03, 0.15 / (state?.ui?.playbackRate || 1));
        
        if (!mapMarker) {
            currentMapArrowRotation = targetHeading;
            
            const arrowIcon = L.divIcon({
                className: 'arrow-marker-icon',
                html: `<img src="../../assets/arrow.png" style="width: 116px; height: 116px; transform: rotate(${currentMapArrowRotation}deg); transform-origin: center center; transition: transform ${transitionDuration}s ease-out; display: block;" />`,
                iconSize: [116, 116],
                iconAnchor: [58, 58],
                popupAnchor: [0, -58]
            });
            
            mapMarker = L.marker(latlng, { icon: arrowIcon }).addTo(map);
        } else {
            mapMarker.setLatLng(latlng);
            
            const iconElement = mapMarker._icon;
            if (iconElement) {
                const imgElement = iconElement.querySelector('img');
                if (imgElement) {
                    imgElement.style.transition = `transform ${transitionDuration}s ease-out`;
                    imgElement.style.transform = `rotate(${currentMapArrowRotation}deg)`;
                } else {
                    const newArrowIcon = L.divIcon({
                        className: 'arrow-marker-icon',
                        html: `<img src="../../assets/arrow.png" style="width: 116px; height: 116px; transform: rotate(${currentMapArrowRotation}deg); transform-origin: center center; transition: transform ${transitionDuration}s ease-out; display: block;" />`,
                        iconSize: [116, 116],
                        iconAnchor: [58, 58],
                        popupAnchor: [0, -58]
                    });
                    mapMarker.setIcon(newArrowIcon);
                }
            }
        }
    } else if (mapMarker) {
        mapMarker.remove();
        mapMarker = null;
    }
}

/**
 * Clear map marker
 */
export function clearMapMarker() {
    if (mapMarker) {
        mapMarker.remove();
        mapMarker = null;
    }
    currentMapArrowRotation = 0;
}

/**
 * Get current map marker
 */
export function getMapMarker() {
    return mapMarker;
}
