import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';

describe('App', () => {
  it('opens the organizer cabinet from the navigation', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const app = fixture.nativeElement as HTMLElement;
    const cabinet = [...app.querySelectorAll('a')].find(
      (link) => link.textContent?.trim() === 'Кабинет',
    );
    expect(cabinet?.getAttribute('href')).toBe('/admin');
  });

  it('keeps share and organizer actions in the event menu', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([{ path: 'e/:id', children: [] }])],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/e/regata-demo');
    await fixture.whenStable();
    const app = fixture.nativeElement as HTMLElement;
    const menu = app.querySelector<HTMLDetailsElement>('.event-menu')!;
    expect(menu.querySelector('summary')?.getAttribute('aria-label')).toBe('Меню мероприятия');
    expect(menu.querySelector('button')?.textContent).toContain('Поделиться');
    expect([...menu.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/admin?view=templates',
      '/admin',
    ]);
  });
});
