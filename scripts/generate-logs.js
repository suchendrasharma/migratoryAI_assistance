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
  'User logout'
];

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
  const time = randomTime();

  logs += `[${level}] ${event} for user ${user} at ${time}\n`;

  // Add some messy logs (for testing AI later)
  if (i % 10 === 0) {
    logs += `Unexpected failure occurred at module X\n`;
  }
}

fs.writeFileSync('logs.txt', logs);

console.log('logs.txt generated with 5000+ entries 🚀');