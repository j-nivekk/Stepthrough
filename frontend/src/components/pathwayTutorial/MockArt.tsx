import type { ReactNode } from 'react';

import type { MockArt as Art } from './tutorialModel';

export const ART_WIDTH = 52;
export const ART_HEIGHT = 106;

const BG = '#f6f6f3';
const BAR = '#dcdcd6';
const SOFT = '#cfcfc8';
const MID = '#a7a7a0';
const DARK = '#7d7d76';

function Header() {
  return (
    <>
      <rect fill={BAR} height={12} width={ART_WIDTH} />
      <rect fill={DARK} height={2.5} width={16} x={5} y={5} />
      <circle cx={45} cy={6} fill={MID} r={2.3} />
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

/** Home, with a feed: the same place whatever is in it. */
function Home({ banner, thumbs, widths }: { banner: string; thumbs: string[]; widths: number[] }) {
  return (
    <>
      <rect fill={banner} height={20} width={42} x={5} y={16} />
      {thumbs.map((thumb, index) => (
        <g key={index}>
          <rect fill={thumb} height={9} width={9} x={5} y={41 + index * 13} />
          <rect fill={MID} height={2.5} width={widths[index]} x={17} y={42.5 + index * 13} />
          <rect fill={SOFT} height={2} width={18} x={17} y={46.5 + index * 13} />
        </g>
      ))}
    </>
  );
}

/** A product: its photo, name and price are its own, and all the rest is the same on every product. */
function Product({ image, name, price }: { image: string; name: number; price: number }) {
  return (
    <>
      <rect fill={image} height={24} width={42} x={5} y={16} />
      <rect fill={DARK} height={3} width={name} x={5} y={44} />
      <rect fill={MID} height={2.5} width={price} x={5} y={49.5} />
      {[5, 16, 27, 38].map((x) => (
        <rect fill="none" height={6} key={x} rx={1} stroke={MID} strokeWidth={0.8} width={9} x={x} y={56} />
      ))}
      <rect fill="#1f3a5f" height={7} rx={2} width={42} x={5} y={66} />
      {[40, 36, 41].map((width, index) => (
        <rect fill={SOFT} height={2} key={index} width={width} x={5} y={78 + index * 5.5} />
      ))}
    </>
  );
}

/** A screen of the practice app, drawn as a wireframe in a 52 × 106 box. */
export function MockArt({ art }: { art: Art }) {
  let body: ReactNode;
  let tab = 0;
  if (art === 'home') {
    body = <Home banner={SOFT} thumbs={['#d6d6cf', '#d6d6cf', '#d6d6cf', '#d6d6cf']} widths={[26, 19, 24, 17]} />;
  } else if (art === 'homeNew') {
    body = <Home banner="#b9a7c9" thumbs={['#c9b3a7', '#a7c0b0', '#c9c2a0', '#a9b4c9']} widths={[15, 27, 20, 25]} />;
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
  } else if (art === 'productA') {
    body = <Product image="#9db7c9" name={34} price={12} />;
    tab = 1;
  } else {
    body = <Product image="#c9ab8c" name={22} price={15} />;
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
          <Header />
          <Tabs active={tab} />
        </>
      )}
    </g>
  );
}
