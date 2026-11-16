"use strict";

var webUtil = require("../routes/webutil");
var createEntityManager = require("../util/entity-manager");

// Set options.populate to the paths of mgr the query wants populated
async function setPopulate(query, mgr, schemaManager, options) {
    var populate = webUtil.parsePopulate(query);
    if (!populate) {
        return;
    }
    var populateFields = await mgr.getPopulateFields(schemaManager, populate);
    if (populateFields) {
        options.populate = populateFields;
    }
}

// The find options of a parsed query
function findOptions(rq, lean) {
    var options = { read : "nearest", lean : lean };
    if (rq.sort) { options.sort = rq.sort; }
    if (rq.limit) { options.limit = rq.limit; }
    if (rq.offset) { options.skip = rq.offset; }
    return options;
}

// Parse the query of listAll - rejecting one whose q is not a JSON object
function parseListQuery(query) {
    var rq = webUtil.parseQuery(query || { }, '1.1', false);
    if (rq.query === webUtil.ERROR_QUERY) {
        throw webUtil.invalidQueryError();
    }
    return rq;
}

// get and listAll of the objects of manager
function GenericEp(manager) {
    this.get = async function(id) {
        return manager.getById(id, { read : "nearest", lean : true });
    };

    this.listAll = async function(query) {
        var rq = parseListQuery(query);
        return manager.getAll(rq.query, findOptions(rq, true), rq.fields);
    };
}

// like GenericEp, but get resolves with { id : hieradata } as the hiera API sends it
function HieraEp(hieraManager) {
    GenericEp.call(this, hieraManager);
    var getEntry = this.get;
    this.get = async function(id) {
        var obj = await getEntry(id);
        var result = {};
        result[id] = obj.hieradata || { };
        return result;
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

    // models with default values are not read lean, so the defaults apply
    var isLean = function(em) {
        return em.model.schema._sis_defaultpaths.length === 0;
    };

    this.get = async function(id, query) {
        var em = await getManager();
        var lean = isLean(em);
        var options = { read : "nearest", lean : lean };
        await setPopulate(query || { }, em, schemaManager, options);
        var result = await em.getById(id, options);
        return lean ? result : result.toObject();
    };

    this.listAll = async function(query) {
        var rq = parseListQuery(query);
        var em = await getManager();
        var lean = isLean(em);
        var condition = await webUtil.flattenCondition(rq.query, schemaManager, em);
        var options = findOptions(rq, lean);
        await setPopulate(query || { }, em, schemaManager, options);
        var result = await em.getAll(condition, options, rq.fields);
        return lean ? result : result.map(function(o) { return o.toObject(); });
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
