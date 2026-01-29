/**
 * ASS Subtitle Generator for Compact Dashboard Export
 * Generates .ass subtitle files from SEI telemetry data for high-speed FFmpeg rendering
 * 
 * This replaces the BrowserWindow capture loop for compact dashboard style,
 * enabling GPU-accelerated exports that run at maximum encoder speed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Constants
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;
const FPS = 36; // Tesla cameras record at ~36fps

// ASS color format: &HAABBGGRR (alpha, blue, green, red)
const COLORS = {
  white: '&H00FFFFFF',
  whiteTransparent: '&H80FFFFFF',
  dimWhite: '&H00808080',
  green: '&H0022C55E',      // #22c55e (blinker active)
  blue: '&H00FF4800',       // #0048ff (autopilot active) - BGR format
  red: '&H000000FF',        // Brake active
  dimGray: '&H00404040',
  transparent: '&HFF000000'
};

// Dashboard text translations for all supported languages
// These are kept compact to preserve layout in exported videos
const DASHBOARD_TRANSLATIONS = {
  en: {
    gear: { 0: 'PARK', 1: 'DRIVE', 2: 'REVERSE', 3: 'NEUTRAL' },
    ap: { 0: 'Manual', 1: 'Self Driving', 2: 'Autosteer', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'No Data'
  },
  es: {
    gear: { 0: 'PARK', 1: 'CONDUCIR', 2: 'REVERSA', 3: 'NEUTRAL' },
    ap: { 0: 'Manual', 1: 'Autónomo', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Sin Datos'
  },
  fr: {
    gear: { 0: 'PARK', 1: 'MARCHE', 2: 'MARCHE AR', 3: 'NEUTRE' },
    ap: { 0: 'Manuel', 1: 'Autonome', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Pas de Données'
  },
  de: {
    gear: { 0: 'PARK', 1: 'FAHREN', 2: 'RÜCKWÄRTS', 3: 'NEUTRAL' },
    ap: { 0: 'Manuell', 1: 'Autonom', 2: 'Autosteer', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Keine Daten'
  },
  zh: {
    gear: { 0: '驻车', 1: '行驶', 2: '倒车', 3: '空档' },
    ap: { 0: '手动', 1: '自动驾驶', 2: '自动转向', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: '无数据'
  },
  ja: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: '手動', 1: '自動運転', 2: 'オートステア', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'データなし'
  },
  ko: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: '수동', 1: '자율주행', 2: '자동조향', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: '데이터 없음'
  },
  pt: {
    gear: { 0: 'PARK', 1: 'CONDUZIR', 2: 'RÉ', 3: 'NEUTRO' },
    ap: { 0: 'Manual', 1: 'Autônomo', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Sem Dados'
  },
  ru: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: 'Ручной', 1: 'Автопилот', 2: 'Автоулр.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Нет данных'
  },
  it: {
    gear: { 0: 'PARK', 1: 'GUIDA', 2: 'RETROMARCIA', 3: 'FOLLE' },
    ap: { 0: 'Manuale', 1: 'Autonomo', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Nessun Dato'
  },
  nl: {
    gear: { 0: 'PARK', 1: 'RIJDEN', 2: 'ACHTERUIT', 3: 'NEUTRAAL' },
    ap: { 0: 'Handmatig', 1: 'Zelfrijdend', 2: 'Autostuur', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Geen Data'
  },
  pl: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: 'Ręczny', 1: 'Autonomiczny', 2: 'Autokier.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Brak Danych'
  },
  tr: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: 'Manuel', 1: 'Otonom', 2: 'Otomatik', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Veri Yok'
  }
};

/**
 * Get translated gear text
 * @param {number} gearState - Gear state (0=PARK, 1=DRIVE, 2=REVERSE, 3=NEUTRAL)
 * @param {string} language - Language code (e.g., 'en', 'es', 'fr')
 * @returns {string} Translated gear text
 */
function getGearText(gearState, language = 'en') {
  const translations = DASHBOARD_TRANSLATIONS[language] || DASHBOARD_TRANSLATIONS.en;
  return translations.gear[gearState] || '--';
}

/**
 * Get translated autopilot state text
 * @param {number} apState - Autopilot state (0=Manual, 1=Self Driving, 2=Autosteer, 3=TACC)
 * @param {string} language - Language code (e.g., 'en', 'es', 'fr')
 * @returns {string} Translated autopilot text
 */
function getApText(apState, language = 'en') {
  const translations = DASHBOARD_TRANSLATIONS[language] || DASHBOARD_TRANSLATIONS.en;
  return translations.ap[apState] || translations.ap[0]; // Default to "Manual"
}

/**
 * Get translated speed unit
 * @param {boolean} useMetric - Whether to use metric (KM/H) or imperial (MPH)
 * @param {string} language - Language code (e.g., 'en', 'es', 'fr')
 * @returns {string} Translated speed unit
 */
function getSpeedUnit(useMetric, language = 'en') {
  const translations = DASHBOARD_TRANSLATIONS[language] || DASHBOARD_TRANSLATIONS.en;
  return useMetric ? translations.speedUnit.kmh : translations.speedUnit.mph;
}

// Legacy mappings for backward compatibility (fallback to English)
const GEAR_TEXT = DASHBOARD_TRANSLATIONS.en.gear;
const AP_TEXT = DASHBOARD_TRANSLATIONS.en.ap;

/**
 * Generate ASS header with styles
 * @param {number} playResX - Coordinate space width (e.g., 1920)
 * @param {number} playResY - Coordinate space height (e.g., 1080)
 * @param {number} fontSize - Base font size for dashboard elements
 * @returns {string} ASS header section
 */
