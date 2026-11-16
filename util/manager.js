import jsondiffpatch from "jsondiffpatch";
import crypto from "crypto";
import _ from "lodash";
import SIS from "./constants.js";
import * as logger from "./logger.js";

var LOGGER = logger.createLogger({
    name : "Manager"
});

// The base of the managers.  A manager is responsible for communicating with
// the DB and running ops on instances of the resource it manages
class Manager {
    // model is a mongoose model object
    // opts is a dictionary w/ the following keys
    // - id_field the id field of the resource
    // - type - the type of resource or defaults to the model name
    // - auth - whether to use auth. Defaults to SIS.DEFAULT_OPT_USE_AUTH (true)
    // - admin_required - whether only admins can modify objects of ours
    constructor(model, opts) {
        this.model = model;
        opts = opts || { };
        this.idField = opts[SIS.OPT_ID_FIELD] || SIS.FIELD_NAME;
        this.type = opts[SIS.OPT_TYPE] || this.model.modelName;
        this.authEnabled = SIS.OPT_USE_AUTH in opts ? opts[SIS.OPT_USE_AUTH] : SIS.DEFAULT_OPT_USE_AUTH;
    }

    getReferences() {
        return this.model.schema._sis_references;
    }

    // return a string if validation fails
    validate(obj, toUpdate, options) {
        return null;
    }

    // can return a document or promise
    // this function receives a doc retrieved from the database
    // and the object sent in the update request - and the options of the
    // update, which subclasses may use (the entity manager's forceMixed)
    // The default just sets the fields sent in the update
    applyUpdate(doc, updateObj, options) {
        // merge:true preserves mongoose 4 semantics where setting a nested object
        // deep-merges rather than replacing the whole subtree.
        doc.set(updateObj, undefined, { merge: true });
        return doc;
    }

    // A call that indicates the specified object has been removed
    // Returns a promise with the object removed.
    async objectRemoved(obj) {
        return obj;
    }

    _getDefaultOptions(options) {
        options = options || { };
        if (!('version' in options)) {
            options.version = "v1.1";
        }
        return options;
    }

    _getFindOptions(options) {
        var result = {};
        if (!options) {
            return result;
        }
        var opts = ['skip','limit','sort','lean','populate', 'read'];
        opts.forEach(function(o) {
            if (o in options) {
                result[o] = options[o];
            }
        });
        return result;
    }

    /** Common methods - rare to override these **/
    // Get a single object that has certain properties.
    async getSingleByCondition(condition, name, options) {
        var result;
        try {
            result = await this.model.findOne(condition, null, this._getFindOptions(options)).exec();
        } catch (err) {
            if (err instanceof Array) {
                throw err;
            }
            if (err.name == "CastError") {
                throw SIS.ERR_NOT_FOUND(this.type, name);
            }
            throw SIS.ERR_INTERNAL(err);
        }
        if (!result) {
            throw SIS.ERR_NOT_FOUND(this.type, name);
        }
        return result;
    }

    // get a single object by id.
    getById(id, options) {
        var q = {}; q[this.idField] = id;
        return this.getSingleByCondition(q, id, options);
    }

    // get all the objects belonging to the model.
    async getAll(condition, options, fields) {
        return this.model.find(condition, fields, this._getFindOptions(options)).exec();
    }

    // Count the number of objects specified by the query
    // Resolves with the count - a failed count is 0.
    async count(condition) {
        var count = 0;
        try {
            count = await this.model.countDocuments(condition || { }).exec();
        } catch (err) {
            count = 0;
        }
        return count;
    }

    // Resolves with the space separated paths to populate, or null if there
    // are none.  subList limits the paths to the ones listed in it.
    async getPopulateFields(schemaManager, subList) {
        var schemaNameToPaths = this._getPopulateFields();
        if (!schemaNameToPaths) {
            return null;
        }
        // referenced schemas that are not loaded yet may still be available
        // due to DB replication - try loading them and drop the ones that aren't
        var schemasToLoad = Object.keys(schemaNameToPaths).filter(function(schemaName) {
            return !schemaManager.hasEntityModel(schemaName);
        });
        await Promise.all(schemasToLoad.map(async function(schemaName) {
            try {
                await schemaManager.getEntityModelAsync(schemaName);
            } catch (err) {
                delete schemaNameToPaths[schemaName];
            }
        }));
        if (!Object.keys(schemaNameToPaths).length) {
            return null;
        }
        return this._getFieldsFromPopulateObject(schemaNameToPaths, subList);
    }

