import { DatePipe, NgTemplateOutlet } from '@angular/common';
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
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  EMPTY,
  catchError,
  distinctUntilChanged,
  exhaustMap,
  from,
  firstValueFrom,
  interval,
  map,
  merge,
  mergeMap,
  Subject,
  startWith,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';
import { eventCoverUrl } from '../event.model';
import type { Event, Task } from '../event.model';
import { OrganizerSession } from '../organizer-session';
import { TrackerApi, errorMessage, type RoleSos } from '../tracker-api';
import { buildLivePlan, groupPlanTasks, type LiveState } from './live-plan';
import { assignedPeople, buildPosts, COMMON_POST_ID, taskAssignedTo } from './post-view';
import { PointWorkflow } from './point-workflow';
import type { WorkflowAction, WorkflowView } from '../workflow.model';

type BoardPage = 'tasks' | 'plan' | 'team' | 'important';
type BoardAlert = { key: string; kind: 'sos' | 'complete'; role: string; detail: string };
const alertDurationMs = { sos: 5 * 60_000, complete: 3 * 60_000 };

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
  imports: [DatePipe, NgTemplateOutlet, PointWorkflow],
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
  private readonly alertTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sosAlertExpiry = new Map<string, number>();
  protected readonly alerts = signal<BoardAlert[]>([]);
  protected readonly sosPending = signal(new Map<string, symbol>());
  protected readonly sosFeedback = signal(new Map<string, { text: string; error: boolean }>());
  private readonly sosActiveUntil = signal(new Map<string, number>());
  private readonly sosNow = signal(Date.now());
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
  protected readonly botUrl = signal<string | null>(null);
  protected readonly workflow = signal<WorkflowView | null>(null);
  protected readonly managedWorkflow = computed(
    () => !!(this.event()?.managedWorkflow || this.workflow()?.enabled),
  );
  protected readonly actualStages = computed(
    () => new Map(this.workflow()?.stages.map((stage) => [stage.stageId, stage])),
  );
  protected readonly workflowBusy = signal(false);
  protected readonly workflowError = signal('');
  protected readonly lastAppliedAction = signal<WorkflowAction | null>(null);
  protected readonly telegramLoginUrl = signal<string | null>(null);
  private readonly workflowRefresh = new Subject<void>();
  private readonly eventId = computed(() => this.event()?.id);
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
  protected readonly posts = computed(() => {
    const event = this.event();
    if (!event) return [];
    const workflow = this.workflow();
    if (
      !workflow?.enabled ||
      !this.personFilter() ||
      this.personFilter() !== workflow.actor?.username
    ) {
      return buildPosts(event, this.personFilter());
    }
    const ownRoles = new Set(workflow.points.map((point) => point.roleId));
    const assignedCommon = buildPosts(event, this.personFilter()).filter(
      (post) => post.id === COMMON_POST_ID,
    );
    return [...buildPosts(event, '').filter((post) => ownRoles.has(post.id)), ...assignedCommon];
  });
  protected readonly activePost = computed(
    () => this.posts().find((post) => post.id === this.selectedPostId()) ?? this.posts()[0],
  );
  protected readonly roleResponsibles = computed(
    () => new Map(this.event()?.roles.map((role) => [role.id, this.people(role)])),
  );
  protected readonly ownRoleIds = computed(
    () =>
      new Set(
        this.personFilter()
          ? this.posts()
              .map((post) => post.id)
              .filter((id) => id !== COMMON_POST_ID)
          : [],
      ),
    { equal: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)) },
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
    const workflow = this.workflow();
    if (workflow?.enabled && person === workflow.actor?.username) {
      const roles = new Set(workflow.points.map((point) => point.roleId));
      return groups.flatMap((role) => {
        if (roles.has(role.id)) return [role];
        if (role.id !== COMMON_POST_ID) return [];
        const tasks = role.tasks.filter((task) => taskAssignedTo(task, [], person));
        return tasks.length ? [{ ...role, tasks }] : [];
      });
    }
    return groups
      .map((role) => {
        const inherited = this.people(role);
        const tasks = role.tasks.filter((task) => taskAssignedTo(task, inherited, person));
        return { ...role, tasks };
      })
      .filter((role) => role.tasks.length > 0 || this.ownRoleIds().has(role.id));
  });
  protected readonly editableTaskIds = computed(() => {
    const workflow = this.workflow();
    if (this.managedWorkflow()) {
      const roles = new Set(
        workflow?.points.filter((point) => point.isSenior).map((point) => point.roleId),
      );
      return new Set(
        this.taskGroups()
          .filter((role) => roles.has(role.id))
          .flatMap((role) => role.tasks.map((task) => task.id)),
      );
    }
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
    if (!event) return null;
    const plan = buildLivePlan(event, new Date(this.now() * 60_000));
    if (!this.managedWorkflow()) return plan;
    const actual = this.actualStages();
    return {
      ...plan,
      schedule: plan.schedule.map((item) => ({
        ...item,
        state:
          actual.get(item.id)?.status === 'finished'
            ? ('past' as const)
            : actual.get(item.id)?.status === 'started'
              ? ('current' as const)
              : item.state,
      })),
    };
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
      this.clearAlerts();
    });
    effect(() => {
      if (!this.organizerSession.authenticated()) this.clearAlerts();
    });
    effect(() => {
      const id = this.eventId();
      const assignee = this.personFilter();
      const roles = this.ownRoleIds();
      if (id && assignee && !this.managedWorkflow())
        untracked(() => this.loadSosStates(id, assignee, roles));
    });
    const authentication = toObservable(computed(() => this.organizerSession.authenticated()));
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshClock());

    this.route.paramMap
      .pipe(
        map((params) => params.get('id') ?? ''),
        distinctUntilChanged(),
        tap(() => {
          this.clearAlerts();
          this.event.set(null);
          this.loadingError.set('');
          this.saveError.set('');
          this.pending.set(new Map());
          this.sosPending.set(new Map());
          this.sosFeedback.set(new Map());
          this.sosActiveUntil.set(new Map());
          this.page.set(
            this.route.snapshot.queryParamMap.get('view') === 'plan' ? 'plan' : 'tasks',
          );
          this.botUrl.set(null);
          this.workflow.set(null);
          this.workflowError.set('');
          this.workflowBusy.set(false);
          this.lastAppliedAction.set(null);
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
            authentication.pipe(
              switchMap(() =>
                this.api.liveEvent(
                  id,
                  (request) => this.showSos(request),
                  (request) => this.removeSos(request),
                  () => this.workflowRefresh.next(),
                ),
              ),
            ),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        this.setLatest(event, true);
        this.loadingError.set('');
      });

    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => this.page.set(params.get('view') === 'plan' ? 'plan' : 'tasks'));

    toObservable(this.eventId)
      .pipe(
        switchMap((id) => (id ? this.api.eventBot(id).pipe(catchError(() => EMPTY)) : EMPTY)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ botUrl }) => this.botUrl.set(botUrl));

    toObservable(this.eventId)
      .pipe(
        switchMap((id) =>
          id
            ? merge(this.workflowRefresh, interval(5000)).pipe(
                startWith(0),
                switchMap(() => this.api.workflow(id).pipe(catchError(() => EMPTY))),
              )
            : EMPTY,
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((view) => {
        const previous = this.workflow();
        this.workflow.set(view);
        if (view.actor?.isAdmin) this.notifyWorkflowSos(previous, view);
        if (view.actor?.username && view.actor.username !== previous?.actor?.username) {
          this.telegramLoginUrl.set(null);
          if (view.enabled) this.choosePerson(view.actor.username);
        }
        if (
          view.enabled &&
          (!previous?.enabled ||
            view.actor?.userId !== previous?.actor?.userId ||
            view.actor?.isAdmin !== previous?.actor?.isAdmin)
        ) {
          const id = this.eventId();
          if (id)
            this.api
              .event(id)
              .pipe(
                catchError(() => EMPTY),
                takeUntilDestroyed(this.destroyRef),
              )
              .subscribe((updated) => {
                if (this.eventId() === id && updated.revision >= (this.event()?.revision ?? 0))
                  this.event.set(updated);
              });
        }
      });
  }

  protected async startTelegramLogin() {
    this.workflowError.set('');
    try {
      this.telegramLoginUrl.set((await firstValueFrom(this.api.startTelegramLogin())).url);
    } catch (error) {
      this.workflowError.set(errorMessage(error));
    }
  }

  protected async endTelegramLogin() {
    try {
      await firstValueFrom(this.api.endTelegramLogin());
      this.telegramLoginUrl.set(null);
      this.choosePerson('');
      this.workflowRefresh.next();
    } catch (error) {
      this.workflowError.set(errorMessage(error));
    }
  }

  protected async applyWorkflow(action: WorkflowAction) {
    const id = this.eventId();
    if (!id || this.workflowBusy()) return;
    this.workflowBusy.set(true);
    this.workflowError.set('');
    try {
      const view = await firstValueFrom(this.api.applyWorkflow(id, action));
      if (this.eventId() === id) {
        this.workflow.set(view);
        this.lastAppliedAction.set(action);
      }
    } catch (error) {
      if (this.eventId() === id) this.workflowError.set(errorMessage(error));
    } finally {
      if (this.eventId() === id) {
        this.workflowBusy.set(false);
        this.workflowRefresh.next();
      }
    }
  }

  protected refreshClock() {
    const now = Date.now();
    this.now.set(Math.floor(now / 60_000));
    this.sosNow.set(now);
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

  protected toggleTaskDone(task: Task): void {
    this.saveTaskStatus(task, task.status === 'done' ? 'todo' : 'done');
  }

  private saveTaskStatus(task: Task, status: 'todo' | 'done'): void {
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

  protected toggleSos(roleId: string): void {
    const event = this.event();
    const assignee = this.personFilter();
    const key = this.sosKey(roleId);
    if (!event || !this.ownRoleIds().has(roleId) || this.sosPending().has(key)) return;

    const cancelling = this.sosActive(key);
    const request = this.startSos(key);
    this.sosFeedback.update((feedback) => {
      const next = new Map(feedback);
      next.delete(key);
      return next;
    });
    const update: Observable<number | null> = cancelling
      ? this.api.cancelSos(event.id, roleId, assignee).pipe(map(() => null))
      : this.api
          .requestSos(event.id, roleId, assignee)
          .pipe(map(({ expiresAt }) => expiresAt ?? Date.now() + alertDurationMs.sos));
    update.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (expiresAt) => {
        if (!this.finishSos(key, request)) return;
        this.setSosExpiry(key, expiresAt);
        const text = cancelling ? 'Запрос помощи отменён.' : 'Запрос помощи отправлен.';
        this.sosFeedback.update((feedback) => new Map(feedback).set(key, { text, error: false }));
      },
      error: (error: unknown) => {
        if (!this.finishSos(key, request)) return;
        this.sosFeedback.update((feedback) =>
          new Map(feedback).set(key, {
            text: errorMessage(error),
            error: true,
          }),
        );
        this.loadSosStates(event.id, assignee, [roleId]);
      },
    });
  }

  protected sosKey(roleId: string, assignee = this.personFilter()): string {
    return JSON.stringify([roleId, assignee]);
  }

  protected sosActive(key: string): boolean {
    return (this.sosActiveUntil().get(key) ?? 0) > this.sosNow();
  }

  private startSos(key: string): symbol {
    const request = Symbol();
    this.sosPending.update((pending) => new Map(pending).set(key, request));
    return request;
  }

  private finishSos(key: string, request: symbol): boolean {
    const pending = new Map(this.sosPending());
    if (pending.get(key) !== request) return false;
    pending.delete(key);
    this.sosPending.set(pending);
    return true;
  }

  private loadSosStates(id: string, assignee: string, roles: Iterable<string>): void {
    from(roles)
      .pipe(
        mergeMap((role) => {
          const key = this.sosKey(role, assignee);
          if (this.eventId() !== id || this.sosPending().has(key)) return EMPTY;
          const request = this.startSos(key);
          return this.api.sosStatus(id, role, assignee).pipe(
            tap(({ expiresAt }) => {
              if (this.finishSos(key, request)) this.setSosExpiry(key, expiresAt);
            }),
            catchError(() => {
              this.finishSos(key, request);
              return EMPTY;
            }),
          );
        }, 4),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private setSosExpiry(key: string, expiresAt: number | null): void {
    this.sosActiveUntil.update((current) => {
      const next = new Map(current);
      if (expiresAt && expiresAt > Date.now()) next.set(key, expiresAt);
      else next.delete(key);
      return next;
    });
  }

  protected formatDate(date: string): string {
    return dateFormat.format(new Date(date + 'T00:00:00Z'));
  }

  protected planLabel(state: LiveState): string {
    return this.planLabels[state];
  }

  protected formatPlanTime(start: string, end: string, point: boolean): string {
    if (start && start === end) return start;
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

  protected dismissAlert(key: string) {
    clearTimeout(this.alertTimers.get(key));
    this.alertTimers.delete(key);
    this.alerts.update((alerts) => alerts.filter((alert) => alert.key !== key));
  }

  private clearAlerts() {
    for (const timer of this.alertTimers.values()) clearTimeout(timer);
    this.alertTimers.clear();
    this.sosAlertExpiry.clear();
    this.alerts.set([]);
  }

  private showAlert(alert: BoardAlert, duration = alertDurationMs[alert.kind]) {
    if (!this.organizerSession.authenticated()) return;
    this.dismissAlert(alert.key);
    this.alerts.update((alerts) => [alert, ...alerts]);
    this.alertTimers.set(
      alert.key,
      setTimeout(() => this.dismissAlert(alert.key), duration),
    );
  }

  private showSos(request: RoleSos) {
    if (!this.organizerSession.authenticated()) return;
    const key = 'sos:' + this.sosKey(request.roleId, request.assignee);
    const now = Date.now();
    const expiresAt = request.expiresAt ?? now + alertDurationMs.sos;
    if (!Number.isFinite(expiresAt)) return;
    if (expiresAt <= now || this.sosAlertExpiry.get(key) === expiresAt) return;
    this.sosAlertExpiry.set(key, expiresAt);
    this.showAlert(
      {
        key,
        kind: 'sos',
        role: request.roleTitle,
        detail: request.assignee,
      },
      expiresAt - now,
    );
  }

  private notifyWorkflowSos(previous: WorkflowView | null, view: WorkflowView) {
    const active = new Set(
      view.requests
        .filter(
          (request) =>
            request.type === 'sos' && !['resolved', 'cancelled', 'closed'].includes(request.status),
        )
        .map((request) => request.id),
    );
    for (const request of previous?.requests ?? []) {
      if (request.type === 'sos' && !active.has(request.id))
        this.dismissAlert(`workflow-sos:${request.id}`);
    }
    const known = new Set(previous?.requests.map((request) => request.id));
    for (const request of view.requests) {
      const remaining = Date.parse(request.createdAt) + alertDurationMs.sos - Date.now();
      if (!active.has(request.id) || known.has(request.id) || !(remaining > 0)) continue;
      const point = view.points.find((entry) => entry.roleId === request.roleId);
      if (point)
        this.showAlert(
          {
            key: `workflow-sos:${request.id}`,
            kind: 'sos',
            role: point.title,
            detail: request.author,
          },
          remaining,
        );
    }
  }

  private removeSos(request: RoleSos): void {
    const key = 'sos:' + this.sosKey(request.roleId, request.assignee);
    this.sosAlertExpiry.delete(key);
    this.dismissAlert(key);
  }

  private notifyCompletedRoles(previous: Event, next: Event) {
    if (!this.organizerSession.authenticated()) return;
    const incompleteRoles = new Set(
      previous.roles
        .filter((role) => role.tasks.some((task) => task.status !== 'done'))
        .map((role) => role.id),
    );
    for (const role of next.roles) {
      if (
        !incompleteRoles.has(role.id) ||
        !role.tasks.length ||
        role.tasks.some((task) => task.status !== 'done')
      )
        continue;
      this.showAlert({
        key: `complete:${role.id}`,
        kind: 'complete',
        role: role.title,
        detail: 'Все задачи выполнены',
      });
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
    if (current && !this.managedWorkflow()) this.notifyCompletedRoles(current, next);
    if (!current) this.restorePerson(next);
    if (this.roleFilter() && !next.roles.some((role) => role.id === this.roleFilter())) {
      this.roleFilter.set('');
    }
    if (this.personFilter() && !this.participants().includes(this.personFilter())) {
      this.choosePerson('');
    }
  }
}