function generateAssHeader(playResX, playResY, fontSize) {
  const scaledFontSize = Math.round(fontSize);
  const smallFontSize = Math.round(fontSize * 0.7);
  const largeFontSize = Math.round(fontSize * 1.4);
  
  return `[Script Info]
Title: Tesla Compact Dashboard
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CompactDash,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: Speed,Segoe UI,${largeFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SpeedUnit,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: Gear,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,1,0,0,0,100,100,1,0,1,2,1,2,10,10,10,1
Style: GearActive,Segoe UI,${scaledFontSize},${COLORS.blue},${COLORS.blue},${COLORS.dimGray},&H80000000,1,0,0,0,100,100,1,0,1,2,1,2,10,10,10,1
Style: Time,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: APLabel,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: APActive,Segoe UI,${smallFontSize},${COLORS.blue},${COLORS.blue},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: BlinkerOff,Segoe UI,${scaledFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: BlinkerOn,Segoe UI,${scaledFontSize},${COLORS.green},${COLORS.green},&H00115C2F,&H80000000,1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: BrakeOff,Segoe UI,${smallFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: BrakeOn,Segoe UI,${smallFontSize},${COLORS.red},${COLORS.red},&H00000080,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: AccelOff,Segoe UI,${smallFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: AccelOn,Segoe UI,${smallFontSize},${COLORS.blue},${COLORS.blue},&H00802400,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SteeringWheel,Segoe UI,${largeFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SteeringActive,Segoe UI,${largeFontSize},${COLORS.blue},${COLORS.blue},&H00802400,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Format timestamp for ASS (h:mm:ss.cc format)
 * @param {number} ms - Time in milliseconds
 * @returns {string} Formatted time string
 */
function formatAssTime(ms) {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centiseconds = Math.floor((totalSeconds % 1) * 100);
  
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

/**
 * Format timestamp for display (12-hour format)
 * @param {number} timestampMs - Unix timestamp in milliseconds
 * @returns {string} Formatted time string
 */
function formatDisplayTime(timestampMs) {
  if (!timestampMs) return '--:--';
  const date = new Date(timestampMs);
  let h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
}

/**
 * Format date for display based on user's date format preference
 * @param {number} timestampMs - Unix timestamp in milliseconds
 * @param {string} dateFormat - Date format: 'mdy', 'dmy', or 'ymd'
 * @returns {string} Formatted date string
 */
function formatDisplayDate(timestampMs, dateFormat = 'mdy') {
  if (!timestampMs) return '--/--/--';
  const date = new Date(timestampMs);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  
  switch (dateFormat) {
    case 'dmy':
      return `${d}/${m}/${y}`;
    case 'ymd':
      return `${y}-${m}-${d}`;
    case 'mdy':
    default:
      return `${m}/${d}/${y}`;
  }
}

/**
 * Get SEI value with camelCase/snake_case fallback
 * @param {Object} sei - SEI data object
 * @param {string} camel - camelCase property name
 * @param {string} snake - snake_case property name
 * @returns {*} Property value or undefined
 */
function getSeiValue(sei, camel, snake) {
  return sei?.[camel] ?? sei?.[snake];
}

/**
 * Calculate dashboard position based on user selection
 * @param {string} position - Position string (e.g., 'bottom-center')
 * @param {number} playResX - Coordinate space width
 * @param {number} playResY - Coordinate space height
 * @param {number} dashWidth - Dashboard width
 * @param {number} dashHeight - Dashboard height
 * @returns {{x: number, y: number}} Position coordinates
 */
function calculatePosition(position, playResX, playResY, dashWidth, dashHeight) {
  const margin = 40; // Margin from edges
  
  const positions = {
    'bottom-center': { x: playResX / 2, y: playResY - margin - dashHeight / 2 },
    'bottom-left': { x: margin + dashWidth / 2, y: playResY - margin - dashHeight / 2 },
    'bottom-right': { x: playResX - margin - dashWidth / 2, y: playResY - margin - dashHeight / 2 },
    'top-center': { x: playResX / 2, y: margin + dashHeight / 2 },
    'top-left': { x: margin + dashWidth / 2, y: margin + dashHeight / 2 },
    'top-right': { x: playResX - margin - dashWidth / 2, y: margin + dashHeight / 2 }
  };
  
  return positions[position] || positions['bottom-center'];
}

/**
 * Generate a single dialogue line for ASS
 * @param {number} layer - Layer number (higher = on top)
 * @param {string} startTime - Start time in ASS format
 * @param {string} endTime - End time in ASS format
 * @param {string} style - Style name
 * @param {string} text - Text content with override tags
 * @returns {string} ASS dialogue line
 */
function dialogueLine(layer, startTime, endTime, style, text) {
  return `Dialogue: ${layer},${startTime},${endTime},${style},,0,0,0,,${text}`;
}

/**
 * Generate ASS drawing for left arrow (blinker)
 * From Illustrator export, mirrored and centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawLeftArrow(scale = 1) {
  return scaleAssPath(SVG_PATHS.arrow_left, scale);
}

/**
 * Generate ASS drawing for right arrow (blinker)
 * From Illustrator export, centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawRightArrow(scale = 1) {
  return scaleAssPath(SVG_PATHS.arrow_right, scale);
}

// Pre-converted SVG path data (from assets/*.svg, normalized and centered at 0,0)
// Exported from Illustrator ASS export, then centered by subtracting center point
const SVG_PATHS = {
  // From testwheel.svg - outer blue circle, centered at (0,0)
  // Original center was at (539.26, 540.24), radius ~446.5
  testwheel_outer: 'm 446.53 0 b 446.53 246.61 246.61 446.53 0 446.53 b -246.61 446.53 -446.53 246.61 -446.53 0 b -446.53 -246.61 -246.61 -446.53 0 -446.53 b 246.61 -446.53 446.53 -246.61 446.53 0',
  // Inner white ring with grip cutouts, centered at (0,0)
  testwheel_inner: 'm 0 -300.34 b -165.6 -300.34 -300.3 -165.59 -300.3 0 b -300.3 165.6 -165.6 300.3 0 300.3 b 165.59 300.3 300.34 165.6 300.34 0 b 300.34 -165.59 165.59 -300.34 0 -300.34 m 0 -246.73 b 115.88 -246.73 213.3 -166.47 239.67 -58.62 b 240.2 -56.58 240.88 -54.24 241.23 -51.9 l 241.23 -51.85 b 242.39 -42.98 237.96 -34.35 198.15 -43.42 b 147.9 -54.87 74.12 -93.95 5.21 -93.95 b -63.7 -93.95 -145.62 -59.08 -180.27 -47.22 b -214.77 -34.45 -241.33 -38.59 -241.62 -49.9 b -218.48 -162.13 -118.91 -246.73 0 -246.73 m -58.73 239.63 b -149.37 217.4 -220.52 144.99 -240.8 53.61 b -235.39 42.89 -221.35 25.25 -189.04 32.02 b -143.77 41.52 -80.66 96.54 -55.76 144.6 b -31.49 191.48 -39.62 242.5 -57.41 239.92 b -57.85 239.87 -58.29 239.77 -58.73 239.63 m 71.39 236.17 l 71.34 236.17 b 47.02 238.46 42.3 232.61 41.71 209.12 b 41.18 185.68 45.9 124.22 118.27 69.45 b 190.59 14.72 234.06 24.95 240.06 57.07 l 240.06 57.12 b 219.73 142.55 154.82 210.92 71.39 236.17',
  // From Illustrator export - accelerator pedal, centered at (0,0)
  // Original center was at (540, 540), size 1080x1080
  // Main pedal body (white shape)
  pedal_acc: 'm 184.15 -263.81 l 184.15 151.71 b 184.15 176.67 161.74 344.75 154.63 382.21 b 147.53 419.67 114.32 444.66 72.87 444.66 l 12.58 444.66 b -2.5 444.66 -12.58 444.66 -12.58 444.66 l -72.87 444.66 b -114.32 444.66 -147.53 419.67 -154.63 382.21 b -161.74 344.75 -184.15 176.67 -184.15 151.71 l -184.15 -263.81 b -184.15 -288.02 -164.54 -307.63 -140.35 -307.63 l 140.35 -307.63 b 164.54 -307.63 184.15 -288.02 184.15 -263.81',
  // Accelerator pedal top tab
  pedal_acc_tab: 'm -55.64 -443.52 l -121.12 -443.52 l -121.12 -297.03 l -55.64 -297.03 l -55.64 -443.52',
  // From Illustrator export - brake pedal, centered at (0,0)
  // Original center was at (540, 540), size 1080x1080
  // Main pedal body (white shape)
  pedal_brake: 'm 386.05 -10.57 l 386.05 275.73 b 386.05 289.36 384.15 302.92 380.41 316.03 l 361.92 380.73 b 354.9 405.28 332.47 422.2 306.93 422.2 l -307.86 422.2 b -333.25 422.2 -355.6 405.46 -362.74 381.1 l -380.95 318.98 b -384.87 305.58 -386.87 291.69 -386.87 277.73 l -386.87 -10.57 b -386.87 -61.26 -345.77 -102.36 -295.08 -102.36 l 294.27 -102.36 b 344.96 -102.36 386.05 -61.26 386.05 -10.57',
  // Brake pedal top tab
  pedal_brake_tab: 'm 270.2 -90.88 l 385.2 -293.5 l 385.2 -422.44 l 188.28 -83.07 l 270.2 -90.88',
  // From Illustrator export - right arrow blinker, centered at (0,0), SOLID (outer contour only)
  // Original center was at (960, 541), size ~195x168
  arrow_right: 'm 13.11 -33.71 b 15.61 -33.7 16.06 -36.09 15.15 -38.05 9.81 -49.52 5.3 -59.32 1.63 -67.45 -1.42 -74.21 0.76 -78.22 5.55 -83.46 5.8 -83.72 6.07 -83.94 6.38 -84.12 14.17 -88.49 20.03 -84.98 25.77 -79.01 36.67 -67.69 45.88 -58.89 57.03 -47.37 62.85 -41.36 73.29 -30.89 88.34 -15.96 91.84 -12.49 95.74 -8.94 97.13 -4.62 99.07 1.36 96.56 6.15 92.31 10.41 59.34 43.5 38.6 64.39 30.11 73.08 27.75 75.49 26.47 76.81 26.28 77.03 23.64 80 20.08 83.56 16.05 83.93 13.88 84.12 11.77 84.13 9.72 83.94 9.38 83.91 9.05 83.83 8.73 83.7 1.64 80.77 -1.19 75.32 0.25 67.36 0.32 66.99 0.43 66.63 0.58 66.29 5.37 55.61 9.91 45.68 14.2 36.51 15.9 32.89 13.31 31.3 10.28 31.29 -5.65 31.24 -34.48 31.23 -76.21 31.24 -83.28 31.24 -87.73 30.78 -89.56 29.85 -93.33 27.94 -96.02 24.45 -97.65 19.38 -97.74 19.08 -97.79 18.76 -97.79 18.44 l -97.73 -20.92 b -97.73 -21.05 -97.71 -21.18 -97.68 -21.31 -96.46 -26.68 -93.59 -30.44 -89.07 -32.6 -87.14 -33.53 -83.84 -33.99 -79.19 -33.98 -43.76 -33.92 -13 -33.83 13.11 -33.71',
  // Left arrow - mirrored version of right arrow (negate X coordinates), SOLID
  arrow_left: 'm -13.11 -33.71 b -15.61 -33.7 -16.06 -36.09 -15.15 -38.05 -9.81 -49.52 -5.3 -59.32 -1.63 -67.45 1.42 -74.21 -0.76 -78.22 -5.55 -83.46 -5.8 -83.72 -6.07 -83.94 -6.38 -84.12 -14.17 -88.49 -20.03 -84.98 -25.77 -79.01 -36.67 -67.69 -45.88 -58.89 -57.03 -47.37 -62.85 -41.36 -73.29 -30.89 -88.34 -15.96 -91.84 -12.49 -95.74 -8.94 -97.13 -4.62 -99.07 1.36 -96.56 6.15 -92.31 10.41 -59.34 43.5 -38.6 64.39 -30.11 73.08 -27.75 75.49 -26.47 76.81 -26.28 77.03 -23.64 80 -20.08 83.56 -16.05 83.93 -13.88 84.12 -11.77 84.13 -9.72 83.94 -9.38 83.91 -9.05 83.83 -8.73 83.7 -1.64 80.77 1.19 75.32 -0.25 67.36 -0.32 66.99 -0.43 66.63 -0.58 66.29 -5.37 55.61 -9.91 45.68 -14.2 36.51 -15.9 32.89 -13.31 31.3 -10.28 31.29 5.65 31.24 34.48 31.23 76.21 31.24 83.28 31.24 87.73 30.78 89.56 29.85 93.33 27.94 96.02 24.45 97.65 19.38 97.74 19.08 97.79 18.76 97.79 18.44 l 97.73 -20.92 b 97.73 -21.05 97.71 -21.18 97.68 -21.31 96.46 -26.68 93.59 -30.44 89.07 -32.6 87.14 -33.53 83.84 -33.99 79.19 -33.98 43.76 -33.92 13 -33.83 -13.11 -33.71'
};

/**
 * Scale an ASS path string by a factor
 * @param {string} path - ASS path with coordinates
 * @param {number} scale - Scale factor
 * @returns {string} Scaled path
 */
function scaleAssPath(path, scale) {
  if (scale === 1) return path;
  return path.replace(/-?\d+\.?\d*/g, (match) => {
    const num = parseFloat(match);
    return Math.round(num * scale * 100) / 100;
  });
}

/**
 * Generate ASS drawing for steering wheel (from testwheel.svg)
 * Centered at (0,0) for proper rotation around the wheel center
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawSteeringWheelOuter(scale = 1) {
  return scaleAssPath(SVG_PATHS.testwheel_outer, scale);
}

function drawSteeringWheelInner(scale = 1) {
  return scaleAssPath(SVG_PATHS.testwheel_inner, scale);
}

/**
 * Generate ASS drawing for accelerator pedal (main body)
 * From Illustrator export, centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawAcceleratorPedal(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_acc, scale);
}

/**
 * Generate ASS drawing for accelerator pedal tab
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawAcceleratorPedalTab(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_acc_tab, scale);
}

/**
 * Generate ASS drawing for brake pedal (main body)
 * From Illustrator export, centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawBrakePedal(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_brake, scale);
}

/**
 * Generate ASS drawing for brake pedal tab
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawBrakePedalTab(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_brake_tab, scale);
}

/**
 * Generate ASS drawing for steering wheel (legacy simple version)
 * @returns {string} ASS vector drawing commands
 */
function drawSteeringWheel() {
  // Simplified steering wheel icon
  // Outer circle with spokes
  return '{\\p1}m 20 0 b 31 0 40 9 40 20 b 40 31 31 40 20 40 b 9 40 0 31 0 20 b 0 9 9 0 20 0 m 20 5 b 12 5 5 12 5 20 b 5 28 12 35 20 35 b 28 35 35 28 35 20 b 35 12 28 5 20 5 m 18 20 l 5 20 m 22 20 l 35 20 m 20 18 l 20 5{\\p0}';
}

/**
 * Generate compact dashboard events for a time range
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Export options
 * @returns {string} ASS events section
 */
function generateCompactDashboardEvents(seiData, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    playResY = 1080,
    position = 'bottom-center',
    size = 'medium',
    useMetric = false,
    segments = [],
    cumStarts = [],
    dateFormat = 'mdy',
    language = 'en'
  } = options;
  
  // Dashboard dimensions - scale based on video width and size option
  // Size options: small (25%), medium (35%), large (45%), xlarge (55% - for high-res exports)
  const sizeMultipliers = {
    'small': 0.25,
    'medium': 0.35,
    'large': 0.45,
    'xlarge': 0.55
  };
  const sizeMultiplier = sizeMultipliers[size] || 0.35;
  
  // Compact style aspect ratio: 480x56 (8.57:1)
  // Cap dashboard width to prevent it from getting too large on high-res exports
  // Max width based on 1920px reference (standard 1080p width)
  const maxDashWidth = Math.round(1920 * sizeMultiplier);
  const rawDashWidth = Math.round(playResX * sizeMultiplier);
  const dashWidth = Math.min(rawDashWidth, maxDashWidth);
  const dashHeight = Math.round(dashWidth / 8.57);
  const fontSize = Math.round(dashHeight * 0.45);
  const iconSize = Math.round(dashHeight * 0.5);
  
  const pos = calculatePosition(position, playResX, playResY, dashWidth, dashHeight);
  const events = [];
  
  // Calculate element positions - evenly distributed across dashboard width
  // Layout: [Brake] [Date/Time] [<] [Speed+Unit] [Gear/AP] [>] [Steering] [Accel]
  // 8 elements, evenly spaced with extra gap between Speed and Gear/AP
  const numElements = 8;
  const padding = dashWidth * 0.05; // 5% padding on each side
  const usableWidth = dashWidth - (padding * 2);
  const spacing = usableWidth / (numElements - 1);
  const startX = pos.x - dashWidth / 2 + padding;
  
  // Even spacing for all elements, with speed/gearAp shifted for extra gap
  const extraGap = spacing * 0.15; // Extra gap between speed and gear/AP
  const positions = {
    brake: startX + spacing * 0,
    dateTime: startX + spacing * 1,              // Date/Time (was Gear)
    leftBlinker: startX + spacing * 2,
    speed: startX + spacing * 3 - extraGap,      // Shift left slightly
    gearAp: startX + spacing * 4 + extraGap,     // Gear/AP (was Time/AP) - Shift right slightly
    rightBlinker: startX + spacing * 5,
    steering: startX + spacing * 6,
    accel: startX + spacing * 7
  };
  
  const durationMs = endTimeMs - startTimeMs;
  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const frameTimeMs = 1000 / FPS;
  
  // Blinker animation: 0.8s cycle at 36fps = ~29 frames per cycle
  const framesPerBlinkerCycle = 29;
  
  // Find SEI data for a given video time
  function findSeiAtTime(videoTimeMs) {
    if (!seiData || seiData.length === 0) return null;
    
    let closest = seiData[0];
    let minDiff = Math.abs(seiData[0].timestampMs - videoTimeMs);
    
    for (let i = 1; i < seiData.length; i++) {
      const diff = Math.abs(seiData[i].timestampMs - videoTimeMs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = seiData[i];
      }
      if (seiData[i].timestampMs > videoTimeMs && diff > minDiff) break;
    }
    
    return closest?.sei || null;
  }
  
  // Convert video time to actual timestamp for display
  function convertVideoTimeToTimestamp(videoTimeMs) {
    if (!segments || segments.length === 0) return videoTimeMs;
    
    for (let i = 0; i < segments.length; i++) {
      const segStart = (cumStarts[i] || 0) * 1000;
      const segDuration = (segments[i]?.durationSec || 60) * 1000;
      const segEnd = segStart + segDuration;
      
      if (videoTimeMs >= segStart && videoTimeMs < segEnd) {
        const segmentTimestamp = segments[i]?.timestamp;
        if (segmentTimestamp) {
          const offsetInSegment = videoTimeMs - segStart;
          return segmentTimestamp + offsetInSegment;
        }
      }
    }
    
    return videoTimeMs;
  }
  
  // Track previous state to only emit events when data changes
  let prevState = null;
  let eventStartFrame = 0;
  
  for (let frame = 0; frame <= totalFrames; frame++) {
    const currentTimeMs = startTimeMs + (frame * frameTimeMs);
    const sei = findSeiAtTime(currentTimeMs);
    const actualTimestampMs = convertVideoTimeToTimestamp(currentTimeMs);
    
    // Extract telemetry values
    const mps = Math.abs(getSeiValue(sei, 'vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedUnit = getSpeedUnit(useMetric, language);
    
    const gear = getSeiValue(sei, 'gearState', 'gear_state');
    const gearText = getGearText(gear, language);
    
    const leftBlinkerOn = !!getSeiValue(sei, 'blinkerOnLeft', 'blinker_on_left');
    const rightBlinkerOn = !!getSeiValue(sei, 'blinkerOnRight', 'blinker_on_right');
    
    const apState = getSeiValue(sei, 'autopilotState', 'autopilot_state');
    const apActive = apState === 1 || apState === 2;
    const apText = getApText(apState, language);
    
    const brakeApplied = !!getSeiValue(sei, 'brakeApplied', 'brake_applied');
    const isAutoHold = gear === 1 && mps < 0.01;
    const brakeActive = brakeApplied || isAutoHold;
    
    const accelPos = getSeiValue(sei, 'acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelActive = accelPos > 1 ? accelPos > 5 : accelPos > 0.05;
    
    const steeringAngle = getSeiValue(sei, 'steeringWheelAngle', 'steering_wheel_angle') || 0;
    
    // Blinker animation state (frame-based)
    const frameInCycle = frame % framesPerBlinkerCycle;
    const isBlinkOn = frameInCycle < Math.floor(framesPerBlinkerCycle / 2);
    const leftBlinkVisible = leftBlinkerOn && isBlinkOn;
    const rightBlinkVisible = rightBlinkerOn && isBlinkOn;
    
    const displayTime = formatDisplayTime(actualTimestampMs);
    const displayDate = formatDisplayDate(actualTimestampMs, dateFormat);
    
    // Create state signature for change detection
    const currentState = JSON.stringify({
      speed, gearText, leftBlinkVisible, rightBlinkVisible,
      apActive, apText, brakeActive, accelActive,
      steeringAngle: Math.round(steeringAngle), displayTime, displayDate
    });
    
    // Emit events when state changes or at the end
    if (currentState !== prevState || frame === totalFrames) {
      if (prevState !== null && eventStartFrame < frame) {
        const startAssTime = formatAssTime((eventStartFrame * frameTimeMs));
        const endAssTime = formatAssTime((frame * frameTimeMs));
        
        // Parse previous state for event generation
        const prev = JSON.parse(prevState);
        
        // Corner radius for rounded rectangle
        const cornerRadius = Math.round(dashHeight * 0.35);
        
        // Background panel - semi-transparent dark rounded rectangle
        // Using absolute coordinates for the rectangle (not relative to pos)
        const bgLeft = pos.x - dashWidth / 2;
        const bgRight = pos.x + dashWidth / 2;
        const bgTop = pos.y - dashHeight / 2;
        const bgBottom = pos.y + dashHeight / 2;
        const r = cornerRadius;
        
        // Draw rounded rectangle using ASS vector drawing with absolute positioning
        // The \an7 (top-left alignment) + \pos(0,0) makes coordinates absolute
        events.push(dialogueLine(0, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(0,0)\\bord1\\shad0\\1c&H302828&\\3c&H404040&\\1a&H40&\\p1}` +
          `m ${bgLeft + r} ${bgTop} ` +
          `l ${bgRight - r} ${bgTop} ` +
          `b ${bgRight} ${bgTop} ${bgRight} ${bgTop + r} ${bgRight} ${bgTop + r} ` +
          `l ${bgRight} ${bgBottom - r} ` +
          `b ${bgRight} ${bgBottom} ${bgRight - r} ${bgBottom} ${bgRight - r} ${bgBottom} ` +
          `l ${bgLeft + r} ${bgBottom} ` +
          `b ${bgLeft} ${bgBottom} ${bgLeft} ${bgBottom - r} ${bgLeft} ${bgBottom - r} ` +
          `l ${bgLeft} ${bgTop + r} ` +
          `b ${bgLeft} ${bgTop} ${bgLeft + r} ${bgTop} ${bgLeft + r} ${bgTop}{\\p0}`
        ));
        
        // Brake pedal icon - from Illustrator export, centered at (0,0)
        const brakeColor = prev.brakeActive ? '&H0000FF&' : '&H606060&'; // Red when active, gray when off
        // Base path is ~773 units wide (from -386.87 to 386.05), scale to fit iconSize
        const pedalScale = iconSize / 450 * 0.45; // Scale to ~45% of iconSize
        const brakeX = Math.round(positions.brake);
        const brakeY = Math.round(pos.y);
        // Main pedal body
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${brakeX},${brakeY})\\bord0\\shad0\\1c${brakeColor}\\p1}` +
          drawBrakePedal(pedalScale) + `{\\p0}`
        ));
        // Pedal tab (same color)
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${brakeX},${brakeY})\\bord0\\shad0\\1c${brakeColor}\\p1}` +
          drawBrakePedalTab(pedalScale) + `{\\p0}`
        ));
        
        // Speed and gear font sizes (declared early as used by gear display)
        const speedNumSize = Math.round(fontSize * 1.4);
        const speedUnitSize = Math.round(fontSize * 0.55);
        const smallTextSize = Math.round(fontSize * 0.7);
        
        // Date and Time display (stacked vertically) - at position 1 (where Gear was)
        // Date on top, Time below - both same size as the old time display
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.dateTime},${pos.y - fontSize * 0.35})\\bord0\\shad0\\fs${smallTextSize}\\1c&HA0A0A0&}${prev.displayDate}`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.dateTime},${pos.y + fontSize * 0.35})\\bord0\\shad0\\fs${smallTextSize}\\1c&HA0A0A0&}${prev.displayTime}`
        ));
        
        // Left blinker arrow - from Illustrator export, centered at (0,0)
        const leftColor = prev.leftBlinkVisible ? '&H22C55E&' : '&H505050&'; // Green when on
        // Base arrow path is ~195 units wide, scale to fit iconSize
        const arrowScale = iconSize / 100 * 0.35; // Scale to ~35% of iconSize
        const leftX = Math.round(positions.leftBlinker);
        const leftY = Math.round(pos.y);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${leftX},${leftY})\\bord0\\shad0\\1c${leftColor}\\p1}` +
          drawLeftArrow(arrowScale) + `{\\p0}`
        ));
        
        // Speed display - number with unit beside it (e.g. "32 MPH")
        const speedGap = fontSize * 0.15; // Small gap between number and unit
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an6\\pos(${positions.speed - speedGap},${pos.y})\\bord0\\shad0\\fs${speedNumSize}\\1c&HFFFFFF&}${prev.speed}`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an4\\pos(${positions.speed + speedGap},${pos.y})\\bord0\\shad0\\fs${speedUnitSize}\\1c&H909090&}${speedUnit}`
        ));
        
        // Gear and Autopilot label (stacked vertically) - at position 4 (where Time was)
        // Gear on top (same size as time text), AP label below
        const gearColor = prev.apActive ? '&HFF4800&' : '&HFFFFFF&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.gearAp},${pos.y - fontSize * 0.35})\\bord0\\shad0\\fs${smallTextSize}\\1c${gearColor}}${prev.gearText}`
        ));
        const apColor = prev.apActive ? '&HFF4800&' : '&H808080&'; // Blue when active
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.gearAp},${pos.y + fontSize * 0.35})\\bord0\\shad0\\fs${smallTextSize}\\1c${apColor}}${prev.apText}`
        ));
        
        // Right blinker arrow - from Illustrator export, centered at (0,0)
        const rightColor = prev.rightBlinkVisible ? '&H22C55E&' : '&H505050&';
        const rightX = Math.round(positions.rightBlinker);
        const rightY = Math.round(pos.y);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${rightX},${rightY})\\bord0\\shad0\\1c${rightColor}\\p1}` +
          drawRightArrow(arrowScale) + `{\\p0}`
        ));
        
        // Steering wheel - from testwheel.svg (Illustrator export), centered at (0,0) for proper rotation
        const steerColor = prev.apActive ? '&HFF4800&' : '&H707070&'; // Blue when AP active
        // ASS \frz rotates counter-clockwise for positive angles, but CSS rotate() is clockwise
        // Negate the angle so exported steering wheel matches the live preview direction
        const angle = -(prev.steeringAngle || 0);
        // Base path radius is ~446.5 units, scale to fit iconSize
        const steerScale = iconSize / 446.5 * 0.5; // Scale to ~50% of iconSize
        const steerX = Math.round(positions.steering);
        const steerY = Math.round(pos.y);
        
        // For ASS vector drawings, \an7 with \pos places the drawing origin (0,0) at pos
        // Since our paths are centered at (0,0), this should center the wheel at steerX, steerY
        // \org sets the rotation origin to the same point
        
        // Outer filled circle (blue/gray background)
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${steerX},${steerY})\\org(${steerX},${steerY})\\bord0\\shad0\\1c${steerColor}\\frz${angle}\\p1}` +
          drawSteeringWheelOuter(steerScale) + `{\\p0}`
        ));
        
        // Inner white ring with grip cutouts
        events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${steerX},${steerY})\\org(${steerX},${steerY})\\bord0\\shad0\\1c&HFFFFFF&\\frz${angle}\\p1}` +
          drawSteeringWheelInner(steerScale) + `{\\p0}`
        ));
        
        // Accelerator pedal icon - from Illustrator export, centered at (0,0)
        const accelColor = prev.accelActive ? '&HFF4800&' : '&H606060&'; // Blue when active
        const accelX = Math.round(positions.accel);
        const accelY = Math.round(pos.y);
        // Main pedal body
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c${accelColor}\\p1}` +
          drawAcceleratorPedal(pedalScale) + `{\\p0}`
        ));
        // Pedal tab (same color)
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c${accelColor}\\p1}` +
          drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
        ));
      }
      
      prevState = currentState;
      eventStartFrame = frame;
    }
  }
  
  return events.join('\n');
}

