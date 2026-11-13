import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
  host: { '(document:click)': 'closeMenuOnOutsideClick($event)' },
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
  private readonly eventMenu = viewChild<ElementRef<HTMLDetailsElement>>('eventMenu');
  protected readonly copied = signal('');
  protected readonly shareUrl = signal('');

  constructor() {
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

  protected async copyPublicLink(closeMenu = false) {
    const link = new URL(this.eventPath(), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
      this.copied.set('Ссылка скопирована');
      this.shareUrl.set('');
      if (closeMenu) this.closeMenu();
    } catch {
      this.shareUrl.set(link);
      this.copied.set('');
    }
  }
}
