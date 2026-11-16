import should from "should";
import SIS from "../util/constants.js";
import * as TestUtil from "./fixtures/util.js";
import createSchemaManager from "../util/schema-manager.js";

describe('EntityManager', function() {
    // Tests of util/entity-manager.js through managers built by the schema
    // manager the way the entities controller builds them.

    var LocalTest = new TestUtil.LocalTest();
    var expectError = TestUtil.expectError;

    var schemaManager = null;
    var superUser = { name : "em_super", super_user : true };
    var g1Admin = { name : "em_g1_admin", roles : { em_g1 : "admin" } };
    var g1User = { name : "em_g1_user", roles : { em_g1 : "user" } };
    var outsider = { name : "em_outsider", roles : { em_g9 : "admin" } };
    var noRoles = { name : "em_no_roles", roles : { } };

    var schemas = {
        target : { name : "em_target", _sis : { owner : ["em_g1", "em_g2"] },
                   definition : { name : "String" } },
        holder : { name : "em_holder", id_field : "name", _sis : { owner : ["em_g1", "em_g2"] },
                   definition : {
                       name : { type : "String", required : true, unique : true },
                       num : { type : "Number" },
                       single : { type : "ObjectId", ref : "em_target" },
                       many : [{ type : "ObjectId", ref : "em_target" }],
                       items : [{ label : "String", thing : { type : "ObjectId", ref : "em_target" } }],
                       mixed : { },
                       nested : { a : "String", b : "String" }
                   } },
        open : { name : "em_open", is_open : true, _sis : { owner : ["em_g1"] },
                 definition : { name : "String" } },
        anyOwner : { name : "em_any_owner", any_owner_can_modify : true, _sis : { owner : ["em_g1", "em_g2"] },
                     definition : { name : "String" } },
        lostRef : { name : "em_lost_ref", _sis : { owner : ["em_g1"] },
                    definition : { name : "String", gone : { type : "ObjectId", ref : "em_gone" } } },
        gone : { name : "em_gone", _sis : { owner : ["em_g1"] }, definition : { name : "String" } }
    };
    var targets = [];

    function getManager(schema) {
        var opts = { };
        opts[SIS.OPT_ID_FIELD] = SIS.FIELD_ID;
        opts[SIS.OPT_USE_AUTH] = true;
        opts[SIS.OPT_SCHEMA_MGR] = schemaManager;
        return schemaManager.getEntityManager(schema.name, opts);
    }

    before(async function() {
        var mongoose = await LocalTest.start();
        schemaManager = createSchemaManager(mongoose, { auth : true });
        for (var key of Object.keys(schemas)) {
            await schemaManager.add(JSON.parse(JSON.stringify(schemas[key])), { user : superUser });
        }
        // a reference to a schema that no longer exists
        await schemaManager.delete(schemas.gone.name, { user : superUser });
        var targetManager = await getManager(schemas.target);
        for (var name of ["t1", "t2"]) {
            targets.push(await targetManager.add({ name : name }, { user : superUser }));
        }
    });

    after(async function() {
        await LocalTest.stop();
    });

    describe('validate', function() {
        var mgr = null;
        before(async function() {
            mgr = await getManager(schemas.holder);
        });

        it("rejects empty entities", function() {
            mgr.validate({}, null).should.match(/cannot be empty/);
            mgr.validate({ _sis : { tags : ["x"] } }, null).should.match(/cannot be empty/);
            mgr.validate({ _sis : {} }, {}).should.match(/cannot be empty/);
            mgr.validate({ _sis : "x" }, {}).should.match(/cannot be empty/);
            should.not.exist(mgr.validate({ _sis : { tags : ["x"] } }, {}));
        });

        it("rejects reserved fields on add and drops them on update", function() {
            mgr.validate({ name : "a", _hidden : 1 }, null).should.match(/_hidden is a reserved field/);
            var update = { name : "a", _hidden : 1 };
            should.not.exist(mgr.validate(update, {}));
            should.not.exist(update._hidden);
        });

        it("requires owners that are valid and owners of the schema", function() {
            mgr.validate({ name : "a", _sis : { owner : 5 } }, null).should.match(/must be a string or array/);
            mgr.validate({ name : "a", _sis : { owner : ["em_g3"] } }, null).should.match(/subset of the schema owners/);
            should.not.exist(mgr.validate({ name : "a", _sis : { owner : ["em_g2"] } }, null));
            should.not.exist(mgr.validate({ name : "a", _sis : { owner : [] } }, null));
        });

        it("does not check owners of open schemas", async function() {
            var open = await getManager(schemas.open);
            should.not.exist(open.validate({ name : "a", _sis : { owner : ["anyone"] } }, null));
        });

        it("lets any owner modify entities of schemas that do", async function() {
            var anyOwner = await getManager(schemas.anyOwner);
            var entity = { name : "a" };
            should.not.exist(anyOwner.validate(entity, null));
            entity._sis.any_owner_can_modify.should.eql(true);
            var unset = { name : "b", _sis : { any_owner_can_modify : false } };
            anyOwner.validate(unset, null);
            unset._sis.any_owner_can_modify.should.eql(false);
        });
    });

    describe('authorize', function() {
        var mgr = null;
        before(async function() {
            mgr = await getManager(schemas.holder);
        });

        it("rejects users who own none of the schema", async function() {
            await expectError(mgr.authorize(SIS.EVENT_INSERT, { _sis : {} }, outsider), 401, /Insufficient privileges/);
            await expectError(mgr.authorize(SIS.EVENT_INSERT, { _sis : {} }, { name : "x" }), 401, /Insufficient privileges/);
        });

        it("gives entities without owners the user's schema groups", async function() {
            var doc = { _sis : { owner : [] } };
            var merged = new mgr.model({ name : "a" });
            merged._sis.owner = [];
            await mgr.authorize(SIS.EVENT_UPDATE, doc, g1Admin, merged);
            doc._sis.owner.should.eql(["em_g1"]);
            merged._sis.owner.toObject().should.eql(["em_g1"]);
        });

        it("lets super users do anything", async function() {
            var doc = { _sis : { owner : ["em_g2"] } };
            (await mgr.authorize(SIS.EVENT_INSERT, doc, superUser)).should.equal(doc);
        });

        it("gives entities of open schemas the user's groups", async function() {
            var open = await getManager(schemas.open);
            var doc = { name : "a", _sis : { } };
            (await open.authorize(SIS.EVENT_INSERT, doc, g1User)).should.equal(doc);
            doc._sis.owner.should.eql(["em_g1"]);
        });

        it("requires roles to add to open schemas", async function() {
            var open = await getManager(schemas.open);
            await expectError(open.authorize(SIS.EVENT_INSERT, { name : "a", _sis : { } }, noRoles),
                              400, /User must have roles assigned/);
        });

        it("defers to the schema owners for entities without owners", function() {
            mgr.getOwners({ _sis : {} }).should.eql(["em_g1", "em_g2"]);
            mgr.getOwners({ _sis : { owner : ["em_g2"] } }).should.eql(["em_g2"]);
        });
    });

    describe('getById', function() {
        var mgr = null;
        var entity = null;
        before(async function() {
            mgr = await getManager(schemas.holder);
            entity = await mgr.add({ name : "by_id" }, { user : superUser });
        });

        it("gets by the id field or the _id", async function() {
            (await mgr.getById("by_id")).name.should.eql("by_id");
            (await mgr.getById(entity._id.toString())).name.should.eql("by_id");
            await expectError(mgr.getById("nothing"), 404);
        });

        it("only upserts by the id field", function() {
            mgr.canInsertWithId("x", { name : "x" }).should.eql(true);
            mgr.canInsertWithId("x", { name : "y" }).should.not.be.ok();
        });
    });

    describe('applyUpdate', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = await getManager(schemas.holder);
            await mgr.model.deleteMany({ name : "mix" }).exec();
            await mgr.add({ name : "mix", mixed : { a : 1, b : { c : 2 } }, nested : { a : "a0", b : "b0" } },
                          { user : superUser });
        });

        it("merges mixed and nested objects", async function() {
            var result = await mgr.update("mix", { mixed : { b : { d : 3 }, e : null }, nested : { a : "a1" } },
                                          { user : superUser });
            result.updated.mixed.should.eql({ a : 1, b : { c : 2, d : 3 } });
            result.updated.nested.toObject().should.eql({ a : "a1", b : "b0" });
        });

        it("replaces mixed objects when forced", async function() {
            var result = await mgr.update("mix", { mixed : { z : 1 } }, { user : superUser, forceMixed : true });
            result.updated.mixed.should.eql({ z : 1 });
        });

        it("leaves mixed objects the update does not set", async function() {
            var result = await mgr.update("mix", { num : 4 }, { user : superUser });
            result.updated.mixed.should.eql({ a : 1, b : { c : 2 } });
        });
    });

    describe('references', function() {
        var mgr = null;
        beforeEach(async function() {
            mgr = await getManager(schemas.holder);
            await mgr.model.deleteMany({ name : /^ref_/ }).exec();
        });

        function id(i) {
            return targets[i]._id.toString();
        }

        it("adds entities whose references exist", async function() {
            var added = await mgr.add({ name : "ref_ok", single : id(0), many : [id(0), id(1)],
                                        items : [{ label : "x", thing : id(1) }, { label : "y" }] },
                                      { user : superUser });
            added.many.length.should.eql(2);
        });

        it("accepts a populated single reference", async function() {
            var added = await mgr.add({ name : "ref_obj", single : { _id : id(0), name : "t1" } }, { user : superUser });
            added.single.toString().should.eql(id(0));
        });

        it("rejects references that do not exist", async function() {
            var missing = "5f0000000000000000000000";
            await expectError(mgr.add({ name : "ref_1", single : missing }, { user : superUser }), 400, /does not exist/);
            await expectError(mgr.add({ name : "ref_2", many : [id(0), missing] }, { user : superUser }), 400, /does not exist/);
            await expectError(mgr.add({ name : "ref_3", items : [{ thing : missing }] }, { user : superUser }),
                              400, /does not exist/);
        });

        it("rejects reference objects without an _id", async function() {
            await expectError(mgr.add({ name : "ref_4", single : { name : "t1" } }, { user : superUser }), 400, /has no _id/);
            await expectError(mgr.add({ name : "ref_5", many : [{ name : "t1" }] }, { user : superUser }), 400, /has no _id/);
            await expectError(mgr.add({ name : "ref_6", items : [{ thing : { name : "t1" } }] }, { user : superUser }),
                              400, /could not be verified at items.thing/);
        });

        it("rejects a document array that is not an array", async function() {
            await expectError(mgr.add({ name : "ref_7", items : { thing : id(0) } }, { user : superUser }),
                              400, /Array expected at items.thing/);
        });

        it("reports each bulk item's reference errors", async function() {
            var missing = "5f0000000000000000000000";
            var result = await mgr.bulkAdd([
                { name : "ref_b1", single : id(0) },
                { name : "ref_b2", single : missing, many : [missing] },
                { name : "ref_b3", single : { name : "no id" } }
            ], { user : superUser });
            result.success.map(function(s) { return s.name; }).should.eql(["ref_b1"]);
            var errors = {};
            result.errors.forEach(function(e) { errors[e.value.name] = e.err[1].error; });
            errors.should.have.keys("ref_b2", "ref_b3");
            errors.ref_b2.should.match(/does not exist/);
            errors.ref_b3.should.match(/has no _id/);
        });

        it("rejects references to a schema that no longer exists", async function() {
            var lost = await getManager(schemas.lostRef);
            await expectError(lost.add({ name : "x", gone : id(0) }, { user : superUser }), 400, /em_gone/);
        });

        it("accepts populated objects in a reference array", async function() {
            var added = await mgr.add({ name : "ref_objs", many : [{ _id : id(0), name : "t1" }, { _id : id(1) }] },
                                      { user : superUser });
            added.many.map(String).should.eql([id(0), id(1)]);
        });
    });
});
