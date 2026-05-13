const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const LOG_PARSE_TOOL = {
  name: 'parse_log_line',
  description: 'Parse a log line into structured log event fields.',
  input_schema: {
    type: 'object',
    properties: {
      parsed: {
        type: 'boolean',
        description: 'true if the line contains a recognizable log event, false if it is random noise.',
      },
      level: {
        type: ['string', 'null'],
        enum: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', null],
      },
      event: {
        type: ['string', 'null'],
        description: 'Snake_case event name inferred from the log message. Do not include user IDs, timestamps, or numeric IDs.',
      },
      user_id: {
        type: ['string', 'null'],
        description: 'User or customer identifier found in the log line, or null.',
      },
      timestamp: {
        type: ['string', 'null'],
        description: 'Timestamp string found in the log line (ISO 8601 preferred), or null.',
      },
    },
    required: ['parsed', 'level', 'event', 'user_id', 'timestamp'],
  },
};

function getApiKey(options = {}) {
  return options.apiKey || process.env.ANTHROPIC_API_KEY;
}

function normalizeEvent(value) {
  if (!value) {
    return null;
  }

  return String(value)
    .trim()
    .replace(/['"]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function extractToolInput(responsePayload) {
  if (!Array.isArray(responsePayload.content)) {
    return null;
  }

  const toolUse = responsePayload.content.find((block) => block.type === 'tool_use');
  return toolUse ? toolUse.input : null;
}

function normalizeLlmParseResult(rawLine, input) {
  if (!input || input.parsed !== true) {
    return null;
  }

  if (!input.level || !input.event) {
    return null;
  }

  return {
    level: String(input.level).toUpperCase(),
    event: normalizeEvent(input.event),
    user_id: input.user_id ?? null,
    timestamp: input.timestamp ?? null,
    raw_message: rawLine,
  };
}

async function parseWithLLM(rawLine, options = {}) {
  const apiKey = getApiKey(options);

  if (!apiKey) {
    throw new Error('Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass apiKey.');
  }

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model || process.env.CLAUDE_LOG_PARSER_MODEL || DEFAULT_MODEL,
      max_tokens: 256,
      system: 'You parse application log lines into structured fields. Use uppercase levels and snake_case event names. Event names must not include user IDs, timestamps, or numeric identifiers.',
      tools: [LOG_PARSE_TOOL],
      tool_choice: { type: 'tool', name: 'parse_log_line' },
      messages: [
        {
          role: 'user',
          content: `Parse this log line:\n${rawLine}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Claude log parsing failed. HTTP ${response.status}: ${details}`);
  }

  const responsePayload = await response.json();
  const toolInput = extractToolInput(responsePayload);

  return normalizeLlmParseResult(rawLine, toolInput);
}

module.exports = {
  parseWithLLM,
};