/**
 * Generate complete ASS subtitle file for compact dashboard
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Export options
 * @returns {string} Complete ASS file content
 */
function generateCompactDashboardAss(seiData, startTimeMs, endTimeMs, options) {
  const { playResX = 1920, playResY = 1080 } = options;
  
  // Calculate font size based on resolution
  const dashWidth = Math.round(playResX * 0.25);
  const dashHeight = Math.round(dashWidth * (76 / 500));
  const fontSize = Math.round(dashHeight * 0.4);
  
  const header = generateAssHeader(playResX, playResY, fontSize);
  const events = generateCompactDashboardEvents(seiData, startTimeMs, endTimeMs, options);
  
  return header + events;
}

/**
 * Write ASS subtitle file to temp directory
 * @param {string} exportId - Export ID for unique filename
 * @param {Array} seiData - SEI telemetry data
 * @param {number} startTimeMs - Start time in ms
 * @param {number} endTimeMs - End time in ms
 * @param {Object} options - Export options
 * @returns {Promise<string>} Path to generated ASS file
 */
async function writeCompactDashboardAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const assContent = generateCompactDashboardAss(seiData, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `dashboard_${exportId}_${Date.now()}.ass`);
  
  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated compact dashboard subtitle: ${tempPath}`);
  
  return tempPath;
}

/**
 * Delete temporary ASS file
 * @param {string} assPath - Path to ASS file
 */
async function cleanupAssFile(assPath) {
  try {
    await fs.promises.unlink(assPath);
    console.log(`[ASS] Cleaned up temp file: ${assPath}`);
  } catch (err) {
    console.warn(`[ASS] Failed to cleanup temp file: ${assPath}`, err.message);
  }
}

/**
 * Generate ASS header for solid cover overlay
 * @param {number} playResX - Coordinate space width
 * @param {number} playResY - Coordinate space height
 * @returns {string} ASS header section
 */
function generateSolidCoverHeader(playResX, playResY) {
  return `[Script Info]
