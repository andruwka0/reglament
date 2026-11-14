import { TestBed } from '@angular/core/testing';
import type { WorkflowAction, WorkflowView } from '../workflow.model';
import { PointWorkflow } from './point-workflow';

const volunteer = { username: '@volunteer', userId: '42', isAdmin: false };
const point: WorkflowView['points'][number] = {
  roleId: 'registration',
  title: 'Регистрация',
  kind: 'registration',
  status: 'intake',
  version: 8,
  senior: '@senior',
  proposal: null,
  member: true,
  isSenior: false,
  canManage: false,
};
const command: WorkflowView['commands'][number] = {
  id: 'close-1',
  type: 'close_intake',
  message: 'Приём завершён',
  createdAt: '',
  targets: [{ roleId: point.roleId, status: 'pending', acknowledgedAt: null, executedAt: null }],
};

function mount(view: Partial<WorkflowView>) {
  TestBed.configureTestingModule({ imports: [PointWorkflow] });
  const fixture = TestBed.createComponent(PointWorkflow);
  fixture.componentRef.setInput('roleId', point.roleId);
  fixture.componentRef.setInput('view', {
    enabled: true,
    actor: volunteer,
    points: [point],
    commands: [],
    requests: [],
    audit: [],
    stages: [],
    ...view,
  });
  const actions: WorkflowAction[] = [];
  fixture.componentInstance.action.subscribe((action) => actions.push(action));
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  return {
    fixture,
    element,
    actions,
    button: (text: string) =>
      [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === text),
  };
}

describe('PointWorkflow', () => {
  it('offers a volunteer Telegram contact and displays their own proposal without operational controls', () => {
    const { element, actions, button } = mount({
      points: [{ ...point, proposal: { id: 'offer-1', username: volunteer.username } }],
      commands: [command],
    });
    expect(element.textContent).toContain('Волонтёр');
    expect(element.querySelector('a')?.href).toBe('https://t.me/senior');
    expect(button('SOS')).toBeUndefined();
    expect(button('Подтвердить получение')).toBeUndefined();
    expect(element.querySelector('select')).toBeNull();
    button('Принять назначение')!.click();
    expect(actions).toEqual([
      { action: 'accept-senior', roleId: point.roleId, proposalId: 'offer-1' },
    ]);
  });

  it('lets a senior acknowledge their command and pause the point with its current version', () => {
    const { fixture, element, actions, button } = mount({
      points: [{ ...point, isSenior: true, canManage: true }],
      commands: [command],
    });
    expect(button('SOS')).toBeDefined();
    button('Подтвердить получение')!.click();
    expect(actions.at(-1)).toEqual({
      action: 'ack-command',
      commandId: command.id,
      roleId: point.roleId,
    });
    const state = element.querySelector('select')!;
    expect([...state.options].map(({ value }) => value)).toEqual(['', 'paused']);
    state.value = 'paused';
    state.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(button('Обновить состояние')?.disabled).toBe(true);
    const reason = element.querySelector('input')!;
    reason.value = 'Требуется помощь на входе';
    reason.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    expect(actions.at(-1)).toEqual({
      action: 'set-point-status',
      roleId: point.roleId,
      status: 'paused',
      expectedVersion: 8,
      reason: reason.value,
    });
  });

  it('reuses a request ID on retry and clears the draft after confirmation', () => {
    const { fixture, element, actions } = mount({
      points: [{ ...point, isSenior: true, canManage: true }],
    });
    const draft = element.querySelector('textarea')!;
    draft.value = 'Кому передать списки?';
    draft.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    draft.closest('form')!.dispatchEvent(new Event('submit'));
    draft.closest('form')!.dispatchEvent(new Event('submit'));
    expect(actions[0]).toMatchObject({
      action: 'create-request',
      roleId: point.roleId,
      type: 'question',
      text: draft.value,
    });
    expect(actions[1]).toEqual(actions[0]);
    fixture.componentRef.setInput('lastAppliedAction', actions[0]);
    fixture.detectChanges();
    expect(draft.value).toBe('');
  });
});
