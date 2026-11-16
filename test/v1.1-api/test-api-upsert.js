describe('@API @V1.1API - Upsert', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");
    var TestUtil = require('../fixtures/util');

    var ApiServer = new TestUtil.TestServer();


    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    describe("Upsert schemas", function() {
        var schema = {
            name : "test_upsert_1",
            id_field : "name",
            _sis : { owner : ["sistest"] },
            definition : {
                name : { type : "String", required : true, unique : true },
                short_name : { type : "String", required : true, unique : true },
                other : "String"
            }
        };

        before(async function() {
            await ApiServer.del("/api/v1.1/schemas/test_upsert_1");
        });

        it("Should insert the schema", async function() {
            await ApiServer.put("/api/v1.1/schemas/test_upsert_1")
                .query({ upsert : true }).send(schema)
                .expect(201);
        });

        it("Should update the schema", async function() {
            schema.id_field = 'short_name';
            var res = await ApiServer.put("/api/v1.1/schemas/test_upsert_1")
                .query({ upsert : true }).send(schema)
                .expect(200);
            res.body.id_field.should.eql('short_name');
        });

        it("Should not insert with mismatched IDs", async function() {
            await ApiServer.put("/api/v1.1/schemas/test_upsert_bad")
                .query({ upsert : true }).send(schema)
                .expect(400);
        });

    });

    describe("Upsert entities", function() {
        var schema = {
            name : "test_upsert_2",
            _sis : { owner : ["sistest"] },
            definition : {
                name : { type : "String" },
                short_name : { type : "String" },
                other : "String"
            }
        };

        before(async function() {
            await ApiServer.del("/api/v1.1/schemas/test_upsert_2");
            await ApiServer.post("/api/v1.1/schemas").send(schema)
                .expect(201);
        });

        it("Should fail to upsert with no id field", async function() {
            var entity = {
                name : "foobar",
                short_name : "foobar_short",
                other : "foobar"
            };
            await ApiServer.put("/api/v1.1/entities/test_upsert_2/foobar")
                .query({ upsert : true }).send(entity).expect(400);
        });

        it("Should upsert with an id field", async function() {
            schema.id_field = 'name';
            schema.definition.name.unique = true;
            schema.definition.name.required = true;

            var entity = {
                name : "foobar",
                short_name : "foobar_short",
                other : "foobar"
            };
            await ApiServer.put("/api/v1.1/schemas/test_upsert_2").send(schema)
                .expect(200);
            await ApiServer.put("/api/v1.1/entities/test_upsert_2/foobar")
                .query({ upsert : true }).send(entity).expect(201);
        });

        it("Should not upsert with mismatched ids", async function() {
            var entity = {
                name : "foobar",
                short_name : "foobar_short",
                other : "foobar"
            };
            await ApiServer.put("/api/v1.1/entities/test_upsert_2/bar")
                .query({ upsert : true }).send(entity).expect(400);
        });

        it("Should upsert if the id has dots", async function() {
            var entity = {
                name : "foo.bar.baz",
                short_name: "foo.bar.short",
                other : "baz"
            };
            await ApiServer.put("/api/v1.1/entities/test_upsert_2/foo.bar.baz")
                .query({ upsert : true }).send(entity).expect(201);
        });

        it("Should report why an existing entity could not be updated", async function() {
            // foobar exists, so a failed update must not fall back to an add
            var entity = { name : "foobar", other : "changed" };
            var res = await ApiServer.put("/api/v1.1/entities/test_upsert_2/foobar")
                .query({ upsert : true, cas : JSON.stringify({ other : "not_foobar" }) })
                .send(entity).expect(400);
            res.body.error.should.match(/CAS update failed/);
        });

    });

});
