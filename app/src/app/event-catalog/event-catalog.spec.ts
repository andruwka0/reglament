import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { EventSummary } from '../event.model';
import { TrackerApi } from '../tracker-api';
import { EventCatalog } from './event-catalog';

const events: EventSummary[] = [
  { id: 'regatta', title: 'Регата', date: '2026-11-14', location: 'НИУ ВШЭ', coverVersion: 'v1' },
  { id: 'meeting', title: 'Встреча волонтёров', date: '', location: '' },
];

function mount(fetchEvents: TrackerApi['events']) {
  TestBed.configureTestingModule({
    imports: [EventCatalog],
    providers: [provideRouter([]), { provide: TrackerApi, useValue: { events: fetchEvents } }],
  });
  const fixture = TestBed.createComponent(EventCatalog);
  fixture.detectChanges();
  return { fixture, page: fixture.nativeElement as HTMLElement };
}

describe('EventCatalog', () => {
  it('shows a loading state before listing dated and undated events with public links', async () => {
    const response = new Subject<EventSummary[]>();
    const { fixture, page } = mount(() => response);
    expect(page.querySelector('[role="status"]')?.textContent).toContain('Загружаем');
    response.next(events);
    response.complete();
    await fixture.whenStable();

    const links = [...page.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/e/regatta', '/e/meeting']);
    expect(links[0].querySelector('time')?.getAttribute('datetime')).toBe('2026-11-14');
    expect(links[0].textContent).toContain('НИУ ВШЭ');
    expect(links[0].querySelector('img')?.getAttribute('src')).toBe(
      '/api/events/regatta/cover?v=v1',
    );
    expect(links[1].textContent).toContain('Дата уточняется');
  });

  it('retries a failed load and displays the empty state if no events are returned', async () => {
    const fetchEvents = vi
      .fn<TrackerApi['events']>()
      .mockReturnValueOnce(throwError(() => new Error('Offline')))
      .mockReturnValueOnce(of([]));
    const { fixture, page } = mount(fetchEvents);
    await fixture.whenStable();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('Не удалось');
    page.querySelector('button')!.click();
    await fixture.whenStable();
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(page.textContent).toContain('Пока нет мероприятий');
  });
});
