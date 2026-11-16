'use strict';

var SIS = require("../util/constants");
var webUtil = require("./webutil");
var nconf = require("nconf");

var CHUNK_SIZE = 100;

// Write the array to the response as JSON - a chunk at a time, letting the
// event loop run between the chunks of a large array
async function writeJSONArray(res, array) {
    if (!array.length) {
        res.write("[]");
        return;
    }
    for (var start = 0; start < array.length; start += CHUNK_SIZE) {
        if (start) {
            await new Promise(function(resolve) { setImmediate(resolve); });
        }
        var json = JSON.stringify(array.slice(start, start + CHUNK_SIZE));
        var last = start + CHUNK_SIZE >= array.length;
        // drop the brackets where the chunks meet
        res.write(json.substring(start ? 1 : 0, last ? json.length : json.length - 1));
        if (!last) {
            res.write(",");
        }
    }
}

// The controller base attaches to an express app and
// has the code for CRUD ops.  It delegates the ops
// to a manager and handles the authorization aspects here.
class ApiController {
    // opts is a dictionary w/ the following keys
    // - schema_manager - the schema manager across the system
    // - auth - boolean (default true) indicating if auth is enabled
    // - auth_reads - boolean (default false) indicating if GET requests
    //       also require a valid token
    // - type - optional string indicating the type for hooks/commits
    // - log_commits - boolean indicating if this controller should
    //       log creates/update/deletions
    // - fire_hooks - boolean indicating if web hooks should be fired
    constructor(opts) {
        this.sm = opts[SIS.OPT_SCHEMA_MGR];
        this.auth = SIS.OPT_USE_AUTH in opts ? opts[SIS.OPT_USE_AUTH] : SIS.DEFAULT_OPT_USE_AUTH;
        this.authReads = SIS.OPT_AUTH_READS in opts ? !!opts[SIS.OPT_AUTH_READS] : SIS.DEFAULT_OPT_AUTH_READS;
        opts = opts || { };
        if (opts[SIS.OPT_TYPE]) {
            this.type = opts[SIS.OPT_TYPE];
        }
        if (opts[SIS.OPT_LOG_COMMTS]) {
            this.commitManager = require("../util/commit-manager")(this.sm);
            if (opts[SIS.OPT_ID_FIELD]) {
                this.commitManager.idField = opts[SIS.OPT_ID_FIELD];
            }
        }
        if (opts[SIS.OPT_FIRE_HOOKS]) {
            this.hm = require('../util/hook-manager')(this.sm);
        }
        this.getterReadPref = nconf.get("app:get_read_pref");
    }

    // overrides
    // Returns a promise that returns a Manager instance.
    // Subclasses can assign a manager to the 'manager' property.
    getManager(req) {
        if (this.manager) {
            req.useLean = true;
            return Promise.resolve(this.manager);
        } else {
            return Promise.reject(SIS.ERR_INTERNAL("Error fetching object"));
        }
    }

    // Get the type of object from the request
    getType(req) {
        return this.type || "invalid" ;
    }

    // Convert the object to an object suitable for the response.
    // Default does nothing, but subclasses may override to
    // remove fields from objects or translate it.
    // obj may be an individual object or an array of objects
    convertToResponseObject(req, obj) {
        // default does nothing
        // hiera needs to return a sub field
        return obj;
    }

    // Apply default parameters to a request
    applyDefaults(req) {
        // noop
    }

    shouldSaveCommit(req) {
        return (this.commitManager && req.method in SIS.METHODS_TO_EVENT);
    }

    // Utils - not normal to override these

    // Send an error via the response object
    // The err is usually an object returned via
    // SIS.ERR_* functions/properties
    sendError(res, err) {
        if (res.headersSent) {
            // too late to tell the client - e.g. a failure while streaming
            if (res.log) {
                res.log.error({ err : err }, "Error after the response was started");
            }
            return;
        }
        if (!(err instanceof Array) || err.length < 2) {
            if (res.log) {
                res.log.error(err);
            }
            // never send a raw error: it can hold internals such as a stack trace
            err = SIS.ERR_INTERNAL(err) || SIS.ERR_INTERNAL("unknown error");
        }
        res.status(err[0]).send(err[1]);
    }

    // Send a response with the specified code and data.  Resolves once it
    // is written.
    async sendObject(res, code, obj, isBulk) {
        res.setHeader("Content-Type","application/json");
        res.status(code);
        if (isBulk) {
            res.setHeader("X-Accel-Buffering","no");
            res.write('{"success":');
            await writeJSONArray(res, obj.success);
            res.write(',"errors":');
            await writeJSONArray(res, obj.errors);
            res.write("}");
            res.end();
        } else if (Array.isArray(obj) && obj.length >= CHUNK_SIZE) {
            res.setHeader("X-Accel-Buffering","no");
            await writeJSONArray(res, obj);
            res.end();
        } else {
            res.send(obj);
        }
    }

