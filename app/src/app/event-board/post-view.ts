import type { Event, Task } from '../event.model';

export interface Post {
  id: string;
  title: string;
  description: string;
  tasks: Task[];
  done: number;
  total: number;
}

export const COMMON_POST_ID = ':common';

export function assignedPeople(item: { assignee: string; assignees?: string[] }): string[] {
  return item.assignees ?? (item.assignee ? [item.assignee] : []);
}

export function taskAssignedTo(task: Task, rolePeople: readonly string[], person: string): boolean {
  const direct = assignedPeople(task);
  return (direct.length ? direct : rolePeople).includes(person);
}

export function buildPosts(event: Event, person: string, showAllCommon = false): Post[] {
  const posts: Post[] = [];

  for (const role of event.roles) {
    const members = assignedPeople(role);
    const tasks = person
      ? role.tasks.filter((task) => taskAssignedTo(task, members, person))
      : role.tasks;
    if (!person || members.includes(person) || tasks.length) {
      posts.push(makePost(role.id, role.title, role.description, tasks));
    }
  }

  const common = person && !showAllCommon
    ? event.tasks.filter((task) => taskAssignedTo(task, [], person))
    : event.tasks;
  if (common.length) {
    posts.push(makePost(COMMON_POST_ID, 'Общие задачи', '', common));
  }

  return posts;
}

function makePost(id: string, title: string, description: string, tasks: Task[]): Post {
  return {
    id,
    title,
    description,
    tasks,
    done: tasks.filter((task) => task.status === 'done').length,
    total: tasks.length,
  };
}
