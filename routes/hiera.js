import ApiController from "./apicontroller.js";
import SIS from "../util/constants.js";
import createHieraManager from "../util/hiera-manager.js";

// Hiera controller
class HieraController extends ApiController {
    constructor(config) {
        var opts = { };
        opts[SIS.OPT_LOG_COMMTS] = true;
        opts[SIS.OPT_FIRE_HOOKS] = true;
        opts[SIS.OPT_TYPE] = SIS.SCHEMA_HIERA;
        opts[SIS.OPT_USE_AUTH] = config[SIS.OPT_USE_AUTH];
        SIS.UTIL_MERGE_SHALLOW(opts, config);
        super(opts);
        this.manager = createHieraManager(this.sm, opts);
    }

    // The GET/:id request needs to send only the hiera object back
    convertToResponseObject(req, obj) {
        if (typeof obj.hieradata === 'undefined') {
            obj.hieradata = { };
        }
        if (req.method == "GET" && req.params.id &&
            !req.params.isCommitApi) {
            // dirty hack to inform the caller that no more
            // conversions are necessary.
            req.params.doneConverting = true;
            var result = { };
            result[req.params.id] = obj.hieradata;
            return result;
        }
        if (typeof obj.toObject === "function") {
            obj = obj.toObject({ minimize : false });
        }
        return obj;
    }
}

// all route controllers expose a setup method
export function setup(app, config) {
    var controller = new HieraController(config);
    controller.attach(app, "/hiera");
}
