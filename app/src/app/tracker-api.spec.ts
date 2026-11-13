import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { TrackerApi } from './tracker-api';

describe('TrackerApi', () => {
  it('updates a task from the shared link using the selected participant', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const api = TestBed.inject(TrackerApi);
    const http = TestBed.inject(HttpTestingController);
    api.updateStatus('regata-demo', 'welcome', 'done', '@volunteer').subscribe();
    const request = http.expectOne('/api/events/regata-demo/tasks/welcome/status');
    expect(request.request.headers.has('Authorization')).toBe(false);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ status: 'done', assignee: '@volunteer' });
    request.flush({});
    http.verify();
  });

  it('reads and cancels an active SOS using the selected participant', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const api = TestBed.inject(TrackerApi);
    const http = TestBed.inject(HttpTestingController);
    const path = '/api/events/regata-demo/roles/welcome/sos';
    api.sosStatus('regata-demo', 'welcome', '@volunteer').subscribe();
    http.expectOne({ method: 'GET', url: path + '?assignee=@volunteer' }).flush({ expiresAt: null });
    api.cancelSos('regata-demo', 'welcome', '@volunteer').subscribe();
    const cancellation = http.expectOne({ method: 'DELETE', url: path });
    expect(cancellation.request.body).toEqual({ assignee: '@volunteer' });
    cancellation.flush({ cancelled: true });
    http.verify();
  });

  it('receives valid snapshots, leaves reconnects to EventSource and closes on unsubscribe', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    class FakeSource extends EventTarget {
      readonly close = vi.fn();
    }
    const source = new FakeSource();
    const open = vi.fn(function () {
      return source;
    });
    vi.stubGlobal('EventSource', open);
    try {
      const next = vi.fn();
      const onSos = vi.fn();
      const onSosCancelled = vi.fn();
      const subscription = TestBed.inject(TrackerApi)
        .liveEvent('regata-demo', onSos, onSosCancelled)
        .subscribe(next);
      expect(open).toHaveBeenCalledWith('/api/events/regata-demo/stream');
      source.dispatchEvent(new MessageEvent('message', { data: 'bad JSON' }));
      source.dispatchEvent(new MessageEvent('message', { data: '{"id":"wrong","revision":1}' }));
      source.dispatchEvent(new Event('error'));
      const event = { id: 'regata-demo', revision: 2 };
      source.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
      expect(next).toHaveBeenCalledExactlyOnceWith(event);
      source.dispatchEvent(new MessageEvent('sos', { data: '{"roleId":"incomplete"}' }));
      const sos = { roleId: 'welcome', roleTitle: 'Регистрация', assignee: '@volunteer' };
      source.dispatchEvent(new MessageEvent('sos', { data: JSON.stringify(sos) }));
      expect(onSos).toHaveBeenCalledExactlyOnceWith(sos);
      source.dispatchEvent(new MessageEvent('sos-cancelled', { data: JSON.stringify(sos) }));
      expect(onSosCancelled).toHaveBeenCalledExactlyOnceWith(sos);
      subscription.unsubscribe();
      expect(source.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
