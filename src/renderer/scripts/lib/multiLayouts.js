// Multi-cam layout preset.
// 6-cam layout uses slots: tl, tc, tr, bl, bc, br (3×2 grid).
// Users can drag cameras to rearrange them (custom order saved in settings).

export const MULTI_LAYOUTS = {
  // Default 6-camera layout (3×2 grid)
  six_default: {
    name: 'Default',
    columns: 3,
    slots: [
      { slot: 'tl', camera: 'left_pillar', label: 'Left Pillar' },
      { slot: 'tc', camera: 'front', label: 'Front' },
      { slot: 'tr', camera: 'right_pillar', label: 'Right Pillar' },
      { slot: 'bl', camera: 'left_repeater', label: 'Left Repeater' },
      { slot: 'bc', camera: 'back', label: 'Back' },
      { slot: 'br', camera: 'right_repeater', label: 'Right Repeater' }
    ]
  }
};

export const DEFAULT_MULTI_LAYOUT = 'six_default';
