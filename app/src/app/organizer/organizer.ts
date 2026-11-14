import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal, viewChild, ElementRef } from '@angular/core';
import { FormField, applyEach, form, maxLength, readonly, required, validate } from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { catchError, EMPTY, exhaustMap, firstValueFrom, interval, map, startWith } from 'rxjs';
import { errorMessage, TrackerApi } from '../tracker-api';
import { formatCoverImage } from '../cover-image';
import { OrganizerSession } from '../organizer-session';
import { eventCoverUrl, type Catalog, type Event, type EventInfo, type Task, type Template } from '../event.model';
import { WorkflowAdmin } from './workflow-admin';
import type { WorkflowAction, WorkflowView } from '../workflow.model';

const emptyEvent: EditableEvent = {
  id: '', revision: 0, title: '', date: '', location: '', description: '',
  roles: [], tasks: [], timeline: [], info: [],
};
type EditableTask = Omit<Task, 'assignees'>;
type InfoKind = 'field' | 'text';
type EditableEvent = Omit<Event, 'info' | 'tasks' | 'roles' | 'coverVersion'> & {
  info: (EventInfo & { kind: InfoKind })[];
  tasks: EditableTask[];
  roles: (Omit<Event['roles'][number], 'assignees' | 'tasks'> & { tasks: EditableTask[] })[];
};

function assignmentText(item: { assignee: string; assignees?: string[] }) {
  return (item.assignees ?? (item.assignee ? [item.assignee] : [])).join(', ');
}

function editableAssignment<T extends { assignee: string; assignees?: string[] }>(item: T) {
  const { assignees, ...rest } = item;
  return { ...rest, assignee: assignmentText({ assignee: item.assignee, assignees }) };
}

function assignmentList<T extends { assignee: string }>(item: T) {
  const assignees = item.assignee.split(/[\s,;]+/).filter(Boolean);
  return { ...item, assignees, assignee: assignees[0] ?? '' };
}

function toEditor(event: Event): EditableEvent {
  const { coverVersion: _coverVersion, managedWorkflow: _managedWorkflow, ...editable } = event;
  return {
    ...editable,
    info: event.info.map((item) => ({ ...item, kind: item.label.trim() ? 'field' : 'text' })),
    tasks: event.tasks.map(editableAssignment),
    roles: event.roles.map((role) => ({
      ...editableAssignment(role),
      tasks: role.tasks.map(editableAssignment),
    })),
  };
}

function fromEditor(event: EditableEvent): Event {
  return {
    ...event,
    info: event.info.map(({ id, kind, label, value }) => ({ id, label: kind === 'text' ? '' : label, value })),
    tasks: event.tasks.map(assignmentList),
    roles: event.roles.map((role) => ({
      ...assignmentList(role),
      tasks: role.tasks.map(assignmentList),
    })),
  };
}

const sections = [
  { id: 'intro', label: 'Вводные' },
  { id: 'timeline', label: 'Расписание' },
  { id: 'roles', label: 'Роли' },
  { id: 'tasks', label: 'Общие задачи' },
  { id: 'links', label: 'Ссылки' },
  { id: 'notifications', label: 'Уведомления' },
  { id: 'workflow', label: 'Рабочий режим' },
] as const;
type Section = typeof sections[number]['id'];

