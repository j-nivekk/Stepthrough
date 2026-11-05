import { CARET, phoneState } from './demoScript';

const CONTACTS = [
  { name: 'alex', colour: '#d9a46b' },
  { name: 'sam', colour: '#7aa6c2' },
  { name: 'robin', colour: '#9bbf8a' },
  { name: 'kim', colour: '#c58fb4' },
  { name: 'jo', colour: '#c7b46a' },
];

export interface DemoPhoneProps {
  t: number;
  /** Show what the analysis ignores (status bar, text cursor). */
  showMasks?: boolean;
  className?: string;
}

/** The demo recording at time t: a small messaging app, drawn rather than filmed. */
export function DemoPhone({ t, showMasks = false, className = '' }: DemoPhoneProps) {
  const state = phoneState(t);
  const keyboardHeight = 150 * state.keyboard;
  const caretWindow = t >= CARET.from && t < CARET.to;

  return (
    <div aria-hidden="true" className={`demo-phone ${className}`}>
      <div className="demo-phone-screen">
        <div className="demo-phone-status">
          <span>{state.clock}</span>
          <span className="demo-phone-status-icons">
            <i />
            <i />
            <b />
          </span>
        </div>

        <div className="demo-phone-pages">
          <section className="demo-phone-page" style={{ transform: `translateX(${-100 * state.slide}%)` }}>
            <p className="demo-phone-title">messages</p>
            {CONTACTS.map((contact, index) => (
              <div className={`demo-phone-row ${index === 1 && state.tapping ? 'tapped' : ''}`} key={contact.name}>
                <span className="demo-phone-avatar" style={{ background: contact.colour }} />
                <span className="demo-phone-row-text">
                  <strong>{contact.name}</strong>
                  <i style={{ width: `${48 + ((index * 17) % 30)}%` }} />
                </span>
                <small>{`9:${(38 - index * 3).toString().padStart(2, '0')}`}</small>
                {index === 1 && state.tapping ? <span className="demo-phone-ripple" /> : null}
              </div>
            ))}
          </section>

          <section className="demo-phone-page chat" style={{ transform: `translateX(${100 - 100 * state.slide}%)` }}>
            <p className="demo-phone-title chat">‹ sam</p>
            <div className="demo-phone-thread" style={{ bottom: 40 + keyboardHeight }}>
              <div className="demo-phone-messages" style={{ transform: `translateY(${150 * state.scroll}px)` }}>
                <span className="demo-phone-bubble in">lunch tomorrow?</span>
                <span className="demo-phone-bubble out">sure, the usual place</span>
                <span className="demo-phone-bubble in">great 🙂</span>
                <span className="demo-phone-bubble in">did you see the new menu?</span>
                <span className="demo-phone-bubble out">not yet</span>
                <span className="demo-phone-bubble in">are you coming tonight?</span>
                {state.sent > 0 ? (
                  <span className="demo-phone-bubble out" style={{ opacity: state.sent }}>
                    see you at six
                  </span>
                ) : null}
              </div>
            </div>
            <div className="demo-phone-input" style={{ bottom: keyboardHeight }}>
              <span>
                {state.typed}
                {caretWindow ? (
                  <em className={`demo-phone-caret ${state.caretOn ? 'on' : ''} ${showMasks ? 'masked' : ''}`} />
                ) : null}
                {!state.typed && !caretWindow ? <span className="demo-phone-placeholder">message</span> : null}
              </span>
            </div>
            <div className="demo-phone-keyboard" style={{ height: 150, transform: `translateY(${150 - keyboardHeight}px)` }}>
              {[10, 9, 7].map((keys, row) => (
                <div className="demo-phone-keys" key={row}>
                  {Array.from({ length: keys }, (_, key) => (
                    <i key={key} />
                  ))}
                </div>
              ))}
              <div className="demo-phone-keys">
                <i className="wide" />
              </div>
            </div>
          </section>
        </div>

        {state.toast > 0 ? (
          <div className="demo-phone-toast" style={{ opacity: state.toast }}>
            delivered
          </div>
        ) : null}

        {state.modal > 0 ? (
          <div className="demo-phone-modal" style={{ background: `rgba(0, 0, 0, ${0.38 * state.modal})` }}>
            <div className="demo-phone-dialog" style={{ opacity: state.modal, transform: `scale(${0.94 + 0.06 * state.modal})` }}>
              <strong>delete chat?</strong>
              <span>this cannot be undone.</span>
              <div>
                <i>cancel</i>
                <i className="danger">delete</i>
              </div>
            </div>
          </div>
        ) : null}

        {showMasks ? (
          <div className="demo-phone-mask status">
            <span>ignored</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
