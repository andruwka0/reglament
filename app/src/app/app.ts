import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';

const themes = [
  { id: 'merlot', label: 'Merlot' },
  { id: 'pastel', label: 'Пастель' },
  { id: 'studio', label: 'Studio' },
] as const;
type Theme = (typeof themes)[number]['id'];
const themeStorageKey = 'reglament-theme';
const defaultTheme: Theme = 'pastel';

function savedTheme(): Theme {
  try {
    const id = window.localStorage.getItem(themeStorageKey);
    return themes.find((theme) => theme.id === id)?.id ?? defaultTheme;
  } catch {
    return defaultTheme;
  }
}

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
  host: { '(document:click)': 'closeThemeOnOutsideClick($event)' },
})
export class App {
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly eventPath = computed(() => {
    const path = this.url().split(/[?#]/, 1)[0];
    return path.startsWith('/e/') ? path : '';
  });
  protected readonly templates = computed(
    () => this.router.parseUrl(this.url()).queryParams['view'] === 'templates',
  );
  private readonly themeMenu = viewChild<ElementRef<HTMLDetailsElement>>('themeMenu');
  protected readonly themes = themes;
  protected readonly theme = signal<Theme>(savedTheme());
  protected readonly copied = signal('');
  protected readonly shareUrl = signal('');

  constructor() {
    document.documentElement.dataset['theme'] = this.theme();
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.copied.set('');
        this.shareUrl.set('');
      });
  }

  protected selectTheme(theme: Theme) {
    this.theme.set(theme);
    document.documentElement.dataset['theme'] = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // The selected theme still applies for this page when storage is unavailable.
    }
    this.closeTheme();
  }

  protected closeTheme() {
    const menu = this.themeMenu()?.nativeElement;
    if (!menu?.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }

  protected closeThemeOnOutsideClick(event: MouseEvent) {
    const menu = this.themeMenu()?.nativeElement;
    if (menu?.open && event.target instanceof Node && !menu.contains(event.target))
      menu.open = false;
  }

  protected async copyPublicLink(closeMenu = false) {
    const link = new URL(this.eventPath(), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
      this.copied.set('Ссылка скопирована');
      this.shareUrl.set('');
      if (closeMenu) this.closeTheme();
    } catch {
      this.shareUrl.set(link);
      this.copied.set('');
    }
  }
}
