import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TrackerApi } from './tracker-api';

describe('TrackerApi', () => {
  it('updates a task from the shared link without an invitation', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const api = TestBed.inject(TrackerApi);
    const http = TestBed.inject(HttpTestingController);
    api.updateStatus('regata-demo', 'welcome', 'done').subscribe();
    const request = http.expectOne('/api/events/regata-demo/tasks/welcome/status');
    expect(request.request.headers.has('Authorization')).toBe(false);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ status: 'done' });
    request.flush({});
    http.verify();
  });
});
