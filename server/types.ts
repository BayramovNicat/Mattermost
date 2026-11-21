export interface MattermostSession {
  baseUrl: string;
  token: string;
  csrfToken: string;
  userId: string;
  lang: string;
}

export interface PostOptions {
  page?: string | number;
  perPage?: string | number;
  before?: string;
  after?: string;
}

export interface SearchPostsOptions {
  terms: string;
  teamId?: string;
  isOrSearch?: boolean;
  includeDeletedChannels?: boolean;
  timeZoneOffset?: number;
  page?: number;
  perPage?: number;
}

export interface SearchPostsResponse {
  order?: string[];
  posts?: Record<
    string,
    { id: string; user_id: string; channel_id: string; [key: string]: unknown }
  >;
  matches?: Record<string, string[]>;
}

export interface WebSocketMessage {
  event?: string;
  data?: Record<string, unknown>;
  broadcast?: {
    channel_id?: string;
    user_id?: string;
    team_id?: string;
  };
  seq?: number;
  status?: string;
  seq_reply?: number;
}
