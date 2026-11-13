import type { Event, Task, TimelineItem } from '../event.model';

export const EVENT_TIME_ZONE = 'Europe/Moscow';
export type LiveState = 'past' | 'current' | 'upcoming' | 'untimed';
export type RelativeDay = 'past' | 'today' | 'future' | 'undated';

export interface LiveScheduleItem extends TimelineItem {
  state: LiveState;
  effectiveEnd: string;
  effectiveEndNextDay: boolean;
}

export interface LivePlan {
  date: string;
  time: string;
  relativeDay: RelativeDay;
  schedule: ReadonlyArray<LiveScheduleItem>;
}

const dayMinutes = 24 * 60;
const dayMilliseconds = dayMinutes * 60_000;
const wallClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: EVENT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function minutes(time: string): number | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

function timeLabel(total: number): string {
  const clock = total % dayMinutes;
  return [Math.floor(clock / 60), clock % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function dayNumber(date: string): number {
  return Date.parse(date + 'T00:00:00Z') / dayMilliseconds;
}

function scheduleState(start: number | null, end: number | null, now: number | null): LiveState {
  if (now === null || end === null) return 'untimed';
  if (now >= end) return 'past';
  if (start === null || now < start) return 'upcoming';
  return 'current';
}

export function buildLivePlan(event: Pick<Event, 'date' | 'timeline'>, now: Date): LivePlan {
  const parts = Object.fromEntries(
    wallClock.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const date = [parts['year'].padStart(4, '0'), parts['month'], parts['day']].join('-');
  const time = [parts['hour'], parts['minute']].join(':');
  const dayOffset = dayNumber(date) - dayNumber(event.date);
  const nowMinutes = Number.isFinite(dayOffset)
    ? dayOffset * dayMinutes + Number(parts['hour']) * 60 + Number(parts['minute'])
    : null;
  const relativeDay =
    nowMinutes === null ? 'undated' : dayOffset === 0 ? 'today' : dayOffset > 0 ? 'past' : 'future';

  const timed = event.timeline
    .map((entry) => ({ entry, start: minutes(entry.start), end: minutes(entry.end) }))
    .sort((a, b) => (a.start ?? a.end ?? dayMinutes) - (b.start ?? b.end ?? dayMinutes));
  const starts = timed.flatMap(({ start }) => (start === null ? [] : [start]));
  const explicitStarts = new Set(
    timed.flatMap(({ start, end }) =>
      start !== null && end !== null && start !== end ? [start] : [],
    ),
  );

  const schedule = timed.map(({ entry, start, end }): LiveScheduleItem => {
    let effectiveEnd = end;
    if (start !== null) {
      if (end === null) {
        effectiveEnd = explicitStarts.has(start)
          ? start
          : (starts.find((later) => later > start) ?? dayMinutes);
      } else if (end < start) effectiveEnd = end + dayMinutes;
    }
    return {
      ...entry,
      state: scheduleState(start, effectiveEnd, nowMinutes),
      effectiveEnd: effectiveEnd === null ? '' : timeLabel(effectiveEnd),
      effectiveEndNextDay: effectiveEnd !== null && effectiveEnd >= dayMinutes,
    };
  });
  return { date, time, relativeDay, schedule };
}

export function groupPlanTasks(
  schedule: readonly LiveScheduleItem[],
  tasks: readonly Task[],
): Map<string, Task[]> {
  const byItem = new Map<string, Task[]>();
  const slots = schedule.map((entry) => {
    const start = minutes(entry.start);
    const end = minutes(entry.effectiveEnd);
    return {
      id: entry.id,
      start,
      end: end === null || !entry.effectiveEndNextDay ? end : end + dayMinutes,
    };
  });

  for (const task of tasks) {
    const start = minutes(task.start);
    const time = start ?? minutes(task.end);
    if (time === null) continue;

    let range: { id: string; start: number } | undefined;
    let point: (typeof slots)[number] | undefined;
    for (const slot of slots) {
      if (slot.start === null || slot.end === null || slot.start === slot.end) {
        if (!point && time === (slot.start ?? slot.end)) point = slot;
        continue;
      }
      const contains =
        start === null
          ? slot.start < time && time <= slot.end
          : slot.start <= time && time < slot.end;
      if (contains && (!range || slot.start > range.start))
        range = { id: slot.id, start: slot.start };
    }

    const match = range ?? point;
    if (match) {
      const group = byItem.get(match.id) ?? [];
      group.push(task);
      byItem.set(match.id, group);
    }
  }
  return byItem;
}
