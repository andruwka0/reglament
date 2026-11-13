import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event, Task } from '../event.model';
import { OrganizerSession } from '../organizer-session';
import { TrackerApi } from '../tracker-api';
import { EventBoard } from './event-board';

const assigned: Task = {
  id: 'first',
  title: 'Встретить гостей',
  description: '',
  start: '15:00',
  end: '16:00',
  assignee: '',
  status: 'todo',
};
const other: Task = { ...assigned, id: 'second', title: 'Получить ключ', assignee: '@volunteer' };
const common: Task = { ...assigned, id: 'third', title: 'Убрать площадку' };
const event: Event = {
  id: 'regatta',
  title: 'Регата',
  date: '2026-11-15',
  location: '2-й этаж',
  description: 'Инструкции команды',
  info: [],
  timeline: [],
  roles: [
    {
      id: 'welcome',
      title: 'Регистрация',
      description: '',
      assignee: '@legacy_owner',
      ...{ assignees: ['@organizer', '@guide_one', '@guide_two'] },
      tasks: [assigned, other],
    },
    {
      id: 'cloakroom',
      title: 'Гардероб',
      description: '',
      assignee: '@stale_owner',
      ...{ assignees: [] },
      tasks: [],
    },
  ],
  tasks: [common],
  revision: 1,
};

function render(fragment: string | null = null, initialEvent = event, authenticated = false) {
  const loadEvent = vi.fn().mockReturnValue(of(initialEvent));
  const updates = new Subject<Event>();
  const updateStatus = vi.fn().mockImplementation((_id, taskId, status) =>
    of({
      ...event,
      roles: [
        {
          ...event.roles[0],
          tasks: [assigned, other].map((task) => (task.id === taskId ? { ...task, status } : task)),
        },
        ...event.roles.slice(1),
      ],
      tasks: [taskId === common.id ? { ...common, status } : common],
      revision: 2,
    }),
  );
  TestBed.configureTestingModule({
    imports: [EventBoard],
    providers: [
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: new BehaviorSubject(convertToParamMap({ id: event.id })),
          fragment: new BehaviorSubject(fragment),
        },
      },
      {
        provide: TrackerApi,
        useValue: { event: loadEvent, liveEvent: () => updates, updateStatus },
      },
      { provide: OrganizerSession, useValue: { authenticated: () => authenticated } },
    ],
  });
  const fixture = TestBed.createComponent(EventBoard);
  fixture.detectChanges();
  const board: HTMLElement = fixture.nativeElement;
  const change = (control: HTMLSelectElement, value: string) => {
    control.value = value;
    control.dispatchEvent(new window.Event('change'));
    fixture.detectChanges();
  };
  return { board, fixture, loadEvent, updateStatus, change, updates };
}

