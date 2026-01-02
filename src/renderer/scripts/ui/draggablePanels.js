/**
 * Draggable Panels
 * Allows dashboard and map panels to be dragged around the screen
 */

// Drag offsets for each panel
const dragOffsets = new Map();
// Track if a drag actually occurred (mouse moved) to prevent click events
const dragOccurred = new Map();
// Track panels that need viewport constraint checking
const constrainedPanels = new Set();

/**
 * Initialize draggable behavior for panels
 * @param {HTMLElement[]} panels - Array of panel elements to make draggable
 */
export function initDraggablePanels(panels) {
    const validPanels = panels.filter(Boolean);
    
    validPanels.forEach(panel => {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let hasMoved = false;
        
        if (!dragOffsets.has(panel)) {
            dragOffsets.set(panel, { x: 0, y: 0 });
        }
        
        panel.addEventListener('mousedown', (e) => {
            // Don't drag if clicking on interactive elements
            if (e.target.closest('button, input, select, a')) return;
            
            isDragging = true;
            hasMoved = false;
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
            const newX = e.clientX - startX;
            const newY = e.clientY - startY;
            
            // Check if mouse actually moved (more than a few pixels)
            if (Math.abs(newX - offset.x) > 2 || Math.abs(newY - offset.y) > 2) {
                hasMoved = true;
            }
            
            offset.x = newX;
            offset.y = newY;
            // Use setProperty with !important for compact dashboard to override CSS !important rules
            if (panel.classList.contains('dashboard-vis-compact')) {
                panel.style.setProperty('transform', `translate3d(${offset.x}px, ${offset.y}px, 0)`, 'important');
            } else {
                panel.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
            }
        });
        
        document.addEventListener('mouseup', (e) => {
            if (isDragging) {
                isDragging = false;
                panel.style.cursor = 'grab';
                
                // If we actually dragged, prevent the click event from firing
                if (hasMoved) {
                    dragOccurred.set(panel, true);
                    // Prevent click event from propagating
                    e.preventDefault();
                    e.stopPropagation();
                    // Clear the flag after a short delay to allow click events again
                    setTimeout(() => {
                        dragOccurred.delete(panel);
                    }, 100);
                }
            }
        });
        
        // Prevent click event if a drag occurred
        panel.addEventListener('click', (e) => {
            if (dragOccurred.has(panel)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, true); // Use capture phase to catch it early
        
        // For compact dashboard, add to constrained panels set
        if (panel.classList.contains('dashboard-vis-compact')) {
            constrainedPanels.add(panel);
        }
    });
    
    // Initialize resize handler if not already set up
    if (!window._draggablePanelsResizeHandler) {
        let resizeTimeout;
        window._draggablePanelsResizeHandler = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                constrainPanelsToViewport();
            }, 100);
        };
        window.addEventListener('resize', window._draggablePanelsResizeHandler);
    }
}

/**
 * Constrain draggable panels to stay within viewport bounds
 */
function constrainPanelsToViewport() {
    constrainedPanels.forEach(panel => {
        if (!panel.isConnected) {
            constrainedPanels.delete(panel);
            return;
        }
        
        const offset = dragOffsets.get(panel);
        if (!offset) return;
        
        const rect = panel.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Get panel dimensions
        const panelWidth = rect.width;
        const panelHeight = rect.height;
        
        // Calculate bounds (with small margin)
        const margin = 10;
        const minX = margin;
        const maxX = viewportWidth - panelWidth - margin;
        const minY = margin;
        const maxY = viewportHeight - panelHeight - margin;
        
        // Get the fixed position values (top/left from CSS or inline styles)
        const computedStyle = window.getComputedStyle(panel);
        const fixedTop = parseInt(panel.style.top) || parseInt(computedStyle.top) || 20;
        const fixedLeft = parseInt(panel.style.left) || parseInt(computedStyle.left) || (viewportWidth - panelWidth - 20);
        
        // Calculate actual position (fixed position + transform offset)
        const currentLeft = fixedLeft + offset.x;
        const currentTop = fixedTop + offset.y;
        
        // Check if panel is outside bounds and adjust if needed
        let newX = offset.x;
        let newY = offset.y;
        let needsUpdate = false;
        
        if (currentLeft < minX) {
            // Panel is off left edge - adjust transform to bring it back
            newX = minX - fixedLeft;
            needsUpdate = true;
        } else if (currentLeft > maxX) {
            // Panel is off right edge - adjust transform to bring it back
            newX = maxX - fixedLeft;
            needsUpdate = true;
        }
        
        if (currentTop < minY) {
            // Panel is off top edge - adjust transform to bring it back
            newY = minY - fixedTop;
            needsUpdate = true;
        } else if (currentTop > maxY) {
            // Panel is off bottom edge - adjust transform to bring it back
            newY = maxY - fixedTop;
            needsUpdate = true;
        }
        
        if (needsUpdate) {
            offset.x = newX;
            offset.y = newY;
            // Update transform
            if (panel.classList.contains('dashboard-vis-compact')) {
                panel.style.setProperty('transform', `translate3d(${offset.x}px, ${offset.y}px, 0)`, 'important');
            } else {
                panel.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
            }
        }
    });
}

/**
 * Reset a panel's position to its original location
 * @param {HTMLElement} panel - Panel element to reset
 */
export function resetPanelPosition(panel) {
    if (dragOffsets.has(panel)) {
        dragOffsets.set(panel, { x: 0, y: 0 });
        // Use setProperty with !important for compact dashboard to override CSS !important rules
        if (panel.classList.contains('dashboard-vis-compact')) {
            panel.style.setProperty('transform', 'translate3d(0, 0, 0)', 'important');
        } else {
            panel.style.transform = '';
        }
    }
}