@Component({
  selector: 'app-organizer',
  imports: [FormField, RouterLink, NgTemplateOutlet, WorkflowAdmin],
  templateUrl: './organizer.html',
})
export class Organizer {
  private readonly api = inject(TrackerApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(OrganizerSession);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('actionDialog');
  private readonly importDialog = viewChild.required<ElementRef<HTMLDialogElement>>('importDialog');

  protected readonly templatesView = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('view') === 'templates')),
    { initialValue: this.route.snapshot.queryParamMap.get('view') === 'templates' },
  );
  protected readonly checking = signal(true);
  protected readonly authenticated = this.session.authenticated;
  protected readonly returnToEvent = toSignal(
    this.route.queryParamMap.pipe(map((params) => {
      const path = params.get('returnTo') ?? '';
      return /^\/e\/[A-Za-z0-9_-]{1,80}$/.test(path) ? path : '';
    })),
    { initialValue: '' },
  );
  protected readonly catalog = signal<Catalog>({ events: [], templates: [] });
  protected readonly baseline = signal<Event | null>(null);
  protected readonly visibleEditor = computed(() => this.templatesView() ? null : this.baseline());
  protected readonly coverUrl = computed(() => {
    const event = this.baseline();
    return event ? eventCoverUrl(event) : null;
  });
  protected readonly coverBusy = signal(false);
  protected readonly coverError = signal('');
  protected readonly coverFeedback = signal('');
  protected readonly draft = signal<EditableEvent>(emptyEvent);
  protected readonly editForm = form(this.draft, (field) => {
    required(field.title);
    applyEach(field.info, (item) => {
      maxLength(item.label, 120);
      maxLength(item.value, 4000);
      validate(item.label, ({ value, valueOf }) =>
        valueOf(item.kind) === 'field' && !value().trim()
          ? { kind: 'required', message: 'Укажите название поля.' }
          : undefined,
      );
      validate(item.value, ({ value, valueOf }) =>
        valueOf(item.kind) === 'text' && !value().trim()
          ? { kind: 'required', message: 'Введите текст.' }
          : undefined,
      );
    });
  });
  protected readonly dirty = computed(() => {
    const baseline = this.baseline();
    return !!baseline && JSON.stringify(toEditor(baseline)) !== JSON.stringify(this.draft());
  });
  protected readonly section = signal<Section>('intro');
  protected readonly addedRoleId = signal('');
  protected readonly sections = sections;
  protected readonly telegram = rxResource({
    params: () => this.authenticated() && this.section() === 'notifications'
      ? this.visibleEditor()?.id : undefined,
    stream: ({ params: eventId }) => this.api.telegramInfo(eventId),
  });
  protected readonly workflow = rxResource({
    params: () => this.authenticated() && this.section() === 'workflow' ? this.visibleEditor()?.id : undefined,
    stream: ({ params: id }) => interval(5000).pipe(
      startWith(0),
      exhaustMap((tick) => tick === 0 ? this.api.workflow(id) : this.api.workflow(id).pipe(catchError(() => EMPTY))),
      map((view) => {
        if (!this.workflowBusy()) this.changedWorkflow.set(null);
        return view;
      }),
    ),
  });
  protected readonly changedWorkflow = signal<{ id: string; view: WorkflowView } | null>(null);
  protected readonly workflowBusy = signal(false);
  protected readonly workflowError = signal('');
  protected readonly announcementLimit = 3000;
  protected readonly announcement = signal({ text: '' });
  protected readonly announcementBusy = signal(false);
  protected readonly announcementError = signal('');
  protected readonly announcementFeedback = signal('');
  protected readonly telegramError = errorMessage;
  protected readonly announcementForm = form(this.announcement, (field) => {
    required(field.text);
    maxLength(field.text, this.announcementLimit);
    readonly(field.text, () => this.announcementBusy());
  });
  protected readonly canAnnounce = computed(() => {
    if (!this.telegram.hasValue() || this.telegram.isLoading()) return false;
    const { botUrl, connected } = this.telegram.value();
    return !!botUrl && connected > 0 && !this.announcementBusy()
      && !this.announcementForm().invalid() && !!this.announcement().text.trim();
  });
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly feedback = signal('');
  protected readonly password = signal({ value: '' });
  protected readonly loginForm = form(this.password, (field) => required(field.value));
  protected readonly action = signal<'create' | 'template'>('create');
  protected readonly actionModel = signal({ title: '', date: '', templateId: '' });
  protected readonly actionForm = form(this.actionModel, (field) => required(field.title));
  protected readonly actionError = signal('');
  protected readonly importModel = signal({ json: '' });
  protected readonly importForm = form(this.importModel, (field) => {
    required(field.json);
    readonly(field.json, () => this.saving());
  });
  protected readonly importError = signal('');
  protected readonly importPrompt = signal('');
  protected readonly promptMessage = signal('');

  constructor() {
    void this.initialize();
  }

  private async initialize() {
    this.error.set('');
    this.checking.set(true);
    try {
      if (await this.session.check()) {
        const event = this.returnToEvent();
        if (event) await this.router.navigateByUrl(event, { replaceUrl: true });
        else await this.refreshCatalog();
      }
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.checking.set(false);
    }
  }

  protected async signIn(event: SubmitEvent) {
    event.preventDefault();
    if (this.loginForm().invalid() || this.saving()) return;
    await this.perform(async () => {
      await this.session.signIn(this.password().value);
      this.password.set({ value: '' });
      const returnTo = this.returnToEvent();
      if (returnTo) await this.router.navigateByUrl(returnTo, { replaceUrl: true });
      else await this.refreshCatalog();
    });
  }

  protected async signOut() {
    if (this.coverBusy() || !this.confirmDiscard()) return;
    await this.perform(async () => {
      await this.session.signOut();
      this.catalog.set({ events: [], templates: [] });
      this.baseline.set(null);
      this.draft.set(emptyEvent);
    });
  }

  protected openEvent(event: Event) {
    if (!this.confirmDiscard()) return;
    this.loadEditor(event);
  }

  canLeave() {
    return !this.coverBusy() && this.confirmDiscard();
  }

  protected closeEditor() {
    if (this.coverBusy() || !this.confirmDiscard()) return;
    this.baseline.set(null);
    this.draft.set(emptyEvent);
    this.error.set('');
  }

  protected openCreate(template?: Template) {
    if (!this.confirmDiscard()) return;
    this.openAction('create', template?.event.title ?? '', template?.id ?? '');
  }

  protected openImport() {
    if (!this.confirmDiscard()) return;
    this.importError.set('');
    this.promptMessage.set('');
    this.importDialog().nativeElement.showModal();
    if (!this.importPrompt()) {
      void firstValueFrom(this.api.importPrompt()).then(
        (prompt) => this.importPrompt.set(prompt),
        () => this.promptMessage.set('Не удалось загрузить промпт. Попробуйте открыть его по ссылке.'),
      );
    }
  }

  protected closeImport() {
    this.importDialog().nativeElement.close();
  }

  protected async copyPrompt() {
    try {
      await navigator.clipboard.writeText(this.importPrompt());
      this.promptMessage.set('Промпт скопирован');
    } catch {
      this.promptMessage.set('Откройте промпт по ссылке, чтобы скопировать его вручную.');
    }
  }

  protected async submitImport(event: SubmitEvent) {
    event.preventDefault();
    if (this.saving() || this.importForm().invalid()) return;
    this.importError.set('');
    let payload: unknown;
    try {
      payload = JSON.parse(this.importModel().json.trim());
    } catch {
      this.importError.set('Некорректный JSON. Вставьте один объект JSON без Markdown-разметки.');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.importError.set('Вставьте один объект JSON мероприятия в фигурных скобках.');
      return;
    }
    this.saving.set(true);
    try {
      const imported = await firstValueFrom(this.api.importEvent(payload));
      this.catalog.update((catalog) => ({ ...catalog, events: [imported, ...catalog.events] }));
      this.loadEditor(imported);
      this.importDialog().nativeElement.close();
      this.importModel.set({ json: '' });
      if (this.templatesView()) await this.router.navigate(['/admin']);
      this.feedback.set('Мероприятие импортировано');
    } catch (error) {
      this.importError.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected openSaveTemplate() {
    const event = this.baseline();
    if (event) this.openAction('template', event.title, '');
  }

  protected async submitAction(event: SubmitEvent) {
    event.preventDefault();
    if (this.actionForm().invalid() || this.saving()) return;
    this.actionError.set('');
    this.saving.set(true);
    const { title, date, templateId } = this.actionModel();
    try {
      if (this.action() === 'template') {
        await firstValueFrom(this.api.saveTemplate(this.draft().id, title));
        this.feedback.set('Шаблон сохранён');
      } else {
        const created = await firstValueFrom(this.api.createEvent(title, date, templateId || undefined));
        this.loadEditor(created);
        if (this.templatesView()) await this.router.navigate(['/admin']);
        this.feedback.set('Мероприятие создано');
      }
      this.dialog().nativeElement.close();
      try {
        await this.refreshCatalog();
      } catch (error) {
        this.error.set(errorMessage(error));
      }
    } catch (error) {
      this.actionError.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected closeAction() {
    this.dialog().nativeElement.close();
  }

  protected async save(event: SubmitEvent) {
    event.preventDefault();
    if (!this.dirty() || this.editForm().invalid() || this.saving() || this.coverBusy()) return;
    await this.perform(async () => {
      const saved = await firstValueFrom(this.api.saveEvent(fromEditor(this.draft())));
      this.baseline.set(saved);
      this.draft.set(toEditor(saved));
      this.catalog.update((catalog) => ({
        ...catalog,
        events: catalog.events.map((entry) => entry.id === saved.id ? saved : entry),
      }));
      this.feedback.set('Изменения сохранены');
    });
  }

  protected async chooseCover(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    await this.changeCover(async (id) => {
      let image: Blob;
      try {
        image = await formatCoverImage(file);
      } catch (error) {
        this.coverError.set(error instanceof Error ? error.message : 'Не удалось подготовить обложку.');
        return;
      }
      return firstValueFrom(this.api.uploadCover(id, image));
    }, 'Обложка сохранена');
  }

  protected async deleteCover() {
    await this.changeCover((id) => firstValueFrom(this.api.removeCover(id)), 'Обложка удалена');
  }

  private async changeCover(change: (id: string) => Promise<Event | undefined>, feedback: string) {
    const current = this.baseline();
    if (!current || this.coverBusy() || this.saving()) return;
    this.coverBusy.set(true);
    this.coverError.set('');
    this.coverFeedback.set('');
    try {
      const updated = await change(current.id);
      if (!updated) return;
      const { coverVersion } = updated;
      this.baseline.update((event) => event?.id === current.id ? { ...event, coverVersion } : event);
      this.catalog.update((catalog) => ({
        ...catalog,
        events: catalog.events.map((event) => event.id === current.id ? { ...event, coverVersion } : event),
      }));
      this.coverFeedback.set(feedback);
    } catch (error) {
      this.coverError.set(errorMessage(error));
    } finally {
      this.coverBusy.set(false);
    }
  }

  protected async reloadEvent() {
    if (this.coverBusy() || !this.confirmDiscard()) return;
    await this.perform(async () => {
      this.loadEditor(await firstValueFrom(this.api.event(this.draft().id)));
    });
  }

  protected selectSection(section: Section) {
    this.changedWorkflow.set(null);
    this.workflowError.set('');
    this.section.set(section);
  }

  protected async changeWorkflow(action: WorkflowAction) {
    const saved = this.visibleEditor();
    if (!saved || this.workflowBusy()) return;
    this.workflowBusy.set(true);
    this.workflowError.set('');
    try {
      const view = await firstValueFrom(this.api.applyWorkflow(saved.id, action));
      if (this.visibleEditor()?.id !== saved.id) return;
      this.changedWorkflow.set({ id: saved.id, view });
      if (action.action === 'enable') {
        this.baseline.set({ ...saved, managedWorkflow: true });
        this.catalog.update((catalog) => ({ ...catalog, events: catalog.events.map((event) =>
          event.id === saved.id ? { ...event, managedWorkflow: true } : event) }));
      }
    } catch (error) {
      if (this.visibleEditor()?.id === saved.id) this.workflowError.set(errorMessage(error));
    } finally {
      this.workflowBusy.set(false);
    }
  }

  protected async workflowTaskOverride(change: { taskId: string; completed: boolean; comment: string }) {
    const saved = this.visibleEditor();
    if (!saved || this.workflowBusy() || this.dirty()) return;
    this.workflowBusy.set(true);
    this.workflowError.set('');
    try {
      const updated = await firstValueFrom(this.api.overrideTask(saved.id, change.taskId, change.completed, change.comment));
      if (this.visibleEditor()?.id !== saved.id) return;
      this.baseline.set({ ...updated, managedWorkflow: true });
      this.draft.set(toEditor(this.baseline()!));
      this.catalog.update((catalog) => ({ ...catalog, events: catalog.events.map((event) =>
        event.id === saved.id ? this.baseline()! : event) }));
      this.refreshWorkflow();
    } catch (error) {
      if (this.visibleEditor()?.id === saved.id) this.workflowError.set(errorMessage(error));
    } finally {
      this.workflowBusy.set(false);
    }
  }

  protected refreshWorkflow() {
    this.changedWorkflow.set(null);
    this.workflow.reload();
  }

  protected async sendAnnouncement(event: SubmitEvent) {
    event.preventDefault();
    const current = this.visibleEditor();
    if (!current || !this.canAnnounce()) return;
    const draft = this.announcement();
    this.announcementBusy.set(true);
    this.announcementError.set('');
    this.announcementFeedback.set('');
    try {
      const { queued, recipients } = await firstValueFrom(this.api.announce(current.id, draft.text.trim()));
      if (this.visibleEditor()?.id !== current.id) return;
      if (queued > 0) {
        if (this.announcement() === draft) this.announcement.set({ text: '' });
        this.announcementFeedback.set(`Поставлено в очередь: ${queued} из ${recipients}. Бот отправит сообщения по мере обработки.`);
      } else {
        this.announcementFeedback.set('В очередь не добавлено ни одного сообщения. Обновите число подключённых участников.');
        this.telegram.reload();
      }
    } catch (error) {
      if (this.visibleEditor()?.id === current.id) this.announcementError.set(errorMessage(error));
    } finally {
      this.announcementBusy.set(false);
    }
  }

  protected addInfo(kind: InfoKind) {
    this.draft.update((event) => ({ ...event, info: [
      ...event.info, { id: crypto.randomUUID(), kind, label: '', value: '' },
    ] }));
  }

  protected addTime() {
    this.draft.update((event) => ({ ...event, timeline: [
      ...event.timeline, { id: crypto.randomUUID(), title: '', start: '', end: '', description: '' },
    ] }));
  }

  protected addRole() {
    const id = crypto.randomUUID();
    this.addedRoleId.set(id);
    this.draft.update((event) => ({ ...event, roles: [
      ...event.roles, { id, title: '', description: '', assignee: '', tasks: [] },
    ] }));
  }

  protected removeItem(list: 'info' | 'timeline' | 'roles', id: string) {
    this.draft.update((event) => ({ ...event, [list]: event[list].filter((entry) => entry.id !== id) }));
  }

  protected addTask(roleId?: string) {
    const task: Task = {
      id: crypto.randomUUID(), title: '', description: '', start: '', end: '', assignee: '', status: 'todo',
    };
    this.changeTasks((tasks) => [...tasks, task], roleId);
  }

  protected removeTask(taskId: string, roleId?: string) {
    this.changeTasks((tasks) => tasks.filter((task) => task.id !== taskId), roleId);
  }

  protected publicLink(id: string) {
    return new URL('/e/' + encodeURIComponent(id), window.location.origin).href;
  }

  protected async copy(link: string, input: HTMLInputElement) {
    try {
      await navigator.clipboard.writeText(link);
      this.feedback.set('Ссылка скопирована');
    } catch {
      input.focus();
      input.select();
    }
  }

  private changeTasks(change: (tasks: EditableTask[]) => EditableTask[], roleId?: string) {
    this.draft.update((event) => roleId
      ? { ...event, roles: event.roles.map((role) =>
          role.id === roleId ? { ...role, tasks: change(role.tasks) } : role,
        ) }
      : { ...event, tasks: change(event.tasks) });
  }

  private loadEditor(event: Event) {
    this.coverError.set('');
    this.coverFeedback.set('');
    this.announcement.set({ text: '' });
    this.announcementError.set('');
    this.announcementFeedback.set('');
    this.baseline.set(event);
    this.draft.set(toEditor(event));
    this.section.set('intro');
    this.addedRoleId.set('');
    this.error.set('');
    this.feedback.set('');
  }

  private openAction(action: 'create' | 'template', title: string, templateId: string) {
    this.action.set(action);
    this.actionModel.set({ title, date: '', templateId });
    this.actionError.set('');
    this.dialog().nativeElement.showModal();
  }

  private confirmDiscard() {
    return !this.dirty() || window.confirm('Оставить несохранённые изменения?');
  }

  private async refreshCatalog() {
    this.catalog.set(await firstValueFrom(this.api.catalog()));
  }

  private async perform(operation: () => Promise<void>) {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.feedback.set('');
    try {
      await operation();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}
