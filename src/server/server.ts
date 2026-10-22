import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { defaultDesignConfig, normalizeDesignConfig } from '../qr/design';
import { buildPayload, isLandingPageType, payloadSchemas } from '../qr/payloads';
import { clampSize, renderQr } from '../qr/renderer';
import type { ContentType, QrMode, QrRecord } from '../shared/types';
import { YourlsClient } from '../yourls/client';
import { JsonStore, publicBaseUrl } from './store';

const purifier = createDOMPurify(new JSDOM('').window);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const app = express();
const store = new JsonStore();

app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use('/uploads', express.static(path.resolve(process.env.UPLOAD_DIR || '.local/uploads'), {
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
}));

const outputFormatSchema = z.enum(['png', 'svg', 'pdf', 'eps']);

const qrCustomSchema = z.object({
  data: z.string().min(1),
  size: z.coerce.number().optional().default(300),
  file: outputFormatSchema.optional().default('png'),
  download: z.coerce.boolean().optional().default(false),
  config: z.record(z.string(), z.unknown()).optional().default({})
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'qr-code-toolkit' });
});

app.get(['/api/meta', '/qr/meta'], (_req, res) => {
  res.json({
    defaultDesignConfig,
    pdfEpsStatus: 'disabled: PNG and SVG are supported in this MVP; PDF/EPS require a print renderer phase.'
  });
});

app.get(['/api/qr/custom', '/qr/custom'], async (req, res, next) => {
  try {
    const config = typeof req.query.config === 'string' ? JSON.parse(req.query.config) : {};
    await sendQr(res, qrCustomSchema.parse({ ...req.query, config }));
  } catch (error) {
    next(error);
  }
});

app.post(['/api/qr/custom', '/qr/custom'], async (req, res, next) => {
  try {
    await sendQr(res, qrCustomSchema.parse(req.body));
  } catch (error) {
    next(error);
  }
});

app.post(['/api/qr/upload-image', '/qr/uploadImage'], rateLimit('upload', 20), optionalAdminAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, 'file is required');
    validateUpload(req.file);
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || '.local/uploads');
    await mkdir(uploadDir, { recursive: true });
    const extension = extensionFor(req.file.mimetype, req.file.originalname);
    const filename = `${randomUUID()}${extension}`;
    const storagePath = path.join(uploadDir, filename);
    await writeFile(storagePath, req.file.buffer);
    const asset = await store.addAsset({
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storagePath,
      publicPath: `/uploads/${filename}`,
      buffer: req.file.buffer
    });
    res.json({ file: asset.publicPath, asset });
  } catch (error) {
    next(error);
  }
});

const createQrSchema = z.object({
  name: z.string().min(1).default('Untitled QR'),
  mode: z.enum(['static', 'dynamic_url', 'dynamic_payload']).default('static'),
  contentType: z.string(),
  contentPayload: z.record(z.string(), z.unknown()).default({}),
  designConfig: z.record(z.string(), z.unknown()).default({}),
  sizePx: z.coerce.number().default(300),
  keyword: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional()
});

