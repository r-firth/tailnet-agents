export type Device = {
  id: string;
  name: string;
  target: string | null;
  status: string;
  source?: string;
  os?: string;
  address?: string | null;
  tailscale_id?: string | null;
  ssh?: string;
};
export type Session = {
  id: string;
  name: string;
  device_id: string;
  cwd: string;
  owner: "user" | "agent";
  closed: boolean;
  created_at: string;
};
export type Chat = {
  id: string;
  name: string;
  created_at: string;
  closed?: boolean;
  closing?: boolean;
  close_error?: string | null;
  session_ids?: string[];
  title_generated?: boolean;
  updated_at?: string;
};
export type Event = {
  id: number;
  kind: string;
  scope: string;
  time: string;
  payload: Record<string, any>;
};
export type HubState = {
  public_origin?: string | null;
  devices: Device[];
  discovery?: {
    status: string;
    message: string;
    last_sync: string | null;
    count: number;
  };
  sessions: Session[];
  chats: Chat[];
  events: Event[];
  live: string[];
  running: string[];
  event_count: number;
  embedding_status: string;
  model: string;
};
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("AUTH_REQUIRED");
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return response.json();
}
export const wsUrl = (path: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api${path}`;
