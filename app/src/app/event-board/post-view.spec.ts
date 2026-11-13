import { describe, expect, it } from 'vitest';
import type { Event, Role, Task } from '../event.model';
import { assignedPeople, buildPosts } from './post-view';

const person = '@volunteer';
const other = '@other_user';

function task(id: string, options: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: '',
    start: '',
    end: '',
    assignee: '',
    status: 'todo',
    ...options,
  };
}

function role(id: string, assignees: string[], tasks: Task[]): Role {
  return { id, title: id, description: 'Место поста', assignee: '', assignees, tasks };
}

function event(roles: Role[], tasks: Task[] = []): Event {
  return {
    id: 'test',
    title: 'Мероприятие',
    date: '',
    location: '',
    description: '',
    info: [],
    timeline: [],
    roles,
    tasks,
    revision: 1,
  };
}

describe('buildPosts', () => {
  it('keeps role order and groups inherited and explicit assignments for one person', () => {
    const plan = event(
      [
        role(
          'welcome',
          [person, other],
          [task('prepare', { status: 'done' }), task('escort', { assignees: [other] })],
        ),
        role('coatroom', [other], [task('chairs'), task('keys', { assignees: [other, person] })]),
        role('unrelated', [other], [task('out')]),
      ],
      [
        task('common-direct', { assignee: person }),
        task('common-other', { assignee: other }),
        task('common-open'),
      ],
    );

    const posts = buildPosts(plan, person);
    expect(
      posts.map((post) => [post.id, post.tasks.map((task) => task.id), post.done, post.total]),
    ).toEqual([
      ['welcome', ['prepare'], 1, 1],
      ['coatroom', ['keys'], 0, 1],
      [':common', ['common-direct'], 0, 1],
    ]);
    expect(posts[0].description).toBe('Место поста');
  });

  it('shows a role owned by the person even when its tasks are overridden', () => {
    const posts = buildPosts(
      event([role('post', [person], [task('override', { assignees: [other] })])]),
      person,
    );
    expect(posts).toMatchObject([{ id: 'post', tasks: [], done: 0, total: 0 }]);
  });

  it('shows all roles and common tasks without a selected person', () => {
    const posts = buildPosts(
      event(
        [role('common', [], []), role('other', [other], [task('first')])],
        [task('open'), task('assigned', { assignee: other, status: 'done' })],
      ),
      '',
    );
    expect(posts.map((post) => [post.id, post.done, post.total])).toEqual([
      ['common', 0, 0],
      ['other', 0, 1],
      [':common', 1, 2],
    ]);
    expect(buildPosts(event([]), '')).toEqual([]);
  });
});

describe('assignedPeople', () => {
  it('prefers the current assignee array and falls back to a legacy handle', () => {
    expect(assignedPeople({ assignee: person })).toEqual([person]);
    expect(assignedPeople({ assignee: person, assignees: [] })).toEqual([]);
  });
});
