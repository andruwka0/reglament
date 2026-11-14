import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { STATUSES, type Event } from '../event.model';
import { assignedPeople } from '../event-board/post-view';
import {
  commandLabels,
  pointStatusLabels,
  requestStatusLabels,
  requestTypeLabels,
  type CommandType,
  type PointKind,
  type WorkflowAction,
  type WorkflowCommand,
  type WorkflowRequest,
  type WorkflowView,
} from '../workflow.model';

const pointKindLabels = { general: 'Обычная точка', registration: 'Регистрация', cloakroom: 'Гардероб' };
const stageLabels = { planned: 'По плану', started: 'Идёт', finished: 'Завершён' };
const targetLabels = { pending: 'Ожидает', acknowledged: 'Принята', executed: 'Исполнена' };
const taskStatusLabels = Object.fromEntries(STATUSES.map(({ id, label }) => [id, label]));
const auditLabels: Record<string, string> = {
  enable: 'Включён режим координации',
  'configure-point': 'Изменён тип точки',
  'propose-senior': 'Предложена роль старшего',
  'accept-senior': 'Назначен старший',
  'decline-senior': 'Участник отказался от роли старшего',
  'revoke-proposal': 'Отозвано предложение',
  'revoke-senior': 'Снято назначение старшего',
  'restore-default-senior': 'Восстановлено автоматическое назначение',
  'set-point-status': 'Обновлён статус точки',
  'create-command': 'Выдана команда',
  'ack-command': 'Принята команда',
  'execute-command': 'Исполнена команда',
  'create-request': 'Создано обращение',
  'accept-request': 'Принято обращение',
  'resolve-request': 'Решено обращение',
  'cancel-request': 'Отменено обращение',
  'close-request': 'Закрыто обращение',
  'view-request': 'Просмотрен отчёт',
  'message-request': 'Добавлено сообщение',
  'mark-stage': 'Обновлён этап',
  'task-status': 'Обновлена задача',
};

interface CommandAttempt {
  signature: string;
  requestId: string;
  previousIds: Set<string>;
}

interface CommandDraft {
  type: CommandType;
  targets: string[];
  message: string;
}

export interface TaskOverride {
  taskId: string;
  completed: boolean;
  comment: string;
}

function commandSignature(type: CommandType, roleIds: string[], message: string) {
  return JSON.stringify([type, [...roleIds].sort(), message]);
}

function isClosed(request: WorkflowRequest) {
  return request.status === 'resolved' || request.status === 'cancelled' || request.status === 'closed' ||
    (request.type === 'report' && request.status === 'viewed');
}

function requestPriority(request: WorkflowRequest) {
  if (request.type !== 'sos') return 2;
  return request.status === 'new' ? 0 : 1;
}

function labelFor(labels: Record<string, string>, value: unknown) {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : '';
}

@Component({
  selector: 'app-workflow-admin',
  imports: [DatePipe, NgTemplateOutlet],
  templateUrl: './workflow-admin.html',
  styles: `
    :host { display: grid; gap: 12px; min-width: 0; }
    .stack { display: grid; gap: 9px; min-width: 0; }
    .compact { margin: 0; padding-inline-start: 20px; }
    .compact li + li { margin-top: 5px; }
    .card { background: var(--paper); }
    .priority { border-color: var(--accent); }
    .targets { display: grid; gap: 0; padding: 0; margin: 0; border: 0; min-width: 0; }
    .targets label { display: flex; align-items: center; min-height: 44px; gap: 9px; }
    .targets input { accent-color: var(--accent-strong); }
    .small { font-size: 13px; }
    .pick { align-items: end; }
    .pick > .field { flex: 1 1 150px; }
  `,
})
export class WorkflowAdmin {
  readonly view = input.required<WorkflowView>();
  readonly event = input.required<Event>();
  readonly busy = input(false);
  readonly action = output<WorkflowAction>();
  readonly taskOverride = output<TaskOverride>();

