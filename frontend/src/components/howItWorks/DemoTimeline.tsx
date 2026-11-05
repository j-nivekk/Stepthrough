import { useMemo } from 'react';
import {
  changeAt,
  DURATION,
  IGNORED,
  LABEL_TEXT,
  MIN_DWELL,
  recordedFrames,
  STEPS,
  STILL,
  THRESHOLD,
  workingFrames,
  type DemoLabel,
} from './demoScript';

const LEFT = 36;
const WIDTH = 690;
const x = (t: number) => LEFT + (Math.min(DURATION, Math.max(0, t)) / DURATION) * WIDTH;

const CHART_TOP = 18;
const CHART_BASE = 104;
const y = (value: number) => CHART_BASE - Math.min(1, value) * (CHART_BASE - CHART_TOP);

export const LABEL_COLOURS: Record<DemoLabel, string> = {
  opening_screen: 'rgb(70, 70, 70)',
  navigation: 'rgb(209, 109, 56)',
  text_entry: 'rgb(120, 84, 150)',
  content_update: 'rgb(111, 102, 90)',
  scroll: 'rgb(47, 100, 130)',
  modal: 'rgb(177, 69, 60)',
};

export interface DemoTimelineProps {
  stage: number;
  t: number;
}

/** The analysis of the demo recording, built up stage by stage and drawn up to the playhead. */
export function DemoTimeline({ stage, t }: DemoTimelineProps) {
  const recorded = useMemo(() => recordedFrames(), []);
  const working = useMemo(() => workingFrames(), []);
  const curve = useMemo(() => working.map((time) => [time, changeAt(time)] as const), [working]);

  const curvePath = useMemo(() => {
    const visible = curve.filter(([time]) => time <= t);
    if (visible.length < 2) return '';
    const line = visible.map(([time, value], index) => `${index ? 'L' : 'M'}${x(time).toFixed(1)},${y(value).toFixed(1)}`).join('');
    const last = visible[visible.length - 1][0];
    return `${line}L${x(last).toFixed(1)},${CHART_BASE}L${x(0)},${CHART_BASE}Z`;
  }, [curve, t]);

  const stepsRowY = 150;

  return (
    <svg className="demo-timeline" role="img" viewBox="0 0 760 236" aria-label="timeline of the demo recording">
      {/* axis */}
      <line className="demo-axis" x1={x(0)} x2={x(DURATION)} y1={214} y2={214} />
      {Array.from({ length: DURATION / 2 + 1 }, (_, index) => index * 2).map((second) => (
        <g key={second}>
          <line className="demo-axis" x1={x(second)} x2={x(second)} y1={214} y2={218} />
          <text className="demo-axis-label" textAnchor="middle" x={x(second)} y={230}>
            {second} s
          </text>
        </g>
      ))}

      {stage === 1 ? (
        <g>
          <text className="demo-row-label" x={x(0)} y={96}>
            the recording: 14 seconds, one continuous stream of frames
          </text>
          <rect className="demo-recording-bar" height={22} width={WIDTH} x={x(0)} y={106} />
          <rect className="demo-recording-bar played" height={22} width={x(t) - x(0)} x={x(0)} y={106} />
        </g>
      ) : null}

      {stage === 2 ? (
        <g>
          <text className="demo-row-label" x={x(0)} y={46}>
            as recorded: a new frame only when the screen changes
          </text>
          {recorded
            .filter((time) => time <= t)
            .map((time) => (
              <line className="demo-frame recorded" key={`r${time}`} x1={x(time)} x2={x(time)} y1={54} y2={84} />
            ))}
          <text className="demo-row-label" x={x(0)} y={130}>
            working copy: 15 frames every second, each at its true time
          </text>
          {working
            .filter((time) => time <= t)
            .map((time) => (
              <line className="demo-frame working" key={`w${time}`} x1={x(time)} x2={x(time)} y1={138} y2={168} />
            ))}
        </g>
      ) : null}

      {stage >= 3 ? (
        <g>
          <text className="demo-row-label" x={x(0)} y={12}>
            how much of the screen changed since the current screen began
          </text>
          <path className="demo-curve" d={curvePath} />
          <line className="demo-threshold" x1={x(0)} x2={x(DURATION)} y1={y(THRESHOLD)} y2={y(THRESHOLD)} />
          <text className="demo-threshold-label" x={x(0) + 2} y={y(THRESHOLD) - 4}>
            counts as a change
          </text>
          <text className="demo-row-label muted" x={x(0)} y={121}>
            ignored: status bar clock, blinking cursor
          </text>
          {IGNORED.filter((event) => event.at <= t).map((event) => (
            <line className="demo-ignored" key={`i${event.at}`} x1={x(event.at)} x2={x(event.at)} y1={126} y2={136} />
          ))}
        </g>
      ) : null}

      {stage === 4
        ? STILL.filter((still) => still.from <= t).map((still) => {
            const end = Math.min(t, still.to);
            const long = end - still.from >= MIN_DWELL;
            const finished = t >= still.to;
            const tooShort = still.note === 'too short';
            return (
              <g key={`s${still.from}`}>
                <rect
                  className={`demo-still ${long ? 'stable' : 'pending'} ${tooShort && finished ? 'too-short' : ''}`}
                  height={18}
                  width={Math.max(1.5, x(end) - x(still.from))}
                  x={x(still.from)}
                  y={stepsRowY}
                />
                {tooShort && finished ? (
                  <text className="demo-note" textAnchor="middle" x={x(still.from) + 4} y={stepsRowY + 32}>
                    too short
                  </text>
                ) : null}
                {still.note === 'same screen' && finished ? (
                  <text className="demo-note" textAnchor="middle" x={(x(still.from) + x(still.to)) / 2 + 10} y={stepsRowY - 6}>
                    same screen again
                  </text>
                ) : null}
              </g>
            );
          })
        : null}
      {stage === 4 ? (
        <text className="demo-row-label" x={x(0)} y={stepsRowY - 8}>
          still for at least 450 ms
        </text>
      ) : null}

      {stage >= 5
        ? STEPS.filter((step) => t >= step.from + MIN_DWELL || stage >= 6).map((step) => {
            const colour = LABEL_COLOURS[step.label];
            return (
              <g key={`step${step.index}`}>
                {step.groupFrom != null ? (
                  <rect
                    className="demo-group"
                    height={18}
                    style={{ stroke: colour }}
                    width={x(step.from) - x(step.groupFrom)}
                    x={x(step.groupFrom)}
                    y={stepsRowY}
                  />
                ) : null}
                <rect
                  className="demo-step"
                  height={18}
                  style={{ fill: colour }}
                  width={Math.max(2, x(step.to) - x(step.from))}
                  x={x(step.from)}
                  y={stepsRowY}
                />
                <text className="demo-step-label" x={x(step.groupFrom ?? step.from)} y={stepsRowY + (step.index % 2 ? 31 : 45)}>
                  {step.index} {LABEL_TEXT[step.label]}
                  {step.grouped ? ` ×${step.grouped}` : ''}
                </text>
                {stage >= 6 && t >= step.shot ? (
                  <g>
                    <line className="demo-shot-line" x1={x(step.shot)} x2={x(step.shot)} y1={CHART_TOP} y2={stepsRowY} />
                    <circle className="demo-shot" cx={x(step.shot)} cy={stepsRowY + 9} r={4.5} />
                  </g>
                ) : null}
              </g>
            );
          })
        : null}
      {stage >= 5 ? (
        <text className="demo-row-label" x={x(0)} y={stepsRowY - 8}>
          {stage >= 6 ? 'steps, with a screenshot 200 ms after each settles' : 'steps: typing grouped, each labelled'}
        </text>
      ) : null}

      <line className="demo-playhead" x1={x(t)} x2={x(t)} y1={CHART_TOP - 6} y2={214} />
    </svg>
  );
}
