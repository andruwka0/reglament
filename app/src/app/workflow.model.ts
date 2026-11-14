export const pointStatusLabels = {
  preparation: 'Подготовка',
  ready: 'Готова',
  working: 'В работе',
  paused: 'Приостановлена',
  finished: 'Завершена',
  intake: 'Приём открыт',
  intake_closed: 'Приём закрыт',
  checkout_preparation: 'Подготовка выдачи',
  checkout: 'Выдача',
} as const;

export const requestStatusLabels = {
  new: 'Новое',
  waiting: 'Ожидает ответа',
  in_progress: 'Принято',
  answered: 'Есть ответ',
  viewed: 'Просмотрено',
  resolved: 'Решено',
  cancelled: 'Отменено',
  closed: 'Закрыто',
} as const;

export const commandLabels = {
  close_intake: 'Закрыть приём',
  prepare_checkout: 'Подготовить выдачу',
  request_status: 'Запросить статус',
} as const;

export const requestTypeLabels = { sos: 'SOS', question: 'Вопрос', report: 'Отчёт' } as const;
export type PointKind = 'general' | 'registration' | 'cloakroom';
export type PointStatus = keyof typeof pointStatusLabels;
export type RequestType = keyof typeof requestTypeLabels;
export type RequestStatus = keyof typeof requestStatusLabels;
export type CommandType = keyof typeof commandLabels;
export type StageStatus = 'planned' | 'started' | 'finished';

export interface WorkflowPoint {
  roleId: string;
  title: string;
  kind: PointKind;
  status: PointStatus;
  version: number;
  senior: string | null;
  proposal: { id: string; username: string } | null;
  member: boolean;
  isSenior: boolean;
  canManage: boolean;
}

export interface WorkflowCommand {
  id: string;
  type: CommandType;
  message: string;
  createdAt: string;
  targets: {
    roleId: string;
    status: 'pending' | 'acknowledged' | 'executed';
    acknowledgedAt: string | null;
    executedAt: string | null;
  }[];
}

export interface WorkflowRequest {
  id: string;
  roleId: string;
  type: RequestType;
  status: RequestStatus;
  author: string;
  createdAt: string;
  acceptedBy: string | null;
  closedAt: string | null;
  messages: { id: string; author: string; text: string; createdAt: string }[];
}

export interface WorkflowStage {
  stageId: string;
  title: string;
  status: StageStatus;
  start: string;
  end: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowView {
  enabled: boolean;
  actor: { username: string | null; userId: string | null; isAdmin: boolean } | null;
  points: WorkflowPoint[];
  commands: WorkflowCommand[];
  requests: WorkflowRequest[];
  audit: {
    id: string;
    roleId: string | null;
    action: string;
    targetId: string | null;
    actor: string;
    createdAt: string;
    details: unknown;
  }[];
  stages: WorkflowStage[];
}

export type WorkflowAction =
  | { action: 'enable' }
  | { action: 'configure-point'; roleId: string; kind: PointKind }
  | { action: 'propose-senior'; roleId: string; username: string }
  | {
      action: 'accept-senior' | 'decline-senior' | 'revoke-proposal';
      roleId: string;
      proposalId: string;
    }
  | { action: 'revoke-senior'; roleId: string }
  | {
      action: 'set-point-status';
      roleId: string;
      status: PointStatus;
      expectedVersion: number;
      reason?: string;
    }
  | {
      action: 'create-command';
      type: CommandType;
      roleIds: string[];
      message?: string;
      requestId: string;
    }
  | { action: 'ack-command' | 'execute-command'; commandId: string; roleId: string }
  | {
      action: 'create-request';
      roleId: string;
      type: RequestType;
      text?: string;
      requestId: string;
    }
  | { action: 'message-request'; id: string; text: string }
  | {
      action:
        'accept-request' | 'resolve-request' | 'cancel-request' | 'close-request' | 'view-request';
      id: string;
    }
  | { action: 'mark-stage'; stageId: string; status: 'started' | 'finished' };
