// Stand-in tokenizer worker that dies as it loads, as a damaged bundle would.
// Each start is recorded as one byte in the file the test names, so the test
// can count how many times the service respawned it.
const spawnLog = process.env.LLM_TOKENIZER_TEST_SPAWN_LOG;
if (spawnLog) {
    require('fs').appendFileSync(spawnLog, 'x');
}
throw new Error('fixture: this worker fails as it loads');
