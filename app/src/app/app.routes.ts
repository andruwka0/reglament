import { Routes } from '@angular/router';
import type { Organizer } from './organizer/organizer';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Мероприятия — Регламент',
    loadComponent: () => import('./event-catalog/event-catalog').then((m) => m.EventCatalog),
  },
  { path: 'e/:id', loadComponent: () => import('./event-board/event-board').then((m) => m.EventBoard) },
  {
    path: 'admin',
    loadComponent: () => import('./organizer/organizer').then((m) => m.Organizer),
    canDeactivate: [(organizer: Organizer) => organizer.canLeave()],
  },
  { path: '**', redirectTo: '' },
];
