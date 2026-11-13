import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  EMPTY,
  catchError,
  distinctUntilChanged,
  exhaustMap,
  interval,
  map,
  merge,
  startWith,
  switchMap,
  tap,
} from 'rxjs';
import { eventCoverUrl, STATUSES } from '../event.model';
import type { Event, Status, Task } from '../event.model';
import { OrganizerSession } from '../organizer-session';
import { TrackerApi, errorMessage } from '../tracker-api';
import { buildLivePlan, groupPlanTasks, type LiveState } from './live-plan';
import { assignedPeople, buildPosts, COMMON_POST_ID, taskAssignedTo } from './post-view';

type BoardPage = 'tasks' | 'plan' | 'team' | 'important';
type HelpAlert = { taskId: string; title: string; group: string };
const helpAlertDurationMs = 5 * 60_000;

const planLabels = {
  past: 'Прошло',
  current: 'Сейчас',
  upcoming: 'Далее',
  untimed: '',
} as const;

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

@Component({
  selector: 'app-event-board',
  imports: [NgTemplateOutlet],
  templateUrl: './event-board.html',
  host: {
    '(window:resize)': 'updateViewport()',
    '(document:visibilitychange)': 'refreshClock()',
  },
})
export class EventBoard {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(TrackerApi);
  protected readonly organizerSession = inject(OrganizerSession);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly carousel = viewChild<ElementRef<HTMLElement>>('postCarousel');
  private readonly importantHeading = viewChild<ElementRef<HTMLHeadingElement>>('importantHeading');
  private readonly helpTimers = new Map<string, ReturnType<typeof setTimeout>>();
  protected readonly helpAlerts = signal<HelpAlert[]>([]);
  private postScrollTimer?: ReturnType<typeof setTimeout>;
  private readonly selectedPostId = signal('');
  protected readonly mobile = signal(window.matchMedia?.('(max-width: 800px)').matches ?? false);
  private readonly now = signal(Math.floor(Date.now() / 60_000));

  protected readonly page = signal<BoardPage>('tasks');
  protected readonly planLabels = planLabels;
  protected readonly planDayLabels = {
    past: 'Дата мероприятия прошла',
    today: 'Сегодня',
    future: 'Предстоит',
    undated: 'Дата уточняется',
  } as const;

