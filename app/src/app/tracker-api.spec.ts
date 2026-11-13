import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { TrackerApi } from './tracker-api';

describe('TrackerApi', () => {
  it('updates a task from the shared link using the selected participant', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
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

  it('receives valid snapshots, leaves reconnects to EventSource and closes on unsubscribe', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    class FakeSource extends EventTarget {
      readonly close = vi.fn();
    }
    const source = new FakeSource();
    const open = vi.fn(function () { return source; });
    vi.stubGlobal('EventSource', open);
    try {
      const next = vi.fn();
      const subscription = TestBed.inject(TrackerApi).liveEvent('regata-demo').subscribe(next);
      expect(open).toHaveBeenCalledWith('/api/events/regata-demo/stream');
      source.dispatchEvent(new MessageEvent('message', { data: 'bad JSON' }));
      source.dispatchEvent(new MessageEvent('message', { data: '{"id":"wrong","revision":1}' }));
      source.dispatchEvent(new Event('error'));
      const event = { id: 'regata-demo', revision: 2 };
      source.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
      expect(next).toHaveBeenCalledExactlyOnceWith(event);
      subscription.unsubscribe();
      expect(source.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
