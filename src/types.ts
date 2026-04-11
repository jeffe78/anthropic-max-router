/**
 * EDUCATIONAL AND ENTERTAINMENT PURPOSES ONLY
 *
 * This software is provided for educational, research, and entertainment purposes only.
 * It is not affiliated with, endorsed by, or sponsored by Anthropic PBC.
 * Use at your own risk. No warranties provided. Users are solely responsible for
 * ensuring compliance with Anthropic's Terms of Service and all applicable laws.
 *
 * Copyright (c) 2025 - Licensed under MIT License
 */

/**
 * OAuth token response from Anthropic
 */
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  expires_at?: number;
  created_at?: string;
}

/**
 * Anthropic API request configuration
 */
export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: SystemMessage[];
  messages: Message[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  stream?: boolean;
}

/**
 * System message structure
 */
export interface SystemMessage {
  type: 'text';
  text: string;
  cache_control?: {
    type: 'ephemeral';
  };
}

/**
 * User/Assistant message
 */
export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/**
 * Content block for messages
 */
export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  [key: string]: unknown;
}

/**
 * Tool definition
 */
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool choice configuration
 */
export interface ToolChoice {
  type: 'auto' | 'any' | 'tool';
  name?: string;
}

/**
 * Anthropic API response
 */
export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * OAuth configuration
 */
export interface OAuthConfig {
  client_id: string;
  authorize_url: string;
  token_url: string;
  redirect_uri: string;
  scope: string;
}

/**
 * OpenAI Chat Completion Message
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/**
 * OpenAI Tool Call
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI Tool Definition
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * OpenAI Chat Completion Request
 */
export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: OpenAITool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  logprobs?: boolean;
  top_logprobs?: number;
}

/**
 * OpenAI Chat Completion Response Choice
 */
export interface OpenAIChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * OpenAI Chat Completion Response
 */
export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  system_fingerprint?: string;
}

/**
 * OpenAI Streaming Delta
 */
export interface OpenAIStreamDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

/**
 * OpenAI Streaming Choice
 */
export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * OpenAI Chat Completion Stream Chunk
 */
export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI Error Response
 */
export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}

/**
 * CLI Backend Types — for parsing `claude -p --output-format stream-json` output
 */

/** Wraps a standard Anthropic SSE event — the .event field is identical to API SSE payloads */
export interface CliStreamEvent {
  type: 'stream_event';
  event: Record<string, unknown>;
  session_id: string;
  parent_tool_use_id: string | null;
}

/** Emitted at process start with session info */
export interface CliSystemEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  tools: string[];
}

/** Emitted at process end with usage summary */
export interface CliResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  result: string;
  stop_reason: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

/** Contains a complete Anthropic-format message object */
export interface CliAssistantEvent {
  type: 'assistant';
  message: AnthropicResponse;
  session_id: string;
}

/** Union of all CLI stream-json event types */
export type CliEvent = CliStreamEvent | CliSystemEvent | CliResultEvent | CliAssistantEvent;

/**
 * Backend abstraction types
 */

export interface BackendResult {
  status: number;
  isStream: boolean;
  /** SSE-formatted chunks for streaming responses */
  stream?: AsyncIterable<Uint8Array>;
  /** Parsed response for non-streaming responses */
  json?: AnthropicResponse;
}

export type BackendExecutor = (
  request: AnthropicRequest,
  options: BackendOptions
) => Promise<BackendResult>;

export interface BackendOptions {
  requestId: string;
  accessToken?: string;
}

/**
 * OpenAI Codex Responses API types
 */

/** Input item for the Responses API */
export interface CodexInputItem {
  type?: 'message';
  role: 'user' | 'assistant' | 'system';
  content: string | CodexContentPart[];
}

/** Content part within a Codex input item */
export interface CodexContentPart {
  type: 'input_text' | 'output_text';
  text: string;
}

/** Tool definition for the Responses API */
export interface CodexToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Request body for POST /v1/responses */
export interface CodexResponsesRequest {
  model: string;
  instructions?: string;
  input: string | CodexInputItem[];
  stream?: boolean;
  tools?: CodexToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  store?: boolean;
}

/** Output item from the Responses API */
export interface CodexOutputItem {
  type: 'message';
  id: string;
  role: 'assistant';
  content: CodexOutputContentPart[];
  status?: string;
}

/** Content part within a Codex output item */
export interface CodexOutputContentPart {
  type: 'output_text';
  text: string;
}

/** Non-streaming response from POST /v1/responses */
export interface CodexResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  output: CodexOutputItem[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  status: 'completed' | 'failed' | 'cancelled';
  error?: {
    code: string;
    message: string;
  };
}

/** OpenAI OAuth tokens (slightly different shape from Anthropic) */
export interface OpenAIOAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  expires_at?: number;
  created_at?: string;
}
