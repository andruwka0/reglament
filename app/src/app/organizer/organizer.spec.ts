import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import type { Event as TrackerEvent } from '../event.model';
import { OrganizerSession } from '../organizer-session';
import { Organizer } from './organizer';
import { TrackerApi } from '../tracker-api';

describe('Organizer', () => {
  it('queues a Telegram announcement only for the open event', async () => {
    const queryParamMap = convertToParamMap({});
    const event: TrackerEvent = {
      id: 'telegram-event', revision: 1, title: 'Турнир', date: '', location: '', description: '',
      info: [], timeline: [], roles: [], tasks: [],
    };
    const botUrl = 'https://t.me/demo_tracker_bot?start=telegram-event';
    const telegramInfo = vi.fn(() => of({ botUrl: botUrl as string | null, recipients: 3, connected: 2 }));
    const announce = vi.fn(() => of({ queued: 2, recipients: 2 }));
    TestBed.configureTestingModule({
      imports: [Organizer],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap }, queryParamMap: of(queryParamMap) } },
        { provide: TrackerApi, useValue: {
          session: () => of({ authenticated: true }),
          catalog: () => of({ events: [event], templates: [] }),
          telegramInfo, announce,
        } },
      ],
    });
    const fixture = TestBed.createComponent(Organizer);
    await fixture.whenStable();
    const page: HTMLElement = fixture.nativeElement;
    const button = (name: string) => [...page.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === name)!;

    button('Редактировать').click();
    await fixture.whenStable();
    expect(telegramInfo).not.toHaveBeenCalled();
    button('Уведомления').click();
    await fixture.whenStable();
    expect(telegramInfo).toHaveBeenCalledExactlyOnceWith(event.id);
    expect(page.textContent).toContain('2 из 3');
    expect(page.querySelector(`a[href="${botUrl}"]`)).not.toBeNull();

    const send = button('Отправить в Telegram');
    expect(send.disabled).toBe(true);
    const message = page.querySelector<HTMLTextAreaElement>('#announcement-text')!;
    message.value = '   ';
    message.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(send.disabled).toBe(true);

    message.value = '  Начинаем через пять минут!  ';
    message.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    send.click();
    await fixture.whenStable();
    expect(announce).toHaveBeenCalledExactlyOnceWith(event.id, 'Начинаем через пять минут!');
    expect(page.textContent).toContain('Поставлено в очередь: 2');
    expect(message.value).toBe('');

    expect(page.textContent).toContain('/admin');

    telegramInfo.mockReturnValueOnce(of({ botUrl: null, recipients: 3, connected: 2 }));
    button('Обновить данные').click();
    await fixture.whenStable();
    expect(page.textContent).toContain('Telegram-бот пока недоступен');
    expect(button('Отправить в Telegram')).toBeUndefined();
  });

  it('keeps legacy task state until the completion checkbox changes', async () => {
    const queryParamMap = convertToParamMap({});
    const stored: TrackerEvent = {
      id: 'test', revision: 1, title: 'Турнир', date: '', location: '', description: '',
      info: [], timeline: [], roles: [],
      tasks: [{
        id: 'first', title: 'Встретить гостей', description: '',
        start: '', end: '', assignee: '', status: 'doing',
      }],
    };
    const save = vi.fn((event: TrackerEvent) => of({ ...event, revision: event.revision + 1 }));
    TestBed.configureTestingModule({
      imports: [Organizer],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap }, queryParamMap: of(queryParamMap) } },
        { provide: TrackerApi, useValue: {
          session: () => of({ authenticated: true }),
          catalog: () => of({ events: [stored], templates: [] }),
          saveEvent: save,
        } },
      ],
    });
    const fixture = TestBed.createComponent(Organizer);
    await fixture.whenStable();
    const page: HTMLElement = fixture.nativeElement;
    const button = (name: string) => [...page.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === name)!;
    button('Редактировать').click();
    await fixture.whenStable();
    button('Общие задачи').click();
    await fixture.whenStable();

    const fields = page.querySelector<HTMLElement>('.edit-block')!;
    const complete = fields.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(complete.checked).toBe(false);
    expect(fields.querySelector('select')).toBeNull();
    const title = fields.querySelector<HTMLInputElement>('input')!;
    title.value = 'Встретить команду';
    title.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Сохранить изменения').click();
    await fixture.whenStable();
    expect(save.mock.calls[0][0].tasks[0].status).toBe('doing');

    button('Общие задачи').click();
    await fixture.whenStable();
    page.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    await fixture.whenStable();
    button('Сохранить изменения').click();
    await fixture.whenStable();
    expect(save.mock.calls[1][0].tasks[0].status).toBe('done');
    expect(page.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);

    page.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    await fixture.whenStable();
    button('Сохранить изменения').click();
    await fixture.whenStable();
    expect(save.mock.calls[2][0].tasks[0].status).toBe('todo');
  });

  it.each([
    ['/e/another-event', true],
    ['//example.org/e/regata-demo', false],
  ])('returns after organizer login only to a local event path (%s)', async (returnTo, shouldReturn) => {
    const queryParamMap = convertToParamMap({ returnTo });
    const catalog = vi.fn(() => of({ events: [], templates: [] }));
    const login = vi.fn(() => of({ authenticated: true }));
    TestBed.configureTestingModule({
      imports: [Organizer],
      providers: [
        provideRouter([{ path: 'e/:id', children: [] }]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap }, queryParamMap: of(queryParamMap) } },
        { provide: TrackerApi, useValue: { session: () => of({ authenticated: false }), login, catalog } },
      ],
    });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl');
    const fixture = TestBed.createComponent(Organizer);
    await fixture.whenStable();
    const page: HTMLElement = fixture.nativeElement;
    const input = page.querySelector<HTMLInputElement>('input[type=password]')!;
    input.value = 'test-password';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    page.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await fixture.whenStable();

    expect(login).toHaveBeenCalledWith('test-password');
    expect(TestBed.inject(OrganizerSession).authenticated()).toBe(true);
    if (shouldReturn) {
      expect(navigate).toHaveBeenCalledWith(returnTo, { replaceUrl: true });
      expect(catalog).not.toHaveBeenCalled();
    } else {
      expect(navigate).not.toHaveBeenCalled();
      expect(catalog).toHaveBeenCalledOnce();
    }
  });

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

  it('adds and saves a multiline text block without a contact heading', async () => {
    const queryParamMap = convertToParamMap({});
    const stored: TrackerEvent = {
      id: 'test', revision: 1, title: 'Турнир', date: '', location: '', description: '',
      info: [{ id: 'chat', label: 'Чат', value: 'https://example.org/chat' }],
      roles: [], timeline: [], tasks: [],
    };
    let submitted: TrackerEvent | undefined;
    TestBed.configureTestingModule({
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
    });
    const fixture = TestBed.createComponent(Organizer);
    await fixture.whenStable();
    const page = fixture.nativeElement as HTMLElement;
    const button = (name: string) => [...page.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === name)!;
    button('Редактировать').click();
    await fixture.whenStable();
    button('Добавить текст').click();
    await fixture.whenStable();
    const text = page.querySelector<HTMLTextAreaElement>('.info-text-editor textarea')!;
    text.value = 'Вход через двор.\nЗвоните координатору.';
    text.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Сохранить изменения').click();
    await fixture.whenStable();
    expect(submitted?.info).toEqual([
      stored.info[0],
      { id: expect.any(String), label: '', value: text.value },
    ]);
    expect(page.querySelectorAll('.info-text-editor textarea')).toHaveLength(1);

    button('Удалить поле').click();
    await fixture.whenStable();
    expect(page.querySelector<HTMLTextAreaElement>('.info-text-editor textarea')?.value)
      .toBe(text.value);
    button('Сохранить изменения').click();
    await fixture.whenStable();
    expect(submitted?.info).toEqual([{ id: expect.any(String), label: '', value: text.value }]);
  });
});
