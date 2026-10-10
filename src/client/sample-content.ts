// Sample defaults shown in the QR Studio builder. Users replace with real URLs/assets when creating actual QR codes.
import type { ContentType } from '../shared/types';

export const sampleContent: Record<ContentType, Record<string, unknown>> = {
  url: { url: 'https://example.com' },
  text: { text: 'QR Code Toolkit' },
  email: { email: 'hello@example.com', subject: 'Hello', message: 'Sent from a QR code' },
  phone: { phone: '+15555550100' },
  sms: { phone: '+15555550100', message: 'Hello' },
  vcard: { version: '3.0', firstName: 'Alex', lastName: 'Example', organization: 'Example Organization', email: 'hello@example.com', url: 'https://example.com' },
  mecard: { firstName: 'Alex', lastName: 'Example', phone1: '+15555550100', email: 'hello@example.com', url: 'https://example.com' },
  maps: { latitude: 40.7128, longitude: -74.006 },
  facebook: { mode: 'url', url: 'https://facebook.com' },
  twitter: { mode: 'url', url: 'https://twitter.com' },
  youtube: { url: 'https://youtube.com' },
  wifi: { ssid: 'example-guest', password: 'change-me', encryption: 'WPA' },
  event: { title: 'Launch', location: 'Online', start: new Date().toISOString(), end: new Date(Date.now() + 3600000).toISOString() },
  crypto: { currency: 'bitcoin', address: '', amount: 0.001 },
  // Replace url with your hosted asset before publishing the QR.
  mp3: { title: 'Audio drop', url: 'https://example.com/samples/audio-drop.mp3', description: 'Audio landing page' },
  // Replace url with your hosted asset before publishing the QR.
  video: { title: 'Video drop', url: 'https://example.com/samples/video-drop.mp4', description: 'Video landing page' },
  // Replace url with your hosted asset before publishing the QR.
  pdf: { title: 'Document', url: 'https://example.com/samples/document.pdf', description: 'PDF landing page' },
  social: { title: 'Social links', links: [{ label: 'Website', url: 'https://example.com' }] },
  app: { title: 'App links', iosUrl: 'https://apple.com/app-store', androidUrl: 'https://play.google.com', fallbackUrl: 'https://example.com' },
  gallery: {
    title: 'Gallery',
    images: [
      { url: '/samples/gallery-1.svg', caption: 'Field artifact #001 — generator preview' },
      { url: '/samples/gallery-2.svg', caption: 'QR specimen study' },
      { url: '/samples/gallery-3.svg', caption: 'Live ledger — scan trace' }
    ]
  },
  rating: { title: 'Rate us', question: 'How was your visit?' },
  feedback: { title: 'Feedback', prompt: 'Tell us what worked.' }
};
