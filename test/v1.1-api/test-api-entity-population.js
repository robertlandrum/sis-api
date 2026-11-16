import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Entity Population API', function() {
    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    describe("Populate entities", function() {
        var schema1 = {
            "name" : "test_pop_schema_1",
            _sis : { "owner" : ["entity_test"] },
            "definition" : {
                "ps1_name" : "String",
                "num" : "Number"
            }
        };

        var schema2 = {
            "name" : "test_pop_schema_2",
            _sis : { "owner" : ["entity_test"] },
            "definition" : {
                "ps2_name" : "String",
                "type" : "String",
                "ref_field" : { "type" : "ObjectId", ref : "test_pop_schema_1" }
            }
        };

        var schema3 = {
            "name" : "test_pop_schema_3",
            _sis : { "owner" : ["entity_test"] },
            "definition" : {
                "ps3_name" : "String",
                "stuff" : "String",
                "ref_field" : { "type" : "ObjectId", ref : "test_pop_schema_2" }
            }
        };

        var entities = [
         ["test_pop_schema_1", {"ps1_name" : "ps1", "num" : 10}],
         ["test_pop_schema_2", {"ps2_name" : "ps2", "type" : "ps2_type"}],
         ["test_pop_schema_3", {"ps3_name" : "ps3", "stuff" : "ps3 stuff"}]
        ];

        var schemas = [schema1, schema2, schema3];

        before(async function() {
            // setup the schemas
            await Promise.all(schemas.map(async function(schema) {
                await ApiServer.del('/api/v1.1/schemas/' + schema.name);
                await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
            }));
            for (var i = 0; i < entities.length; ++i) {
                if (i > 0) {
                    // assign _id of the previous entity
                    entities[i][1].ref_field = entities[i - 1][1]._id;
                }
                entities[i][1] = (await ApiServer.post("/api/v1.1/entities/" + entities[i][0])
                    .set("Content-Type", "application/json")
                    .query("populate=false")
                    .send(entities[i][1])
                    .expect(201)).body;
            }
        });

        after(async function() {
            await Promise.all(schemas.map(function(s) {
                return ApiServer.del('/api/v1.1/schemas/' + s.name).expect(200);
            }));
        });

        it("Should populate test_pop_schema_2 ref_field", async function() {
            // test it with the GET /
            var res = (await ApiServer.get("/api/v1.1/entities/test_pop_schema_3")
                .set('Content-Type', 'application/json')
                .expect(200)).body[0];
            should.exist(res);
            should.exist(res.stuff);
            res.stuff.should.eql("ps3 stuff");
            should.exist(res.ref_field);
            res.ref_field.should.eql(entities[1][1]);
        });

        it("Should populate test_pop_schema_1 ref_field", async function() {
            var res = (await ApiServer.get("/api/v1.1/entities/test_pop_schema_2/" + entities[1][1]._id)
                .set("Content-Type", "application/json")
                .expect(200)).body;
            should.exist(res);
            should.exist(res.type);
            res.type.should.eql("ps2_type");
            should.exist(res.ref_field);
            res.ref_field.should.eql(entities[0][1]);
        });

        it("Should not populate test_pop_schema_2 ref_field", async function() {
            // test it with the GET /
            var res = (await ApiServer.get("/api/v1.1/entities/test_pop_schema_3")
                .query("populate=false")
                .set('Content-Type', 'application/json')
                .expect(200)).body[0];
            should.exist(res);
            res.should.eql(entities[2][1]);
        });

        it("Should not populate test_pop_schema_1 ref_field", async function() {
            var res = (await ApiServer.get("/api/v1.1/entities/test_pop_schema_2/" + entities[1][1]._id)
                .query("populate=false")
                .set("Content-Type", "application/json")
                .expect(200)).body;
            should.exist(res);
            res.should.eql(entities[1][1]);
        });

        it("Should not update test_pop_schema_2 with a bad ref", async function() {
            // clone
            var entity = JSON.parse(JSON.stringify(entities[1][1]));
            // a test_pop_schema_3 entity where a test_pop_schema_1 one belongs
            entity.ref_field = entities[2][1]._id;
            // try to update
            await ApiServer.put("/api/v1.1/entities/test_pop_schema_2/" + entity._id)
                .set("Content-Type", "application/json")
                .send(entity)
                .expect(400);
        });

        it("Should not add test_pop_schema_2 with a bad ref", async function() {
            var entity = {"ps2_name" : "ps2.bad", "type" : "ps2_type.bad"};
            entity.ref_field = entities[2][1]._id;
            await ApiServer.post("/api/v1.1/entities/test_pop_schema_2")
                .set("Content-Type", "application/json")
                .send(entity)
                .expect(400);
        });
    });
});