Title: Blur Zone Solid Cover
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: SolidCover,Arial,20,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Generate ASS drawing commands for a polygon
 * @param {Array} coordinates - Array of {x, y} normalized coordinates (0-1)
 * @param {number} width - Video width
 * @param {number} height - Video height
 * @returns {string} ASS vector drawing commands
 */
function generatePolygonPath(coordinates, width, height) {
  if (!coordinates || coordinates.length < 3) return '';
  
  // Convert normalized coordinates to absolute pixels
  const points = coordinates.map(c => ({
    x: Math.round(c.x * width),
    y: Math.round(c.y * height)
  }));
  
  // Build ASS path: m x y l x y l x y ... (move to first, line to rest)
  let path = `m ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    path += ` l ${points[i].x} ${points[i].y}`;
  }
  
  return path;
}

/**
 * Generate ASS events for solid cover overlays on blur zones
 * @param {Array} blurZones - Array of blur zone objects {coordinates, camera}
 * @param {number} durationMs - Total video duration in milliseconds
 * @param {Object} cameraDimensions - Object mapping camera names to {width, height}
 * @param {Object} cameraPositions - Object mapping camera names to {x, y} positions in the grid
 * @returns {string} ASS events section
 */
function generateSolidCoverEvents(blurZones, durationMs, cameraDimensions, cameraPositions) {
  const events = [];
  const startTime = formatAssTime(0);
  const endTime = formatAssTime(durationMs);
  
  for (const zone of blurZones) {
    if (!zone || !zone.coordinates || zone.coordinates.length < 3 || !zone.camera) continue;
    
    const camDims = cameraDimensions[zone.camera];
    const camPos = cameraPositions[zone.camera];
    
    if (!camDims || !camPos) {
      console.warn(`[ASS] Unknown camera or position for blur zone: ${zone.camera}`);
      continue;
    }
    
    // Convert normalized coordinates to absolute pixels within the camera's region
    const points = zone.coordinates.map(c => ({
      x: Math.round(camPos.x + c.x * camDims.width),
      y: Math.round(camPos.y + c.y * camDims.height)
    }));
    
    // Build ASS path
    let path = `m ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      path += ` l ${points[i].x} ${points[i].y}`;
    }
    
    // Create dialogue line with solid black polygon
    // Using \an7 (top-left alignment) + \pos(0,0) for absolute positioning
    // \1c&H000000& = solid black fill
    // \bord0 = no border
    // \shad0 = no shadow
    // \p1 = enable drawing mode
    events.push(`Dialogue: 10,${startTime},${endTime},SolidCover,,0,0,0,,{\\an7\\pos(0,0)\\1c&H000000&\\bord0\\shad0\\p1}${path}{\\p0}`);
  }
  
  return events.join('\n');
}

