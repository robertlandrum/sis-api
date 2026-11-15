describe('Manager', function() {
    "use strict";

    // Characterization tests for the base Manager (util/manager.js).  They pin
    // the behavior subclasses and controllers rely on - result shapes, error
    // tuples and the bulk paths - using a plain model rather than a SIS schema
    // so the base class is exercised without subclass overrides.

    var SIS = require("../util/constants");
    var Manager = require("../util/manager");
    var should = require('should');
    var TestUtil = require('./fixtures/util');
    var LocalTest = new TestUtil.LocalTest();

    var MODEL_NAME = "manager_test_item";
    var Model = null;

    // A manager whose model has some statics replaced; the rest go to the
    // real model so the database is still used.
    function withModel(overrides, opts) {
        var model = new Proxy(Model, {
            get : function(target, prop) {
                if (prop in overrides) {
                    return overrides[prop];
                }
                var value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        return new Manager(model, opts);
    }

    function rejectingQuery(err) {
        return function() {
            return { exec : function() { return Promise.reject(err); } };
        };
    }

    var expectError = TestUtil.expectError;

    function item(name, num, owner) {
        var result = { name : name, num : num };
        result[SIS.FIELD_SIS_META] = { owner : owner || ["g1"] };
        return result;
    }

    function meta(obj) {
        return obj[SIS.FIELD_SIS_META];
    }

    var admin = { name : "admin_user", roles : { g1 : SIS.ROLE_ADMIN, g2 : SIS.ROLE_ADMIN } };
    var superUser = { name : "super", super_user : true };

    before(function(done) {
        LocalTest.start(function(err, mongoose) {
            if (err) { return done(err); }
            Model = mongoose.models[MODEL_NAME];
            if (!Model) {
                var metaDef = Object.assign({}, require("../util/sis-schemas").metaDef);
                metaDef.owner = { type : ["String"] };
                var schema = new mongoose.Schema({
                    name : { type : String, required : true, unique : true },
                    num : { type : Number, min : 0 },
                    _sis : metaDef
                });
                schema._sis_references = [];
                Model = mongoose.model(MODEL_NAME, schema);
            }
            Model.init().then(function() { done(); }, done);
        });
    });

    after(function(done) {
        LocalTest.stop(done);
    });

    beforeEach(function() {
        return Model.deleteMany({}).exec();
    });

    describe('constructor', function() {
        it("defaults the id field, type and auth", function() {
            var mgr = new Manager(Model);
            mgr.idField.should.eql(SIS.FIELD_NAME);
            mgr.type.should.eql(MODEL_NAME);
            mgr.authEnabled.should.eql(SIS.DEFAULT_OPT_USE_AUTH);
        });

        it("takes the id field, type and auth from options", function() {
            var opts = {};
            opts[SIS.OPT_ID_FIELD] = "_id";
            opts[SIS.OPT_TYPE] = "thing";
            opts[SIS.OPT_USE_AUTH] = false;
            var mgr = new Manager(Model, opts);
            mgr.idField.should.eql("_id");
            mgr.type.should.eql("thing");
            mgr.authEnabled.should.eql(false);
        });
    });

    describe('getters', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = new Manager(Model, { auth : false });
            await mgr.add(item("a", 1));
            await mgr.add(item("b", 2));
        });

        it("gets by id", async function() {
            var found = await mgr.getById("a", { lean : true });
            found.num.should.eql(1);
        });

        it("rejects with 404 when nothing matches", async function() {
            await expectError(mgr.getById("missing"), 404, /manager_test_item missing does not exist/);
        });

        it("rejects with 404 for an id that does not cast", async function() {
            var byObjectId = new Manager(Model, { auth : false, id_field : "_id" });
            await expectError(byObjectId.getById("not-an-object-id"), 404);
        });

        it("rejects with 500 for other database errors", async function() {
            var broken = withModel({ findOne : rejectingQuery(new Error("db down")) }, { auth : false });
            await expectError(broken.getById("a"), 500, /db down/);
        });

        it("passes error tuples through untouched", async function() {
            var tuple = SIS.ERR_BAD_REQ("already a tuple");
            var broken = withModel({ findOne : rejectingQuery(tuple) }, { auth : false });
            var err = await expectError(broken.getById("a"), 400);
            err.should.equal(tuple);
        });

        it("gets all with find options", async function() {
            var all = await mgr.getAll({}, { sort : { num : -1 }, lean : true, bogus : true });
            all.map(function(i) { return i.name; }).should.eql(["b", "a"]);
        });

        it("only passes known find options", function() {
            mgr._getFindOptions(null).should.eql({});
            mgr._getFindOptions({ skip : 1, limit : 2, sort : 3, lean : 4, populate : 5, read : 6, user : 7 })
                .should.eql({ skip : 1, limit : 2, sort : 3, lean : 4, populate : 5, read : 6 });
        });

        it("counts as [count, condition, manager]", async function() {
            var condition = { num : { $gt : 1 } };
            var result = await mgr.count(condition);
            result.length.should.eql(3);
            result[0].should.eql(1);
            result[1].should.equal(condition);
            result[2].should.equal(mgr);
        });

        it("counts everything for an empty condition", async function() {
            var result = await mgr.count({});
            result[0].should.eql(2);
        });

        it("counts 0 when the count fails", async function() {
            var broken = withModel({ countDocuments : rejectingQuery(new Error("db down")) }, { auth : false });
            var condition = { num : 1 };
            var result = await broken.count(condition);
            result[0].should.eql(0);
            result[1].should.equal(condition);
            result[2].should.equal(broken);
        });
    });

    describe('getPopulateFields', function() {
        var mgr = null;
        var loaded = null;
        var loadable = null;
        var schemaManager = {
            hasEntityModel : function(name) { return loaded.indexOf(name) !== -1; },
            getEntityModelAsync : function(name) {
                if (loadable.indexOf(name) !== -1) {
                    return Promise.resolve({});
                }
                return Promise.reject(SIS.ERR_NOT_FOUND("schema", name));
            }
        };
        var references = [
            { ref : "s1", path : "p1" },
            { ref : "s1", path : "p2" },
            { ref : "s2", path : "p3" }
        ];

        beforeEach(function() {
            mgr = new Manager(Model, { auth : false });
            mgr.getReferences = function() { return references; };
            loaded = [];
            loadable = [];
        });

        it("returns null without references", async function() {
            mgr.getReferences = function() { return []; };
            should.not.exist(await mgr.getPopulateFields(schemaManager));
        });

        it("returns the paths of loaded schemas", async function() {
            loaded = ["s1", "s2"];
            (await mgr.getPopulateFields(schemaManager)).should.eql("p1 p2 p3");
        });

        it("limits the paths to a sub list", async function() {
            loaded = ["s1", "s2"];
            (await mgr.getPopulateFields(schemaManager, ["p3", "p1", "nope"])).should.eql("p1 p3");
        });

        it("returns null when the sub list matches nothing", async function() {
            loaded = ["s1", "s2"];
            should.not.exist(await mgr.getPopulateFields(schemaManager, ["nope"]));
        });

        it("loads schemas that are not loaded yet", async function() {
            loaded = ["s1"];
            loadable = ["s2"];
            (await mgr.getPopulateFields(schemaManager)).should.eql("p1 p2 p3");
        });

        it("drops the paths of schemas that cannot be loaded", async function() {
            loaded = ["s1"];
            (await mgr.getPopulateFields(schemaManager)).should.eql("p1 p2");
        });

        it("returns null when no schema can be loaded", async function() {
            should.not.exist(await mgr.getPopulateFields(schemaManager));
        });
    });

    describe('permissions', function() {
        var mgr = new Manager({ modelName : MODEL_NAME }, { auth : true });

        it("grants admin when auth is disabled", function() {
            new Manager({ modelName : MODEL_NAME }, { auth : false })
                .getPermissionsForObject(null, null).should.eql(SIS.PERMISSION_ADMIN);
        });

        it("grants nothing without a user or object", function() {
            mgr.getPermissionsForObject(item("a"), null).should.eql(SIS.PERMISSION_NONE);
            mgr.getPermissionsForObject(null, admin).should.eql(SIS.PERMISSION_NONE);
        });

        it("grants admin to super users", function() {
            mgr.getPermissionsForObject(item("a"), superUser).should.eql(SIS.PERMISSION_ADMIN);
        });

        it("grants nothing to users without roles", function() {
            mgr.getPermissionsForObject(item("a"), { name : "x" }).should.eql(SIS.PERMISSION_NONE);
        });

        it("grants by the roles held on the owners", function() {
            var user = { name : "u", roles : { g1 : SIS.ROLE_ADMIN, g2 : SIS.ROLE_USER } };
            mgr.getPermissionsForObject(item("a", 1, ["g1"]), user).should.eql(SIS.PERMISSION_ADMIN);
            mgr.getPermissionsForObject(item("a", 1, ["g1", "g2"]), user).should.eql(SIS.PERMISSION_USER_ALL_GROUPS);
            mgr.getPermissionsForObject(item("a", 1, ["g2", "g3"]), user).should.eql(SIS.PERMISSION_USER);
            mgr.getPermissionsForObject(item("a", 1, ["g3"]), user).should.eql(SIS.PERMISSION_NONE);
        });

        it("reads owners from the meta or the object itself", function() {
            mgr.getOwners(item("a", 1, ["g9"])).should.eql(["g9"]);
            mgr.getOwners({ owner : ["g8"] }).should.eql(["g8"]);
        });

        it("validates owners", function() {
            var invalid = [
                [null, /required/],
                [{}, /required in _sis/],
                [{ _sis : {} }, /required/],
                [{ _sis : { owner : "" } }, /required/],
                [{ _sis : { owner : [] } }, /can not be empty/],
                [{ _sis : { owner : 5 } }, /must be a string or array/]
            ];
            invalid.forEach(function(pair) {
                mgr.validateOwner(pair[0]).should.match(pair[1]);
            });
            var single = { _sis : { owner : "g1" } };
            should.not.exist(mgr.validateOwner(single));
            single._sis.owner.should.eql(["g1"]);
            var several = { _sis : { owner : ["g2", "g1"] } };
            should.not.exist(mgr.validateOwner(several));
            several._sis.owner.should.eql(["g1", "g2"]);
            should.not.exist(new Manager({ modelName : MODEL_NAME }, { auth : false }).validateOwner(null));
        });
    });

    describe('authorize', function() {
        var mgr = null;
        before(function() {
            mgr = new Manager(Model, { auth : true });
        });

        it("resolves with the object on insert and delete", async function() {
            var obj = item("a");
            (await mgr.authorize(SIS.EVENT_INSERT, obj, admin)).should.equal(obj);
            (await mgr.authorize(SIS.EVENT_DELETE, obj, admin)).should.equal(obj);
        });

        it("rejects deleting a locked object", async function() {
            var obj = item("a");
            meta(obj).locked = true;
            await expectError(mgr.authorize(SIS.EVENT_DELETE, obj, superUser), 401, /locked/);
        });

        it("rejects users without permission on the object", async function() {
            await expectError(mgr.authorize(SIS.EVENT_INSERT, item("a", 1, ["g3"]), admin),
                              401, /Insufficient permissions on source document/);
        });

        it("lets plain users operate when any owner can modify", async function() {
            var obj = item("a", 1, ["g1", "g3"]);
            var user = { name : "u", roles : { g1 : SIS.ROLE_USER } };
            await expectError(mgr.authorize(SIS.EVENT_INSERT, obj, user), 401);
            meta(obj)[SIS.FIELD_ANY_ADMIN_MOD] = true;
            (await mgr.authorize(SIS.EVENT_INSERT, obj, user)).should.equal(obj);
        });

        it("resolves with the merged object on update", async function() {
            var merged = new Model(item("a", 2));
            (await mgr.authorize(SIS.EVENT_UPDATE, item("a", 1), admin, merged)).should.equal(merged);
        });

        it("rejects updates that move the object out of the user's groups", async function() {
            var merged = new Model(item("a", 1, ["g3"]));
            await expectError(mgr.authorize(SIS.EVENT_UPDATE, item("a", 1), admin, merged),
                              401, /Insufficient/);
        });

        it("rejects changing the data of an immutable object", async function() {
            var old = new Model(item("a", 1)).toObject();
            meta(old).immutable = true;
            var merged = new Model(old);
            merged.num = 2;
            await expectError(mgr.authorize(SIS.EVENT_UPDATE, old, admin, merged), 401, /immutable/);
        });

        it("allows clearing the immutable flag", async function() {
            var old = new Model(item("a", 1)).toObject();
            meta(old).immutable = true;
            var merged = new Model(old);
            meta(merged).immutable = false;
            (await mgr.authorize(SIS.EVENT_UPDATE, old, admin, merged)).should.equal(merged);
        });

        [
            ["the owner", { owner : ["g1", "g2"] }],
            ["the tags", { tags : ["t1"] }],
            ["the lock", { locked : true }],
            ["the owner while clearing the immutable flag", { owner : ["g1", "g2"], immutable : false }]
        ].forEach(function(change) {
            it("rejects changing " + change[0] + " of an immutable object", async function() {
                var old = new Model(item("a", 1)).toObject();
                meta(old).immutable = true;
                var merged = new Model(old);
                Object.keys(change[1]).forEach(function(k) {
                    meta(merged)[k] = change[1][k];
                });
                await expectError(mgr.authorize(SIS.EVENT_UPDATE, old, admin, merged), 401, /immutable/);
            });
        });
    });

    describe('add', function() {
        var mgr = null;
        beforeEach(function() {
            mgr = new Manager(Model, { auth : true });
        });

        it("saves the object and fills in the meta fields", async function() {
            var before = Date.now();
            var added = await mgr.add(item("a", 1), { user : admin });
            added.should.be.instanceof(Model);
            added.name.should.eql("a");
            var m = meta(added);
            m._version.should.eql("v1.1");
            m._created_by.should.eql("admin_user");
            m._updated_by.should.eql("admin_user");
            m._created_at.should.be.aboveOrEqual(before);
            m._updated_at.should.be.aboveOrEqual(before);
            (await Model.countDocuments({ name : "a" })).should.eql(1);
        });

        it("defaults the version option", async function() {
            var options = {};
            var seen = null;
            mgr.validate = function(obj, toUpdate, opts) { seen = opts; return null; };
            options.user = admin;
            await mgr.add(item("a"), options);
            seen.should.equal(options);
            options.version.should.eql("v1.1");
        });

        it("rejects with 400 when validate returns a message", async function() {
            mgr.validate = function() { return "nope"; };
            await expectError(mgr.add(item("a"), { user : admin }), 400, /Bad request: nope/);
        });

        it("rejects with 401 without permission", async function() {
            await expectError(mgr.add(item("a", 1, ["g3"]), { user : admin }), 401);
        });

        it("runs preAdd and _preSave in order before saving", async function() {
            var calls = [];
            mgr.preAdd = function(obj) { calls.push("preAdd"); obj.num = 7; return Promise.resolve(obj); };
            mgr._preSave = function(obj) { calls.push("_preSave"); return Promise.resolve(obj); };
            var added = await mgr.add(item("a", 1), { user : admin });
            calls.should.eql(["preAdd", "_preSave"]);
            added.num.should.eql(7);
        });

        it("rejects with 400 for a model validation error", async function() {
            await expectError(mgr.add(item("a", -1), { user : admin }), 400);
        });

        it("rejects with 409 for a taken unique value", async function() {
            await mgr.add(item("a", 1), { user : admin });
            await expectError(mgr.add(item("a", 2), { user : admin }), 409, /Conflict/);
        });

        it("rejects saving nothing", async function() {
            await expectError(mgr._save(null), 400, /invalid data/);
        });

        it("rejects with 400 when the model cannot be built", async function() {
            var Broken = function() { throw new Error("bad shape"); };
            var broken = new Manager(Object.assign(Broken, { modelName : MODEL_NAME }), { auth : false });
            await expectError(broken._save({}), 400, /bad shape/);
        });

        it("fills in only the created time without a user", async function() {
            var fill = mgr._addByFields(null, SIS.EVENT_INSERT);
            var obj = await fill(item("a"));
            should.exist(meta(obj)._created_at);
            should.not.exist(meta(obj)._created_by);
            should.not.exist(await fill(null));
        });
    });

    describe('update', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = new Manager(Model, { auth : true });
            await mgr.add(item("a", 1), { user : superUser });
        });

        it("resolves with [old, updated, null]", async function() {
            var result = await mgr.update("a", { num : 2 }, { user : admin });
            result.length.should.eql(3);
            result[0].num.should.eql(1);
            result[0].should.not.be.instanceof(Model);
            result[1].should.be.instanceof(Model);
            result[1].num.should.eql(2);
            meta(result[1])._updated_by.should.eql("admin_user");
            meta(result[1])._created_by.should.eql("super");
            should(result[2]).be.null();
            (await Model.findOne({ name : "a" }).lean()).num.should.eql(2);
        });

        it("applies mutable meta fields", async function() {
            var update = { _sis : { tags : ["t1"], owner : ["g1", "g2"] } };
            var updated = (await mgr.update("a", update, { user : admin }))[1];
            meta(updated).tags.should.eql(["t1"]);
            meta(updated).owner.should.eql(["g1", "g2"]);
        });

        it("keeps the meta fields SIS maintains", async function() {
            var before = await Model.findOne({ name : "a" }).lean();
            var update = { num : 2, _sis : { _created_by : "forged", _created_at : 1,
                                              _updated_by : "forged", _updated_at : 1 } };
            await mgr.update("a", update, { user : admin });
            var stored = meta(await Model.findOne({ name : "a" }).lean());
            stored._created_by.should.eql("super");
            stored._created_at.should.eql(meta(before)._created_at);
            stored._updated_by.should.eql("admin_user");
            stored._updated_at.should.be.aboveOrEqual(meta(before)._updated_at);
        });

        it("rejects with 404 for a missing object", async function() {
            await expectError(mgr.update("missing", { num : 2 }, { user : admin }), 404);
        });

        it("rejects with 400 when validate returns a message", async function() {
            mgr.validate = function(obj, found) { return found.num === 1 ? "still one" : null; };
            await expectError(mgr.update("a", { num : 2 }, { user : admin }), 400, /still one/);
        });

        it("rejects changing the id", async function() {
            await expectError(mgr.update("a", { name : "b" }, { user : admin }), 400, /name cannot be changed/);
        });

        it("rejects with 401 without permission", async function() {
            var user = { name : "u", roles : { g3 : SIS.ROLE_ADMIN } };
            await expectError(mgr.update("a", { num : 2 }, { user : user }), 401);
        });

        it("passes old and updated to finishUpdate", async function() {
            var seen = null;
            mgr.finishUpdate = function(old, updated) {
                seen = [old.num, updated.num];
                return Promise.resolve({ replaced : true });
            };
            var result = await mgr.update("a", { num : 2 }, { user : admin });
            seen.should.eql([1, 2]);
            result[1].should.eql({ replaced : true });
        });

        it("updates when the CAS condition matches", async function() {
            var result = await mgr.update("a", { num : 3 }, { user : admin, cas : { num : 1 } });
            result[0].num.should.eql(1);
            result[1].num.should.eql(3);
        });

        it("rejects when the CAS condition does not match", async function() {
            await expectError(mgr.update("a", { num : 3 }, { user : admin, cas : { num : 5 } }),
                              400, /CAS update failed/);
            (await Model.findOne({ name : "a" }).lean()).num.should.eql(1);
        });

        it("rejects a CAS update that fails model validation", async function() {
            await expectError(mgr.update("a", { num : -3 }, { user : admin, cas : { num : 1 } }), 400);
            (await Model.findOne({ name : "a" }).lean()).num.should.eql(1);
        });

        it("casts the CAS condition", async function() {
            var result = await mgr.update("a", { num : 3 }, { user : admin, cas : { num : "1" } });
            result[1].num.should.eql(3);
            await expectError(mgr.update("a", { num : 4 }, { user : admin, cas : { num : "abc" } }), 400);
        });

        it("saves a CAS update like any other update", async function() {
            await Model.updateOne({ name : "a" }, { "_sis.tags" : ["t0"], "_sis.locked" : true });
            var result = await mgr.update("a", { num : 3, _sis : { tags : ["t1"] } },
                                          { user : admin, cas : { num : 1 } });
            var stored = await Model.findOne({ name : "a" }).lean();
            stored.num.should.eql(3);
            var m = meta(stored);
            m.tags.should.eql(["t1"]);
            m.owner.should.eql(["g1"]);
            m.locked.should.eql(true);
            m._created_by.should.eql("super");
            m._updated_by.should.eql("admin_user");
            m._updated_at.should.be.aboveOrEqual(meta(result[0])._updated_at);
        });
    });

    describe('upsert', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = new Manager(Model, { auth : true });
            await mgr.add(item("a", 1), { user : superUser });
        });

        it("updates an existing object", async function() {
            var result = await mgr.upsert("a", item("a", 2), { user : admin });
            result.should.be.instanceof(Array);
            result[1].num.should.eql(2);
        });

        it("adds a missing object", async function() {
            var result = await mgr.upsert("b", item("b", 2), { user : admin });
            result.should.be.instanceof(Model);
            result.name.should.eql("b");
        });

        it("rejects adding with an id other than the one in the path", async function() {
            await expectError(mgr.upsert("b", item("c", 2), { user : admin }), 400, /specified ID/);
        });

        it("rejects with the update's error for an existing object", async function() {
            var user = { name : "u", roles : { g3 : SIS.ROLE_ADMIN } };
            await expectError(mgr.upsert("a", item("a", 2), { user : user }), 401);
            await expectError(mgr.upsert("a", item("a", 2), { user : admin, cas : { num : 5 } }),
                              400, /CAS update failed/);
        });
    });

    describe('delete', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = new Manager(Model, { auth : true });
            await mgr.add(item("a", 1), { user : superUser });
        });

        it("removes the object and reports it to objectRemoved", async function() {
            var removed = null;
            mgr.objectRemoved = function(obj) { removed = obj; return Promise.resolve("ignored"); };
            var result = await mgr.delete("a", { user : admin });
            result.name.should.eql("a");
            removed.should.equal(result);
            (await Model.countDocuments({})).should.eql(0);
        });

        it("rejects with 404 for a missing object", async function() {
            await expectError(mgr.delete("missing", { user : admin }), 404);
        });

        it("rejects deleting a locked object", async function() {
            await Model.updateOne({ name : "a" }, { "_sis.locked" : true });
            await expectError(mgr.delete("a", { user : admin }), 401, /locked/);
            (await Model.countDocuments({})).should.eql(1);
        });
    });

    describe('bulkAdd', function() {
        var mgr = null;
        beforeEach(function() {
            mgr = new Manager(Model, { auth : true });
        });

        it("adds every item", async function() {
            var result = await mgr.bulkAdd([item("a", 1), item("b", 2)], { user : admin });
            result.errors.should.eql([]);
            result.success.length.should.eql(2);
            result.success.forEach(function(s) {
                should.exist(s._id);
                meta(s)._created_by.should.eql("admin_user");
                should.exist(meta(s)._updated_at);
                should.exist(meta(s)[SIS.FIELD_TRANSACTION_ID].id);
            });
            (await Model.countDocuments({})).should.eql(2);
        });

        it("adds the valid items and reports the rest", async function() {
            mgr.validate = function(obj) { return obj.name === "bad" ? "bad name" : null; };
            var items = [item("a", 1), item("bad", 1), item("c", 1, ["g3"]), item("d", -1)];
            var result = await mgr.bulkAdd(items, { user : admin });
            result.success.map(function(s) { return s.name; }).should.eql(["a"]);
            result.errors.length.should.eql(3);
            var byName = {};
            result.errors.forEach(function(e) { byName[e.value.name] = e.err[0]; });
            byName.should.eql({ bad : 400, c : 401, d : 400 });
            (await Model.countDocuments({})).should.eql(1);
        });

        it("adds nothing when all or none has errors", async function() {
            var result = await mgr.bulkAdd([item("a", 1), item("c", 1, ["g3"])],
                                           { user : admin, allOrNone : true });
            result.success.should.eql([]);
            result.errors.length.should.eql(1);
            (await Model.countDocuments({})).should.eql(0);
        });

        it("adds nothing when no item is valid", async function() {
            var result = await mgr.bulkAdd([item("c", 1, ["g3"])], { user : admin });
            result.success.should.eql([]);
            result.errors.length.should.eql(1);
        });

        it("reports the items the database refused", async function() {
            var result = await mgr.bulkAdd([item("a", 1), item("a", 2)], { user : admin });
            result.success.map(function(s) { return s.num; }).should.eql([1]);
            result.errors.length.should.eql(1);
            result.errors[0].err[1].error.should.match(/Insert failed/);
            result.errors[0].value.num.should.eql(2);
            result.internalErr[0].should.eql(409);
            (await Model.countDocuments({})).should.eql(1);
        });

        it("reports the refused items correctly when others failed validation", async function() {
            await mgr.add(item("a", 1), { user : admin });
            var result = await mgr.bulkAdd([item("a", 2), item("b", -1), item("c", 3)], { user : admin });
            result.success.map(function(s) { return s.name; }).should.eql(["c"]);
            var errors = result.errors.map(function(e) { return [e.value.name, e.err[1].error]; });
            errors.length.should.eql(2);
            errors.should.containDeep([["a", "Bad request: Insert failed"]]);
            (await Model.countDocuments({ name : "c" })).should.eql(1);
        });

        it("removes what was added when all or none is refused", async function() {
            var result = await mgr.bulkAdd([item("a", 1), item("a", 2)], { user : admin, allOrNone : true });
            result.success.should.eql([]);
            result.errors.length.should.eql(1);
            (await Model.countDocuments({})).should.eql(0);
        });

        it("reports every item when the database inserts fewer without an error", async function() {
            var collection = {
                initializeUnorderedBulkOp : function() {
                    return {
                        insert : function() {},
                        execute : function() { return Promise.resolve({ ok : 1, insertedCount : 0 }); }
                    };
                }
            };
            var broken = withModel({ collection : collection }, { auth : true });
            var result = await broken.bulkAdd([item("a", 1), item("b", 1)], { user : admin });
            result.success.should.eql([]);
            result.errors.length.should.eql(2);
            should.not.exist(result.internalErr);
        });

        it("rejects with 500 when the insert fails outright", async function() {
            var collection = {
                initializeUnorderedBulkOp : function() {
                    return {
                        insert : function() {},
                        execute : function() { return Promise.reject(new Error("db down")); }
                    };
                }
            };
            var broken = withModel({ collection : collection }, { auth : true });
            await expectError(broken.bulkAdd([item("a", 1)], { user : admin }), 500, /db down/);
        });

        it("rejects with 500 when all or none cannot clean up", async function() {
            var broken = withModel({ deleteMany : rejectingQuery(new Error("db down")) }, { auth : true });
            await expectError(broken.bulkAdd([item("a", 1), item("a", 2)], { user : admin, allOrNone : true }),
                              500, /allOrNone/);
        });

        it("splits _preSave results into success and errors", async function() {
            mgr._preSave = function(obj) {
                return obj.num ? Promise.resolve(obj) : Promise.reject(SIS.ERR_BAD_REQ("zero"));
            };
            var result = await mgr._preSaveBulk([item("a", 1), item("b", 0)]);
            result.length.should.eql(2);
            result[0].map(function(s) { return s.name; }).should.eql(["a"]);
            result[1].length.should.eql(1);
            result[1][0].value.name.should.eql("b");
            result[1][0].err[0].should.eql(400);
        });
    });

    describe('bulk updates', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = new Manager(Model, { auth : true });
            await mgr.bulkAdd([item("a", 1), item("b", 1), item("c", 1, ["g3"])], { user : superUser });
        });

        it("updates by query as [old, updated] pairs", async function() {
            var result = await mgr.bulkUpdateQuery({ "_sis.owner" : "g1" }, { num : 5 }, { user : admin });
            result.errors.should.eql([]);
            result.success.length.should.eql(2);
            result.success.forEach(function(pair) {
                pair.length.should.eql(2);
                pair[0].num.should.eql(1);
                pair[1].num.should.eql(5);
            });
        });

        it("updates by query and reports the failures", async function() {
            var result = await mgr.bulkUpdateQuery({}, { num : 5 }, { user : admin });
            result.success.length.should.eql(2);
            result.errors.length.should.eql(1);
            result.errors[0].value.name.should.eql("c");
            result.errors[0].err[0].should.eql(401);
        });

        it("updates nothing when the query matches nothing", async function() {
            var result = await mgr.bulkUpdateQuery({ name : "zzz" }, { num : 5 }, { user : admin });
            result.should.eql({ success : [], errors : [] });
        });

        it("updates by array as [old, updated] pairs", async function() {
            var result = await mgr.bulkUpdateArray([{ name : "a", num : 6 }, { name : "b", num : 7 }],
                                                   { user : admin });
            result.errors.should.eql([]);
            result.success.map(function(pair) { return [pair.length, pair[0].num, pair[1].num]; })
                .sort().should.eql([[2, 1, 6], [2, 1, 7]]);
        });

        it("updates by array and reports the failures", async function() {
            var result = await mgr.bulkUpdateArray([{ num : 6 }, { name : "c", num : 6 },
                                                    { name : "missing", num : 6 }, { name : "a", num : 6 }],
                                                   { user : admin });
            result.success.length.should.eql(1);
            var errors = result.errors.map(function(e) { return [e.value.name, e.err[0]]; });
            errors.should.containDeep([[undefined, 400], ["c", 401], ["missing", 404]]);
            errors.length.should.eql(3);
        });

        it("updates nothing for an empty array", async function() {
            (await mgr.bulkUpdateArray([], { user : admin })).should.eql({ success : [], errors : [] });
        });
    });

    describe('bulkDelete', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = new Manager(Model, { auth : true });
            await mgr.bulkAdd([item("a", 1), item("b", 1), item("c", 1, ["g3"])], { user : superUser });
        });

        it("deletes the permitted items and reports the rest", async function() {
            var removed = [];
            mgr.objectRemoved = function(obj) { removed.push(obj.name); return Promise.resolve(obj); };
            var result = await mgr.bulkDelete({}, { user : admin });
            result.success.map(function(s) { return s.name; }).sort().should.eql(["a", "b"]);
            removed.sort().should.eql(["a", "b"]);
            result.errors.length.should.eql(1);
            result.errors[0].value.name.should.eql("c");
            result.errors[0].err[0].should.eql(401);
            (await Model.countDocuments({})).should.eql(1);
        });

        it("succeeds with the objects objectRemoved resolves", async function() {
            mgr.objectRemoved = function(obj) { return Promise.resolve({ gone : obj.name }); };
            var result = await mgr.bulkDelete({ name : "a" }, { user : admin });
            result.success.should.eql([{ gone : "a" }]);
        });

        it("reports objects that objectRemoved rejects", async function() {
            mgr.objectRemoved = function(obj) {
                return obj.name === "a" ? Promise.reject(SIS.ERR_INTERNAL("cleanup failed")) : Promise.resolve(obj);
            };
            var result = await mgr.bulkDelete({ "_sis.owner" : "g1" }, { user : admin });
            result.success.map(function(s) { return s.name; }).should.eql(["b"]);
            result.errors.length.should.eql(1);
            result.errors[0].value.name.should.eql("a");
            (await Model.countDocuments({})).should.eql(1);
        });

        it("deletes nothing when the query matches nothing", async function() {
            (await mgr.bulkDelete({ name : "zzz" }, { user : admin })).should.eql({ success : [], errors : [] });
        });

        it("deletes nothing when no item is permitted", async function() {
            var result = await mgr.bulkDelete({ name : "c" }, { user : admin });
            result.success.should.eql([]);
            result.errors.length.should.eql(1);
            (await Model.countDocuments({})).should.eql(3);
        });

        it("reports the items the database did not delete", async function() {
            var broken = withModel({
                deleteMany : function(condition) {
                    return Model.deleteOne({ _id : condition._id.$in[0] });
                }
            }, { auth : true });
            var result = await broken.bulkDelete({ "_sis.owner" : "g1" }, { user : admin });
            result.success.length.should.eql(1);
            result.errors.length.should.eql(1);
            result.errors[0].err[0].should.eql(500);
            result.errors[0].err[1].error.should.match(/Could not delete/);
            result.errors[0].value._id.toString().should.not.eql(result.success[0]._id.toString());
            (await Model.countDocuments({})).should.eql(2);
        });

        it("rejects with 500 when the items left behind cannot be found", async function() {
            var finds = 0;
            var broken = withModel({
                deleteMany : function(condition) {
                    return Model.deleteOne({ _id : condition._id.$in[0] });
                },
                find : function() {
                    // the first find is the bulk delete's own query
                    finds++;
                    return finds === 1 ? Model.find.apply(Model, arguments) : rejectingQuery(new Error("db down"))();
                }
            }, { auth : true });
            var err = await expectError(broken.bulkDelete({ "_sis.owner" : "g1" }, { user : admin }), 500);
            // wrapped once, so the client sees no stack trace
            err[1].error.should.eql("Internal error Error: db down");
        });

        it("rejects with 500 when the delete fails", async function() {
            var broken = withModel({ deleteMany : rejectingQuery(new Error("db down")) }, { auth : true });
            await expectError(broken.bulkDelete({ name : "a" }, { user : admin }), 500, /db down/);
        });
    });

    describe('applyPartial', function() {
        var mgr = new Manager({ modelName : MODEL_NAME });

        it("replaces non objects", function() {
            should(mgr.applyPartial(null, { a : 1 })).eql({ a : 1 });
            should(mgr.applyPartial({ a : 1 }, null)).be.null();
            mgr.applyPartial({ a : 1 }, 5).should.eql(5);
            mgr.applyPartial({ a : 1 }, [1]).should.eql([1]);
            mgr.applyPartial([1], { a : 1 }).should.eql({ a : 1 });
        });

        it("merges nested objects and deletes null values", function() {
            var full = { a : 1, b : { c : 2, d : 3 }, e : 4 };
            var result = mgr.applyPartial(full, { b : { c : 5 }, e : null, f : 6 });
            result.should.equal(full);
            result.should.eql({ a : 1, b : { c : 5, d : 3 }, f : 6 });
        });
    });
});
