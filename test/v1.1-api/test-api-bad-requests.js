import should from "should";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Bad requests', function() {
    var ApiServer = new TestUtil.TestServer();

    // entities that happen to have the fields the commits API queries by
    var schema = {
        name : "test_invalid_queries",
        id_field : "name",
        _sis : { owner : ["test"] },
        definition : { name : { type : "String", required : true, unique : true },
                       entity_id : "String", type : "String" }
    };
    var url = "/api/v1.1/entities/" + schema.name;
    var entity = { name : "keep_me", entity_id : "x1", type : schema.name };

    before(async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    before(async function() {
        await ApiServer.del("/api/v1.1/schemas/" + schema.name);
        await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
        await ApiServer.post(url).send(entity).expect(201);
    });

    after(async function() {
        await ApiServer.del("/api/v1.1/schemas/" + schema.name).expect(200);
    });

    after(async function() {
        await ApiServer.stop();
    });

    function expectInvalid(res) {
        res.body.error.should.match(/Query parameter is invalid/);
    }

    describe("bodies", function() {
        var schemasUrl = "/api/v1.1/schemas";

        it("rejects one that is not JSON", async function() {
            var res = await ApiServer.post(schemasUrl).send('{"name": ').expect(400);
            res.body.should.eql({ error : "Bad request: Invalid JSON", code : 1001 });
        });

        it("rejects one that is too large", async function() {
            var big = JSON.stringify({ name : "x".repeat(11 * 1024 * 1024) });
            var res = await ApiServer.post(schemasUrl).send(big).expect(413);
            res.body.should.eql({ error : "Bad request: request entity too large", code : 1001 });
        });

        it("rejects a charset it cannot read", async function() {
            var res = await ApiServer.post(schemasUrl).set("Content-Type", "application/json; charset=bogus")
                .send("{}").expect(415);
            res.body.code.should.eql(1001);
            res.body.error.should.match(/^Bad request: unsupported charset/);
        });
    });

    describe("queries", function() {

        it("rejects them when listing", async function() {
            expectInvalid(await ApiServer.get(url).query({ q : "notjson" }).expect(400));
        });

        it("rejects them in bulk deletes", async function() {
            expectInvalid(await ApiServer.del(url).query({ q : "notjson" }).expect(400));
        });

        it("rejects them in bulk updates", async function() {
            expectInvalid(await ApiServer.put(url).query({ q : "notjson" }).send({ type : "changed" }).expect(400));
        });

        it("rejects them when listing commits", async function() {
            expectInvalid(await ApiServer.get(url + "/keep_me/commits").query({ q : "notjson" }).expect(400));
        });

        it("rejects them when listing tokens", async function() {
            var tokensUrl = "/api/v1.1/users/" + ApiServer.getSuperCreds().username + "/tokens";
            expectInvalid(await ApiServer.get(tokensUrl).query({ q : "notjson" }).expect(400));
        });

        it("rejects a CAS condition that is not an object", async function() {
            for (var cas of ["null", "5", "[]", "{}", "notjson"]) {
                var res = await ApiServer.put(url + "/keep_me").query({ cas : cas }).send({ type : "changed" })
                    .expect(400);
                res.body.error.should.match(/CAS condition must be an object/);
            }
        });

        it("does not let one request change the query of another", async function() {
            // these used to write the entity_id, type and username they query by
            // into the object every invalid query shared...
            await ApiServer.get(url + "/x1/commits").query({ q : "notjson" });
            await ApiServer.get("/api/v1.1/users/" + ApiServer.getSuperCreds().username + "/tokens")
                .query({ q : "notjson" });
            // ...so an invalid query then matched those, and these updated and
            // deleted the entity
            expectInvalid(await ApiServer.put(url).query({ q : "notjson" }).send({ type : "changed" }).expect(400));
            expectInvalid(await ApiServer.del(url).query({ q : "notjson" }).expect(400));
            var left = (await ApiServer.get(url + "/keep_me").expect(200)).body;
            left.type.should.eql(schema.name);
        });
    });
});
