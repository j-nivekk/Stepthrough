import type { AnalysisEngine, AnalysisMetadata, AnalysisPreset, HybridPresetMetadata, RunSettings } from '../types';

function fallbackPresetLabel(preset: AnalysisPreset): string {
  if (preset === 'subtle_ui') return 'subtle ui';
  if (preset === 'noise_resistant') return 'ignore noise';
  return 'balanced';
}

export function getHybridPresetMetadata(
  analysisMetadata: AnalysisMetadata | null | undefined,
  preset: AnalysisPreset,
): HybridPresetMetadata | null {
  return analysisMetadata?.hybrid_presets[preset] ?? null;
}

export function getHybridPresetLabel(
  analysisMetadata: AnalysisMetadata | null | undefined,
  preset: AnalysisPreset,
): string {
  return getHybridPresetMetadata(analysisMetadata, preset)?.label ?? fallbackPresetLabel(preset);
}

export function getHybridPresetRuntimeValues(
  analysisMetadata: AnalysisMetadata | null | undefined,
  preset: AnalysisPreset,
): {
  minDwellMs: number | null;
  ocrTriggerThreshold: number | null;
  proposalThreshold: number | null;
  sampleFps: number | null;
  settleThreshold: number | null;
  settleWindowMs: number | null;
} {
  const metadata = getHybridPresetMetadata(analysisMetadata, preset);
  return {
    sampleFps: metadata?.sample_fps ?? null,
    minDwellMs: metadata?.min_dwell_ms ?? null,
    settleWindowMs: metadata?.settle_window_ms ?? null,
    proposalThreshold: metadata?.proposal_threshold ?? null,
    settleThreshold: metadata?.settle_threshold ?? null,
    ocrTriggerThreshold: metadata?.ocr_trigger_threshold ?? null,
  };
}

export function getHybridEffectiveSampleFps(
  settings: Pick<RunSettings, 'analysis_preset' | 'advanced'>,
  analysisMetadata: AnalysisMetadata | null | undefined,
): number | null {
  return settings.advanced?.sample_fps_override ?? getHybridPresetRuntimeValues(analysisMetadata, settings.analysis_preset).sampleFps;
}

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
