
// Small native-promise helpers replacing the bluebird-specific sugar
// (.pending / .nodeify) that SIS relied on.

// A deferred: { promise, resolve, reject }  (was BPromise.pending()).
export function defer() {
    var resolve, reject;
    var promise = new Promise(function(res, rej) {
        resolve = res;
        reject = rej;
    });
    return { promise: promise, resolve: resolve, reject: reject };
}

// Node-style callback bridge (was promise.nodeify(cb)). Returns the promise.
export function nodeify(promise, cb) {
    if (typeof cb !== 'function') {
        return promise;
    }
    promise.then(function(r) { cb(null, r); }, function(e) { cb(e); });
    return promise;
}
