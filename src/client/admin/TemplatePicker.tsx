import { useId } from 'react';
import type { EventTemplate, EventTemplateConfig } from '../../shared/types';
import { useResource } from './hooks';
import './templates.css';

/** Built-ins plus the signed-in account's own saved templates. */
export const TEMPLATES_PATH = '/api/templates';

/** "90 min before the start", "at the start", "1 h 30 min after the start". */
function offsetText(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes === 0) return 'at the start';
  const abs = Math.abs(minutes);
  const amount = abs >= 60 && abs % 60 === 0 ? `${abs / 60} h` : abs > 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return `${amount} ${minutes < 0 ? 'before' : 'after'} the start`;
}

function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}

/** What a template sets up: duration, capacity, gates, policies with their entry windows, pass design. */
export function TemplateOutline({ config }: { config: EventTemplateConfig }) {
  return (
    <dl className="template-outline">
      <div>
        <dt>Length</dt>
        <dd>
          {durationText(config.durationMinutes)}
          {config.capacity ? ` · capacity ${config.capacity}` : ' · no capacity limit'}
          {config.venue ? ` · ${config.venue}` : ''}
          {config.timeZone ? ` · ${config.timeZone.replace(/_/g, ' ')}` : ''}
        </dd>
      </div>
      <div>
        <dt>Gates</dt>
        <dd>{config.gates.length ? config.gates.join(', ') : 'None (any door)'}</dd>
      </div>
      <div>
        <dt>Policies</dt>
        <dd>
          {config.policies.length ? (
            <ul className="template-policies">
              {config.policies.map((policy) => (
                <li key={policy.name}>
                  <span className="strong">{policy.name}</span>: entry from {offsetText(policy.opensOffsetMinutes, 'the start')} until{' '}
                  {offsetText(policy.closesOffsetMinutes, 'the end')}
                  {policy.gates.length ? ` · ${policy.gates.join(', ')}` : ''}
                  {policy.capacity ? ` · max ${policy.capacity}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            'None (passes enter during the event at any gate)'
          )}
        </dd>
      </div>
      <div>
        <dt>Pass design</dt>
        <dd>{config.design ? 'Copied from the saved event' : (config.designPreset ?? 'Default')}</dd>
      </div>
    </dl>
  );
}

/**
 * Optional first step of the new-event form. "Start from scratch" is the
 * default; a template pre-fills the form and the server adds its gates,
 * policies and pass design when the event is created.
 */
export function TemplatePicker({ selected, onSelect }: { selected: EventTemplate | null; onSelect: (template: EventTemplate | null) => void }) {
  const { data: templates, error, loading, reload } = useResource<EventTemplate[]>(TEMPLATES_PATH);
  const id = useId();
  const builtins = templates?.filter((template) => template.kind === 'builtin') ?? [];
  const saved = templates?.filter((template) => template.kind === 'saved') ?? [];

  return (
    <div className="template-picker span-2">
      <label>
        Start from
        <select
          value={selected?.id ?? ''}
          onChange={(e) => onSelect(templates?.find((template) => template.id === e.target.value) ?? null)}
          disabled={!templates}
          aria-describedby={`${id}-hint`}
        >
          <option value="">Start from scratch</option>
          {builtins.length ? (
            <optgroup label="Templates">
              {builtins.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {saved.length ? (
            <optgroup label="Your templates">
              {saved.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <span id={`${id}-hint`} className="field-hint">
        {loading && !templates ? (
          'Loading templates…'
        ) : error && !templates ? (
          <>
            Templates could not be loaded ({error}).{' '}
            <button type="button" className="btn btn-ghost btn-small" onClick={() => void reload()}>
              Try again
            </button>
          </>
        ) : selected ? (
          (selected.description ?? 'Your saved template.')
        ) : (
          'A template fills in typical settings and adds gates, admission policies and a pass design. You can change everything afterwards.'
        )}
      </span>
      {selected ? <TemplateOutline config={selected.config} /> : null}
    </div>
  );
}
