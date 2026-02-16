/**
 * Steering Wheel Animation
 * Frame-rate-independent exponential tracking for Tesla-like 1:1 steering response
 */

// Animation state
let steeringPosition = 0;      // Current displayed angle
let steeringTarget = 0;        // Target angle from SEI data
let steeringAnimationId = null;
let lastSteeringTime = 0;

// DOM element references
let steeringIcon = null;
let steeringIconCompact = null;

// Tracking speed: higher = more responsive. 45 gives ~95% tracking in ~67ms (~4 frames at 60fps)
// Tesla's instrument cluster uses near-1:1 tracking; this matches that feel while
// filtering sub-pixel jitter (0.1° noise → 0.05° display movement = invisible)
const STEERING_TRACKING_SPEED = 45;

// Playback rate getter (set via init)
let getPlaybackRate = () => 1;

/**
 * Initialize the steering wheel module
 * @param {Function} playbackRateGetter - Function that returns current playback rate
 */
export function initSteeringWheel(playbackRateGetter) {
    steeringIcon = document.getElementById('steeringIcon');
    steeringIconCompact = document.getElementById('steeringIconCompact');
    if (playbackRateGetter) {
        getPlaybackRate = playbackRateGetter;
    }
}

/**
 * Smoothly animate steering wheel to target angle
 * @param {number} targetAngle - Target angle in degrees
 */
export function smoothSteeringTo(targetAngle) {
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
    
    // Frame-rate-independent exponential tracking: factor approaches 1.0 for large dt
    // Scales with playback rate so animation keeps up at higher speeds
    const playbackRate = getPlaybackRate();
    const factor = 1 - Math.exp(-STEERING_TRACKING_SPEED * playbackRate * dt);
    steeringPosition += (steeringTarget - steeringPosition) * factor;
    
    // Apply to DOM
    if (steeringIcon) {
        steeringIcon.style.transform = `rotate(${steeringPosition}deg)`;
    }
    if (steeringIconCompact) {
        steeringIconCompact.style.transform = `rotate(${steeringPosition}deg)`;
    }
    
    // Check if we're settled (very close to target)
    if (Math.abs(steeringTarget - steeringPosition) < 0.05) {
        steeringPosition = steeringTarget;
        if (steeringIcon) {
            steeringIcon.style.transform = `rotate(${steeringPosition}deg)`;
        }
        if (steeringIconCompact) {
            steeringIconCompact.style.transform = `rotate(${steeringPosition}deg)`;
        }
        steeringAnimationId = null;
        return;
    }
    
    // Continue animation
    steeringAnimationId = requestAnimationFrame(animateSteeringWheel);
}

/**
 * Stop steering animation (call when paused)
 */
export function stopSteeringAnimation() {
    if (steeringAnimationId) {
        cancelAnimationFrame(steeringAnimationId);
        steeringAnimationId = null;
    }
}

/**
 * Reset steering wheel to default state
 */
export function resetSteeringWheel() {
    stopSteeringAnimation();
    steeringPosition = 0;
    steeringTarget = 0;
    if (!steeringIcon) {
        steeringIcon = document.getElementById('steeringIcon');
    }
    if (!steeringIconCompact) {
        steeringIconCompact = document.getElementById('steeringIconCompact');
    }
    if (steeringIcon) {
        steeringIcon.style.transform = 'rotate(0deg)';
    }
    if (steeringIconCompact) {
        steeringIconCompact.style.transform = 'rotate(0deg)';
    }
}
