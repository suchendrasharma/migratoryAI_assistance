const { parseLogLine } = require('../src/core/logIngestor');

const formats = [
  {
    label: '1. Bracket + prose (generated format)',
    line: '[INFO] Payment failed for user 999 at 14:02',
  },
  {
    label: '2. Key=value pairs',
    line: '[ERROR] event=payment_failed user_id=123 timestamp=10:32',
  },
  {
    label: '3. ISO timestamp + key=value',
    line: '[2026-05-13T10:34:22.000Z] [ERROR] event=payment_failed user_id=456',
  },
  {
    label: '4. Log4j / Java style',
    line: '2026-05-13 10:34:22,456 ERROR [main] com.example.App - Payment failed',
  },
  {
    label: '5. Python standard logging',
    line: '2026-05-13 10:34:22,456 - myapp - ERROR - Payment failed for user 123',
  },
  {
    label: '6. Logfmt (structured key=value)',
    line: 'time=2026-05-13T10:34:22Z level=error event=payment_failed user_id=789 msg="Payment processing failed"',
  },
  {
    label: '7. JSON log line',
    line: '{"level":"error","message":"Payment failed","timestamp":"2026-05-13T10:34:22.000Z","userId":"123"}',
  },
  {
    label: '8. Spring Boot',
    line: '2026-05-13 10:34:22.456  ERROR 1234 --- [main] com.example.App : Payment failed for user 321',
  },
  {
    label: '9. Syslog style',
    line: 'May 13 10:34:22 hostname myapp[1234]: ERROR: Connection refused for user_id=55',
  },
  {
    label: '10. Rails logger',
    line: 'I, [2026-05-13T10:34:22.456Z #1234]  INFO -- : Order placed for user 88',
  },
  {
    label: '11. Winston / Node.js JSON',
    line: '{"level":"warn","message":"Session expired","userId":"77","timestamp":"2026-05-13T10:34:22.000Z"}',
  },
  {
    label: '12. Docker / k8s log wrapper',
    line: '{"log":"ERROR Payment failed\\n","stream":"stderr","time":"2026-05-13T10:34:22.456Z"}',
  },
  {
    label: '13. Plain text (no structure)',
    line: 'Unexpected failure occurred at module X',
  },
  {
    label: '14. WARN with customer_id',
    line: '[WARN] Retry attempt customer_id=999 at 08:15',
  },
  {
    label: '15. Multiword event with uid',
    line: '[DEBUG] Database timeout uid=42 timestamp=2026-05-13T07:00:00Z',
  },
];

let passed = 0;
let failed = 0;

for (const { label, line } of formats) {
  const result = parseLogLine(line);
  const ok = result !== null;

  if (ok) passed++;
  else failed++;

  const status = ok ? '✓ PARSED' : '✗ UNPARSED';
  console.log(`\n${status}  ${label}`);
  console.log(`  input : ${line}`);
  if (result) {
    console.log(`  level : ${result.level}`);
    console.log(`  event : ${result.event}`);
    console.log(`  user  : ${result.user_id}`);
    console.log(`  time  : ${result.timestamp}`);
  }
}

console.log(`\n--- Coverage: ${passed}/${formats.length} parsed (${Math.round(passed / formats.length * 100)}%) ---`);
