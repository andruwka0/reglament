import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import type { Catalog, Event, Status, Template } from './event.model';

@Service()
export class TrackerApi {
  private readonly http = inject(HttpClient);

  event(id: string) {
    return this.http.get<Event>(this.eventPath(id));
  }

  updateStatus(id: string, taskId: string, status: Status) {
    const path = this.eventPath(id) + '/tasks/' + encodeURIComponent(taskId) + '/status';
    return this.http.post<Event>(path, { status });
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
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse && typeof error.error?.error === 'string') {
    return error.error.error;
  }
  return 'Не удалось связаться с сервером. Попробуйте ещё раз.';
}
