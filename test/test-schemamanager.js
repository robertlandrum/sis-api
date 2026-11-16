describe('SchemaManager', function() {
    "use strict";

    var SIS = require("../util/constants");
    var should = require('should');
    var TestUtil = require('./fixtures/util');
    var LocalTest = new TestUtil.LocalTest();

    var schemaManager = null;

    before(async function() {
        var mongoose = await LocalTest.start();
        schemaManager = require("../util/schema-manager")(mongoose, { auth : false});
    });

    after(async function() {
        await LocalTest.stop();
    });

    var expectError = TestUtil.expectError;

    // delete the schema if it is there
    async function deleteSchema(name) {
        try {
            await schemaManager.delete(name);
        } catch (err) {
            // it was not
        }
    }

    describe('add-invalid-schema', function() {
        it("should error adding an empty string ", async function() {
            await expectError(schemaManager.add({ "name" : "name", "definition" : "" }), 400,
                              /definition must be an object/);
        });

        it("should error adding an empty object ", async function() {
            await expectError(schemaManager.add({ "name" : "name", "definition" : { } }), 400,
                              /Cannot add an empty schema/);
        });


        it("should error adding a schema with an unkown type ", async function() {
            var schema = { "field1" : "Bogus", "field2" : "String" };
            await expectError(schemaManager.add({ "name" : "name", "definition" : schema }), 400,
                              /Schema is invalid: .*Bogus/);
        });


        it("should error adding a schema with no name ", async function() {
            var schema = { "field1" : "String", "field2" : "String" };
            await expectError(schemaManager.add({ "name" : "", "definition" : schema }), 400,
                              /invalid name/);
        });
    });

    describe('add-schema', function() {
        it("should add a valid json schema object", async function() {
            var schema = {
                "name" : "network_element",
                _sis : { "owner" : ["test"] },
                "definition" : {
                    ne_type: "String",
                    cid: "String",
                    ip: "String",
                    ip6: "String",
                    bgpip: "String",
                    bgpip6: "String"
                }
            };
            var entity = await schemaManager.add(schema);
            entity.should.have.property('name', 'network_element');
            entity.should.have.property('definition');
            entity.definition.should.eql(schema.definition);
        });

        ['sis_hiera', 'sis_schemas', 'sis_hooks'].map(function(name) {
            it("should fail to add a schema with name" + name, async function() {
                var schema = {
                    "name" : name,
                    _sis : { "owner" : ["test"] },
                    "definition" : {
                        ne_type: "String"
                    }
                };
                await expectError(schemaManager.add(schema), 400, /Schema name is reserved/);
            });
        });
        it("Should fail to add an empty schema", async function() {
            var schema = {
                "name" : "name",
                _sis : { "owner" : "test" },
                "definition" : { }
            };
            await expectError(schemaManager.add(schema), 400, /Cannot add an empty schema/);
        });

        ['_id', '__v'].map(function(field) {
            it("Should fail to add a schema w/ field " + field, async function() {
                var schema = {
                    "name" : "schema1",
                    _sis : { "owner" : ["test"] },
                    "definition" : {
                        "name" : "String"
                    }
                };
                schema.definition[field] = 'String';
                await expectError(schemaManager.add(schema), 400, new RegExp(field + " is a reserved field"));
            });
        });
        it("Should fail to add a schema with a bad definition", async function() {
            var schema = {
                "name" : "schema1",
                _sis : { "owner" : ["test"] },
                "definition" : "Bogus"
            };
            await expectError(schemaManager.add(schema), 400, /definition must be an object/);
        });
        it("Should fail to add a schema with an invalid schema def", async function() {
            var schema = {
                "name" : "schema1",
                _sis : { "owner" : ["test"] },
                "definition" : {
                    "name" : "UnknownType"
                }
            };
            await expectError(schemaManager.add(schema), 400, /Schema is invalid: .*UnknownType/);
        });
    });

    describe("getEntityModel failures", function() {
        it("Should fail to get an EntityModel for a schema with no name", function() {
            var model = schemaManager.getEntityModel({'definition' : {'name' : 'String'}});
            should.not.exist(model);
        });
        it("Should fail to get an EntityModel for an invalid schema def", function() {
            var schema = {
                name : 'invalid',
                _sis : { owner : ['invalid'] },
                definition : { 'bogus' : 'Unknown' }
            };
            var model = schemaManager.getEntityModel(schema);
            should.not.exist(model);
        });
    });

    describe('delete-schema', function() {
        var schemaName = "schema1";
        // add a schema
        var schemaDef = {
            f1 : "String",
            f2 : "String"
        };

        var fullSchema = {
            "name" : schemaName,
            _sis : { "owner" : ["test"] },
            "definition" : schemaDef
        };
        before(async function() {
            var entity = await schemaManager.add(fullSchema);
            // add some documents - get the model and save a document
            var EntityType = schemaManager.getEntityModel(entity);
            should.exist(EntityType);
            await new EntityType({f1 : "f1", f2 : "f2" } ).save();
            // assert there is an item
            (await EntityType.countDocuments({}).exec()).should.eql(1);
        });

        it("Should fail to delete a schema that does not exist", async function() {
            await expectError(schemaManager.delete("DNE"), 404);
        });

        it("Should delete the schema", async function() {
            (await schemaManager.delete(schemaName)).name.should.eql(schemaName);
        });

        it("Should no longer exist ", async function() {
            await expectError(schemaManager.getById(schemaName), 404);
        });

        it("Should have no documents ", async function() {
            var entity = await schemaManager.add(fullSchema);
            var EntityType = schemaManager.getEntityModel(entity);
            (await EntityType.countDocuments({}).exec()).should.eql(0);
        });
    });

    describe("update-schema", function() {
        var schema = {
            "name":"test_entity",
            _sis : { "owner" : ["test"] },
            "definition": {
                "str":   "String",
                "num":   "Number",
                "date":  "Date",
                "bool":  "Boolean",
                "arr": [],
            }
        };

        var initialEntity = {
            "str" : "foobar",
            "num" : 10,
            "date" : new Date(),
            "bool" : false,
            "arr" : "helloworld".split("")
        };

        var savedEntity = null;

        // create the schema and add an entity
        before(async function() {
            await deleteSchema(schema.name);
            await schemaManager.add(schema);
            var EntityType = schemaManager.getEntityModel(schema);
            savedEntity = await new EntityType(initialEntity).save();
        });
        after(async function() {
            await schemaManager.delete(schema.name);
        });

        it("Should update the schema", async function() {
            // delete the num field, change bool to string, add field
            delete schema.definition.num;
            schema.definition.bool = 'String';
            schema.definition.newBool = "Boolean";
            var updated = (await schemaManager.update(schema.name, schema)).updated;
            should.exist(updated.definition);
            should.exist(updated.definition.newBool);
            should.not.exist(updated.definition.num);
            var o = await schemaManager.getById(schema.name);
            updated.toObject().should.eql(o.toObject());
        });

        it("Should retrieve the existing entity", async function() {
            var entitySchema = await schemaManager.getById(schema.name);
            var EntityType = schemaManager.getEntityModel(entitySchema);
            var result = await EntityType.findOne({"_id" : savedEntity._id}).exec();
            should.exist(result);
            // ensure that the num is removed
            should.not.exist(result.num);
        });

        it("Should not save the initial entity num field " + JSON.stringify(initialEntity), async function() {
            var entitySchema = await schemaManager.getById(schema.name);
            var EntityType = schemaManager.getEntityModel(entitySchema);
            var doc = new EntityType(initialEntity);
            should.not.exist(doc.schema.num);
            var e = await doc.save();
            should.exist(e.str);
            should.not.exist(e.num);
        });

        it("Should save an updated entity", async function() {
            var entitySchema = await schemaManager.getById(schema.name);
            var EntityType = schemaManager.getEntityModel(entitySchema);
            await new EntityType({
                "str" : "new",
                "newBool" : true,
                "date" : new Date(),
                "arr" : [0,1,2],
                "bool" : "became a string"
            }).save();
        });
    });

    describe("schema diff", function() {
        var s = {
            definition : {
                "str":   "String",
                "num":   "Number",
                "date":  "Date",
                "bool":  "Boolean",
                "arr": []
            }
        };

        beforeEach(function() {
            s.definition = {
                "str":   "String",
                "num":   "Number",
                "date":  "Date",
                "bool":  "Boolean",
                "arr": []
            };
        });

        it("should match the schemas", function() {
            var s1 = schemaManager._getMongooseSchema(s);
            var s2 = schemaManager._getMongooseSchema(s);
            var diff = schemaManager._diffSchemas(s1, s2);
            for (var i = 0; i < diff.length; ++i) {
                diff[i].length.should.eql(0);
            }
        });

        it("should see str was removed", function() {
            var s1 = schemaManager._getMongooseSchema(s);
            delete s.definition.str;
            var s2 = schemaManager._getMongooseSchema(s);
            var diff = schemaManager._diffSchemas(s1, s2);
            diff[1].length.should.eql(1);
            diff[1][0][0].should.eql('str');
        });

        it("should see str was removed, q added, num updated", function() {
            var s1 = schemaManager._getMongooseSchema(s);
            delete s.definition.str;
            s.definition.q = "String";
            s.definition.num = "String";
            var s2 = schemaManager._getMongooseSchema(s);
            var diff = schemaManager._diffSchemas(s1, s2);
            diff[1].length.should.eql(1);
            diff[1][0][0].should.eql('str');
            diff[0].length.should.eql(1);
            diff[0][0][0].should.eql('q');
            diff[2].length.should.eql(1);
            diff[2][0][0].should.eql('num');
        });
    });

    describe("schema indexes", function() {
        var schema = {
            name : "test_schema_index_removal",
            _sis : { owner : ["test"] },
            definition : {
                str : { type : "String", unique : true },
                other : { type : "String", unique : true }
            }
        };

        var schemaDoc = null;

        // create the schema
        before(async function() {
            await deleteSchema(schema.name);
            schemaDoc = (await schemaManager.add(schema)).toObject();
        });
        //
        after(async function() {
            await schemaManager.delete(schema.name);
        });

        it("Should fail to add two objects w/ same str", async function() {
            var EntityType = schemaManager.getEntityModel(schemaDoc);
            await EntityType.ensureIndexes();
            await new EntityType({ str : "foo", other : "foo" }).save();
            var err = null;
            try {
                await new EntityType({ str : "foo", other : "bar" }).save();
            } catch (e) {
                err = e;
            }
            should.exist(err, "the second save should have failed with a duplicate key error");
            err.code.should.eql(11000);
        });

        it("Should remove the unique index", async function() {
            this.timeout(600000);
            delete schema.definition.str.unique;
            schemaDoc = (await schemaManager.update(schema.name, schema)).updated.toObject();
            var EntityType = schemaManager.getEntityModel(schemaDoc);
            await new EntityType({ str : "foo", other : "bar" }).save();
        });

        it("Should remove the 'other' index", async function() {
            delete schema.definition.other;
            schemaDoc = (await schemaManager.update(schema.name, schema)).updated.toObject();
            var EntityType = schemaManager.getEntityModel(schemaDoc);
            var indeces = EntityType.schema.indexes().filter(function(ind) {
                var keys = Object.keys(ind[0]);
                return keys.length != 1 || keys[0].indexOf('_sis') !== 0;
            });
            indeces.length.should.eql(0);
        });

    });

    describe("edge cases", function() {
        var superUser = { name : "sm_super", super_user : true };

        function schemaWith(fields) {
            return Object.assign({ name : "sm_edge", _sis : { owner : ["test"] },
                                   definition : { name : "String" } }, fields);
        }

        it("validates the schema fields", function() {
            schemaManager.validate(schemaWith({ name : "sis_edge" })).should.match(/reserved/);
            schemaManager.validate(schemaWith({ locked_fields : "name" })).should.match(/locked_fields must be an array/);
            schemaManager.validate(schemaWith({ definition : { _hidden : "String" } })).should.match(/_hidden is a reserved field/);
            schemaManager.validate(schemaWith({ id_field : "name" })).should.match(/required and unique/);
            schemaManager.validate(schemaWith({ definition : { name : { type : "String", match : "/abc" } } }))
                .should.match(/Schema is invalid: match/);
            should.not.exist(schemaManager.validate(schemaWith({ definition : { name : { type : "String", match : "/a.c/i" } } })));
            schemaManager.validate(schemaWith({ definition : { name : "String", _sis : { owner : "Number" } } }))
                .should.match(/owner must be a String array/);
        });

        it("turns empty objects in the definition into Mixed", function() {
            var schema = schemaWith({ definition : { name : "String", stuff : { } } });
            should.not.exist(schemaManager.validate(schema));
            schema.definition.stuff.should.eql({ type : "Mixed" });
        });

        it("picks a required and unique id field", async function() {
            var unique = { type : "String", required : true, unique : true };
            (await schemaManager.preAdd({ definition : { name : unique, id : unique } })).id_field.should.eql("name");
            (await schemaManager.preAdd({ definition : { other : unique, id : unique } })).id_field.should.eql("id");
            (await schemaManager.preAdd({ definition : { a : "String", b : unique } })).id_field.should.eql("b");
            should.not.exist((await schemaManager.preAdd({ definition : { a : "String" } })).id_field);
            (await schemaManager.preAdd({ id_field : "a", definition : { a : "String", name : unique } }))
                .id_field.should.eql("a");
        });

        it("records the schemas a schema references", async function() {
            var schema = { _sis : { }, definition : { r : { type : "ObjectId", ref : "other" }, n : "String" } };
            (await schemaManager._preSave(schema))._sis._references.should.eql(["other"]);
        });

        it("rejects getting the model of a schema that does not exist", async function() {
            await expectError(schemaManager.getEntityModelAsync("sm_missing"), 400, /Invalid schema found with name sm_missing/);
        });

        it("rejects getting the model when the lookup fails", async function() {
            var broken = Object.create(schemaManager);
            broken.model = { findOne : function() {
                return { exec : function() { return Promise.reject(new Error("db down")); } };
            } };
            await expectError(broken.getEntityModelAsync("x"), 400, /Schema not found with name x/);
        });

        it("knows the models it has built", function() {
            schemaManager.hasEntityModel(SIS.SCHEMA_SCHEMAS).should.eql(true);
            schemaManager.getEntityModelByName(SIS.SCHEMA_SCHEMAS).should.equal(schemaManager.model);
            schemaManager.hasEntityModel("sm_never_built").should.eql(false);
        });

        it("has no token managers when auth is off", function() {
            should.not.exist(schemaManager.getTokenManagerForUser("anyone"));
        });

        it("removes a schema whose collection was never created", async function() {
            var schema = { name : "sm_no_collection", definition : { name : "String" } };
            (await schemaManager.objectRemoved(schema)).should.equal(schema);
        });

        it("goes ahead without indexes it cannot build", async function() {
            var model = { init : function() { return Promise.reject(new Error("duplicates")); },
                          collection : { name : "sm_dupes" } };
            should.not.exist(await schemaManager.indexesReady(model));
        });

        it("counts the entities of schemas when asked", async function() {
            var schema = schemaWith({ name : "sm_counted" });
            await schemaManager.add(schema, { user : superUser });
            var model = schemaManager.getEntityModel(await schemaManager.getById("sm_counted", { lean : true }));
            await new model({ name : "a" }).save();
            var options = { lean : true, query : { with_counts : "true" } };
            (await schemaManager.getById("sm_counted", options)).entity_count.should.eql(1);
            var all = await schemaManager.getAll({ name : "sm_counted" }, options);
            all[0].entity_count.should.eql(1);
            should.not.exist((await schemaManager.getById("sm_counted", { lean : true })).entity_count);
            await schemaManager.delete("sm_counted", { user : superUser });
        });

        describe("bootstrap", function() {
            var bad = { name : "sm_bad_stored", definition : { field : { type : "Bogus" } } };

            after(async function() {
                await schemaManager.model.collection.deleteOne({ name : bad.name });
            });

            it("builds the models of the stored schemas", async function() {
                await schemaManager.bootstrapEntitySchemas();
            });

            it("fails on a stored schema it cannot build", async function() {
                await schemaManager.model.collection.insertOne(Object.assign({}, bad));
                await expectError(schemaManager.bootstrapEntitySchemas(), 500, /Error building schema/);
            });
        });
    });
});
