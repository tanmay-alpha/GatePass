import { z } from 'zod';
import type { ContentType } from '../shared/types';

const optionalString = z.string().optional().default('');
const httpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'URL must use http or https');

export const payloadSchemas = {
  url: z.object({ url: httpUrl }),
  text: z.object({ text: z.string().min(1).max(400) }),
  email: z.object({ email: z.string().email(), subject: optionalString, message: optionalString }),
  phone: z.object({ phone: z.string().min(1) }),
  sms: z.object({ phone: z.string().min(1), message: optionalString }),
  vcard: z.object({
    version: z.enum(['2.1', '3.0']).optional().default('3.0'),
    firstName: optionalString,
    lastName: optionalString,
    organization: optionalString,
    title: optionalString,
    phoneWork: optionalString,
    phonePrivate: optionalString,
    phoneMobile: optionalString,
    faxWork: optionalString,
    faxPrivate: optionalString,
    email: optionalString,
    url: optionalString,
    street: optionalString,
    zipcode: optionalString,
    city: optionalString,
    state: optionalString,
    country: optionalString
  }),
  mecard: z.object({
    firstName: optionalString,
    lastName: optionalString,
    nickname: optionalString,
    phone1: optionalString,
    phone2: optionalString,
    phone3: optionalString,
    email: optionalString,
    url: optionalString,
    birthday: optionalString,
    street: optionalString,
    zipcode: optionalString,
    city: optionalString,
    state: optionalString,
    country: optionalString,
    notes: optionalString
  }),
  maps: z.object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) }),
  facebook: z.object({ mode: z.enum(['url', 'share']).default('url'), url: httpUrl }),
  twitter: z.object({ mode: z.enum(['url', 'tweet']).default('url'), url: httpUrl.optional(), tweet: z.string().max(280).optional() }),
  youtube: z.object({ url: httpUrl }),
  wifi: z.object({ ssid: optionalString, password: optionalString, encryption: z.enum(['nopass', 'WEP', 'WPA']).default('nopass') }),
  event: z.object({ title: optionalString, location: optionalString, start: z.string().min(1), end: z.string().min(1) }),
  crypto: z.object({ currency: z.enum(['bitcoin', 'bitcoincash', 'ethereum', 'litecoin', 'dash']).default('bitcoin'), address: z.string().min(1), amount: z.coerce.number().positive().optional() }),
  mp3: z.object({ title: optionalString, url: httpUrl.optional(), description: optionalString }),
  video: z.object({ title: optionalString, url: httpUrl.optional(), description: optionalString }),
  pdf: z.object({ title: optionalString, url: httpUrl.optional(), description: optionalString }),
  social: z.object({ title: optionalString, links: z.array(z.object({ label: z.string(), url: httpUrl })).default([]) }),
  app: z.object({ title: optionalString, iosUrl: httpUrl.optional(), androidUrl: httpUrl.optional(), fallbackUrl: httpUrl.optional() }),
  gallery: z.object({ title: optionalString, images: z.array(z.object({ url: z.union([httpUrl, z.string().regex(/^\/samples\/gallery-[123]\.svg$/)]), caption: optionalString })).default([]) }),
  rating: z.object({ title: optionalString, question: optionalString }),
  feedback: z.object({ title: optionalString, prompt: optionalString })
} satisfies Record<ContentType, z.ZodTypeAny>;

