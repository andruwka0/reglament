import { Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { eventCoverUrl } from '../event.model';
import { TrackerApi } from '../tracker-api';

const eventDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

@Component({
  selector: 'app-event-catalog',
  imports: [RouterLink],
  templateUrl: './event-catalog.html',
  styleUrl: './event-catalog.css',
})
export class EventCatalog {
  private readonly api = inject(TrackerApi);
  protected readonly events = rxResource({ stream: () => this.api.events() });
  protected readonly rows = computed(() => {
    if (!this.events.hasValue()) return [];
    return this.events.value().map((event) => ({
      ...event,
      dateLabel: event.date ? eventDate.format(new Date(`${event.date}T00:00:00Z`)) : '',
      coverUrl: eventCoverUrl(event),
    }));
  });
}
