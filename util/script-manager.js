
// A class used to manage the SIS Scripts defined by the /scripts api

'use strict';
var nconf = require('nconf');
var vm = require("vm");

var SIS = require('./constants');
var Manager = require("./manager");

// Script Manager
class ScriptManager extends Manager {
    constructor(sm, opts) {
        var model = sm.getSisModel(SIS.SCHEMA_SCRIPTS);
        opts = opts || {};
        opts[SIS.OPT_USE_AUTH] = sm.authEnabled;
        super(model, opts);
    }

    validate(modelObj, toUpdate, options) {
        if (!modelObj) {
            return "No model defined.";
        }
        if(!modelObj.name) {
            return "Script has no name.";
        }
        if(!modelObj.script_type) {
            return "Script has no script_type";
        }
        if(!modelObj.script) {
            return "Script has no content.";
        }
        // try to compile it
        try {
            new vm.Script(modelObj.script, { filename: "__test__.js" });
        } catch(ex) {
            return "Script does not compile " + ex;
        }
        return this.validateOwner(modelObj, options);
    }
}

module.exports = function(schemaManager, opts) {
    return new ScriptManager(schemaManager);
};