  protected readonly event = signal<Event | null>(null);
  protected readonly coverUrl = computed(() => {
    const event = this.event();
    return event ? eventCoverUrl(event) : null;
  });
  protected readonly tab = signal<'roles' | 'common'>('roles');
  protected readonly roleFilter = signal('');
  protected readonly personFilter = signal('');
  protected readonly loadingError = signal('');
  protected readonly saveError = signal('');
  protected readonly pending = signal(new Map<string, symbol>());
  protected readonly statuses = STATUSES;
  protected readonly posts = computed(() => {
    const event = this.event();
    return event ? buildPosts(event, this.personFilter()) : [];
  });
  protected readonly activePost = computed(
    () => this.posts().find((post) => post.id === this.selectedPostId()) ?? this.posts()[0],
  );
  private readonly tasks = computed(() => {
    const event = this.event();
    return event ? [...event.tasks, ...event.roles.flatMap((role) => role.tasks)] : [];
  });
  protected readonly total = computed(() => this.tasks().length);
  protected readonly done = computed(
    () => this.tasks().filter((task) => task.status === 'done').length,
  );
  protected readonly progress = computed(() =>
    this.total() ? (this.done() / this.total()) * 100 : 0,
  );
  protected readonly participants = computed(() => {
    const event = this.event();
    if (!event) return [];

    const people = [...event.roles.flatMap((role) => this.people(role))];
    for (const task of this.tasks()) people.push(...this.people(task));
    return [...new Set(people)].sort();
  });
  private readonly taskGroups = computed(() => {
    const event = this.event();
    if (!event) return [];
    return [
      ...event.roles,
      {
        id: COMMON_POST_ID,
        title: 'Общие задачи',
        description: '',
        assignee: '',
        tasks: event.tasks,
      },
    ];
  });
  private readonly personGroups = computed(() => {
    const person = this.personFilter();
    const groups = this.taskGroups();
    if (!person) return groups;
    return groups
      .map((role) => {
        const inherited = this.people(role);
        const tasks = role.tasks.filter((task) => taskAssignedTo(task, inherited, person));
        return { ...role, tasks };
      })
      .filter((role) => role.tasks.length > 0);
  });
  protected readonly editableTaskIds = computed(() => {
    if (!this.personFilter()) return new Set<string>();
    return new Set(this.personGroups().flatMap((group) => group.tasks.map((task) => task.id)));
  });
  protected readonly groups = computed(() => {
    const groups = this.personGroups();
    if (this.personFilter()) return groups;
    if (this.tab() === 'common') return groups.slice(-1);

    const roles = groups.slice(0, -1);
    const role = roles.find((candidate) => candidate.id === this.roleFilter());
    return role ? [role] : roles;
  });
  protected readonly livePlan = computed(() => {
    const event = this.event();
    return event ? buildLivePlan(event, new Date(this.now() * 60_000)) : null;
  });
  protected readonly planTasks = computed(() => {
    const plan = this.livePlan();
    return groupPlanTasks(plan?.schedule ?? [], this.tasks());
  });
  protected readonly team = computed(() => {
    const groups = this.taskGroups();
    return this.participants().map((person) => ({
      person,
      roles: groups
        .filter(
          (group) =>
            this.people(group).includes(person) ||
            group.tasks.some((task) => this.people(task).includes(person)),
        )
        .map((group) => group.title),
    }));
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.postScrollTimer);
      this.clearHelpAlerts();
    });
    effect(() => {
      if (!this.organizerSession.authenticated()) this.clearHelpAlerts();
    });
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshClock());

    this.route.paramMap
      .pipe(
        map((params) => params.get('id') ?? ''),
        distinctUntilChanged(),
        tap(() => {
          this.clearHelpAlerts();
          this.event.set(null);
          this.loadingError.set('');
          this.saveError.set('');
          this.pending.set(new Map());
          this.page.set('tasks');
          this.resetTaskFilters();
        }),
        switchMap((id) =>
          merge(
            interval(10_000).pipe(
              startWith(0),
              exhaustMap(() =>
                this.api.event(id).pipe(
                  catchError((error) => {
                    this.loadingError.set(errorMessage(error));
                    return EMPTY;
                  }),
                ),
              ),
            ),
            this.api.liveEvent(id),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        this.setLatest(event, true);
        this.loadingError.set('');
      });
  }

  protected refreshClock() {
    this.now.set(Math.floor(Date.now() / 60_000));
  }

  protected changePage(page: BoardPage) {
    if (this.page() === page) return;
    clearTimeout(this.postScrollTimer);
    this.page.set(page);
    this.refreshClock();
    if (page === 'tasks' && this.mobile()) this.alignPostAfterRender();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  protected showImportant() {
    if (this.page() === 'important') {
      window.scrollTo({ top: 0, behavior: 'instant' });
      this.importantHeading()?.nativeElement.focus({ preventScroll: true });
      return;
    }
    this.changePage('important');
    afterNextRender(() => this.importantHeading()?.nativeElement.focus({ preventScroll: true }), {
      injector: this.injector,
    });
  }

  protected showPersonTasks(person: string) {
    this.choosePerson(person);
    this.changePage('tasks');
  }

  protected choosePerson(person: string) {
    this.personFilter.set(person);
    const event = this.event();
    if (event) {
      try {
        const key = 'reglament-person:' + event.id;
        if (person) window.localStorage.setItem(key, person);
        else window.localStorage.removeItem(key);
      } catch {
        // The current selection still works when storage is unavailable.
      }
    }
    this.selectedPostId.set('');
    clearTimeout(this.postScrollTimer);
    if (this.mobile()) this.alignPostAfterRender();
  }

  protected choosePost(id: string) {
    clearTimeout(this.postScrollTimer);
    this.selectedPostId.set(id);
    this.alignPost();
  }

  protected postScrolled() {
    clearTimeout(this.postScrollTimer);
    this.postScrollTimer = setTimeout(() => {
      const track = this.carousel()?.nativeElement;
      if (!track) return;
      const left = track.getBoundingClientRect().left + track.clientLeft + 3;
      const cards = Array.from(track.querySelectorAll<HTMLElement>('[data-post-id]'));
      const closest = cards.reduce<HTMLElement | undefined>(
        (nearest, card) =>
          !nearest ||
          Math.abs(card.getBoundingClientRect().left - left) <
            Math.abs(nearest.getBoundingClientRect().left - left)
            ? card
            : nearest,
        undefined,
      );
      if (closest?.dataset['postId']) this.selectedPostId.set(closest.dataset['postId']);
    }, 120);
  }

  private alignPostAfterRender() {
    afterNextRender(() => this.alignPost(), { injector: this.injector });
  }

  private alignPost() {
    const track = this.carousel()?.nativeElement;
    const id = this.activePost()?.id;
    if (!track || !id) return;
    const card = Array.from(track.querySelectorAll<HTMLElement>('[data-post-id]')).find(
      (entry) => entry.dataset['postId'] === id,
    );
    if (!card) return;
    const offset =
      card.getBoundingClientRect().left - track.getBoundingClientRect().left - track.clientLeft - 3;
    track.scrollTo({ left: track.scrollLeft + offset, behavior: 'instant' });
  }

  protected resetTaskFilters(): void {
    this.tab.set('roles');
    this.roleFilter.set('');
    this.choosePerson('');
  }

  protected updateTask(task: Task, control: HTMLSelectElement): void {
    const status = this.statuses.find((option) => option.id === control.value)?.id;
    control.value = task.status;
    if (status) this.saveTaskStatus(task, status);
  }

  protected toggleTaskDone(task: Task): void {
    this.saveTaskStatus(task, task.status === 'done' ? 'todo' : 'done');
  }

  protected postStatus(tasks: readonly Task[]): Status {
    if (tasks.some((task) => task.status === 'blocked')) return 'blocked';
    if (tasks.length && tasks.every((task) => task.status === 'done')) return 'done';
    return tasks.some((task) => task.status === 'doing' || task.status === 'done')
      ? 'doing'
      : 'todo';
  }

  protected statusLabel(status: Status): string {
    return STATUSES.find((option) => option.id === status)?.label ?? '';
  }

  private saveTaskStatus(task: Task, status: Status): void {
    const event = this.event();
    const assignee = this.personFilter();
    if (
      !event ||
      !this.editableTaskIds().has(task.id) ||
      status === task.status ||
      this.pending().has(task.id)
    )
      return;

    const request = Symbol();
    this.pending.update((pending) => new Map(pending).set(task.id, request));
    this.saveError.set('');
    this.api
      .updateStatus(event.id, task.id, status, assignee)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          if (!this.finishUpdate(task.id, request)) return;
          this.setLatest(updated);
        },
        error: (error: unknown) => {
          if (!this.finishUpdate(task.id, request)) return;
          this.saveError.set(errorMessage(error));
        },
      });
  }

  protected formatDate(date: string): string {
    return dateFormat.format(new Date(date + 'T00:00:00Z'));
  }

  protected planLabel(state: LiveState): string {
    return this.planLabels[state];
  }

  protected formatPlanTime(start: string, end: string, point: boolean): string {
    if (start && !end) return point ? start : 'С ' + start;
    return this.formatTime(start, end);
  }

  protected formatTime(start: string, end: string): string {
    if (start && end) return start + '–' + end;
    if (start) return start;
    return end ? 'до ' + end : '';
  }

  protected infoLink(value: string): string | null {
    const link = value.trim();
    if (/^@[A-Za-z0-9_]{5,32}$/.test(link)) return this.telegram(link);
    if (/^https?:\/\/[^\s]+$/i.test(link)) return link;
    return null;
  }

  protected people(item: { assignee: string; assignees?: string[] }): string[] {
    return assignedPeople(item);
  }

  protected telegram(assignee: string): string {
    return 'https://t.me/' + assignee.slice(1);
  }

  protected dismissHelpAlert(taskId: string) {
    clearTimeout(this.helpTimers.get(taskId));
    this.helpTimers.delete(taskId);
    this.helpAlerts.update((alerts) => alerts.filter((alert) => alert.taskId !== taskId));
  }

  private clearHelpAlerts() {
    for (const timer of this.helpTimers.values()) clearTimeout(timer);
    this.helpTimers.clear();
    this.helpAlerts.set([]);
  }

  private notifyHelp(previous: Event, next: Event) {
    if (!this.organizerSession.authenticated()) return;
    const alreadyBlocked = new Set(
      [previous.tasks, ...previous.roles.map((role) => role.tasks)]
        .flat()
        .filter((task) => task.status === 'blocked')
        .map((task) => task.id),
    );
    const groups = [...next.roles, { title: 'Общие задачи', tasks: next.tasks }];
    for (const group of groups) {
      for (const task of group.tasks) {
        if (task.status !== 'blocked' || alreadyBlocked.has(task.id)) continue;
        this.dismissHelpAlert(task.id);
        this.helpAlerts.update((alerts) => [
          { taskId: task.id, title: task.title, group: group.title },
          ...alerts,
        ]);
        this.helpTimers.set(
          task.id,
          setTimeout(() => this.dismissHelpAlert(task.id), helpAlertDurationMs),
        );
      }
    }
  }

  protected updateViewport() {
    const mobile = window.matchMedia('(max-width: 800px)').matches;
    if (mobile === this.mobile()) return;
    this.mobile.set(mobile);
    if (mobile) this.alignPostAfterRender();
  }

  private finishUpdate(taskId: string, request: symbol): boolean {
    const pending = new Map(this.pending());
    if (pending.get(taskId) !== request) return false;
    pending.delete(taskId);
    this.pending.set(pending);
    return true;
  }

  private restorePerson(event: Event) {
    let person = '';
    try {
      person = window.localStorage.getItem('reglament-person:' + event.id) ?? '';
    } catch {
      return;
    }
    if (person && this.participants().includes(person)) this.personFilter.set(person);
  }

  private setLatest(next: Event, fromRefresh = false): void {
    const current = this.event();
    if (current && next.revision <= current.revision) {
      if (
        fromRefresh &&
        next.revision === current.revision &&
        next.coverVersion !== current.coverVersion
      ) {
        this.event.set({ ...current, coverVersion: next.coverVersion });
      }
      return;
    }
    this.event.set(
      current && !fromRefresh ? { ...next, coverVersion: current.coverVersion } : next,
    );
    if (current) this.notifyHelp(current, next);
    if (!current) this.restorePerson(next);
    if (this.roleFilter() && !next.roles.some((role) => role.id === this.roleFilter())) {
      this.roleFilter.set('');
    }
    if (this.personFilter() && !this.participants().includes(this.personFilter())) {
      this.choosePerson('');
    }
  }
}
