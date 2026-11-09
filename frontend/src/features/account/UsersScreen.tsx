import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { listUsers } from '../../api';
import type { AdminUser } from '../../types';
import { AddPeoplePanel } from './AddPeoplePanel';
import { UserBatchBar } from './UserBatchBar';
import { UserRow } from './UserRow';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface UsersScreenProps {
  currentUserId: string;
  onBack: () => void;
}

/** The administrators' page, built like the analysis page: a column to add people, and the people themselves. */
export function UsersScreen({ currentUserId, onBack }: UsersScreenProps) {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: ['admin-users'], queryFn: listUsers });
  const users = usersQuery.data ?? [];
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'recent'>('name');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const nowMs = Date.now();

  const visibleUsers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = users.filter((user) =>
      [user.name, user.display_name ?? '', ...user.tags].some((value) => value.toLowerCase().includes(needle)),
    );
    if (sort === 'recent') {
      const seen = (user: AdminUser) => (user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0);
      return [...matches].sort((left, right) => seen(right) - seen(left) || left.name.localeCompare(right.name));
    }
    return matches;
  }, [search, sort, users]);

  // Handing over or deleting projects changes the project list too.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
    ]);

  // Selections survive searching, so a group can be put together from several searches.
  const selectedUsers = users.filter((user) => selectedIds.has(user.id));
  const selectableVisible = visibleUsers.filter((user) => !user.is_builtin);

  function toggleSelected(userId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function leaveSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  const adminCount = users.filter((user) => user.is_admin && !user.is_builtin).length;
  const switchedOffCount = users.filter((user) => user.is_disabled).length;
  const peopleCount = users.filter((user) => !user.is_builtin).length;

  return (
    <div className="analysis-screen admin-tint">
      <div className="analysis-stage-shell">
        <div className="analysis-stage-nav">
          <nav aria-label="pages" className="stage-pill">
            <span aria-hidden="true" className="stage-pill-dot" />
            <button className="stage-pill-btn" onClick={onBack} type="button">
              projects
            </button>
            <span aria-hidden="true" className="stage-pill-sep">·</span>
            <button aria-current="page" className="stage-pill-btn stage-pill-btn--active" disabled type="button">
              users
            </button>
          </nav>
        </div>

        <div className="users-grid">
          <AddPeoplePanel
            onChanged={() => {
              setNotice('');
              return refresh();
            }}
          />

          <section className="analysis-column users-people-column">
            <div className="analysis-column-head">
              <p>people</p>
              <div className="analysis-task-filter-tabs">
                <button
                  className={`analysis-task-filter-button ${sort === 'name' ? 'active' : ''}`}
                  onClick={() => setSort('name')}
                  type="button"
                >
                  a-z
                </button>
                <button
                  className={`analysis-task-filter-button ${sort === 'recent' ? 'active' : ''}`}
                  onClick={() => setSort('recent')}
                  type="button"
                >
                  last seen
                </button>
              </div>
            </div>
            <div className="analysis-divider" />

            <div className="users-people-tools">
              <div className="users-search-group">
                <input
                  aria-label="search names and tags"
                  className="entry-project-search"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="search names and tags"
                  value={search}
                />
                {selectMode ? (
                  <>
                    <button
                      className="analysis-task-link subtle"
                      disabled={!selectableVisible.length}
                      onClick={() => setSelectedIds((current) => new Set([...current, ...selectableVisible.map((user) => user.id)]))}
                      type="button"
                    >
                      {search.trim() ? 'all found' : 'all'}
                    </button>
                    <button
                      className="analysis-task-link subtle"
                      disabled={!selectedIds.size}
                      onClick={() => setSelectedIds(new Set())}
                      type="button"
                    >
                      none
                    </button>
                    <button className="analysis-task-link subtle" onClick={leaveSelectMode} type="button">
                      done
                    </button>
                  </>
                ) : (
                  <button
                    className="analysis-task-link subtle"
                    onClick={() => {
                      setSelectMode(true);
                      setNotice('');
                    }}
                    title="select several people to change them together"
                    type="button"
                  >
                    select
                  </button>
                )}
              </div>
              <span className="users-count">
                {selectMode
                  ? `${selectedIds.size} of ${plural(peopleCount, 'person', 'people')} selected`
                  : `${plural(peopleCount, 'person', 'people')}${
                      adminCount ? ` · ${plural(adminCount, 'administrator', 'administrators')}` : ''
                    }${switchedOffCount ? ` · ${switchedOffCount} switched off` : ''}`}
              </span>
            </div>
            {selectMode && (
              <UserBatchBar
                currentUserId={currentUserId}
                onFinished={(message, deletedIds) => {
                  setNotice(message);
                  if (deletedIds?.length) {
                    setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.includes(id))));
                  }
                  void refresh();
                }}
                onOpen={() => setNotice('')}
                selected={selectedUsers}
              />
            )}
            {notice && <p className="analysis-guidance-copy users-notice">{notice}</p>}

            <div className="users-list">
              {visibleUsers.map((user) => (
                <UserRow
                  currentUserId={currentUserId}
                  key={user.id}
                  onToggleSelected={() => toggleSelected(user.id)}
                  selectMode={selectMode}
                  selected={selectedIds.has(user.id)}
                  nowMs={nowMs}
                  onChanged={(message) => {
                    setNotice(message ?? '');
                    void refresh();
                  }}
                  user={user}
                />
              ))}
              {usersQuery.isLoading && <p className="entry-empty-copy">loading…</p>}
              {usersQuery.isError && <p className="entry-empty-copy">{usersQuery.error.message}</p>}
              {users.length > 0 && !visibleUsers.length && <p className="entry-empty-copy">nobody matches that search.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