    // Parse the query parameters for a given req
    // Converts the q param to an object and assigns a
    // limit and offset
    parseQuery(req) {
        return webUtil.parseQuery(req.query, req.params.version, true);
    }

    parseUpsert(req) {
        if (typeof req.query.upsert == 'string') {
            return req.query.upsert == 'true';
        } else {
            return req.query.upsert || false;
        }
    }

    // parseQuery, but send a 400 and return null if q is not a JSON object
    _parseValidQuery(req, res) {
        var rq = this.parseQuery(req);
        if (rq.query === webUtil.ERROR_QUERY) {
            this.sendError(res, webUtil.invalidQueryError());
            return null;
        }
        return rq;
    }

    // Returns true if the request wants sub-documents populated
    parsePopulate(req) {
        return webUtil.parsePopulate(req.query);
    }

    // Set options.populate to the paths the request wants populated
    async _setPopulate(req, mgr, options) {
        var populate = this.parsePopulate(req);
        if (!populate) {
            return;
        }
        var populateFields = await mgr.getPopulateFields(this.sm, populate);
        if (populateFields) {
            options.populate = populateFields;
        }
    }

    // Handler for the getAll request (typically GET controller_base/)
    async getAll(req, res) {
        this.applyDefaults(req);
        var rq = this._parseValidQuery(req, res);
        if (!rq) {
            return;
        }
        var options = this._getReqOptions(req);
        options.skip = rq.offset;
        options.limit = rq.limit;
        if (rq.sort) {
            options.sort = rq.sort;
        }
        await this._finish(req, res, 200, async () => {
            var mgr = await this.getManager(req);
            var condition = await webUtil.flattenCondition(rq.query, this.sm, mgr);
            var count = await mgr.count(condition);
            res.setHeader(SIS.HEADER_TOTAL_COUNT, count);
            if (!count || count <= options.skip) {
                return [];
            }
            options.lean = req.useLean;
            await this._setPopulate(req, mgr, options);
            return mgr.getAll(condition, options, rq.fields);
        });
    }

    // Handler for the get request (typically GET controller_base/:id)
    async get(req, res) {
        this.applyDefaults(req);
        await this._finish(req, res, 200, async () => {
            var mgr = await this.getManager(req);
            var options = this._getReqOptions(req);
            options.lean = req.useLean;
            await this._setPopulate(req, mgr, options);
            return mgr.getById(req.params.id, options);
        });
    }

    // Handler for the delete request (typically DELETE controller_base/:id)
    async delete(req, res) {
        this.applyDefaults(req);
        var id = req.params.id;
        var options = this._getReqOptions(req);
        if (id) {
            await this._finish(req, res, 200, async () => {
                var mgr = await this.getManager(req);
                return mgr.delete(id, options);
            });
            return;
        }
        // bulk delete - query is required
        req.params.isBulk = true;
        var rq = this._parseValidQuery(req, res);
        if (!rq) {
            return;
        }
        if (!Object.keys(rq.query).length) {
            this.sendError(res, SIS.ERR_BAD_REQ("Bulk delete requires a non empty query."));
            return;
        }
        await this._finish(req, res, 200, async () => {
            var mgr = await this.getManager(req);
            var condition = await webUtil.flattenCondition(rq.query, this.sm, mgr);
            return mgr.bulkDelete(condition, options);
        });
    }

    async bulkUpdate(req, res) {
        // either an array of objects or a query with an object to set
        var obj = req.body;
        var options = this._getReqOptions(req);
        req.params.isBulk = true;
        if (Array.isArray(obj)) {
            if (!obj.length) {
                return this.sendError(res, SIS.ERR_BAD_REQ("Array must not be empty."));
            }
            // array of individual objects
            await this._finish(req, res, 200, async () => {
                var mgr = await this.getManager(req);
                return mgr.bulkUpdateArray(obj, options);
            });
            return;
        }
        if (typeof obj !== "object") {
            return this.sendError(res, SIS.ERR_BAD_REQ("Bulk update requires array or object as body"));
        }
        var rq = this._parseValidQuery(req, res);
        if (!rq) {
            return;
        }
        if (!Object.keys(rq.query).length) {
            return this.sendError(res, SIS.ERR_BAD_REQ("A valid query is required"));
        }
        if (!Object.keys(obj).length) {
            return this.sendError(res, SIS.ERR_BAD_REQ("Body should not be empty"));
        }
        await this._finish(req, res, 200, async () => {
            var mgr = await this.getManager(req);
            var condition = await webUtil.flattenCondition(rq.query, this.sm, mgr);
            return mgr.bulkUpdateQuery(condition, obj, options);
        });
    }

