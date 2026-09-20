const { User } = require('leadpulse-data-model');
const callService = require('./app/components/call/call.service');

async function run() {
  try {
    const exec = await User.findOne({ where: { role: 'executive' } });
    if (!exec) return console.log('No executive found');
    console.log('Testing metrics for exec:', exec.id);
    const metrics = await callService.myMetrics(exec.id);
    console.log('Metrics result:', metrics);
  } catch (err) {
    console.error('Error:', err);
  }
}
run();
