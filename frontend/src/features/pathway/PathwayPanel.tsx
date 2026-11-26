import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { getRunPathway, mergePathwayScreens, notePathwayFigure, restoreRunPhases, setRunPhase } from '../../api';
import interItalicUrl from '../../assets/fonts/InterVariable-Italic.ttf?url';
import interUrl from '../../assets/fonts/InterVariable.ttf?url';
import { markPathwayTutorialSeen, PathwayTutorial, pathwayTutorialSeen } from '../../components/pathwayTutorial/PathwayTutorial';
import { downloadBlob, downloadText } from '../../lib/accountLinks';
import { APP_VERSION } from '../../lib/buildInfo';
import { buildPathwayFigure, formatPathwayTime, pathwayColumnsFor, pathwayFrameWidth, pathwayScale, type PathwayFigureOptions, type PathwayNotesPlacement } from '../../lib/pathwayFigure';
import { screenshotUrl, screenshotWidth } from '../../lib/screenshots';
import { renderPathwayPng } from '../../lib/pathwayPng';
import {
  clampPathwayZoom,
  loadPathwayView,
  PATHWAY_ZOOM_MAX,
  PATHWAY_ZOOM_MIN,
  savePathwayView,
  type PathwayView,
} from '../../lib/pathwayView';
import { rangeFillStyle } from '../../lib/rangeFill';
import { pathwayQueryOptions } from '../../lib/pathwayQuery';
import { recordingAspect } from '../../lib/stepLayout';
import { splitFilename } from '../../lib/utils';
import type { CandidateChanges, Pathway, PathwayDetail, PathwayStep, RecordingSummary, RunDetail } from '../../types';
import { useElementWidth } from '../analysis/useElementWidth';
import { holdPlace, keepPlace, type HeldPlace } from './holdPlace';
import { PathwayCanvas, type PhaseRequest } from './PathwayCanvas';
import { usePathwayPeek } from './usePathwayPeek';
import { track } from '../../lib/usage';
import { PlaceholderFigure } from '../../components/Placeholders';

interface PathwayPanelProps {
  /** Opens the about panel at the bottom right, where the tutorial stays within reach. */
  onOpenAbout: () => void;
  onUpdateCandidate: (candidateId: string, changes: CandidateChanges) => void;
  projectName: string;
  recording: RecordingSummary | null;
  run: RunDetail;
}

/** Both draw boxes as screens; they differ in how readily two steps count as one. The tooltip says when to use
 * which, the line under the controls what the chosen one does. */
const DETAILS: Array<[PathwayDetail, string, string, string]> = [
  [
    'screens',
    'screens',
    'for the journey as places: how many screens, in what order, and where people came back',
    'by screens, a page stays one box while it is scrolled or typed in, after a pop-up over it closes, and when it comes back.',
  ],
  [
    'steps',
    'steps',
    'for every action on its own, such as each scroll through a feed; also to check what screens put together',
    'by steps, every step has a box of its own; only the same picture again, or your own correction, shares one.',
  ],
];
type FigureFormat = 'svg' | 'png';
const FORMATS: Array<[FigureFormat, string]> = [
  ['svg', 'a drawing to finish in a design program: sharp at any size, text stays text, every screen is a group'],
  ['png', "a picture at twice the figure's size, for slides, documents and the web"],
];
const NOTES: Array<[PathwayNotesPlacement, string, string]> = [
  ['under', 'under screens', 'notes under each screen'],
  ['key', 'in a key', 'notes in a list below the chart'],
  ['hidden', 'off', 'leave the notes out'],
];
// Optional detours: trips off the main way through that come back to it (services/pathway.py). Some interactions
// are optional, so counting their steps would not say faithfully how many steps an activity takes.
const DETOURS: Array<[boolean, string, string]> = [
  [true, 'counted', 'the steps of optional detours count as the others'],
  [false, 'left out', 'leave the steps of optional detours (trips off the main way that come back to it) out of the counts and the numbers; they get letters, as in 13a'],
];

