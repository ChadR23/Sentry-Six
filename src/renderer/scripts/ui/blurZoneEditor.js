/**
 * Blur Zone Editor
 * Provides a polygon-based blur zone editor similar to UniFi Protect zone creation
 */

// State for the blur zone editor
const editorState = {
    canvas: null,
    ctx: null,
    image: null,
    anchors: [],
    ghostPoint: null,
    hoveredSegment: null,
    draggedAnchor: null,
    isDraggingZone: false,
    dragOffset: { x: 0, y: 0 },
    imageWidth: 0,
    imageHeight: 0,
    isInitialized: false
};

/**
 * Check if two line segments intersect (for self-intersection detection)
 */
function segmentsIntersect(p1, p2, p3, p4) {
    const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

/**
 * Check if adding a new point would cause self-intersection
 */
function wouldCauseIntersection(anchors, newIndex, newPoint) {
    if (anchors.length < 3) return false;
    
    // Create a test polygon with the new point
    const testAnchors = [...anchors];
    testAnchors.splice(newIndex, 0, newPoint);
    
    // Check each edge against every other edge (skip adjacent edges)
    for (let i = 0; i < testAnchors.length; i++) {
        const p1 = testAnchors[i];
        const p2 = testAnchors[(i + 1) % testAnchors.length];
        
        for (let j = i + 2; j < testAnchors.length; j++) {
            // Skip if this is the last edge connecting to first point
            if (i === 0 && j === testAnchors.length - 1) continue;
            
            const p3 = testAnchors[j];
            const p4 = testAnchors[(j + 1) % testAnchors.length];
            
            if (segmentsIntersect(p1, p2, p3, p4)) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * Find the closest point on a line segment to a given point
 */
function closestPointOnSegment(point, segStart, segEnd) {
    const dx = segEnd.x - segStart.x;
    const dy = segEnd.y - segStart.y;
    const length2 = dx * dx + dy * dy;
    
    if (length2 === 0) return { ...segStart };
    
    const t = Math.max(0, Math.min(1, ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / length2));
    return {
        x: segStart.x + t * dx,
        y: segStart.y + t * dy
    };
}

/**
 * Check if a point is inside a polygon using ray casting algorithm
 */
function pointInPolygon(point, anchors) {
    if (anchors.length < 3) return false;
    
    let inside = false;
    for (let i = 0, j = anchors.length - 1; i < anchors.length; j = i++) {
        const xi = anchors[i].x, yi = anchors[i].y;
        const xj = anchors[j].x, yj = anchors[j].y;
        
        const intersect = ((yi > point.y) !== (yj > point.y))
            && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Find the segment closest to a point and return projection point
 */
function findClosestSegment(point, anchors) {
    if (anchors.length < 2) return null;
    
    let minDist = Infinity;
    let closestSeg = null;
    let closestPoint = null;
    
    for (let i = 0; i < anchors.length; i++) {
        const segStart = anchors[i];
        const segEnd = anchors[(i + 1) % anchors.length];
        const projPoint = closestPointOnSegment(point, segStart, segEnd);
        
        const dx = point.x - projPoint.x;
        const dy = point.y - projPoint.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < minDist) {
            minDist = dist;
            closestSeg = i;
            closestPoint = projPoint;
        }
    }
    
    // Only show ghost point if within reasonable distance (20px)
    if (minDist < 20) {
        return { segmentIndex: closestSeg, point: closestPoint };
    }
    
    return null;
}

/**
 * Load saved coordinates into the editor
 */
export function loadSavedCoordinates(coordinates, canvasWidth, canvasHeight) {
    if (!coordinates || coordinates.length < 3) return;
    
    editorState.anchors = coordinates.map(coord => ({
        x: coord.x * canvasWidth,
        y: coord.y * canvasHeight
    }));
    
    if (editorState.isInitialized) {
        render();
    }
}

/**
 * Initialize the blur zone editor with an image
 */
export function initBlurZoneEditor(imageDataUrl, imageWidth, imageHeight, savedCoordinates = null) {
    const modal = document.getElementById('blurZoneEditorModal');
    if (!modal) return;
    
    const canvas = document.getElementById('blurZoneEditorCanvas');
    if (!canvas) return;
    
    editorState.canvas = canvas;
    editorState.ctx = canvas.getContext('2d');
    editorState.imageWidth = imageWidth;
    editorState.imageHeight = imageHeight;
    
    // Set canvas size to match container
    const container = canvas.parentElement;
    const containerRect = container.getBoundingClientRect();
    const scale = Math.min(containerRect.width / imageWidth, containerRect.height / imageHeight, 1);
    const displayWidth = imageWidth * scale;
    const displayHeight = imageHeight * scale;
    
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    
    // Load and draw the image
    const img = new Image();
    img.onload = () => {
        editorState.image = img;
        editorState.ctx.drawImage(img, 0, 0, displayWidth, displayHeight);
        
        // Initialize with saved coordinates or default centered rectangle
        if (savedCoordinates && savedCoordinates.length >= 3) {
            editorState.anchors = savedCoordinates.map(coord => ({
                x: coord.x * displayWidth,
                y: coord.y * displayHeight
            }));
        } else {
            // Initialize with a centered rectangle (4 anchor points)
            const centerX = displayWidth / 2;
            const centerY = displayHeight / 2;
            const rectWidth = Math.min(displayWidth * 0.3, 200);
            const rectHeight = Math.min(displayHeight * 0.3, 150);
            
            editorState.anchors = [
                { x: centerX - rectWidth / 2, y: centerY - rectHeight / 2 },
                { x: centerX + rectWidth / 2, y: centerY - rectHeight / 2 },
                { x: centerX + rectWidth / 2, y: centerY + rectHeight / 2 },
                { x: centerX - rectWidth / 2, y: centerY + rectHeight / 2 }
            ];
        }
        
        editorState.isInitialized = true;
        render();
    };
    img.src = imageDataUrl;
    
    // Set up event listeners
    setupEventListeners();
}

/**
 * Set up canvas event listeners
 */
function setupEventListeners() {
    const canvas = editorState.canvas;
    if (!canvas) return;
    
    canvas.addEventListener('mousemove', (e) => {
        if (!editorState.isInitialized) return;
        
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        if (editorState.draggedAnchor !== null) {
            // Update dragged anchor position
            editorState.anchors[editorState.draggedAnchor].x = Math.max(0, Math.min(canvas.width, x));
            editorState.anchors[editorState.draggedAnchor].y = Math.max(0, Math.min(canvas.height, y));
            render();
        } else if (editorState.isDraggingZone) {
            // Move all anchors by the drag offset
            const dx = x - editorState.dragOffset.x;
            const dy = y - editorState.dragOffset.y;
            
            for (const anchor of editorState.anchors) {
                anchor.x = Math.max(0, Math.min(canvas.width, anchor.x + dx));
                anchor.y = Math.max(0, Math.min(canvas.height, anchor.y + dy));
            }
            
            editorState.dragOffset.x = x;
            editorState.dragOffset.y = y;
            render();
        } else {
            // Check for ghost point on hover (but not if inside polygon)
            const isInside = pointInPolygon({ x, y }, editorState.anchors);
            if (!isInside) {
                const closest = findClosestSegment({ x, y }, editorState.anchors);
                if (closest) {
                    editorState.ghostPoint = closest.point;
                    editorState.hoveredSegment = closest.segmentIndex;
                    canvas.style.cursor = 'crosshair';
                } else {
                    editorState.ghostPoint = null;
                    editorState.hoveredSegment = null;
                    canvas.style.cursor = 'default';
                }
            } else {
                editorState.ghostPoint = null;
                editorState.hoveredSegment = null;
                canvas.style.cursor = 'move';
            }
            render();
        }
    });
    
    canvas.addEventListener('mousedown', (e) => {
        if (!editorState.isInitialized) return;
        
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // Check if clicking on an anchor point (highest priority)
        for (let i = 0; i < editorState.anchors.length; i++) {
            const anchor = editorState.anchors[i];
            const dx = x - anchor.x;
            const dy = y - anchor.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < 8) {
                editorState.draggedAnchor = i;
                canvas.style.cursor = 'grabbing';
                e.preventDefault();
                return;
            }
        }
        
        // Check if clicking on ghost point
        if (editorState.ghostPoint) {
            const dx = x - editorState.ghostPoint.x;
            const dy = y - editorState.ghostPoint.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < 10) {
                // Insert new anchor point
                const insertIndex = editorState.hoveredSegment + 1;
                
                // Check for self-intersection
                if (!wouldCauseIntersection(editorState.anchors, insertIndex, editorState.ghostPoint)) {
                    editorState.anchors.splice(insertIndex, 0, { ...editorState.ghostPoint });
                    editorState.ghostPoint = null;
                    editorState.hoveredSegment = null;
                    render();
                }
                e.preventDefault();
                return;
            }
        }
        
        // Check if clicking inside the polygon (for zone dragging)
        if (pointInPolygon({ x, y }, editorState.anchors)) {
            editorState.isDraggingZone = true;
            editorState.dragOffset.x = x;
            editorState.dragOffset.y = y;
            canvas.style.cursor = 'grabbing';
            e.preventDefault();
        }
    });
    
    canvas.addEventListener('mouseup', () => {
        editorState.draggedAnchor = null;
        editorState.isDraggingZone = false;
        editorState.dragOffset = { x: 0, y: 0 };
        canvas.style.cursor = 'default';
    });
    
    canvas.addEventListener('mouseleave', () => {
        editorState.ghostPoint = null;
        editorState.hoveredSegment = null;
        editorState.draggedAnchor = null;
        editorState.isDraggingZone = false;
        editorState.dragOffset = { x: 0, y: 0 };
        canvas.style.cursor = 'default';
        render();
    });
}

/**
 * Render the canvas
 */
function render() {
    const ctx = editorState.ctx;
    const canvas = editorState.canvas;
    if (!ctx || !canvas || !editorState.isInitialized) return;
    
    // Clear and redraw image
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (editorState.image) {
        ctx.drawImage(editorState.image, 0, 0, canvas.width, canvas.height);
    }
    
    // Draw polygon fill (semi-transparent blue/purple)
    if (editorState.anchors.length >= 3) {
        ctx.fillStyle = 'rgba(147, 51, 234, 0.4)'; // Purple with transparency
        ctx.beginPath();
        ctx.moveTo(editorState.anchors[0].x, editorState.anchors[0].y);
        for (let i = 1; i < editorState.anchors.length; i++) {
            ctx.lineTo(editorState.anchors[i].x, editorState.anchors[i].y);
        }
        ctx.closePath();
        ctx.fill();
    }
    
    // Draw polygon outline
    if (editorState.anchors.length >= 2) {
        ctx.strokeStyle = 'rgba(147, 51, 234, 0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(editorState.anchors[0].x, editorState.anchors[0].y);
        for (let i = 1; i < editorState.anchors.length; i++) {
            ctx.lineTo(editorState.anchors[i].x, editorState.anchors[i].y);
        }
        ctx.closePath();
        ctx.stroke();
    }
    
    // Draw anchor points
    ctx.fillStyle = '#9333ea'; // Purple
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    
    for (const anchor of editorState.anchors) {
        ctx.beginPath();
        ctx.arc(anchor.x, anchor.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    
    // Draw ghost point
    if (editorState.ghostPoint) {
        ctx.fillStyle = 'rgba(147, 51, 234, 0.6)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(editorState.ghostPoint.x, editorState.ghostPoint.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
}

/**
 * Get normalized coordinates (0-1 range) for export
 */
export function getNormalizedCoordinates() {
    if (!editorState.canvas || editorState.anchors.length < 3) return null;
    
    const coords = editorState.anchors.map(anchor => ({
        x: anchor.x / editorState.canvas.width,
        y: anchor.y / editorState.canvas.height
    }));
    
    return coords;
}

/**
 * Get canvas dimensions
 */
export function getCanvasDimensions() {
    if (!editorState.canvas) return null;
    return {
        width: editorState.canvas.width,
        height: editorState.canvas.height
    };
}

/**
 * Generate mask image as base64 PNG (white polygon on black background)
 * @returns {Promise<string>} - Base64-encoded PNG image data URL
 */
export async function generateMaskImage() {
    if (!editorState.canvas || !editorState.isInitialized || editorState.anchors.length < 3) {
        return null;
    }
    
    // Create a new canvas for the mask (same size as editor canvas)
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = editorState.canvas.width;
    maskCanvas.height = editorState.canvas.height;
    const maskCtx = maskCanvas.getContext('2d');
    
    // Fill with black (transparent areas)
    maskCtx.fillStyle = '#000000';
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    
    // Draw polygon in white (blur areas)
    maskCtx.fillStyle = '#FFFFFF';
    maskCtx.beginPath();
    maskCtx.moveTo(editorState.anchors[0].x, editorState.anchors[0].y);
    for (let i = 1; i < editorState.anchors.length; i++) {
        maskCtx.lineTo(editorState.anchors[i].x, editorState.anchors[i].y);
    }
    maskCtx.closePath();
    maskCtx.fill();
    
    return maskCanvas.toDataURL('image/png');
}

/**
 * Reset the editor
 */
export function resetBlurZoneEditor() {
    editorState.anchors = [];
    editorState.ghostPoint = null;
    editorState.hoveredSegment = null;
    editorState.draggedAnchor = null;
    editorState.isInitialized = false;
}

