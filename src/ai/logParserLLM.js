const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4o-mini';

const LOG_PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    parsed: {
      type: 'boolean',
      description: 'Whether the log line contains enough signal to parse into a structured log event.',
    },
    level: {
      type: ['string', 'null'],
      enum: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', null],
    },
    event: {
      type: ['string', 'null'],
      description: 'Snake_case event name inferred from the log line.',
    },
    user_id: {
      type: ['string', 'null'],
    },
    timestamp: {
      type: ['string', 'null'],
    },
    raw_message: {
      type: 'string',
    },
  },
  required: ['parsed', 'level', 'event', 'user_id', 'timestamp', 'raw_message'],
};

function getOpenAiApiKey(options = {}) {
  return options.apiKey || process.env.OPENAI_API_KEY;
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

function extractResponseText(responsePayload) {
  if (typeof responsePayload.output_text === 'string') {
    return responsePayload.output_text;
  }

  if (!Array.isArray(responsePayload.output)) {
    return '';
  }

  for (const item of responsePayload.output) {
    if (!Array.isArray(item.content)) {
      continue;
    }

    const textContent = item.content.find((content) => {
      return content && (content.type === 'output_text' || content.type === 'text');
    });

    if (textContent && typeof textContent.text === 'string') {
      return textContent.text;
    }
  }

  return '';
}

function normalizeLlmParseResult(rawLine, parsedPayload) {
  if (!parsedPayload || parsedPayload.parsed !== true) {
    return null;
  }

  if (!parsedPayload.level || !parsedPayload.event) {
    return null;
  }

  return {
    level: String(parsedPayload.level).toUpperCase(),
    event: normalizeEvent(parsedPayload.event),
    user_id: parsedPayload.user_id === undefined ? null : parsedPayload.user_id,
    timestamp: parsedPayload.timestamp === undefined ? null : parsedPayload.timestamp,
    raw_message: rawLine,
  };
}

async function parseWithLLM(rawLine, options = {}) {
  const apiKey = getOpenAiApiKey(options);

  if (!apiKey) {
    throw new Error('Missing OpenAI API key. Set OPENAI_API_KEY or pass apiKey.');
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model || process.env.OPENAI_LOG_PARSER_MODEL || DEFAULT_MODEL,
      input: [
        {
          role: 'system',
          content: [
            'You parse application log lines into JSON.',
            'Return parsed=false when the line is random text or does not contain a log event.',
            'Use uppercase levels and snake_case event names.',
          ].join(' '),
        },
        {
          role: 'user',
          content: `Parse this log line as JSON:\n${rawLine}`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'log_parse_result',
          strict: true,
          schema: LOG_PARSE_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI log parsing failed. HTTP ${response.status}: ${details}`);
  }

  const responsePayload = await response.json();
  const outputText = extractResponseText(responsePayload);
  const parsedPayload = JSON.parse(outputText);

  return normalizeLlmParseResult(rawLine, parsedPayload);
}

module.exports = {
  parseWithLLM,
};