    // Handler for the update request (typically PUT controller_base:/id)
    async update(req, res) {
        this.applyDefaults(req);
        var id = req.params.id;
        var obj = req.body;
        var upsert = this.parseUpsert(req);
        var options = this._getReqOptions(req);
        options.forceMixed = req.query.forceMixed;
        if ('cas' in req.query) {
            var cas = req.query.cas;
            try {
                if (typeof cas === 'string') {
                    cas = JSON.parse(cas);
                }
            } catch (ex) {
                cas = { };
            }
            if (!cas || typeof cas !== 'object' ||
                cas instanceof Array ||
                !Object.keys(cas).length) {
                // invalid query
                return this.sendError(res, SIS.ERR_BAD_REQ("CAS condition must be an object."));
            }
            options.cas = cas;
        }
        await this._finish(req, res, 200, async () => {
            var mgr = await this.getManager(req);
            return upsert ? mgr.upsert(id, obj, options) : mgr.update(id, obj, options);
        });
    }

    // Handler for the add request (typically POST controller_base:/)
    async add(req, res) {
        this.applyDefaults(req);
        var body = req.body;
        if (body instanceof Array) {
            req.params.isBulk = true;
            if (typeof req.query.all_or_none == 'undefined') {
                req.query.all_or_none = false;
            } else {
                req.query.all_or_none = req.query.all_or_none == "true";
            }
            if (!body.length) {
                return this.sendError(res, SIS.ERR_BAD_REQ("Array must not be empty."));
            }
        }
        var options = this._getReqOptions(req);
        if (req.params.isBulk) {
            options.allOrNone = req.query.all_or_none;
            await this._finish(req, res, 200, async () => {
                var mgr = await this.getManager(req);
                return mgr.bulkAdd(body, options);
            });
        } else {
            await this._finish(req, res, 201, async () => {
                var mgr = await this.getManager(req);
                return mgr.add(body, options);
            });
        }
    }

    // Attach the controller to the app at a particular base
    attach(app, prefix) {
        // prepend prefix w/ /api/version str.  Express 5 (path-to-regexp v8) no
        // longer supports inline regex in the path, so the version is validated by
        // an app.param('version', ...) guard registered in server.js.
        prefix = "/api/:version" + prefix;
        this.apiPrefix = prefix;
        app.get(prefix, this._wrapReadAuth(this.getAll));
        app.get(prefix + "/:id", this._wrapReadAuth(this.get));
        if (!app.get(SIS.OPT_READONLY)) {
            // wrap authorization around modification calls
            app.put(prefix + "/:id", this._wrapAuth(this.update));
            app.put(prefix, this._wrapAuth(this.bulkUpdate));
            app.post(prefix, this._wrapAuth(this.add));
            // Express 5 dropped optional params (/:id?) - register both forms.
            // The delete handler bulk-deletes when no id is present.
            app.delete(prefix + "/:id", this._wrapAuth(this.delete));
            app.delete(prefix, this._wrapAuth(this.delete));
            // enable the commit api if we have a commitManager
            if (this.commitManager) {
                this._enableCommitApi(app, prefix);
            }
        }
    }

    // Returns a promise that authenticates a request
    // The type specifies which kind of authentication to use
    // and should have already been registered with passport
    authenticate(req, res, type) {
        return webUtil.authenticate(req, res, type);
    }

    // "private"
    // Wrap a controller func(req, res) as a request handler bound to the
    // controller that authenticates the request first if auth is enabled.
    // An error func throws is sent to the client.
    _wrapAuth(func) {
        return this._handler(func, this.auth);
    }

    // Wrap a read (GET) handler.  Reads only require a token when
    // auth_reads is enabled.
    _wrapReadAuth(func) {
        return this._handler(func, this.auth && this.authReads);
    }

    _handler(func, authenticate) {
        return async (req, res) => {
            try {
                if (authenticate) {
                    await this.authenticate(req, res, SIS.SCHEMA_TOKENS);
                }
                await func.call(this, req, res);
            } catch (err) {
                this.sendError(res, err);
            }
        };
    }

