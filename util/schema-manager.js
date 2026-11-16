
// A class used to manage the SIS Schemas defined by the /schemas api
// and also help out the /entities apis

// Not all controllers need this and can use mongoose directly
// but we have it here since the schemas and entities controller can benefit

import jsondiffpatch from "jsondiffpatch";
import SIS from "./constants.js";
import Manager from "./manager.js";
import * as logger from "./logger.js";
import createEntityManager from "./entity-manager.js";
import createUserManager from "./user-manager.js";
import createTokenManager from "./token-manager.js";
import * as sisSchemas from "./sis-schemas.js";
import registerTypes from "./types/index.js";

var LOGGER = logger.createLogger({
    name : "SchemaManager"
});

var toRegex = function(str) {
    try {
        if (str instanceof RegExp) {
            return str;
        }
        if (!str || str[0] != '/') {
            return null;
        }
        var splits = str.split('/');
        if (splits.length < 3 || splits[0]) {
            return null;
        }
        var flags = splits.pop();
        splits.shift();
        var regex = splits.join("/");
        if (!regex) {
            return null;
        }
        return new RegExp(regex, flags);
    } catch(ex) {
    }
    return null;
};

// patched to prevent schema changes from causing
// mongoose to barf.  I.e. string field changed to
// document
var patchMongoose = function(mongoose) {
    // mongoose 4 allowed querying arbitrary (non-schema) paths such as the
    // sub-paths of custom types (e.g. ip.ip_address).  Preserve that behavior.
    mongoose.set('strictQuery', false);
    var Document = mongoose.Document;
    var oldInit = Document.prototype.init;
    Document.prototype.init = function(doc, opts, fn) {
        if (!doc) {
            return oldInit.call(this, doc, opts, fn);
        }
        if (typeof doc !== 'object' || doc instanceof Array) {
            doc = { };
        }
        return oldInit.call(this, doc, opts, fn);
    };
    var oldToObj = Document.prototype.toObject;
    Document.prototype.toObject = function(options) {
        if (!this._doc) {
            return oldToObj.call(this, options);
        }
        if (typeof this._doc !== 'object' ||
            !Object.keys(this._doc).length) {
            return { };
        }
        return oldToObj.call(this, options);
    };
    var SchemaString = mongoose.SchemaTypes.String;
    var oldMatch = SchemaString.prototype.match;
    SchemaString.prototype.match = function(regExp, message) {
        if (typeof regExp === 'string') {
            var regex = toRegex(regExp);
            if (!regex) {
                return this;
            }
            regExp = regex;
        }
        return oldMatch.call(this, regExp, message);
    };
};

function withCounts(options) {
    return options && options.query &&
           options.query.with_counts === 'true';
}

// the models whose index build failure was logged
var indexFailuresLogged = new WeakSet();

class SchemaManager extends Manager {
    constructor(mongoose, opts) {
        // the model of the schemas is one of the internal models, which are
        // built with this manager's methods - so it is set once they are built
        var managerOpts = { };
        managerOpts[SIS.OPT_TYPE] = SIS.SCHEMA_SCHEMAS;
        super(null, Object.assign(managerOpts, opts));
        this.mongoose = mongoose;
        this.entitySchemaToUpdateTime = { };
        registerTypes(mongoose);
        for (var i = 0; i < sisSchemas.schemas.length; ++i) {
            this.getEntityModel(sisSchemas.schemas[i],true);
        }
        this.model = this.getSisModel(SIS.SCHEMA_SCHEMAS);
        if (this.authEnabled) {
            var auth = {};
            auth[SIS.SCHEMA_USERS] = createUserManager(this);
            this.auth = auth;
            // a token manager that is not associated with a user name
            this.tokenFetcher = createTokenManager(this, null);
        }
        patchMongoose(mongoose);
        this.managerCache = { };
    }

