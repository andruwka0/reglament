import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { OrganizerSession } from './organizer-session';
import { errorMessage } from './tracker-api';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
  host: {
    '(document:click)': 'closeMenuOnOutsideClick($event)',
    '(document:visibilitychange)': 'refreshEventSession()',
  },
})
export class App {
  private readonly router = inject(Router);
  protected readonly session = inject(OrganizerSession);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly path = computed(() => this.url().split(/[?#]/, 1)[0]);
  protected readonly eventPath = computed(() => this.path().startsWith('/e/') ? this.path() : '');
  protected readonly templates = computed(
    () => this.router.parseUrl(this.url()).queryParams['view'] === 'templates',
  );
  private readonly eventMenu = viewChild<ElementRef<HTMLDetailsElement>>('eventMenu');
  protected readonly copied = signal('');
  protected readonly shareUrl = signal('');
  protected readonly signingOut = signal(false);
  protected readonly menuError = signal('');

  constructor() {
    void this.session.check().catch(() => undefined);
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.copied.set('');
        this.shareUrl.set('');
        this.menuError.set('');
      });
  }

  protected closeMenu() {
    const menu = this.eventMenu()?.nativeElement;
    if (!menu?.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }

  protected closeMenuOnOutsideClick(event: MouseEvent) {
    const menu = this.eventMenu()?.nativeElement;
    if (menu?.open && event.target instanceof Node && !menu.contains(event.target))
      menu.open = false;
  }

  protected refreshEventSession() {
    if (this.eventPath() && document.visibilityState === 'visible') {
      void this.session.check().catch(() => undefined);
    }
  }

  protected async signOut() {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    this.menuError.set('');
    try {
      await this.session.signOut();
      this.closeMenu();
    } catch (error) {
      this.menuError.set(errorMessage(error));
    } finally {
      this.signingOut.set(false);
    }
  }

  protected async copyPublicLink() {
    const link = new URL(this.eventPath(), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
      this.copied.set('Ссылка скопирована');
      this.shareUrl.set('');
      this.closeMenu();
    } catch {
      this.shareUrl.set(link);
      this.copied.set('');
    }
  }
}
