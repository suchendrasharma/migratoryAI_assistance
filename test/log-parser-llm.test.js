const assert = require('node:assert/strict');

const { parseWithLLM } = require('../src/ai/logParserLLM');

async function runScenario() {
  const originalFetch = global.fetch;
  const rawLine = 'Payment failed for customer 123 at 10:32 severity critical';

  global.fetch = async (url, request) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-api-key'], 'test-api-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');

    const body = JSON.parse(request.body);

    assert.equal(body.model, 'claude-test');
    assert.equal(body.tool_choice.type, 'tool');
    assert.equal(body.tool_choice.name, 'parse_log_line');
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools[0].name, 'parse_log_line');

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test123',
              name: 'parse_log_line',
              input: {
                parsed: true,
                level: 'ERROR',
                event: 'payment_failed',
                user_id: '123',
                timestamp: '10:32',
              },
            },
          ],
        };
      },
    };
  };

  try {
    const parsed = await parseWithLLM(rawLine, {
      apiKey: 'test-api-key',
      model: 'claude-test',
    });

    assert.deepEqual(parsed, {
      level: 'ERROR',
      event: 'payment_failed',
      user_id: '123',
      timestamp: '10:32',
      raw_message: rawLine,
    });
  } finally {
    global.fetch = originalFetch;
  }
}

runScenario()
  .then(() => {
    console.log('Log parser LLM test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