describe('EventBoard', () => {
  afterEach(() => window.localStorage.removeItem('reglament-person:regatta'));

  it('restores a previously selected participant for the same event', () => {
    window.localStorage.setItem('reglament-person:regatta', '@volunteer');
    const { board, change } = render();
    const people = board.querySelector<HTMLSelectElement>('.person-filter select')!;
    expect(people.value).toBe('@volunteer');
    expect(board.querySelector('.task-main h3')?.textContent).toContain('Получить ключ');
    change(people, '');
    expect(window.localStorage.getItem('reglament-person:regatta')).toBeNull();
  });

  it('updates a role task for the selected participant', () => {
    const { board, updateStatus, change } = render();
    expect(board.querySelector('h1')?.textContent).toContain('Регата');
    expect(board.querySelectorAll('select.status')).toHaveLength(0);
    change(board.querySelector<HTMLSelectElement>('.person-filter select')!, '@volunteer');
    const controls = board.querySelectorAll<HTMLSelectElement>('select.status');
    expect(controls).toHaveLength(1);
    expect(controls[0].getAttribute('aria-label')).toContain('Получить ключ');
    change(controls[0], 'done');
    expect(updateStatus).toHaveBeenCalledWith('regatta', 'second', 'done', '@volunteer');
    expect(controls[0].value).toBe('done');
  });

  it('shows an unassigned common task as read-only', () => {
    const { board, fixture, updateStatus } = render('invite=old');
    const tabs = [...board.querySelectorAll<HTMLButtonElement>('button.tab')];
    tabs.find((tab) => tab.textContent?.includes('Общие'))?.click();
    fixture.detectChanges();
    expect(board.querySelector('.task-main h3')?.textContent).toContain('Убрать площадку');
    expect(board.querySelector('.task-status-readonly')?.textContent).toContain('К выполнению');
    expect(board.querySelector('select.status')).toBeNull();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('can focus on one role and return to all roles', () => {
    const { board, fixture } = render();
    expect(board.querySelectorAll('.role-card')).toHaveLength(2);
    const filter = board.querySelector<HTMLSelectElement>('.role-filter select')!;
    filter.value = 'cloakroom';
    filter.dispatchEvent(new window.Event('change'));
    fixture.detectChanges();
    expect(board.querySelectorAll('.role-card')).toHaveLength(1);
    expect(board.querySelector('.role-card h2')?.textContent).toContain('Гардероб');
    filter.value = '';
    filter.dispatchEvent(new window.Event('change'));
    fixture.detectChanges();
    expect(board.querySelectorAll('.role-card')).toHaveLength(2);
  });

  it('shows multiple role contacts separately from task contacts and keeps legacy contacts', () => {
    const { board } = render();
    const role = board.querySelector('.role-head .responsibles')!;
    expect(role.querySelectorAll('.responsibles-list > a')).toHaveLength(3);
    expect(role.querySelector('summary')?.textContent).toContain('Ещё 1');
    expect(role.textContent).not.toContain('@legacy_owner');
    expect(board.textContent).not.toContain('@stale_owner');
    const taskContacts = board.querySelectorAll('.task-responsibles');
    expect(taskContacts).toHaveLength(1);
    expect(taskContacts[0].textContent).toContain('@volunteer');
  });

  it('lists Telegram handles once and shows inherited, explicit and common tasks across roles', () => {
    const nick = '@organizer';
    const { board, fixture, change } = render(null, {
      ...event,
      roles: [
        event.roles[0],
        {
          ...event.roles[1],
          tasks: [
            {
              ...assigned,
              id: 'fourth',
              title: 'Проверить гардероб',
              assignees: ['@guide_one', nick],
            },
          ],
        },
      ],
      tasks: [{ ...common, assignee: nick }],
    });
    const roles = board.querySelector<HTMLSelectElement>('.role-filter select')!;
    change(roles, 'cloakroom');
    const people = board.querySelector<HTMLSelectElement>('.person-filter select')!;
    expect(
      [...people.options].map((option) => option.value).filter((value) => value === nick),
    ).toHaveLength(1);
    expect([...people.options].some((option) => option.value === '@volunteer')).toBe(true);

    const commonTab = board.querySelector<HTMLButtonElement>('button[aria-label="Общие задачи"]')!;
    commonTab.click();
    fixture.detectChanges();
    change(people, nick);
    expect(
      [...board.querySelectorAll('.task-main h3')].map((heading) => heading.textContent.trim()),
    ).toEqual(['Встретить гостей', 'Проверить гардероб', 'Убрать площадку']);
    expect(commonTab.disabled).toBe(true);
    expect(board.querySelector('.role-filter')).toBeNull();

    change(people, '');
    expect(
      [...board.querySelectorAll('.task-main h3')].map((heading) => heading.textContent.trim()),
    ).toEqual(['Убрать площадку']);
  });

  it('offers to clear an empty participant filter and resets a removed handle on refresh', () => {
    vi.useFakeTimers();
    const { board, fixture, loadEvent, change } = render(null, {
      ...event,
      roles: [{ ...event.roles[0], tasks: [other] }],
    });
    try {
      const people = board.querySelector<HTMLSelectElement>('.person-filter select')!;
      change(people, '@organizer');
      expect(board.querySelector('.empty-state')?.textContent).toContain('нет задач');
      board.querySelector<HTMLButtonElement>('.empty-state button')!.click();
      fixture.detectChanges();
      expect(people.value).toBe('');

      change(people, '@organizer');
      loadEvent.mockReturnValueOnce(
        of({
          ...event,
          roles: [{ ...event.roles[0], assignees: [], tasks: [other] }],
          revision: 2,
        }),
      );
      vi.advanceTimersByTime(10_000);
      fixture.detectChanges();
      expect(people.value).toBe('');
      expect(board.querySelector('.task-main h3')?.textContent).toContain('Получить ключ');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('refreshes the cover without a new task revision and removes it when cleared', () => {
    vi.useFakeTimers();
    const { board, fixture, loadEvent } = render();
    try {
      expect(board.querySelector('.event-cover')).toBeNull();
      loadEvent.mockReturnValueOnce(of({ ...event, coverVersion: 'new-cover' }));
      vi.advanceTimersByTime(10_000);
      fixture.detectChanges();
      expect(board.querySelector('.event-cover')?.getAttribute('src')).toBe(
        '/api/events/regatta/cover?v=new-cover',
      );
      vi.advanceTimersByTime(10_000);
      fixture.detectChanges();
      expect(board.querySelector('.event-cover')).toBeNull();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('keeps the saved status visible when the update fails', () => {
    const { board, updateStatus, change } = render();
    change(board.querySelector<HTMLSelectElement>('.person-filter select')!, '@volunteer');
    updateStatus.mockReturnValueOnce(throwError(() => new Error('offline')));
    const control = board.querySelector<HTMLSelectElement>('select.status')!;
    change(control, 'done');
    expect(control.value).toBe('todo');
    expect(board.querySelector('[role="alert"]')?.textContent).toContain('Не удалось');
  });

  it.each([true, false])('applies live help updates with organizer session %s', (authenticated) => {
    vi.useFakeTimers();
    const { board, fixture, updates } = render(null, event, authenticated);
    try {
      const next: Event = {
        ...event,
        roles: [
          { ...event.roles[0], tasks: [{ ...assigned, status: 'blocked' }, other] },
          event.roles[1],
        ],
        revision: 2,
      };
      updates.next(next);
      fixture.detectChanges();
      expect(board.querySelector('.task-status-readonly')?.textContent).toContain('Нужна помощь');
      expect(!!board.querySelector('.help-alert')).toBe(authenticated);
      vi.advanceTimersByTime(299_999);
      fixture.detectChanges();
      expect(!!board.querySelector('.help-alert')).toBe(authenticated);
      vi.advanceTimersByTime(1);
      fixture.detectChanges();
      expect(board.querySelector('.help-alert')).toBeNull();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