app.post('/api/qr-codes', rateLimit('qr-create', 60), optionalAdminAuth, async (req, res, next) => {
  try {
    const input = createQrSchema.parse(req.body);
    const contentType = input.contentType as ContentType;
    if (!Object.hasOwn(payloadSchemas, contentType)) throw httpError(400, 'Unknown content type');
    input.contentPayload = payloadSchemas[contentType].parse(input.contentPayload);
    if (input.mode === 'dynamic_url' && contentType !== 'url') throw httpError(400, 'Dynamic URL mode requires URL content');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const mode = normalizeMode(input.mode, contentType);
    const longPayload = mode === 'dynamic_payload' ? `${publicBaseUrl()}/l/${id}` : mode === 'dynamic_url' ? `${publicBaseUrl()}/r/${id}` : buildPayload(contentType, input.contentPayload);
    const dynamic = mode !== 'static';
    const yourls = makeYourlsClient();
    const short = dynamic ? await yourls.shorten(longPayload, input.keyword, input.name) : undefined;
    const encodedPayload = dynamic ? short!.shorturl : longPayload;
    const record: QrRecord = {
      id,
      name: input.name,
      mode,
      contentType,
      contentPayload: input.contentPayload,
      encodedPayload,
      yourlsKeyword: short?.keyword,
      yourlsShortUrl: short?.shorturl,
      yourlsLongUrl: short?.longurl,
      designConfig: normalizeDesignConfig(input.designConfig),
      sizePx: clampSize(input.sizePx),
      status: 'active',
      createdAt,
      updatedAt: createdAt
    };
    await store.upsertQr(record);
    await store.addAudit({ qrCodeId: id, actorId: 'system', eventType: 'created', previous: null, next: record });
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

app.get('/api/qr-codes', optionalAdminAuth, async (_req, res) => {
  const db = await store.all();
  res.json(db.qrCodes);
});

app.get('/api/qr-codes/:id', optionalAdminAuth, async (req, res, next) => {
  const db = await store.all();
  const qr = db.qrCodes.find((item) => item.id === req.params.id);
  if (!qr) return next(httpError(404, 'QR code not found'));
  res.json({ qr, auditEvents: db.auditEvents.filter((event) => event.qrCodeId === qr.id), feedback: db.feedback.filter((item) => item.qrCodeId === qr.id) });
});

app.patch('/api/qr-codes/:id', rateLimit('qr-update', 120), optionalAdminAuth, async (req, res, next) => {
  try {
    const db = await store.all();
    const qr = db.qrCodes.find((item) => item.id === req.params.id);
    if (!qr) throw httpError(404, 'QR code not found');
    const nextPayload = payloadSchemas[qr.contentType].parse(req.body.contentPayload ?? qr.contentPayload);
    const nextDesign = normalizeDesignConfig(req.body.designConfig ?? qr.designConfig);
    const previous = structuredClone(qr);
    qr.name = typeof req.body.name === 'string' ? req.body.name : qr.name;
    qr.contentPayload = nextPayload;
    qr.designConfig = nextDesign;
    qr.sizePx = clampSize(req.body.sizePx ?? qr.sizePx);
    qr.updatedAt = new Date().toISOString();
    if (qr.mode === 'static') {
      qr.encodedPayload = buildPayload(qr.contentType, qr.contentPayload);
    } else if (qr.mode === 'dynamic_payload') {
      qr.yourlsLongUrl = `${publicBaseUrl()}/l/${qr.id}`;
    } else {
      qr.yourlsLongUrl = `${publicBaseUrl()}/r/${qr.id}`;
    }
    await store.upsertQr(qr);
    await store.addAudit({ qrCodeId: qr.id, actorId: 'system', eventType: 'updated', previous, next: qr });
    res.json(qr);
  } catch (error) {
    next(error);
  }
});

app.get('/api/qr-codes/:id/render', optionalAdminAuth, async (req, res, next) => {
  try {
    const db = await store.all();
    const qr = db.qrCodes.find((item) => item.id === req.params.id);
    if (!qr) throw httpError(404, 'QR code not found');
    await sendQr(res, {
      data: qr.encodedPayload,
      size: Number(req.query.size || qr.sizePx),
      file: outputFormatSchema.parse(req.query.file ?? 'svg'),
      download: false,
      config: qr.designConfig as unknown as Record<string, unknown>
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/qr-codes/:id/stats', optionalAdminAuth, async (req, res, next) => {
  try {
    const db = await store.all();
    const qr = db.qrCodes.find((item) => item.id === req.params.id);
    if (!qr) throw httpError(404, 'QR code not found');
    if (!qr.yourlsShortUrl) return res.json({ scans: 0, source: 'static' });
    if (!makeYourlsClient().configured()) return res.json({ scans: 0, source: 'dev-fallback', shorturl: qr.yourlsShortUrl });
    res.json(await makeYourlsClient().urlStats(qr.yourlsShortUrl));
  } catch (error) {
    next(error);
  }
});

app.get('/r/:token', async (req, res, next) => {
  const db = await store.all();
  const qr = db.qrCodes.find((item) => item.id === req.params.token || item.yourlsKeyword === req.params.token);
  if (!qr) return next(httpError(404, 'Short URL not found'));
  if (qr.mode === 'dynamic_url') {
    return res.redirect(buildPayload(qr.contentType, qr.contentPayload));
  }
  res.redirect(qr.yourlsLongUrl || qr.encodedPayload);
});

app.get('/l/:id', async (req, res, next) => {
  const db = await store.all();
  const qr = db.qrCodes.find((item) => item.id === req.params.id);
  if (!qr) return next(httpError(404, 'Landing page not found'));
  res.type('html').send(renderLandingPage(qr));
});

const feedbackSchema = z.object({
  name: z.string().trim().max(200).optional().default(''),
  message: z.string().trim().max(5000).optional().default('')
}).refine((value) => value.name.length > 0 || value.message.length > 0, { message: 'Feedback must include a name or a message' });

// The landing page form posts application/x-www-form-urlencoded; API clients may post JSON.
app.post('/api/landing/:id/feedback', rateLimit('feedback', 30), express.urlencoded({ extended: false, limit: '64kb' }), async (req, res, next) => {
  const fromForm = Boolean(req.is('application/x-www-form-urlencoded'));
  try {
    const db = await store.all();
    const qr = db.qrCodes.find((item) => item.id === req.params.id);
    if (!qr || !['rating', 'feedback'].includes(qr.contentType)) throw httpError(404, 'Landing page not found');
    if (!req.body || typeof req.body !== 'object') throw httpError(400, 'Feedback must be sent as a form or JSON body');
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message || 'Invalid feedback');
    db.feedback.unshift({ id: randomUUID(), qrCodeId: qr.id, submission: parsed.data, createdAt: new Date().toISOString() });
    await store.save();
    if (fromForm) return res.type('html').send(renderFeedbackResult(qr, true, 'Thanks, your feedback was received.'));
    res.json({ ok: true });
  } catch (error) {
    if (!fromForm) return next(error);
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: number }).status) : 500;
    const message = status < 500 && error instanceof Error ? error.message : 'Your feedback could not be saved. Please try again.';
    res.status(status).type('html').send(renderFeedbackResult(null, false, message));
  }
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static('dist/client'));
  app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/client/index.html')));
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = error instanceof z.ZodError ? 400 : typeof error === 'object' && error && 'status' in error ? Number((error as { status: number }).status) : 500;
  res.status(status || 500).json({ error: error instanceof Error ? error.message : 'Unexpected error' });
});

export function createApp(): express.Express {
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const certFile = process.env.HTTPS_CERT_FILE || process.env.LOCAL_CERT_FILE;
  const keyFile = process.env.HTTPS_KEY_FILE || process.env.LOCAL_CERT_KEY_FILE;
  if (certFile && keyFile) {
    https.createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, app).listen(port, host, () => {
      console.log(`QR Code Toolkit running with HTTPS at https://localhost:${port}`);
    });
  } else {
    app.listen(port, host, () => {
      console.log(`QR Code Toolkit running at http://localhost:${port}`);
    });
  }
}

