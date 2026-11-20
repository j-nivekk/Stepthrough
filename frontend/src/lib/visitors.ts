// Visitor accounts (backend/app/visitors.py): shared accounts whose projects are deleted a while after they were
// made, with an upload limit and a limit on what they keep. Pure functions, so they can be tested without a browser.

import type { SessionUser } from '../types';
import { formatRunShortTimestamp } from './formatters';

const MB = 1024 * 1024;

/** Whether this is a visitor account (never an administrator). */
export function isVisitor(user: SessionUser | null | undefined): boolean {
  return Boolean(user && !user.is_admin && user.tags.includes('visitor'));
}

/** Sizes as people read them, in MB as the settings are (`500 MB`, `2000 MB`), and in GB from 10 GB. */
export function formatSize(bytes: number): string {
  if (bytes >= 10 * 1024 * MB) return `${Math.round((bytes / (1024 * MB)) * 10) / 10} GB`;
  if (bytes < MB) return bytes > 0 ? 'under 1 MB' : '0 MB';
  return `${Math.round(bytes / MB)} MB`;
}

/** A keeping time as people read it: `72 hours`, `1 hour`. */
export function formatHours(hours: number): string {
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** How long until a moment, roughly: `in 20 hours`, `in 35 minutes`, `in a minute or so`. */
export function formatTimeLeft(at: string, now = Date.now()): string {
  const minutes = Math.floor((new Date(at).getTime() - now) / 60000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 2) return 'in a minute or so';
  if (minutes < 120) return `in ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} hours`;
  return `in ${Math.floor(hours / 24)} days`;
}

/** When a visitor's project goes, roughly: `deleted in 20 hours`. */
export function deletionLine(deletesAt: string, now = Date.now()): string {
  return `deleted ${formatTimeLeft(deletesAt, now)}`;
}

/** The moment itself: `22 nov, 14:05`. */
export function deletionDate(deletesAt: string): string {
  return formatRunShortTimestamp(deletesAt);
}

/** Whether the deletion is near enough to say so more firmly. */
export function deletionIsNear(deletesAt: string, now = Date.now()): boolean {
  return new Date(deletesAt).getTime() - now < 6 * 3600 * 1000;
}

/**
 * Why a file cannot be uploaded by this account, before it is sent; null when it can. A video is held to the
 * account's upload limit; any file (a video or a project file) to the room the account has left. The server checks
 * again: this only spares waiting for an upload that would be refused.
 */
export function uploadProblem(user: SessionUser | null | undefined, file: Pick<File, 'size'>, kind: 'video' | 'project'): string | null {
  const limits = isVisitor(user) ? user?.visitor : null;
  if (!limits) return null;
  if (kind === 'video' && file.size > limits.upload_limit_bytes) {
    return `larger than this account's ${formatSize(limits.upload_limit_bytes)} limit.`;
  }
  if (limits.storage_limit_bytes !== null && limits.storage_used_bytes !== null) {
    const room = limits.storage_limit_bytes - limits.storage_used_bytes;
    if (file.size > room) {
      return `does not fit: this account has ${formatSize(Math.max(0, room))} of ${formatSize(limits.storage_limit_bytes)} left.`;
    }
  }
  return null;
}

/**
 * What is wrong with a set of tags for one account, or null: a visitor account is a shared one already, so the two
 * tags never go together, and neither goes on an administrator. The server refuses the same (user_admin.py).
 */
export function tagProblem(tags: string[]): string | null {
  const has = new Set(tags.map((tag) => tag.trim()).filter(Boolean));
  if (has.has('admin') && has.has('shared')) return 'an administrator cannot be shared.';
  if (has.has('admin') && has.has('visitor')) return 'an administrator cannot be a visitor.';
  if (has.has('shared') && has.has('visitor')) return 'shared or visitor, not both: a visitor account is shared already.';
  return null;
}

/** The rows of a CSV list, as a spreadsheet saves it: commas, semicolons or tabs, and quoted fields. */
export function parseList(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const header = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, next) => (header.split(next).length > header.split(best).length ? next : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quoted) {
      if (char === '"' && clean[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && clean[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

/**
 * The rows of a list of people whose tags cannot go together (with the tags given for everyone), as the server
 * would skip them: row numbers count the header as 1, as in its report.
 */
export function listTagProblems(text: string, everyone: string[]): Array<{ row: number; name: string; problem: string }> {
  const [header, ...rows] = parseList(text);
  if (!header) return [];
  const columns = header.map((cell) => cell.trim().toLowerCase());
  const nameAt = columns.indexOf('name');
  const tagsAt = columns.indexOf('tags');
  const problems: Array<{ row: number; name: string; problem: string }> = [];
  rows.forEach((cells, index) => {
    const own = tagsAt >= 0 ? (cells[tagsAt] ?? '').split(/[,\s]+/) : [];
    const problem = tagProblem([...everyone, ...own]);
    if (problem) problems.push({ row: index + 2, name: (cells[nameAt] ?? '').trim(), problem });
  });
  return problems;
}
