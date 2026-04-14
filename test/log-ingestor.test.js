const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ingestLogFile, parseLogLine } = require('../src/core/logIngestor');

async function runScenario() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migratoryai-logs-'));
  const filePath = path.join(tempDir, 'logs.txt');

  fs.writeFileSync(
    filePath,
    [
      '[ERROR] Payment failed event=payment_failed user_id=123 timestamp=10:32',
      '[INFO] User login event=user_login user_id=456 timestamp=10:33',
      'Some random log line',
    ].join('\n'),
    'utf8'
  );

  try {
    assert.deepEqual(
      parseLogLine('[ERROR] Payment failed event=payment_failed user_id=123 timestamp=10:32'),
      {
        level: 'ERROR',
        event: 'payment_failed',
        user_id: '123',
        timestamp: '10:32',
        raw_message: '[ERROR] Payment failed event=payment_failed user_id=123 timestamp=10:32',
      }
    );

    const result = await ingestLogFile(filePath);

    assert.equal(result.collection, 'logs');
    assert.equal(result.documents.length, 2);
    assert.deepEqual(result.documents[0], {
      level: 'ERROR',
      event: 'payment_failed',
      user_id: '123',
      timestamp: '10:32',
      raw_message: '[ERROR] Payment failed event=payment_failed user_id=123 timestamp=10:32',
    });
    assert.deepEqual(result.unparsed, ['Some random log line']);
    assert.equal(result.coverage, 67);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runScenario()
  .then(() => {
    console.log('Log ingestor test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
