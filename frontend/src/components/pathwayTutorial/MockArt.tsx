import type { ReactNode } from 'react';

import type { MockArt as Art } from './tutorialModel';

export const ART_WIDTH = 52;
export const ART_HEIGHT = 106;

const BG = '#f6f6f3';
const BAR = '#dcdcd6';
const SOFT = '#cfcfc8';
const MID = '#a7a7a0';
const DARK = '#7d7d76';

function Header({ badge = false }: { badge?: boolean }) {
  return (
    <>
      <rect fill={BAR} height={12} width={ART_WIDTH} />
      <rect fill={DARK} height={2.5} width={16} x={5} y={5} />
      <circle cx={45} cy={6} fill={MID} r={2.3} />
      {badge ? <circle cx={47} cy={4} fill="#c0392b" r={3} stroke={BAR} strokeWidth={1} /> : null}
    </>
  );
}

function Tabs({ active }: { active: number }) {
  return (
    <>
      <rect fill="#e8e8e3" height={10} width={ART_WIDTH} y={96} />
      {[8, 20, 32, 44].map((x, index) => (
        <circle cx={x} cy={101} fill={index === active ? DARK : SOFT} key={x} r={1.8} />
      ))}
    </>
  );
}

function SettingsRows({ widths, shift = 0, firstOn = false }: { widths: number[]; shift?: number; firstOn?: boolean }) {
  return (
    <>
      {widths.map((width, index) => {
        const y = 17 + shift + index * 12;
        const on = firstOn && index === 0;
        return (
          <g key={index}>
            <rect fill={MID} height={2.5} width={width} x={5} y={y + 3} />
            <rect fill={on ? '#48af7c' : SOFT} height={6} rx={3} width={11} x={36} y={y + 1.5} />
            <circle cx={on ? 44 : 39} cy={y + 4.5} fill="#fff" r={2.2} />
            <line stroke="#e2e2dc" strokeWidth={0.6} x1={5} x2={47} y1={y + 10} y2={y + 10} />
          </g>
        );
      })}
    </>
  );
}

function Article({ image, title, lines }: { image: string; title: number; lines: number[] }) {
  return (
    <>
      <rect fill={image} height={24} width={42} x={5} y={16} />
      <rect fill={DARK} height={3} width={title} x={5} y={44} />
      {lines.map((width, index) => (
        <rect fill={SOFT} height={2} key={index} width={width} x={5} y={52 + index * 6} />
      ))}
    </>
  );
}

/** A screen of the practice app, drawn as a wireframe in a 52 × 106 box. */
export function MockArt({ art }: { art: Art }) {
  let body: ReactNode;
  let tab = 0;
  if (art === 'home' || art === 'homeBadge') {
    body = (
      <>
        <rect fill={SOFT} height={20} width={42} x={5} y={16} />
        {[0, 1, 2, 3].map((index) => (
          <g key={index}>
            <rect fill="#d6d6cf" height={9} width={9} x={5} y={41 + index * 13} />
            <rect fill={MID} height={2.5} width={26 - ((index * 7) % 12)} x={17} y={42.5 + index * 13} />
            <rect fill={SOFT} height={2} width={18} x={17} y={46.5 + index * 13} />
          </g>
        ))}
      </>
    );
  } else if (art === 'settings') {
    body = <SettingsRows widths={[18, 24, 14, 20, 16, 22]} />;
    tab = 3;
  } else if (art === 'settingsScrolled') {
    body = <SettingsRows shift={-5} widths={[22, 16, 20, 12, 24, 18, 15]} />;
    tab = 3;
  } else if (art === 'settingsOn') {
    body = <SettingsRows firstOn widths={[18, 24, 14, 20, 16, 22]} />;
    tab = 3;
  } else if (art === 'dialog') {
    body = (
      <>
        <SettingsRows shift={-5} widths={[22, 16, 20, 12, 24, 18, 15]} />
        <Header />
        <Tabs active={3} />
        <rect fill="#000" height={ART_HEIGHT} opacity={0.38} width={ART_WIDTH} />
        <rect fill="#fff" height={28} rx={3} width={38} x={7} y={38} />
        <rect fill={DARK} height={2.5} width={22} x={11} y={43} />
        <rect fill={SOFT} height={2} width={28} x={11} y={48} />
        <rect fill="#e3e3de" height={6} rx={2} width={13} x={11} y={55} />
        <rect fill="#1f3a5f" height={6} rx={2} width={13} x={27} y={55} />
      </>
    );
    tab = 3;
  } else if (art === 'articleA') {
    body = <Article image="#9db7c9" lines={[40, 38, 41, 30, 39, 36, 20]} title={34} />;
    tab = 1;
  } else {
    body = <Article image="#c9ab8c" lines={[39, 41, 35, 40, 33, 38, 26]} title={28} />;
    tab = 1;
  }
  // The dialog draws its own header and tabs, under the dimming.
  const dialog = art === 'dialog';
  return (
    <g>
      <rect fill={BG} height={ART_HEIGHT} width={ART_WIDTH} />
      {body}
      {dialog ? null : (
        <>
          <Header badge={art === 'homeBadge'} />
          <Tabs active={tab} />
        </>
      )}
    </g>
  );
}