async function sendQr(res: express.Response, input: z.infer<typeof qrCustomSchema>): Promise<void> {
  const rendered = await renderQr({ data: input.data, size: input.size, file: input.file, config: input.config });
  res.setHeader('Content-Type', rendered.contentType);
  if (input.download) res.setHeader('Content-Disposition', `attachment; filename="${rendered.filename}"`);
  res.send(rendered.body);
}

function makeYourlsClient(): YourlsClient {
  return new YourlsClient({
    apiUrl: process.env.YOURLS_API_URL,
    signature: process.env.YOURLS_SIGNATURE,
    shortDomain: process.env.YOURLS_SHORT_DOMAIN || `${publicBaseUrl()}/r`
  });
}

function normalizeMode(mode: QrMode, contentType: ContentType): QrMode {
  if (mode === 'dynamic_payload' || isLandingPageType(contentType)) return 'dynamic_payload';
  return mode;
}

function validateUpload(file: Express.Multer.File): void {
  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'];
  if (!allowed.includes(file.mimetype)) throw httpError(415, 'Unsupported logo type. Use PNG, JPG, GIF, or SVG.');
  if (file.mimetype === 'image/svg+xml') {
    const clean = purifier.sanitize(file.buffer.toString('utf8'), {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'animate', 'animateMotion', 'animateTransform', 'set', 'use', 'style'],
      FORBID_ATTR: ['href', 'xlink:href', 'style']
    });
    if (purifier.removed.some((item) => 'attribute' in item || item.element?.nodeName !== 'BODY') || !clean.includes('<svg')) throw httpError(400, 'Unsafe SVG content rejected.');
    file.buffer = Buffer.from(clean);
  }
}

function extensionFor(mime: string, original: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/svg+xml') return '.svg';
  return path.extname(original).slice(0, 8) || '.bin';
}