/**
 * Generate complete ASS file for solid cover overlays
 * @param {Array} blurZones - Array of blur zone objects
 * @param {number} durationMs - Total video duration in milliseconds
 * @param {number} gridWidth - Total grid width in pixels
 * @param {number} gridHeight - Total grid height in pixels
 * @param {Object} cameraDimensions - Object mapping camera names to {width, height}
 * @param {Object} cameraPositions - Object mapping camera names to {x, y} positions
 * @returns {string} Complete ASS file content
 */
function generateSolidCoverAss(blurZones, durationMs, gridWidth, gridHeight, cameraDimensions, cameraPositions) {
  const header = generateSolidCoverHeader(gridWidth, gridHeight);
  const events = generateSolidCoverEvents(blurZones, durationMs, cameraDimensions, cameraPositions);
  
  return header + events;
}

/**
 * Write solid cover ASS file to temp directory
 * @param {string} exportId - Export ID for unique filename
 * @param {Array} blurZones - Blur zone data
 * @param {number} durationMs - Video duration in milliseconds
 * @param {number} gridWidth - Grid width in pixels
 * @param {number} gridHeight - Grid height in pixels
 * @param {Object} cameraDimensions - Camera dimensions
 * @param {Object} cameraPositions - Camera positions
 * @returns {Promise<string>} Path to generated ASS file
 */
