import type { DesignConfig } from '../shared/types';

export const bodyShapes = [
  'square',
  'mosaic',
  'dot',
  'circle',
  'circle-zebra',
  'circle-zebra-vertical',
  'circular',
  'edge-cut',
  'edge-cut-smooth',
  'japnese',
  'leaf',
  'pointed',
  'pointed-edge-cut',
  'pointed-in',
  'pointed-in-smooth',
  'pointed-smooth',
  'round',
  'rounded-in',
  'rounded-in-smooth',
  'rounded-pointed',
  'star',
  'diamond'
] as const;

export const eyeFrames = [
  'frame0',
  'frame1',
  'frame2',
  'frame3',
  'frame4',
  'frame5',
  'frame6',
  'frame7',
  'frame8',
  'frame10',
  'frame11',
  'frame12',
  'frame13',
  'frame14',
  'frame16'
] as const;

export const eyeBalls = [
  'ball0',
  'ball1',
  'ball2',
  'ball3',
  'ball5',
  'ball6',
  'ball7',
  'ball8',
  'ball10',
  'ball11',
  'ball12',
  'ball13',
  'ball14',
  'ball15',
  'ball16',
  'ball17',
  'ball18',
  'ball19'
] as const;

export const logoGallery = [
  'ctech-mark',
  'qrcodemonkey',
  'facebook',
  'facebook-circle',
  'twitter-circle',
  'youtube',
  'youtube-circle',
  'googleplus-circle',
  'instagram-circle',
  'linkedin-circle',
  'xing-circle',
  'pinterest-circle',
  'vimeo-circle',
  'soundcloud-circle',
  'vk-circle',
  'whatsapp-circle',
  'appstore',
  'google-play',
  'gmail',
  'calendar-circle',
  'document-circle',
  'phone-circle',
  'share-circle',
  'wifi-circle',
  'bitcoin'
] as const;

export const defaultDesignConfig: DesignConfig = {
  body: 'square',
  eye: 'frame0',
  eyeBall: 'ball0',
  erf1: [],
  erf2: [],
  erf3: [],
  brf1: [],
  brf2: [],
  brf3: [],
  bodyColor: '#000000',
  bgColor: '#ffffff',
  eye1Color: '#000000',
  eye2Color: '#000000',
  eye3Color: '#000000',
  eyeBall1Color: '#000000',
  eyeBall2Color: '#000000',
  eyeBall3Color: '#000000',
  gradientColor1: null,
  gradientColor2: null,
  gradientType: 'linear',
  gradientOnEyes: false,
  logo: null,
  logoMode: 'default'
};

