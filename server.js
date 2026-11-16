"use strict";

var cluster = require("cluster");
var os = require("os");
var express = require('express');
var mongoose = require('mongoose');
var nconf = require("nconf");
var passport = require("passport");
var logger = require('./util/logger');
var SIS = require("./util/constants");
var createSchemaManager = require('./util/schema-manager');
var sessionManagerModule = require("./util/session-manager");
var hookManagerModule = require('./util/hook-manager');
var webUtil = require("./routes/webutil");

// routes we want to include
var routes = [
    require('./routes/schemas'),
    require('./routes/entities'),
    require('./routes/hiera'),
    require('./routes/hooks'),
    require('./routes/users'),
    require('./routes/tokens'),
    require('./routes/info'),
    require('./routes/scripts'),
    require('./routes/endpoints')
];

// Throws if the app config has settings that cannot work together
var validateAppConfig = function(appConfig) {
    appConfig = appConfig || { };
    if (appConfig[SIS.OPT_AUTH_READS] && !appConfig[SIS.OPT_USE_AUTH]) {
        throw new Error("app." + SIS.OPT_AUTH_READS + " requires app." +
                        SIS.OPT_USE_AUTH + " to be enabled");
    }
};

// Load the JWT session keys.  Throws if auth is enabled and the keys are
// missing or invalid.  Read-only servers only need the public keys; they
// mint tokens only if a private key is also present.
var createSessionManager = function(appConfig, logger) {
    appConfig = appConfig || { };
    if (!appConfig[SIS.OPT_USE_AUTH]) {
        return null;
    }
    return sessionManagerModule(appConfig[SIS.OPT_JWT], {
        requireSigningKey : !appConfig[SIS.OPT_READONLY],
        logger : logger
    });
};

// Resolves with the http server once app listens on port - rejects if it
// cannot, e.g. when the port is taken
var listen = function(app, port) {
    return new Promise(function(resolve, reject) {
        var httpServer = app.listen(port, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(httpServer);
            }
        });
    });
};

var startServer = function(callback) {
    var LOGGER = logger.createLogger({
        name : "SISServer"
    });

    var allowCrossDomain = function(req,res,next) {
        var origin = req.get("origin") || "*";
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
        res.set('Access-Control-Allow-Headers', 'Content-Type,X-Requested-With,x-auth-token,Authorization');
        res.set('Access-Control-Expose-Headers', "x-total-count,WWW-Authenticate");
        next();
    };

    var app = express();

    app.use(logger.loggingMiddleware());

    app.use(express.json({
        // set byte limit
        limit : SIS.MAX_BODY_SIZE_BYTES
    }));
    // Express 5 makes req.query a getter that re-parses on every access, so
    // mutations (e.g. applyDefaults setting populate) would be lost.  Replace it
    // with a concrete, mutable own-property parsed once per request.
    app.use(function(req, res, next) {
        var parsed = req.query;
        Object.defineProperty(req, 'query', {
            value : parsed,
            writable : true,
            configurable : true,
            enumerable : true
        });
        next();
    });
    app.use(allowCrossDomain);

    // Setup global options
    // --------------------
    app.head('/',function(req,res) {
        res.sendStatus(200);
    });
    app.options('/',function(req,res) {
        res.sendStatus(200);
    });
    app.disable('etag');
    app.enable('trust proxy');
    // Express 5 defaults the query parser to 'simple'; SIS relies on nested
    // query parsing (e.g. q[...] objects), which needs the 'extended' (qs) parser.
    app.set('query parser', 'extended');

    // fail fast on invalid settings before touching the database
    validateAppConfig(nconf.get('app'));
    var sessionManager = createSessionManager(nconf.get('app'), LOGGER);

    var opts = nconf.get('db').opts || { };

    // connect, set up the routes and listen
    var start = async function() {
        await mongoose.connect(nconf.get('db').url, opts);

        // express app settings
        var appConfig = nconf.get('app') || {};
        for (var k in appConfig) {
            app.set(k, appConfig[k]);
        }
        app.locals.closeListeners = [];
        var schemaManager = createSchemaManager(mongoose, appConfig);
        await schemaManager.bootstrapEntitySchemas();
        passport.use(webUtil.createTokenStrategy(schemaManager, sessionManager));
        passport.use(webUtil.createUserPassStrategy(schemaManager, appConfig));

        app.use(passport.initialize());

        var cfg = { };
        cfg[SIS.OPT_SCHEMA_MGR] = schemaManager;
        cfg[SIS.OPT_USE_AUTH] = app.get(SIS.OPT_USE_AUTH);
        cfg[SIS.OPT_AUTH_READS] = !!app.get(SIS.OPT_AUTH_READS);
        cfg[SIS.OPT_SESSION_MGR] = sessionManager;
        app.set(SIS.OPT_SCHEMA_MGR, schemaManager);
        app.set(SIS.OPT_SESSION_MGR, sessionManager);

        // Validate the API :version param (Express 5 dropped inline route
        // regex that previously restricted it to SUPPORTED_VERSIONS).
        app.param('version', function(req, res, next, version) {
            if (SIS.SUPPORTED_VERSIONS.indexOf(version) === -1) {
                var verr = SIS.ERR_NOT_FOUND('version', version);
                return res.status(verr[0]).send(verr[1]);
            }
            next();
        });

        // setup the routes
        routes.forEach(function(route) {
            route.setup(app, cfg);
        });

        // setup error handler
        app.use(logger.errorLoggingMiddleware());
        app.use(function(err, req, res, next) {
            var errObj = webUtil.toSisError(err);
            res.status(errObj[0]).send(errObj[1]);
        });

        // listen once the indexes of every model (e.g. the unique names of
        // schemas and users) exist, so no write can slip past them
        await Promise.all(mongoose.modelNames().map(function(name) {
            return schemaManager.indexesReady(mongoose.model(name));
        }));
        var httpServer = await listen(app, nconf.get('server').port);
        httpServer.on("close", function() {
            app.locals.closeListeners.forEach(function(handler) {
                handler();
            });
        });
        if (callback) {
            callback(app, httpServer);
        }
    };

    start().catch(function(err) {
        // e.g. no database, a stored schema that cannot be built or a port
        // that is taken
        LOGGER.error({ err : err }, "Error starting the server");
        process.exit(1);
    });
};

