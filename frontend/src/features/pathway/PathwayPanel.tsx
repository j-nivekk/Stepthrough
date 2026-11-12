import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';

import { absoluteApiUrl, getRunPathway } from '../../api';
import { downloadText } from '../../lib/accountLinks';
import { APP_VERSION } from '../../lib/buildInfo';
import { buildPathwayFigure, formatPathwayTime, type PathwayFigureOptions, type PathwayNotesPlacement } from '../../lib/pathwayFigure';
import {
  clampPathwayZoom,
  loadPathwayView,
  PATHWAY_ZOOM_MAX,
  PATHWAY_ZOOM_MIN,
  savePathwayView,
  type PathwayView,
} from '../../lib/pathwayView';
import { rangeFillStyle } from '../../lib/rangeFill';
import { recordingAspect } from '../../lib/stepLayout';
import { splitFilename } from '../../lib/utils';
import type { CandidateChanges, Pathway, PathwayDetail, PathwayStep, RecordingSummary, RunDetail } from '../../types';
import { useElementWidth } from '../analysis/useElementWidth';
import { PathwayBoxEditor } from './PathwayBoxEditor';

interface PathwayPanelProps {
  onUpdateCandidate: (candidateId: string, changes: CandidateChanges) => void;
  projectName: string;
  recording: RecordingSummary | null;
  run: RunDetail;
}

const DETAILS: Array<[PathwayDetail, string, string]> = [
  ['screens', 'screens', 'one box per screen: scrolling, typing and small changes stay in the same box'],
  ['steps', 'steps', 'one box per step; a step that returns to an earlier screen still shares its box'],
];
const NOTES: Array<[PathwayNotesPlacement, string, string]> = [
  ['under', 'under screens', 'notes under each screen, cut after four lines'],
  ['key', 'in a key', 'notes in full in a list below the chart'],
  ['hidden', 'off', 'leave the notes out'],
];

/** Today as YYYY-MM-DD, by the clock of this computer. */
function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A screenshot as a data URI no wider than `maxWidth`, so the downloaded figure needs no other files. */
async function embedImage(url: string, maxWidth: number): Promise<string> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('could not load a screenshot for the figure.');
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.86);
}

