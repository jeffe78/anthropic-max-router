import { AnthropicRequest, AnthropicResponse } from '../types.js';

export type LogLevel = 'quiet' | 'minimal' | 'medium' | 'maximum';

export class Logger {
  constructor(private level: LogLevel = 'medium') {}

  setLevel(level: LogLevel) {
    this.level = level;
  }

  startup(message: string) {
    // Always show startup messages unless quiet
    if (this.level !== 'quiet') {
      console.log(message);
    }
  }

  logRequest(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    hadSystemPrompt: boolean,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    if (this.level === 'quiet') {
      return;
    }

    if (this.level === 'minimal') {
      this.logMinimal(requestId, timestamp, request, response, error, endpointType);
    } else if (this.level === 'medium') {
      this.logMedium(requestId, timestamp, request, hadSystemPrompt, response, error, endpointType);
    } else if (this.level === 'maximum') {
      this.logMaximum(
        requestId,
        timestamp,
        request,
        hadSystemPrompt,
        response,
        error,
        endpointType
      );
    }
  }

  private logMinimal(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    const status = error ? '✗ ERROR' : response ? `✓ ${response.status}` : '...';
    const tokens = response?.data?.usage
      ? `(in:${response.data.usage.input_tokens} out:${response.data.usage.output_tokens})`
      : '';
    const endpoint = endpointType === 'openai' ? '[OpenAI]' : '[Anthropic]';

    console.log(
      `[${timestamp.substring(11, 19)}] ${endpoint} ${status} ${request.model} ${tokens}`
    );
  }

  private logMedium(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    hadSystemPrompt: boolean,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    const lines: string[] = [];
    lines.push(`\n[${timestamp}] [${requestId}] Incoming request`);
    lines.push(`  Model: ${request.model}`);
    lines.push(`  Max tokens: ${request.max_tokens}`);
    lines.push(hadSystemPrompt ? `  ✓ System prompt already present` : `  ✓ Injected required system prompt`);
    lines.push(`  ✓ OAuth token validated`);

    if (error) {
      lines.push(`  ✗ Error: ${error.message}`);
    } else if (response) {
      lines.push(`  → Forwarding to Anthropic API...`);
      if (response.status >= 200 && response.status < 300) {
        lines.push(`  ✓ Success (${response.status})`);
        if (response.data?.usage) {
          lines.push(`  Tokens: input=${response.data.usage.input_tokens}, output=${response.data.usage.output_tokens}`);
        }
      } else {
        lines.push(`  ✗ Error (${response.status})`);
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
  }

  private logMaximum(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    hadSystemPrompt: boolean,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    const sep = '='.repeat(80);
    const lines: string[] = [];
    lines.push('\n' + sep);
    lines.push(`[${timestamp}] [${requestId}] REQUEST`);
    lines.push(sep);
    lines.push('Request Body:');
    lines.push(JSON.stringify(request, null, 2));
    lines.push(hadSystemPrompt ? '\n✓ System prompt already present' : '\n✓ Injected required system prompt');
    lines.push('✓ OAuth token validated');
    lines.push('→ Forwarding to Anthropic API...\n');

    if (error) {
      lines.push(sep);
      lines.push('ERROR');
      lines.push(sep);
      lines.push(String(error));
    } else if (response) {
      lines.push(sep);
      lines.push(`RESPONSE (${response.status})`);
      lines.push(sep);
      lines.push(JSON.stringify(response.data, null, 2));
    }
    lines.push(sep + '\n');
    process.stdout.write(lines.join('\n') + '\n');
  }

  info(message: string) {
    if (this.level !== 'quiet') {
      console.log(message);
    }
  }

  error(message: string, error?: unknown) {
    // Always show errors
    console.error(message, error || '');
  }
}

export const logger = new Logger();
