
// Manager for entities

'use strict';

var Manager = require("./manager");
var SIS = require("./constants");

// Entity manager
class EntityManager extends Manager {
    constructor(model, schema, opts) {
        super(model, opts);
        this.schema = schema;
        this.sm = opts[SIS.OPT_SCHEMA_MGR];
        this.mixedTypes = [];
        model.schema.eachPath((pathName, type) => {
            if (type.options && type.options.type == "Mixed") {
                this.mixedTypes.push(pathName);
            }
        });
    }

    // validate the entity
    validate(entity, toUpdate, options) {
        var keys = Object.keys(entity);
        var i = 0;
        var rf;
        if (toUpdate) {
            // remove reserved fields..
            for (i = 0; i < keys.length; ++i) {
                rf = keys[i];
                if (rf[0] == "_") {
                    // v1 does not allow any _
                    // v1.1+ allows SIS.FIELD_SIS_META
                    if (rf != SIS.FIELD_SIS_META) {
                        delete entity[rf];
                    }
                }
            }
            keys = Object.keys(entity);
        }
        try {
            if (!keys.length) {
                return "entity cannot be empty";
            } else if (keys.length == 1 && keys[0] == SIS.FIELD_SIS_META) {
                if (!toUpdate) {
                    return "entity cannot be empty";
                }
                if (typeof entity[SIS.FIELD_SIS_META] !== 'object' ||
                    !Object.keys(entity[SIS.FIELD_SIS_META]).length) {
                    return "entity cannot be empty";
                }
            }
            for (i = 0; i < keys.length; ++i) {
                rf = keys[i];
                if (rf[0] == "_") {
                    // v1 does not allow any _
                    // v1.1+ allows SIS.FIELD_SIS_META
                    if (rf != SIS.FIELD_SIS_META) {
                        return rf + " is a reserved field";
                    }
                }
            }
            if (!toUpdate) {
                // match the any owner can modify of the schema
                if (this.schema[SIS.FIELD_ANY_ADMIN_MOD]) {
                    entity[SIS.FIELD_SIS_META] = entity[SIS.FIELD_SIS_META] || { };
                    if (typeof entity[SIS.FIELD_SIS_META][SIS.FIELD_ANY_ADMIN_MOD] === "undefined") {
                        entity[SIS.FIELD_SIS_META][SIS.FIELD_ANY_ADMIN_MOD] = true;
                    }
                }
            }
            if (this.schema[SIS.FIELD_IS_OPEN] ||
                this.schema[SIS.FIELD_IS_PUBLIC]) {
                return null;
            }
            if (this._hasOwners(entity, options)) {
                var owners = this.getOwners(entity);
                if (owners instanceof Array && !owners.length) {
                    // let the authorize call take care of setting
                    // sub owners
                    return null;
                }
                var err = this.validateOwner(entity, options);
                if (err) {
                    return err;
                }
                // ensure the document is a subset of owners of the schema
                var schemaOwners = this.getOwners(this.schema);
                for (i = 0; i < owners.length; ++i) {
                    if (schemaOwners.indexOf(owners[i]) == -1) {
                        // must be a subset
                        return "entity owners must be a subset of the schema owners.";
                    }
                }
            }
        } catch (ex) {
            return "cannot be empty or is not an object " + ex;
        }
        return null;
    }

    _hasOwners(obj, options) {
        return SIS.FIELD_SIS_META in obj &&
            SIS.FIELD_OWNER in obj[SIS.FIELD_SIS_META];
    }

    _getOwnerSubset(user, schema) {
        if (!user[SIS.FIELD_ROLES]) {
            return [];
        }
        var schemaOwners = this.getOwners(schema);
        var userRoles = Object.keys(user[SIS.FIELD_ROLES]);
        return userRoles.filter(function(owner) {
            return schemaOwners.indexOf(owner) != -1;
        });
    }

    getOwners(obj) {
        var owners = super.getOwners(obj);
        if (!owners) {
            // defer to schema owners
            owners = super.getOwners(this.schema);
        }
        return owners;
    }

    // authorize always gets meta in v1.1 support
    async authorize(evt, doc, user, mergedDoc) {
        if (!this.authEnabled) {
            return super.authorize(evt, doc, user, mergedDoc);
        }
        var meta = null;
        if (user[SIS.FIELD_SUPERUSER]) {
            return super.authorize(evt, doc, user, mergedDoc);
        }
        if (this.schema[SIS.FIELD_IS_OPEN] || this.schema[SIS.FIELD_IS_PUBLIC]) {
            // the schema allows anybody to add entities
            var userGroups = user[SIS.FIELD_ROLES] ? Object.keys(user[SIS.FIELD_ROLES]) : [];
            if (!userGroups.length) {
                throw SIS.ERR_BAD_REQ("User must have roles assigned.");
            }
            // ensure the owners are set
            meta = mergedDoc ? mergedDoc[SIS.FIELD_SIS_META] : doc[SIS.FIELD_SIS_META];
            if (!meta[SIS.FIELD_OWNER]) {
                meta[SIS.FIELD_OWNER] = userGroups;
            }
            return super.authorize(evt, doc, user, mergedDoc);
        }

        // authorize against entity subset or schema
        var ownerSubset = this._getOwnerSubset(user, this.schema);
        if (!ownerSubset.length) {
            throw SIS.ERR_BAD_CREDS("Insufficient privileges to operate on entities in this schema.");
        }
        var docMeta = doc[SIS.FIELD_SIS_META];
        if (!docMeta[SIS.FIELD_OWNER] || !docMeta[SIS.FIELD_OWNER].length) {
            docMeta[SIS.FIELD_OWNER] = ownerSubset;
        }
        if (mergedDoc) {
            docMeta = mergedDoc[SIS.FIELD_SIS_META];
            if (!docMeta[SIS.FIELD_OWNER] || !docMeta[SIS.FIELD_OWNER].length) {
                docMeta[SIS.FIELD_OWNER] = ownerSubset;
            }
        }
        return super.authorize(evt, doc, user, mergedDoc);
    }

