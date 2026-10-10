/**
 * Brand and category SVG glyphs for the QR logo gallery.
 *
 * Each entry's `body` is the inner SVG markup normalized to a 100x100
 * viewBox so the renderer can scale it consistently. Paths are simplified,
 * monochrome glyphs sourced or hand-traced from public-domain icon
 * vocabularies (Simple Icons, Font Awesome free, Lucide). The renderer
 * places these on top of a colored circular badge using `bg` and `fg`.
 */

export interface LogoIcon {
  /** SVG path data, normalized to a 100x100 viewBox. May be multiple <path>s joined as raw inner SVG. */
  body: string;
  /** Background color for the circular badge behind the icon. */
  bg: string;
  /** Foreground (icon) color. */
  fg: string;
}

const NAVY = '#003A70';
const PAPER = '#F7FAFE';
const GOLD = '#FDB913';

export const logoIcons: Record<string, LogoIcon> = {
  // CompleteTech "default" mark — compact CT monogram tuned for tiny QR centers.
  'ctech-mark': {
    bg: NAVY,
    fg: GOLD,
    body:
      '<path d="M38 24c-16 0-28 11-28 26s12 26 28 26c8 0 15-3 20-8l-8-9c-3 3-7 5-12 5-9 0-16-6-16-14s7-14 16-14c5 0 9 2 12 5l8-9c-5-5-12-8-20-8z"/>' +
      '<path d="M54 24h38v12H79v40H66V36H54V24z"/>' +
      '<rect x="13" y="78" width="74" height="5" rx="2.5" opacity=".35"/>'
  },

  // QRCode Monkey-inspired monkey head, replacing the previous QR tile placeholder.
  qrcodemonkey: {
    bg: '#7A4A24',
    fg: '#F6C57A',
    body:
      '<circle cx="21" cy="47" r="15" fill="#5A351C"/>' +
      '<circle cx="79" cy="47" r="15" fill="#5A351C"/>' +
      '<circle cx="50" cy="48" r="31" fill="#5A351C"/>' +
      '<path d="M29 50c0-13 9-23 21-23s21 10 21 23c0 15-9 26-21 26S29 65 29 50z"/>' +
      '<circle cx="38" cy="45" r="5" fill="#2A170D"/>' +
      '<circle cx="62" cy="45" r="5" fill="#2A170D"/>' +
      '<path d="M41 61c5 4 13 4 18 0" fill="none" stroke="#2A170D" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M46 52h8l-4 5z" fill="#2A170D"/>'
  },

  // Facebook "f" with closer Meta-era proportions.
  facebook: {
    bg: '#1877F2',
    fg: '#FFFFFF',
    body:
      '<path d="M59 92V56h12l2-14H59v-9c0-4 2-7 7-7h8V13c-4-1-8-1-13-1-13 0-22 8-22 22v8H27v14h12v36h20z"/>'
  },
  'facebook-circle': {
    bg: '#1877F2',
    fg: '#FFFFFF',
    body:
      '<path d="M59 90V57h11l2-13H59v-9c0-4 2-6 7-6h7V17c-3 0-7-1-12-1-12 0-20 7-20 21v7H30v13h11v33h18z"/>'
  },

  // Twitter / X — current X glyph.
  'twitter-circle': {
    bg: '#000000',
    fg: '#FFFFFF',
    body:
      '<path d="M21 20h18l15 21 18-21h8L58 47l25 33H65L49 58 30 80h-9l24-28L21 20zm14 7 34 46h6L41 27h-6z"/>'
  },

  // YouTube rounded rectangle + play cutout.
  youtube: {
    bg: '#FF0000',
    fg: '#FFFFFF',
    body:
      '<path fill-rule="evenodd" d="M91 30c-1-5-5-9-10-10-8-2-31-2-31-2s-23 0-31 2c-5 1-9 5-10 10-2 8-2 20-2 20s0 12 2 20c1 5 5 9 10 10 8 2 31 2 31 2s23 0 31-2c5-1 9-5 10-10 2-8 2-20 2-20s0-12-2-20zM42 64V36l25 14-25 14z"/>'
  },
  'youtube-circle': {
    bg: '#FF0000',
    fg: '#FFFFFF',
    body:
      '<path d="M30 32c13-2 27-2 40 0 4 1 7 4 8 8 1 7 1 13 0 20-1 4-4 7-8 8-13 2-27 2-40 0-4-1-7-4-8-8-1-7-1-13 0-20 1-4 4-7 8-8z"/>' +
      '<path d="M44 64V36l24 14-24 14z" fill="#FF0000"/>'
  },

  // Legacy Google+ circle.
  'googleplus-circle': {
    bg: '#DD4B39',
    fg: '#FFFFFF',
    body:
      '<path d="M44 46v10h14c-2 8-8 13-17 13-10 0-19-8-19-19s9-19 19-19c5 0 9 2 12 5l8-8c-5-5-12-8-20-8-17 0-31 13-31 30s14 30 31 30c18 0 30-12 30-30 0-1 0-3-1-4H44z"/>' +
      '<path d="M83 43V31h-8v12H63v8h12v12h8V51h12v-8H83z"/>'
  },

  // Instagram camera in the current app-glyph style.
  'instagram-circle': {
    bg: '#C13584',
    fg: '#FFFFFF',
    body:
      '<defs><radialGradient id="ig" cx="30%" cy="100%" r="95%"><stop offset="0" stop-color="#FEDA75"/><stop offset=".35" stop-color="#FA7E1E"/><stop offset=".62" stop-color="#D62976"/><stop offset="1" stop-color="#4F5BD5"/></radialGradient></defs>' +
      '<circle cx="50" cy="50" r="49" fill="url(#ig)"/>' +
      '<rect x="24" y="24" width="52" height="52" rx="15" fill="none" stroke="#FFFFFF" stroke-width="6"/>' +
      '<circle cx="50" cy="50" r="13" fill="none" stroke="#FFFFFF" stroke-width="6"/>' +
      '<circle cx="66" cy="34" r="4"/>'
  },

  // LinkedIn "in"
  'linkedin-circle': {
    bg: '#0A66C2',
    fg: '#FFFFFF',
    body:
      '<rect x="24" y="39" width="12" height="37"/>' +
      '<circle cx="30" cy="28" r="7"/>' +
      '<path d="M44 39h12v5c3-4 7-6 13-6 11 0 17 7 17 20v18H74V60c0-7-3-11-8-11-6 0-9 4-9 11v16H44V39z"/>'
  },

  // Xing — stylized "X"
  'xing-circle': {
    bg: '#026466',
    fg: '#FFFFFF',
    body:
      '<path d="M25 31h13c1 0 2 1 3 3l8 14-13 23c-1 2-2 3-4 3H20l14-25-9-18z"/>' +
      '<path d="M69 17h13L59 56l14 27H60L46 56l23-39z"/>'
  },

  // Pinterest "P"
  'pinterest-circle': {
    bg: '#E60023',
    fg: '#FFFFFF',
    body:
      '<path d="M50 16c-19 0-31 13-31 28 0 10 5 17 13 20 1 0 2-1 2-2l2-6c0-1 0-2-1-3-3-3-4-6-4-10 0-10 8-18 20-18 11 0 17 7 17 16 0 12-5 21-13 21-5 0-8-4-7-8l4-15c1-4-1-8-5-8-5 0-9 5-9 12 0 4 1 7 1 7l-7 29c-1 6-1 12 0 17 0 1 2 1 2 0 2-3 7-10 9-16l3-12c2 4 6 6 11 6 15 0 25-13 25-30 0-15-13-26-32-26z"/>'
  },

  // Vimeo "v"
  'vimeo-circle': {
    bg: '#1AB7EA',
    fg: '#FFFFFF',
    body:
      '<path d="M83 37c-1 8-6 18-16 31-9 12-17 18-23 18-5 0-9-4-12-13l-5-18c-2-6-4-9-6-9-1 0-3 1-6 3l-4-6c4-4 8-7 12-10 5-4 8-6 10-6 5 0 8 4 10 13l3 16c1 6 3 9 5 9 2 0 5-3 8-8 3-4 4-8 4-10 0-4-2-6-6-6-2 0-4 0-7 1 4-13 12-20 23-20 8 0 12 5 10 15z"/>'
  },

  // SoundCloud — three bars rising like waveform
  'soundcloud-circle': {
    bg: '#FF7700',
    fg: '#FFFFFF',
    body:
      '<rect x="16" y="54" width="4" height="15" rx="2"/>' +
      '<rect x="24" y="48" width="4" height="21" rx="2"/>' +
      '<rect x="32" y="42" width="4" height="27" rx="2"/>' +
      '<rect x="40" y="36" width="4" height="33" rx="2"/>' +
      '<path d="M51 34c-2 0-3 1-3 3v32h31c6 0 11-5 11-11s-5-11-11-11h-2c-3-8-11-13-20-13h-6z"/>'
  },

  // VK
  'vk-circle': {
    bg: '#0077FF',
    fg: '#FFFFFF',
    body:
      '<path d="M54 72c-19 0-31-13-32-35h10c1 15 7 22 14 24V37h9v14c7-1 12-8 14-14h10c-2 8-8 15-14 19 7 4 13 10 16 16H70c-3-6-8-10-15-12v12h-1z"/>'
  },

  // WhatsApp — phone in chat bubble (simplified)
  'whatsapp-circle': {
    bg: '#25D366',
    fg: '#FFFFFF',
    body:
      '<path fill-rule="evenodd" d="M50 15c-19 0-34 15-34 34 0 6 2 12 5 17l-5 19 20-5c4 2 9 3 14 3 19 0 34-15 34-34S69 15 50 15zm0 61c-5 0-9-1-13-4l-2-1-11 3 3-11-1-2c-3-4-4-8-4-13 0-15 13-27 28-27s28 12 28 27-13 28-28 28zm15-20c-1-1-5-3-6-3s-2 0-2 1l-3 3c-1 1-1 1-3 0-5-2-10-6-13-12-1-1 0-2 1-2l2-2c0-1 1-2 0-3l-3-6c-1-2-2-2-3-2h-3c-1 0-3 2-4 4s-2 6 1 10c3 6 10 16 23 20 8 3 13 2 16 0 2-2 3-5 3-7 0 0-1-1-2-1z"/>'
  },

  // Apple App Store — three-stroke A.
  appstore: {
    bg: '#0D96F6',
    fg: '#FFFFFF',
    body:
      '<path d="M34 69h-9c-4 0-6-3-5-6 1-3 3-5 6-5h14l16-28c2-4 6-5 9-3 3 2 4 6 2 9L48 69H34z"/>' +
      '<path d="M66 69H53l7-12h14c4 0 6 3 5 6-1 3-4 6-7 6h-6z"/>' +
      '<path d="M35 30c2-4 6-5 9-3 3 2 4 6 2 9L28 68c-2 4-6 5-9 3-3-2-4-6-2-9l18-32z"/>' +
      '<path d="M43 54h14l-7 12H36l7-12z"/>'
  },

  // Google Play multi-color triangle.
  'google-play': {
    bg: '#F7FAFE',
    fg: '#FFFFFF',
    body:
      '<circle cx="50" cy="50" r="47" fill="#FFFFFF" stroke="#C9D9EA" stroke-width="3"/>' +
      '<path d="M22 13c-2 1-3 3-3 6v62c0 3 1 5 3 6l35-37L22 13z" fill="#00A173"/>' +
      '<path d="M57 50 22 13c2-1 4-1 7 1l43 24-15 12z" fill="#00C7F2"/>' +
      '<path d="M57 50 22 87c2 1 4 1 7-1l43-24-15-12z" fill="#FFCE00"/>' +
      '<path d="M72 38 57 50l15 12 5-3c5-3 5-15 0-18l-5-3z" fill="#FF3D00"/>'
  },

  // Gmail M-envelope.
  gmail: {
    bg: '#F7FAFE',
    fg: '#EA4335',
    body:
      '<circle cx="50" cy="50" r="47" fill="#FFFFFF" stroke="#C9D9EA" stroke-width="3"/>' +
      '<rect x="14" y="25" width="72" height="50" rx="7" fill="#FFFFFF"/>' +
      '<path d="M22 35v33h12V44l16 13 16-13v24h12V35L50 57 22 35z" fill="#EA4335"/>' +
      '<path d="M22 35 50 57 78 35c-1-6-7-8-12-4L50 43 34 31c-5-4-11-2-12 4z" fill="#FBBC04"/>' +
      '<path d="M22 35v33h12V44L22 35z" fill="#34A853"/>' +
      '<path d="M78 35v33H66V44l12-9z" fill="#4285F4"/>'
  },

  // Calendar
  'calendar-circle': {
    bg: NAVY,
    fg: PAPER,
    body:
      '<rect x="21" y="24" width="58" height="55" rx="6" fill="' + PAPER + '"/>' +
      '<rect x="21" y="24" width="58" height="17" rx="6" fill="' + GOLD + '"/>' +
      '<rect x="31" y="17" width="7" height="16" rx="3" fill="' + PAPER + '"/>' +
      '<rect x="62" y="17" width="7" height="16" rx="3" fill="' + PAPER + '"/>' +
      '<rect x="31" y="49" width="8" height="7" fill="' + NAVY + '"/>' +
      '<rect x="46" y="49" width="8" height="7" fill="' + NAVY + '"/>' +
      '<rect x="61" y="49" width="8" height="7" fill="' + NAVY + '"/>' +
      '<rect x="31" y="63" width="8" height="7" fill="' + NAVY + '"/>' +
      '<rect x="46" y="63" width="8" height="7" fill="' + NAVY + '"/>' +
      '<rect x="61" y="63" width="8" height="7" fill="' + NAVY + '"/>'
  },

  // Document with corner fold
  'document-circle': {
    bg: NAVY,
    fg: PAPER,
    body:
      '<path d="M30 18h28l16 16v44c0 3-2 6-6 6H30c-4 0-6-3-6-6V24c0-3 2-6 6-6z" fill="' + PAPER + '"/>' +
      '<path d="M58 18v13c0 3 2 5 5 5h11L58 18z" fill="#C9D9EA"/>' +
      '<rect x="32" y="45" width="35" height="5" rx="1" fill="' + NAVY + '"/>' +
      '<rect x="32" y="56" width="35" height="5" rx="1" fill="' + NAVY + '"/>' +
      '<rect x="32" y="67" width="25" height="5" rx="1" fill="' + NAVY + '"/>'
  },

  // Phone receiver
  'phone-circle': {
    bg: NAVY,
    fg: PAPER,
    body:
      '<path d="M31 19c-5 0-10 5-10 10 0 27 23 50 50 50 5 0 10-5 10-10v-8c0-3-2-5-5-6l-13-3c-3-1-5 0-7 3l-4 6c-9-4-16-11-20-20l6-4c3-2 4-4 3-7l-3-13c-1-3-3-5-6-5h-1z" fill="' + PAPER + '"/>' +
      '<path d="M36 42c5 9 12 16 21 21" fill="none" stroke="' + NAVY + '" stroke-width="5" stroke-linecap="round"/>'
  },

  // Share — three nodes connected
  'share-circle': {
    bg: NAVY,
    fg: PAPER,
    body:
      '<path d="M34 48 64 30M34 52l30 18" fill="none" stroke="' + PAPER + '" stroke-width="6" stroke-linecap="round"/>' +
      '<circle cx="68" cy="28" r="10" fill="' + PAPER + '"/>' +
      '<circle cx="28" cy="50" r="10" fill="' + PAPER + '"/>' +
      '<circle cx="68" cy="72" r="10" fill="' + PAPER + '"/>'
  },

  // Wifi — three arcs above a dot
  'wifi-circle': {
    bg: NAVY,
    fg: PAPER,
    body:
      '<path d="M18 43c18-17 46-17 64 0" fill="none" stroke="' + PAPER + '" stroke-width="7" stroke-linecap="round"/>' +
      '<path d="M30 55c11-10 29-10 40 0" fill="none" stroke="' + PAPER + '" stroke-width="7" stroke-linecap="round"/>' +
      '<path d="M41 66c5-4 13-4 18 0" fill="none" stroke="' + PAPER + '" stroke-width="7" stroke-linecap="round"/>' +
      '<circle cx="50" cy="77" r="5" fill="' + PAPER + '"/>'
  },

  // Bitcoin — circle with stylized "B"
  bitcoin: {
    bg: '#F7931A',
    fg: '#FFFFFF',
    body:
      '<path d="M62 46c6-2 9-6 8-12-1-7-6-11-15-12v-9h-6v9h-5v-9h-6v9H27v7h4c3 0 4 2 4 4v34c0 2-1 4-4 4h-4v7h11v9h6v-9h5v9h6v-9c10-1 16-6 17-14 1-8-3-13-10-15v-3zm-17-16h7c5 0 8 2 8 6s-3 6-8 6h-7V30zm8 40h-8V52h8c6 0 9 3 9 8s-3 10-9 10z"/>'
  }
};

export function getLogoIcon(name: string): LogoIcon | undefined {
  return logoIcons[name];
}
