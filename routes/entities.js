// API for entities that adhere to schemas created via
// the schemas API

import ApiController from "./apicontroller.js";
import SIS from "../util/constants.js";

// Entity controller
class EntityController extends ApiController {
    constructor(config) {
        var opts = { };
        opts[SIS.OPT_LOG_COMMTS] = true;
        opts[SIS.OPT_FIRE_HOOKS] = true;
        opts[SIS.OPT_ID_FIELD] = SIS.FIELD_ID;
        opts[SIS.OPT_USE_AUTH] = config[SIS.OPT_USE_AUTH];
        SIS.UTIL_MERGE_SHALLOW(opts, config);
        super(opts);
        this.opts = opts;
    }

    // overrides
    // Get the manager to handle this query
    async getManager(req) {
        // Get the latest
        var manager = await this.sm.getEntityManager(this.getType(req), this.opts);
        req.sisManager = manager;
        req.useLean = manager.model.schema._sis_defaultpaths.length === 0;
        return manager;
    }

    convertToResponseObject(req, obj) {
        if (!req.sisManager) {
            return obj;
        }
        var arrayPaths = req.sisManager.model.schema._sis_arraypaths;
        if (req.query.removeEmpty && arrayPaths.length) {
            if (!obj.toObject) {
                obj = new req.sisManager.model(obj);
            }
            arrayPaths.forEach(function(p) {
                var arr = obj.get(p);
                if (arr && arr.length === 0) {
                    obj.set(p, undefined);
                }
            });
            obj = obj.toObject();
        } else if (req.useLean && arrayPaths.length) {
            // need to ensure the array is set to [] if it's null
            req.sisManager.model.schema._sis_arraypaths.forEach(function(path) {
                SIS.UTIL_SET_DEFAULT_ARRAY(obj, path);
            });
        }
        return obj;
    }

    shouldSaveCommit(req) {
        return req.sisManager &&
               req.sisManager.schema[SIS.FIELD_TRACK_HISTORY] &&
               super.shouldSaveCommit(req);
    }

    // The type is the schema being requested
    getType(req) {
        return req.params.schema;
    }

    // Apply the default to populate the objects returned from GET
    applyDefaults(req) {
        if (req.method == "GET") {
            // need to populate..
            if (!('populate' in req.query)) {
                req.query.populate = true;
            }
        }
    }
}

// all route controllers expose a setup method
export function setup(app, config) {
    var controller = new EntityController(config);
    controller.attach(app, "/entities/:schema");
}