    _commonAuth(evt, doc, user, mergedDoc) {
        var docMeta = doc[SIS.FIELD_SIS_META];
        if (evt == SIS.EVENT_DELETE) {
            if (docMeta[SIS.FIELD_LOCKED]) {
                return SIS.ERR_BAD_CREDS("Cannot delete a locked object.");
            }
        } else if (evt == SIS.EVENT_UPDATE) {
            if (docMeta[SIS.FIELD_IMMUTABLE]) {
                mergedDoc = mergedDoc.toObject();
                var mergeMeta = mergedDoc[SIS.FIELD_SIS_META];
                var diff = jsondiffpatch.diff(doc, mergedDoc) || { };
                var changedKeys = Object.keys(diff).filter(function(k) {
                    return k[0] != '_';
                });
                if (changedKeys.length > 0) {
                    return SIS.ERR_BAD_CREDS("Cannot change an immutable object unless only changing immutable state");
                }
                // ensure only sis meta immutable is being changed
                diff = jsondiffpatch.diff(docMeta, mergeMeta) || { };
                changedKeys = Object.keys(diff);
                if (changedKeys.length != 1 || changedKeys[0] != SIS.FIELD_IMMUTABLE) {
                    return SIS.ERR_BAD_CREDS("Cannot change an immutable object unless only changing immutable state");
                }
            }
        }
        return null;
    }

    _canOperate(doc, user) {
        var docMeta = doc[SIS.FIELD_SIS_META] || {};
        var permission = this.getPermissionsForObject(doc, user);
        return permission === SIS.PERMISSION_ADMIN ||
            permission === SIS.PERMISSION_USER_ALL_GROUPS ||
            (docMeta[SIS.FIELD_ANY_ADMIN_MOD] && permission === SIS.PERMISSION_USER);
    }

    // Authorize a user to operate on a particular document
    // if evt is SIS.EVENT_UPDATE, mergedDoc is the updated object and is
    // what this resolves with; otherwise doc is the object being added/deleted
    async authorize(evt, doc, user, mergedDoc) {
        var commonErr = this._commonAuth(evt, doc, user, mergedDoc);
        if (commonErr) {
            throw commonErr;
        }
        if (!this._canOperate(doc, user)) {
            throw SIS.ERR_BAD_CREDS("Insufficient permissions on source document.");
        }
        if (evt !== SIS.EVENT_UPDATE) {
            return doc;
        }
        if (!this._canOperate(mergedDoc, user)) {
            throw SIS.ERR_BAD_CREDS("Insufficient permissisons on update object.");
        }
        return mergedDoc;
    }

    // Ensures the user can add the object and then add it
    async add(obj, options) {
        options = this._getDefaultOptions(options);
        var user = options.user;
        var err = this.validate(obj, null, options);
        if (err) {
            throw SIS.ERR_BAD_REQ(err);
        }
        obj = SIS.ENSURE_SIS_META(obj);
        var authorized = await this.authorize(SIS.EVENT_INSERT, obj, user);
        var doc = await this._addByFields(user, SIS.EVENT_INSERT)(authorized);
        doc = await this.preAdd(doc);
        doc = await this._preSave(doc);
        return this._save(doc);
    }

