import { ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { EventSummary, IssuedPass } from '../../shared/types';
import { formatRangeInZone } from '../time';
import { BADGES_PER_PAGE, badgeLayout, nameFontPt, paginate, type BadgeLayout, type BadgesPerPage } from './BadgeSheetLayout';
import { adminQrUrl } from './http';
import { passReference } from './IssuedPasses';
import './badges.css';

const QR_CONCURRENCY = 6;

interface Props {
  event: EventSummary;
  passes: IssuedPass[];
  policyNames: Map<string, string>;
  onDone: () => void;
}

/**
 * Print preview and A4 badge sheets for freshly issued passes. QR codes are rendered from
 * the in-memory issuance response (tokens are never fetched again); the preview shows one
 * sheet at a time, and the whole run is portalled outside `#root`, the only thing printed.
 */
export function BadgeSheet({ event, passes, policyNames, onDone }: Props) {
  const [urls, setUrls] = useState<Array<string | null> | null>(null);
  const [ready, setReady] = useState(false);
  const [perPage, setPerPage] = useState<BadgesPerPage>(8);
  const [guides, setGuides] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);
  const sheet = useRef<HTMLDivElement>(null);
  const id = useId();
  const layout = badgeLayout(perPage);
  const pages = useMemo(() => paginate(passes, perPage), [passes, perPage]);
  const current = Math.min(pageIndex, pages.length - 1);
  const failed = urls?.filter((url) => url === null).length ?? 0;

  // Reloading the event gives `design` a new identity; refetch only when its content changes.
  const designKey = JSON.stringify(event.design);
  useEffect(() => {
    let live = true;
    const design = JSON.parse(designKey);
    const created: string[] = [];
    const result: Array<string | null> = passes.map(() => null);
    let next = 0;
    // The previous codes are revoked by the cleanup below: stop showing (and printing) them.
    setUrls(null);
    setReady(false);
    const worker = async () => {
      while (live && next < passes.length) {
        const index = next++;
        try {
          const url = await adminQrUrl(passes[index].passUrl, design);
          created.push(url);
          result[index] = url;
        } catch {
          result[index] = null;
        }
      }
    };
    void Promise.all(Array.from({ length: QR_CONCURRENCY }, worker)).then(() => live && setUrls(result));
    return () => {
      live = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [passes, designKey]);

  // Printing before every code has decoded would leave blank squares on paper.
  useEffect(() => {
    if (!urls || !sheet.current) return;
    let live = true;
    const images = [...sheet.current.querySelectorAll('img')];
    void Promise.allSettled(images.map((image) => image.decode())).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [urls]);

  const sheetProps = { event, layout, policyNames, urls: urls ?? [] };

  return (
    <section className="sheet-preview" aria-label="Print preview">
      <div className="sheet-controls">
        {/* Short number buttons under one visible label: four "N per page" buttons did not fit a phone screen. */}
        <div className="sheet-per-page">
          <span id={`${id}-per-page`} className="small muted">
            Passes per page
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby={`${id}-per-page`}>
            {BADGES_PER_PAGE.map((count) => (
              <button
                key={count}
                role="radio"
                aria-checked={perPage === count}
                aria-label={`${count} per page`}
                className={perPage === count ? 'active' : ''}
                onClick={() => {
                  setPerPage(count);
                  setPageIndex(0);
                }}
              >
                {count}
              </button>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> Cut guides
        </label>
        <div className="actions">
          <button type="button" className="btn btn-primary btn-small" onClick={() => window.print()} disabled={!ready}>
            <Printer size={14} aria-hidden /> {ready ? 'Print' : 'Preparing…'}
          </button>
          <button type="button" className="btn btn-ghost btn-small" onClick={onDone}>
            Close print view
          </button>
        </div>
      </div>
      <p className="muted small" role="status">
        {urls
          ? `${pages.length} A4 page${pages.length === 1 ? '' : 's'}, ${perPage} per page, QR codes ${layout.qrMm} mm.${failed ? ` ${failed} code${failed === 1 ? '' : 's'} could not be rendered and are left blank; use the CSV links for those.` : ''}`
          : `Preparing ${passes.length} pass${passes.length === 1 ? '' : 'es'} for printing…`}
      </p>
      {urls ? (
        <>
          <div className={`sheet-paper per-${perPage}`}>
            <div className="sheet-paper-scale">
              <BadgePage {...sheetProps} passes={pages[current]} offset={current * perPage} guides={guides} />
            </div>
          </div>
          <div className="sheet-pager">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setPageIndex(current - 1)} disabled={current === 0} aria-label="Previous page">
              <ChevronLeft size={14} aria-hidden />
            </button>
            <span>
              Page {current + 1} of {pages.length}
            </span>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setPageIndex(current + 1)} disabled={current >= pages.length - 1} aria-label="Next page">
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
          {createPortal(
            <div className="sheet-print" ref={sheet} aria-hidden>
              {pages.map((page, index) => (
                <BadgePage key={index} {...sheetProps} passes={page} offset={index * perPage} guides={guides} />
              ))}
            </div>,
            document.body
          )}
        </>
      ) : null}
    </section>
  );
}

interface PageProps {
  event: EventSummary;
  layout: BadgeLayout;
  policyNames: Map<string, string>;
  urls: Array<string | null>;
  passes: IssuedPass[];
  /** Index of the page's first pass in `urls`. */
  offset: number;
  guides: boolean;
}

function BadgePage({ event, layout, policyNames, urls, passes, offset, guides }: PageProps) {
  const when = formatRangeInZone(event.startsAt, event.endsAt, event.timeZone);
  const style = {
    '--sheet-cols': layout.columns,
    '--sheet-rows': layout.rows,
    '--sheet-pad': `${layout.paddingMm}mm`,
    '--sheet-gap': `${layout.gapMm}mm`,
    '--sheet-qr': `${layout.qrMm}mm`
  } as CSSProperties;
  return (
    <div className={`sheet-page per-${layout.perPage}${guides ? ' guides' : ''}`} style={style}>
      {passes.map((pass, index) => {
        const name = pass.attendeeName || 'Admission pass';
        const policy = pass.policyId ? (policyNames.get(pass.policyId) ?? null) : null;
        const url = urls[offset + index];
        return (
          <article key={pass.id} className={`sheet-badge sheet-${layout.direction}`}>
            {url ? <img className="sheet-qr" src={url} alt="" /> : <div className="sheet-qr sheet-missing">QR code unavailable: use the link from the CSV</div>}
            <div className="sheet-text">
              <div className="sheet-name" style={{ fontSize: `${nameFontPt(name, layout)}pt`, WebkitLineClamp: layout.nameLines } as CSSProperties}>
                {name}
              </div>
              {policy ? <div className="sheet-policy">{policy}</div> : null}
              <div className="sheet-event">{event.name}</div>
              <div className="sheet-when">{when}</div>
              {event.venue ? <div className="sheet-venue">{event.venue}</div> : null}
              <div className="sheet-ref">
                Ref <span>{passReference(pass.id)}</span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
