import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
  it('opens the organizer cabinet from the navigation', async () => {
    await TestBed.configureTestingModule({ imports: [App], providers: [provideRouter([])] })
      .compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const app = fixture.nativeElement as HTMLElement;
    const cabinet = [...app.querySelectorAll('a')].find((link) => link.textContent?.trim() === 'Кабинет');
    expect(cabinet?.getAttribute('href')).toBe('/admin');
  });
});
