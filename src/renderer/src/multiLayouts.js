// Multi-cam layout presets.
// 4-cam layouts use slots: tl, tr, bl, br (2×2 grid).
// 6-cam layouts use slots: tl, tc, tr, bl, bc, br (3×2 grid).
// Immersive layouts: Front camera full-screen with others overlaid.
//   Immersive slots: main (front), overlay_tl, overlay_tr, overlay_bl, overlay_bc, overlay_br

export const MULTI_LAYOUTS = {
  // --- Immersive layouts (Front full-screen with overlays) ---

  immersive: {
    name: 'Immersive',
    type: 'immersive',
    overlayOpacity: 0.9,
    slots: [
      { slot: 'main', camera: 'front', label: 'Front' },
      { slot: 'overlay_tl', camera: 'left_pillar', label: 'L Pillar' },
      { slot: 'overlay_tr', camera: 'right_pillar', label: 'R Pillar' },
      { slot: 'overlay_bl', camera: 'left_repeater', label: 'L Rep' },
      { slot: 'overlay_bc', camera: 'back', label: 'Back' },
      { slot: 'overlay_br', camera: 'right_repeater', label: 'R Rep' }
    ]
  },

  immersive_swap: {
    name: 'Immersive (Swap)',
    type: 'immersive',
    overlayOpacity: 0.9,
    slots: [
      { slot: 'main', camera: 'front', label: 'Front' },
      { slot: 'overlay_tl', camera: 'left_pillar', label: 'L Pillar' },
      { slot: 'overlay_tr', camera: 'right_pillar', label: 'R Pillar' },
      { slot: 'overlay_bl', camera: 'right_repeater', label: 'R Rep' },
      { slot: 'overlay_bc', camera: 'back', label: 'Back' },
      { slot: 'overlay_br', camera: 'left_repeater', label: 'L Rep' }
    ]
  },

  // --- 6-camera layouts (3×2 grid) ---

  // Default: Pillars on top (forward-looking), Repeaters on bottom (side/rear)
  six_default: {
    name: 'Pillars Top / Repeaters Bottom',
    columns: 3,
    slots: [
      { slot: 'tl', camera: 'left_pillar', label: 'Left Pillar' },
      { slot: 'tc', camera: 'front', label: 'Front' },
      { slot: 'tr', camera: 'right_pillar', label: 'Right Pillar' },
      { slot: 'bl', camera: 'left_repeater', label: 'Left Repeater' },
      { slot: 'bc', camera: 'back', label: 'Back' },
      { slot: 'br', camera: 'right_repeater', label: 'Right Repeater' }
    ]
  },

  // Repeaters on top, Pillars on bottom
  six_repeaters_top: {
    name: 'Repeaters Top / Pillars Bottom',
    columns: 3,
    slots: [
      { slot: 'tl', camera: 'left_repeater', label: 'Left Rep' },
      { slot: 'tc', camera: 'front', label: 'Front' },
      { slot: 'tr', camera: 'right_repeater', label: 'Right Rep' },
      { slot: 'bl', camera: 'left_pillar', label: 'Left Pillar' },
      { slot: 'bc', camera: 'back', label: 'Back' },
      { slot: 'br', camera: 'right_pillar', label: 'Right Pillar' }
    ]
  },

  // Front/Back prominent in top-left/top-center
  six_fb_first: {
    name: 'Front/Back First',
    columns: 3,
    slots: [
      { slot: 'tl', camera: 'front', label: 'Front' },
      { slot: 'tc', camera: 'back', label: 'Back' },
      { slot: 'tr', camera: 'left_pillar', label: 'Left Pillar' },
      { slot: 'bl', camera: 'right_pillar', label: 'Right Pillar' },
      { slot: 'bc', camera: 'left_repeater', label: 'Left Rep' },
      { slot: 'br', camera: 'right_repeater', label: 'Right Rep' }
    ]
  },

  // --- 4-camera layouts (2×2 grid) for older recordings ---
  fb_lr: {
    name: '4-cam: F/B/L/R',
    columns: 2,
    slots: [
      { slot: 'tl', camera: 'front', label: 'Front' },
      { slot: 'tr', camera: 'back', label: 'Back' },
      { slot: 'bl', camera: 'left_repeater', label: 'Left' },
      { slot: 'br', camera: 'right_repeater', label: 'Right' }
    ]
  },
  fb_rl: {
    name: '4-cam: F/B/R/L',
    columns: 2,
    slots: [
      { slot: 'tl', camera: 'front', label: 'Front' },
      { slot: 'tr', camera: 'back', label: 'Back' },
      { slot: 'bl', camera: 'right_repeater', label: 'Right' },
      { slot: 'br', camera: 'left_repeater', label: 'Left' }
    ]
  }
};

export const DEFAULT_MULTI_LAYOUT = 'six_default';


