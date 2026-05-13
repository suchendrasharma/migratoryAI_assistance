const fs = require('fs');
const readline = require('readline');

const { parseWithLLM } = require('../ai/logParserLLM');

const DEFAULT_COLLECTION = 'logs';
const LEVEL_PATTERN = '(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)';

function normalizeLevel(level) {
  if (!level) {
    return null;
  }

  const normalized = String(level).toUpperCase();
  return normalized === 'WARNING' ? 'WARN' : normalized;
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

function compactMessage(value) {
  return String(value || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\b\w+=\S+/gi, ' ')
    .replace(/\b(?:for\s+)?(?:user|customer|uid)\s+[a-zA-Z0-9_.:-]+/gi, ' ')
    .replace(/\bat\s+\d{1,2}:\d{2}(?::\d{2})?/gi, ' ')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, ' ')
    .replace(/\b[a-f0-9]{24,}\b/gi, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(new RegExp(`\\b${LEVEL_PATTERN}\\b`, 'gi'), ' ')
    .replace(/\b(?:the|a|an|for|to|from|due|with|into|out|of|in|on|by|is|was|has|have|been|be|are)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferEventFromMessage(line) {
  const message = compactMessage(line);
  const event = normalizeEvent(message);

  return event || null;
}

const JSON_LEVEL_FIELDS = ['level', 'severity', 'lvl', 'loglevel'];
const JSON_MESSAGE_FIELDS = ['message', 'msg', 'log'];
const JSON_TIMESTAMP_FIELDS = ['timestamp', 'time', 'ts', '@timestamp'];
const JSON_USERID_FIELDS = ['user_id', 'userId', 'uid', 'customer_id', 'customerId'];
const JSON_EVENT_FIELDS = ['event', 'event_name', 'action'];

function extractFirstMatch(line, patterns) {
  for (const pattern of patterns) {
    const match = line.match(pattern);

    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

function parseJsonLogLine(rawLine) {
  let obj;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return null;
  }

  if (typeof obj !== 'object' || obj === null) {
    return null;
  }

  let rawLevel = null;
  for (const field of JSON_LEVEL_FIELDS) {
    if (typeof obj[field] === 'string') { rawLevel = obj[field]; break; }
  }

  let message = null;
  for (const field of JSON_MESSAGE_FIELDS) {
    if (typeof obj[field] === 'string') {
      message = obj[field].replace(/\\n$/, '').trim();
      break;
    }
  }

  if (!rawLevel && message) {
    rawLevel = extractFirstMatch(message, [
      new RegExp(`\\[${LEVEL_PATTERN}\\]`, 'i'),
      new RegExp(`\\b${LEVEL_PATTERN}\\b`, 'i'),
    ]);
  }

  const level = normalizeLevel(rawLevel);

  let event = null;
  for (const field of JSON_EVENT_FIELDS) {
    if (typeof obj[field] === 'string') { event = normalizeEvent(obj[field]); break; }
  }
  if (!event && message) {
    event = inferEventFromMessage(message);
  }

  if (!level || !event) {
    return null;
  }

  let userId = null;
  for (const field of JSON_USERID_FIELDS) {
    if (obj[field] != null) { userId = String(obj[field]); break; }
  }

  let timestamp = null;
  for (const field of JSON_TIMESTAMP_FIELDS) {
    if (typeof obj[field] === 'string') { timestamp = obj[field]; break; }
  }

  return { level, event, user_id: userId, timestamp, raw_message: rawLine };
}

function parseLogLine(line) {
  const rawLine = String(line || '').trim();

  if (!rawLine) {
    return null;
  }

  if (rawLine.startsWith('{')) {
    const jsonResult = parseJsonLogLine(rawLine);
    if (jsonResult) return jsonResult;
  }

  const level = normalizeLevel(
    extractFirstMatch(rawLine, [
      new RegExp(`\\[${LEVEL_PATTERN}\\]`, 'i'),
      new RegExp(`\\b${LEVEL_PATTERN}\\b`, 'i'),
    ])
  );
  const event = normalizeEvent(
    extractFirstMatch(rawLine, [
      /\b(?:event|event_name|action|type)=["']?([a-zA-Z0-9_.:-]+)["']?/i,
    ])
  ) || inferEventFromMessage(rawLine);
  const userId = extractFirstMatch(rawLine, [
    /\b(?:user_id|uid|customer_id)=["']?([a-zA-Z0-9_.:-]+)["']?/i,
    /\b(?:user_id|uid|customer_id):\s*["']?([a-zA-Z0-9_.:-]+)["']?/i,
    /\bfor\s+(?:user|customer)\s+([a-zA-Z0-9_.:-]+)/i,
    /\buser\s+(\d+)\b/i,
  ]);
  const timestamp = extractFirstMatch(rawLine, [
    /\[(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\]/,
    /\b(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\b/,
    /\b(?:timestamp|time|ts)=["']?(\d{1,2}:\d{2}(?::\d{2})?)["']?/i,
    /\[(\d{2}:\d{2}(?::\d{2})?)\]/,
    /\bat\s+(\d{2}:\d{2}(?::\d{2})?)\b/,
  ]);

  if (!level || !event) {
    return null;
  }

  return {
    level,
    event,
    user_id: userId,
    timestamp,
    raw_message: rawLine,
  };
}

function calculateCoverage(parsedCount, unparsedCount) {
  const total = parsedCount + unparsedCount;

  if (total === 0) {
    return 0;
  }

  return Math.round((parsedCount / total) * 100);
}

async function ingestLogFile(filePath, options = {}) {
  const collection = options.collection || DEFAULT_COLLECTION;
  const documents = [];
  const unparsed = [];
  const stream = fs.createReadStream(filePath, { encoding: options.encoding || 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    let parsedDocument = parseLogLine(trimmedLine);

    if (!parsedDocument && options.llmFallback) {
      if (options.onProgress) {
        options.onProgress({
          phase: 'llm-retry',
          parsedCount: documents.length,
          unparsedCount: unparsed.length,
        });
      }

      try {
        parsedDocument = await parseWithLLM(trimmedLine, {
          apiKey: options.llmApiKey,
          model: options.llmModel,
        });
      } catch (error) {
        if (options.throwOnLlmError) {
          throw error;
        }
      }
    }

    if (parsedDocument) {
      documents.push(parsedDocument);
      if (options.onProgress) {
        options.onProgress({
          phase: 'parse-success',
          parsedCount: documents.length,
          unparsedCount: unparsed.length,
          parser: options.llmFallback ? 'regex-or-ai' : 'regex',
        });
      }
      continue;
    }

    if (options.onProgress) {
      options.onProgress({
        phase: 'parse-failed',
        parsedCount: documents.length,
        unparsedCount: unparsed.length + 1,
      });
    }

    unparsed.push(trimmedLine);
  }

  return {
    collection,
    documents,
    unparsed,
    coverage: calculateCoverage(documents.length, unparsed.length),
  };
}

module.exports = {
  ingestLogFile,
  parseLogLine,
  parseWithLLM,
};
