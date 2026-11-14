export type Status = 'todo' | 'doing' | 'blocked' | 'done';

export const STATUSES: ReadonlyArray<{ id: Status; label: string }> = [
  { id: 'todo', label: 'К выполнению' },
  { id: 'doing', label: 'В работе' },
  { id: 'blocked', label: 'Нужна помощь' },
  { id: 'done', label: 'Готово' },
];

export interface Task {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  assignee: string;
  assignees?: string[];
  status: Status;
}

export interface Role {
  id: string;
  title: string;
  description: string;
  assignee: string;
  assignees?: string[];
  tasks: Task[];
}

export interface EventInfo {
  id: string;
  label: string;
  value: string;
}

export interface TimelineItem {
  id: string;
  title: string;
  start: string;
  end: string;
  description: string;
}

export interface EventSummary {
  id: string;
  title: string;
  date: string;
  location: string;
  coverVersion?: string;
}

export interface Event extends EventSummary {
  description: string;
  info: EventInfo[];
  timeline: TimelineItem[];
  roles: Role[];
  tasks: Task[];
  revision: number;
  managedWorkflow?: boolean;
}

export interface Template {
  id: string;
  title: string;
  event: Event;
}

export interface Catalog {
  events: Event[];
  templates: Template[];
}

export function eventCoverUrl(event: Pick<EventSummary, 'id' | 'coverVersion'>): string | null {
  if (!event.coverVersion) return null;
  return '/api/events/' + encodeURIComponent(event.id) + '/cover?v=' + encodeURIComponent(event.coverVersion);
}