async function writeSolidCoverAss(exportId, blurZones, durationMs, gridWidth, gridHeight, cameraDimensions, cameraPositions) {
  const assContent = generateSolidCoverAss(blurZones, durationMs, gridWidth, gridHeight, cameraDimensions, cameraPositions);
  const tempPath = path.join(os.tmpdir(), `solidcover_${exportId}_${Date.now()}.ass`);
  
  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated solid cover overlay: ${tempPath}`);
  
  return tempPath;
}

// ============================================
// ASS MINIMAP GENERATION
// Vector-based minimap using ASS drawings for GPU-accelerated rendering
// ============================================

/**
 * Calculate bounding box from GPS coordinates with padding
 * @param {Array} gpsPath - Array of [lat, lon] coordinates
 * @param {number} padding - Padding factor (0.1 = 10% padding)
 * @returns {{minLat, maxLat, minLon, maxLon, centerLat, centerLon}}
 */
function calculateGpsBounds(gpsPath, padding = 0.15) {
  if (!gpsPath || gpsPath.length === 0) {
    return { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1, centerLat: 0.5, centerLon: 0.5 };
  }
  
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  
  for (const [lat, lon] of gpsPath) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  
  // Add padding
  const latRange = maxLat - minLat || 0.001;
  const lonRange = maxLon - minLon || 0.001;
  const latPad = latRange * padding;
  const lonPad = lonRange * padding;
  
  minLat -= latPad;
  maxLat += latPad;
  minLon -= lonPad;
  maxLon += lonPad;
  
  return {
    minLat,
    maxLat,
    minLon,
    maxLon,
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2
  };
}

/**
 * Convert GPS coordinate to pixel position within minimap
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {Object} bounds - GPS bounds from calculateGpsBounds
 * @param {number} mapSize - Minimap size in pixels (square)
 * @param {number} mapX - Minimap X offset in video
 * @param {number} mapY - Minimap Y offset in video
 * @returns {{x: number, y: number}}
 */
function gpsToPixel(lat, lon, bounds, mapSize, mapX, mapY) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  
  // Normalize to 0-1 range
  const normalX = (lon - minLon) / (maxLon - minLon || 1);
  const normalY = 1 - (lat - minLat) / (maxLat - minLat || 1); // Flip Y (lat increases north)
  
  // Apply margin inside the minimap (10% on each side)
  const margin = mapSize * 0.1;
  const usableSize = mapSize - margin * 2;
  
  return {
    x: Math.round(mapX + margin + normalX * usableSize),
    y: Math.round(mapY + margin + normalY * usableSize)
  };
}

/**
 * Generate ASS header for minimap overlay
 * @param {number} playResX - Video width
 * @param {number} playResY - Video height
 * @returns {string} ASS header
 */
function generateMinimapAssHeader(playResX, playResY) {
  return `[Script Info]
Title: GPS Minimap Overlay
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: MinimapBg,Arial,20,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: MinimapPath,Arial,20,&H00FF7200,&H00FF7200,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: MinimapMarker,Arial,20,&H000048FF,&H000048FF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Calculate minimap position and size based on options
 * @param {number} playResX - Video width
 * @param {number} playResY - Video height
 * @param {string} position - Position: 'top-right', 'top-left', 'bottom-right', 'bottom-left'
 * @param {string} sizeOption - Size: 'small', 'medium', 'large', 'xlarge'
 * @returns {{mapX, mapY, mapSize, margin}}
 */
function calculateMinimapLayout(playResX, playResY, position, sizeOption) {
  const sizeMultipliers = {
    'small': 0.20,
    'medium': 0.28,
    'large': 0.35,
    'xlarge': 0.42
  };
  const multiplier = sizeMultipliers[sizeOption] || 0.20;
  
  // Square minimap based on smaller dimension
  const baseSize = Math.min(playResX, playResY);
  const mapSize = Math.round(baseSize * multiplier);
  const margin = Math.round(Math.min(playResX, playResY) * 0.02); // 2% margin from edge
  
  let mapX, mapY;
  
  switch (position) {
    case 'top-left':
      mapX = margin;
      mapY = margin;
      break;
    case 'top-right':
      mapX = playResX - mapSize - margin;
      mapY = margin;
      break;
    case 'bottom-left':
      mapX = margin;
      mapY = playResY - mapSize - margin;
      break;
    case 'bottom-right':
      mapX = playResX - mapSize - margin;
      mapY = playResY - mapSize - margin;
      break;
    default:
      mapX = playResX - mapSize - margin;
      mapY = margin;
  }
  
  return { mapX, mapY, mapSize, margin };
}

/**
 * Generate ASS events for minimap background panel with grid
 * @param {number} mapX - Minimap X position
 * @param {number} mapY - Minimap Y position
 * @param {number} mapSize - Minimap size
 * @param {number} durationMs - Total duration in ms
 * @returns {string} ASS dialogue lines for background and grid
 */
function generateMinimapBackground(mapX, mapY, mapSize, durationMs) {
  const startTime = formatAssTime(0);
  const endTime = formatAssTime(durationMs);
  const cornerRadius = Math.round(mapSize * 0.05);
  
  const r = cornerRadius;
  const left = mapX;
  const top = mapY;
  const right = mapX + mapSize;
  const bottom = mapY + mapSize;
  
  // Rounded rectangle with semi-transparent dark fill
  const bgPath = 
    `m ${left + r} ${top} ` +
    `l ${right - r} ${top} ` +
    `b ${right} ${top} ${right} ${top + r} ${right} ${top + r} ` +
    `l ${right} ${bottom - r} ` +
    `b ${right} ${bottom} ${right - r} ${bottom} ${right - r} ${bottom} ` +
    `l ${left + r} ${bottom} ` +
    `b ${left} ${bottom} ${left} ${bottom - r} ${left} ${bottom - r} ` +
    `l ${left} ${top + r} ` +
    `b ${left} ${top} ${left + r} ${top} ${left + r} ${top}`;
  
  const events = [];
  
  // Main background
  events.push(`Dialogue: 0,${startTime},${endTime},MinimapBg,,0,0,0,,{\\an7\\pos(0,0)\\bord1\\shad0\\1c&H282828&\\3c&H404040&\\1a&H20&\\p1}${bgPath}{\\p0}`);
  
  // Add subtle grid lines for schematic appearance
  const gridSpacing = Math.round(mapSize / 5);
  const gridLineWidth = 1;
  let gridPath = '';
  
  // Vertical grid lines
  for (let x = left + gridSpacing; x < right; x += gridSpacing) {
    gridPath += `m ${x} ${top + r} l ${x} ${bottom - r} `;
  }
  
  // Horizontal grid lines  
  for (let y = top + gridSpacing; y < bottom; y += gridSpacing) {
    gridPath += `m ${left + r} ${y} l ${right - r} ${y} `;
  }
  
  // Draw grid as thin lines (using small rectangles for visibility)
  if (gridPath) {
    // Convert line paths to thin rectangles for ASS
    let gridRects = '';
    for (let x = left + gridSpacing; x < right; x += gridSpacing) {
      gridRects += `m ${x} ${top + r} l ${x + gridLineWidth} ${top + r} l ${x + gridLineWidth} ${bottom - r} l ${x} ${bottom - r} `;
    }
    for (let y = top + gridSpacing; y < bottom; y += gridSpacing) {
      gridRects += `m ${left + r} ${y} l ${right - r} ${y} l ${right - r} ${y + gridLineWidth} l ${left + r} ${y + gridLineWidth} `;
    }
    events.push(`Dialogue: 0,${startTime},${endTime},MinimapBg,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H383838&\\1a&H60&\\p1}${gridRects}{\\p0}`);
  }
  
  return events.join('\n');
}

/**
 * Generate ASS drawing for route path as proper stroked line segments
 * ASS fills shapes, so we draw thin rectangles for each line segment to simulate a stroke
 * @param {Array} gpsPath - Array of [lat, lon] coordinates
 * @param {Object} bounds - GPS bounds
 * @param {number} mapSize - Minimap size
 * @param {number} mapX - Minimap X offset
 * @param {number} mapY - Minimap Y offset
 * @param {number} durationMs - Total duration in ms
 * @returns {string} ASS dialogue lines for route path segments
 */
function generateMinimapRoutePath(gpsPath, bounds, mapSize, mapX, mapY, durationMs) {
  if (!gpsPath || gpsPath.length < 2) return '';
  
  const startTime = formatAssTime(0);
  const endTime = formatAssTime(durationMs);
  
  // Convert all GPS points to pixel coordinates
  const points = gpsPath.map(([lat, lon]) => gpsToPixel(lat, lon, bounds, mapSize, mapX, mapY));
  
  // Downsample points to reduce complexity (keep every Nth point)
  const maxPoints = 200;
  let sampledPoints = points;
  if (points.length > maxPoints) {
    const step = Math.ceil(points.length / maxPoints);
    sampledPoints = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  }
  
  // Line thickness based on map size
  const strokeWidth = Math.max(2, Math.round(mapSize / 100));
  
  // Build path as a series of thin filled rectangles (stroke segments)
  // For each segment, create a quadrilateral perpendicular to the line direction
  let pathStr = '';
  
  for (let i = 0; i < sampledPoints.length - 1; i++) {
    const p1 = sampledPoints[i];
    const p2 = sampledPoints[i + 1];
    
    // Calculate direction vector
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len < 0.5) continue; // Skip tiny segments
    
    // Perpendicular unit vector for stroke width
    const px = (-dy / len) * strokeWidth / 2;
    const py = (dx / len) * strokeWidth / 2;
    
    // Four corners of the line segment rectangle
    const x1 = Math.round(p1.x + px);
    const y1 = Math.round(p1.y + py);
    const x2 = Math.round(p1.x - px);
    const y2 = Math.round(p1.y - py);
    const x3 = Math.round(p2.x - px);
    const y3 = Math.round(p2.y - py);
    const x4 = Math.round(p2.x + px);
    const y4 = Math.round(p2.y + py);
    
    // Draw as filled quadrilateral
    pathStr += `m ${x1} ${y1} l ${x2} ${y2} l ${x3} ${y3} l ${x4} ${y4} `;
  }
  
  // Add circles at start and end points for rounded caps
  const capRadius = strokeWidth;
  const startPt = sampledPoints[0];
  const endPt = sampledPoints[sampledPoints.length - 1];
  
  // Simple circle approximation using bezier curves
  const circleAt = (cx, cy, r) => {
    const k = 0.552284749831; // Bezier circle constant
    return `m ${cx} ${cy - r} ` +
           `b ${cx + r*k} ${cy - r} ${cx + r} ${cy - r*k} ${cx + r} ${cy} ` +
           `b ${cx + r} ${cy + r*k} ${cx + r*k} ${cy + r} ${cx} ${cy + r} ` +
           `b ${cx - r*k} ${cy + r} ${cx - r} ${cy + r*k} ${cx - r} ${cy} ` +
           `b ${cx - r} ${cy - r*k} ${cx - r*k} ${cy - r} ${cx} ${cy - r} `;
  };
  
  pathStr += circleAt(startPt.x, startPt.y, capRadius);
  pathStr += circleAt(endPt.x, endPt.y, capRadius);
  
  // Route line with blue color
  return `Dialogue: 1,${startTime},${endTime},MinimapPath,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HFF7200&\\p1}${pathStr}{\\p0}`;
}

