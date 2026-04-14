const assert = require('node:assert/strict');

const { parseWithLLM } = require('../src/ai/logParserLLM');

async function runScenario() {
  const originalFetch = global.fetch;
  const rawLine = 'Payment failed for customer 123 at 10:32 severity critical';

  global.fetch = async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer test-api-key');

    const body = JSON.parse(request.body);

    assert.equal(body.model, 'gpt-test');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.name, 'log_parse_result');
    assert.equal(body.text.format.strict, true);

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          output_text: JSON.stringify({
            parsed: true,
            level: 'ERROR',
            event: 'payment_failed',
            user_id: '123',
            timestamp: '10:32',
            raw_message: rawLine,
          }),
        };
      },
    };
  };

  try {
    const parsed = await parseWithLLM(rawLine, {
      apiKey: 'test-api-key',
      model: 'gpt-test',
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