export const templates: Array<{ name: string; config: DesignConfig }> = [
  { name: 'Classic', config: { ...defaultDesignConfig } },
  {
    name: 'CompleteTech',
    config: {
      ...defaultDesignConfig,
      body: 'round',
      eye: 'frame13',
      eyeBall: 'ball15',
      bodyColor: '#003A70',
      eye1Color: '#003A70',
      eye2Color: '#003A70',
      eye3Color: '#003A70',
      eyeBall1Color: '#FDB913',
      eyeBall2Color: '#FDB913',
      eyeBall3Color: '#FDB913',
      bgColor: '#F7FAFE',
      logo: '#ctech-mark'
    }
  },
  {
    name: 'Easy',
    config: {
      ...defaultDesignConfig,
      body: 'dot',
      eye: 'frame13',
      eyeBall: 'ball15',
      bodyColor: '#102A43',
      eye1Color: '#102A43',
      eye2Color: '#102A43',
      eye3Color: '#102A43'
    }
  },
  {
    name: 'Facebook',
    config: {
      ...defaultDesignConfig,
      body: 'round',
      eye: 'frame2',
      eyeBall: 'ball2',
      bodyColor: '#1877F2',
      eye1Color: '#1877F2',
      eye2Color: '#1877F2',
      eye3Color: '#1877F2',
      logo: '#facebook'
    }
  },
  {
    name: 'Twitter',
    config: {
      ...defaultDesignConfig,
      body: 'circular',
      eye: 'frame5',
      eyeBall: 'ball11',
      bodyColor: '#111111',
      eye1Color: '#111111',
      eye2Color: '#111111',
      eye3Color: '#111111',
      logo: '#twitter-circle'
    }
  },
  {
    name: 'Youtube',
    config: {
      ...defaultDesignConfig,
      body: 'circle',
      eye: 'frame13',
      eyeBall: 'ball14',
      bodyColor: '#E62117',
      eye1Color: '#E62117',
      eye2Color: '#E62117',
      eye3Color: '#E62117',
      logo: '#youtube'
    }
  },
  {
    name: 'Monkey',
    config: {
      ...defaultDesignConfig,
      body: 'mosaic',
      eye: 'frame13',
      eyeBall: 'ball15',
      bodyColor: '#6B3F1F',
      bgColor: '#FFF7ED',
      eye1Color: '#5A351C',
      eye2Color: '#5A351C',
      eye3Color: '#5A351C',
      eyeBall1Color: '#F6C57A',
      eyeBall2Color: '#F6C57A',
      eyeBall3Color: '#F6C57A',
      logo: '#qrcodemonkey'
    }
  },
  {
    name: 'Rain',
    config: {
      ...defaultDesignConfig,
      body: 'circle-zebra-vertical',
      eye: 'frame13',
      eyeBall: 'ball15',
      bodyColor: '#0B6FA4',
      gradientColor1: '#083D77',
      gradientColor2: '#2BB3F3',
      eye1Color: '#083D77',
      eye2Color: '#083D77',
      eye3Color: '#083D77',
      eyeBall1Color: '#2BB3F3',
      eyeBall2Color: '#2BB3F3',
      eyeBall3Color: '#2BB3F3'
    }
  },
  {
    name: 'Jungle',
    config: {
      ...defaultDesignConfig,
      body: 'rounded-pointed',
      eye: 'frame14',
      eyeBall: 'ball16',
      bodyColor: '#2F6B2F',
      gradientColor1: '#6FAF3A',
      gradientColor2: '#123D2A',
      gradientType: 'radial',
      eye1Color: '#123D2A',
      eye2Color: '#123D2A',
      eye3Color: '#123D2A',
      eyeBall1Color: '#6FAF3A',
      eyeBall2Color: '#6FAF3A',
      eyeBall3Color: '#6FAF3A'
    }
  },
  {
    name: 'Mosaic',
    config: {
      ...defaultDesignConfig,
      body: 'mosaic',
      eye: 'frame16',
      eyeBall: 'ball8',
      bodyColor: '#0B7285',
      gradientColor1: '#7B2CBF',
      gradientColor2: '#00A8E8',
      eye1Color: '#2F184B',
      eye2Color: '#2F184B',
      eye3Color: '#2F184B',
      eyeBall1Color: '#00A8E8',
      eyeBall2Color: '#00A8E8',
      eyeBall3Color: '#00A8E8'
    }
  },
  {
    name: 'Dot',
    config: {
      ...defaultDesignConfig,
      body: 'dot',
      eye: 'frame0',
      eyeBall: 'ball14',
      bodyColor: '#0077B6',
      eye1Color: '#023E8A',
      eye2Color: '#023E8A',
      eye3Color: '#023E8A',
      eyeBall1Color: '#0077B6',
      eyeBall2Color: '#0077B6',
      eyeBall3Color: '#0077B6'
    }
  },
  {
    name: 'Coffee',
    config: {
      ...defaultDesignConfig,
      body: 'round',
      eye: 'frame8',
      eyeBall: 'ball19',
      bgColor: '#FAEDE7',
      bodyColor: '#5B3924',
      gradientColor1: '#8A5A3C',
      gradientColor2: '#3B2A20',
      eye1Color: '#3B2A20',
      eye2Color: '#3B2A20',
      eye3Color: '#3B2A20',
      eyeBall1Color: '#B17800',
      eyeBall2Color: '#B17800',
      eyeBall3Color: '#B17800'
    }
  },
  {
    name: 'Ninja',
    config: {
      ...defaultDesignConfig,
      body: 'japnese',
      eye: 'frame12',
      eyeBall: 'ball14',
      bodyColor: '#111827',
      gradientColor1: '#111827',
      gradientColor2: '#B91C1C',
      eye1Color: '#111827',
      eye2Color: '#111827',
      eye3Color: '#111827',
      eyeBall1Color: '#B91C1C',
      eyeBall2Color: '#B91C1C',
      eyeBall3Color: '#B91C1C'
    }
  },
  {
    name: 'Bitcoin',
    config: {
      ...defaultDesignConfig,
      body: 'circle',
      eye: 'frame1',
      eyeBall: 'ball1',
      bodyColor: '#2B2B2B',
      bgColor: '#FFF8E6',
      eye1Color: '#2B2B2B',
      eye2Color: '#2B2B2B',
      eye3Color: '#2B2B2B',
      eyeBall1Color: '#F7931A',
      eyeBall2Color: '#F7931A',
      eyeBall3Color: '#F7931A',
      logo: '#bitcoin'
    }
  }
];

export function normalizeDesignConfig(input: Partial<DesignConfig> = {}): DesignConfig {
  const merged = { ...defaultDesignConfig, ...input };
  for (const key of ['bgColor', 'bodyColor', 'eye1Color', 'eye2Color', 'eye3Color', 'eyeBall1Color', 'eyeBall2Color', 'eyeBall3Color', 'gradientColor1', 'gradientColor2'] as const) {
    const color = merged[key];
    if (color && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) throw new Error('Colors must be six-digit hex values');
  }
  if (merged.logo && (typeof merged.logo !== 'string' || !/^(#[a-z0-9-]+|\/uploads\/[a-z0-9-]+\.(png|jpg|gif|svg))$/i.test(merged.logo))) {
    throw new Error('Choose a built-in logo or an uploaded image');
  }
  return {
    ...merged,
    body: bodyShapes.includes(merged.body as never) ? merged.body : defaultDesignConfig.body,
    eye: eyeFrames.includes(merged.eye as never) ? merged.eye : defaultDesignConfig.eye,
    eyeBall: eyeBalls.includes(merged.eyeBall as never) ? merged.eyeBall : defaultDesignConfig.eyeBall,
    gradientType: merged.gradientType === 'radial' ? 'radial' : 'linear',
    logoMode: merged.logoMode === 'clean' ? 'clean' : 'default'
  };
}
