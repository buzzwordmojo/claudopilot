import type { PMAdapter, StatusConfig } from "../types.js";

const BASE_URL = "https://api.clickup.com/api/v2";

export class ClickUpAdapter implements PMAdapter {
  name = "clickup";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `ClickUp API error ${res.status}: ${body}`
      );
    }

    return res.json() as Promise<T>;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.request<{ user: { id: number } }>("/user");
      return true;
    } catch {
      return false;
    }
  }

  async getWorkspaces(): Promise<{ id: string; name: string }[]> {
    const data = await this.request<{
      teams: { id: string; name: string }[];
    }>("/team");
    return data.teams.map((t) => ({ id: t.id, name: t.name }));
  }

  async getSpaces(
    workspaceId: string
  ): Promise<{ id: string; name: string }[]> {
    const data = await this.request<{
      spaces: { id: string; name: string }[];
    }>(`/team/${workspaceId}/space`);
    return data.spaces.map((s) => ({ id: s.id, name: s.name }));
  }

  async getLists(
    spaceId: string
  ): Promise<{ id: string; name: string }[]> {
    // Get folderless lists
    const folderless = await this.request<{
      lists: { id: string; name: string }[];
    }>(`/space/${spaceId}/list`);

    // Get folders and their lists
    const folders = await this.request<{
      folders: { id: string; name: string; lists: { id: string; name: string }[] }[];
    }>(`/space/${spaceId}/folder`);

    const folderLists = folders.folders.flatMap((f) =>
      f.lists.map((l) => ({ id: l.id, name: `${f.name}/${l.name}` }))
    );

    return [...folderless.lists, ...folderLists];
  }

  async configureStatuses(
    listId: string,
    statuses: StatusConfig
  ): Promise<void> {
    const statusValues = Object.values(statuses);

    // ClickUp requires override_statuses to set list-level statuses
    // Without it, statuses are inherited from the space and silently ignored
    await this.request(`/list/${listId}`, {
      method: "PUT",
      body: JSON.stringify({
        override_statuses: true,
        statuses: statusValues.map((s, i) => ({
          status: s,
          order_index: i,
          color: STATUS_COLORS[i] ?? "#808080",
          type: i === 0 ? "open" : i === statusValues.length - 1 ? "closed" : "custom",
        })),
      }),
    });
  }

  async getTasksByStatus(
    listId: string,
    status: string
  ): Promise<{ id: string; name: string; status: string }[]> {
    const data = await this.request<{
      tasks: { id: string; name: string; status: { status: string } }[];
    }>(`/list/${listId}/task?statuses[]=${encodeURIComponent(status)}`);

    return data.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status.status,
    }));
  }

  async createWebhook(
    workspaceId: string,
    webhookUrl: string
  ): Promise<{ id: string }> {
    const data = await this.request<{ id: string; webhook: { id: string } }>(
      `/team/${workspaceId}/webhook`,
      {
        method: "POST",
        body: JSON.stringify({
          endpoint: webhookUrl,
          events: ["taskStatusUpdated"],
        }),
      }
    );
    return { id: data.webhook?.id ?? data.id };
  }

  async createList(
    spaceId: string,
    name: string
  ): Promise<{ id: string; name: string }> {
    const data = await this.request<{ id: string; name: string }>(
      `/space/${spaceId}/list`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
      }
    );
    return { id: data.id, name: data.name };
  }

  async getMembers(
    workspaceId: string
  ): Promise<{ id: string; username: string; email: string }[]> {
    const data = await this.request<{
      team: { members: { user: { id: number; username: string; email: string } }[] };
    }>(`/team/${workspaceId}`);
    return data.team.members.map((m) => ({
      id: String(m.user.id),
      username: m.user.username,
      email: m.user.email,
    }));
  }

  async getUser(): Promise<{ id: number; username: string; email: string }> {
    const data = await this.request<{
      user: { id: number; username: string; email: string };
    }>("/user");
    return data.user;
  }
}

const STATUS_COLORS = [
  "#6B7280", // idea - gray
  "#3B82F6", // planning - blue
  "#EF4444", // red team - red
  "#F59E0B", // blocked - amber
  "#8B5CF6", // awaiting approval - purple
  "#10B981", // approved - green
  "#06B6D4", // building - cyan
  "#F97316", // in review - orange
  "#22C55E", // done - green
];
