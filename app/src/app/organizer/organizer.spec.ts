import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { Event as TrackerEvent } from '../event.model';
import { Organizer } from './organizer';
import { TrackerApi } from '../tracker-api';

describe('Organizer', () => {
  it('requires organizer sign-in before exposing the event editor', async () => {
    const queryParamMap = convertToParamMap({});
    await TestBed.configureTestingModule({
      imports: [Organizer],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap }, queryParamMap: of(queryParamMap) } },
        { provide: TrackerApi, useValue: { session: () => of({ authenticated: false }) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Organizer);
    await fixture.whenStable();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('input[type=password]')).not.toBeNull();
    expect(page.querySelector('.editor')).toBeNull();
  });
  it('imports pasted JSON and opens the newly created event for editing', async () => {
    const queryParamMap = convertToParamMap({});
    const imported: TrackerEvent = {
      id: 'imported-event', revision: 0, title: 'Турнир из JSON', date: '',
      location: '', description: '', info: [], timeline: [], roles: [], tasks: [],
    };
    let submitted: unknown;
    await TestBed.configureTestingModule({
      imports: [Organizer],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap }, queryParamMap: of(queryParamMap) } },
        { provide: TrackerApi, useValue: {
          session: () => of({ authenticated: true }),
          catalog: () => of({ events: [], templates: [] }),
          importPrompt: () => of('Промпт'),
          importEvent: (payload: unknown) => {
            submitted = payload;
            return of(imported);
          },
        } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Organizer);
    await fixture.whenStable();
    const page = fixture.nativeElement as HTMLElement;
    const importButton = [...page.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Импорт JSON');
    expect(importButton).toBeDefined();
    const input = page.querySelector<HTMLTextAreaElement>('#import-json')!;
    const dialog = input.closest('dialog')!;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    importButton!.click();
    await fixture.whenStable();
    expect(dialog.open).toBe(true);
    input.value = '{';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    dialog.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await fixture.whenStable();
    expect(dialog.querySelector('[role=alert]')?.textContent).toContain('Некорректный JSON');
    expect(submitted).toBeUndefined();
    expect(input.value).toBe('{');

    input.value = '{"title":"Турнир из JSON"}';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    dialog.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await fixture.whenStable();
    expect(submitted).toEqual({ title: 'Турнир из JSON' });
    expect(dialog.open).toBe(false);
    expect(page.querySelector('.editor h2')?.textContent).toContain('Турнир из JSON');
  });

  it('loads existing contacts and saves multiple handles for a role', async () => {
    const queryParamMap = convertToParamMap({});
    const stored: TrackerEvent = {
      id: 'test', revision: 1, title: 'Турнир', date: '', location: '', description: '',
      info: [], timeline: [], tasks: [],
      roles: [{ id: 'role', title: 'Встреча', description: '', assignee: '@existing', tasks: [] }],
    };
    let submitted: TrackerEvent | undefined;
    await TestBed.configureTestingModule({
      imports: [Organizer],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap }, queryParamMap: of(queryParamMap) } },
        { provide: TrackerApi, useValue: {
          session: () => of({ authenticated: true }),
          catalog: () => of({ events: [stored], templates: [] }),
          saveEvent: (event: TrackerEvent) => {
            submitted = event;
            return of({ ...event, revision: 2 });
          },
        } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Organizer);
    await fixture.whenStable();
    const page = fixture.nativeElement as HTMLElement;
    const button = (name: string) => [...page.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === name)!;
    button('Редактировать').click();
    await fixture.whenStable();
    button('Роли').click();
    await fixture.whenStable();
    const input = [...page.querySelectorAll('label')]
      .find((label) => label.textContent?.trim() === 'Ответственные за роль')!.querySelector('input')!;
    expect(input.value).toBe('@existing');
    input.value = '@existing, @second @third';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Сохранить изменения').click();
    await fixture.whenStable();
    expect(submitted?.roles[0].assignees).toEqual(['@existing', '@second', '@third']);
  });
});