    // get a single object by id - the schema's id field, or _id
    async getById(id, options) {
        var idField = this.schema[SIS.FIELD_ID_FIELD];
        if (idField && idField != '_id') {
            var q = {}; q[idField] = id;
            try {
                return await this.getSingleByCondition(q, id, options);
            } catch (err) {
                // fall back to _id
            }
        }
        return this.getSingleByCondition({ _id : id }, id, options);
    }

    canInsertWithId(id, obj) {
        var idField = this.schema[SIS.FIELD_ID_FIELD];
        return idField && idField != '_id' && obj[idField] == id;
    }

    applyUpdate(result, entity, options) {
        // save old mixed paths
        var oldMixed = this.mixedTypes.reduce(function(ret, p) {
            ret[p] = result.get(p);
            return ret;
        }, { });
        // merge:true keeps nested defined objects deep-merged (mongoose 4 behavior);
        // Mixed paths are then restored explicitly below.
        result.set(entity, undefined, { merge: true });

        var getValueForPath = function(path, obj) {
            if (!obj) {
                return undefined;
            }
            var paths = path.split(".");
            for (var i = 0; i < paths.length; ++i) {
                var p = paths[i];
                obj = obj[p];
                if (obj === undefined) {
                    return undefined;
                } else if (!obj) {
                    return null;
                }
            }
            return obj;
        };

        var forceMixed = options && options.forceMixed;

        // restore mixed objects w/ merge
        this.mixedTypes.forEach(function(p) {
            var old = oldMixed[p];
            var entityVal = getValueForPath(p, entity);
            if (entityVal === undefined) {
                return;
            }
            if (!forceMixed) {
                old = this.applyPartial(old, entityVal);
            } else {
                old = entityVal;
            }
            result.set(p, old);
            result.markModified(p);
        }.bind(this));
        return result;
    }

    _getDocArrayReferencedObjectIds(ref, obj, idx, errors) {
        var containerPaths = ref.containerSplits;
        var currObj = obj;
        var path = null;
        for (var i = 0; i < containerPaths.length; ++i) {
            path = containerPaths[i];
            if (!(path in currObj)) {
                // not there - fine.
                return null;
            }
            currObj = currObj[path];
        }
        if (currObj && !(currObj instanceof Array)) {
            // invalid
            errors[idx] = {
                err : SIS.ERR_BAD_REQ("Array expected at " + ref.path),
                value : obj
            };
            return null;
        }
        if (!currObj || !currObj.length) {
            // empty - ok..
            return null;
        }
        // map to subref gets
        var subRefErrs = { };
        var subRefsObjIds = currObj.map(function(doc) {
            return this._getReferenceObjectIds(ref.subRef, doc, -1, subRefErrs);
        }.bind(this));
        if (Object.keys(subRefErrs).length) {
            errors[idx] = {
                err : SIS.ERR_BAD_REQ("One ore more references could not be verified at " + ref.path),
                value : obj
            };
            return null;
        }
        // subRefsObjIds is an array of array of objectIds
        // it could also be null
        var allObjIds = subRefsObjIds.reduce(function(ret, objIdArray) {
            if (!objIdArray) { return ret; }
            objIdArray.forEach(function(oid) {
                ret[oid + ""] = true;
            });
            return ret;
        }, { });
        var distinctObjIds = Object.keys(allObjIds);
        if (!distinctObjIds.length) {
            return null;
        }
        return distinctObjIds;
    }

