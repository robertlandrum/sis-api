import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Entity ID fields', function() {
    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    describe("Schemas with ID fields", function() {
        var schema = {
            name : "test_schema_id_field",
            id_field : "name",
            _sis : { owner : ["sistest"] },
            definition : {
                name : { type : "String", required : true, unique : true },
                short_name : { type : "String", required : true, unique : true },
                other : "String"
            }
        };

        before(async function() {
            await ApiServer.del('/api/v1.1/schemas/test_schema_id_field');
        });

        after(async function() {
            await ApiServer.del('/api/v1.1/schemas/test_schema_id_field');
        });

        it("Should add the schema", async function() {
            await ApiServer.post("/api/v1.1/schemas")
                .set("Content-type", "application/json")
                .send(schema)
                .expect(201);
        });

        var createEntities = async function() {
            var names = ['test', 'test2', 'test3'];
            var data = names.map(function(n) {
                return {
                    name : n,
                    short_name : n + '_short',
                    other : 'test'
                };
            });
            var res = await ApiServer.post('/api/v1.1/entities/test_schema_id_field')
                .send(data)
                .expect(200);
            should.exist(res.body);
            should.exist(res.body.success);
            should.exist(res.body.errors);
            res.body.success.should.be.instanceof(Array);
            res.body.success.length.should.eql(data.length);
            res.body.errors.should.be.instanceof(Array);
            res.body.errors.length.should.eql(0);
            return res.body.success;
        };

        var fetchUpdateAndDelete = async function(e, field) {
            var url = '/api/v1.1/entities/test_schema_id_field/' + e[field];
            var res = await ApiServer.get(url).expect(200);
            res.body._id.should.eql(e._id);
            // fetch by _id should always work
            var idUrl = '/api/v1.1/entities/test_schema_id_field/' + e._id;
            res = await ApiServer.get(idUrl).expect(200);
            res.body._id.should.eql(e._id);
            // update
            var updateObj = res.body;
            updateObj.other = 'update';
            res = await ApiServer.put(url).send(updateObj).expect(200);
            res.body._id.should.eql(e._id);
            res.body.other.should.eql('update');
            // issue a cas update
            updateObj = res.body;
            updateObj.other = 'cas_update';
            var casOp = { other : 'update' };
            res = await ApiServer.put(url).send(updateObj).query({ cas : casOp }).expect(200);
            res.body._id.should.eql(e._id);
            res.body.other.should.eql('cas_update');
            // delete
            await ApiServer.del(url).expect(200);
        };

        var createAndVerify = async function(field) {
            var entities = await createEntities();
            await Promise.all(entities.map(function(e) {
                return fetchUpdateAndDelete(e, field);
            }));
        };

        it("Should fetch entities by name", async function() {
            await createAndVerify('name');
        });

        it("Should 404 on a non existent entity", async function() {
            await ApiServer.get("/api/v1.1/entities/test_schema_id_field/foobar")
                .expect(404);
        });

        it("Should fail to update to a bad ID field", async function() {
            var update = JSON.parse(JSON.stringify(schema));
            update.id_field = 'other';
            await ApiServer.put("/api/v1.1/schemas/test_schema_id_field")
                .send(update)
                .expect(400);
        });

        it("Should fail to change attributes on name", async function() {
            var update = JSON.parse(JSON.stringify(schema));
            update.definition.name = "String";
            await ApiServer.put("/api/v1.1/schemas/test_schema_id_field")
                .send(update)
                .expect(400);
        });

        it("Should update to a valid id field", async function() {
            var update = JSON.parse(JSON.stringify(schema));
            update.id_field = 'short_name';
            var res = await ApiServer.put("/api/v1.1/schemas/test_schema_id_field")
                .send(update)
                .expect(200);
            res.body.id_field.should.eql('short_name');
        });

        it("Should fetch by short_name", async function() {
            await createAndVerify('short_name');
        });

        it("Should 404 on a non existent entity again", async function() {
            await ApiServer.get("/api/v1.1/entities/test_schema_id_field/foobar_short")
                .expect(404);
        });

        it("Should reset the id field to _id", async function() {
            var update = JSON.parse(JSON.stringify(schema));
            update.id_field = null;
            var res = await ApiServer.put("/api/v1.1/schemas/test_schema_id_field")
                .send(update)
                .expect(200);
            res.body.id_field.should.eql('_id');
        });

        it("Should fetch entities by _id", async function() {
            await createAndVerify('_id');
        });

    });

});