export function PathwayPanel({ onUpdateCandidate, projectName, recording, run }: PathwayPanelProps) {
  const [view, setView] = useState<PathwayView>(() => loadPathwayView());
  const [areaRef, areaWidth] = useElementWidth<HTMLDivElement>();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  // The selected box, kept as one of its steps: boxes are numbered again whenever the grouping changes.
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  useEffect(() => {
    savePathwayView(view);
  }, [view]);

  const runId = run.summary.id;
  useEffect(() => {
    setSelectedCandidateId(null);
  }, [runId]);
  // The pathway is built from the steps, so it is fetched again when a decision, title, note or screen choice changes.
  const acceptedKey = run.candidates
    .map((step) => [step.id, step.status, step.title ?? '', step.notes ?? '', step.screen_link ?? '', step.screen_kind ?? ''].join('\u0001'))
    .join('\u0002');
  const pathwayQuery = useQuery({
    queryKey: ['pathway', runId, view.detail, acceptedKey],
    queryFn: () => getRunPathway(runId, view.detail),
    enabled: run.accepted_steps.length > 0,
    placeholderData: keepPreviousData,
  });
  const pathway = run.accepted_steps.length > 0 ? pathwayQuery.data : undefined;

  const aspect = recordingAspect(recording?.width, recording?.height);
  const options: PathwayFigureOptions = useMemo(
    () => ({ notes: view.notes, times: view.times, caption: view.caption }),
    [view.notes, view.times, view.caption],
  );
  const filename = recording?.filename ?? run.summary.recording_id;

  const selectedScreen = useMemo(() => {
    const step = pathway?.steps.find((item) => item.source_candidate_id === selectedCandidateId);
    return (step && pathway?.screens.find((screen) => screen.id === step.screen_id)) || null;
  }, [pathway, selectedCandidateId]);

  function figureFor(source: Pathway, imageFor: (step: PathwayStep) => string, highlight: string | null = null) {
    const counts = `${plural(source.step_count, 'step', 'steps')} on ${plural(source.screen_count, 'screen', 'screens')}`;
    const parts = [projectName, counts, recording ? formatPathwayTime(recording.duration_ms) : ''].filter(Boolean);
    return buildPathwayFigure({
      pathway: source,
      options,
      aspect,
      title: filename,
      subtitle: parts.join(' · '),
      date: localDate(),
      version: APP_VERSION,
      imageFor,
      highlight,
    });
  }

  const figure = useMemo(
    () =>
      pathway && pathway.screens.length
        ? figureFor(pathway, (step) => absoluteApiUrl(step.image_url), selectedScreen?.id ?? null)
        : null,
    // figureFor reads only what is listed here
    [pathway, options, aspect, filename, projectName, recording?.duration_ms, selectedScreen?.id],
  );

  /** A click on a screen selects its box for editing; a click anywhere else lets go of it. */
  function handleFigureClick(event: MouseEvent<HTMLDivElement>) {
    const group = event.target instanceof Element ? event.target.closest('[data-screen]') : null;
    const screen = group ? pathway?.screens.find((item) => item.id === group.getAttribute('data-screen')) : undefined;
    const step = screen ? pathway?.steps.find((item) => item.step_id === screen.image_step_id) : undefined;
    setSelectedCandidateId(step?.source_candidate_id ?? null);
  }

  const fitScale = figure && areaWidth > 0 ? Math.min(1, areaWidth / figure.width) : 1;
  const scale = view.zoom ?? fitScale;

  async function handleDownload() {
    if (!pathway) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const shown = new Map(pathway.steps.map((step) => [step.step_id, step]));
      const images = new Map<string, string>();
      // Three times the size it is drawn at, so the screenshots stay sharp in print.
      const maxWidth = Math.round(220 * Math.sqrt(aspect) * 3);
      for (const screen of pathway.screens) {
        const step = shown.get(screen.image_step_id);
        if (step) images.set(step.step_id, await embedImage(absoluteApiUrl(step.image_url), maxWidth));
      }
      const file = figureFor(pathway, (step) => images.get(step.step_id) ?? '');
      downloadText(`${splitFilename(filename).base}-pathway.svg`, `<?xml version="1.0" encoding="UTF-8"?>\n${file.svg}\n`, 'image/svg+xml');
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'could not make the figure.');
    } finally {
      setDownloading(false);
    }
  }

  if (run.accepted_steps.length === 0) {
    return (
      <p className="entry-empty-copy candidate-empty-copy">
        a pathway is drawn from the accepted steps. accept the steps that belong in the walkthrough under <b>steps</b>,
        then come back here.
      </p>
    );
  }

  const zoomPercent = Math.round(scale * 100);
  return (
    <div className="pathway-panel">
      <div className="pathway-bar" ref={areaRef}>
        <span className="candidate-view-note">
          {pathwayQuery.isError
            ? 'could not load the pathway.'
            : pathway
              ? `${plural(pathway.step_count, 'step', 'steps')} on ${plural(pathway.screen_count, 'screen', 'screens')}`
              : 'loading the pathway…'}
          {figure && figure.clippedNotes > 0 ? (
            <>
              {' · '}
              {plural(figure.clippedNotes, 'note is', 'notes are')} cut short;{' '}
              <button className="analysis-task-link subtle" onClick={() => setView((current) => ({ ...current, notes: 'key' }))} type="button">
                show notes in a key
              </button>
            </>
          ) : null}
          {downloadError ? ` · ${downloadError}` : ''}
        </span>
        <div className="pathway-controls">
          <div aria-label="boxes of the pathway" className="pathway-control" role="group">
            <span className="pathway-control-label">boxes</span>
            {DETAILS.map(([value, label, hint]) => (
              <button
                aria-pressed={view.detail === value}
                className={`candidate-filter-tab ${view.detail === value ? 'active' : ''}`}
                key={value}
                onClick={() => setView((current) => ({ ...current, detail: value }))}
                title={hint}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <div aria-label="where notes go" className="pathway-control" role="group">
            <span className="pathway-control-label">notes</span>
            {NOTES.map(([value, label, hint]) => (
              <button
                aria-pressed={view.notes === value}
                className={`candidate-filter-tab ${view.notes === value ? 'active' : ''}`}
                key={value}
                onClick={() => setView((current) => ({ ...current, notes: value }))}
                title={hint}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <div aria-label="what else to show" className="pathway-control" role="group">
            <span className="pathway-control-label">show</span>
            <button
              aria-pressed={view.times}
              className={`candidate-filter-tab ${view.times ? 'active' : ''}`}
              onClick={() => setView((current) => ({ ...current, times: !current.times }))}
              title="the time of each visit, next to its step number"
              type="button"
            >
              times
            </button>
            <button
              aria-pressed={view.caption}
              className={`candidate-filter-tab ${view.caption ? 'active' : ''}`}
              onClick={() => setView((current) => ({ ...current, caption: !current.caption }))}
              title="the title above the chart and the legend below it"
              type="button"
            >
              title and legend
            </button>
          </div>
          <div className="candidate-size-control">
            <label className="candidate-size-slider" title={`size of the figure on the page: ${zoomPercent}%`}>
              <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                <rect height="6" rx="1" width="6" x="4" y="4" />
              </svg>
              <input
                aria-label="size of the figure on the page"
                max={PATHWAY_ZOOM_MAX * 100}
                min={PATHWAY_ZOOM_MIN * 100}
                onChange={(event) => setView((current) => ({ ...current, zoom: clampPathwayZoom(Number(event.target.value) / 100) }))}
                step={5}
                style={rangeFillStyle(zoomPercent, PATHWAY_ZOOM_MIN * 100, PATHWAY_ZOOM_MAX * 100)}
                type="range"
                value={Math.min(PATHWAY_ZOOM_MAX * 100, Math.max(PATHWAY_ZOOM_MIN * 100, zoomPercent))}
              />
              <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                <rect height="12" rx="1" width="12" x="1" y="1" />
              </svg>
            </label>
            <button
              aria-pressed={view.zoom === null}
              className={`candidate-filter-tab ${view.zoom === null ? 'active' : ''}`}
              onClick={() => setView((current) => ({ ...current, zoom: null }))}
              title="size the figure to fill the width of the page"
              type="button"
            >
              fit
            </button>
          </div>
          <button className="analysis-pill success" disabled={!figure || downloading} onClick={() => void handleDownload()} type="button">
            {downloading ? 'preparing…' : 'download svg'}
          </button>
        </div>
      </div>
      {pathway && figure ? (
        <PathwayBoxEditor
          candidates={run.candidates}
          onSelect={setSelectedCandidateId}
          onUpdateCandidate={onUpdateCandidate}
          pathway={pathway}
          selected={selectedScreen}
        />
      ) : null}
      {figure ? (
        <div className="pathway-scroll">
          <div
            aria-label={`pathway of ${filename}; choose a screen above to change it`}
            className="pathway-figure"
            // The markup is built by buildPathwayFigure, which escapes every title, note and address it places.
            dangerouslySetInnerHTML={{ __html: figure.svg }}
            onClick={handleFigureClick}
            style={{ width: `${Math.round(figure.width * scale)}px` }}
          />
        </div>
      ) : null}
    </div>
  );
}