    _getReferenceObjectIds(ref, obj, idx, errors) {
        var currObj = obj;
        var path = null;
        if (ref.container == 'docarr') {
            // in a doc array
            return this._getDocArrayReferencedObjectIds(ref, obj, idx, errors);
        }
        var refPaths = ref.splits;
        for (var i = 0; i < refPaths.length; ++i) {
            path = refPaths[i];
            if (!(path in currObj)) {
                // no id @ path - it's ok
                return null;
            }
            currObj = currObj[path];
        }
        if (!currObj) {
            // no value @ path - it's ok
            return null;
        }
        path = ref.path;
        var schema = this.model.schema;
        var refModelName = ref.ref;
        var d = null;
        if (ref.type == 'oid') {
            if (typeof currObj === 'object' &&
                currObj.constructor.name !== "ObjectID" &&
                currObj.constructor.name !== "ObjectId") {
                if (SIS.FIELD_ID in currObj) {
                    currObj = currObj[SIS.FIELD_ID];
                } else {
                    errors[idx] = {
                        err : SIS.ERR_BAD_REQ("Reference Object has no _id"),
                        value : obj
                    };
                    return null;
                }
            }
            return [currObj + ''];
        } else if (ref.type == 'arr') {
            // array of oids
            if (!(currObj instanceof Array)) {
                currObj = [currObj];
            }
            currObj = currObj.filter(function(o) {
                return o !== null;
            });
            var errored = false;
            // populated objects are referenced by their _id
            currObj = currObj.map(function(obj) {
                if (typeof obj === 'object' &&
                    obj.constructor.name !== "ObjectID" &&
                    obj.constructor.name !== "ObjectId") {
                    if (SIS.FIELD_ID in obj) {
                        return obj[SIS.FIELD_ID];
                    } else {
                        errored = true;
                    }
                }
                return obj;
            });
            if (errored) {
                errors[idx] = {
                    err : SIS.ERR_BAD_REQ("Reference Object has no _id"),
                    value : obj
                };
                return null;
            }
            // reduce to a set
            var distinctItems = currObj.reduce(function(ret, id) {
                // just to string it..
                ret['' + id] = true;
                return ret;
            }, { });
            distinctItems = Object.keys(distinctItems);
            return distinctItems;
        }
    }

    // returns an array of object ids
    _addReferencesToState(ref, obj, idx, refToIdx, errors) {
        var objIds = this._getReferenceObjectIds(ref, obj, idx, errors);
        if (!objIds || !objIds.length) {
            return;
        }
        objIds.forEach(function(oid) {
            if (!refToIdx[oid]) {
                refToIdx[oid] = { };
            }
            refToIdx[oid][idx] = true;
        });
    }

    // Check the references of the objects.  Resolves with { success, errors }:
    // the objects whose references exist, and errors as { err, value }
    async _preSaveBulk(objs) {
        var references = this.getReferences();
        if (!references.length || !objs || !objs.length) {
            return { success : objs, errors : [] };
        }
        // errors by index of the object
        var allErrors = { };
        // by referenced schema, the objects (by index) referencing each object id
        var objIdStatesByName = references.reduce(function(ret, ref) {
            var refToIdx = { };
            var errors = { };
            // these are not model objects
            // so can just map straight up
            objs.forEach(function(obj, idx) {
                this._addReferencesToState(ref, obj, idx, refToIdx, errors);
            }.bind(this));
            for (var errIdx in errors) {
                if (!allErrors[errIdx]) {
                    allErrors[errIdx] = errors[errIdx];
                }
            }
            var refModelName = ref.ref;
            if (!ret[refModelName]) {
                ret[refModelName] = {
                    ref : refModelName,
                    refToIdx : refToIdx
                };
            } else {
                // need to extend
                var ext = ret[refModelName];
                for (var oid in refToIdx) {
                    ext.refToIdx[oid] = ext.refToIdx[oid] || { };
                    for (var oidIdx in refToIdx[oid]) {
                        ext.refToIdx[oid][oidIdx] = true;
                    }
                }
            }
            return ret;
        }.bind(this), { });

        var markErrored = function(refToIdx, err) {
            Object.keys(refToIdx).forEach(function(oid) {
                Object.keys(refToIdx[oid]).forEach(function(idx) {
                    if (!allErrors[idx]) {
                        allErrors[idx] = {
                            err : err,
                            value : objs[idx]
                        };
                    }
                });
            });
        };

        await Promise.all(Object.keys(objIdStatesByName).map(async (name) => {
            var state = objIdStatesByName[name];
            var objIds = Object.keys(state.refToIdx);
            if (!objIds.length) {
                // nothing to do.
                return;
            }
            // rejects if the referenced schema does not exist
            var model = await this.sm.getEntityModelAsync(state.ref);
            var found;
            try {
                found = await model.find({ '_id' : { "$in" : objIds }}, '_id', { lean : true }).exec();
            } catch (err) {
                throw SIS.ERR_INTERNAL("Error verifying references");
            }
            if (found && found.length == objIds.length) {
                return;
            }
            // figure out the ones that are missing
            (found || []).forEach(function(obj) {
                delete state.refToIdx[obj._id + ""];
            });
            markErrored(state.refToIdx, SIS.ERR_BAD_REQ("Reference does not exist."));
        }));

        var erroredIndeces = Object.keys(allErrors);
        if (!erroredIndeces.length) {
            return { success : objs, errors : [] };
        }
        var errorValues = erroredIndeces.map(function(eIdx) {
            return allErrors[eIdx];
        });
        var success = objs.filter(function(o, idx) {
            return !(idx in allErrors);
        });
        return { success : success, errors : errorValues };
    }

    async _preSave(obj) {
        var errors = (await this._preSaveBulk([obj])).errors;
        if (errors.length) {
            throw errors[0].err;
        }
        return obj;
    }
}

module.exports = function(model, schema, opts) {
    return new EntityManager(model, schema, opts);
};
