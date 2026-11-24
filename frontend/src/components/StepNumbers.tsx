import { createContext, useCallback, useContext, type ReactNode } from 'react';

import { candidateNumber, type ReviewNumber } from '../lib/stepNumbers';
import type { CandidateFrame } from '../types';

type NumberOf = (candidate: CandidateFrame) => ReviewNumber;

const asFound: NumberOf = (candidate) => candidateNumber(candidate.detector_index);

const StepNumbersContext = createContext<NumberOf>(asFound);

/** Gives the step cards, rows and menus under it what to call each screenshot of the run (reviewNumbers). */
export function StepNumbersProvider({ numbers, children }: { numbers: Map<string, ReviewNumber>; children: ReactNode }) {
  const numberOf = useCallback<NumberOf>((candidate) => numbers.get(candidate.id) ?? asFound(candidate), [numbers]);
  return <StepNumbersContext.Provider value={numberOf}>{children}</StepNumbersContext.Provider>;
}

export const useStepNumbers = (): NumberOf => useContext(StepNumbersContext);
