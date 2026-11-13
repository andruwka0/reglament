import { describe, expect, it } from 'vitest';
import type { Task, TimelineItem } from '../event.model';
import { buildLivePlan, groupPlanTasks } from './live-plan';

const eventDate = '2026-11-15';
function item(id: string, start = '', end = ''): TimelineItem {
  return { id, title: id, description: '', start, end };
}

describe('buildLivePlan', () => {
  it('uses Moscow time across the UTC date change', () => {
    const plan = buildLivePlan(
      { date: eventDate, timeline: [item('opening', '00:00', '00:30')] },
      new Date('2026-11-14T21:00:00Z'),
    );
    expect(plan).toMatchObject({ date: eventDate, time: '00:00', relativeDay: 'today' });
    expect(plan.schedule[0].state).toBe('current');
  });

  it('orders timed entries, infers end from a later start and uses half-open intervals', () => {
    const timeline = [
      item('regatta', '16:30', '20:30'),
      item('cleanup', '20:30'),
      item('untimed'),
      item('opening', '14:00'),
      item('deadline', '', '15:00'),
      item('second-opening', '14:00'),
    ];
    const plan = buildLivePlan({ date: eventDate, timeline }, new Date('2026-11-15T13:30:00Z'));
    expect(plan.schedule.map((entry) => [entry.id, entry.state])).toEqual([
      ['opening', 'past'],
      ['second-opening', 'past'],
      ['deadline', 'past'],
      ['regatta', 'current'],
      ['cleanup', 'upcoming'],
      ['untimed', 'untimed'],
    ]);
    expect(plan.schedule[0]).toMatchObject({ end: '', effectiveEnd: '16:30' });
    expect(plan.schedule[4]).toMatchObject({ effectiveEnd: '00:00', effectiveEndNextDay: true });
    expect(timeline[0].id).toBe('regatta');
  });

  it('treats a start-only milestone at the start of a timed phase as a point', () => {
    const event = {
      date: eventDate,
      timeline: [item('posts-ready', '15:30'), item('check-in', '15:30', '16:30')],
    };
    const { schedule } = buildLivePlan(event, new Date('2026-11-15T12:42:00Z'));
    expect(schedule.map(({ id, state }) => [id, state])).toEqual([
      ['posts-ready', 'past'],
      ['check-in', 'current'],
    ]);
    expect(schedule[0].effectiveEnd).toBe('15:30');
  });

  it('treats end-only entries as deadlines with no active interval', () => {
    const event = { date: eventDate, timeline: [item('deadline', '', '15:30')] };
    expect(buildLivePlan(event, new Date('2026-11-15T12:29:00Z')).schedule[0].state).toBe(
      'upcoming',
    );
    expect(buildLivePlan(event, new Date('2026-11-15T12:30:00Z')).schedule[0].state).toBe('past');
  });

  it('keeps explicit overnight entries active on the next day until the end boundary', () => {
    const event = {
      date: eventDate,
      timeline: [item('overnight', '23:00', '01:00'), item('end-of-day', '23:30')],
    };
    const afterMidnight = buildLivePlan(event, new Date('2026-11-15T21:30:00Z'));
    expect(afterMidnight.relativeDay).toBe('past');
    expect(afterMidnight.schedule[0]).toMatchObject({
      state: 'current',
      effectiveEnd: '01:00',
      effectiveEndNextDay: true,
    });
    expect(afterMidnight.schedule[1].state).toBe('past');
    expect(buildLivePlan(event, new Date('2026-11-15T22:00:00Z')).schedule[0].state).toBe('past');
  });

  it('keeps undated schedules untimed and puts future events ahead of the clock', () => {
    const timeline = [item('start', '14:00', '15:00'), item('unknown')];
    const now = new Date('2026-11-14T11:30:00Z');
    const undated = buildLivePlan({ date: '', timeline }, now);
    expect(undated.relativeDay).toBe('undated');
    expect(undated.schedule.map((entry) => entry.state)).toEqual(['untimed', 'untimed']);
    const future = buildLivePlan({ date: eventDate, timeline }, now);
    expect(future.relativeDay).toBe('future');
    expect(future.schedule.map((entry) => entry.state)).toEqual(['upcoming', 'untimed']);
  });
});

describe('groupPlanTasks', () => {
  it('puts each task in one matching interval, preserving start and deadline boundaries', () => {
    const plan = buildLivePlan(
      {
        date: eventDate,
        timeline: [
          item('opening', '14:00', '15:30'),
          item('registration', '15:30', '16:30'),
          item('overlap', '15:45', '16:15'),
          item('point', '', '17:30'),
          item('overnight', '23:00', '01:00'),
        ],
      },
      new Date('2026-11-15T13:30:00Z'),
    );
    const task = (id: string, start = '', end = ''): Task => ({
      ...item(id, start, end),
      assignee: '',
      status: 'todo',
    });
    const tasks = [
      task('starts-at-boundary', '15:30'),
      task('deadline-at-boundary', '', '15:30'),
      task('latest-matching-range', '15:50'),
      task('no-time'),
      task('gap', '17:00'),
      task('point-matches', '17:30'),
      task('before-midnight', '23:45'),
      task('not-a-next-day-task', '00:30'),
      task('midnight-deadline', '', '00:00'),
    ];
    const { byItem, outside } = groupPlanTasks(plan.schedule, tasks);
    expect([...byItem].map(([id, tasks]) => [id, tasks.map((task) => task.id)])).toEqual([
      ['registration', ['starts-at-boundary']],
      ['opening', ['deadline-at-boundary']],
      ['overlap', ['latest-matching-range']],
      ['point', ['point-matches']],
      ['overnight', ['before-midnight']],
    ]);
    expect(outside.map((task) => task.id)).toEqual([
      'no-time',
      'gap',
      'not-a-next-day-task',
      'midnight-deadline',
    ]);
  });
});
