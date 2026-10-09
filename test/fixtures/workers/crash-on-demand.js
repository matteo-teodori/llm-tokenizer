// The real bundled worker, except that a count of the text "CRASH" makes it
// throw asynchronously without replying, as crash-async.js does. The count
// then settles only once the service has handled the crash, so a test can
// crash the worker exactly when it wants to, and still load and count a real
// vocabulary on every start.
const path = require('path');
const { parentPort } = require('worker_threads');

// Wraps the real worker's own listener, which it registers as it loads.
const on = parentPort.on.bind(parentPort);
parentPort.on = (event, listener) =>
    on(event, event !== 'message' ? listener : request => {
        if (request.type === 'count' && request.text === 'CRASH') {
            setTimeout(() => {
                throw new Error('fixture: asynchronous crash');
            }, 0);
            return;
        }
        listener(request);
    });

require(path.join(__dirname, '..', '..', '..', 'out', 'worker.js'));
