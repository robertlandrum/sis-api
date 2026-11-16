import ChildProcess from "child_process";
import express from "express";
import Pool from "generic-pool";
import nconf from "nconf";
import * as P from "../util/promises.js";
import * as logger from "../util/logger.js";
import SIS from "../util/constants.js";
import * as webUtil from "./webutil.js";

var WORKER_LOGGER = logger.createLogger({ name:"EndpointWorker" });
var LOGGER = logger.createLogger({ name : "EndpointController" });

// child states
var IDLE = 0,
    DEAD = 1,
    SPAWNING = 2,
    BUSY = 3,
    ERROR = 4,
    DESTROYED = 5,
    TIMEDOUT = 6;

// small wrapper around the sandbox process
// takes in a pending defer and resolves it
// when done or should be killed.  A worker that is not IDLE between
// requests is broken, and the pool replaces it (see validate below).
class EndpointWorker {
    constructor() {
        this.childproc = null;
        this.childState = DEAD;

        // request being handled and callback
        // set per request
        this.currentReq = null;
        this.defer = null;
        this.reqTimer = null;
    }

    // called when a worker needs to be created
    create() {
        if (this.childState !== DEAD) {
            return Promise.reject({ error: "Process is in invalid state: " + this.childState });
        }
        var args = [];
        // inherit the parent environment so db/config overrides (e.g. db__url)
        // propagate to the worker; flag test runs so it loads the test config.
        var env = Object.assign({}, process.env);
        if (nconf.get("app:test")) {
            env.TESTING = true;
        }
        var createDefer = P.defer();
        this.childState = SPAWNING;
        this.child = ChildProcess.fork(import.meta.dirname + "/../endpoints/main.js", args, { env : env });
        // set a timeout - no message back in 5 seconds is bad
        var timer = setTimeout(function() {
            this.childState = ERROR;
            this.destroy();
            LOGGER.error("Failed to spawn child within 5 seconds");
            createDefer.reject({ error : "Failed to spawn within 5 seconds" });
        }.bind(this), 5000);
        this.child.on("message", function(msg) {
            var type = msg.type;
            var data = msg.data;
            if (type === SIS.EP_DONE) {
                if (this.childState === BUSY) {
                    this.childState = IDLE;
                    clearTimeout(this.reqTimer);
                    this.reqTimer = null;
                    // send it back up to the master
                    this.defer.resolve(data);
                } else if (this.childState === TIMEDOUT) {
                    // ignore - the request already timed out
                }
            } else if (type === SIS.EP_READY && this.childState === SPAWNING) {
                this.childState = IDLE;
                clearTimeout(timer);
                createDefer.resolve(this);
                LOGGER.debug({pid : this.child.pid}, "Spawned worker process");
            } else {
                // SIS.EP_ERROR
                // unexpected state
                WORKER_LOGGER.error({ message: "Received unexpected message.",
                                      data: msg,
                                      state: this.childState
                                    });
                var state = this.childState;
                this.childState = ERROR;
                if (state === SPAWNING) {
                    clearTimeout(timer);
                    this.destroy();
                    createDefer.reject({ error : "Failed to spawn within 5 seconds" });
                } else if (state === BUSY) {
                    WORKER_LOGGER.error("Unexpected message while busy");
                    // message during a request
                    this.defer.reject({ error : "Unexpected message received. "});
                }
                // an idle worker in the ERROR state is replaced when next taken
            }
        }.bind(this));
        this.child.on("exit", function(code, signal) {
            var state = this.childState;
            if (state === DESTROYED) {
                // we killed it
                return;
            }
            LOGGER.error({ pid : this.child.pid, code : code, signal : signal }, "Script process exited");
            this.childState = ERROR;
            clearTimeout(this.reqTimer);
            if (state === SPAWNING) {
                clearTimeout(timer);
                createDefer.reject({ error : "Script process exited while starting" });
            } else if (state === BUSY) {
                // fail the request now rather than when it times out
                this.defer.reject({ error : "Script process exited", status : 500 });
            }
            // an idle worker is replaced when next taken
        }.bind(this));
        // e.g. sending to a process that just died.  Without a listener the
        // error would end the server.
        this.child.on("error", function(err) {
            LOGGER.error({ err : err, pid : this.child.pid }, "Script process error");
            var state = this.childState;
            if (state === DESTROYED) {
                return;
            }
            this.childState = ERROR;
            clearTimeout(this.reqTimer);
            if (state === BUSY) {
                this.defer.reject({ error : "Script process failed", status : 500 });
            }
        }.bind(this));
        return createDefer.promise;
    }

