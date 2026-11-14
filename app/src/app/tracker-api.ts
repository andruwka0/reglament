import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { Catalog, Event, Status, Template } from './event.model';
import type { WorkflowAction, WorkflowView } from './workflow.model';

export interface RoleSos {
  roleId: string;
  roleTitle: string;
  assignee: string;
  expiresAt?: number;
}

@Service()
export class TrackerApi {
  private readonly http = inject(HttpClient);

  event(id: string) {
    return this.http.get<Event>(this.eventPath(id));
  }

  liveEvent(
    id: string,
    onSos: (request: RoleSos) => void = () => {},
    onSosCancelled: (request: RoleSos) => void = () => {},
    onWorkflow: () => void = () => {},
  ): Observable<Event> {
    return new Observable((subscriber) => {
      if (typeof EventSource === 'undefined') {
        subscriber.complete();
        return;
      }
      const source = new EventSource(this.eventPath(id) + '/stream');
      source.addEventListener('message', (message) => {
        let snapshot: Event | null;
        try {
          snapshot = JSON.parse(message.data);
        } catch {
          return;
        }
        if (snapshot?.id === id && Number.isSafeInteger(snapshot.revision))
          subscriber.next(snapshot);
      });
      const listenForSos = (name: string, handle: (request: RoleSos) => void) =>
        source.addEventListener(name, (message) => {
          let request: RoleSos | null;
          try {
            request = JSON.parse((message as MessageEvent<string>).data);
          } catch {
            return;
          }
          if (
            typeof request?.roleId === 'string' &&
            typeof request.roleTitle === 'string' &&
            typeof request.assignee === 'string'
          ) {
            handle(request);
          }
        });
      listenForSos('sos', onSos);
      listenForSos('sos-cancelled', onSosCancelled);
      source.addEventListener('workflow', onWorkflow);
      return () => source.close();
    });
  }

  updateStatus(id: string, taskId: string, status: Status, assignee: string) {
    const path = this.eventPath(id) + '/tasks/' + encodeURIComponent(taskId) + '/status';
    return this.http.post<Event>(path, { status, assignee });
  }

  workflow(id: string) {
    return this.http.get<WorkflowView>(this.eventPath(id) + '/workflow');
  }

  applyWorkflow(id: string, action: WorkflowAction) {
    return this.http.post<WorkflowView>(this.eventPath(id) + '/workflow', action);
  }

  overrideTask(id: string, taskId: string, completed: boolean, comment: string) {
    return this.http.post<Event>(
      this.eventPath(id) + '/tasks/' + encodeURIComponent(taskId) + '/status',
      {
        status: completed ? 'done' : 'todo',
        comment,
      },
    );
  }

  startTelegramLogin() {
    return this.http.post<{ url: string | null }>('/api/telegram/login', {});
  }

  endTelegramLogin() {
    return this.http.delete('/api/telegram/login');
  }

  requestSos(id: string, roleId: string, assignee: string) {
    return this.http.post<{ sent: true; expiresAt?: number }>(this.sosPath(id, roleId), {
      assignee,
    });
  }

  cancelSos(id: string, roleId: string, assignee: string) {
    return this.http.delete<{ cancelled: true }>(this.sosPath(id, roleId), { body: { assignee } });
  }

  sosStatus(id: string, roleId: string, assignee: string) {
    return this.http.get<{ expiresAt: number | null }>(this.sosPath(id, roleId), {
      params: { assignee },
    });
  }

  session() {
    return this.http.get<{ authenticated: boolean }>('/api/admin/session');
  }

  login(password: string) {
    return this.http.post<{ authenticated: boolean }>('/api/admin/login', { password });
  }

  logout() {
    return this.http.post<{ authenticated: boolean }>('/api/admin/logout', {});
  }

  catalog() {
    return this.http.get<Catalog>('/api/admin/catalog');
  }

  eventBot(id: string) {
    return this.http.get<{ botUrl: string | null }>(this.eventPath(id) + '/telegram');
  }

  telegramInfo(id: string) {
    return this.http.get<{ botUrl: string | null; recipients: number; connected: number }>(
      '/api/admin/events/' + encodeURIComponent(id) + '/telegram',
    );
  }

  announce(id: string, text: string) {
    return this.http.post<{ queued: number; recipients: number }>(
      '/api/admin/events/' + encodeURIComponent(id) + '/announcements',
      { text },
    );
  }

  createEvent(title: string, date: string, templateId?: string) {
    return this.http.post<Event>('/api/admin/events', { title, date, templateId });
  }

  importEvent(payload: object) {
    return this.http.post<Event>('/api/admin/events/import', payload);
  }

  importPrompt() {
    return this.http.get('/event-import-prompt.txt', { responseType: 'text' });
  }

  saveEvent(event: Event) {
    return this.http.put<Event>('/api/admin/events/' + encodeURIComponent(event.id), event);
  }

  uploadCover(id: string, image: Blob) {
    return this.http.put<Event>(this.adminCoverPath(id), image);
  }

  removeCover(id: string) {
    return this.http.delete<Event>(this.adminCoverPath(id));
  }

  private adminCoverPath(id: string) {
    return '/api/admin/events/' + encodeURIComponent(id) + '/cover';
  }

  saveTemplate(eventId: string, title: string) {
    return this.http.post<Template>('/api/admin/templates', { eventId, title });
  }

  private eventPath(id: string) {
    return '/api/events/' + encodeURIComponent(id);
  }

  private sosPath(id: string, roleId: string) {
    return this.eventPath(id) + '/roles/' + encodeURIComponent(roleId) + '/sos';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse && typeof error.error?.error === 'string') {
    return error.error.error;
  }
  return 'Не удалось связаться с сервером. Попробуйте ещё раз.';
}
