
// Manager for hiera

import Manager from "./manager.js";
import SIS from "./constants.js";

// Hiera Manager
// hiera overrides
class HieraManager extends Manager {
    constructor(sm, opts) {
        opts = opts || {};
        opts[SIS.OPT_USE_AUTH] = sm.authEnabled;
        var model = sm.getSisModel(SIS.SCHEMA_HIERA);
        super(model, opts);
    }

    validate(entry, toUpdate, options) {
        if (!entry || !entry.name || typeof entry.name != 'string') {
            return "Hiera entry has an invalid or missing name";
        }
        var name = entry.name;
        var hieradata = entry.hieradata;
        if (typeof hieradata === "undefined" ||
            hieradata === null) {
            return "hieradata is missing";
        }
        return this.validateOwner(entry, options);
    }

    applyUpdate(doc, updateObj) {
        /* allow partial update */
        doc.hieradata = this.applyPartial(doc.hieradata, updateObj.hieradata);
        doc.markModified('hieradata');
        return doc;
    }
}

export default function(schemaManager, opts) {
    return new HieraManager(schemaManager, opts);
}
