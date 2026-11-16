import bunyan from "bunyan";
import crypto from "crypto";
import nconf from "nconf";
import _ from "lodash";

// logger middleware

function toResponseTime(time) {
    var diff = process.hrtime(time);
    return (diff[0] * 1000) + (diff[1] / 1000000);
}

// A bunyan logger with opts and the configured logger:options.  It is made
// the first time it is used, so modules can create their loggers when they
// load - before the configuration is read.
function createLogger(opts) {
    var log = null;
    var getLog = function() {
        if (!log) {
            var serializerOpts = {
                serializers : {
                    err : bunyan.stdSerializers.err
                }
            };
            log = bunyan.createLogger(_.merge({ }, opts, nconf.get("logger:options"), serializerOpts));
        }
        return log;
    };
    return new Proxy({ }, {
        get : function(target, prop) {
            var l = getLog();
            var value = l[prop];
            return typeof value === "function" ? value.bind(l) : value;
        }
    });
}

export { createLogger };

// heavily borrowed from https://github.com/villadora/express-bunyan-logger/blob/master/index.js
// but trimmed down
// The errors are sent by the error handler server.js adds after this.
export function errorLoggingMiddleware(opts) {
    if (process.env.SIS_DISABLE_LOGGING === 'true') {
        return function(err, req, res, next) {
            next(err);
        };
    }
    opts = opts || { };
    opts.name = opts.name || "SIS";
    opts.serializers = opts.serializers || { };
    opts.serializers.req = opts.serializers.req || bunyan.stdSerializers.req;
    opts.serializers.res = opts.serializers.res || bunyan.stdSerializers.res;
    opts.serializers.err = opts.serializers.err || bunyan.stdSerializers.err;
    var logger = createLogger(opts);

    return function(err, req, res, next) {
        var startTime = process.hrtime();
        req.id = crypto.randomUUID();
        var childLogger = logger.child({ req_id : req.id });
        req.log = childLogger;
        res.log = childLogger;

        function log() {
            res.removeListener('finish', log);
            res.removeListener('close', log);

            var logMsg = {
                status : res.statusCode,
                method : req.method,
                url : req.originalUrl,
                httpVersion : [req.httpVersionMajor, req.httpVersionMinor].join("."),
                responseTime : toResponseTime(startTime)
            };

            if (err) {
                logMsg.err = err;
                childLogger.error(logMsg);
            } else {
                childLogger.info(logMsg);
            }
        }

        res.on('finish', log);
        res.on('close', log);
        next(err);
    };
}

export function loggingMiddleware(opts) {
    var logger = errorLoggingMiddleware(opts);
    return function(req, res, next) {
        logger(null, req, res, next);
    };
}
