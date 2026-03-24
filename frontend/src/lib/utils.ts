import { absoluteApiUrl } from '../api';
import type { ExportBundle } from '../types';

export function jumpToAnchor(anchorId: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const target = document.getElementById(anchorId);
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  target.focus({ preventScroll: true });
}

export function createLocalId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

export function clampInteger(value: number, min?: number, max?: number): number {
  let nextValue = Math.round(value);
  if (typeof min === 'number') {
    nextValue = Math.max(min, nextValue);
  }
  if (typeof max === 'number') {
    nextValue = Math.min(max, nextValue);
  }
  return nextValue;
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function triggerDownload(url: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function getFilenameStem(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return 'stepthrough';
  }
  return trimmed.replace(/\.[^./\\]+$/, '');
}

export function buildReviewExportName(filename: string): string {
  return `${getFilenameStem(filename)}-review-export`;
}

export function normalizeZipFilename(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const sanitized = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.zip$/i, '');
  return sanitized ? `${sanitized}.zip` : null;
}

export function formatPlaybackTimestamp(timestampMs: number): string {
  const safeTimestamp = Math.max(0, Math.round(timestampMs));
  const totalSeconds = Math.floor(safeTimestamp / 1000);
  const milliseconds = safeTimestamp % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;
  return `${clock}.${String(milliseconds).padStart(3, '0')}`;
}

async function triggerNamedDownload(url: string, filename: string): Promise<void> {
  if (typeof document === 'undefined') {
    return;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not download the export bundle.');
  }

  const blob = await response.blob();
  const objectUrl = globalThis.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => {
    globalThis.URL.revokeObjectURL(objectUrl);
  }, 0);
}

export async function downloadExportBundle(bundle: ExportBundle, downloadName?: string): Promise<void> {
  const bundleUrl = absoluteApiUrl(bundle.zip_url);
  const normalizedDownloadName = typeof downloadName === 'string' ? normalizeZipFilename(downloadName) : null;

  if (normalizedDownloadName) {
    await triggerNamedDownload(bundleUrl, normalizedDownloadName);
    return;
  }

  triggerDownload(bundleUrl);
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function splitFilename(value: string): { base: string; extension: string } {
  const lastDotIndex = value.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex === value.length - 1) {
    return { base: value, extension: '' };
  }
  return {
    base: value.slice(0, lastDotIndex),
    extension: value.slice(lastDotIndex),
  };
}

export function joinFilename(base: string, extension: string): string {
  const normalizedBase = base.trim();
  return `${normalizedBase}${extension}`;
}

export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function describeFrameSkip(sampleFps: number | null, sourceFps: number | null): string | null {
  if (!sampleFps || !sourceFps) {
    return sourceFps ? `every frame (~${Math.round(sourceFps)} fps source)` : null;
  }
  const skip = Math.max(1, Math.round(sourceFps / sampleFps));
  return skip > 1
    ? `~every ${ordinal(skip)} frame (~${Math.round(sourceFps)} fps source)`
    : `every frame (~${Math.round(sourceFps)} fps source)`;
}
