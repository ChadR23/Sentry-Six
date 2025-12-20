/**
 * Steering Wheel Animation
 * Smooth spring-damper physics for realistic steering wheel movement
 */

// Animation state
let steeringPosition = 0;      // Current displayed angle
let steeringVelocity = 0;      // Current angular velocity
let steeringTarget = 0;        // Target angle from SEI data
let smoothedTarget = 0;        // Smoothed target (reduces noise)
let steeringAnimationId = null;
let lastSteeringTime = 0;

// DOM element reference
let steeringIcon = null;

// Spring-damper physics base constants (tuned for 1x playback)
const STEERING_STIFFNESS_BASE = 15.0;  // Spring force
const STEERING_DAMPING_BASE = 6.5;     // Damping
const TARGET_SMOOTHING_BASE = 0.25;    // Smoothing factor

// Playback rate getter (set via init)
let getPlaybackRate = () => 1;

/**
 * Initialize the steering wheel module
 * @param {Function} playbackRateGetter - Function that returns current playback rate
 */
export function initSteeringWheel(playbackRateGetter) {
    steeringIcon = document.getElementById('steeringIcon');
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
    
    // Scale physics by playback rate so animation keeps up at higher speeds
    const playbackRate = getPlaybackRate();
    const stiffness = STEERING_STIFFNESS_BASE * playbackRate;
    const damping = STEERING_DAMPING_BASE * Math.sqrt(playbackRate);
    const smoothing = Math.min(0.7, TARGET_SMOOTHING_BASE * playbackRate);
    
    // First, smooth the target to reduce noise from SEI data
    smoothedTarget += (steeringTarget - smoothedTarget) * smoothing;
    
    // Spring-damper physics:
    // F = -k*(x - target) - b*v
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
    const settleThreshold = 0.1 * playbackRate;
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
    steeringVelocity = 0;
    steeringTarget = 0;
    smoothedTarget = 0;
    if (!steeringIcon) {
        steeringIcon = document.getElementById('steeringIcon');
    }
    if (steeringIcon) {
        steeringIcon.style.transform = 'rotate(0deg)';
    }
}