    // Add many objects at once.  Resolves with { success, errors } where
    // errors are { err, value }.  With options.allOrNone, nothing is added
    // unless everything can be.  If the insert itself partially fails,
    // internalErr holds the error the database gave.
    async bulkAdd(items, options) {
        options = this._getDefaultOptions(options);
        var user = options.user;
        var allOrNone = options.allOrNone;
        var memo = { success: [], errors: [] };
        // every inserted item is tagged with the transaction so the ones that
        // made it in can be found (and removed for allOrNone) after a failure
        var transactionId = crypto.randomBytes(8).toString('hex') + Date.now();
        var transactionCond = { };
        transactionCond[SIS.FIELD_SIS_META + "." + SIS.FIELD_TRANSACTION_ID + ".id"] = transactionId;

        // validate and authorize each item
        var authorized = [];
        await Promise.all(items.map(async (item) => {
            var err = this.validate(item, null, options);
            if (err) {
                memo.errors.push({ err : SIS.ERR_BAD_REQ(err), value : item });
                return;
            }
            item = SIS.ENSURE_SIS_META(item);
            try {
                var doc = await this.authorize(SIS.EVENT_INSERT, item, user);
                doc = await this._addByFields(user, SIS.EVENT_INSERT)(doc);
                authorized.push(await this.preAdd(doc));
            } catch (e) {
                memo.errors.push({ err : e, value : item });
            }
        }));

        var preSaved = await this._preSaveBulk(authorized);
        memo.errors.push.apply(memo.errors, preSaved.errors);

        // validate against the model and queue the inserts
        var toAdd = [];
        var batch = this.model.collection.initializeUnorderedBulkOp();
        await Promise.all(preSaved.success.map(async (res, idx) => {
            var doc = new this.model(res);
            try {
                await doc.validate();
            } catch (err) {
                memo.errors.push({ err : SIS.ERR_BAD_REQ(err), value : doc.toObject() });
                return;
            }
            res = doc.toObject();
            this.applyPreSaveFields(res);
            res[SIS.FIELD_SIS_META][SIS.FIELD_TRANSACTION_ID] = {
                id : transactionId,
                idx : idx
            };
            toAdd.push(res);
            batch.insert(res);
        }));

        if ((allOrNone && memo.errors.length) || !toAdd.length) {
            // bail - nothing inserted yet or nothing to insert
            return memo;
        }

        // The modern driver resolves execute() with a BulkWriteResult and rejects
        // with a MongoBulkWriteError (whose .result holds the partial
        // BulkWriteResult) when some writes fail.
        var bulkResult;
        try {
            bulkResult = await batch.execute();
        } catch (err) {
            if (!(err && err.result)) {
                throw SIS.ERR_INTERNAL(err);
            }
            memo.internalErr = SIS.ERR_INTERNAL(err);
            return this._bulkAddFailed(memo, toAdd, transactionCond, allOrNone);
        }
        if (!(bulkResult.ok && bulkResult.insertedCount === toAdd.length)) {
            return this._bulkAddFailed(memo, toAdd, transactionCond, allOrNone);
        }
        // everything we wanted to add was added.
        // insertedIds maps the index in the batch to the _id
        var insertedIds = bulkResult.insertedIds || { };
        Object.keys(insertedIds).forEach(function(idx) {
            toAdd[idx]._id = insertedIds[idx];
        });
        memo.success = toAdd;
        return memo;
    }

    // Some of a bulk add's inserts failed - find out which ones from what the
    // database holds for the transaction.  With allOrNone, remove the rest.
    async _bulkAddFailed(memo, toAdd, transactionCond, allOrNone) {
        var added = await this.getAll(transactionCond, { lean : true });
        var addedIdxs = new Set(added.map(function(item) {
            return item[SIS.FIELD_SIS_META][SIS.FIELD_TRANSACTION_ID].idx;
        }));
        var insertFail = SIS.ERR_BAD_REQ("Insert failed");
        var success = [];
        toAdd.forEach(function(item) {
            // match on the transaction idx - not the position in toAdd, which
            // differs once an item has failed validation
            if (addedIdxs.has(item[SIS.FIELD_SIS_META][SIS.FIELD_TRANSACTION_ID].idx)) {
                success.push(item);
            } else {
                memo.errors.push({ value : item, err : insertFail });
            }
        });
        if (!allOrNone) {
            memo.success = success;
            return memo;
        }
        try {
            await this.model.deleteMany(transactionCond).exec();
        } catch (e) {
            var msg = "Error deleting entries per allOrNone: " + SIS.FIELD_TRANSACTION_ID + ".id = " +
                transactionCond[SIS.FIELD_SIS_META + "." + SIS.FIELD_TRANSACTION_ID + ".id"];
            throw SIS.ERR_INTERNAL(msg);
        }
        return memo;
    }

