import { Service, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TrackerApi } from './tracker-api';

@Service()
export class OrganizerSession {
  private readonly api = inject(TrackerApi);
  private readonly state = signal<boolean | null>(null);
  private pendingCheck?: Promise<boolean>;
  private changing = false;

  readonly authenticated = () => this.state() === true;
  readonly checking = () => this.state() === null;

  check(): Promise<boolean> {
    if (this.changing) return Promise.resolve(this.authenticated());
    if (this.pendingCheck) return this.pendingCheck;
    this.pendingCheck = firstValueFrom(this.api.session())
      .then(({ authenticated }) => {
        this.state.set(authenticated);
        return authenticated;
      })
      .catch((error) => {
        if (this.state() === null) this.state.set(false);
        throw error;
      })
      .finally(() => {
        this.pendingCheck = undefined;
      });
    return this.pendingCheck;
  }

  async signIn(password: string): Promise<void> {
    await this.change(() => firstValueFrom(this.api.login(password)));
  }

  async signOut(): Promise<void> {
    await this.change(() => firstValueFrom(this.api.logout()));
  }

  private async change(run: () => Promise<{ authenticated: boolean }>): Promise<void> {
    this.changing = true;
    try {
      await this.pendingCheck?.catch(() => undefined);
      const { authenticated } = await run();
      this.state.set(authenticated);
    } finally {
      this.changing = false;
    }
  }
}
