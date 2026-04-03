const BASE_URL = "https://api.clickup.com/api/v2";

export class ClickUpClient {
  private readonly headers: Record<string, string>;
  private readonly workspaceId: string;

  constructor(apiKey: string, workspaceId: string) {
    this.workspaceId = workspaceId;
    this.headers = {
      Authorization: apiKey,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      ...options,
      headers: this.headers,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ClickUp API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async getTask(taskId: string) {
    return this.request<Record<string, unknown>>(
      `/task/${taskId}?team_id=${this.workspaceId}&include_subtasks=true&include_markdown_description=true`
    );
  }

  async createTask(listId: string, params: {
    name: string;
    markdown_description?: string;
    status?: string;
    tags?: string[];
    parent?: string;
  }) {
    return this.request<Record<string, unknown>>(`/list/${listId}/task`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async updateTask(taskId: string, params: {
    name?: string;
    markdown_description?: string;
    status?: string;
    assignees?: { add?: number[]; rem?: number[] };
  }) {
    return this.request<Record<string, unknown>>(`/task/${taskId}?team_id=${this.workspaceId}`, {
      method: "PUT",
      body: JSON.stringify(params),
    });
  }

  async getTaskComments(taskId: string) {
    return this.request<{ comments: Record<string, unknown>[] }>(
      `/task/${taskId}/comment?team_id=${this.workspaceId}`
    );
  }

  async createTaskComment(
    taskId: string,
    commentText: string,
    commentBlocks?: Record<string, unknown>[]
  ) {
    const body: Record<string, unknown> = commentBlocks
      ? { comment: commentBlocks, notify_all: false }
      : { comment_text: commentText };

    return this.request<Record<string, unknown>>(
      `/task/${taskId}/comment?team_id=${this.workspaceId}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  async getListTasks(listId: string, params: {
    archived?: boolean;
    page?: number;
    subtasks?: boolean;
    include_closed?: boolean;
    statuses?: string[];
  } = {}) {
    const queryParams = new URLSearchParams();

    if (params.archived !== undefined)
      queryParams.append("archived", params.archived.toString());
    if (params.page !== undefined)
      queryParams.append("page", params.page.toString());
    if (params.subtasks !== undefined)
      queryParams.append("subtasks", params.subtasks.toString());
    if (params.include_closed !== undefined)
      queryParams.append("include_closed", params.include_closed.toString());
    if (params.statuses) {
      for (const status of params.statuses) {
        queryParams.append("statuses[]", status);
      }
    }

    const queryString = queryParams.toString()
      ? `?${queryParams.toString()}`
      : "";

    return this.request<{ tasks: Record<string, unknown>[] }>(
      `/list/${listId}/task${queryString}`
    );
  }
}