/**
 * Generate ASS arrow marker path (direction indicator)
 * Creates a small, clean navigation arrow pointing up, centered at (0,0)
 * @param {number} scale - Scale factor
 * @returns {string} ASS drawing path for arrow
 */
function generateArrowPath(scale = 1) {
  const s = scale;
  // Simple triangular navigation arrow (like Google Maps)
  // Smaller and cleaner design
  return `m 0 ${Math.round(-8*s)} l ${Math.round(5*s)} ${Math.round(8*s)} l ${Math.round(-5*s)} ${Math.round(4*s)} l ${Math.round(-5*s)} ${Math.round(-4*s)} l ${Math.round(5*s)} ${Math.round(-8*s)}`;
}

/**
 * Generate ASS events for position markers throughout the video
 * @param {Array} seiData - Array of {timestampMs, sei} objects with GPS data
 * @param {Array} gpsPath - Array of [lat, lon] for bounds calculation
 * @param {Object} bounds - GPS bounds
 * @param {number} mapSize - Minimap size
 * @param {number} mapX - Minimap X offset
 * @param {number} mapY - Minimap Y offset
 * @param {number} startTimeMs - Start time in ms
 * @param {number} endTimeMs - End time in ms
 * @returns {string} ASS dialogue lines for position markers
 */