    // Enable the commit API endpoints
    _enableCommitApi(app, prefix) {
        // all history
        app.get(prefix + "/:id/commits", this._wrapReadAuth(async function(req, res) {
            req.params.isCommitApi = true;
            var rq = this._parseValidQuery(req, res);
            if (!rq) {
                return;
            }
            var mongooseModel = this.commitManager.model;
            // update the query for the right types
            rq.query.entity_id = req.params.id;
            rq.query.type = this.getType(req);
            var count = 0;
            var commits = [];
            try {
                count = await mongooseModel.countDocuments(rq.query).exec();
                if (count) {
                    var opts = { skip : rq.offset, limit: rq.limit};
                    commits = await mongooseModel.find(rq.query, rq.fields, opts).sort({date_modified: -1}).exec();
                }
            } catch (err) {
                // e.g. a query that cannot be cast - nothing matches it
                count = 0;
                commits = [];
            }
            res.setHeader(SIS.HEADER_TOTAL_COUNT, count);
            await this.sendObject(res, 200, commits);
        }));

        // specific entry by history id
        app.get(prefix + "/:id/commits/:hid", this._wrapReadAuth(async function(req, res) {
            var hid = req.params.hid;
            req.params.isCommitApi = true;
            var result = null;
            try {
                result = await this.commitManager.getVersionById(this.getType(req), req.params.id, hid);
            } catch (err) {
                result = null;
            }
            if (!result) {
                return this.sendError(res, SIS.ERR_NOT_FOUND("commit", hid));
            }
            result.value_at = this.convertToResponseObject(req, result.value_at);
            await this.sendObject(res, 200, result);
        }));

        app.get(prefix + "/:id/revision/:utc", this._wrapReadAuth(async function(req, res) {
            var utc = req.params.utc;
            req.params.isCommitApi = true;
            var result = null;
            try {
                result = await this.commitManager.getVersionByUtc(this.getType(req), req.params.id, utc);
            } catch (err) {
                result = null;
            }
            if (!result) {
                return this.sendError(res, SIS.ERR_NOT_FOUND("commit at time", utc));
            }
            await this.sendObject(res, 200, this.convertToResponseObject(req, result));
        }));
    }

    _convertToResponseObject(req, obj) {
        if (req.params.isBulk) {
            // change the success array
            obj.success = obj.success.map((o) => {
                if (req.method == SIS.METHOD_PUT) {
                    // get the update value
                    o = o.updated;
                }
                return this.convertToResponseObject(req, o);
            });
            return obj;
        }
        if (obj instanceof Array) {
            return obj.map((o) => this.convertToResponseObject(req, o));
        }
        return this.convertToResponseObject(req, obj);
    }

    // Send the result of the request and dispatch the hooks for it
    async _send(req, res, code, result) {
        // hooks get the object - and the old one for an update
        var toSend = result;
        var hookEvt = SIS.METHODS_TO_EVENT[req.method];
        if (!req.params.isBulk &&
            req.method == SIS.METHOD_PUT && req.params.id) {
            if (!result.old) {
                // an upsert that added the object - it was created
                code = 201;
                hookEvt = SIS.EVENT_INSERT;
                toSend = result.updated;
            }
            result = result.updated;
        }
        result = this._convertToResponseObject(req, result);
        var sent = this.sendObject(res, code, result, req.params.isBulk);
        // dispatch hooks
        if (this.hm && req.method in SIS.METHODS_TO_EVENT) {
            if (req.params.isBulk) {
                // the objects as sent in the response
                toSend = result.success;
            }
            this.hm.dispatchHooks(toSend, this.getType(req), hookEvt, req.params.isBulk);
        }
        await sent;
    }

    // Save the commit of the result.  A commit that fails to save doesn't
    // fail the request (for now) - it is logged.
    async _saveCommit(req, result) {
        if (!this.shouldSaveCommit(req)) {
            return;
        }
        var action = SIS.METHODS_TO_EVENT[req.method];
        var type = this.getType(req);
        try {
            if (req.params.isBulk) {
                if (result.success.length) {
                    await this.commitManager.recordHistoryBulk(result.success, req.user, action, type);
                }
            } else {
                // an update's old is null if an upsert added the object
                var old = req.method == SIS.METHOD_PUT ? result.old :
                          req.method == SIS.METHOD_DELETE ? result : null;
                var now = req.method == SIS.METHOD_PUT ? result.updated :
                          req.method == SIS.METHOD_POST ? result : null;
                await this.commitManager.recordHistory(old, now, req.user, type);
            }
        } catch (err) {
            if (req.log) {
                req.log.error({ err : err }, "Error saving the commit");
            }
        }
    }

    // Do the final steps of the request: resolve the result with work,
    // save its commit, send it and dispatch its hooks.  An error is sent
    // to the client.
    async _finish(req, res, code, work) {
        try {
            var result = await work();
            await this._saveCommit(req, result);
            await this._send(req, res, code, result);
        } catch (err) {
            this.sendError(res, err);
        }
    }

    // get request options to pass to managers per request
    _getReqOptions(req) {
        var result = {
            user : req.user,
            version : req.params.version,
            log : req.log,
            params : req.params,
            query : req.query
        };
        if (req.method === "GET" && this.getterReadPref) {
            result.read = this.getterReadPref;
        }
        return result;
    }
}

// export it
module.exports = exports = ApiController;