/** The borders of the frame the figure is in (styles.css .pathway-scroll), in pixels. */
const FRAME_BORDERS = 2;

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
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('could not prepare a screenshot for the figure.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
  return canvas.toDataURL('image/jpeg', 0.86);
}

export function PathwayPanel({ onOpenAbout, onUpdateCandidate, projectName, recording, run }: PathwayPanelProps) {
  const queryClient = useQueryClient();
  const editingCandidates = useIsMutating({ mutationKey: ['candidate-update'] }) > 0;
  const [view, setView] = useState<PathwayView>(() => loadPathwayView());
  const [areaRef, areaWidth] = useElementWidth<HTMLDivElement>();
  const [downloading, setDownloading] = useState<FigureFormat | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const [tutorialOpen, setTutorialOpen] = useState(false);
  // Shown once, until the tutorial is started or the invitation dismissed.
  const [invite, setInvite] = useState(() => !pathwayTutorialSeen());
  useEffect(() => {
    if (invite) track({ kind: 'tutorial_invited' });
    // once, when the pathway first shows with the invitation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After the invitation goes, a note in its place says where the tutorial is from then on. Its colour drains
  // from right to left as a countdown, and the note goes when it is empty (or with its ×).
  const [aboutNote, setAboutNote] = useState(false);
  const [tutorialFromInvite, setTutorialFromInvite] = useState(false);
  // The phases panel, open on its list, on a stretch of steps for a new phase, or on a phase to change.
  const [phases, setPhases] = useState<PhaseRequest | null>(null);

  useEffect(() => {
    savePathwayView(view);
  }, [view]);

  const runId = run.summary.id;
  useEffect(() => {
    setPhases(null);
  }, [runId]);
  const pathwayQuery = useQuery(pathwayQueryOptions(run, view.detail, getRunPathway));
  const mergeMutation = useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
      mergePathwayScreens(runId, sourceId, targetId, view.detail),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['run', runId] }),
        queryClient.invalidateQueries({ queryKey: ['pathway', runId] }),
      ]);
    },
  });
  const pathway = run.accepted_steps.length > 0 ? pathwayQuery.data : undefined;
  const updating = pathwayQuery.isFetching || pathwayQuery.isPlaceholderData || mergeMutation.isPending || editingCandidates;

  const aspect = recordingAspect(recording?.width, recording?.height);
  const options: PathwayFigureOptions = useMemo(
    () => ({ notes: view.notes, times: view.times, caption: view.caption, countDetours: view.countDetours }),
    [view.notes, view.times, view.caption, view.countDetours],
  );
  const filename = recording?.filename ?? run.summary.recording_id;
  const hasDetours = Boolean(pathway && pathway.main_step_count !== undefined && pathway.main_step_count < pathway.step_count);

  // On the page, a row takes as many boxes as fit the space with little shrinking, so its labels stay readable, or as
  // many as fit at the smaller size the reader chose; a downloaded figure has the same rows. Drawn anew only when that
  // number changes, not with every pixel of a resize.
  const space = Math.max(0, areaWidth - FRAME_BORDERS);
  const rowSize = view.zoom === null ? null : Math.min(1, view.zoom); // beyond 100% the rows stay
  const columns = useMemo(
    () => (pathway && space > 0 ? pathwayColumnsFor({ pathway, options, aspect }, space, rowSize) : undefined),
    [pathway, options, aspect, space, rowSize],
  );
  // The boxes draw a copy of each screenshot as wide as they are (at most at full size, or as zoomed in), not the
  // screenshot itself; the hovered step's preview shows in the same box. Only a different copy draws them again.
  const boxWidth = pathwayFrameWidth(aspect) * Math.max(1, view.zoom ?? 1);
  const copyWidth = screenshotWidth(boxWidth);

  /** The figure of a pathway, for a file or the page: there, its boxes and step numbers can be selected, dragged and
   *  previewed. Both have the same rows. */
  function figureFor(source: Pathway, imageFor: (step: PathwayStep) => string, page = false) {
    // With the optional detours left out, the counts are those of the main way through, and say what was left out.
    const detourSteps = source.main_step_count === undefined ? 0 : source.step_count - source.main_step_count;
    const counts =
      options.countDetours === false && detourSteps > 0
        ? `${plural(source.main_step_count ?? 0, 'step', 'steps')} on ${plural(source.main_screen_count ?? 0, 'screen', 'screens')}, ` +
          `plus ${detourSteps} in optional detours`
        : `${plural(source.step_count, 'step', 'steps')} on ${plural(source.screen_count, 'screen', 'screens')}`;
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
      peek: page,
      columns,
    });
  }

  const figure = useMemo(
    () =>
      pathway && pathway.screens.length
        ? figureFor(pathway, (step) => screenshotUrl(step.image_url, boxWidth), true)
        : null,
    // figureFor reads only what is listed here; the selection is drawn over the figure (PathwayCanvas)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boxWidth matters only through copyWidth
    [pathway, options, aspect, filename, projectName, recording?.duration_ms, columns, copyWidth],
  );
  const peek = usePathwayPeek(pathway, figure?.svg, boxWidth, !view.countDetours);
  // One object per figure: React sets the markup again whenever it gets a new object, even with the same text, and
  // the analysis page renders every second for its clock. That would draw the chart anew each second and take
  // away the step a pointer is resting on.
  const figureMarkup = useMemo(() => (figure ? { __html: figure.svg } : undefined), [figure]);

  const scale = figure ? pathwayScale(figure.width, space, view.zoom) : 1;
  const heldRef = useRef<HeldPlace | null>(null);
  /** The size of the figure on the page (null fits it), keeping the reader's place in it. */
  function setSize(control: Element, zoom: number | null) {
    heldRef.current = holdPlace(control, heldRef.current);
    setView((current) => ({ ...current, zoom }));
  }
  useLayoutEffect(() => {
    if (heldRef.current) keepPlace(heldRef.current);
    // only when the size changed: the figure is drawn anew for other reasons as well, which hold nothing
  }, [view.zoom]);

  async function handleDownload(format: FigureFormat) {
    if (!pathway || updating) return;
    setDownloading(format);
    setDownloadError('');
    try {
      const shown = new Map(pathway.steps.map((step) => [step.step_id, step]));
      const images = new Map<string, string>();
      // Three times the size it is drawn at, so the screenshots stay sharp in print.
      const maxWidth = pathwayFrameWidth(aspect) * 3;
      for (const screen of pathway.screens) {
        const step = shown.get(screen.image_step_id);
        // a copy at least that wide (not the screenshot itself, often many times larger), made smaller to fit
        if (step) images.set(step.step_id, await embedImage(screenshotUrl(step.image_url, maxWidth, 1), maxWidth));
      }
      const file = figureFor(pathway, (step) => images.get(step.step_id) ?? '');
      const name = `${splitFilename(filename).base}-pathway.${format}`;
      if (format === 'svg') downloadText(name, `<?xml version="1.0" encoding="UTF-8"?>\n${file.svg}\n`, 'image/svg+xml');
      else downloadBlob(name, await renderPathwayPng(file, { regular: interUrl, italic: interItalicUrl }));
      void notePathwayFigure(run.summary.id, format).catch(() => undefined); // for the usage and progress reports
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'could not make the figure.');
    } finally {
      setDownloading(null);
    }
  }

  function openTutorial() {
    track({ kind: 'tutorial_opened', from: invite ? 'invitation' : 'pathway' });
    markPathwayTutorialSeen();
    setTutorialFromInvite(invite);
    setInvite(false);
    setTutorialOpen(true);
  }

  function dismissInvite() {
    markPathwayTutorialSeen();
    setInvite(false);
    setAboutNote(true);
  }

  const tutorialLink = (
    <button className="analysis-task-link subtle" onClick={openTutorial} type="button">
      how to work with pathways
    </button>
  );
  const tutorial = tutorialOpen ? (
    <PathwayTutorial
      onClose={() => {
        setTutorialOpen(false);
        if (tutorialFromInvite) setAboutNote(true);
        setTutorialFromInvite(false);
      }}
    />
  ) : null;
  // keyed apart, so the note is a new element: the focus of a click on "not now" must not carry over into it and
  // hold its line (which stops while the note is hovered or focused)
  const invitation = invite ? (
    <div className="pathway-invite" key="invite">
      <span>
        <b>new to pathways?</b> a hands-on tutorial on a practice recording shows how to read, check and correct a
        pathway. it takes about 5 minutes.
      </span>
      <button className="analysis-pill success" onClick={openTutorial} type="button">
        start the tutorial
      </button>
      <button className="analysis-task-link subtle" onClick={dismissInvite} type="button">
        not now
      </button>
    </div>
  ) : aboutNote ? (
    <div aria-live="polite" className="pathway-invite pathway-invite-after" key="about-note">
      <span aria-hidden="true" className="pathway-invite-fill" onAnimationEnd={() => setAboutNote(false)} />
      <span>
        you can always come back to the tutorial under{' '}
        <button
          className="analysis-task-link"
          onClick={() => {
            setAboutNote(false);
            onOpenAbout();
          }}
          type="button"
        >
          about
        </button>
        , at the bottom right.
      </span>
      <button aria-label="close" className="pathway-invite-close" onClick={() => setAboutNote(false)} type="button">
        ×
      </button>
    </div>
  ) : null;

  if (run.accepted_steps.length === 0) {
    return (
      <div className="pathway-panel">
        {invitation}
        <p className="entry-empty-copy candidate-empty-copy">
          a pathway is drawn from the accepted steps. accept the steps that belong in the walkthrough under <b>steps</b>,
          then come back here. new to pathways? {tutorialLink}.
        </p>
        {tutorial}
      </div>
    );
  }

  const zoomPercent = Math.round((view.zoom ?? scale) * 100);
  const barNotes: ReactNode[] = [];
  if (pathwayQuery.isError) barNotes.push('could not load the pathway.');
  else if (!pathway) barNotes.push('loading the pathway…');
  if (downloadError) barNotes.push(downloadError);
  if (mergeMutation.isError) barNotes.push(`could not merge the screens: ${mergeMutation.error.message}`);
  const controlsBar = (
    <div className="pathway-bar">
      {/* The step and screen counts are in the figure's subtitle; this line is only for what needs saying. */}
      {barNotes.length ? (
        <span className="candidate-view-note">
          {barNotes.map((note, index) => (
            <span key={index}>
              {index > 0 ? ' · ' : ''}
              {note}
            </span>
          ))}
        </span>
      ) : null}
      <div className="pathway-controls">
        {/* what the figure shows on the left; its size on the page and the download on the right */}
        <div className="pathway-controls-group">
          <div aria-label="view of the pathway" className="pathway-control" role="group">
            <span className="pathway-control-label" title={DETAILS.find(([value]) => value === view.detail)?.[3]}>
              view
            </span>
            {DETAILS.map(([value, label, hint]) => (
              <button
                aria-pressed={view.detail === value}
                className={`candidate-filter-tab ${view.detail === value ? 'active' : ''}`}
                key={value}
                onClick={() => {
                  if (view.detail !== value) track({ kind: 'boxes_switched', to: value });
                  setView((current) => ({ ...current, detail: value }));
                }}
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
          {hasDetours ? (
            <div aria-label="optional detours" className="pathway-control" role="group">
              <span className="pathway-control-label">detours</span>
              {DETOURS.map(([value, label, hint]) => (
                <button
                  aria-pressed={view.countDetours === value}
                  className={`candidate-filter-tab ${view.countDetours === value ? 'active' : ''}`}
                  key={label}
                  onClick={() => setView((current) => ({ ...current, countDetours: value }))}
                  title={hint}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
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
          <div aria-label="phases of the walkthrough" className="pathway-control" role="group">
            <span className="pathway-control-label">phases</span>
            <button
              aria-expanded={phases !== null}
              className={`candidate-filter-tab ${phases !== null ? 'active' : ''}`}
              data-phases-toggle=""
              disabled={!pathway}
              onClick={(event) => {
                const button = event.currentTarget.getBoundingClientRect();
                setPhases((current) => (current ? null : { list: true, at: { x: button.left, y: button.bottom + 6 } }));
              }}
              title="named stretches of steps, such as sign up: drawn over the boxes, and in the export"
              type="button"
            >
              {pathway?.phases?.length ? `${pathway.phases.length} named` : 'none yet'}
            </button>
          </div>
        </div>
        <div className="pathway-controls-group pathway-controls-end">
          <div className="candidate-size-control">
            <label className="candidate-size-slider" title={`size of the figure on the page: ${zoomPercent}%. smaller fits more screens on a row`}>
              <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                <rect height="6" rx="1" width="6" x="4" y="4" />
              </svg>
              <input
                aria-label="size of the figure on the page"
                max={PATHWAY_ZOOM_MAX * 100}
                min={PATHWAY_ZOOM_MIN * 100}
                onChange={(event) => setSize(event.currentTarget, clampPathwayZoom(Number(event.target.value) / 100))}
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
              onClick={(event) => setSize(event.currentTarget, null)}
              title="size the figure to fill the width of the page"
              type="button"
            >
              fit
            </button>
          </div>
          <div aria-label="download the figure" className="pathway-control pathway-download" role="group">
            {/* "preparing…" takes the place of the label, which keeps room for it, so nothing moves while it works */}
            <span aria-live="polite" className="pathway-control-label pathway-download-label">
              <span>{downloading ? 'preparing…' : 'download'}</span>
              <span aria-hidden="true" className="pathway-download-room">
                preparing…
              </span>
            </span>
            {FORMATS.map(([format, hint]) => (
              <button
                aria-busy={downloading === format}
                className="analysis-pill success"
                disabled={!figure || downloading !== null || updating}
                key={format}
                onClick={() => void handleDownload(format)}
                title={hint}
                type="button"
              >
                {format}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="pathway-panel" ref={areaRef}>
      {invitation}
      {tutorial}
      {pathway && figure && figureMarkup ? (
        <PathwayCanvas
          ariaLabel={`pathway of ${filename}: select a box or a step number to change it`}
          busy={updating}
          candidates={run.candidates}
          encodings={figure.encodings}
          leaveOut={!view.countDetours}
          markup={figureMarkup}
          onMerge={async (sourceId, targetId) => (await mergeMutation.mutateAsync({ sourceId, targetId })).changed}
          onPhaseRequest={setPhases}
          onRestorePhases={async (boundaries, expected) => {
            try {
              await restoreRunPhases(runId, boundaries, expected);
            } finally {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['pathway', runId] }),
                queryClient.invalidateQueries({ queryKey: ['run', runId] }),
              ]);
            }
          }}
          onSetPhase={async (phase) => {
            const answer = await setRunPhase(runId, phase);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['pathway', runId] }),
              queryClient.invalidateQueries({ queryKey: ['run', runId] }),
              queryClient.invalidateQueries({ queryKey: ['recording', run.summary.recording_id] }),
            ]);
            return answer.phases;
          }}
          phaseBoundaries={run.phases}
          phaseRequest={phases}
          onPointerLeave={peek.onPointerLeave}
          onPointerOver={peek.onPointerOver}
          onUpdateCandidate={onUpdateCandidate}
          pathway={pathway}
          runId={runId}
          stickyHeader={controlsBar}
          width={Math.floor(figure.width * scale)}
        />
      ) : (
        <>
          {controlsBar}
          {!pathwayQuery.isError ? <PlaceholderFigure label="loading the pathway" /> : null}
        </>
      )}
    </div>
  );
}