function generateMinimapMarkers(seiData, gpsPath, bounds, mapSize, mapX, mapY, startTimeMs, endTimeMs) {
  if (!seiData || seiData.length === 0) return '';
  
  const events = [];
  // Smaller scale for the arrow marker
  const markerScale = Math.max(0.8, mapSize / 250);
  
  // Group consecutive frames with same position to reduce ASS events
  let prevState = null;
  let eventStartMs = 0; // Start from 0 (relative to export start)
  
  for (let i = 0; i < seiData.length; i++) {
    const { timestampMs, sei } = seiData[i];
    
    // Get GPS coordinates
    const lat = sei?.latitude_deg ?? sei?.latitudeDeg ?? 0;
    const lon = sei?.longitude_deg ?? sei?.longitudeDeg ?? 0;
    const heading = sei?.heading_deg ?? sei?.headingDeg ?? 0;
    
    // Skip invalid coordinates
    if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) continue;
    
    // Convert to pixel position
    const pos = gpsToPixel(lat, lon, bounds, mapSize, mapX, mapY);
    
    // Round heading to reduce event count (5 degree increments)
    const roundedHeading = Math.round(heading / 5) * 5;
    
    // Create state signature
    const currentState = `${pos.x},${pos.y},${roundedHeading}`;
    
    // Calculate relative time from export start
    const relativeTimeMs = timestampMs - startTimeMs;
    
    if (currentState !== prevState) {
      // Emit previous event if exists
      if (prevState !== null && eventStartMs < relativeTimeMs) {
        const [px, py, ph] = prevState.split(',').map(Number);
        const startAssTime = formatAssTime(Math.max(0, eventStartMs));
        const endAssTime = formatAssTime(Math.max(0, relativeTimeMs));
        
        // Red arrow with white border, rotated to heading direction
        // Color: &H0000FF& = pure red in BGR format
        events.push(`Dialogue: 2,${startAssTime},${endAssTime},MinimapMarker,,0,0,0,,{\\an5\\pos(${px},${py})\\org(${px},${py})\\frz${-ph}\\bord2\\shad1\\1c&H0000FF&\\3c&HFFFFFF&\\4c&H000000&\\p1}${generateArrowPath(markerScale)}{\\p0}`);
      }
      
      prevState = currentState;
      eventStartMs = relativeTimeMs;
    }
  }
  
  // Emit final event
  if (prevState !== null) {
    const [px, py, ph] = prevState.split(',').map(Number);
    const startAssTime = formatAssTime(Math.max(0, eventStartMs));
    const endAssTime = formatAssTime(Math.max(0, endTimeMs - startTimeMs));
    
    // Red arrow with white border
    events.push(`Dialogue: 2,${startAssTime},${endAssTime},MinimapMarker,,0,0,0,,{\\an5\\pos(${px},${py})\\org(${px},${py})\\frz${-ph}\\bord2\\shad1\\1c&H0000FF&\\3c&HFFFFFF&\\4c&H000000&\\p1}${generateArrowPath(markerScale)}{\\p0}`);
  }
  
  return events.join('\n');
}

/**
 * Generate complete ASS file for minimap overlay
 * @param {Array} seiData - Array of {timestampMs, sei} objects with GPS data
 * @param {Array} mapPath - Array of [lat, lon] coordinates for route display
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Options including playResX, playResY, position, size
 * @returns {string} Complete ASS file content
 */
function generateMinimapAss(seiData, mapPath, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    playResY = 1080,
    position = 'top-right',
    size = 'small',
    // For standalone mode (overlaying on map image), set these:
    standaloneMode = false,  // If true, generates ASS for a standalone minimap image
    standaloneSize = 256,    // Size of the standalone minimap
    customBounds = null,     // Custom GPS bounds (e.g., from map tiles)
    includeBackground = true // Whether to include the dark background
  } = options;
  
  const durationMs = endTimeMs - startTimeMs;
  
  let mapX, mapY, mapSize;
  
  if (standaloneMode) {
    // Standalone mode: ASS coordinates are 0,0 to standaloneSize,standaloneSize
    mapX = 0;
    mapY = 0;
    mapSize = standaloneSize;
  } else {
    // Normal mode: Calculate position within video frame
    const layout = calculateMinimapLayout(playResX, playResY, position, size);
    mapX = layout.mapX;
    mapY = layout.mapY;
    mapSize = layout.mapSize;
  }
  
  // Use custom bounds if provided (e.g., from map tile boundaries), otherwise calculate from path
  const bounds = customBounds || calculateGpsBounds(mapPath);
  
  // Generate header with appropriate resolution
  const headerResX = standaloneMode ? standaloneSize : playResX;
  const headerResY = standaloneMode ? standaloneSize : playResY;
  let assContent = generateMinimapAssHeader(headerResX, headerResY);
  
  // Generate background panel (skip in standalone mode if we have a map image background)
  if (includeBackground) {
    assContent += generateMinimapBackground(mapX, mapY, mapSize, durationMs) + '\n';
  }
  
  // Generate route path
  const routePath = generateMinimapRoutePath(mapPath, bounds, mapSize, mapX, mapY, durationMs);
  if (routePath) {
    assContent += routePath + '\n';
  }
  
  // Generate position markers
  const markers = generateMinimapMarkers(seiData, mapPath, bounds, mapSize, mapX, mapY, startTimeMs, endTimeMs);
  if (markers) {
    assContent += markers + '\n';
  }
  
  return assContent;
}

/**
 * Write minimap ASS file to temp directory
 * @param {string} exportId - Export ID for unique filename
 * @param {Array} seiData - SEI telemetry data with GPS
 * @param {Array} mapPath - GPS path coordinates
 * @param {number} startTimeMs - Start time in ms
 * @param {number} endTimeMs - End time in ms
 * @param {Object} options - Export options
 * @returns {Promise<string>} Path to generated ASS file
 */
async function writeMinimapAss(exportId, seiData, mapPath, startTimeMs, endTimeMs, options) {
  const assContent = generateMinimapAss(seiData, mapPath, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `minimap_${exportId}_${Date.now()}.ass`);
  
  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated minimap overlay: ${tempPath} (${mapPath?.length || 0} GPS points)`);
  
  return tempPath;
}

module.exports = {
  generateCompactDashboardAss,
  writeCompactDashboardAss,
  cleanupAssFile,
  formatAssTime,
  COLORS,
  // Solid cover exports
  generateSolidCoverAss,
  writeSolidCoverAss,
  // Minimap exports (ASS-based)
  generateMinimapAss,
  writeMinimapAss
};
