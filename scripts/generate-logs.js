const fs = require('fs');

const levels = ['INFO', 'ERROR', 'WARN', 'DEBUG'];
const events = [
  'Login success',
  'Payment failed',
  'Order placed',
  'Session expired',
  'Retry attempt',
  'Database timeout',
  'File uploaded',
  'User logout',
];

function randomIso() {
  const d = new Date(Date.now() - Math.random() * 86400000);
  return d.toISOString();
}

function randomTime() {
  const h = String(Math.floor(Math.random() * 24)).padStart(2, '0');
  const m = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  return `${h}:${m}`;
}

function randomUser() {
  return Math.floor(Math.random() * 1000);
}

let logs = '';

for (let i = 0; i < 5000; i++) {
  const level = levels[Math.floor(Math.random() * levels.length)];
  const event = events[Math.floor(Math.random() * events.length)];
  const user = randomUser();
  const format = i % 3;

  if (format === 0) {
    // bracket + prose: [INFO] Payment failed for user 999 at 14:02
    logs += `[${level}] ${event} for user ${user} at ${randomTime()}\n`;
  } else if (format === 1) {
    // ISO timestamp + key=value: [2026-04-07T15:35:52.000Z] [INFO] event=payment_failed user_id=999
    const eventKey = event.toLowerCase().replace(/\s+/g, '_');
    logs += `[${randomIso()}] [${level}] event=${eventKey} user_id=${user}\n`;
  } else {
    // ISO timestamp + prose (real-world style)
    logs += `[${randomIso()}] : [${level.toLowerCase()}] ${event} for user_id=${user}\n`;
  }

  // Every 10th line: ambiguous noise (for LLM fallback testing)
  if (i % 10 === 0) {
    logs += `Unexpected failure occurred at module X\n`;
  }
}

fs.writeFileSync('logs.txt', logs);

console.log('logs.txt generated with 5000+ entries');
