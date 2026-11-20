import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { extendVisitorProject, listVisitorProjects } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { deletionDate, deletionLine } from '../../lib/visitors';
import { NumberSetting, OptionalNumberSetting, useServerSettings } from './ServerSettingsPanel';

/**
 * The settings for visitor accounts (backend/app/visitors.py), with the people, under adding them: how long their
 * projects are kept, their largest upload and how much each may keep. Saved for everyone at once, as the server's
 * settings are. In the two text styles of the fields above: the rows' labels and the notes under them.
 */
export function VisitorSettings() {
  const { settings, save, message } = useServerSettings();
  const { confirm, dialog } = useConfirm();
  // a keeping time not confirmed goes back to the saved one
  const [keepResets, setKeepResets] = useState(0);

  /** A shorter keeping time deletes the visitors' projects older than it within minutes, so it asks first. */
  async function saveKeep(hours: number) {
    const current = settings?.visitor_keep_hours.value;
    if (current !== undefined && hours < current) {
      const confirmed = await confirm({
        message: `keep the projects of visitor accounts for ${hours} ${hours === 1 ? 'hour' : 'hours'}?`,
        detail: `visitors' projects made more than ${hours} ${hours === 1 ? 'hour' : 'hours'} ago are deleted within a few minutes. this cannot be undone.`,
        confirmLabel: 'shorten',
        danger: true,
      });
      if (!confirmed) {
        setKeepResets((count) => count + 1);
        return;
      }
    }
    save({ visitor_keep_hours: hours });
  }

  if (!settings) return null;
  return (
    <div className="users-visitor-settings">
      <div className="analysis-parameter-box">
        <div className="analysis-parameter-group">
          <NumberSetting
            key={`keep-${keepResets}`}
            label="visitors' projects kept"
            max={24 * 365}
            min={1}
            onSave={(value) => void saveKeep(value)}
            step={1}
            unit="h"
            value={settings.visitor_keep_hours.value}
          />
          <span className="analysis-parameter-annotation">
            accounts tagged visitor: shared accounts whose projects are deleted this long after they are made. default{' '}
            {settings.visitor_keep_hours.default} hours.
          </span>
        </div>

        <div className="analysis-parameter-group">
          <OptionalNumberSetting
            empty="server's"
            label="visitors' largest upload"
            max={1_000_000}
            onSave={(value) => save({ visitor_upload_mb: value })}
            unit="MB"
            value={settings.visitor_upload_mb.value}
          />
          <span className="analysis-parameter-annotation">
            per video. empty: the server's own limit.
          </span>
        </div>

        <div className="analysis-parameter-group">
          <OptionalNumberSetting
            empty="no date"
            label="visitor accounts kept"
            max={3650}
            onSave={(value) => save({ visitor_account_days: value })}
            unit="d"
            value={settings.visitor_account_days.value}
          />
          <span className="analysis-parameter-annotation">
            for an account given the visitor tag without a deletion date of its own. empty: no date.
          </span>
        </div>

        <div className="analysis-parameter-group">
          <OptionalNumberSetting
            empty="no limit"
            label="each visitor keeps at most"
            max={10_000_000}
            onSave={(value) => save({ visitor_storage_mb: value })}
            unit="MB"
            value={settings.visitor_storage_mb.value}
          />
          <span className="analysis-parameter-annotation">
            per account, videos and screenshots together. empty: no limit.
          </span>
        </div>
      </div>
      {message ? <p className={`analysis-guidance-copy ${message.tone === 'error' ? 'users-error' : ''}`}>{message.text}</p> : null}
      <VisitorProjects />
      {dialog}
    </div>
  );
}

/** From how many visitors' projects on the list gets a search field. */
const SEARCH_FROM = 6;

/**
 * The visitors' projects, the one deleted first first, each with a day more to give (a workshop that runs over).
 * There can be many, so the list is folded to one line (how many, and which goes next) until it is opened; open, it
 * scrolls within its own box, and from a handful on it can be searched by project or account.
 */
function VisitorProjects() {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({ queryKey: ['visitor-projects'], queryFn: listVisitorProjects, refetchInterval: 60_000 });
  const extend = useMutation({
    mutationFn: (projectId: string) => extendVisitorProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['visitor-projects'] }),
  });
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const projects = projectsQuery.data ?? [];
  const needle = search.trim().toLocaleLowerCase();
  const shown = needle
    ? projects.filter((project) => `${project.name} ${project.owners}`.toLocaleLowerCase().includes(needle))
    : projects;
  const next = projects[0];

  return (
    <div className="analysis-parameter-box users-visitor-projects">
      <div className="analysis-parameter-row">
        <span>
          {projects.length
            ? `${projects.length} ${projects.length === 1 ? 'visitor project' : 'visitor projects'}`
            : 'no visitor projects'}
        </span>
        {projects.length ? (
          <button
            aria-controls="users-visitor-project-list"
            aria-expanded={open}
            className="analysis-task-link subtle"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            {open ? 'hide' : 'show'}
          </button>
        ) : null}
      </div>
      {next ? (
        <span className="analysis-parameter-annotation" title={deletionDate(next.deletes_at)}>
          next: {next.name}, {deletionLine(next.deletes_at)}.
        </span>
      ) : null}
      {open && projects.length ? (
        <>
          {projects.length >= SEARCH_FROM ? (
            <input
              aria-label="search visitor projects and accounts"
              className="users-control users-visitor-search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="search projects and accounts"
              spellCheck={false}
              value={search}
            />
          ) : null}
          <div className="users-visitor-project-list" id="users-visitor-project-list" role="list">
            {shown.map((project) => (
              <div className="analysis-parameter-group" key={project.id} role="listitem">
                <div className="analysis-parameter-row">
                  <span className="users-visitor-project-name" title={project.name}>
                    {project.name}
                  </span>
                  <button
                    className="analysis-task-link subtle"
                    disabled={extend.isPending && extend.variables === project.id}
                    onClick={() => extend.mutate(project.id)}
                    title="keep it a day longer"
                    type="button"
                  >
                    +1 day
                  </button>
                </div>
                <span className="analysis-parameter-annotation" title={deletionDate(project.deletes_at)}>
                  {project.owners || 'no account'}, {deletionLine(project.deletes_at)}
                </span>
              </div>
            ))}
            {!shown.length ? <span className="analysis-parameter-annotation">none match.</span> : null}
          </div>
        </>
      ) : null}
      {extend.isError ? <p className="analysis-guidance-copy users-error">{extend.error.message.toLocaleLowerCase()}</p> : null}
    </div>
  );
}
