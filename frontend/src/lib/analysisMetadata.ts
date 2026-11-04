import type { AnalysisEngine, AnalysisMetadata } from '../types';

export function isAnalysisControlSupported(
  analysisMetadata: AnalysisMetadata | null | undefined,
  engine: AnalysisEngine,
  controlName: string,
): boolean {
  return analysisMetadata?.controls_by_engine[engine]?.[controlName]?.supported ?? true;
}

export function getAnalysisControlNote(
  analysisMetadata: AnalysisMetadata | null | undefined,
  engine: AnalysisEngine,
  controlName: string,
): string | null {
  return analysisMetadata?.controls_by_engine[engine]?.[controlName]?.note ?? null;
}
