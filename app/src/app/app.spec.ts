import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { App } from './app';
import { TrackerApi } from './tracker-api';

async function render(authenticated: boolean) {
  const logOut = vi.fn(() => of({ authenticated: false }));
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter([{ path: 'e/:id', children: [] }]),
      { provide: TrackerApi, useValue: { session: () => of({ authenticated }), logout: logOut } },
    ],
  });
  const fixture = TestBed.createComponent(App);
  await TestBed.inject(Router).navigateByUrl('/e/regata-demo#old-fragment');
  await fixture.whenStable();
  const app: HTMLElement = fixture.nativeElement;
  const menu = app.querySelector<HTMLDetailsElement>('.event-menu')!;
  return { fixture, app, menu, logOut };
}

describe('App', () => {
  it('offers organizer sign-in and sharing but hides templates for signed-out visitors', async () => {
    const { app, menu } = await render(false);
    expect(menu.querySelector('summary')?.getAttribute('aria-label')).toBe('Меню мероприятия');
    expect(menu.querySelector('button')?.textContent).toContain('Поделиться');
    const login = menu.querySelector('a')!;
    expect(login.textContent?.trim()).toBe('Войти');
    const href = new URL(login.getAttribute('href')!, 'https://example.test');
    expect(href.pathname).toBe('/admin');
    expect(href.searchParams.get('returnTo')).toBe('/e/regata-demo');
    expect(
      [...app.querySelectorAll('.site-nav a')].map((link) => link.textContent?.trim()),
    ).toEqual(['Обзор']);
  });

  it('shows organizer links only while signed in and returns to the visitor menu after logout', async () => {
    const { fixture, app, menu, logOut } = await render(true);
    expect([...menu.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/admin?view=templates',
    ]);
    expect(app.querySelector('.site-nav a[href="/admin?view=templates"]')).toBeNull();
    const exit = [...menu.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Выйти',
    )!;
    exit.click();
    await fixture.whenStable();
    expect(logOut).toHaveBeenCalledOnce();
    expect(menu.querySelector('a')?.textContent?.trim()).toBe('Войти');
    expect(app.querySelector('.site-nav a[href="/admin?view=templates"]')).toBeNull();
  });
});