  protected readonly pointKindLabels = pointKindLabels;
  protected readonly pointStatusLabels = pointStatusLabels;
  protected readonly commandLabels = commandLabels;
  protected readonly stageLabels = stageLabels;
  protected readonly targetLabels = targetLabels;
  protected readonly auditLabels = auditLabels;
  protected readonly pointKinds: PointKind[] = ['general', 'registration', 'cloakroom'];
  protected readonly commandTypes: CommandType[] = ['close_intake', 'prepare_checkout', 'request_status'];
  protected readonly seniorChoices = signal<Record<string, string>>({});
  protected readonly command = linkedSignal<WorkflowCommand[], CommandDraft>({
    source: () => this.view().commands,
    computation: (commands, previous) => {
      const draft = previous?.value ?? { type: 'close_intake', targets: [], message: '' };
      const attempt = this.commandAttempt;
      if (attempt && commands.some((command) =>
        !attempt.previousIds.has(command.id) && !previous?.source.some(({ id }) => id === command.id) &&
        commandSignature(command.type, command.targets.map((target) => target.roleId), command.message) === attempt.signature,
      )) return { ...draft, targets: [], message: '' };
      return draft;
    },
  });
  protected readonly replies = linkedSignal<WorkflowRequest[], Record<string, string>>({
    source: () => this.view().requests,
    computation: (requests, previous): Record<string, string> => {
      const drafts = { ...previous?.value };
      for (const request of requests) {
        const old = previous?.source.find((item) => item.id === request.id);
        if (old && old.messages.length < request.messages.length &&
            request.messages.some((message) => message.text === drafts[request.id]?.trim() &&
              !old.messages.some(({ id }) => id === message.id))) delete drafts[request.id];
      }
      return drafts;
    },
  });
  protected readonly overrideTaskId = signal('');
  protected readonly overrideTask = computed(() => this.allTasks().find((task) => task.id === this.overrideTaskId()));
  protected readonly overrideComment = linkedSignal({
    source: () => `${this.overrideTaskId()}:${this.overrideTask()?.status ?? ''}`,
    computation: () => '',
  });
  protected readonly activeRequests = computed(() => this.view().requests.filter((request) => !isClosed(request))
    .sort((first, second) => requestPriority(first) - requestPriority(second)));
  protected readonly previousRequests = computed(() => this.view().requests.filter(isClosed));
  protected readonly pendingSos = computed(() => this.activeRequests().filter((request) => request.type === 'sos').length);
  protected readonly eligibleTargets = computed(() => this.view().points.filter((point) => {
    switch (this.command().type) {
      case 'close_intake': return point.kind === 'registration' || point.kind === 'cloakroom';
      case 'prepare_checkout': return point.kind === 'cloakroom';
      case 'request_status': return true;
    }
  }));
  protected readonly selectedTargets = computed(() => {
    const selected = this.command().targets;
    return this.eligibleTargets().filter((point) => selected.includes(point.roleId)).map((point) => point.roleId);
  });

  private readonly allTasks = computed(() => [...this.event().roles.flatMap((role) => role.tasks), ...this.event().tasks]);
  private readonly pointTitles = computed(() => new Map(this.view().points.map((point) => [point.roleId, point.title])));
  private readonly candidatesByRole = computed(() => new Map(this.event().roles.map((role) => [
    role.id, [...new Set([...assignedPeople(role), ...role.tasks.flatMap(assignedPeople)])].sort(),
  ])));
  private commandAttempt?: CommandAttempt;

  protected pointTitle(roleId: string) {
    return this.pointTitles().get(roleId) ?? 'Удалённая точка';
  }

  protected seniorCandidates(roleId: string, current: string | null, proposed: string | null) {
    return (this.candidatesByRole().get(roleId) ?? []).filter((candidate) => candidate !== current && candidate !== proposed);
  }

  protected requestCanBeAccepted(request: WorkflowRequest) {
    return (request.type === 'sos' && request.status === 'new') ||
      (request.type === 'question' && request.status === 'waiting');
  }

  protected requestHeading(request: WorkflowRequest) {
    return `${requestTypeLabels[request.type]} · ${this.pointTitle(request.roleId)}`;
  }