export function buildPayload(type: ContentType, raw: Record<string, unknown>): string {
  switch (type) {
    case 'url':
      return payloadSchemas.url.parse(raw).url;
    case 'text':
      return payloadSchemas.text.parse(raw).text;
    case 'email': {
      const data = payloadSchemas.email.parse(raw);
      const params = new URLSearchParams();
      if (data.subject) params.set('subject', data.subject);
      if (data.message) params.set('body', data.message);
      const query = params.toString();
      return `mailto:${data.email}${query ? `?${query}` : ''}`;
    }
    case 'phone':
      return `tel:${payloadSchemas.phone.parse(raw).phone}`;
    case 'sms': {
      const data = payloadSchemas.sms.parse(raw);
      return `SMSTO:${data.phone}:${data.message}`;
    }
    case 'vcard': {
      const v = payloadSchemas.vcard.parse(raw);
      const lines = ['BEGIN:VCARD', `VERSION:${v.version}`];
      if (v.firstName || v.lastName) {
        lines.push(`N:${v.lastName};${v.firstName}`);
        lines.push(`FN:${[v.firstName, v.lastName].filter(Boolean).join(' ')}`);
      }
      if (v.title) lines.push(`TITLE:${v.title}`);
      if (v.organization) lines.push(`ORG:${v.organization}`);
      if (v.url) lines.push(`URL:${v.url}`);
      if (v.email) lines.push(`EMAIL;TYPE=INTERNET:${v.email}`);
      if (v.phoneWork) lines.push(`TEL;TYPE=voice,work,pref:${v.phoneWork}`);
      if (v.phonePrivate) lines.push(`TEL;TYPE=voice,home,pref:${v.phonePrivate}`);
      if (v.phoneMobile) lines.push(`TEL;TYPE=voice,cell,pref:${v.phoneMobile}`);
      if (v.faxWork) lines.push(`TEL;TYPE=fax,work,pref:${v.faxWork}`);
      if (v.faxPrivate) lines.push(`TEL;TYPE=fax,home,pref:${v.faxPrivate}`);
      if (v.street || v.city || v.zipcode || v.country || v.state) lines.push(`ADR;TYPE=intl,postal,parcel:;;${v.street};${v.city};${v.state};${v.zipcode};${v.country}`);
      lines.push('END:VCARD');
      return lines.join('\n');
    }
    case 'mecard': {
      const m = payloadSchemas.mecard.parse(raw);
      const parts = ['MECARD:'];
      if (m.firstName || m.lastName) parts.push(`N:${m.lastName},${m.firstName};`);
      if (m.nickname) parts.push(`NICKNAME:${m.nickname};`);
      for (const phone of [m.phone1, m.phone2, m.phone3]) if (phone) parts.push(`TEL:${phone};`);
      if (m.url) parts.push(`URL:${m.url};`);
      if (m.email) parts.push(`EMAIL:${m.email};`);
      if (m.birthday) parts.push(`BDAY:${m.birthday.replace(/-/g, '')};`);
      if (m.notes) parts.push(`NOTE:${m.notes.replace(/;/g, ',')};`);
      if (m.street || m.city || m.state || m.zipcode || m.country) parts.push(`ADR:,,${m.street},${m.city},${m.state},${m.zipcode},${m.country};`);
      parts.push(';');
      return parts.join('');
    }
    case 'maps': {
      const data = payloadSchemas.maps.parse(raw);
      return `https://maps.google.com/local?q=${data.latitude},${data.longitude}`;
    }
    case 'facebook': {
      const data = payloadSchemas.facebook.parse(raw);
      return data.mode === 'share' ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(data.url)}` : data.url;
    }
    case 'twitter': {
      const data = payloadSchemas.twitter.parse(raw);
      return data.mode === 'tweet' ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(data.tweet ?? '')}` : data.url ?? 'https://twitter.com';
    }
    case 'youtube':
      return payloadSchemas.youtube.parse(raw).url;
    case 'wifi': {
      const w = payloadSchemas.wifi.parse(raw);
      return `WIFI:S:${escapeWifi(w.ssid)};T:${w.encryption};P:${escapeWifi(w.password)};;`;
    }
    case 'event': {
      const e = payloadSchemas.event.parse(raw);
      return ['BEGIN:VEVENT', `SUMMARY:${e.title}`, `LOCATION:${e.location}`, `DTSTART:${formatEventDate(e.start)}`, `DTEND:${formatEventDate(e.end)}`, 'END:VEVENT'].join('\n');
    }
    case 'crypto': {
      const c = payloadSchemas.crypto.parse(raw);
      return `${c.currency}:${c.address}${c.amount ? `?amount=${c.amount}` : ''}`;
    }
    default:
      return JSON.stringify(payloadSchemas[type].parse(raw));
  }
}

export function isLandingPageType(type: ContentType): boolean {
  return ['mp3', 'video', 'pdf', 'social', 'app', 'gallery', 'rating', 'feedback'].includes(type);
}

function escapeWifi(value: string): string {
  return value.replace(/([\\;,":])/g, '\\$1');
}

function formatEventDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace(/[-:]/g, '').slice(0, 15);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}
