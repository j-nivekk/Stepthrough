import { useConfirm } from '../../../components/ConfirmDialog';
import { useReadTextQuestion } from '../../../components/ReadTextQuestion';
import { hasText, runTextNotice } from '../../../lib/stepText';
import type { RunText } from '../../../types';

interface RunTextControlProps {
  text: RunText;
  /** How many steps the run has. */
  total: number;
  /** Whether text can be read on this server; text read before can be searched either way. */
  available: boolean;
  pending: boolean;
  /** What is looked for in the text; null where there is nothing to filter (the pathway). */
  query: string | null;
  onQueryChange: (query: string) => void;
  onRead: () => void;
  onStop: () => void;
}

/** How far the reading of a run's text is, what to do about it, and a field to find words in it. */
export function RunTextControl({ text, total, available, pending, query, onQueryChange, onRead, onStop }: RunTextControlProps) {
  const notice = runTextNotice(text, total);
  const action = notice.action && (available || notice.action.does === 'stop') ? notice.action : null;
  const { confirm, dialog } = useConfirm();
  const question = useReadTextQuestion();

  async function read() {
    if (await confirm(question)) onRead();
  }
  return (
    <div className="run-text">
      {notice.label ? (
        <span
          aria-live="polite"
          className={`run-text-note ${notice.kind === 'problem' || notice.kind === 'earlier' ? 'is-warning' : ''}`}
          title={notice.title}
        >
          {notice.label}
        </span>
      ) : null}
      {action ? (
        <button
          className="analysis-task-link subtle"
          disabled={pending}
          onClick={action.does === 'read' ? () => void read() : onStop}
          title={notice.label ? undefined : notice.title}
          type="button"
        >
          {action.label}
        </button>
      ) : null}
      {query !== null && hasText(text) ? (
        <input
          aria-label="find text on the screens"
          className="run-text-find"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            if (query) onQueryChange('');
            else event.currentTarget.blur(); // so that the shortcuts of the step review work again
          }}
          placeholder="find text"
          title="show only the steps with these words on the screen; put words that belong together between quotation marks"
          type="search"
          value={query}
        />
      ) : null}
      {dialog}
    </div>
  );
}
