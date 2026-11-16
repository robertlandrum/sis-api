"use strict";

// Small native-promise helpers replacing the bluebird-specific sugar
// (.pending / .tap / .nodeify) that SIS relied on.

// A deferred: { promise, resolve, reject }  (was BPromise.pending()).
exports.defer = function() {
    var resolve, reject;
    var promise = new Promise(function(res, rej) {
        resolve = res;
        reject = rej;
    });
    return { promise: promise, resolve: resolve, reject: reject };
};

// Node-style callback bridge (was promise.nodeify(cb)). Returns the promise.
exports.nodeify = function(promise, cb) {
    if (typeof cb !== 'function') {
        return promise;
    }
    promise.then(function(r) { cb(null, r); }, function(e) { cb(e); });
    return promise;
};

// Run a side effect, then pass the original value through (was .tap(fn)).
// Use as: promise.then(tap(function(val) { ... }))
exports.tap = function(fn) {
    return function(val) {
        return Promise.resolve(fn(val)).then(function() { return val; });
    };
};