    // Update the object with the given id using saveFunc to persist it.
    // Resolves with { old, updated } where old is the object before the
    // update (a plain object) and updated is what saveFunc and finishUpdate
    // resolved with.
    async _update(id, obj, options, saveFunc) {
        var converted = await this.getById(id, { lean : true });
        var err = this.validate(obj, converted, options);
        if (err) {
            throw SIS.ERR_BAD_REQ(err);
        }
        // this check should still work for entities since idField is _id and
        // it is removed from the object in the validate method.
        // this needs to be cleaned since this is a case of a superclass
        // getting lucky because of subclass behavior
        if (this.idField in obj && converted[this.idField] != obj[this.idField]) {
            throw SIS.ERR_BAD_REQ(this.idField + " cannot be changed.");
        }

        // init the mongoose doc - must use .init per comment in mongoose
        // otherwise there are problems like _id mod errors from mongo
        var found = new this.model();
        found.init(converted, { });
        found.isNew = false;

        var oldV11 = found.toObject();
        var user = options.user;

        // always convert the obj to V1.1
        obj = SIS.ENSURE_SIS_META(obj);

        // the meta fields starting with _ (such as _created_by) are kept by SIS,
        // so an update can not set them
        var updateMeta = obj[SIS.FIELD_SIS_META];
        Object.keys(updateMeta).forEach(function(k) {
            if (k[0] === '_') {
                delete updateMeta[k];
            }
        });

        // set the mutable meta fields
        SIS.MUTABLE_META_FIELDS.forEach(function(k) {
            if (k in updateMeta) {
                found[SIS.FIELD_SIS_META][k] = updateMeta[k];
            }
        });

        var merged = await this._merge(found, obj, options);
        var doc = await this.authorize(SIS.EVENT_UPDATE, oldV11, user, merged);
        doc = await this._addByFields(user, SIS.EVENT_UPDATE)(doc);
        doc = await this._preSave(doc);
        var updated = await saveFunc(doc);
        updated = await this.finishUpdate(oldV11, updated);
        return { old : oldV11, updated : updated };
    }

    async finishUpdate(old, updated) {
        return updated;
    }

    // Returns a save function for _update that saves the updated document
    // like _save, but only if the stored object still matches the cas condition
    _getCasSave(cas) {
        return async (doc) => {
            // save filters on $where as is, so cast it like a query would be
            // (cas values from the query string are strings)
            try {
                doc.$where = this.model.find().cast(this.model, cas);
            } catch (err) {
                throw SIS.ERR_BAD_REQ(err);
            }
            this.applyPreSaveFields(doc);
            try {
                return await doc.save();
            } catch (err) {
                if (err && err.name == "DocumentNotFoundError") {
                    throw SIS.ERR_BAD_REQ("CAS update failed.");
                }
                throw this._mapModError(err);
            }
        };
    }

    canInsertWithId(id, obj) {
        return obj[this.idField] == id;
    }

    // Update the object if it exists, otherwise add it.  Resolves with
    // { old, updated } like update - old is null when the object was added.
    async upsert(id, obj, options) {
        options = this._getDefaultOptions(options);
        try {
            await this.getById(id, { lean : true });
        } catch (err) {
            if (!this.canInsertWithId(id, obj)) {
                throw SIS.ERR_BAD_REQ("Cannot insert object with specified ID");
            }
            return { old : null, updated : await this.add(obj, options) };
        }
        return this.update(id, obj, options);
    }

    // Ensures the user can update the object and then update it.
    // Resolves with { old, updated } (see _update).
    update(id, obj, options) {
        options = this._getDefaultOptions(options);
        var cas = options.cas;
        var saveFunc = this._save.bind(this);
        // if cas, use the cas save rather than generic save
        if (cas) {
            saveFunc = this._getCasSave(cas);
        }
        return this._update(id, obj, options, saveFunc);
    }

    // Update every object matching condition with obj.  Resolves with
    // { success, errors } where success holds what update resolved with.
    // Note bulk updates are horribly inefficient at the moment
    async bulkUpdateQuery(condition, obj, options) {
        var items = await this.getAll(condition, { lean : true }, this.idField);
        return this._updateEach(items, function() { return obj; }, options);
    }

    // Update each object in items, identified by its id field.  Resolves with
    // { success, errors } where success holds what update resolved with.
    bulkUpdateArray(items, options) {
        return this._updateEach(items, function(item) { return item; }, options);
    }

    // Update the object with the id of each item with what getUpdate maps the
    // item to
    async _updateEach(items, getUpdate, options) {
        var memo = { success : [], errors : [] };
        await Promise.all(items.map(async (item) => {
            var id = item[this.idField];
            if (!id) {
                memo.errors.push({ err : SIS.ERR_BAD_REQ("Missing ID field in bulk update"), value : item });
                return;
            }
            try {
                memo.success.push(await this.update(id, getUpdate(item), options));
            } catch (err) {
                memo.errors.push({ err : err, value : item });
            }
        }));
        return memo;
    }

    // Ensures the user can delete the object and then delete it.
    // Resolves with the deleted object.
    async delete(id, options) {
        options = this._getDefaultOptions(options);
        var obj = SIS.ENSURE_SIS_META(await this.getById(id, { lean : true }));
        var authorized = await this.authorize(SIS.EVENT_DELETE, obj, options.user);
        var removed = await this._remove(authorized);
        await this.objectRemoved(removed);
        return removed;
    }