    // overrides
    // only called for entity schemas
    validate(modelObj, toUpdate, options) {
        if (!modelObj || !modelObj.name || typeof modelObj.name != 'string') {
            return "Schema has an invalid name: " + modelObj.name;
        }
        var ownerError = this.validateOwner(modelObj, options);
        if (ownerError) {
            return ownerError;
        }

        if (modelObj.name.indexOf("sis_") === 0) {
            return "Schema name is reserved.";
        }

        var locked_fields = modelObj[SIS.FIELD_LOCKED_FIELDS] || [];
        if (!(locked_fields instanceof Array)) {
            return SIS.FIELD_LOCKED_FIELDS + " must be an array.";
        }
        var definition = modelObj.definition;
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
            return "Schema definition must be an object.";
        }
        try {
            var fields = Object.keys(definition);
            if (!fields.length) {
                return "Cannot add an empty schema.";
            }
            for (var i = 0; i < fields.length; ++i) {
                if (fields[i][0] == '_' && fields[i] !== SIS.FIELD_SIS_META) {
                    return fields[i] + " is a reserved field";
                } else if (typeof modelObj.definition[fields[i]] === 'object') {
                    // if it is empty, convert to mixed
                    if (!Object.keys(modelObj.definition[fields[i]]).length) {
                        modelObj.definition[fields[i]] = { type : "Mixed" };
                    }
                }
            }
            if (modelObj[SIS.FIELD_ID_FIELD] && modelObj[SIS.FIELD_ID_FIELD] != '_id') {
                // ensure it's proper in the definition
                var idField = modelObj[SIS.FIELD_ID_FIELD];
                var idDescriptor = modelObj.definition[idField];
                if (!idDescriptor || typeof idDescriptor != 'object' ||
                    !idDescriptor.required || !idDescriptor.unique) {
                    return "ID Field must be required and unique.";
                }
            }
            var mongooseSchema = new this.mongoose.Schema(modelObj.definition, { collection : "__test__", autoIndex: false, versionKey : SIS.FIELD_VERS });
            mongooseSchema.eachPath(function(path, schemaType) {
                if (schemaType.instance == "String" &&
                    schemaType.options && schemaType.options.match) {
                    if (!toRegex(schemaType.options.match)) {
                        throw "match " + schemaType.options.match;
                    }
                } else if (path === "_sis.owner") {
                    if (schemaType.constructor.name !== 'SchemaArray' ||
                        !schemaType.caster ||
                        schemaType.caster.instance != "String") {
                        // owner is invalid
                        throw "owner must be a String array.";
                    }
                }
            });
        } catch (ex) {
            return "Schema is invalid: " + ex;
        }
        return null;
    }

    _invalidateSchema(name) {
        // mongoose 5+ removed direct access to modelSchemas/models for removal;
        // deleteModel cleans up the compiled model and its cached schema.
        if (this.mongoose.models[name]) {
            this.mongoose.deleteModel(name);
        }
        delete this.entitySchemaToUpdateTime[name];
    }

    _diffSchemas(schema1, schema2) {

        function isNotSisPath(str) {
            return str[0] != '_';
        }

        var addedPaths = [];
        var removedPaths = [];
        var updatedPaths = [];
        var s1Paths = Object.keys(schema1.paths).filter(isNotSisPath).sort();
        var s2Paths = Object.keys(schema2.paths).filter(isNotSisPath).sort();
        // linear diff
        while (s1Paths.length && s2Paths.length) {
            var pathName1 = s1Paths[0];
            var pathName2 = s2Paths[0];
            // check if they are the same type
            var path1 = schema1.path(pathName1);
            var path2 = schema2.path(pathName2);
            if (pathName1 === pathName2) {
                s1Paths.shift();
                s2Paths.shift();
                if (path1.constructor.name !== path2.constructor.name) {
                    updatedPaths.push([pathName1, path1, path2]);
                } else if (JSON.stringify(path1.options) !== JSON.stringify(path2.options)) {
                    updatedPaths.push([pathName1, path1, path2]);
                }
            } else if (pathName1 < pathName2) {
                // p1 before p2.  p1 has been removed in s2
                removedPaths.push([pathName1, path1]);
                s1Paths.shift();
            } else {
                // p2 before p1. p2 has been added
                addedPaths.push([pathName2, path2]);
                s2Paths.shift();
            }
        }
        addedPaths = addedPaths.concat(s2Paths.map(function(p) {
            return [p, schema2.path(p)];
        }));
        removedPaths = removedPaths.concat(s1Paths.map(function(p) {
            return [p, schema1.path(p)];
        }));
        return [addedPaths, removedPaths, updatedPaths];
    }

    // only called on entity schemas
    // After a schema update, rebuild its model and drop the indexes and data
    // of the fields that changed or were removed.  Resolves with updatedSchema.
    async finishUpdate(oldSchema, updatedSchema) {
        var oldMongooseSchema = this.getEntityModel(oldSchema).schema;
        var newSchema = this._getMongooseSchema(updatedSchema);

        var diff = this._diffSchemas(oldMongooseSchema, newSchema);
        var defChanged = diff.some(function(paths) {
            return paths.length > 0;
        });
        if (!defChanged) {
            // definition didn't change so we don't need to delete any models
            // or anything
            return updatedSchema;
        }

        // paths whose index options changed, and paths that were removed
        var pathsWithIndecesToRemove = diff[2].filter(function(p) {
            var p1Opt = p[1].options || { };
            var p2Opt = p[2].options || { };
            return JSON.stringify(p1Opt.index) !== JSON.stringify(p2Opt.index) ||
                p1Opt.unique != p2Opt.unique;
        }).map(function(p) {
            // actual path
            return p[0];
        });
        var pathsToDelete = diff[1].map(function(p) { return p[0]; });

        var indeces = oldMongooseSchema.indexes();
        // invalidate the existing schema
        this._invalidateSchema(updatedSchema.name);
        var currentMongooseModel = this.getEntityModel(updatedSchema);
        var collection = currentMongooseModel.collection;

        // drop the old indexes on those paths - failures are ignored
        var dropIndecesOn = async function(paths) {
            var toRemove = [];
            paths.forEach(function(p) {
                indeces.filter(function(index) {
                    return p in index[0];
                }).forEach(function(index) {
                    toRemove.push(index);
                });
            });
            await Promise.all(toRemove.map(async function(r) {
                try {
                    await collection.dropIndex(r[0], r[1]);
                } catch (e) {
                    // already gone
                }
            }));
        };

        await dropIndecesOn(pathsWithIndecesToRemove);
        if (pathsToDelete.length) {
            await dropIndecesOn(pathsToDelete);
            // unset the removed fields
            var pathsObj = pathsToDelete.reduce(function(ret, p) {
                ret[p] = "";
                return ret;
            }, { });
            await currentMongooseModel.updateMany({}, { $unset : pathsObj }, { strict : false }).exec();
        }
        return updatedSchema;
    }

    async applyUpdate(currentSchema, updatedSchema) {
        // now we have the persisted schema document.
        // need to set the schema object fields
        // and also validate that the fields being removed
        // do not
        var currentMongooseModel = this.getEntityModel(currentSchema);
        var currentMongooseSchema = currentMongooseModel.schema;
        var newDef = updatedSchema.definition;
        var newSchema = this._getMongooseSchema(updatedSchema);

        var setIfPresent = function(field) {
            if (field in updatedSchema) {
                currentSchema[field] = updatedSchema[field];
            }
        };

        currentSchema[SIS.FIELD_ID_FIELD] = updatedSchema[SIS.FIELD_ID_FIELD] || '_id';
        currentSchema[SIS.FIELD_DESCRIPTION] = updatedSchema[SIS.FIELD_DESCRIPTION];
        // update optional fields that have default vals
        // meta fields already updated
        setIfPresent(SIS.FIELD_LOCKED_FIELDS);
        setIfPresent(SIS.FIELD_IS_OPEN);
        setIfPresent(SIS.FIELD_IS_PUBLIC);
        setIfPresent(SIS.FIELD_ANY_ADMIN_MOD);
        setIfPresent(SIS.FIELD_TRACK_HISTORY);

        currentSchema.definition = newDef;

        // validate the diff against locked fields
        var diff = this._diffSchemas(currentMongooseSchema, newSchema);

        var defChanged = diff.some(function(paths) {
            return paths.length > 0;
        });

        if (!defChanged) {
            // definition didn't change so we don't need to delete any models
            // or anything
            return currentSchema;
        }

        // find all paths that need to be unset/deleted
        var pathsToDelete = diff[1].map(function(p) { return p[0]; });
        if (!pathsToDelete.length) {
            return currentSchema;
        }

        var lockedFields = currentSchema[SIS.FIELD_LOCKED_FIELDS] || [];
        for (var i = 0; i < pathsToDelete.length; ++i) {
            var path = pathsToDelete[i];
            if (lockedFields.indexOf(path) != -1) {
                throw SIS.ERR_BAD_REQ("Cannot remove field " + path);
            }
        }

        return currentSchema;
    }

    async objectRemoved(schema) {
        // schema document is removed.. now delete the
        // mongoose caches
        // and documents for that schema
        var collection = this.getEntityModel(schema).collection;
        this._invalidateSchema(schema[SIS.FIELD_NAME]);
        // TODO: handle the error when the collection is busy
        // i.e. index being created
        try {
            await collection.drop();
        } catch (err) {
            // the driver errors if the collection isn't found (ns not found / code 26)
            if (err && err.message != 'ns not found' && err.code !== 26) {
                // at this point we're in a bad state.. we deleted the instance
                // but still have documents
                // TODO: handle this
                throw SIS.ERR_INTERNAL(err);
            }
        }
        return schema;
    }

    // additional methods
    getSisModel(name) {
        return this.mongoose.models[name];
    }

    // Resolves with the model of the schema named name.  Rejects if there is
    // no such schema or its model cannot be built.
    async getEntityModelAsync(name) {
        var schema;
        try {
            schema = await this.model.findOne({ name : name }, null, { lean : true }).exec();
        } catch (err) {
            throw SIS.ERR_BAD_REQ("Schema not found with name " + name);
        }
        var model = this.getEntityModel(schema);
        if (!model) {
            throw SIS.ERR_BAD_REQ("Invalid schema found with name " + name);
        }
        return model;
    }

    // Bootstrap mongoose by setting up the models of the stored schemas
    async bootstrapEntitySchemas() {
        var schemas = await this.model.find({}, null, { lean : true }).exec();
        for (var i = 0; i < schemas.length; ++i) {
            if (!this.getEntityModel(schemas[i])) {
                throw SIS.ERR_INTERNAL("Error building schema " + JSON.stringify(schemas[i]));
            }
        }
    }

    // may throw an exception.
    _getMongooseSchema(sisSchema, isInternal) {
        // add our special fields..
        var definition = {};
        // only need shallow copy..
        for (var k in sisSchema.definition) {
            definition[k] = sisSchema.definition[k];
        }
        // v1.1. - move these into _sis
        var META_FIELDS = sisSchemas.metaDef;
        var thisMetaDef = definition[SIS.FIELD_SIS_META] || { };
        var ignoredMeta = (isInternal ? sisSchema.ignored_meta : null) || [];

        for (k in META_FIELDS) {
            if (ignoredMeta.indexOf(k) == -1) {
                thisMetaDef[k] = META_FIELDS[k];
            }
        }

        if (!isInternal) {
            // add the default meta def for entities
            thisMetaDef[SIS.FIELD_OWNER] = ["String"];
            thisMetaDef[SIS.FIELD_ANY_ADMIN_MOD] = { type : "Boolean", default : false };
        }

        definition[SIS.FIELD_SIS_META] = thisMetaDef;

        return new this.mongoose.Schema(definition, { collection : sisSchema.name, versionKey : SIS.FIELD_VERS });
    }

    // set the entity count of the schema
    async _addEntityCount(schema) {
        schema[SIS.FIELD_ENTITY_COUNT] = await this.getEntityModel(schema).countDocuments({}).exec();
        return schema;
    }

    // wrap this so we can handle the error case
    async getById(id, options) {
        try {
            var schema = await super.getById(id, options);
            return withCounts(options) ? await this._addEntityCount(schema) : schema;
        } catch (err) {
            this._invalidateSchema(id);
            throw err;
        }
    }

    // handle the with_counts in get all also
    async getAll(condition, options, fields) {
        var schemas = await super.getAll(condition, options, fields);
        if (!withCounts(options)) {
            return schemas;
        }
        return Promise.all(schemas.map(this._addEntityCount.bind(this)));
    }

    // get a mongoose model back based on the sis schema
    // passed in.  sisSchema would be an object returned by
    // calls like getById
    // the mongoose cached version is returned if available
    // Do not hang on to any of these objects
    getEntityModel(sisSchema, isInternal) {
        if (!sisSchema || !sisSchema.name || !sisSchema.definition) {
            return null;
        }

        var name = sisSchema.name;
        var sisMeta = sisSchema[SIS.FIELD_SIS_META] || {};
        var schemaTime = sisMeta[SIS.FIELD_UPDATED_AT] || Date.now();
        if (name in this.mongoose.models) {
            if (this.entitySchemaToUpdateTime[name] === schemaTime) {
                return this.mongoose.models[name];
            } else {
                // invalidate
                this._invalidateSchema(name);
            }
        }
        // convert to mongoose
        try {
            var schema = this._getMongooseSchema(sisSchema, isInternal);
            var result = this.mongoose.model(name, schema);
            var pathsWithDefaultVal = [];
            var pathsWithArray = [];
            schema.eachPath(function(pathName, schemaType) {
                if (pathName.indexOf(SIS.FIELD_SIS_META) === 0 ||
                    pathName === '_id') {
                    return;
                }
                if (schemaType.constructor.name.indexOf('Array') != -1) {
                    pathsWithArray.push(pathName);
                } else if (schemaType.default()) {
                    pathsWithDefaultVal.push(pathName);
                }
            });

            // precalculate sis data and store on the schema
            schema._sis_arraypaths = pathsWithArray;
            schema._sis_references = SIS.UTIL_GET_OID_PATHS(schema);
            schema._sis_defaultpaths = pathsWithDefaultVal;

            if ('indexes' in sisSchema && isInternal) {
                for (var i = 0; i < sisSchema.indexes.length; ++i) {
                    schema.index(sisSchema.indexes[i]);
                }
                if (sisSchema.indexes.length) {
                    result.createIndexes();
                }
            }

            this.entitySchemaToUpdateTime[name] = schemaTime;
            return result;
        } catch (ex) {
            LOGGER.error({ err : ex }, "Error getting entity model");
            return null;
        }
    }

    hasEntityModel(name) {
        return name in this.mongoose.models;
    }

    getEntityModelByName(name) {
        return this.mongoose.models[name];
    }

    getPermissionsForObject(schema, user) {
        if (schema && schema[SIS.FIELD_IS_OPEN]) {
            return SIS.PERMISSION_ADMIN;
        }
        return super.getPermissionsForObject(schema, user);
    }

    _isPartialAdmin(obj, user) {
        var owners = this.getOwners(obj);
        var roles = user[SIS.FIELD_ROLES] || { };
        return owners.some(function(o) {
            return roles[o] == SIS.ROLE_ADMIN;
        });
    }

    async _preSave(obj) {
        var mongooseSchema = new this.mongoose.Schema(obj.definition, { collection : "__test__", autoIndex: false, versionKey : SIS.FIELD_VERS });
        var refs = SIS.UTIL_GET_OID_PATHS(mongooseSchema).map(function(ref) {
            return ref.ref;
        });
        obj[SIS.FIELD_SIS_META][SIS.FIELD_REFERENCES] = refs;
        return obj;
    }

    async preAdd(obj) {
        var definition = obj.definition || { };
        function isCandidate(fieldName) {
            return typeof definition[fieldName] === 'object' &&
                definition[fieldName].required &&
                definition[fieldName].unique;
        }
        // figure out the ID field and set it
        if (!obj.id_field || obj.id_field === SIS.FIELD_ID) {
            // find one that might be better from the top level
            if (isCandidate('name')) {
                obj.id_field = 'name';
            } else if (isCandidate('id')) {
                obj.id_field = 'id';
            } else {
                // find first..
                var topFields = Object.keys(definition);
                for (var i = 0; i < topFields.length; ++i) {
                    if (isCandidate(topFields[i])) {
                        obj.id_field = topFields[i];
                        break;
                    }
                }
            }
        }
        return obj;
    }

    async authorize(evt, doc, user, mergedDoc) {
        var commonErr = this._commonAuth(evt, doc, user, mergedDoc);
        if (commonErr) {
            throw commonErr;
        }
        // get the permissions on the doc being added/updated/deleted
        var permission = this.getPermissionsForObject(doc, user);
        var canOperateOnDoc = permission == SIS.PERMISSION_ADMIN ||
            (doc[SIS.FIELD_ANY_ADMIN_MOD] && this._isPartialAdmin(doc, user));
        if (!canOperateOnDoc) {
            throw SIS.ERR_BAD_CREDS("Insufficient permissions.");
        } else if (evt != SIS.EVENT_UPDATE) {
            // insert / delete and user is an admin
            return doc;
        }

        permission = this.getPermissionsForObject(mergedDoc, user);
        canOperateOnDoc = permission == SIS.PERMISSION_ADMIN ||
            (mergedDoc[SIS.FIELD_ANY_ADMIN_MOD] && this._isPartialAdmin(mergedDoc, user));
        if (!canOperateOnDoc) {
            throw SIS.ERR_BAD_CREDS("Insufficient permissions.");
        }
        return mergedDoc;
    }

    // get a token manager for the particular user
    getTokenManagerForUser(username) {
        if (!this.authEnabled) {
            return null;
        }
        return createTokenManager(this, username);
    }

    _createEntityManager(schema, opts) {
        var name = schema.name;
        var schemaTs = schema[SIS.FIELD_SIS_META] ? schema[SIS.FIELD_SIS_META][SIS.FIELD_UPDATED_AT]
                                                  : schema[SIS.FIELD_UPDATED_AT];
        var cached = this.managerCache[name];
        if (cached && cached.ts === schemaTs) {
            return cached.manager;
        }
        var model = this.getEntityModel(schema);
        cached = {
            ts : schemaTs,
            manager : createEntityManager(model, schema, opts)
        };
        this.managerCache[name] = cached;
        return cached.manager;
    }

    // Resolves once the model's indexes are built. Mongoose builds them in the
    // background when the model is created (for a new or changed schema), and a
    // write that comes first is not checked against a unique index; a duplicate
    // written then even keeps the index from being built. If building fails (the
    // collection already holds duplicates), the error is logged once and writes go
    // ahead without the index.
    async indexesReady(model) {
        try {
            await model.init();
        } catch (err) {
            if (!indexFailuresLogged.has(model)) {
                indexFailuresLogged.add(model);
                LOGGER.error({ err : err, collection : model.collection.name },
                             "Could not build the indexes of " + model.collection.name);
            }
        }
    }

    // Resolves with the entity manager of the schema once its indexes are built
    async getEntityManager(schemaName, opts) {
        var schema = await this.getById(schemaName, { lean : true });
        var manager = this._createEntityManager(schema, opts);
        await this.indexesReady(manager.model);
        return manager;
    }
}

// export
export default function(mongoose, opts) {
    return new SchemaManager(mongoose, opts);
}
