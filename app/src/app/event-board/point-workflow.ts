import {
  Component,
  computed,
  effect,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  commandLabels,
  pointStatusLabels,
  requestStatusLabels,
  requestTypeLabels,
  type PointKind,
  type PointStatus,
  type WorkflowAction,
  type WorkflowView,
} from '../workflow.model';

type Point = WorkflowView['points'][number];
type Command = WorkflowView['commands'][number];
type Request = WorkflowView['requests'][number];
type RequestDraft = { roleId: string; type: Request['type']; text: string; requestId: string };
type Reply = { id: string; text: string };

const transitions: Record<PointKind, Partial<Record<PointStatus, readonly PointStatus[]>>> = {
  general: {
    preparation: ['ready'],
    ready: ['preparation', 'working'],
    working: ['paused', 'finished'],
    paused: ['working', 'preparation', 'finished'],
  },
  registration: {
    preparation: ['ready'],
    ready: ['preparation', 'intake'],
    intake: ['paused'],
    paused: ['intake'],
  },
  cloakroom: {
    preparation: ['ready'],
    ready: ['preparation', 'intake'],
    intake: ['paused'],
    paused: ['intake'],
    checkout_preparation: ['checkout'],
    checkout: ['finished'],
  },
};

@Component({
  selector: 'app-point-workflow',
  templateUrl: './point-workflow.html',
  styleUrl: './point-workflow.css',
})
export class PointWorkflow {
  readonly view = input.required<WorkflowView>();
  readonly roleId = input.required<string>();
  readonly busy = input(false);
  readonly lastAppliedAction = input<WorkflowAction | null>(null);
  readonly action = output<WorkflowAction>();

  protected readonly point = computed(() =>
    this.view().points.find(({ roleId }) => roleId === this.roleId()),
  );
  protected readonly proposal = computed(() => {
    const proposal = this.point()?.proposal;
    return proposal?.username === this.view().actor?.username ? proposal : null;
  });
  protected readonly actor = computed(() => {
    if (this.point()?.isSenior) return 'Старший';
    if (this.view().actor?.isAdmin) return 'Координатор';
    if (this.point()?.member) return 'Волонтёр';
    return '';
  });
  protected readonly options = computed(() => {
    const point = this.point();
    return point ? (transitions[point.kind]?.[point.status] ?? []) : [];
  });
  protected readonly commands = computed(() =>
    this.view().commands.flatMap((command) => {
      const target = command.targets.find(({ roleId }) => roleId === this.roleId());
      return target ? [{ ...command, target }] : [];
    }),
  );
  protected readonly requests = computed(() =>
    this.view().requests.filter(({ roleId }) => roleId === this.roleId()),
  );
  protected readonly activeSos = computed(() =>
    this.requests().find((request) => request.type === 'sos' && this.requestOpen(request)),
  );
  protected readonly nextState = linkedSignal({
    source: () => `${this.roleId()}:${this.point()?.version}`,
    computation: () => '',
  });
  protected readonly reason = linkedSignal({
    source: () => `${this.roleId()}:${this.nextState()}`,
    computation: () => '',
  });
  protected readonly requestText = linkedSignal({
    source: () => this.roleId(),
    computation: () => '',
  });
  protected readonly requestType = linkedSignal<string, Request['type']>({
    source: () => this.roleId(),
    computation: () => 'question',
  });
  protected readonly reply = linkedSignal<string, Reply | null>({
    source: () => this.roleId(),
    computation: () => null,
  });
  private readonly sent = signal<RequestDraft | null>(null);

  protected readonly stateLabels = pointStatusLabels;
  protected readonly commandLabels = commandLabels;
  protected readonly targetLabels = {
    pending: 'Ожидает подтверждения',
    acknowledged: 'Принята',
    executed: 'Выполнена',
  };
  protected readonly requestTypes = requestTypeLabels;
  protected readonly requestStatuses = requestStatusLabels;

  constructor() {
    effect(() => {
      const applied = this.lastAppliedAction();
      if (!applied) return;
      untracked(() => {
        const sent = this.sent();
        if (applied.action === 'create-request' && applied.requestId === sent?.requestId) {
          if (sent.roleId === this.roleId() && this.requestText().trim() === sent.text) {
            this.requestText.set('');
          }
          this.sent.set(null);
        }
        if (
          applied.action === 'message-request' &&
          this.replyText(applied.id).trim() === applied.text
        ) {
          this.reply.set(null);
        }
      });
    });
  }

  protected changeState(point: Point): void {
    const status = this.options().find((option) => option === this.nextState());
    const reason = this.reason().trim();
    if (!status || (status === 'paused' && !reason)) return;
    this.action.emit({
      action: 'set-point-status',
      roleId: point.roleId,
      status,
      expectedVersion: point.version,
      ...(reason ? { reason } : {}),
    });
  }

  protected canExecute(point: Point, command: Command): boolean {
    if (command.type === 'close_intake')
      return point.status === 'intake' || point.status === 'paused';
    if (command.type === 'prepare_checkout') return point.status === 'intake_closed';
    return true;
  }

  protected requestOpen(request: Request): boolean {
    return !['resolved', 'cancelled', 'closed'].includes(request.status);
  }

  protected createRequest(type: Request['type']): void {
    const text = type === 'sos' ? '' : this.requestText().trim();
    if (type !== 'sos' && !text) return;
    const previous = this.sent();
    const roleId = this.roleId();
    const requestId =
      previous?.roleId === roleId && previous.type === type && previous.text === text
        ? previous.requestId
        : crypto.randomUUID();
    this.sent.set({ roleId, type, text, requestId });
    this.action.emit({
      action: 'create-request',
      roleId,
      type,
      requestId,
      ...(text ? { text } : {}),
    });
  }

  protected replyText(id: string): string {
    const reply = this.reply();
    return reply?.id === id ? reply.text : '';
  }

  protected sendReply(request: Request): void {
    const text = this.replyText(request.id).trim();
    if (!text) return;
    this.action.emit({ action: 'message-request', id: request.id, text });
  }
}
