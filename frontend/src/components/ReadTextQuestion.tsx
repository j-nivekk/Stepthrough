import { useQuery } from '@tanstack/react-query';
import { getSession } from '../api';
import type { ConfirmRequest } from './ConfirmDialog';

export const PAGE_XML_URL = 'https://github.com/PRImA-Research-Lab/PAGE-XML';

/** Asked before text is turned on for an analysis, or read for a run: it costs the server's time, everyone's, or on
 *  one's own computer (the app without logins) that computer's. */
export function readTextQuestion(ownComputer: boolean): ConfirmRequest {
  return {
    message: 'ocr (optical character recognition) is an experimental feature.',
    detail: (
      <>
        <p>
          ocr transcribes text from each screen, which can be exported as{' '}
          <a className="confirm-dialog-link" href={PAGE_XML_URL} rel="noreferrer" target="_blank">
            PageXML
            <span aria-hidden="true">↗</span>
          </a>{' '}
          or read in-app. this operation may take some time and slow down{' '}
          {ownComputer ? 'this computer' : 'the server for everyone'}.
        </p>
        <p>only use it if on-screen text is essential to your research.</p>
      </>
    ),
    caution: true,
  };
}

/** The question as it fits where the app runs: the session says whether people log in. */
export function useReadTextQuestion(): ConfirmRequest {
  // the query Root.tsx loads before the app shows, so it is there already
  const session = useQuery({ queryKey: ['session'], queryFn: getSession, retry: false, staleTime: Infinity });
  return readTextQuestion(session.data?.mode === 'none');
}