function main() {
    nconf.env({ separator : '__', parseValues : true })
        .argv()
        .file("config.json.local", __dirname + "/conf/config.json.local")
        .file("config.json", __dirname + "/conf/config.json");

    var LOGGER = logger.createLogger({
        name : "SISMain"
    });

    // Check the config once, before forking, so a bad setting exits with a
    // clear message instead of crashing (and re-forking) every worker.
    try {
        validateAppConfig(nconf.get('app'));
        createSessionManager(nconf.get('app'));
    } catch (ex) {
        LOGGER.fatal(ex.message);
        process.exit(1);
    }

    var setupCloseHandlers = function(app, server) {
        mongoose.connection.on('error', function(err) {
            LOGGER.error({ err : err }, "A connection error occurred.");
            server.close(function() {
                process.exit(1);
            });
        });

        process.on("SIGINT", function() {
            server.close(function() {
                process.exit(0);
            });
        });
    };

    if (nconf.get("app:use_cluster")) {
        if (cluster.isPrimary) {
            var cpuCount = os.cpus().length;
            var worker = null;
            // Create a worker for each CPU
            for (var i = 0; i < cpuCount; i += 1) {
                worker = cluster.fork();
                LOGGER.info({ worker_pid : worker.process.pid }, "Created worker");
            }
            var listening = new Set();
            cluster.on('listening', function(worker) {
                listening.add(worker.id);
            });
            // create workers when they exit - unless one exits before it
            // listens, as its replacement would fail to start the same way
            // (e.g. the port is taken or there is no database)
            cluster.on('exit', function(worker, code, signal) {
                if (!listening.has(worker.id)) {
                    LOGGER.fatal({ worker_pid : worker.process.pid, code : code, signal : signal },
                                 "A worker failed to start. Stopping the server.");
                    cluster.removeAllListeners('exit');
                    Object.values(cluster.workers).forEach(function(w) {
                        w.process.kill();
                    });
                    process.exit(1);
                }
                listening.delete(worker.id);
                LOGGER.error({ worker_pid : worker.process.pid }, 'worker died. forking again.');
                cluster.fork();
            });
        } else {
            startServer(setupCloseHandlers);
        }
    } else {
        startServer(setupCloseHandlers);
    }
}

// Run if we're the root module
if (!module.parent) {
    main();
}


module.exports.mongoose = mongoose;
module.exports.startServer = startServer;
module.exports.validateAppConfig = validateAppConfig;
module.exports.createSessionManager = createSessionManager;
// stops accepting requests, then lets running hook lookups finish so the
// database connection can be closed
module.exports.stopServer = function(server, callback) {
    server.close(async function(err) {
        await hookManagerModule.lookupsDone();
        callback(err);
    });
};