function renderLandingPage(qr: QrRecord): string {
  const p = qr.contentPayload as Record<string, any>;
  const title = escapeHtml(String(p.title || qr.name));
  const rawDescription = String(p.description || p.prompt || p.question || '');
  const description = escapeHtml(rawDescription);
  const contentTypeLabel = escapeHtml(String(qr.contentType).toUpperCase());
  let body = '';
  if (['mp3', 'video'].includes(qr.contentType) && p.url) {
    body += qr.contentType === 'mp3'
      ? `<audio controls src="${escapeAttr(p.url)}"></audio>`
      : `<video controls src="${escapeAttr(p.url)}"></video>`;
  }
  if (qr.contentType === 'pdf' && p.url) {
    body += `<div class="actions"><a class="btn btn-primary" href="${escapeAttr(p.url)}">Open PDF &rarr;</a></div>`;
  }
  if (qr.contentType === 'social' && Array.isArray(p.links)) {
    body += `<ul class="social-links">${p.links.map((link: any) => `<li><a href="${escapeAttr(link.url)}"><span class="row-label">${escapeHtml(link.label)}</span><span class="row-chevron" aria-hidden="true">&rsaquo;</span></a></li>`).join('')}</ul>`;
  }
  if (qr.contentType === 'app') {
    const ios = p.iosUrl ? `<a class="btn btn-primary" href="${escapeAttr(p.iosUrl)}">App Store</a>` : '';
    const android = p.androidUrl ? `<a class="btn btn-secondary" href="${escapeAttr(p.androidUrl)}">Google Play</a>` : '';
    if (ios || android) body += `<div class="actions">${ios}${android}</div>`;
  }
  if (qr.contentType === 'gallery' && Array.isArray(p.images)) {
    body += `<div class="gallery">${p.images.map((img: any) => `<figure><img src="${escapeAttr(img.url)}" alt=""><figcaption>${escapeHtml(img.caption || '')}</figcaption></figure>`).join('')}</div>`;
  }
  if (qr.contentType === 'rating' || qr.contentType === 'feedback') {
    body += `<form method="post" action="/api/landing/${escapeAttr(qr.id)}/feedback"><label><span class="eyebrow">Name</span><input name="name"></label><label><span class="eyebrow">Message</span><textarea name="message" rows="4"></textarea></label><div class="actions"><button class="btn btn-primary" type="submit">Send</button></div></form>`;
  }
  const lede = rawDescription ? `<p class="lede">${description}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#F7FAFE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0B1628" media="(prefers-color-scheme: dark)">
<title>${title} &middot; CompleteTech</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--navy:#003A70;--navy-deep:#020638;--navy-mid:#073F78;--blue:#008CFF;--gold:#FDB913;--gold-soft:#F2B544;--gold-deep:#B17800;--paper:#F7FAFE;--paper-deep:#E8F1FB;--paper-warm:#F2F7FD;--ink:#07142F;--ink-mid:#1D2B46;--ink-light:#60708A;--rule:#C9D9EA;--rule-soft:#E5EEF8;--font-display:'Fraunces',Georgia,serif;--font-body:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--font-mono:'JetBrains Mono',SFMono-Regular,Menlo,Consolas,monospace;--col-text:760px;--col-max:1280px;--ease-standard:cubic-bezier(.2,.8,.2,1);--dur-fast:120ms;--dur-base:220ms;}
@media (prefers-color-scheme: dark){:root{--navy:#5F8EC9;--navy-deep:#04081A;--navy-mid:#0F1F3D;--blue:#31A8FF;--gold:#FDB913;--gold-soft:#F2B544;--gold-deep:#E2A437;--paper:#0B1628;--paper-deep:#152238;--paper-warm:#101C32;--ink:#EAF1FB;--ink-mid:#B8C5D9;--ink-light:#7A8AA3;--rule:#27375A;--rule-soft:#1A263F;}}
html{color-scheme:light dark;}
*,*::before,*::after{box-sizing:border-box;}
body{font-family:var(--font-body);color:var(--ink);background:var(--paper);margin:0;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
::selection{background:var(--gold);color:var(--navy-deep);}
a{color:var(--navy);text-decoration:none;border-bottom:1px solid transparent;transition:color var(--dur-fast) var(--ease-standard),border-color var(--dur-fast) var(--ease-standard);}
a:hover{border-bottom-color:var(--gold);}
.wrap{max-width:var(--col-text);margin:0 auto;padding:56px 22px 80px;}
.eyebrow{font-family:var(--font-mono);font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:var(--ink-light);margin:0 0 12px;display:block;}
h1{font-family:var(--font-display);font-variation-settings:"opsz" 96;letter-spacing:-0.01em;font-weight:500;font-size:clamp(40px,7vw,64px);line-height:1.05;margin:0 0 18px;color:var(--ink);}
h1 em{font-style:italic;font-variation-settings:"opsz" 96,"SOFT" 100;}
.lede{font-family:var(--font-body);font-size:18px;line-height:1.5;color:var(--ink-mid);margin:0 0 12px;}
hr{height:1px;background:var(--rule);border:0;margin:32px 0;}
.btn{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-body);font-size:14px;font-weight:500;letter-spacing:0.02em;padding:14px 22px;border:1px solid var(--ink);border-radius:0;cursor:pointer;text-decoration:none;transition:background-color var(--dur-base) var(--ease-standard),color var(--dur-base) var(--ease-standard),border-color var(--dur-base) var(--ease-standard);}
.btn:hover{border-bottom-color:var(--ink);}
.btn-primary{background:var(--ink);color:var(--paper);}
.btn-primary:hover{background:var(--gold);color:var(--navy-deep);border-color:var(--gold);}
.btn-secondary{background:transparent;color:var(--ink);}
.btn-secondary:hover{background:var(--gold);color:var(--navy-deep);border-color:var(--gold);}
.btn:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0;}
audio,video,img{max-width:100%;border-radius:0;display:block;}
audio{width:100%;}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin:24px 0;}
.gallery figure{margin:0;}
.gallery img{width:100%;height:auto;}
.gallery figcaption{font-family:var(--font-mono);font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-light);margin-top:8px;}
form label{display:block;margin:18px 0;}
form label .eyebrow{margin-bottom:6px;}
input,textarea,select{width:100%;font:inherit;font-family:var(--font-body);padding:12px;border:1px solid var(--rule);border-radius:0;background:var(--paper);color:var(--ink);margin:0;transition:border-color var(--dur-fast) var(--ease-standard);}
textarea{resize:vertical;min-height:96px;}
input:hover,textarea:hover,select:hover{border-color:var(--ink-light);}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--gold);outline-offset:2px;border-color:var(--ink);}
ul.social-links{list-style:none;padding:0;margin:24px 0;}
ul.social-links li{padding:0;border-top:1px solid var(--rule-soft);}
ul.social-links li:first-child{border-top:0;}
ul.social-links a{display:flex;align-items:center;justify-content:space-between;padding:18px 0;color:var(--ink);border-bottom:0;transition:color var(--dur-fast) var(--ease-standard),padding var(--dur-base) var(--ease-standard);}
ul.social-links .row-label{font-family:var(--font-mono);font-size:12px;letter-spacing:0.16em;text-transform:uppercase;}
ul.social-links .row-chevron{font-family:var(--font-display);font-size:24px;color:var(--ink-light);transition:transform var(--dur-base) var(--ease-standard),color var(--dur-fast) var(--ease-standard);}
ul.social-links a:hover{color:var(--navy);}
ul.social-links a:hover .row-chevron{transform:translateX(4px);color:var(--gold-deep);}
ul.social-links a:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
footer{font-family:var(--font-mono);font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-light);margin-top:48px;padding-top:24px;border-top:1px solid var(--rule-soft);}
footer a{color:var(--navy);}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{transition:none !important;animation:none !important;}}
</style>
</head>
<body>
<main class="wrap">
<p class="eyebrow">FIELD ARTIFACT &middot; ${contentTypeLabel}</p>
<h1>${title}</h1>
${lede}
<hr>
${body}
<footer>&copy; 2026 CompleteTech LLC &middot; <a href="https://complete.tech">complete.tech</a></footer>
</main>
</body>
</html>`;
}

function renderFeedbackResult(qr: QrRecord | null, ok: boolean, message: string): string {
  const back = qr ? `<p><a href="/l/${escapeAttr(qr.id)}">Back</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'Thank you' : 'Feedback not sent'}</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:56px auto;padding:0 22px;}</style></head><body><main><h1>${ok ? 'Thank you' : 'Feedback not sent'}</h1><p role="status">${escapeHtml(message)}</p>${back}</main></body></html>`;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(scope: string, maxPerMinute: number): express.RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${scope}:${req.ip}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) return res.status(429).json({ error: 'Rate limit exceeded' });
    next();
  };
}

function optionalAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next();
  if (req.header('x-admin-token') === token) return next();
  res.status(401).json({ error: 'Admin token required' });
}