    // Delete every object matching condition.  Resolves with { success, errors }
    // where success holds what objectRemoved resolved with for each deleted object.
    async bulkDelete(condition, options) {
        options = this._getDefaultOptions(options);
        var user = options.user;
        var memo = { success: [], errors: [] };
        var items = await this.getAll(condition, { lean: true });

        var toDelete = [];
        await Promise.all(items.map(async (item) => {
            item = SIS.ENSURE_SIS_META(item);
            try {
                toDelete.push(await this.authorize(SIS.EVENT_DELETE, item, user));
            } catch (err) {
                memo.errors.push({ err : err, value : item });
            }
        }));
        if (!toDelete.length) {
            return memo;
        }

        var idsToDelete = { };
        toDelete.forEach(function(i) {
            idsToDelete[i._id] = i;
        });
        var idCondition = { _id : { $in : Object.keys(idsToDelete) } };
        var res;
        try {
            res = await this.model.deleteMany(idCondition).exec();
        } catch (err) {
            throw SIS.ERR_INTERNAL(err);
        }
        var deleted = toDelete;
        if (res.deletedCount != toDelete.length) {
            // some issue occurred.. get the ones that weren't deleted
            var remaining;
            try {
                remaining = await this.getAll(idCondition, { lean : true });
            } catch (err) {
                throw SIS.ERR_INTERNAL(err);
            }
            remaining.forEach(function(r) {
                delete idsToDelete[r._id];
                memo.errors.push({ err : SIS.ERR_INTERNAL("Could not delete."), value : r });
            });
            deleted = Object.values(idsToDelete);
        }

        // trigger object removed
        await Promise.all(deleted.map(async (removed) => {
            try {
                memo.success.push(await this.objectRemoved(removed));
            } catch (e) {
                // in a REALLY bad state here.
                // TODO: handle this error case
                memo.errors.push({ err : e, value : removed });
            }
        }));
        return memo;
    }

    // utils
    // Expects a valid object - should be called at the end of
    // a validate routine and changes the owner to an array
    // if it is a string
    validateOwner(obj, options) {
        if (!this.authEnabled) {
            return null;
        }
        if (!obj) {
            return SIS.FIELD_OWNER + " field is required.";
        }
        obj = obj[SIS.FIELD_SIS_META];
        if (!obj) {
            return SIS.FIELD_OWNER + " field is required in " + SIS.FIELD_SIS_META;
        }
        if (!obj[SIS.FIELD_OWNER]) {
            return SIS.FIELD_OWNER + " field is required.";
        }
        var owner = obj[SIS.FIELD_OWNER];
        if (typeof owner === 'string') {
            if (!owner.length) {
                return SIS.FIELD_OWNER + " can not be empty.";
            }
            obj[SIS.FIELD_OWNER] = [owner];
        } else if (owner instanceof Array) {
            if (!owner.length) {
                return SIS.FIELD_OWNER + " can not be empty.";
            }
            // sort it
            owner.sort();
        } else {
            // invalid format
            return SIS.FIELD_OWNER + " must be a string or array.";
        }
        return null;
    }

    getOwners(obj) {
        if (SIS.FIELD_SIS_META in obj) {
            obj = obj[SIS.FIELD_SIS_META];
        }
        return obj[SIS.FIELD_OWNER];
    }

    // expects object to have an owners array - i.e. should have passed
    // validateOwners
    getPermissionsForObject(obj, user) {
        if (!this.authEnabled) {
            return SIS.PERMISSION_ADMIN;
        }
        // if either is null, just say nothing..
        if (!user || !obj) {
            return SIS.PERMISSION_NONE;
        }
        if (user[SIS.FIELD_SUPERUSER]) {
            return SIS.PERMISSION_ADMIN;
        }
        if (!user[SIS.FIELD_ROLES]) {
            return SIS.PERMISSION_NONE;
        }
        var owners = this.getOwners(obj);
        var roles = user[SIS.FIELD_ROLES];
        var userRoleCount = 0;
        var adminRoleCount = 0;
        for (var i = 0; i < owners.length; ++i) {
            var owner = owners[i];
            if (owner in roles) {
                if (roles[owner] == SIS.ROLE_ADMIN) {
                    adminRoleCount++;
                    userRoleCount++;
                } else if (roles[owner] == SIS.ROLE_USER) {
                    userRoleCount++;
                }
            }
        }
        // are we permitted to operate on all groups?
        if (adminRoleCount == owners.length) {
            return SIS.PERMISSION_ADMIN;
        } else if (userRoleCount == owners.length) {
            return SIS.PERMISSION_USER_ALL_GROUPS;
        } else {
            return userRoleCount ? SIS.PERMISSION_USER : SIS.PERMISSION_NONE;
        }
    }

