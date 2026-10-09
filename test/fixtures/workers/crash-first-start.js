// Stand-in tokenizer worker that dies on its first start only. Every later
// start runs the real bundled worker, so a downloaded vocabulary can be loaded
// and counted with exactly as in production. Starts are counted in the file
// named by LLM_TOKENIZER_TEST_SPAWN_LOG, one byte each.
const fs = require('fs');
const path = require('path');

const spawnLog = process.env.LLM_TOKENIZER_TEST_SPAWN_LOG;
const starts = spawnLog && fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').length : 0;
if (spawnLog) {
    fs.appendFileSync(spawnLog, 'x');
}
if (starts === 0) {
    throw new Error('fixture: this worker fails on its first start');
}
require(path.join(__dirname, '..', '..', '..', 'out', 'worker.js'));
