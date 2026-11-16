
// A class used to manage the SIS Hooks defined by the /hooks api

import qs from "qs";
import nconf from "nconf";
import * as logger from "./logger.js";
import SIS from "./constants.js";
import Manager from "./manager.js";

var LOGGER = logger.createLogger({
    name : "HookManager"
});

// Defaults merged into every outbound hook request (was request.defaults(...)).
var requestDefaults = { };


/////////////////////////////////

var sleep = function(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
};

// Send the hook request, retrying up to retryCount times delay seconds
// apart.  Resolves with the response body.
var sendRequest = async function(options, retryCount, delay) {
    var fetchOpts = Object.assign({ }, requestDefaults, { method: options.method });
    fetchOpts.headers = Object.assign({ }, requestDefaults.headers, options.headers);
    if (options.body !== undefined) {
        fetchOpts.body = options.body;
    }
    for (;;) {
        try {
            var res = await fetch(options.url, fetchOpts);
            if (res.status >= 300) {
                // non 2xx - treat as an error so the retry logic kicks in
                var httpErr = new Error("Hook target responded with status " + res.status);
                httpErr.statusCode = res.status;
                throw httpErr;
            }
            return await res.text();
        } catch (err) {
            LOGGER.error({ err: err }, "Error Response from Outbound Hook Request");
            if (retryCount <= 0) {
                LOGGER.error({ err: err }, "Exhausted retries");
                throw SIS.ERR_INTERNAL(err);
            }
            retryCount--;
            await sleep(delay * 1000);
        }
    }
};

// Send the event to the hook.  Resolves with the response body.
// entity is the object - or for an update that is not bulk, { old, updated }
var dispatchHook = function(hook, entity, event, isBulk) {
    // This check will never be true
    if (typeof entity.toObject === 'function') {
        entity = entity.toObject();
        //LOGGER.error({entity:entity},"Got a function instead of an entity");
    }
    var data = {
        'hook' : hook.name,
        'entity_type' : hook.entity_type,
        'event' : event,
        'data' : entity,
        'is_bulk' : isBulk || false
    };
    // what a GET hook gets as data, as JSON
    var serialized = entity;
    if (event == SIS.EVENT_UPDATE && !isBulk) {
        data.data = entity.updated;
        data.old_value = entity.old;
        // GET hooks have always been sent the [old, updated, null] array
        // update used to resolve with
        serialized = [entity.old, entity.updated, null];
    }
    var options = {
        "url" : hook.target.url,
        "method" : hook.target.action
    };
    if (options.method == 'GET') {
        data.data = JSON.stringify(serialized);
        // serialize with qs so the nested object round-trips through the
        // receiver's query parser (which also uses qs), e.g. data[entity_type]=...
        var query = qs.stringify({ 'data' : data });
        options.url += (options.url.indexOf('?') === -1 ? '?' : '&') + query;
    } else {
        options.headers = { 'content-type' : 'application/json' };
        options.body = JSON.stringify(data);
        LOGGER.info({ payload: data }, "Hook payload: ");
    }
    return sendRequest(options, hook.retry_count || 0, hook.retry_delay || 1);
};

// Hook dispatches run after the write's response is sent. Their lookups of the
// hooks to run are tracked, so a stopping server can let them finish before
// the database connection closes (the requests to the hooks are not waited for:
// with retries they can take minutes).
var pendingLookups = new Set();

function trackLookup(lookup) {
    var tracked = lookup.then(function() {}, function() {});
    pendingLookups.add(tracked);
    tracked.then(function() {
        pendingLookups.delete(tracked);
    });
    return lookup;
}

// Hook Manager
class HookManager extends Manager {
    constructor(sm, opts) {
        var model = sm.getSisModel(SIS.SCHEMA_HOOKS);
        opts = opts || {};
        opts[SIS.OPT_USE_AUTH] = sm.authEnabled;
        super(model, opts);
        var hookRequestDefaults = nconf.get('hooks:request_defaults');
        if (hookRequestDefaults) {
            requestDefaults = hookRequestDefaults;
        }
        this.sm = sm;
    }

    validate(modelObj, toUpdate, options) {
        if (!modelObj) {
            return "No model defined.";
        }
        if(!modelObj.name) {
            return "Hook has no name.";
        }
        if(!modelObj.entity_type) {
            return "Hook has no entity_type.";
        }
        if(!modelObj.target) {
            return "Hook has no target.";
        }
        if(!modelObj.target.url) {
            return "Hook target has no url.";
        }
        if(!modelObj.target.action) {
            return "Hook target has no action.";
        }
        if(!modelObj.events) {
            return "Hook has no on parameter.";
        }
        if(!modelObj.events.length) {
            return "Hook on parameter has no values.";
        }
        return this.validateOwner(modelObj, options);
    }

    // Send the event to the hooks of entity_type that want it.  Resolves with
    // the hooks' response bodies - or null if a hook failed, which is logged.
    // Callers do not wait for this, so it never rejects.
    async dispatchHooks(entity, entity_type, event, isBulk) {
        var query = { "entity_type" : entity_type, "events" : event };
        try {
            var hooks = await trackLookup(Promise.resolve(this.model.find(query, null, { lean : true }).exec()));
            return await Promise.all(hooks.map(function(hook) {
                return dispatchHook(hook, entity, event, isBulk);
            }));
        } catch (err) {
            LOGGER.error({ err: err }, "Error running hooks");
            return null;
        }
    }

    // force trigger
    async triggerHooks(entityType, entityId, opts) {
        opts = opts || { };
        var mgr = await this.sm.getEntityManager(entityType);
        opts.lean = mgr.model.schema._sis_defaultpaths.length === 0;
        var entity = await mgr.getById(entityId);
        // trigger an update from the entity to itself
        this.dispatchHooks({ old : entity, updated : entity }, entityType, SIS.EVENT_UPDATE, false);
        return {
            message: "Hooks triggered successfully",
            type: entityType,
            entity: entity
        };
    }
}

export default function(schemaManager, opts) {
    return new HookManager(schemaManager);
}

// resolves once the hook lookups running now are done
export function lookupsDone() {
    return Promise.all(Array.from(pendingLookups));
}