    // Utility method to apply a partial object to the full one
    // This supports nested documents
    applyPartial(full, partial) {
        if (full === null || partial === null) {
            return partial;
        }
        if (typeof partial !== 'object' || Array.isArray(partial)) {
            return partial;
        } else if (typeof full !== 'object' || Array.isArray(full)) {
            return partial;
        } else if (Array.isArray(full) !== Array.isArray(partial)) {
            return partial;
        } else {
            // merge the object
            var result = full;
            for (var k in partial) {
                if (partial[k] !== null) {
                    if (!full[k]) {
                        result[k] = partial[k];
                    } else {
                        result[k] = this.applyPartial(full[k], partial[k]);
                    }
                } else {
                    delete result[k];
                }
            }
            return result;
        }
    }

    // Private methods
    // Remove the document and resolve with it
    async _remove(doc) {
        var q = {}; q[this.idField] = doc[this.idField];
        await this.model.deleteOne(q).exec();
        return doc;
    }

    // Map a mongoose save/validation error to a SIS error tuple
    _mapModError(err) {
        if (err && (err.name == "ValidationError" || err.name == "CastError")) {
            return SIS.ERR_BAD_REQ(err);
        }
        return SIS.ERR_INTERNAL(err);
    }

    // Get the fields that need populating
    _getPopulateFields() {
        var references = this.getReferences();
        if (!references.length) {
            return null;
        }
        return references.reduce(function(result, ref) {
            result[ref.ref] = result[ref.ref] || [];
            result[ref.ref].push(ref.path);
            return result;
        }, { });
    }

    _getFieldsFromPopulateObject(refToPaths, subList) {
        var refs = Object.keys(refToPaths);
        var paths = refs.reduce(function(result, ref) {
            return result.concat(refToPaths[ref]);
        }, []);
        if (Array.isArray(subList)) {
            paths = _.intersection(paths, subList);
        }
        if (!paths.length) { return null; }
        return paths.join(" ");
    }

    // Apply the update to a document from find and resolve with it
    async _merge(doc, update, options) {
        return this.applyUpdate(doc, update, options);
    }

    applyPreSaveFields(obj) {
        obj[SIS.FIELD_SIS_META][SIS.FIELD_UPDATED_AT] = Date.now();
    }

    // Run _preSave on each object.  Resolves with { success, errors }:
    // the objects that passed, and errors as { err, value }
    async _preSaveBulk(objs) {
        var errors = [];
        var success = [];
        await Promise.all(objs.map(async (obj) => {
            try {
                success.push(await this._preSave(obj));
            } catch (err) {
                errors.push({ value : obj, err : err });
            }
        }));
        return { success : success, errors : errors };
    }

    // pre add hook that is called on inserts only
    // before the object is persisted
    async preAdd(obj) {
        return obj;
    }

    // do one last bit of validation for subclasses
    async _preSave(obj) {
        return obj;
    }

    // Save the object and resolve with the saved document
    async _save(obj) {
        if (!obj) {
            throw SIS.ERR_BAD_REQ("invalid data");
        }
        var m = obj;
        if (!(obj instanceof this.model)) {
            try {
                m = new this.model(obj);
            } catch (ex) {
                throw SIS.ERR_BAD_REQ(ex);
            }
        }
        this.applyPreSaveFields(m);
        try {
            return await m.save();
        } catch (err) {
            throw this._mapModError(err);
        }
    }

    // Returns a function that receives a document, fills in
    // the _updated_by and _created_by fields and resolves with it
    _addByFields(user, event) {
        return async function(doc) {
            if (!doc) {
                return doc;
            }
            var docMeta = doc[SIS.FIELD_SIS_META];
            if (event == SIS.EVENT_INSERT) {
                docMeta[SIS.FIELD_CREATED_AT] = Date.now();
            }
            if (!user) {
                return doc;
            }

            if (event == SIS.EVENT_UPDATE) {
                docMeta[SIS.FIELD_UPDATED_BY] = user[SIS.FIELD_NAME];
            } else if (event == SIS.EVENT_INSERT) {
                docMeta[SIS.FIELD_CREATED_BY] = user[SIS.FIELD_NAME];
                docMeta[SIS.FIELD_UPDATED_BY] = user[SIS.FIELD_NAME];
            }
            return doc;
        };
    }
}

// exports
export default Manager;