    handleRequest(request) {
        if (this.childState !== IDLE) {
            return Promise.reject({ error : "Worker is busy", status : 500 });
        }
        this.currentReq = request;
        this.defer = P.defer();
        this.childState = BUSY;
        var req = this.currentReq.req;
        var message = {
            type : SIS.EP_REQ,
            data : {
                path : req.path,
                endpoint : req.params.id,
                method : req.method,
                body : req.body,
                query : req.query,
                headers : req.headers
            }
        };
        this.child.send(message);
        var self = this;
        this.reqTimer = setTimeout(function() {
            self.childState = TIMEDOUT;
            self.defer.reject({ error : "Request timed out", status : 500 });
        }, 10000);
        return this.defer.promise;
    }

    destroy() {
        // kill proc
        if (this.childState !== DESTROYED) {
            this.childState = DESTROYED;
            clearTimeout(this.reqTimer);
            this.child.kill("SIGKILL");
        }
    }
}

// Endpoint controller
// - Note that this runs in the main process
class EndpointController {
    constructor(config) {
        this.authReads = !!config[SIS.OPT_AUTH_READS];
        // create the pool of workers.  generic-pool v3 uses a promise-based
        // factory + createPool() rather than the v2 callback style.
        var factory = {
            create : function() {
                var worker = new EndpointWorker();
                return worker.create();
            },
            destroy : function(worker) {
                if (worker && worker.destroy) {
                    worker.destroy();
                }
                return Promise.resolve();
            },
            // a worker whose process died or misbehaved while idle is replaced
            validate : function(worker) {
                return Promise.resolve(worker.childState === IDLE);
            }
        };
        this.workerPool = Pool.createPool(factory, {
            min : nconf.get("app:scripts_min") || 1,
            max : nconf.get("app:scripts_max") || 2,
            idleTimeoutMillis : nconf.get("app:script_worker_idle_time_ms") || 300000,
            testOnBorrow : true
        });
        // v3 surfaces factory create failures via this event
        this.workerPool.on('factoryCreateError', function(err) {
            LOGGER.error(err);
        });
    }

    attach(app, base) {
        this.base = base;
        // ensure the request is handled with a slash
        var router = express.Router({ strict : true });
        if (this.authReads) {
            // endpoint scripts can read any data, so they need a token too
            router.use(webUtil.requireToken);
        }
        router.use("/:id/", this.handler.bind(this));
        app.use(base, router);
        app.locals.closeListeners.push(async () => {
            LOGGER.info("Draining pool");
            try {
                await this.workerPool.drain();
                await this.workerPool.clear();
            } catch (err) {
                LOGGER.error({ err : err }, "Error draining the pool");
            }
        });
    }

    // Run the request in a script process
    async handler(req, res) {
        var worker;
        try {
            worker = await this.workerPool.acquire();
        } catch (err) {
            LOGGER.error({ err : err }, "Unable to get a script process");
            res.status(500).json({ error : "Unable to run script.  Internal error", status : 500 });
            return;
        }
        try {
            var data = await worker.handleRequest({ req : req, res : res });
            res.status(data.status);
            res.set(data.headers);
            res.send(data.data);
            this.workerPool.release(worker);
        } catch (err) {
            if (err instanceof Error) {
                // the stack goes to the log, not to the client
                LOGGER.error({ err: err }, "Endpoint caught an error");
                err = {
                    status : 500,
                    error : String(err)
                };
            }
            // timeout or exception
            // errors from the script should be sent properly
            res.status(500).json(err);
            // always destroy badness - let the pool spin up another
            this.workerPool.destroy(worker).catch(function(e) {
                LOGGER.error({ err : e }, "Error destroying a script process");
            });
        }
    }
}

// all route controllers expose a setup method
export function setup(app, config) {
    if (!nconf.get('app:scripts_enabled')) {
        return;
    }
    var controller = new EndpointController(config);
    controller.attach(app, "/api/v1.1/endpoints");
}
