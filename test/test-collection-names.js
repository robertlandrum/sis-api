describe("Mongo Collection Naming", function() {
    "use strict";

    var should = require('should');

    var SIS = require("../util/constants");
    var TestUtil = require('./fixtures/util');
    var LocalTest = new TestUtil.LocalTest();
    var schemaManager = null;

    before(async function() {
        var mongoose = await LocalTest.start();
        schemaManager = require("../util/schema-manager")(mongoose, { auth : true });
    });

    after(async function() {
        await LocalTest.stop();
    });

    describe("Schemas with plural and non plural", function() {

        var schemas = [
            {
                name : "name_test_site",
                owner : ["sistest"],
                definition : {
                    name : "String",
                    short_name : "String"
                }
            },
            {
                name : "name_test_sites",
                owner : ["sistest"],
                definition : {
                    name : "String",
                    short_name : "String"
                }
            }
        ];

        var entityManagers = { };


        before(function() {
            var opts = { };
            opts[SIS.OPT_SCHEMA_MGR] = schemaManager;
            opts[SIS.OPT_ID_FIELD] = '_id';
            opts[SIS.OPT_USE_AUTH] = false;
            schemas.forEach(function(schema) {
                var model = schemaManager.getEntityModel(schema);
                should.exist(model);
                entityManagers[schema.name] = require('../util/entity-manager')(model, schema, opts);
            });
        });

        it("should add 5 entities to each", async function() {
            var items = [1, 2, 3, 4, 5];
            await Promise.all(schemas.map(function(s) {
                var em = entityManagers[s.name];
                return Promise.all(items.map(function(num) {
                    return em.add({
                        name : s.name + "_" + num,
                        short_name : s.name + "_short_" + num
                    });
                }));
            }));
        });

        it("should only have 5 entities in each", async function() {
            for (var s of schemas) {
                (await entityManagers[s.name].model.find({}).exec()).length.should.eql(5);
            }
        });

        it("should have 2 different mongo collections with 5 items each", async function() {
            var db = schemaManager.mongoose.connection.db;
            for (var s of schemas) {
                // modern driver: db.collection() is synchronous (no strict/callback)
                var collection = db.collection(s.name);
                should.exist(collection);
                (await collection.find().toArray()).length.should.eql(5);
            }
        });

    });

});
