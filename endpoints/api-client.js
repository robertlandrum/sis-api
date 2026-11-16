"use strict";

var webUtil = require("../routes/webutil");
var createEntityManager = require("../util/entity-manager");
var _ = require("lodash");

// get and listAll of the objects of manager
function GenericEp(manager) {
    this.get = function(id) {
        return manager.getById(id, { read : "nearest", lean : true });
    };

    this.listAll = function(query) {
        query = query || { };
        var rq = webUtil.parseQuery(query, '1.1', false);
        if (rq.query === webUtil.ERROR_QUERY) {
            return Promise.reject(webUtil.invalidQueryError());
        }
        var lean = true;
        var options = { read : "nearest" };
        if (rq.sort) { options.sort = rq.sort; }
        if (rq.limit) { options.limit = rq.limit; }
        if (rq.offset) { options.skip = rq.offset; }
        options.lean = lean;
        return manager.getAll(rq.query, options, rq.fields);
    };
}

// like GenericEp, but get resolves with { id : hieradata } as the hiera API sends it
function HieraEp(hieraManager) {
    GenericEp.call(this, hieraManager);
    var getEntry = this.get;
    this.get = function(id) {
        return getEntry(id).then(function(obj) {
            var result = {};
            result[id] = obj.hieradata || { };
            return result;
        });
    };
}

function EntityEp(name, schemaManager) {
    // looked up on first use - a client for a schema that does not exist
    // only fails the calls made on it
    var mgr = null;
    var getManager = function() {
        if (!mgr) {
            mgr = schemaManager.getById(name, { lean : true }).then(function(schema) {
                var model = schemaManager.getEntityModel(schema);
                return createEntityManager(model, schema, { });
            });
        }
        return mgr;
    };

    this.get = function(id, query) {
        query = query || { };
        var rq = webUtil.parseQuery(query, '1.1', false);
        var populate = webUtil.parsePopulate(query);
        var lean = false;
        return getManager().then(function(em) {
            lean = em.model.schema._sis_defaultpaths.length === 0;
            var options = { read : "nearest" };
            options.lean = lean;
            if (populate) {
                return em.getPopulateFields(schemaManager, populate)
                .then(function(populateFields) {
                    if (populateFields) {
                        options.populate = populateFields;
                    }
                    return em.getById(id, options);
                });
            } else {
                return em.getById(id, options);
            }
        }).then(function(result) {
            if (!lean) {
                result = result.toObject();
            }
            return result;
        });
    };

    this.listAll = function(query) {
        query = query || { };
        var rq = webUtil.parseQuery(query, '1.1', false);
        if (rq.query === webUtil.ERROR_QUERY) {
            return Promise.reject(webUtil.invalidQueryError());
        }
        var populate = webUtil.parsePopulate(query);
        var lean = false;
        return getManager().then(function(mgr) {
            lean = mgr.model.schema._sis_defaultpaths.length === 0;
            return webUtil.flattenCondition(rq.query, schemaManager, mgr).then(function(flattenedCondition) {
                var options = { read: "nearest" };
                if (rq.sort) { options.sort = rq.sort; }
                if (rq.limit) { options.limit = rq.limit; }
                if (rq.offset) { options.skip = rq.offset; }
                options.lean = lean;
                if (populate) {
                    return mgr.getPopulateFields(schemaManager, populate)
                    .then(function(fields) {
                        if (fields) {
                            options.populate = fields;
                        }
                        return mgr.getAll(flattenedCondition, options, rq.fields);
                    });
                } else {
                    return mgr.getAll(flattenedCondition, options, rq.fields);
                }
            });
        }).then(function(result) {
            if (!lean) {
                result = result.map(function(o) { return o.toObject(); });
            }
            return result;
        });
    };
}

function Client(schemaManager, hieraManager) {

    var epCache = { };
    this.entities = function(name) {
        if (!epCache[name]) {
            epCache[name] = new EntityEp(name, schemaManager);
        }
        return epCache[name];
    };
    this.hiera = new HieraEp(hieraManager);
    this.schemas = new GenericEp(schemaManager);
}

module.exports = Client;