  protected requestStatus(request: WorkflowRequest) {
    return requestStatusLabels[request.status];
  }

  protected configurePoint(roleId: string, field: HTMLSelectElement, current: PointKind) {
    const pointKind = this.pointKinds.find((option) => option === field.value);
    field.value = current;
    if (pointKind && pointKind !== current) this.dispatch({ action: 'configure-point', roleId, kind: pointKind });
  }

  protected chooseSenior(roleId: string, username: string) {
    this.seniorChoices.update((entries) => ({ ...entries, [roleId]: username }));
  }

  protected proposeSenior(roleId: string, username: string) {
    if (username) this.dispatch({ action: 'propose-senior', roleId, username });
  }

  protected chooseCommand(value: string) {
    const commandType = this.commandTypes.find((option) => option === value);
    if (!commandType) return;
    this.command.update((draft) => ({ ...draft, type: commandType, targets: [] }));
  }

  protected toggleTarget(roleId: string, selected: boolean) {
    this.command.update((draft) => ({
      ...draft, targets: selected ? [...new Set([...draft.targets, roleId])] : draft.targets.filter((id) => id !== roleId),
    }));
  }

  protected editCommandMessage(message: string) {
    this.command.update((draft) => ({ ...draft, message }));
  }

  protected sendCommand() {
    const roleIds = this.selectedTargets();
    if (this.busy() || !roleIds.length) return;
    const { type, message: draft } = this.command();
    const commands = this.view().commands;
    const message = draft.trim();
    const signature = commandSignature(type, roleIds, message);
    const attempt = this.commandAttempt;
    const previousCommandExists = attempt?.signature === signature && commands.some((command) =>
      !attempt.previousIds.has(command.id) &&
      commandSignature(command.type, command.targets.map((target) => target.roleId), command.message) === signature,
    );
    const currentAttempt = !attempt || attempt.signature !== signature || previousCommandExists
      ? { signature, requestId: crypto.randomUUID(), previousIds: new Set(commands.map((command) => command.id)) }
      : attempt;
    this.commandAttempt = currentAttempt;
    this.dispatch({ action: 'create-command', type, roleIds, message, requestId: currentAttempt.requestId });
  }

  protected editReply(id: string, value: string) {
    this.replies.update((drafts) => ({ ...drafts, [id]: value }));
  }

  protected sendReply(id: string) {
    const text = this.replies()[id]?.trim();
    if (!text || this.busy()) return;
    this.dispatch({ action: 'message-request', id, text });
  }

  protected overrideTaskStatus() {
    const task = this.overrideTask();
    const value = this.overrideComment().trim();
    if (!task || !value || this.busy()) return;
    this.taskOverride.emit({ taskId: task.id, completed: task.status !== 'done', comment: value });
  }

  protected auditDetail(entry: WorkflowView['audit'][number]) {
    const details = entry.details;
    if (!details || typeof details !== 'object') return '';
    const value = details as Record<string, unknown>;
    const reason = typeof value['reason'] === 'string' ? value['reason'] : '';
    const comment = typeof value['comment'] === 'string' ? value['comment'] : '';
    const participant = [value['proposed'], value['senior'], value['previousSenior']].find((item) => typeof item === 'string');
    const task = entry.action === 'task-status' ? this.allTasks().find((item) => item.id === entry.targetId)?.title : '';
    const stage = entry.action === 'mark-stage' ? this.view().stages.find((item) => item.stageId === entry.targetId)?.title : '';
    return [task, stage, participant, labelFor(pointKindLabels, value['kind']),
      labelFor(commandLabels, value['type']) || labelFor(requestTypeLabels, value['type']),
      labelFor(pointStatusLabels, value['status']) || labelFor(pointStatusLabels, value['pointStatus']) ||
        labelFor(requestStatusLabels, value['status']) || labelFor(stageLabels, value['status']) ||
        labelFor(taskStatusLabels, value['status']),
      reason, comment].filter(Boolean).join(' · ');
  }

  protected dispatch(action: WorkflowAction) {
    if (!this.busy()) this.action.emit(action);
  }
}
