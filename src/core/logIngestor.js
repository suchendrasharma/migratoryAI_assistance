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
    .replace(/\b(?:event|event_name|action|type)=\S+/gi, ' ')
    .replace(/\b(?:user|user_id|uid|customer_id)=\S+/gi, ' ')
    .replace(/\b(?:timestamp|time|ts)=\S+/gi, ' ')
    .replace(new RegExp(`\\b${LEVEL_PATTERN}\\b`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferEventFromMessage(line) {
  const message = compactMessage(line);
  const event = normalizeEvent(message);

  return event || null;
}

function extractFirstMatch(line, patterns) {
  for (const pattern of patterns) {
    const match = line.match(pattern);

    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

function parseLogLine(line) {
  const rawLine = String(line || '').trim();

  if (!rawLine) {
    return null;
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
    /\b(?:user_id|user|uid|customer_id)=["']?([a-zA-Z0-9_.:-]+)["']?/i,
  ]);
  const timestamp = extractFirstMatch(rawLine, [
    /\b(?:timestamp|time|ts)=["']?(\d{1,2}:\d{2}(?::\d{2})?)["']?/i,
    /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/,
    /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/,
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
          apiKey: options.openAiApiKey,
          model: options.openAiModel,
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
