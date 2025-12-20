/**
 * Draggable Panels
 * Allows dashboard and map panels to be dragged around the screen
 */

// Drag offsets for each panel
const dragOffsets = new Map();

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

/**
 * Reset a panel's position to its original location
 * @param {HTMLElement} panel - Panel element to reset
 */
export function resetPanelPosition(panel) {
    if (dragOffsets.has(panel)) {
        dragOffsets.set(panel, { x: 0, y: 0 });
        panel.style.transform = '';
    }
}
