// Stand-in tokenizer worker that answers every count with the text's length,
// except "CRASH", which makes it throw asynchronously without replying — the
// shape of crash that emits 'error' and then, a turn later, 'exit'.
const { parentPort } = require('worker_threads');

parentPort.on('message', request => {
    if (request.type === 'count' && request.text === 'CRASH') {
        setTimeout(() => {
            throw new Error('fixture: asynchronous crash');
        }, 0);
        return;
    }
    parentPort.postMessage({ type: 'count', id: request.id, count: request.text.length, exact: true });
});
